import {
  SESSION_COLLABORATION_CONTRACT,
  SESSION_COLLABORATION_CONTRACT_VERSION,
  type PublicPortableSessionBundleV2,
  type ServiceMethodResult,
  type SessionCollaborationServiceV1,
  type SessionRecordDto,
  type SideChatMessageDto,
} from '@harnessmate/plugin-api';

const SESSION_LEDGER_CONTRACT = 'session.ledger.v1';
import type { CanonicalEvent, Session } from '@harnessmate/protocol';
import { SessionExplorerService, type SessionExplorerHooks } from '../../core/session-explorer-service.js';
import type { TaskLedgerService } from '../../core/task-ledger-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { PluginManager } from '../plugin-manager.js';

export const SESSION_COLLABORATION_DEFAULT_PLUGIN_ID = 'hm.plugin.session-explorer';

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr<T = never>(
  code: 'invalid_request' | 'not_found' | 'plugin_disabled' | 'conflict',
  message: string,
): ServiceMethodResult<T> {
  return { ok: false, error: { code, message } };
}

function toSessionDto(session: Session): SessionRecordDto {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    harnessId: session.harnessId,
    harnessKind: session.harnessKind,
    nativeSessionId: session.nativeSessionId,
    parentSessionId: session.parentSessionId ?? null,
    forkedFromTurnSeq: session.forkedFromTurnSeq ?? null,
    forkMode: session.forkMode === 'native' ? 'clean_fork' : session.forkMode === 'portable' ? 'with_context' : null,
    importMode: session.importMode ?? null,
    importSource: session.importSource ?? null,
    participatingHarnesses: session.participatingHarnesses,
    contextSyncMode: session.contextSyncMode,
    cwd: session.cwd,
    worktreeBranch: session.worktreeBranch ?? null,
    title: session.title,
    status: session.status,
    model: session.model,
    actualModel: session.actualModel ?? null,
    modelReroutedReason: session.modelReroutedReason ?? null,
    reasoningEffort: session.reasoningEffort,
    permissionMode: session.permissionMode,
    lastSeq: session.lastSeq,
    usage: session.usage,
    pendingApprovalCount: session.pendingApprovalCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export interface SessionCollaborationRuntimeBridge {
  emitCanonical?: (
    sessionId: string,
    type: CanonicalEvent['type'],
    payload: Record<string, unknown>,
    turnId?: string | null,
  ) => CanonicalEvent;
  createSession?: SessionExplorerHooks['createSession'];
  addWorkspace?: SessionExplorerHooks['addWorkspace'];
  tryNativeFork?: SessionExplorerHooks['tryNativeFork'];
  onSessionImported?: SessionExplorerHooks['onSessionImported'];
}

export function createSessionCollaborationPlugin(params: {
  store: HarnessMateStore;
  registry: HarnessRegistry;
  getPluginManager?: () => PluginManager;
  bridge?: SessionCollaborationRuntimeBridge;
}): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  return {
    provides: [SESSION_COLLABORATION_CONTRACT, 'session-search'],
    apply(ctx) {
      let active = true;
      const explorer = new SessionExplorerService(params.store, params.registry);

      explorer.attachHooks({
        emitCanonical: (sessionId, type, payload, turnId) => {
          if (params.bridge?.emitCanonical) {
            return params.bridge.emitCanonical(sessionId, type, payload, turnId ?? null);
          }
          return params.store.appendEvent(sessionId, type, payload, turnId ?? null);
        },
        createSession: (req) => {
          if (!params.bridge?.createSession) {
            throw new Error('createSession runtime bridge unavailable');
          }
          return params.bridge.createSession(req);
        },
        addWorkspace: (rootPath, name) => {
          if (!params.bridge?.addWorkspace) {
            throw new Error('addWorkspace runtime bridge unavailable');
          }
          return params.bridge.addWorkspace(rootPath, name);
        },
        tryNativeFork: params.bridge?.tryNativeFork,
        getTaskLedger: () => {
          const pm = params.getPluginManager?.();
          if (pm) {
            const sel = pm.resolveServiceSelection(SESSION_LEDGER_CONTRACT, { allowSingleCandidate: true });
            if (sel.status === 'ready' && sel.instanceId) {
              const svc = pm.host.getServiceByInstance<TaskLedgerService>(sel.instanceId, 'ledger');
              if (svc) return svc;
            }
            return pm.host.get<TaskLedgerService>('ledger');
          }
          try {
            return ctx.get<TaskLedgerService>('ledger');
          } catch {
            return undefined;
          }
        },
        onSessionImported: params.bridge?.onSessionImported,
      });

      const mapSideChat = (sessionId: string, msg: ReturnType<SessionExplorerService['getSideChat']>[number]): SideChatMessageDto => ({
        id: msg.id,
        sessionId,
        role: msg.role,
        text: msg.text,
        harnessId: msg.harnessId ?? 'unknown',
        model: msg.model ?? null,
        createdAt: msg.createdAt,
      });

      const serviceV1: SessionCollaborationServiceV1 = {
        async forkSession(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          try {
            const res = await explorer.forkSession(request.sessionId, {
              targetHarnessId: request.targetHarnessId,
              fromTurnSeq: request.fromTurnSeq,
              title: request.title,
              createWorktree: request.createWorktree,
              worktreeBranch: request.worktreeBranch,
            });
            return peerOk({
              session: toSessionDto(res.session),
              forkMode: res.modeUsed,
              handoffPreview: { notice: res.notice, forkedFromTurnSeq: res.session.forkedFromTurnSeq ?? request.fromTurnSeq ?? null },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return peerErr(msg.includes('not found') ? 'not_found' : 'invalid_request', msg);
          }
        },
        async mergeBack(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          try {
            const res = explorer.mergeBack(request.childSessionId, {
              summaryOverride: request.summary,
              includeTouchedFiles: request.pinnedFacts ? true : undefined,
            });
            return peerOk(res as unknown as Record<string, unknown>);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return peerErr(msg.includes('not found') ? 'not_found' : 'invalid_request', msg);
          }
        },
        async getSideChat(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          const list = explorer.getSideChat(request.sessionId).map((m) => mapSideChat(request.sessionId, m));
          return peerOk({ messages: list });
        },
        async clearSideChat(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          explorer.clearSideChat(request.sessionId);
          return peerOk({ ok: true });
        },
        async sendSideChat(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          try {
            const res = await explorer.sendSideChat(request.sessionId, {
              text: request.text,
              harnessId: request.harnessId,
              model: request.model,
            });
            return peerOk({
              messages: res.messages.map((m) => mapSideChat(request.sessionId, m)),
              reply: mapSideChat(request.sessionId, res.reply),
            });
          } catch (err) {
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async promoteSideChatToFork(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          try {
            const res = await explorer.promoteSideChatToFork(request.sessionId, {
              title: request.title,
              targetHarnessId: request.targetHarnessId,
              createWorktree: request.createWorktree,
            });
            return peerOk({
              session: toSessionDto(res.session),
              forkMode: res.modeUsed,
            });
          } catch (err) {
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async exportSession(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          try {
            const res = explorer.exportSession(request.sessionId, request.format, {
              redact: request.redact,
            });
            if (res.format === 'markdown') {
              return peerOk({
                format: 'markdown',
                filename: res.filename,
                contentType: 'text/markdown',
                content: res.markdown,
              });
            }
            return peerOk({
              format: 'json_bundle',
              filename: res.filename,
              contentType: 'application/json',
              content: res.bundle as unknown as PublicPortableSessionBundleV2,
            });
          } catch (err) {
            return peerErr('not_found', err instanceof Error ? err.message : String(err));
          }
        },
        async importSessionBundle(request) {
          if (!active) return peerErr('plugin_disabled', '会话分叉与协作插件已停用');
          try {
            const session = await explorer.importSessionBundle({
              bundle: request.bundle as unknown as Parameters<SessionExplorerService['importSessionBundle']>[0]['bundle'],
              workspaceId: request.workspaceId,
              titleOverride: request.titleOverride,
            });
            return peerOk({ session: toSessionDto(session) });
          } catch (err) {
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
      };

      ctx.provide('session-search', explorer);
      ctx.provide(SESSION_COLLABORATION_CONTRACT, serviceV1, {
        version: SESSION_COLLABORATION_CONTRACT_VERSION,
        metadata: { title: '会话分叉、Side Chat 与导入导出中心' },
      });

      ctx.effect(() => () => {
        active = false;
        explorer.dispose();
      });
    },
  };
}
