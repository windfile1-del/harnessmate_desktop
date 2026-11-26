import type { FastifyInstance } from 'fastify';
import {
  CreateTerminalContextChipRequestSchema,
  OpenTerminalRequestSchema,
  ReleaseTerminalsPathRequestSchema,
  TerminalInputRequestSchema,
  type ManagedTerminalTab,
} from '@harnessmate/protocol';
import { PEER_CONTRACTS } from '@harnessmate/plugin-api';
import type { SessionManager } from '../../core/session-manager.js';
import { TerminalWorkspaceError } from '../../core/terminal-workspace-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import {
  httpStatusForPluginError,
  releaseTerminalsUsingPath,
  resolveTerminalProviderForTerminalIdAsync,
  resolveTerminalRunnerService,
  resolveTerminalWorkspaceService,
  unwrapPeerServiceResult,
} from '../../core/w1-service-helpers.js';

export interface TerminalCompatDeps {
  store: HarnessMateStore;
  pluginManager: PluginManager;
  sessionManager: SessionManager;
  terminalSessionOwners: Map<string, string>;
}

export function registerTerminalCompatRoutes(
  app: FastifyInstance,
  deps: TerminalCompatDeps,
): void {
  const { store, pluginManager, sessionManager, terminalSessionOwners } = deps;

  app.post('/api/v1/sessions/:id/terminal', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const body = request.body as { command?: string; instanceId?: string; timeoutMs?: number };
    if (!body?.command?.trim()) {
      return reply.code(400).send({ error: 'Command is required' });
    }
    try {
      const { peer, legacy } = resolveTerminalRunnerService(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: body.instanceId || undefined,
      });
      if (peer) {
        const result = unwrapPeerServiceResult(
          await peer.run({
            sessionId: session.id,
            workspaceId: session.workspaceId,
            cwd: session.cwd,
            command: body.command,
            timeoutMs: body.timeoutMs,
          }),
        );
        return {
          result: {
            command: body.command.trim(),
            cwd: session.cwd,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            timedOut: Boolean(result.timedOut),
          },
        };
      }
      if (legacy?.runCommand) {
        const result = await legacy.runCommand({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          cwd: session.cwd,
          command: body.command,
          timeoutMs: body.timeoutMs,
        });
        return { result };
      }
      return reply.code(409).send({ error: '终端命令执行服务不可用', code: 'E_SERVICE_UNAVAILABLE' });
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });

  // ── Integrated PTY Terminal Workspace & Context Chips ─────────────────

  app.get('/api/v1/workspaces/:id/terminals', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getWorkspace(id)) return reply.code(404).send({ error: 'Workspace not found' });
    const q = request.query as { cwd?: string; instanceId?: string };
    const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.terminalWorkspace, {
      workspaceId: id,
      explicitInstanceId: q.instanceId || undefined,
      allowSingleCandidate: true,
    });
    if (resolution.status !== 'ready') {
      return {
        enabled: false,
        instanceId: resolution.instanceId,
        ptyAvailable: false,
        terminals: [],
      };
    }
    try {
      const { instanceId, peer, legacy } = resolveTerminalWorkspaceService(pluginManager, {
        workspaceId: id,
        explicitInstanceId: resolution.instanceId,
      });
      if (legacy) {
        return {
          enabled: legacy.isPluginActive(),
          instanceId,
          ptyAvailable: legacy.isPtyAvailable(),
          terminals: legacy.listTerminals(id, q.cwd || undefined),
        };
      }
      if (peer) {
        const listed = unwrapPeerServiceResult(await peer.listTerminals({ workspaceId: id, cwd: q.cwd || undefined }));
        return {
          enabled: true,
          instanceId,
          ptyAvailable: listed.ptyAvailable,
          terminals: listed.terminals as unknown as ManagedTerminalTab[],
        };
      }
    } catch {
      // Fallback safely when instance transitions during read
    }
    return {
      enabled: false,
      instanceId: resolution.instanceId,
      ptyAvailable: false,
      terminals: [],
    };
  });

  app.post('/api/v1/workspaces/:id/terminals', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getWorkspace(id)) return reply.code(404).send({ error: 'Workspace not found' });

    const parsed = OpenTerminalRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid open terminal payload' });
    }
    const q = request.query as { instanceId?: string };
    let resolved;
    try {
      resolved = resolveTerminalWorkspaceService(pluginManager, {
        workspaceId: id,
        sessionId: parsed.data.sessionId,
        explicitInstanceId: q.instanceId || undefined,
      });
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }

    try {
      let created: { terminal: ManagedTerminalTab; snapshot: string };
      if (resolved.legacy) {
        created = await resolved.legacy.openTerminal(id, {
          cwd: parsed.data.cwd,
          title: parsed.data.title,
          cols: parsed.data.cols,
          rows: parsed.data.rows,
          initialCommand: parsed.data.initialCommand,
        });
      } else if (resolved.peer) {
        const res = unwrapPeerServiceResult(
          await resolved.peer.openTerminal({
            workspaceId: id,
            cwd: parsed.data.cwd ?? store.getWorkspace(id)!.rootPath,
            sessionId: parsed.data.sessionId,
            cols: parsed.data.cols,
            rows: parsed.data.rows,
            title: parsed.data.title,
          }),
        );
        const tab = res.terminal as unknown as ManagedTerminalTab;
        const snap = await resolved.peer.getOutputSnapshot({ terminalId: tab.terminalId }).catch(() => null);
        created = {
          terminal: tab,
          snapshot: snap && snap.ok ? snap.value.snapshot : '',
        };
      } else {
        return reply.code(409).send({ error: '终端服务不可用', code: 'E_SERVICE_UNAVAILABLE' });
      }

      if (parsed.data.sessionId && sessionManager.getSession(parsed.data.sessionId)) {
        terminalSessionOwners.set(created.terminal.terminalId, parsed.data.sessionId);
        sessionManager.recordTerminalEvent(parsed.data.sessionId, 'terminal.opened', {
          terminalId: created.terminal.terminalId,
          title: created.terminal.title,
          cwd: created.terminal.cwd,
          backend: created.terminal.backend,
        });
      }
      return reply.code(201).send({ ...created, instanceId: resolved.instanceId });
    } catch (err) {
      const code = err instanceof TerminalWorkspaceError ? err.code : undefined;
      const mapped = httpStatusForPluginError(err, 400);
      const effectiveCode = code ?? (mapped.code === 'E_INTERNAL' ? 'E_TERMINAL_OPEN_FAILED' : mapped.code);
      const status = effectiveCode === 'E_PLUGIN_DISABLED' ? 409 : effectiveCode === 'E_WORKSPACE_NOT_FOUND' ? 404 : mapped.status;
      return reply.code(status).send({ error: mapped.message, code: effectiveCode });
    }
  });

  app.post('/api/v1/terminals/:terminalId/input', async (request, reply) => {
    const { terminalId } = request.params as { terminalId: string };
    const parsed = TerminalInputRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid terminal input payload' });
    }
    const owner = await resolveTerminalProviderForTerminalIdAsync(pluginManager, terminalId);
    if (!owner) {
      const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.terminalWorkspace, { allowSingleCandidate: true });
      if (resolution.status === 'disabled') {
        return reply.code(409).send({ error: '终端插件当前已停用', code: 'E_PLUGIN_DISABLED' });
      }
      return reply.code(404).send({ error: `终端不存在或已关闭: ${terminalId}`, code: 'E_TERMINAL_NOT_FOUND' });
    }
    try {
      if (owner.legacy) {
        owner.legacy.writeInput(terminalId, parsed.data.data);
      } else if (owner.peer) {
        unwrapPeerServiceResult(await owner.peer.writeInput({ terminalId, data: parsed.data.data }));
      }
      return { ok: true };
    } catch (err) {
      const code = err instanceof TerminalWorkspaceError ? err.code : 'E_TERMINAL_INPUT_FAILED';
      const status = code === 'E_TERMINAL_NOT_FOUND' ? 404 : code === 'E_PLUGIN_DISABLED' || code === 'E_TERMINAL_EXITED' ? 409 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/terminals/:terminalId/interrupt', async (request, reply) => {
    const { terminalId } = request.params as { terminalId: string };
    const owner = await resolveTerminalProviderForTerminalIdAsync(pluginManager, terminalId);
    if (!owner) {
      return reply.code(404).send({ error: `终端不存在或已关闭: ${terminalId}`, code: 'E_TERMINAL_NOT_FOUND' });
    }
    try {
      if (owner.legacy) {
        const terminal = await owner.legacy.interruptTerminal(terminalId);
        return { terminal };
      }
      unwrapPeerServiceResult(await owner.peer!.interruptTerminal({ terminalId }));
      return { terminal: { terminalId, status: 'running' } };
    } catch (err) {
      const code = err instanceof TerminalWorkspaceError ? err.code : 'E_TERMINAL_INTERRUPT_FAILED';
      return reply.code(code === 'E_TERMINAL_NOT_FOUND' ? 404 : 400).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.post('/api/v1/terminals/:terminalId/restart', async (request, reply) => {
    const { terminalId } = request.params as { terminalId: string };
    const owner = await resolveTerminalProviderForTerminalIdAsync(pluginManager, terminalId);
    if (!owner) {
      const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.terminalWorkspace, { allowSingleCandidate: true });
      if (resolution.status === 'disabled') {
        return reply.code(409).send({ error: '终端插件当前已停用', code: 'E_PLUGIN_DISABLED' });
      }
      return reply.code(404).send({ error: `终端不存在或已关闭: ${terminalId}`, code: 'E_TERMINAL_NOT_FOUND' });
    }
    try {
      if (owner.legacy) {
        const terminal = await owner.legacy.restartTerminal(terminalId);
        return { terminal };
      }
      const res = unwrapPeerServiceResult(await owner.peer!.restartTerminal({ terminalId }));
      return { terminal: res.terminal };
    } catch (err) {
      const code = err instanceof TerminalWorkspaceError ? err.code : 'E_TERMINAL_RESTART_FAILED';
      const status = code === 'E_TERMINAL_NOT_FOUND' ? 404 : code === 'E_PLUGIN_DISABLED' ? 409 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/terminals/:terminalId/context-chip', async (request, reply) => {
    const { terminalId } = request.params as { terminalId: string };
    const parsed = CreateTerminalContextChipRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid context chip request' });
    }
    const owner = await resolveTerminalProviderForTerminalIdAsync(pluginManager, terminalId);
    if (!owner) {
      return reply.code(404).send({ error: `终端不存在或已关闭: ${terminalId}`, code: 'E_TERMINAL_NOT_FOUND' });
    }
    try {
      if (owner.legacy) {
        const chip = owner.legacy.createContextChip(terminalId, parsed.data);
        return { chip };
      }
      const res = unwrapPeerServiceResult(await owner.peer!.buildContextChip({ terminalId, ...parsed.data }));
      return { chip: res.chip };
    } catch (err) {
      const code = err instanceof TerminalWorkspaceError ? err.code : 'E_CONTEXT_CHIP_FAILED';
      return reply.code(code === 'E_TERMINAL_NOT_FOUND' ? 404 : 400).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.delete('/api/v1/terminals/:terminalId', async (request, reply) => {
    const { terminalId } = request.params as { terminalId: string };
    const owner = await resolveTerminalProviderForTerminalIdAsync(pluginManager, terminalId);
    if (!owner) return reply.code(404).send({ error: 'Terminal not found' });
    let closed = false;
    if (owner.legacy) {
      closed = await owner.legacy.closeTerminal(terminalId);
    } else if (owner.peer) {
      closed = unwrapPeerServiceResult(await owner.peer.closeTerminal({ terminalId })).closed;
    }
    if (!closed) return reply.code(404).send({ error: 'Terminal not found' });
    terminalSessionOwners.delete(terminalId);
    return { closed: true };
  });

  app.post('/api/v1/terminals/release-path', async (request, reply) => {
    const parsed = ReleaseTerminalsPathRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid release-path payload' });
    }
    const res = await releaseTerminalsUsingPath(pluginManager, parsed.data.targetPath);
    for (const tid of res.terminalIds) {
      terminalSessionOwners.delete(tid);
    }
    return { releasedCount: res.closedCount, terminalIds: res.terminalIds };
  });
}
