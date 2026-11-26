import type { FastifyInstance } from 'fastify';
import {
  GcCheckpointsRequestSchema,
  RevertCheckpointRequestSchema,
} from '@harnessmate/protocol';
import { CheckpointError, CheckpointService } from '../../core/checkpoint-service.js';
import type { SessionManager } from '../../core/session-manager.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import { httpStatusForPluginError, resolveGitCheckpointProvider } from '../../core/w1-service-helpers.js';

export interface CheckpointsCompatDeps {
  store: HarnessMateStore;
  registry: HarnessRegistry;
  pluginManager: PluginManager;
  sessionManager: SessionManager;
}

export function registerCheckpointsCompatRoutes(
  app: FastifyInstance,
  deps: CheckpointsCompatDeps,
): void {
  const { store, registry, pluginManager, sessionManager } = deps;

  app.get('/api/v1/sessions/:id/checkpoints', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const adapter = registry.get(session.harnessId);
    const supportsNativeRollback = Boolean(adapter?.capabilitiesV2?.supportsNativeRollback);
    try {
      const { provider } = resolveGitCheckpointProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      const checkpoints = await provider.list(id, 100);
      return { checkpoints, supportsNativeRollback, instanceId: provider.instanceId, readOnly: false };
    } catch {
      // Preserve read-only historical checkpoints when checkpoint plugin is disabled
      const checkpoints = store.listCheckpointRecords(id, 100);
      return { checkpoints, supportsNativeRollback, instanceId: null, readOnly: true };
    }
  });

  app.post('/api/v1/sessions/:id/checkpoints', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    try {
      const checkpoint = await sessionManager.captureManualCheckpoint(id);
      return reply.code(201).send({ checkpoint });
    } catch (err) {
      const code = err instanceof CheckpointError ? err.code : undefined;
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({
        error: mapped.message,
        code: code ?? (mapped.code === 'E_INTERNAL' ? 'E_CHECKPOINT_CAPTURE_FAILED' : mapped.code),
      });
    }
  });

  app.get('/api/v1/sessions/:id/checkpoints/diff', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as {
      fromCheckpointId?: string;
      toCheckpointId?: string;
      fromSeq?: string;
      toSeq?: string;
    };
    const diffOpts = {
      fromCheckpointId: q.fromCheckpointId || undefined,
      toCheckpointId: q.toCheckpointId || undefined,
      fromSeq: q.fromSeq !== undefined ? Number(q.fromSeq) : undefined,
      toSeq: q.toSeq !== undefined ? Number(q.toSeq) : undefined,
    };
    try {
      const diff = await sessionManager.diffSessionCheckpoints(id, diffOpts);
      return diff;
    } catch (err) {
      // Allow read-only historical diff inspection if checkpoint provider is disabled
      const mapped = httpStatusForPluginError(err, 400);
      if (mapped.code === 'E_PLUGIN_DISABLED' || mapped.code === 'E_SERVICE_UNAVAILABLE') {
        try {
          const readOnlyReader = new CheckpointService(store);
          return await readOnlyReader.diff({
            sessionId: id,
            cwd: session.cwd,
            ...diffOpts,
          });
        } catch (readErr) {
          const code = readErr instanceof CheckpointError ? readErr.code : 'E_CHECKPOINT_DIFF_FAILED';
          const status = code === 'E_CHECKPOINT_MISSING' || code === 'E_CHECKPOINT_NOT_FOUND' ? 404 : 400;
          return reply.code(status).send({
            error: readErr instanceof Error ? readErr.message : String(readErr),
            code,
          });
        }
      }
      const code = err instanceof CheckpointError ? err.code : undefined;
      return reply.code(mapped.status).send({
        error: mapped.message,
        code: code ?? (mapped.code === 'E_INTERNAL' ? 'E_CHECKPOINT_DIFF_FAILED' : mapped.code),
      });
    }
  });

  app.post('/api/v1/sessions/:id/checkpoints/revert', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const parsed = RevertCheckpointRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid revert payload' });
    }
    try {
      const result = await sessionManager.revertSessionCheckpoint(id, parsed.data);
      return {
        result,
        session: sessionManager.getSession(id),
        checkpoints: await sessionManager.listSessionCheckpointsAsync(id),
      };
    } catch (err) {
      const code = err instanceof CheckpointError ? err.code : undefined;
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({
        error: mapped.message,
        code: code ?? (mapped.code === 'E_INTERNAL' ? 'E_REVERT_FAILED' : mapped.code),
      });
    }
  });

  app.post('/api/v1/sessions/:id/checkpoints/gc', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const parsed = GcCheckpointsRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid GC payload' });
    try {
      const result = await sessionManager.gcSessionCheckpoints(id, parsed.data);
      return {
        ...result,
        checkpoints: await sessionManager.listSessionCheckpointsAsync(id),
      };
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });
}
