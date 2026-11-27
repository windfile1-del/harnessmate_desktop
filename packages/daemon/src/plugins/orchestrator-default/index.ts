import crypto from 'node:crypto';
import {
  SESSION_ORCHESTRATION_CONTRACT,
  SESSION_ORCHESTRATION_CONTRACT_VERSION,
  type ServiceMethodResult,
  type SessionOrchestrationServiceV1,
  type SessionRecordDto,
} from '@harnessmate/plugin-api';

const SESSION_LEDGER_CONTRACT = 'session.ledger.v1';
import type {
  AttentionItem,
  CanonicalEvent,
  PermissionMode,
  ReasoningEffort,
  Session,
  SubagentStatus,
} from '@harnessmate/protocol';
import { resolveDriverForScope } from '../../core/driver-peer-router.js';
import {
  ORCHESTRATOR_PLUGIN_ID,
  OrchestratorError,
  OrchestratorService,
  type OrchestratorWorktreePolicy,
} from '../../core/orchestrator-service.js';
import {
  findSessionWithProvider,
  findWorkspaceWithProvider,
  recordResourceOwner,
  resolveSessionDataProvider,
  resolveSessionRuntimeProvider,
} from '../../core/session-peer-router.js';
import type { TaskLedgerService } from '../../core/task-ledger-service.js';
import { resolveOptionalGitWorkspaceProvider, unwrapPeerServiceResult } from '../../core/w1-service-helpers.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import { gitService as defaultGitService, type GitService } from '../../plugin-host/builtin/services.js';
import { sessionPluginEvent } from '../../plugin-host/runtime/events.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { PluginManager } from '../plugin-manager.js';

export { ORCHESTRATOR_PLUGIN_ID };

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr<T = never>(
  code: 'invalid_request' | 'permission_denied' | 'not_found' | 'conflict' | 'busy' | 'plugin_disabled',
  message: string,
): ServiceMethodResult<T> {
  return { ok: false, error: { code, message } };
}

function mapOrchestratorErrCode(code: string): 'invalid_request' | 'permission_denied' | 'not_found' | 'conflict' | 'busy' | 'plugin_disabled' {
  switch (code) {
    case 'E_PLUGIN_DISABLED':
      return 'plugin_disabled';
    case 'E_SUBAGENT_NOT_FOUND':
    case 'E_SESSION_NOT_FOUND':
    case 'E_WORKSPACE_NOT_FOUND':
    case 'E_TARGET_INSTANCE_NOT_FOUND':
      return 'not_found';
    case 'E_SUBAGENT_BUSY':
      return 'busy';
    case 'E_CONSUMER_PROVENANCE_BLOCKED':
      return 'permission_denied';
    case 'E_MERGE_CONFLICT':
    case 'E_SUBAGENT_ACTIVE':
    case 'E_GIT_REPO_REQUIRED':
      return 'conflict';
    default:
      return 'invalid_request';
  }
}

function toSessionModel(dto: SessionRecordDto): Session {
  return {
    id: dto.id,
    workspaceId: dto.workspaceId,
    harnessId: dto.harnessId,
    harnessKind: dto.harnessKind,
    nativeSessionId: dto.nativeSessionId,
    parentSessionId: dto.parentSessionId ?? null,
    forkedFromTurnSeq: dto.forkedFromTurnSeq ?? null,
    forkMode: dto.forkMode === 'clean_fork' ? 'native' : dto.forkMode === 'with_context' ? 'portable' : null,
    importMode: dto.importMode ?? null,
    importSource: dto.importSource ?? null,
    participatingHarnesses: dto.participatingHarnesses ?? [dto.harnessId],
    contextSyncMode: dto.contextSyncMode ?? 'auto',
    cwd: dto.cwd,
    worktreeBranch: dto.worktreeBranch ?? null,
    title: dto.title,
    status: dto.status as Session['status'],
    model: dto.model,
    actualModel: dto.actualModel ?? null,
    modelReroutedReason: dto.modelReroutedReason ?? null,
    reasoningEffort: (dto.reasoningEffort as ReasoningEffort | null) ?? null,
    permissionMode: dto.permissionMode as PermissionMode,
    lastSeq: dto.lastSeq,
    usage: dto.usage ?? null,
    pendingApprovalCount: dto.pendingApprovalCount,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

export interface OrchestratorRuntimeBridge {
  emitCanonical?: (
    sessionId: string,
    type: CanonicalEvent['type'],
    payload: Record<string, unknown>,
    turnId?: string | null,
  ) => CanonicalEvent;
  publishAttention?: (item: AttentionItem) => void;
  sendTurn?: (
    sessionId: string,
    text: string,
    opts?: { omitHandoff?: boolean; literalText?: boolean },
  ) => Promise<{ turnId: string }>;
  interruptSession?: (sessionId: string) => Promise<void>;
  disposeSessionHandles?: (sessionId: string) => Promise<void>;
}

export function createOrchestratorPlugin(params: {
  store: HarnessMateStore;
  registry: HarnessRegistry;
  getPluginManager?: () => PluginManager;
  bridge?: OrchestratorRuntimeBridge;
}): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  return {
    provides: [SESSION_ORCHESTRATION_CONTRACT, 'orchestrator'],
    inject: ['git'],
    apply(ctx, settings) {
      let active = true;
      const cfg = (settings ?? {}) as {
        maxDepth?: number;
        maxConcurrent?: number;
        defaultTimeoutMs?: number;
        worktreePolicy?: OrchestratorWorktreePolicy;
      };
      const orchestrator = new OrchestratorService(params.store, params.registry, {
        maxDepth: typeof cfg.maxDepth === 'number' ? cfg.maxDepth : undefined,
        maxConcurrent: typeof cfg.maxConcurrent === 'number' ? cfg.maxConcurrent : undefined,
        defaultTimeoutMs: typeof cfg.defaultTimeoutMs === 'number' ? cfg.defaultTimeoutMs : undefined,
        worktreePolicy: cfg.worktreePolicy,
      });

      const resolvePluginManager = () => params.getPluginManager?.();

      orchestrator.attachHooks({
        isOrchestratorEnabled: () => active,
        resolveTargetAdapter: (targetInstanceId, parentSession) => {
          const pm = resolvePluginManager();
          if (!pm) return params.registry.get(targetInstanceId);
          return resolveDriverForScope(pm, params.registry, {
            harnessId: targetInstanceId,
            workspaceId: parentSession.workspaceId,
            sessionId: parentSession.id,
            store: params.store,
          }).adapter;
        },
        getSession: async (sessionId) => {
          const pm = resolvePluginManager();
          if (pm) {
            const found = await findSessionWithProvider(pm, sessionId).catch(() => null);
            if (found) return toSessionModel(found.session);
          }
          return params.store.getSession(sessionId);
        },
        getWorkspace: async (workspaceId) => {
          const pm = resolvePluginManager();
          if (pm) {
            const found = await findWorkspaceWithProvider(pm, workspaceId).catch(() => null);
            if (found) return found.workspace;
          }
          return params.store.getWorkspace(workspaceId);
        },
        createChildSession: async ({
          parentSession,
          targetInstanceId,
          roleTitle,
          cwd,
          worktreeBranch,
          permissionMode,
          model,
        }) => {
          const pm = resolvePluginManager();
          const driverSelection = pm
            ? resolveDriverForScope(pm, params.registry, {
                harnessId: targetInstanceId,
                workspaceId: parentSession.workspaceId,
                sessionId: parentSession.id,
                store: params.store,
              })
            : null;
          const adapter = driverSelection?.adapter ?? params.registry.get(targetInstanceId);
          if (!adapter) {
            throw new Error(`Target harness instance not registered: ${targetInstanceId}`);
          }
          const resolvedHarnessId = driverSelection?.harnessId ?? adapter.id;
          const childId = `sess_${crypto.randomBytes(6).toString('hex')}`;
          const now = Date.now();

          if (pm) {
            try {
              const dataProvider = resolveSessionDataProvider(pm, {
                workspaceId: parentSession.workspaceId,
                sessionId: parentSession.id,
              });
              const createdRes = unwrapPeerServiceResult(
                await dataProvider.service.createSession({
                  session: {
                    id: childId,
                    workspaceId: parentSession.workspaceId,
                    harnessId: resolvedHarnessId,
                    harnessKind: adapter.kind,
                    nativeSessionId: null,
                    parentSessionId: parentSession.id,
                    participatingHarnesses: [resolvedHarnessId],
                    contextSyncMode: parentSession.contextSyncMode,
                    cwd,
                    worktreeBranch,
                    title: `[子任务] ${roleTitle}`.slice(0, 160),
                    status: 'idle',
                    model: model ?? null,
                    actualModel: null,
                    modelReroutedReason: null,
                    reasoningEffort: parentSession.reasoningEffort,
                    permissionMode,
                    lastSeq: 0,
                    usage: null,
                    pendingApprovalCount: 0,
                    createdAt: now,
                    updatedAt: now,
                  },
                }),
              );
              recordResourceOwner(params.store, 'session', createdRes.session.id, dataProvider.instanceId, parentSession.workspaceId);
              const childModel = toSessionModel(createdRes.session);
              if (params.bridge?.emitCanonical) {
                params.bridge.emitCanonical(childModel.id, 'session.status', { status: 'idle' });
              }
              await pm.dispatchLifecycleEvent(
                sessionPluginEvent('session.created', childModel),
                childModel.workspaceId,
              );
              return childModel;
            } catch (err) {
              if (err instanceof OrchestratorError) throw err;
              // Fall back to direct SQLite createSession below when session.data.v1 is unavailable in pure unit tests
            }
          }

          const child = params.store.createSession({
            id: childId,
            workspaceId: parentSession.workspaceId,
            harnessId: resolvedHarnessId,
            harnessKind: adapter.kind,
            nativeSessionId: null,
            parentSessionId: parentSession.id,
            participatingHarnesses: [resolvedHarnessId],
            contextSyncMode: parentSession.contextSyncMode,
            cwd,
            worktreeBranch,
            title: `[子任务] ${roleTitle}`.slice(0, 160),
            status: 'idle',
            model: model ?? null,
            actualModel: null,
            modelReroutedReason: null,
            reasoningEffort: parentSession.reasoningEffort,
            permissionMode,
            lastSeq: 0,
            usage: null,
            pendingApprovalCount: 0,
            createdAt: now,
            updatedAt: now,
          });
          params.bridge?.emitCanonical?.(child.id, 'session.status', { status: 'idle' });
          if (pm) {
            await pm.dispatchLifecycleEvent(sessionPluginEvent('session.created', child), child.workspaceId);
          }
          return params.store.getSession(child.id) ?? child;
        },
        sendTurn: async (sessionId, text, opts) => {
          if (params.bridge?.sendTurn) {
            return params.bridge.sendTurn(sessionId, text, opts);
          }
          const pm = resolvePluginManager();
          if (pm) {
            const session = params.store.getSession(sessionId);
            const runtimeProvider = resolveSessionRuntimeProvider(pm, {
              sessionId,
              workspaceId: session?.workspaceId,
            });
            const receipt = unwrapPeerServiceResult(
              await runtimeProvider.service.sendTurn({
                sessionId,
                text,
                omitHandoff: opts?.omitHandoff ?? true,
                literalText: opts?.literalText ?? true,
              }),
            );
            return { turnId: receipt.turnId };
          }
          throw new OrchestratorError('E_ORCHESTRATOR_NOT_READY', 'sendTurn bridge is unavailable');
        },
        interruptSession: async (sessionId) => {
          if (params.bridge?.interruptSession) {
            return params.bridge.interruptSession(sessionId);
          }
          const pm = resolvePluginManager();
          if (pm) {
            const session = params.store.getSession(sessionId);
            const runtimeProvider = resolveSessionRuntimeProvider(pm, {
              sessionId,
              workspaceId: session?.workspaceId,
            });
            await runtimeProvider.service.interrupt({ sessionId });
          }
        },
        disposeSessionHandles: async (sessionId) => {
          if (params.bridge?.disposeSessionHandles) {
            return params.bridge.disposeSessionHandles(sessionId);
          }
        },
        emitCanonical: (sessionId, type, payload, turnId) => {
          if (params.bridge?.emitCanonical) {
            return params.bridge.emitCanonical(sessionId, type, payload, turnId ?? null);
          }
          return params.store.appendEvent(sessionId, type, payload, turnId ?? null);
        },
        publishAttention: (item) => {
          params.bridge?.publishAttention?.(item);
        },
        getGitService: () => {
          const pm = resolvePluginManager();
          if (pm) {
            const gitProvider = resolveOptionalGitWorkspaceProvider(pm, {});
            if (gitProvider) return gitProvider as unknown as GitService;
          }
          return ctx.get<GitService>('git') ?? defaultGitService;
        },
        getTaskLedger: () => {
          const pm = resolvePluginManager();
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
      });

      orchestrator.recoverOrphanedRuns();

      const serviceV1: SessionOrchestrationServiceV1 = {
        async getLimits() {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          return peerOk(orchestrator.getLimits());
        },
        async getBoard(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          return peerOk(orchestrator.getBoard(request.parentSessionId) as unknown as Record<string, unknown>);
        },
        async listSubagents(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          const subagents = orchestrator.listSubagents(request.parentSessionId, {
            cohortId: request.cohortId,
            status: request.status as SubagentStatus | undefined,
          });
          return peerOk({ subagents: subagents as unknown as Array<Record<string, unknown>> });
        },
        async getSubagentResult(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          try {
            return peerOk(orchestrator.getSubagentResult(request.subagentId) as unknown as Record<string, unknown>);
          } catch (err) {
            if (err instanceof OrchestratorError) {
              return peerErr(mapOrchestratorErrCode(err.code), err.message);
            }
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async delegateTask(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          try {
            const subagent = await orchestrator.delegateTask(request.parentSessionId, {
              targetInstanceId: request.targetInstanceId,
              roleTitle: request.roleTitle,
              prompt: request.prompt,
              isolation: request.isolation ?? 'worktree_write',
              cohortId: request.cohortId,
              requestedApprovalPolicy: request.requestedApprovalPolicy as PermissionMode | undefined,
              model: request.model,
              timeoutMs: request.timeoutMs,
              failFast: request.failFast,
              baseBranch: request.baseBranch,
            });
            return peerOk({ subagent: subagent as unknown as Record<string, unknown> });
          } catch (err) {
            if (err instanceof OrchestratorError) {
              return peerErr(mapOrchestratorErrCode(err.code), err.message);
            }
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async sendToSubagent(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          try {
            const res = await orchestrator.sendToSubagent(request.subagentId, request.text);
            return peerOk({
              subagent: res.subagent as unknown as Record<string, unknown>,
              turnId: res.turnId,
            });
          } catch (err) {
            if (err instanceof OrchestratorError) {
              return peerErr(mapOrchestratorErrCode(err.code), err.message);
            }
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async stopSubagent(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          try {
            const subagent = await orchestrator.stopSubagent(request.subagentId, request.reason, {
              suppressWakeup: request.suppressWakeup,
            });
            return peerOk({ subagent: subagent as unknown as Record<string, unknown> });
          } catch (err) {
            if (err instanceof OrchestratorError) {
              return peerErr(mapOrchestratorErrCode(err.code), err.message);
            }
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async dryRunMergeSubagent(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          try {
            const res = await orchestrator.dryRunMergeSubagent(request.subagentId, request.baseBranch);
            return peerOk(res as unknown as Record<string, unknown>);
          } catch (err) {
            if (err instanceof OrchestratorError) {
              return peerErr(mapOrchestratorErrCode(err.code), err.message);
            }
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async mergeSubagent(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          try {
            const res = await orchestrator.mergeBackSubagent(request.subagentId, {
              baseBranch: request.baseBranch,
              confirmMerge: Boolean(request.confirmMerge),
              cleanupWorktree: request.cleanupWorktree ?? false,
              deleteBranch: request.deleteBranch ?? false,
              commitMessage: request.commitMessage,
            });
            return peerOk(res as unknown as Record<string, unknown>);
          } catch (err) {
            if (err instanceof OrchestratorError) {
              return peerErr(mapOrchestratorErrCode(err.code), err.message);
            }
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async cleanupSubagentWorktree(request) {
          if (!active) return peerErr('plugin_disabled', '多引擎并行编排插件已停用');
          try {
            const res = await orchestrator.cleanupSubagentWorktree(request.subagentId, {
              force: request.force,
              deleteBranch: request.deleteBranch,
            });
            return peerOk(res as unknown as Record<string, unknown>);
          } catch (err) {
            if (err instanceof OrchestratorError) {
              return peerErr(mapOrchestratorErrCode(err.code), err.message);
            }
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
        async notifyChildTurnCompleted(childSessionId) {
          if (!active) return;
          await orchestrator.handleChildTurnCompleted(childSessionId);
        },
        async notifyChildTurnCancelled(childSessionId) {
          if (!active) return;
          await orchestrator.handleChildTurnCancelled(childSessionId);
        },
        async notifyChildTurnFailed(childSessionId, message) {
          if (!active) return;
          await orchestrator.handleChildTurnFailed(childSessionId, message);
        },
        notifyParentSessionIdle(parentSessionId) {
          if (!active) return;
          orchestrator.onParentSessionIdle(parentSessionId);
        },
        notifyChildApproval(childSessionId, approvalId, toolName) {
          if (!active) return;
          orchestrator.handleChildApprovalRequested(childSessionId, approvalId, toolName);
        },
        async recoverOrphanedRuns() {
          const settledCount = orchestrator.recoverOrphanedRuns();
          return peerOk({ settledCount });
        },
      };

      ctx.provide('orchestrator', orchestrator);
      ctx.provide(SESSION_ORCHESTRATION_CONTRACT, serviceV1, {
        version: SESSION_ORCHESTRATION_CONTRACT_VERSION,
        metadata: { title: '多引擎并行编排中心' },
      });

      ctx.effect(() => () => {
        active = false;
        void orchestrator.onPluginDisabled().catch(() => {});
      });
    },
  };
}
