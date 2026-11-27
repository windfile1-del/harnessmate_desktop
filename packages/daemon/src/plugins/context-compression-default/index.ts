import {
  SESSION_COMPRESSION_CONTRACT,
  SESSION_COMPRESSION_CONTRACT_VERSION,
  type ServiceMethodResult,
  type SessionCompressionServiceV1,
} from '@harnessmate/plugin-api';

const SESSION_LEDGER_CONTRACT = 'session.ledger.v1';
import type { CanonicalEvent } from '@harnessmate/protocol';
import {
  ContextCompressionService,
  CONTEXT_COMPRESSION_PLUGIN_ID,
} from '../../core/context-compression-service.js';
import type { TaskLedgerService } from '../../core/task-ledger-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { PluginManager } from '../plugin-manager.js';

export { CONTEXT_COMPRESSION_PLUGIN_ID };

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr<T = never>(
  code: 'invalid_request' | 'not_found' | 'plugin_disabled' | 'conflict',
  message: string,
): ServiceMethodResult<T> {
  return { ok: false, error: { code, message } };
}

export function createContextCompressionPlugin(params: {
  store: HarnessMateStore;
  registry: HarnessRegistry;
  emitCanonical?: (
    sessionId: string,
    type: CanonicalEvent['type'],
    payload: Record<string, unknown>,
    turnId?: string | null,
  ) => CanonicalEvent;
  getPluginManager?: () => PluginManager;
}): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  return {
    provides: [SESSION_COMPRESSION_CONTRACT, 'compressor'],
    apply(ctx) {
      let active = true;
      const compressor = new ContextCompressionService(params.store, params.registry);
      compressor.setPluginActive(true);
      compressor.attachHooks({
        isEnabled: () => active,
        emitEvent: (sessionId, type, payload) => {
          if (params.emitCanonical) {
            return params.emitCanonical(sessionId, type, payload, null);
          }
          return params.store.appendEvent(sessionId, type, payload, null);
        },
        getTaskState: (sessionId) => {
          const session = params.store.getSession(sessionId);
          if (!session) return undefined;
          const pm = params.getPluginManager?.();
          if (pm) {
            const selection = pm.resolveServiceSelection(SESSION_LEDGER_CONTRACT, {
              sessionId: session.id,
              allowSingleCandidate: true,
            });
            if (selection.status === 'ready' && selection.instanceId) {
              const ledger =
                pm.host.getServiceByInstance<TaskLedgerService>(selection.instanceId, SESSION_LEDGER_CONTRACT) ??
                pm.host.getServiceByInstance<TaskLedgerService>(selection.instanceId, 'ledger');
              if (ledger && typeof ledger.getOrCreate === 'function') {
                return ledger.getOrCreate(session);
              }
            }
            const hostLedger = pm.host.get<TaskLedgerService>('ledger');
            if (hostLedger && typeof hostLedger.getOrCreate === 'function') {
              return hostLedger.getOrCreate(session);
            }
          }
          return params.store.getTaskState(sessionId) ?? undefined;
        },
      });

      const serviceV1: SessionCompressionServiceV1 = {
        isEnabled: () => active,
        async getConfig() {
          if (!active) return peerErr('plugin_disabled', '上下文压缩与符号索引插件已停用');
          return peerOk({
            enabled: active,
            config: compressor.getConfig() as unknown as Record<string, unknown>,
          });
        },
        async updateConfig(patch) {
          if (!active) return peerErr('plugin_disabled', '上下文压缩与符号索引插件已停用');
          const config = compressor.updateConfig(patch as Parameters<ContextCompressionService['updateConfig']>[0]);
          return peerOk({
            enabled: active,
            config: config as unknown as Record<string, unknown>,
          });
        },
        async getStatus(request) {
          if (!active) return peerErr('plugin_disabled', '上下文压缩与符号索引插件已停用');
          try {
            const status = await compressor.getSessionStatus(request.sessionId);
            return peerOk(status as unknown as Record<string, unknown>);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return peerErr('not_found', msg);
          }
        },
        async compressRange(request) {
          if (!active) return peerErr('plugin_disabled', '上下文压缩与符号索引插件已停用');
          const session = params.store.getSession(request.sessionId);
          if (!session) {
            return peerErr('not_found', `Session not found: ${request.sessionId}`);
          }
          try {
            const fromSeq = request.fromSeq ?? 1;
            const toSeq = request.toSeq ?? session.lastSeq;
            const budgetChars = request.budgetChars ?? 6_000;
            const result = await compressor.compressRange(request.sessionId, fromSeq, toSeq, budgetChars, {
              forceRecompute: request.forceRecompute,
            });
            const status = await compressor.getSessionStatus(request.sessionId);
            return peerOk({ result, status });
          } catch (err) {
            return peerErr('conflict', err instanceof Error ? err.message : String(err));
          }
        },
        async clearCache(request) {
          if (!active) return peerErr('plugin_disabled', '上下文压缩与符号索引插件已停用');
          try {
            const cleared = compressor.clearSessionCache(request.sessionId);
            const status = await compressor.getSessionStatus(request.sessionId);
            return peerOk({ ...cleared, status });
          } catch (err) {
            return peerErr('not_found', err instanceof Error ? err.message : String(err));
          }
        },
        async buildSymbolOutline(request) {
          if (!active) return peerErr('plugin_disabled', '上下文压缩与符号索引插件已停用');
          const res = await compressor.buildSymbolOutline(
            request.workspacePath,
            request.filePaths,
            request.maxChars,
          );
          return peerOk(res as unknown as Record<string, unknown>);
        },
      };

      ctx.provide('compressor', compressor);
      ctx.provide(SESSION_COMPRESSION_CONTRACT, serviceV1, {
        version: SESSION_COMPRESSION_CONTRACT_VERSION,
        metadata: { title: 'AI 上下文压缩与符号索引' },
      });

      ctx.on('turn.completed', ({ sessionId, data }) => {
        if (!active) return;
        if (!data.maintenance && sessionId) {
          compressor.scheduleIdleRollup(sessionId);
        }
      });

      ctx.effect(() => () => {
        active = false;
        compressor.onPluginDisabled();
      });
    },
  };
}
