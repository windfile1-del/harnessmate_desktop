import crypto from 'node:crypto';
import {
  PluginApiError,
  SESSION_DATA_CONTRACT,
  SESSION_RUNTIME_CONTRACT,
  SESSION_RUNTIME_CONTRACT_VERSION,
  type PluginManifest,
  type RuntimeActiveTurnStateDto,
  type RuntimePendingRecoveryDto,
  type SendTurnRuntimeReceipt,
  type SendTurnRuntimeRequest,
  type ServiceMethodResult,
  type SessionConfigReceiptDto,
  type SessionDataServiceV1,
  type SessionRecordDto,
  type SessionRuntimeServiceV1,
  type SessionTurnReceiptDto,
} from '@harnessmate/plugin-api';
import type {
  ApprovalDecision,
  CanonicalEventType,
  HarnessKind,
  PermissionMode,
  ReasoningEffort,
  RuntimeBinding,
  Session,
  SessionStatus,
} from '@harnessmate/protocol';
import type { CommandOutputHub } from '../../core/command-output-hub.js';
import { dispatchTurn } from '../../core/outbound-gate.js';
import type {
  CollaborationBridgePort,
  LegacyRuntimeTurnOptions,
  NativeRuntimePort,
  RuntimeDriverPort,
  RuntimeRequestPort,
} from '../../core/runtime-ports.js';
import {
  findSessionWithProvider,
  listActiveSessionDataProviders,
  resolveSessionDataProvider,
} from '../../core/session-peer-router.js';
import { TextDeltaCoalescer } from '../../core/text-delta-coalescer.js';
import { perfDiagnostics } from '../../core/perf-diagnostics.js';
import { classifyTerminalFailure, FAILOVER_TRIGGER_CLASSES } from '../../core/failover-service.js';
import type { AdapterSessionConfig, AdapterSessionHandle, HarnessAdapter, NormalizedAdapterEvent } from '../../harnesses/types.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { PluginToolLease } from '../../plugins/plugin-capabilities.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';

export const SESSION_RUNTIME_DEFAULT_PLUGIN_ID = 'hm.plugin.session-runtime-default';

export const SESSION_RUNTIME_DEFAULT_MANIFEST: PluginManifest = {
  id: SESSION_RUNTIME_DEFAULT_PLUGIN_ID,
  name: '默认会话运行插件',
  version: '1.0.0',
  description: '负责会话活动句柄池、轮次启动互斥、请求幂等、未知结果保护、增量流合批、配置回执与崩溃恢复的默认运行时实现。',
  author: 'HarnessMate Core',
  category: 'workflow',
  provides: [SESSION_RUNTIME_CONTRACT],
  contributes: {},
};

const MAX_WARM_HANDLES = 6;
const MAX_STORED_TOOL_OUTPUT_CHARS = 16_384;
const MAX_TURN_ITEM_TEXT_CHARS = 512_000;

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr<T = never>(
  code: 'invalid_request' | 'permission_denied' | 'not_found' | 'conflict' | 'busy' | 'plugin_disabled' | 'not_supported',
  message: string,
): ServiceMethodResult<T> {
  return { ok: false, error: { code, message } };
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
    status: dto.status as SessionStatus,
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

function hashSendRequest(req: SendTurnRuntimeRequest, resolvedHarnessId: string): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        sessionId: req.sessionId,
        text: req.text,
        harnessId: resolvedHarnessId,
        model: req.model ?? null,
        turnOptions: req.turnOptions ?? null,
        cliCommand: req.cliCommand ?? null,
        nativeSkill: req.nativeSkill ?? null,
      }),
    )
    .digest('hex');
}

interface LiveHandleEntry {
  key: string;
  sessionId: string;
  harnessId: string;
  harnessKind: HarnessKind;
  providerPluginId?: string;
  providerInstanceId?: string;
  providerRunId?: string;
  adapter: HarnessAdapter;
  handle: AdapterSessionHandle;
  unsubscribe: () => void;
  nativeToGlobalApprovalId: Map<string, string>;
  lastUsedAt: number;
  pluginToolKey: string;
  pluginToolLease?: PluginToolLease;
  nativeBinding?: RuntimeBinding;
  dataInstanceId: string;
  generation: number;
  disposed: boolean;
  requestedPermissionMode: PermissionMode;
  lastConfirmedConfig?: {
    model?: string | null;
    thoughtLevel?: string | null;
    modeId?: string | null;
    permissionEnforcement?: 'native' | 'client_guard' | null;
    actualModel?: string | null;
  };
}

interface ActiveTurnMeta {
  runId: string;
  turnId: string;
  harnessId: string;
  harnessKind: HarnessKind;
  providerInstanceId?: string;
  providerRunId?: string;
  model: string | null;
  actualModel: string | null;
  turnSeq?: number;
  preTurnTreeSha?: string | null;
  advanceWatermark?: boolean;
  reloadHandle?: boolean;
  maintenance?: boolean;
  requestId?: string;
  requestHash?: string;
  dataInstanceId: string;
  turnGeneration: number;
  startedAt: number;
  settled: boolean;
}

export interface SessionRuntimeDefaultController {
  isActive(): boolean;
  sendTurnWithLegacyOptions(
    req: SendTurnRuntimeRequest,
    legacyOpts?: LegacyRuntimeTurnOptions,
  ): Promise<SendTurnRuntimeReceipt>;
  hasLiveHandle(sessionId: string, harnessId: string, expectedHandle?: AdapterSessionHandle): boolean;
  getLiveHandle(sessionId: string, harnessId: string): AdapterSessionHandle | undefined;
  resolveApprovalOnLiveHandle(
    sessionId: string,
    nativeRequestId: string,
    decision: ApprovalDecision,
    comment?: string,
    secretPayload?: string,
    questionAnswer?: Parameters<NonNullable<AdapterSessionHandle['resolveQuestion']>>[1],
  ): Promise<boolean>;
  settleHeldNativeTurn(params: Parameters<import('../../harnesses/agy/native/wiring/types.js').NativeTurnSettlementSink['settleTurn']>[0]): { readonly settled: boolean; readonly reason?: string };
  disposeSessionHandles(sessionId: string): Promise<void>;
  disposeLiveHandle(sessionId: string, harnessId: string): Promise<void>;
  closeSessionsForHarness(harnessId: string): Promise<void>;
  listActiveTurnSessionIds(): string[];
  hasActiveTurn(sessionId: string): boolean;
  getActiveTurnId(sessionId: string): string | undefined;
  flushSessionDeltas(sessionId: string): void;
  getLiveHandleInfo(sessionId: string, harnessId: string): {
    handle: AdapterSessionHandle;
    pluginToolKey: string;
    pluginToolLease?: PluginToolLease;
  } | undefined;
}

export interface DefaultSessionRuntimeDeps {
  getPluginManager: () => PluginManager;
  driverPort: RuntimeDriverPort;
  nativePort: NativeRuntimePort;
  requestPort: RuntimeRequestPort;
  collabPort: CollaborationBridgePort;
  commandOutputHub: CommandOutputHub;
  resolveHistorySourceMetadata?: (
    sessionId: string,
    nativeSessionId: string | null,
  ) => { source?: string; sourcePath?: string } | null;
  onControllerReady?: (controller: SessionRuntimeDefaultController | null) => void;
}

export function createDefaultSessionRuntimePlugin(
  deps: DefaultSessionRuntimeDeps,
): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  return {
    provides: [SESSION_RUNTIME_CONTRACT],
    apply(ctx) {
      const pluginManager = deps.getPluginManager();
      const runtimeInstanceId = ctx.instanceId ?? SESSION_RUNTIME_DEFAULT_PLUGIN_ID;
      const runtimeRunId = crypto.randomUUID();
      let active = true;
      let acceptingTurns = true;
      let generationCounter = 0;

      const liveHandles = new Map<string, LiveHandleEntry>();
      const activeTurnMeta = new Map<string, ActiveTurnMeta>();
      const startingSessions = new Set<string>();
      const pendingRecoveries = new Map<string, RuntimePendingRecoveryDto>();
      const settledTurnIds = new Set<string>();
      const sessionCommitQueues = new Map<string, Promise<unknown>>();
      const activeDataInstances = new Set<string>(
        listActiveSessionDataProviders(pluginManager).map((p) => p.instanceId),
      );

      const handleKey = (sessionId: string, harnessId: string): string => `${sessionId}::${harnessId}`;

      const recordSettledTurn = (turnId: string) => {
        settledTurnIds.add(turnId);
        if (settledTurnIds.size > 2_000) {
          const oldest = settledTurnIds.values().next().value;
          if (oldest) settledTurnIds.delete(oldest);
        }
      };

      const resolveData = (sessionId: string, preferredInstanceId?: string): {
        instanceId: string;
        service: SessionDataServiceV1;
      } => {
        const resolved = resolveSessionDataProvider(pluginManager, {
          explicitInstanceId: preferredInstanceId,
          sessionId,
        });
        return { instanceId: resolved.instanceId, service: resolved.service };
      };

      const enqueueSessionCommit = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
        const enqueuedAt = Date.now();
        perfDiagnostics.adjustQueueDepth('runtimeCommit', 1);
        const prev = sessionCommitQueues.get(sessionId) ?? Promise.resolve();
        const run = async () => {
          const startedAt = Date.now();
          try {
            return await fn();
          } finally {
            const depthAfter = perfDiagnostics.adjustQueueDepth('runtimeCommit', -1);
            perfDiagnostics.recordBatchFlush('runtimeCommit', {
              batchSize: 1,
              backlogMs: startedAt - enqueuedAt,
              queueDepthAfter: depthAfter,
            });
          }
        };
        const next = prev.then(run, run);
        const settled = next.then(() => undefined, () => undefined);
        sessionCommitQueues.set(sessionId, settled);
        void settled.finally(() => {
          if (sessionCommitQueues.get(sessionId) === settled) {
            sessionCommitQueues.delete(sessionId);
          }
        });
        return next;
      };

      const publishCommitted = (
        session: Session | SessionRecordDto | null | undefined,
        committedEvents: Array<{
          sessionId: string;
          seq: number;
          type: string;
          turnId: string | null;
          payload: Record<string, unknown>;
          createdAt: number;
        }>,
      ) => {
        for (const ev of committedEvents) {
          deps.collabPort.publishCanonicalEvent({
            sessionId: ev.sessionId,
            seq: ev.seq,
            type: ev.type as CanonicalEventType,
            turnId: ev.turnId,
            payload: ev.payload,
            createdAt: ev.createdAt,
          });
        }
        if (session && committedEvents.length > 0 && typeof ctx.services?.publish === 'function') {
          try {
            ctx.services.publish(SESSION_RUNTIME_CONTRACT, {
              kind: 'events_committed',
              sessionId: session.id,
              runtimeInstanceId,
              runtimeRunId,
              lastSeq: committedEvents[committedEvents.length - 1]!.seq,
            });
          } catch {
            // Best-effort runtime channel notify
          }
        }
      };

      const commitToData = async (
        sessionId: string,
        dataInstanceId: string | undefined,
        batch: Parameters<SessionDataServiceV1['commitBatch']>[0],
      ) => {
        const { instanceId, service } = resolveData(sessionId, dataInstanceId);
        const res = await service.commitBatch(batch);
        if (!res.ok) {
          throw new PluginApiError(
            res.error.code === 'plugin_disabled' ? 'E_PLUGIN_DISABLED' : 'E_SERVICE_UNAVAILABLE',
            res.error.message,
          );
        }
        publishCommitted(res.value.session, res.value.committedEvents);
        return { instanceId, ...res.value };
      };

      const pendingDeltaBatches = new Map<string, Promise<unknown>>();

      const deltaCoalescer = new TextDeltaCoalescer({
        windowMs: 20,
        onFlush: (batch) => {
          const meta = activeTurnMeta.get(batch.sessionId);
          const targetDataInstanceId = meta?.dataInstanceId;
          const evType: CanonicalEventType = batch.channel === 'assistant' ? 'message.assistant.delta' : 'thinking.delta';
          const payload = batch.channel === 'assistant'
            ? {
                text: batch.text,
                messageId: batch.messageId,
                parentToolUseId: batch.parentToolUseId,
                harnessId: batch.harnessId,
                actualModel: batch.actualModel,
              }
            : { text: batch.text };

          const task = enqueueSessionCommit(batch.sessionId, async () => {
            if (!active) return;
            try {
              await commitToData(batch.sessionId, targetDataInstanceId, {
                sessionId: batch.sessionId,
                events: [{ type: evType, turnId: batch.turnId, payload }],
                trace: { runtimeReceivedAt: batch.firstReceivedAt },
              });
            } catch {
              // Data plugin unavailable during delta flush: recorded via handle disconnect/data disable handler
            }
          });
          pendingDeltaBatches.set(batch.sessionId, task);
          void task.finally(() => {
            if (pendingDeltaBatches.get(batch.sessionId) === task) {
              pendingDeltaBatches.delete(batch.sessionId);
            }
          });
        },
      });

      const flushSessionDeltasAndWait = async (sessionId: string): Promise<void> => {
        deltaCoalescer.flushSession(sessionId);
        const pending = pendingDeltaBatches.get(sessionId);
        if (pending) await pending.catch(() => {});
      };

      const withSessionStartup = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
        if (startingSessions.has(sessionId)) {
          throw new PluginApiError('E_CONFLICT', 'Session operation already in progress. Please retry in a moment.');
        }
        startingSessions.add(sessionId);
        try {
          return await fn();
        } finally {
          startingSessions.delete(sessionId);
        }
      };

      const disposeLiveHandleEntry = async (entry: LiveHandleEntry): Promise<void> => {
        if (entry.disposed) return;
        try { deps.requestPort.cancelSessionApprovals(entry.sessionId, 'driver_connection_stopped', undefined, `${entry.providerRunId ?? 'local'}:${entry.generation}`); } catch {}
        entry.disposed = true;
        if (liveHandles.get(entry.key) === entry) {
          liveHandles.delete(entry.key);
        }
        try { entry.unsubscribe(); } catch {}
        try { entry.pluginToolLease?.release(); } catch {}
        await entry.handle.dispose().catch(() => {});
      };

      const disposeLiveHandle = async (sessionId: string, harnessId: string): Promise<void> => {
        const entry = liveHandles.get(handleKey(sessionId, harnessId));
        if (entry) await disposeLiveHandleEntry(entry);
      };

      const disposeSessionHandles = async (sessionId: string): Promise<void> => {
        const targets = [...liveHandles.values()].filter((e) => e.sessionId === sessionId);
        await Promise.all(targets.map((e) => disposeLiveHandleEntry(e)));
      };

      const closeSessionsForHarness = async (harnessId: string): Promise<void> => {
        const targets = [...liveHandles.values()].filter((e) => e.harnessId === harnessId);
        await Promise.all(targets.map((e) => disposeLiveHandleEntry(e)));
      };

      const evictOldestIdleHandle = async (): Promise<void> => {
        let oldest: LiveHandleEntry | undefined;
        for (const entry of liveHandles.values()) {
          const meta = activeTurnMeta.get(entry.sessionId);
          if (meta && meta.harnessId === entry.harnessId) continue;
          if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
        }
        if (oldest) await disposeLiveHandleEntry(oldest);
      };

      const handleAdapterEvent = async (
        entry: LiveHandleEntry,
        rawEv: NormalizedAdapterEvent,
        opts?: { bypassNativeHold?: boolean; settledTurnOverride?: string },
      ): Promise<void> => {
        // Generation & handle-ownership fence: ignore callbacks from disposed or replaced handles
        if (!active || entry.disposed || liveHandles.get(entry.key) !== entry) return;
        const runtimeReceivedAt = Date.now();

        const sessionId = entry.sessionId;
        const eventHarnessId = entry.harnessId;
        const eventHarnessKind = entry.harnessKind;
        const ev = rawEv;
        const evTurnId = 'turnId' in ev && typeof ev.turnId === 'string' ? ev.turnId : undefined;

        const currentMeta = activeTurnMeta.get(sessionId);
        if (evTurnId && settledTurnIds.has(evTurnId) && !(opts?.bypassNativeHold && ev.type === 'turn.completed')) {
          return;
        }
        if (currentMeta && evTurnId && currentMeta.turnId !== evTurnId && ev.type !== 'usage.updated') {
          return;
        }
        if (!currentMeta && !opts?.bypassNativeHold && (
          ev.type === 'message.assistant.delta' ||
          ev.type === 'message.assistant.completed' ||
          ev.type === 'thinking.delta' ||
          ev.type === 'tool.call.started' ||
          ev.type === 'tool.call.completed' ||
          ev.type === 'turn.completed' ||
          ev.type === 'turn.failed' ||
          ev.type === 'turn.cancelled'
        )) {
          return;
        }

        const dataServiceRef = (() => {
          try {
            return resolveData(sessionId, entry.dataInstanceId);
          } catch {
            return null;
          }
        })();
        if (!dataServiceRef) {
          if (currentMeta) {
            pendingRecoveries.set(sessionId, {
              sessionId,
              turnId: currentMeta.turnId,
              runId: currentMeta.runId,
              dataInstanceId: entry.dataInstanceId,
              reason: `数据实例 ${entry.dataInstanceId} 不可用或已停用`,
              recordedAt: Date.now(),
            });
          }
          await disposeLiveHandleEntry(entry);
          return;
        }

        if (ev.type === 'message.assistant.delta') {
          const turnId = currentMeta?.turnId ?? ev.turnId;
          deltaCoalescer.push({
            sessionId,
            turnId,
            channel: 'assistant',
            text: ev.text,
            messageId: ev.messageId ?? null,
            parentToolUseId: ev.parentToolUseId ?? null,
            harnessId: currentMeta?.harnessId ?? eventHarnessId,
            actualModel: currentMeta?.actualModel ?? null,
            receivedAt: runtimeReceivedAt,
          });
          return;
        }

        if (ev.type === 'thinking.delta') {
          deltaCoalescer.push({
            sessionId,
            turnId: currentMeta?.turnId ?? ev.turnId,
            channel: 'thinking',
            text: ev.text,
            harnessId: currentMeta?.harnessId ?? eventHarnessId,
            receivedAt: runtimeReceivedAt,
          });
          return;
        }

        if (ev.type === 'tool.call.delta') {
          if (ev.outputDelta) deps.commandOutputHub.append(sessionId, ev.toolCallId, ev.outputDelta, 'stdout');
          if (ev.diffDelta) deps.commandOutputHub.append(sessionId, ev.toolCallId, ev.diffDelta, 'stdout');
          return;
        }

        if (ev.type === 'command.output.delta') {
          deps.commandOutputHub.append(sessionId, ev.toolCallId, ev.chunk, ev.stream ?? 'stdout');
          return;
        }

        if (ev.type === 'tool.call.completed') {
          deps.commandOutputHub.complete(sessionId, ev.toolCallId);
        }

        if (ev.type === 'model.confirmed') {
          entry.lastConfirmedConfig = {
            ...(entry.lastConfirmedConfig ?? {}),
            actualModel: ev.actualModel,
            model: ev.actualModel,
          };
        } else if (ev.type === 'config.confirmed') {
          entry.lastConfirmedConfig = {
            model: ev.model ?? null,
            thoughtLevel: ev.thoughtLevel ?? null,
            modeId: ev.modeId ?? null,
            permissionEnforcement: ev.permissionEnforcement ?? 'native',
          };
          const current = (await findSessionWithProvider(deps.getPluginManager(), sessionId))?.session;
          if (current) {
            const policy = deps.getPluginManager().resolveCapabilityBinding('approval.policy.v1', { sessionId, workspaceId: current.workspaceId });
            await deps.requestPort.recordMode({ sessionId, requested: entry.requestedPermissionMode,
              policyInstanceId: policy.instanceId ?? null, policyRevision: null,
              status: ev.permissionEnforcement === 'client_guard' ? 'policy_handled' : 'applied',
              execution: ev.permissionEnforcement === 'client_guard' ? 'per_request_policy' : 'driver',
              driverRequested: { permissionMode: entry.requestedPermissionMode }, driverAccepted: { modeId: ev.modeId ?? null, permissionEnforcement: ev.permissionEnforcement ?? 'native' } });
          }

        }

        // Flush any buffered deltas before non-delta boundary events
        if (
          ev.type === 'turn.started' ||
          ev.type === 'turn.completed' ||
          ev.type === 'turn.cancelled' ||
          ev.type === 'turn.failed' ||
          ev.type === 'message.assistant.completed' ||
          ev.type === 'thinking.completed' ||
          ev.type === 'tool.call.started' ||
          ev.type === 'tool.call.completed' ||
          ev.type === 'turn_block.ext'
        ) {
          deltaCoalescer.flushSession(sessionId);
        }

        await enqueueSessionCommit(sessionId, async () => {
          if (!active || entry.disposed || liveHandles.get(entry.key) !== entry) return;

          const latestRes = await dataServiceRef.service.getSession({ sessionId });
          if (!latestRes.ok || !latestRes.value.session) return;
          const sessionDto = latestRes.value.session;
          const sessionModel = toSessionModel(sessionDto);
          const meta = activeTurnMeta.get(sessionId);
          if (meta && evTurnId && meta.turnId !== evTurnId && ev.type !== 'usage.updated') return;

          const activeTurnHarness = meta?.harnessId ?? eventHarnessId;
          const activeTurnModel = meta?.model ?? sessionDto.model;
          const activeTurnActualModel = meta?.actualModel ?? sessionDto.actualModel ?? null;

          switch (ev.type) {
            case 'native_session_ready': {
              const bindingRes = await dataServiceRef.service.getHarnessBinding({
                sessionId,
                harnessId: eventHarnessId,
              });
              const prevBinding = bindingRes.ok ? bindingRes.value.binding : null;
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                ...(sessionDto.harnessId === eventHarnessId
                  ? { sessionPatch: { nativeSessionId: ev.nativeSessionId } }
                  : {}),
                bindingUpsert: {
                  sessionId,
                  harnessId: eventHarnessId,
                  harnessKind: eventHarnessKind,
                  nativeSessionId: ev.nativeSessionId,
                  lastModel: prevBinding?.lastModel ?? sessionDto.model,
                  lastActualModel: prevBinding?.lastActualModel ?? sessionDto.actualModel ?? null,
                  lastEffort: prevBinding?.lastEffort ?? sessionDto.reasoningEffort,
                  syncedUpToSeq: prevBinding?.syncedUpToSeq ?? 0,
                  driverUsed: prevBinding?.driverUsed ?? null,
                  updatedAt: Date.now(),
                },
              });
              break;
            }

            case 'model.confirmed': {
              if (meta && meta.harnessId === eventHarnessId) meta.actualModel = ev.actualModel;
              entry.lastConfirmedConfig = {
                ...(entry.lastConfirmedConfig ?? {}),
                actualModel: ev.actualModel,
                model: ev.actualModel,
              };
              const bindingRes = await dataServiceRef.service.getHarnessBinding({
                sessionId,
                harnessId: eventHarnessId,
              });
              const prevBinding = bindingRes.ok ? bindingRes.value.binding : null;
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                ...(sessionDto.harnessId === eventHarnessId
                  ? {
                      sessionPatch: {
                        actualModel: ev.actualModel,
                        modelReroutedReason: ev.reroutedFrom
                          ? ev.reason || `请求 ${ev.reroutedFrom}，实际使用 ${ev.actualModel}`
                          : null,
                      },
                    }
                  : {}),
                bindingUpsert: {
                  sessionId,
                  harnessId: eventHarnessId,
                  harnessKind: eventHarnessKind,
                  nativeSessionId: prevBinding?.nativeSessionId ?? null,
                  lastModel: prevBinding?.lastModel ?? sessionDto.model,
                  lastActualModel: ev.actualModel,
                  lastEffort: prevBinding?.lastEffort ?? sessionDto.reasoningEffort,
                  syncedUpToSeq: prevBinding?.syncedUpToSeq ?? 0,
                  driverUsed: prevBinding?.driverUsed ?? null,
                  updatedAt: Date.now(),
                },
                events: [
                  {
                    type: 'session.model_confirmed',
                    turnId: meta?.turnId ?? null,
                    payload: {
                      harnessId: eventHarnessId,
                      harnessKind: eventHarnessKind,
                      actualModel: ev.actualModel,
                      reroutedFrom: ev.reroutedFrom ?? null,
                      reason: ev.reason ?? null,
                    },
                  },
                ],
              });
              break;
            }

            case 'config.confirmed': {
              entry.lastConfirmedConfig = {
                model: ev.model ?? null,
                thoughtLevel: ev.thoughtLevel ?? null,
                modeId: ev.modeId ?? null,
                permissionEnforcement: ev.permissionEnforcement ?? 'native',
                actualModel: ev.model ?? entry.lastConfirmedConfig?.actualModel ?? null,
              };
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                events: [
                  {
                    type: 'session.config_confirmed',
                    turnId: meta?.turnId ?? null,
                    payload: {
                      harnessId: eventHarnessId,
                      model: ev.model ?? null,
                      thoughtLevel: ev.thoughtLevel ?? null,
                      availableThoughtLevels: ev.availableThoughtLevels ?? [],
                      modeId: ev.modeId ?? null,
                      permissionEnforcement: ev.permissionEnforcement ?? 'native',
                      tierName: ev.tierName ?? null,
                    },
                  },
                ],
              });
              break;
            }

            case 'commands.updated': {
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                events: [
                  {
                    type: 'session.commands_updated',
                    turnId: meta?.turnId ?? null,
                    payload: {
                      harnessId: eventHarnessId,
                      commands: ev.commands,
                    },
                  },
                ],
              });
              break;
            }

            case 'session.title_updated': {
              const nextTitle = ev.title.trim().slice(0, 160);
              if (nextTitle && sessionDto.title.includes('·')) {
                await commitToData(sessionId, entry.dataInstanceId, {
                  sessionId,
                  sessionPatch: { title: nextTitle },
                  events: [
                    {
                      type: 'session.title_updated',
                      turnId: meta?.turnId ?? null,
                      payload: { title: nextTitle, harnessId: eventHarnessId },
                    },
                  ],
                });
              }
              break;
            }

            case 'turn.started': {
              const startedAt = Date.now();
              let contMeta: ActiveTurnMeta | undefined;
              if (ev.continuation && !meta) {
                const contRunId = `run_${crypto.randomBytes(6).toString('hex')}`;
                generationCounter += 1;
                contMeta = {
                  runId: contRunId,
                  turnId: ev.turnId,
                  harnessId: eventHarnessId,
                  harnessKind: eventHarnessKind,
                  model: activeTurnModel,
                  actualModel: activeTurnActualModel,
                  advanceWatermark: false,
                  dataInstanceId: entry.dataInstanceId,
                  turnGeneration: generationCounter,
                  startedAt,
                  settled: false,
                };
                activeTurnMeta.set(sessionId, contMeta);
              }
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                ...(sessionDto.status !== 'running' ? { sessionPatch: { status: 'running' } } : {}),
                ...(contMeta
                  ? {
                      runStart: {
                        runId: contMeta.runId,
                        sessionId,
                        turnId: ev.turnId,
                        instanceId: eventHarnessId,
                        driverId: eventHarnessKind,
                        model: activeTurnModel,
                        status: 'running',
                        startedAt,
                      },
                    }
                  : {}),
                events: [
                  {
                    type: 'turn.started',
                    turnId: ev.turnId,
                    payload: {
                      harnessId: eventHarnessId,
                      harnessKind: eventHarnessKind,
                      model: activeTurnModel,
                      actualModel: activeTurnActualModel,
                    },
                  },
                  ...(sessionDto.status !== 'running'
                    ? [{ type: 'session.status', turnId: null, payload: { status: 'running' } }]
                    : []),
                ],
              });
              break;
            }

            case 'message.assistant.completed': {
              const msgId = ev.messageId ?? `${ev.turnId}:assistant:${crypto.randomBytes(3).toString('hex')}`;
              const itemId = `msg:${msgId}`;
              const now = Date.now();
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                trace: { runtimeReceivedAt },
                events: [
                  {
                    type: 'message.assistant.completed',
                    turnId: ev.turnId,
                    payload: {
                      text: ev.text,
                      messageId: msgId,
                      parentToolUseId: ev.parentToolUseId ?? null,
                      harnessId: activeTurnHarness,
                      harnessKind: eventHarnessKind,
                      actualModel: activeTurnActualModel,
                    },
                  },
                ],
                turnItems: [
                  {
                    itemId,
                    schemaVersion: 2,
                    turnId: ev.turnId,
                    instanceId: activeTurnHarness,
                    driverId: eventHarnessKind,
                    blockType: 'assistant_text',
                    status: 'completed',
                    title: 'Assistant',
                    textBody: ev.text.slice(0, MAX_TURN_ITEM_TEXT_CHARS),
                    payload: {
                      messageId: msgId,
                      parentToolUseId: ev.parentToolUseId ?? null,
                      actualModel: activeTurnActualModel,
                    },
                    outputOmitted: false,
                    omittedBytes: 0,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              });
              break;
            }

            case 'thinking.completed': {
              const now = Date.now();
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                events: [
                  {
                    type: 'thinking.completed',
                    turnId: ev.turnId,
                    payload: { text: ev.text, harnessId: activeTurnHarness },
                  },
                ],
                turnItems: ev.text.trim()
                  ? [
                      {
                        itemId: `${ev.turnId}:thinking:${crypto.randomBytes(3).toString('hex')}`,
                        schemaVersion: 2,
                        turnId: ev.turnId,
                        instanceId: activeTurnHarness,
                        driverId: eventHarnessKind,
                        blockType: 'reasoning',
                        status: 'completed',
                        title: 'Thinking',
                        textBody: ev.text.slice(0, MAX_TURN_ITEM_TEXT_CHARS),
                        payload: {},
                        outputOmitted: false,
                        omittedBytes: 0,
                        createdAt: now,
                        updatedAt: now,
                      },
                    ]
                  : [],
              });
              break;
            }

            case 'tool.call.started': {
              const now = Date.now();
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                trace: { runtimeReceivedAt },
                events: [
                  {
                    type: 'tool.call.started',
                    turnId: ev.turnId,
                    payload: {
                      toolCallId: ev.toolCallId,
                      toolName: ev.toolName,
                      toolKind: ev.toolKind,
                      summary: ev.summary,
                      input: ev.input ?? null,
                      parentToolUseId: ev.parentToolUseId ?? null,
                      harnessId: activeTurnHarness,
                    },
                  },
                ],
                turnItems: [
                  {
                    itemId: `tool:${ev.toolCallId}`,
                    schemaVersion: 2,
                    turnId: ev.turnId,
                    instanceId: activeTurnHarness,
                    driverId: eventHarnessKind,
                    blockType: ev.toolKind === 'shell' ? 'command_execution' : 'tool_call',
                    status: 'running',
                    title: ev.toolName,
                    textBody: ev.summary,
                    payload: {
                      toolCallId: ev.toolCallId,
                      toolName: ev.toolName,
                      toolKind: ev.toolKind,
                      summary: ev.summary,
                      input: ev.input ?? null,
                      parentToolUseId: ev.parentToolUseId ?? null,
                    },
                    outputOmitted: false,
                    omittedBytes: 0,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              });
              break;
            }

            case 'tool.call.completed': {
              deps.commandOutputHub.complete(sessionId, ev.toolCallId);
              const hubSnap = deps.commandOutputHub.getSnapshot(sessionId, ev.toolCallId);
              const rawOutput = ev.output ?? hubSnap?.text ?? null;
              const outputBytes = rawOutput ? Buffer.byteLength(rawOutput, 'utf8') : 0;
              const existingRes = await dataServiceRef.service.getTurnItem({
                sessionId,
                itemId: `tool:${ev.toolCallId}`,
              });
              const existingItem = existingRes.ok ? existingRes.value?.item ?? null : null;
              const outputOmitted = Boolean(rawOutput && rawOutput.length > MAX_STORED_TOOL_OUTPUT_CHARS);
              const storedOutput = outputOmitted && rawOutput
                ? rawOutput.slice(0, MAX_STORED_TOOL_OUTPUT_CHARS)
                : rawOutput;
              const turnItemBody = rawOutput
                ? rawOutput.slice(0, MAX_TURN_ITEM_TEXT_CHARS)
                : existingItem?.textBody ?? '';
              const now = Date.now();
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                trace: { runtimeReceivedAt },
                events: [
                  {
                    type: 'tool.call.completed',
                    turnId: ev.turnId,
                    payload: {
                      toolCallId: ev.toolCallId,
                      toolName: ev.toolName,
                      status: ev.status,
                      output: storedOutput,
                      diff: ev.diff ?? null,
                      outputOmitted,
                      omittedBytes: outputOmitted ? outputBytes : 0,
                      harnessId: activeTurnHarness,
                    },
                  },
                ],
                turnItems: [
                  {
                    itemId: `tool:${ev.toolCallId}`,
                    schemaVersion: 2,
                    turnId: ev.turnId,
                    ...(existingItem ? { seq: existingItem.seq } : {}),
                    instanceId: activeTurnHarness,
                    driverId: eventHarnessKind,
                    blockType: existingItem?.blockType ?? 'tool_call',
                    status: ev.status === 'error' ? 'error' : 'completed',
                    title: ev.toolName,
                    textBody: turnItemBody,
                    payload: {
                      ...(existingItem?.payload ?? {}),
                      toolCallId: ev.toolCallId,
                      toolName: ev.toolName,
                      status: ev.status,
                      diff: ev.diff ?? null,
                    },
                    outputOmitted,
                    omittedBytes: outputOmitted ? outputBytes : 0,
                    createdAt: existingItem?.createdAt ?? now,
                    updatedAt: now,
                  },
                ],
              });
              break;
            }

            case 'usage.updated': {
              const prev = sessionDto.usage;
              const merged = {
                inputTokens: Math.max(ev.usage.inputTokens, (prev?.inputTokens ?? 0) + ev.usage.inputTokens),
                outputTokens: Math.max(ev.usage.outputTokens, (prev?.outputTokens ?? 0) + ev.usage.outputTokens),
                cachedTokens:
                  ev.usage.cachedTokens !== undefined
                    ? (prev?.cachedTokens ?? 0) + ev.usage.cachedTokens
                    : prev?.cachedTokens,
                ...(ev.usage.contextTokens !== undefined || prev?.contextTokens !== undefined
                  ? { contextTokens: ev.usage.contextTokens ?? prev?.contextTokens }
                  : {}),
                ...(ev.usage.modelContextWindow !== undefined || prev?.modelContextWindow !== undefined
                  ? { modelContextWindow: ev.usage.modelContextWindow ?? prev?.modelContextWindow }
                  : {}),
                costUsd:
                  ev.usage.costUsd !== undefined
                    ? Number(((prev?.costUsd ?? 0) + ev.usage.costUsd).toFixed(6))
                    : prev?.costUsd,
              };
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                sessionPatch: { usage: merged },
                events: [
                  {
                    type: 'usage.updated',
                    turnId: ev.turnId ?? null,
                    payload: { usage: merged, harnessId: eventHarnessId },
                  },
                ],
              });
              break;
            }

            case 'diagnostic.log': {
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                events: [
                  {
                    type: 'diagnostic.log',
                    turnId: null,
                    payload: {
                      level: ev.level,
                      stream: ev.stream,
                      message: ev.message,
                      harnessId: eventHarnessId,
                    },
                  },
                ],
              });
              break;
            }

            case 'turn_block.ext': {
              const now = Date.now();
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                turnItems: [
                  {
                    itemId: ev.itemId,
                    schemaVersion: 2,
                    turnId: ev.turnId,
                    seq: sessionDto.lastSeq,
                    instanceId: activeTurnHarness,
                    driverId: eventHarnessKind,
                    blockType: ev.blockType,
                    status: ev.status ?? 'completed',
                    title: ev.title,
                    textBody: ev.fallbackSummary,
                    payload: ev.payload,
                    outputOmitted: false,
                    omittedBytes: 0,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              });
              break;
            }

            case 'approval.requested': {
              const inferredKind =
                ev.kind ??
                (ev.toolKind === 'file_edit'
                  ? 'file_change_approval'
                  : ev.toolKind === 'mcp'
                    ? 'mcp_tool_approval'
                    : 'command_approval');
              const supportedDecisions =
                (ev.supportedDecisions ??
                  entry.adapter.capabilitiesV2?.supportedApprovalDecisions ??
                  ['allow_once', 'deny']) as ApprovalDecision[];
              const approval = deps.requestPort.createAndEmitApproval({
                session: sessionModel,
                harnessId: eventHarnessId,
                turnId: ev.turnId ?? null,
                nativeRequestId: ev.nativeRequestId,
                kind: inferredKind,
                toolName: ev.toolName,
                toolKind: ev.toolKind,
                summary: ev.summary,
                input: inferredKind === 'secret_request' ? {} : ((ev.input as Record<string, unknown> | undefined) ?? undefined),
                diffPreview: ev.diffPreview,
                riskLevel: ev.riskLevel,
                supportedDecisions,
                questionSpec: ev.questionSpec ?? null,
                secretSpec: ev.secretSpec ?? null,
                driverGeneration: `${entry.providerRunId ?? 'local'}:${entry.generation}`,
                providerInstanceId: entry.providerInstanceId,
                deliver: async input => {
                  if (entry.disposed || liveHandles.get(entry.key) !== entry || !entry.nativeToGlobalApprovalId.has(ev.nativeRequestId)) return 'unavailable';
                  entry.nativeToGlobalApprovalId.delete(ev.nativeRequestId);
                  if (input.secretValue !== undefined && input.decision !== 'deny') {
                    if (!entry.handle.resolveSecret) return 'unavailable';
                    await entry.handle.resolveSecret(ev.nativeRequestId, input.secretValue);
                  } else if (input.questionAnswer && input.decision !== 'deny' && entry.handle.resolveQuestion) {
                    await entry.handle.resolveQuestion(ev.nativeRequestId, input.questionAnswer);
                  } else await entry.handle.resolveApproval(ev.nativeRequestId, input.decision ?? 'deny', input.comment);
                  return 'acknowledged';
                },
              });
              entry.nativeToGlobalApprovalId.set(ev.nativeRequestId, approval.id);
              deps.collabPort.notifyOrchestratorChildApproval(sessionModel.id, approval.id, approval.toolName);
              break;
            }

            case 'turn.completed': {
              const nativeScope = {
                sessionId,
                driverProviderInstanceId: entry.providerInstanceId,
              };
              if (!opts?.bypassNativeHold && eventHarnessKind === 'agy' && deps.nativePort.isEnabled(nativeScope)) {
                const settlement = deps.nativePort.decideTurnSettlement(
                  ev.turnId,
                  entry.nativeBinding ?? null,
                  nativeScope,
                );
                if (settlement?.kind === 'held') {
                  break;
                }
                if (deps.nativePort.isNativeLifecycleEnabled(nativeScope) && meta && meta.turnId !== ev.turnId) {
                  break;
                }
              }
              if (meta?.settled || settledTurnIds.has(ev.turnId)) break;
              if (meta) meta.settled = true;
              recordSettledTurn(ev.turnId);
              deps.requestPort.expireSessionApprovals(sessionId, (expired) => {
                entry.nativeToGlobalApprovalId.delete(expired.nativeRequestId);
                void entry.handle.resolveApproval(expired.nativeRequestId, 'deny', '轮次已结束').catch(() => {});
              });
              const bindingRes = await dataServiceRef.service.getHarnessBinding({
                sessionId,
                harnessId: eventHarnessId,
              });
              const prevBinding = bindingRes.ok ? bindingRes.value.binding : null;
              const now = Date.now();
              const commitOut = await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                trace: { runtimeReceivedAt },
                sessionPatch: { status: 'idle' },
                ...(meta
                  ? {
                      runFinish: {
                        runId: meta.runId,
                        status: 'completed',
                        endedAt: now,
                      },
                    }
                  : {}),
                settleRunningItemsStatus: 'completed',
                events: [
                  {
                    type: 'turn.completed',
                    turnId: ev.turnId,
                    payload: {
                      stopReason: ev.stopReason ?? 'end_turn',
                      harnessId: eventHarnessId,
                      harnessKind: eventHarnessKind,
                      model: activeTurnModel,
                      actualModel: activeTurnActualModel,
                    },
                  },
                  {
                    type: 'session.status',
                    payload: { status: 'idle' },
                  },
                ],
                ...(meta?.requestId && meta.requestHash
                  ? {
                      turnReceipt: {
                        sessionId,
                        requestId: meta.requestId,
                        requestHash: meta.requestHash,
                        turnId: meta.turnId,
                        runId: meta.runId,
                        status: 'completed',
                        runtimeInstanceId,
                        runtimeRunId,
                        createdAt: meta.startedAt,
                        updatedAt: now,
                      },
                    }
                  : {}),
              });
              const completedEv = commitOut.committedEvents[0];
              if (completedEv) {
                await dataServiceRef.service.upsertHarnessBinding({
                  binding: {
                    sessionId,
                    harnessId: eventHarnessId,
                    harnessKind: eventHarnessKind,
                    nativeSessionId: prevBinding?.nativeSessionId ?? sessionDto.nativeSessionId,
                    lastModel: activeTurnModel,
                    lastActualModel: activeTurnActualModel,
                    lastEffort: sessionDto.reasoningEffort,
                    syncedUpToSeq: meta?.advanceWatermark !== false ? completedEv.seq : prevBinding?.syncedUpToSeq ?? 0,
                    driverUsed: prevBinding?.driverUsed ?? null,
                    updatedAt: Date.now(),
                  },
                });
              }
              activeTurnMeta.delete(sessionId);
              if (meta) {
                void deps.collabPort.capturePostTurnCheckpoint({
                  session: sessionModel,
                  turnSeq: meta.turnSeq,
                  preTurnTreeSha: meta.preTurnTreeSha,
                  maintenance: meta.maintenance,
                }).then((ckpt) => {
                  if (!ckpt) return;
                  void enqueueSessionCommit(sessionId, async () => {
                    await commitToData(sessionId, entry.dataInstanceId, {
                      sessionId,
                      events: [
                        {
                          type: 'checkpoint.captured',
                          turnId: ev.turnId,
                          payload: {
                            checkpoint: ckpt,
                            phase: ckpt.phase,
                            turnSeq: ckpt.turnSeq,
                            filesChanged: ckpt.filesChanged,
                            insertions: ckpt.insertions,
                            deletions: ckpt.deletions,
                          },
                        },
                      ],
                      turnItems: [
                        {
                          itemId: `${ev.turnId}:checkpoint:${ckpt.checkpointId}`,
                          schemaVersion: 2,
                          turnId: ev.turnId,
                          instanceId: meta.harnessId,
                          driverId: meta.harnessKind,
                          blockType: 'checkpoint_marker',
                          status: 'completed',
                          title: `检查点 · Turn #${ckpt.turnSeq}`,
                          textBody: `+${ckpt.insertions} -${ckpt.deletions} · ${ckpt.filesChanged} 个文件变更`,
                          payload: {
                            checkpointId: ckpt.checkpointId,
                            turnSeq: ckpt.turnSeq,
                            phase: ckpt.phase,
                            gitRef: ckpt.gitRef,
                            treeSha: ckpt.treeSha,
                          },
                          outputOmitted: false,
                          omittedBytes: 0,
                          createdAt: Date.now(),
                          updatedAt: Date.now(),
                        },
                      ],
                    }).catch(() => {});
                  });
                }).catch(() => {});
              }
              if (meta?.reloadHandle) void disposeLiveHandleEntry(entry);
              deps.collabPort.notifyOrchestratorTurnCompleted(sessionId);
              deps.collabPort.notifyOrchestratorParentIdle(sessionId);
              deps.collabPort.notifyAttention({
                kind: 'turn_completed',
                sessionId,
                sessionTitle: sessionDto.title,
                harnessId: eventHarnessId,
                summary: `Turn completed (${eventHarnessId})`,
                timestamp: Date.now(),
              });
              break;
            }

            case 'turn.cancelled': {
              if (meta?.settled || settledTurnIds.has(ev.turnId)) break;
              if (meta) meta.settled = true;
              recordSettledTurn(ev.turnId);
              deps.requestPort.cancelSessionApprovals(sessionId, '轮次已取消', (denied) => {
                entry.nativeToGlobalApprovalId.delete(denied.nativeRequestId);
                void entry.handle.resolveApproval(denied.nativeRequestId, 'deny', '轮次已取消').catch(() => {});
              });
              const now = Date.now();
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                sessionPatch: { status: 'idle' },
                ...(meta
                  ? { runFinish: { runId: meta.runId, status: 'cancelled', endedAt: now } }
                  : {}),
                settleRunningItemsStatus: 'interrupted',
                events: [
                  {
                    type: 'turn.cancelled',
                    turnId: ev.turnId,
                    payload: { harnessId: eventHarnessId, harnessKind: eventHarnessKind },
                  },
                  {
                    type: 'session.status',
                    payload: { status: 'idle' },
                  },
                ],
                ...(meta?.requestId && meta.requestHash
                  ? {
                      turnReceipt: {
                        sessionId,
                        requestId: meta.requestId,
                        requestHash: meta.requestHash,
                        turnId: meta.turnId,
                        runId: meta.runId,
                        status: 'cancelled',
                        runtimeInstanceId,
                        runtimeRunId,
                        createdAt: meta.startedAt,
                        updatedAt: now,
                      },
                    }
                  : {}),
              });
              activeTurnMeta.delete(sessionId);
              if (meta?.reloadHandle) void disposeLiveHandleEntry(entry);
              deps.collabPort.notifyOrchestratorTurnCancelled(sessionId);
              deps.collabPort.notifyOrchestratorParentIdle(sessionId);
              break;
            }

            case 'turn.failed': {
              if (meta?.settled || settledTurnIds.has(ev.turnId)) break;
              if (meta) meta.settled = true;
              recordSettledTurn(ev.turnId);
              deps.requestPort.cancelSessionApprovals(sessionId, '轮次执行失败', (denied) => {
                entry.nativeToGlobalApprovalId.delete(denied.nativeRequestId);
                void entry.handle.resolveApproval(denied.nativeRequestId, 'deny', '轮次执行失败').catch(() => {});
              });
              const failureClass = ev.failureClass || classifyTerminalFailure(ev.code, ev.message);
              const cooldownResetsAt = FAILOVER_TRIGGER_CLASSES.has(failureClass)
                ? deps.collabPort.recordFailoverFailure(sessionId, eventHarnessId, failureClass, ev.resetAt ?? undefined)
                : (ev.resetAt ?? null);
              const now = Date.now();
              await commitToData(sessionId, entry.dataInstanceId, {
                sessionId,
                sessionPatch: {
                  status: 'error',
                  ...(ev.code === 'invalid_thinking_signature' && sessionDto.harnessId === eventHarnessId
                    ? { nativeSessionId: null }
                    : {}),
                },
                ...(meta
                  ? { runFinish: { runId: meta.runId, status: 'failed', failureClass, endedAt: now } }
                  : {}),
                settleRunningItemsStatus: 'interrupted',
                events: [
                  {
                    type: 'turn.failed',
                    turnId: ev.turnId,
                    payload: {
                      message: ev.message,
                      code: ev.code ?? null,
                      failureClass,
                      ...(cooldownResetsAt ? { resetsAt: cooldownResetsAt } : {}),
                      harnessId: eventHarnessId,
                      harnessKind: eventHarnessKind,
                      model: activeTurnModel,
                      actualModel: activeTurnActualModel,
                    },
                  },
                  {
                    type: 'session.status',
                    payload: { status: 'error' },
                  },
                ],
                ...(meta?.requestId && meta.requestHash
                  ? {
                      turnReceipt: {
                        sessionId,
                        requestId: meta.requestId,
                        requestHash: meta.requestHash,
                        turnId: meta.turnId,
                        runId: meta.runId,
                        status: 'failed',
                        runtimeInstanceId,
                        runtimeRunId,
                        createdAt: meta.startedAt,
                        updatedAt: now,
                      },
                    }
                  : {}),
              });
              activeTurnMeta.delete(sessionId);
              if (ev.code === 'invalid_thinking_signature') {
                const bRes = await dataServiceRef.service.getHarnessBinding({
                  sessionId,
                  harnessId: eventHarnessId,
                });
                const prevB = bRes.ok ? bRes.value.binding : null;
                if (prevB) {
                  await dataServiceRef.service.upsertHarnessBinding({
                    binding: { ...prevB, nativeSessionId: null, updatedAt: Date.now() },
                  });
                }
              }
              break;
            }
          }
        });
      };

      const ensureLiveHandle = async (
        sessionDto: SessionRecordDto,
        dataService: SessionDataServiceV1,
        dataInstanceId: string,
        harnessId: string,
        handoffContinuity: boolean,
        refreshPluginTools = false,
      ): Promise<LiveHandleEntry> => {
        const key = handleKey(sessionDto.id, harnessId);
        const existing = liveHandles.get(key);
        const scope = {
          sessionId: sessionDto.id,
          workspaceId: sessionDto.workspaceId,
          driverProviderInstanceId: existing?.providerInstanceId,
        };
        const adapter = deps.driverPort.getAdapter(harnessId, scope);
        if (!adapter) {
          throw new PluginApiError('E_SERVICE_UNAVAILABLE', `Harness 驱动实例 ${harnessId} 未注册`);
        }
        const sessionModel = toSessionModel(sessionDto);
        const toolInfo = deps.collabPort.prepareModelTools(sessionModel, harnessId, adapter);
        const toolChanged =
          refreshPluginTools &&
          Boolean(adapter.pluginMcpTransport) &&
          Boolean(
            existing &&
            (existing.pluginToolKey !== toolInfo.pluginToolKey ||
              (existing.pluginToolLease && !toolInfo.isLeaseActive(existing.pluginToolLease))),
          );

        if (existing && !existing.disposed && !toolChanged && existing.dataInstanceId === dataInstanceId) {
          existing.lastUsedAt = Date.now();
          toolInfo.lease?.release();
          return existing;
        }
        if (existing) {
          await disposeLiveHandleEntry(existing);
        } else if (liveHandles.size >= MAX_WARM_HANDLES) {
          await evictOldestIdleHandle();
        }

        const bindingRes = await dataService.getHarnessBinding({
          sessionId: sessionDto.id,
          harnessId,
        });
        const binding = bindingRes.ok ? bindingRes.value.binding : null;
        const nativeSessionId =
          binding?.nativeSessionId ?? (sessionDto.harnessId === harnessId ? sessionDto.nativeSessionId : null);
        const nativeHistory = deps.resolveHistorySourceMetadata?.(sessionDto.id, nativeSessionId) ?? null;

        let nativeBinding: RuntimeBinding | undefined;
        let nativeRuntimeHooks: AdapterSessionConfig['nativeRuntimeHooks'];
        const nativeScope = {
          sessionId: sessionDto.id,
          workspaceId: sessionDto.workspaceId,
          driverProviderInstanceId: adapter.providerInstanceId,
        };
        if (adapter.kind === 'agy' && deps.nativePort.isEnabled(nativeScope)) {
          if (deps.nativePort.isNativeLifecycleEnabled(nativeScope) && deps.nativePort.isSchemaCompatible(nativeScope)) {
            try {
              const prepared = deps.nativePort.prepareSessionBinding({
                sessionId: sessionDto.id,
                workspaceId: sessionDto.workspaceId,
                instanceId: adapter.id,
                driverProviderInstanceId: adapter.providerInstanceId,
                nativeSessionId,
                sourceRef: nativeHistory?.source ?? 'acp',
              });
              if (prepared) {
                nativeBinding = prepared.binding;
                nativeRuntimeHooks = prepared.hooks;
              }
            } catch {
              nativeBinding = undefined;
              nativeRuntimeHooks = undefined;
            }
          } else if (deps.nativePort.isObservatoryTapEnabled(nativeScope)) {
            nativeRuntimeHooks = deps.nativePort.createObservatoryHooks(sessionDto.id, adapter.id, nativeScope);
          }
        }

        const config: AdapterSessionConfig = {
          cwd: sessionDto.cwd,
          model: sessionDto.model,
          reasoningEffort: (sessionDto.reasoningEffort as ReasoningEffort | null) ?? null,
          permissionMode: sessionDto.permissionMode as PermissionMode,
          nativeSessionId,
          nativeHistorySource: nativeHistory?.source as AdapterSessionConfig['nativeHistorySource'],
          nativeHistoryPath: nativeHistory?.sourcePath,
          requireNativeResume: Boolean(nativeHistory || (existing && nativeSessionId)),
          handoffContinuity: handoffContinuity && (adapter.kind === 'codex' || adapter.kind === 'claude'),
          onContinuityNotice: (channel, text) => {
            void enqueueSessionCommit(sessionDto.id, async () => {
              await commitToData(sessionDto.id, dataInstanceId, {
                sessionId: sessionDto.id,
                events: [
                  {
                    type: 'handoff.system_notice',
                    turnId: activeTurnMeta.get(sessionDto.id)?.turnId ?? null,
                    payload: { harnessId, channel, text },
                  },
                ],
              }).catch(() => {});
            });
          },
          ...(nativeRuntimeHooks ? { nativeRuntimeHooks } : {}),
        };

        const selectedPolicy = deps.getPluginManager().resolveCapabilityBinding('approval.policy.v1', { sessionId: sessionDto.id, workspaceId: sessionDto.workspaceId });
        await deps.requestPort.recordMode({ sessionId: sessionDto.id, requested: config.permissionMode,
          policyInstanceId: selectedPolicy.instanceId ?? null, policyRevision: null, status: 'pending_next_session', execution: 'none',
          driverRequested: { permissionMode: config.permissionMode, providerInstanceId: adapter.providerInstanceId, harnessId }, note: '等待驱动配置接受回执' });
        let lease = toolInfo.lease;
        let handle: AdapterSessionHandle;
        const openScope = {
          sessionId: sessionDto.id,
          workspaceId: sessionDto.workspaceId,
          driverProviderInstanceId: adapter.providerInstanceId,
        };
        try {
          handle = await deps.driverPort.openSession(harnessId, {
            ...config,
            ...(lease ? { pluginMcp: lease.connection } : {}),
          }, openScope);
        } catch (error) {
          if (!lease) throw error;
          lease.release();
          lease = undefined;
          handle = await deps.driverPort.openSession(harnessId, config, openScope);
        }

        if (lease && (!handle.pluginMcpAvailable || !toolInfo.isLeaseActive(lease))) {
          lease.release();
          lease = undefined;
        }

        const resolvedNativeId = handle.nativeSessionId ?? nativeSessionId;
        generationCounter += 1;
        const entry: LiveHandleEntry = {
          key,
          sessionId: sessionDto.id,
          harnessId,
          harnessKind: adapter.kind,
          providerPluginId: adapter.providerPluginId,
          providerInstanceId: adapter.providerInstanceId,
          providerRunId: adapter.providerRunId,
          adapter,
          handle,
          unsubscribe: () => {},
          nativeToGlobalApprovalId: new Map(),
          lastUsedAt: Date.now(),
          pluginToolKey: toolInfo.pluginToolKey,
          pluginToolLease: lease,
          nativeBinding,
          dataInstanceId,
          generation: generationCounter,
          disposed: false,
          requestedPermissionMode: config.permissionMode,
        };
        // Register live handle BEFORE handle.onEvent() so synchronously replayed earlyBuffer events
        // pass the liveHandles ownership fence instead of being dropped.
        liveHandles.set(key, entry);
        entry.unsubscribe = handle.onEvent((ev) => {
          void handleAdapterEvent(entry, ev);
        });
        if (nativeBinding) {
          deps.nativePort.notifyReconnect(nativeBinding, nativeSessionId ? 'resume' : 'fresh', nativeScope);
        }
        if (resolvedNativeId) {
          await enqueueSessionCommit(sessionDto.id, async () =>
            commitToData(sessionDto.id, dataInstanceId, {
              sessionId: sessionDto.id,
              ...(sessionDto.harnessId === harnessId && resolvedNativeId !== sessionDto.nativeSessionId
                ? { sessionPatch: { nativeSessionId: resolvedNativeId } }
                : {}),
              bindingUpsert: {
                sessionId: sessionDto.id,
                harnessId,
                harnessKind: adapter.kind,
                nativeSessionId: resolvedNativeId,
                lastModel: sessionDto.model,
                lastActualModel: sessionDto.actualModel ?? null,
                lastEffort: sessionDto.reasoningEffort,
                syncedUpToSeq: resolvedNativeId === nativeSessionId ? binding?.syncedUpToSeq ?? 0 : 0,
                driverUsed: resolvedNativeId === nativeSessionId ? binding?.driverUsed ?? null : null,
                updatedAt: Date.now(),
              },
            }));
        }
        return entry;
      };

      const executeSendTurn = async (
        req: SendTurnRuntimeRequest,
        legacyOpts?: LegacyRuntimeTurnOptions,
      ): Promise<SendTurnRuntimeReceipt> => {
        if (!active || !acceptingTurns) {
          throw new PluginApiError('E_PLUGIN_DISABLED', `会话运行插件 (${runtimeInstanceId}) 已停用或正在排空`);
        }
        return withSessionStartup(req.sessionId, async () => {
          const found = await findSessionWithProvider(
            pluginManager,
            req.sessionId,
            req.dataInstanceId,
          );
          if (!found) {
            throw new PluginApiError('E_INVALID_INPUT', `会话不存在: ${req.sessionId}`);
          }
          const dataInstanceId = found.provider.instanceId;
          const dataService = found.provider.service;
          let sessionDto = found.session;

          const effectiveHarnessId = sessionDto.status === 'running'
            ? sessionDto.harnessId
            : (req.harnessId ?? legacyOpts?.harnessId ?? sessionDto.harnessId);
          const requestId = req.requestId ?? legacyOpts?.requestId;
          const requestHash = requestId ? hashSendRequest(req, effectiveHarnessId) : undefined;

          // Step 1: Idempotency check BEFORE any side effect or external dispatch!
          if (requestId && requestHash) {
            const receiptRes = await dataService.getTurnReceipt({
              sessionId: req.sessionId,
              requestId,
            });
            const existing = receiptRes.ok ? receiptRes.value.receipt : null;
            if (existing) {
              if (existing.requestHash !== requestHash) {
                throw new PluginApiError('E_CONFLICT', `requestId ${requestId} 已绑定到不同的轮次请求参数`);
              }
              // CRITICAL: never auto-re-execute unknown outcomes or duplicate known receipts
              return {
                sessionId: req.sessionId,
                turnId: existing.turnId,
                runId: existing.runId,
                requestId: existing.requestId,
                disposition: 'reused',
                status: existing.status,
                runtimeInstanceId: existing.runtimeInstanceId,
                runtimeRunId: existing.runtimeRunId,
                dataInstanceId,
                harnessId: effectiveHarnessId,
                turnGeneration: 0,
              };
            }
          }

          deps.driverPort.assertDispatchTarget(
            effectiveHarnessId,
            sessionDto.harnessKind,
            legacyOpts?.dispatchProvenance,
          );

          const expectedNativeHandle = legacyOpts?.expectedNativeHandle;
          legacyOpts?.verifyNativeDispatch?.();
          if (
            expectedNativeHandle &&
            (sessionDto.status !== 'idle' ||
              liveHandles.get(handleKey(sessionDto.id, sessionDto.harnessId))?.handle !== expectedNativeHandle)
          ) {
            throw new PluginApiError('E_CONFLICT', 'The bound AGY session is no longer idle and attached');
          }
          if (sessionDto.status === 'awaiting_approval') {
            throw new PluginApiError('E_CONFLICT', 'Session already has a pending approval blocking the turn.');
          }

          // Active steering path when a turn is already running
          if (sessionDto.status === 'running') {
            const adapter = deps.driverPort.getAdapter(sessionDto.harnessId);
            const liveEntry = liveHandles.get(handleKey(sessionDto.id, sessionDto.harnessId));
            const canSteer = Boolean(
              !legacyOpts?.cliCommand &&
                !req.cliCommand &&
                !legacyOpts?.nativeSkill &&
                !req.nativeSkill &&
                adapter?.capabilitiesV2?.supportsActiveSteering &&
                liveEntry?.handle.steerTurn &&
                !liveEntry.disposed &&
                !(sessionDto.harnessKind === 'agy' && deps.nativePort.isNativeLifecycleEnabled()),
            );
            if (!canSteer || !liveEntry?.handle.steerTurn) {
              throw new PluginApiError('E_CONFLICT', 'Session is already running a turn.');
            }
            const activeMeta = activeTurnMeta.get(sessionDto.id);
            const steerTurnId = activeMeta?.turnId ?? `turn_${crypto.randomBytes(6).toString('hex')}`;
            await enqueueSessionCommit(sessionDto.id, async () => {
              await commitToData(sessionDto.id, dataInstanceId, {
                sessionId: sessionDto.id,
                events: [
                  {
                    type: 'message.user',
                    turnId: steerTurnId,
                    payload: {
                      text: req.text,
                      harnessId: sessionDto.harnessId,
                      harnessKind: sessionDto.harnessKind,
                      model: sessionDto.model,
                      actualModel: sessionDto.actualModel ?? null,
                      steered: true,
                    },
                  },
                ],
                turnItems: [
                  {
                    itemId: `${steerTurnId}:user:${crypto.randomBytes(3).toString('hex')}`,
                    schemaVersion: 2,
                    turnId: steerTurnId,
                    instanceId: sessionDto.harnessId,
                    driverId: sessionDto.harnessKind,
                    blockType: 'user_message',
                    status: 'completed',
                    title: 'User',
                    textBody: req.text,
                    payload: { steered: true },
                    outputOmitted: false,
                    omittedBytes: 0,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                  },
                ],
              });
            });
            await liveEntry.handle.steerTurn({
              turnId: steerTurnId,
              text: req.text,
              attachments: req.attachments as never,
              model: sessionDto.model,
              reasoningEffort: (sessionDto.reasoningEffort as ReasoningEffort | null) ?? null,
              permissionMode: sessionDto.permissionMode as PermissionMode,
            });
            // Flush any commits synchronously queued by the driver during sendTurn
            const pendingCommit = sessionCommitQueues.get(sessionDto.id);
            if (pendingCommit) {
              await pendingCommit.catch(() => {});
            }

            return {
              sessionId: sessionDto.id,
              turnId: steerTurnId,
              runId: activeMeta?.runId ?? '',
              ...(requestId ? { requestId } : {}),
              disposition: 'steered',
              status: 'running',
              runtimeInstanceId,
              runtimeRunId,
              dataInstanceId,
              harnessId: sessionDto.harnessId,
              turnGeneration: activeMeta?.turnGeneration ?? 0,
            };
          }

          // Switch harness/model on idle session if requested
          const requestedHarnessId = req.harnessId ?? legacyOpts?.harnessId;
          const requestedModel = req.model !== undefined ? req.model : legacyOpts?.model;
          if ((requestedHarnessId && requestedHarnessId !== sessionDto.harnessId) || requestedModel !== undefined) {
            const targetHarness = requestedHarnessId ?? sessionDto.harnessId;
            const targetAdapter = deps.driverPort.getAdapter(targetHarness, {
              sessionId: sessionDto.id,
              workspaceId: sessionDto.workspaceId,
            });
            if (!targetAdapter) {
              throw new PluginApiError('E_INVALID_INPUT', `Harness 驱动实例不存在: ${targetHarness}`);
            }
            const nextPatch: Parameters<SessionDataServiceV1['updateSession']>[0]['patch'] = {
              harnessId: targetHarness,
              harnessKind: targetAdapter.kind,
              participatingHarnesses: Array.from(new Set([...(sessionDto.participatingHarnesses ?? []), targetHarness])),
              ...(requestedModel !== undefined
                ? {
                    model: requestedModel,
                    actualModel: null,
                    modelReroutedReason: null,
                  }
                : {}),
            };
            const updRes = await dataService.updateSession({
              sessionId: sessionDto.id,
              patch: nextPatch,
            });
            if (updRes.ok && updRes.value.session) {
              sessionDto = updRes.value.session;
            }
          }

          const turnId = `turn_${crypto.randomBytes(6).toString('hex')}`;
          const runId = `run_${crypto.randomBytes(6).toString('hex')}`;
          generationCounter += 1;
          const turnGeneration = generationCounter;
          const startedAt = Date.now();
          const cliCmd = req.cliCommand ?? legacyOpts?.cliCommand;
          const nativeSkill = req.nativeSkill ?? legacyOpts?.nativeSkill;
          const isMaintenance = ['/compact', '/usage', '/reload-plugins'].includes(cliCmd?.split(/\s+/)[0] ?? '');
          const { effectiveText, expandedCommand, compactTerminalChips } = deps.collabPort.prepareTurnText({
            text: req.text,
            literalText: req.literalText ?? legacyOpts?.literalText,
            mode: req.mode ?? legacyOpts?.mode,
            cliCommand: cliCmd,
            nativeSkill,
            terminalContexts: (req.terminalContexts ?? legacyOpts?.terminalContexts) as never,
          });
          const hasNativeInput = Boolean(cliCmd || nativeSkill);
          const autoTitle = !hasNativeInput && sessionDto.lastSeq <= 2 && sessionDto.title.includes('·')
            ? req.text.replace(/\s+/g, ' ').trim().slice(0, 64)
            : '';

          const turnMeta: ActiveTurnMeta = {
            runId,
            turnId,
            harnessId: sessionDto.harnessId,
            harnessKind: sessionDto.harnessKind,
            providerInstanceId: liveHandles.get(handleKey(sessionDto.id, sessionDto.harnessId))?.providerInstanceId,
            providerRunId: liveHandles.get(handleKey(sessionDto.id, sessionDto.harnessId))?.providerRunId,
            model: sessionDto.model,
            actualModel: sessionDto.actualModel ?? null,
            advanceWatermark: !cliCmd && !(req.omitHandoff ?? legacyOpts?.omitHandoff),
            reloadHandle: sessionDto.harnessKind === 'agy' && Boolean(cliCmd),
            maintenance: isMaintenance,
            requestId,
            requestHash,
            dataInstanceId,
            turnGeneration,
            startedAt,
            settled: false,
          };
          activeTurnMeta.set(sessionDto.id, turnMeta);

          const preTurnSeq = sessionDto.lastSeq;
          const initCommit = await enqueueSessionCommit(sessionDto.id, async () =>
            commitToData(sessionDto.id, dataInstanceId, {
              sessionId: sessionDto.id,
              sessionPatch: {
                status: 'running',
                ...(autoTitle ? { title: autoTitle } : {}),
              },
              runStart: {
                runId,
                sessionId: sessionDto.id,
                turnId,
                instanceId: sessionDto.harnessId,
                driverId: sessionDto.harnessKind,
                model: sessionDto.model,
                status: 'running',
                startedAt,
              },
              events: [
                {
                  type: 'message.user',
                  turnId,
                  createdAt: startedAt,
                  payload: {
                    text: req.text,
                    ...(effectiveText !== req.text ? { sentText: effectiveText } : {}),
                    ...(req.mode ? { mode: req.mode } : {}),
                    ...(compactTerminalChips ? { terminalContexts: compactTerminalChips } : {}),
                    expandedCommand: expandedCommand ?? null,
                    harnessId: sessionDto.harnessId,
                    harnessKind: sessionDto.harnessKind,
                    model: sessionDto.model,
                    actualModel: sessionDto.actualModel ?? null,
                    attachments: (req.attachments ?? []).map((a) => ({
                      id: a.id,
                      kind: a.kind,
                      name: a.name,
                      relativePath: a.relativePath,
                      mimeType: a.mimeType,
                      sizeBytes: a.sizeBytes,
                      ...('previewUrl' in a ? { previewUrl: (a as { previewUrl?: string }).previewUrl } : {}),
                    })),
                  },
                },
                ...(compactTerminalChips
                  ? [
                      {
                        type: 'terminal.context_attached',
                        turnId,
                        createdAt: startedAt,
                        payload: {
                          terminalContexts: compactTerminalChips,
                          count: compactTerminalChips.length,
                        },
                      },
                    ]
                  : []),
                {
                  type: 'session.status',
                  createdAt: startedAt,
                  payload: { status: 'running' },
                },
              ],
              turnItems: [
                {
                  itemId: `${turnId}:user`,
                  schemaVersion: 2,
                  turnId,
                  instanceId: sessionDto.harnessId,
                  driverId: sessionDto.harnessKind,
                  blockType: 'user_message',
                  status: 'completed',
                  title: 'User',
                  textBody: req.text,
                  payload: {
                    ...(req.terminalContexts ? { terminalContexts: req.terminalContexts } : {}),
                  },
                  outputOmitted: false,
                  omittedBytes: 0,
                  createdAt: startedAt,
                  updatedAt: startedAt,
                },
              ],
              ...(requestId && requestHash
                ? {
                    turnReceipt: {
                      sessionId: sessionDto.id,
                      requestId,
                      requestHash,
                      turnId,
                      runId,
                      status: 'running',
                      runtimeInstanceId,
                      runtimeRunId,
                      createdAt: startedAt,
                      updatedAt: startedAt,
                    },
                  }
                : {}),
            }));

          const userSeq = initCommit.committedEvents[0]?.seq ?? sessionDto.lastSeq;
          turnMeta.turnSeq = userSeq;
          sessionDto = initCommit.session ?? sessionDto;

          if (!cliCmd) {
            const preRecord = await deps.collabPort.capturePreTurnCheckpoint({
              sessionId: sessionDto.id,
              workspaceId: sessionDto.workspaceId,
              cwd: sessionDto.cwd,
              turnSeq: userSeq,
            }).catch(() => null);
            if (preRecord) turnMeta.preTurnTreeSha = preRecord.treeSha;
          }

          let dispatchStarted = false;
          try {
            const sessionModel = toSessionModel(sessionDto);
            const bindingRes = await dataService.getHarnessBinding({
              sessionId: sessionDto.id,
              harnessId: sessionDto.harnessId,
            });
            const binding = bindingRes.ok ? bindingRes.value.binding : null;
            const compiled = await deps.collabPort.prepareTurnHandoff({
              session: sessionModel,
              harnessId: sessionDto.harnessId,
              harnessKind: sessionDto.harnessKind,
              binding: binding
                ? {
                    sessionId: binding.sessionId,
                    harnessId: binding.harnessId,
                    harnessKind: binding.harnessKind,
                    nativeSessionId: binding.nativeSessionId,
                    lastModel: binding.lastModel ?? null,
                    lastActualModel: binding.lastActualModel ?? null,
                    lastEffort: (binding.lastEffort as ReasoningEffort | null) ?? null,
                    syncedUpToSeq: binding.syncedUpToSeq,
                    driverUsed: (binding.driverUsed as 'native_warm' | 'codex_inject_items' | 'prompt_envelope' | null) ?? null,
                    updatedAt: binding.updatedAt,
                  }
                : null,
              upToSeq: preTurnSeq,
              excludeTurnId: turnId,
              omitHandoff: req.omitHandoff ?? legacyOpts?.omitHandoff,
            });

            const entry = expectedNativeHandle
              ? liveHandles.get(handleKey(sessionDto.id, sessionDto.harnessId))
              : await ensureLiveHandle(
                  sessionDto,
                  dataService,
                  dataInstanceId,
                  sessionDto.harnessId,
                  Boolean(compiled?.syncNeeded && !cliCmd),
                  true,
                );
            if (!entry || (expectedNativeHandle && entry.handle !== expectedNativeHandle)) {
              throw new PluginApiError('E_CONFLICT', 'The bound AGY connection changed before dispatch');
            }
            legacyOpts?.verifyNativeDispatch?.();

            const bufferedPreSendEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
            dispatchStarted = true;
            const finalDriver = await dispatchTurn(
              entry.handle,
              { id: sessionDto.harnessId, kind: sessionDto.harnessKind },
              {
                turnId,
                text: effectiveText,
                attachments: req.attachments as never,
                ...(expectedNativeHandle
                  ? {}
                  : {
                      model: sessionDto.model,
                      reasoningEffort: (sessionDto.reasoningEffort as ReasoningEffort | null) ?? null,
                      permissionMode: sessionDto.permissionMode as PermissionMode,
                    }),
                ...((req.turnOptions ?? legacyOpts?.turnOptions)
                  ? { turnOptions: (req.turnOptions ?? legacyOpts?.turnOptions) as never }
                  : {}),
                ...(cliCmd ? { cliCommand: cliCmd } : {}),
                ...(nativeSkill ? { nativeSkill } : {}),
              },
              compiled,
              (type, payload) => {
                bufferedPreSendEvents.push({ type, payload });
              },
            );

            if (bufferedPreSendEvents.length > 0 || (compiled?.syncNeeded && !cliCmd)) {
              await enqueueSessionCommit(sessionDto.id, async () => {
                await commitToData(sessionDto.id, dataInstanceId, {
                  sessionId: sessionDto.id,
                  events: bufferedPreSendEvents.map((e) => ({
                    type: e.type,
                    turnId,
                    payload: e.payload,
                  })),
                  ...(compiled?.syncNeeded && !cliCmd
                    ? {
                        bindingUpsert: {
                          sessionId: sessionDto.id,
                          harnessId: sessionDto.harnessId,
                          harnessKind: sessionDto.harnessKind,
                          nativeSessionId: entry.handle.nativeSessionId ?? binding?.nativeSessionId ?? null,
                          lastModel: sessionDto.model,
                          lastActualModel: sessionDto.actualModel ?? null,
                          lastEffort: sessionDto.reasoningEffort,
                          syncedUpToSeq: Math.max(preTurnSeq, binding?.syncedUpToSeq ?? 0),
                          driverUsed: finalDriver,
                          updatedAt: Date.now(),
                        },
                      }
                    : {}),
                });
              });
            }

            // Flush any commits synchronously queued by the driver during sendTurn
            const pendingCommit = sessionCommitQueues.get(sessionDto.id);
            if (pendingCommit) {
              await pendingCommit.catch(() => {});
            }

            return {
              sessionId: sessionDto.id,
              turnId,
              runId,
              ...(requestId ? { requestId } : {}),
              disposition: 'started',
              status: turnMeta.settled ? 'completed' : 'running',
              runtimeInstanceId,
              runtimeRunId,
              dataInstanceId,
              harnessId: sessionDto.harnessId,
              turnGeneration,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await flushSessionDeltasAndWait(sessionDto.id);
            const receiptStatus: SessionTurnReceiptDto['status'] = dispatchStarted ? 'unknown' : 'failed';
            turnMeta.settled = true;
            recordSettledTurn(turnId);
            activeTurnMeta.delete(sessionDto.id);
            if (dispatchStarted) {
              pendingRecoveries.set(sessionDto.id, {
                sessionId: sessionDto.id,
                turnId,
                runId,
                dataInstanceId,
                reason: `外部发送结果未知: ${message}`,
                recordedAt: Date.now(),
              });
            }
            await enqueueSessionCommit(sessionDto.id, async () => {
              await commitToData(sessionDto.id, dataInstanceId, {
                sessionId: sessionDto.id,
                sessionPatch: { status: 'error' },
                runFinish: {
                  runId,
                  status: 'failed',
                  failureClass: dispatchStarted ? 'unknown_outcome' : 'dispatch_error',
                  endedAt: Date.now(),
                },
                settleRunningItemsStatus: 'interrupted',
                events: [
                  {
                    type: 'turn.failed',
                    turnId,
                    payload: {
                      message,
                      code: dispatchStarted ? 'unknown_outcome' : 'dispatch_error',
                      harnessId: sessionDto.harnessId,
                      harnessKind: sessionDto.harnessKind,
                      model: sessionDto.model,
                    },
                  },
                  {
                    type: 'session.status',
                    payload: { status: 'error' },
                  },
                ],
                ...(requestId && requestHash
                  ? {
                      turnReceipt: {
                        sessionId: sessionDto.id,
                        requestId,
                        requestHash,
                        turnId,
                        runId,
                        status: receiptStatus,
                        runtimeInstanceId,
                        runtimeRunId,
                        createdAt: startedAt,
                        updatedAt: Date.now(),
                      },
                    }
                  : {}),
              }).catch(() => {});
            });
            throw err;
          }
        });
      };

      const runtimeService: SessionRuntimeServiceV1 = {
        async getRuntimeInfo() {
          if (!active) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用`);
          }
          return peerOk({
            runtimeInstanceId,
            runtimeRunId,
            acceptingTurns,
            activeTurnCount: activeTurnMeta.size,
            liveHandleCount: liveHandles.size,
            pendingRecoveryCount: pendingRecoveries.size,
          });
        },

        async sendTurn(req) {
          if (!active || !acceptingTurns) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用或正在排空`);
          }
          try {
            const receipt = await executeSendTurn(req);
            return peerOk(receipt);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = err instanceof PluginApiError ? err.code : 'E_INTERNAL';
            if (code === 'E_CONFLICT') return peerErr('conflict', msg);
            if (msg.startsWith('会话不存在')) return peerErr('not_found', msg);
            if (code === 'E_PLUGIN_DISABLED') return peerErr('plugin_disabled', msg);
            if (code === 'E_INVALID_INPUT') return peerErr('invalid_request', msg);
            if (code === 'E_PERMISSION_DENIED') return peerErr('permission_denied', msg);
            return peerErr('conflict', msg);
          }
        },

        async getTurnStatus(req) {
          if (!active) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用`);
          }
          const activeMeta = activeTurnMeta.get(req.sessionId);
          const found = await findSessionWithProvider(pluginManager, req.sessionId).catch(() => null);
          let receipt: SessionTurnReceiptDto | null = null;
          if (req.requestId && found) {
            const r = await found.provider.service.getTurnReceipt({
              sessionId: req.sessionId,
              requestId: req.requestId,
            });
            receipt = r.ok ? r.value.receipt : null;
          }
          const activeDto: RuntimeActiveTurnStateDto | null = activeMeta
            ? {
                sessionId: req.sessionId,
                turnId: activeMeta.turnId,
                runId: activeMeta.runId,
                ...(activeMeta.requestId ? { requestId: activeMeta.requestId } : {}),
                runtimeInstanceId,
                runtimeRunId,
                dataInstanceId: activeMeta.dataInstanceId,
                harnessId: activeMeta.harnessId,
                harnessKind: activeMeta.harnessKind,
                model: activeMeta.model,
                actualModel: activeMeta.actualModel,
                turnGeneration: activeMeta.turnGeneration,
                startedAt: activeMeta.startedAt,
              }
            : null;
          return peerOk({
            active: activeDto,
            receipt,
            pendingRecovery: pendingRecoveries.get(req.sessionId) ?? null,
          });
        },

        async interrupt(req) {
          if (!active) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用`);
          }
          await flushSessionDeltasAndWait(req.sessionId);
          const meta = activeTurnMeta.get(req.sessionId);
          const found = await findSessionWithProvider(pluginManager, req.sessionId, meta?.dataInstanceId);
          const targetHarnessId = meta?.harnessId ?? found?.session.harnessId;
          let interruptedHandle = false;
          if (targetHarnessId) {
            const entry = liveHandles.get(handleKey(req.sessionId, targetHarnessId));
            if (entry && !entry.disposed) {
              interruptedHandle = true;
              const cancelScope = {
                sessionId: req.sessionId,
                driverProviderInstanceId: entry.providerInstanceId,
              };
              if (
                entry.nativeBinding &&
                entry.handle.requestNativeSessionCancel &&
                deps.nativePort.isEnabled(cancelScope) &&
                deps.nativePort.isNativeLifecycleEnabled(cancelScope) &&
                deps.nativePort.hasCancelHook?.(cancelScope) &&
                entry.handle.requestNativeSessionCancel()
              ) {
                deps.nativePort.notifyCancelRequested(entry.nativeBinding, cancelScope);
                return peerOk({ interrupted: true });
              }
              await entry.handle.interrupt().catch(() => {});
            }
          }

          if (meta && !meta.settled) {
            meta.settled = true;
            recordSettledTurn(meta.turnId);
            activeTurnMeta.delete(req.sessionId);
            if (found) {
              const now = Date.now();
              await enqueueSessionCommit(req.sessionId, async () => {
                await commitToData(req.sessionId, found.provider.instanceId, {
                  sessionId: req.sessionId,
                  sessionPatch: { status: 'idle' },
                  runFinish: { runId: meta.runId, status: 'cancelled', endedAt: now },
                  settleRunningItemsStatus: 'interrupted',
                  events: [
                    {
                      type: 'turn.cancelled',
                      turnId: meta.turnId,
                      payload: {
                        harnessId: meta.harnessId,
                        harnessKind: meta.harnessKind,
                        reason: req.reason ?? 'user_interrupt',
                      },
                    },
                    { type: 'session.status', payload: { status: 'idle' } },
                  ],
                  ...(meta.requestId && meta.requestHash
                    ? {
                        turnReceipt: {
                          sessionId: req.sessionId,
                          requestId: meta.requestId,
                          requestHash: meta.requestHash,
                          turnId: meta.turnId,
                          runId: meta.runId,
                          status: 'cancelled',
                          runtimeInstanceId,
                          runtimeRunId,
                          createdAt: meta.startedAt,
                          updatedAt: now,
                        },
                      }
                    : {}),
                }).catch(() => {});
              });
            }
          } else if (found && found.session.status === 'running') {
            await enqueueSessionCommit(req.sessionId, async () => {
              await commitToData(req.sessionId, found.provider.instanceId, {
                sessionId: req.sessionId,
                sessionPatch: { status: 'idle' },
                settleRunningItemsStatus: 'interrupted',
                events: [{ type: 'session.status', payload: { status: 'idle' } }],
              }).catch(() => {});
            });
          }

          deps.requestPort.cancelSessionApprovals(req.sessionId, '轮次已中断', (denied) => {
            if (!targetHarnessId) return;
            const entry = liveHandles.get(handleKey(req.sessionId, targetHarnessId));
            if (entry) {
              entry.nativeToGlobalApprovalId.delete(denied.nativeRequestId);
              void entry.handle.resolveApproval(denied.nativeRequestId, 'deny', '轮次已中断').catch(() => {});
            }
          });
          deps.collabPort.notifyOrchestratorTurnCancelled(req.sessionId);
          return peerOk({ interrupted: interruptedHandle || Boolean(meta) });
        },

        async applyConfig(req) {
          if (!active) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用`);
          }
          const found = await findSessionWithProvider(pluginManager, req.sessionId);
          if (!found) return peerErr('not_found', `会话不存在: ${req.sessionId}`);
          const current = found.session;
          const updRes = await found.provider.service.updateSession({
            sessionId: req.sessionId,
            patch: {
              ...(req.patch.model !== undefined
                ? { model: req.patch.model, actualModel: null, modelReroutedReason: null }
                : {}),
              ...(req.patch.reasoningEffort !== undefined ? { reasoningEffort: req.patch.reasoningEffort } : {}),
              ...(req.patch.permissionMode !== undefined ? { permissionMode: req.patch.permissionMode } : {}),
            },
          });
          const updated = updRes.ok && updRes.value.session ? updRes.value.session : current;
          const live = liveHandles.get(handleKey(req.sessionId, updated.harnessId));
          let status: SessionConfigReceiptDto['status'] = 'pending_next_session';
          let note: string | undefined;
          let confirmed: SessionConfigReceiptDto['confirmed'] = {
            model: updated.model,
            actualModel: null,
            reasoningEffort: updated.reasoningEffort,
            permissionMode: updated.permissionMode,
          };

          if (req.configAlreadyApplied) {
            status = 'applied';
            confirmed.actualModel = updated.actualModel ?? null;
          } else if (live && !live.disposed && current.status === 'idle') {
            if (
              req.patch.permissionMode !== undefined
              && live.adapter.capabilities.permissionModes.length > 0
              && !live.adapter.capabilities.permissionModes.includes(req.patch.permissionMode as PermissionMode)
            ) {
              status = 'unsupported';
              note = `驱动 ${live.harnessId} 不支持权限模式 ${req.patch.permissionMode}`;
            } else if (live.handle.updateConfig) {
              live.lastConfirmedConfig = undefined;
              const previousPermissionMode = live.requestedPermissionMode;
              live.requestedPermissionMode = updated.permissionMode as PermissionMode;
              try {
                const driverReceipt = await live.handle.updateConfig({
                  model: updated.model,
                  reasoningEffort: (updated.reasoningEffort as ReasoningEffort | null) ?? null,
                  permissionMode: updated.permissionMode as PermissionMode,
                });
                const pendingCommit = sessionCommitQueues.get(req.sessionId);
                if (pendingCommit) await pendingCommit.catch(() => {});
                if (driverReceipt && typeof driverReceipt === 'object' && 'status' in driverReceipt) {
                  status = driverReceipt.status;
                  if (driverReceipt.note) note = driverReceipt.note;
                  if (driverReceipt.confirmed) {
                    confirmed = {
                      model: (driverReceipt.confirmed.model as string | null | undefined) ?? updated.model,
                      actualModel: (driverReceipt.confirmed.actualModel as string | null | undefined)
                        ?? (driverReceipt.confirmed.model as string | null | undefined)
                        ?? null,
                      reasoningEffort: (driverReceipt.confirmed.reasoningEffort as ReasoningEffort | null | undefined)
                        ?? updated.reasoningEffort,
                      permissionMode: (driverReceipt.confirmed.permissionMode as PermissionMode | undefined)
                        ?? updated.permissionMode,
                    };
                  }
                } else {
                  status = 'pending_next_session';
                  note = '驱动未返回配置接受回执';
                }
                const confirmedCfg = (live as LiveHandleEntry).lastConfirmedConfig;
                if (!driverReceipt && confirmedCfg && (req.patch.permissionMode === undefined || confirmedCfg.permissionEnforcement !== undefined)) status = 'applied'; // explicit driver event is an acceptance receipt
                if (confirmedCfg && status === 'applied') {
                  confirmed = {
                    model: confirmedCfg.model ?? updated.model,
                    actualModel: confirmedCfg.actualModel ?? confirmedCfg.model ?? null,
                    reasoningEffort: (confirmedCfg.thoughtLevel as ReasoningEffort | null | undefined)
                      ?? updated.reasoningEffort,
                    permissionMode: updated.permissionMode,
                    permissionEnforcement: confirmedCfg.permissionEnforcement ?? null,
                  };
                }
              } catch (err) {
                live.requestedPermissionMode = previousPermissionMode;
                const errCode =
                  err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
                    ? (err as { code: string }).code
                    : undefined;
                note = err instanceof Error ? err.message : String(err);
                if (errCode === 'E_NOT_SUPPORTED') {
                  status = 'unsupported';
                } else if (errCode === 'E_PENDING_NEXT_SESSION') {
                  await disposeLiveHandleEntry(live);
                  status = 'pending_next_session';
                } else {
                  status = 'rejected';
                }
              }
            } else {
              await disposeLiveHandleEntry(live);
              status = 'pending_next_session';
              note = '当前驱动不支持热切换配置，已释放旧句柄并在下次发送时应用';
            }
          } else {
            const targetAdapter = deps.driverPort.getAdapter(updated.harnessId, {
              sessionId: req.sessionId,
              workspaceId: updated.workspaceId,
            });
            if (
              req.patch.permissionMode !== undefined
              && targetAdapter
              && targetAdapter.capabilities.permissionModes.length > 0
              && !targetAdapter.capabilities.permissionModes.includes(req.patch.permissionMode as PermissionMode)
            ) {
              status = 'unsupported';
              note = `驱动 ${updated.harnessId} 不支持权限模式 ${req.patch.permissionMode}`;
            }
          }

          if (req.patch.permissionMode !== undefined) {
            const policy = deps.getPluginManager().resolveCapabilityBinding('approval.policy.v1', { sessionId: req.sessionId, workspaceId: updated.workspaceId });
            await deps.requestPort.recordMode({ sessionId: req.sessionId, requested: req.patch.permissionMode as PermissionMode,
              policyInstanceId: policy.instanceId ?? null, policyRevision: null,
              status: status === 'applied' && confirmed.permissionEnforcement === 'client_guard' ? 'policy_handled' : status,
              driverRequested: { permissionMode: req.patch.permissionMode }, driverAccepted: status === 'applied' ? { ...confirmed, modeId: live?.lastConfirmedConfig?.modeId ?? null } : undefined,
              execution: status === 'applied' ? confirmed.permissionEnforcement === 'client_guard' ? 'per_request_policy' : 'driver' : 'none', note });
          }
          return peerOk({
            sessionId: req.sessionId,
            harnessId: updated.harnessId,
            requested: {
              ...(req.patch.model !== undefined ? { model: req.patch.model } : {}),
              ...(req.patch.reasoningEffort !== undefined ? { reasoningEffort: req.patch.reasoningEffort } : {}),
              ...(req.patch.permissionMode !== undefined ? { permissionMode: req.patch.permissionMode } : {}),
            },
            confirmed,
            status,
            ...(note ? { note } : {}),
          });
        },

        async closeSession(req) {
          const targets = [...liveHandles.values()].filter((e) => e.sessionId === req.sessionId);
          await flushSessionDeltasAndWait(req.sessionId);
          await Promise.all(targets.map((e) => disposeLiveHandleEntry(e)));
          return peerOk({ closedHandles: targets.length });
        },

        async closeHarnessSessions(req) {
          const targets = [...liveHandles.values()].filter((e) => e.harnessId === req.harnessId);
          await Promise.all(targets.map((e) => disposeLiveHandleEntry(e)));
          return peerOk({ closedHandles: targets.length });
        },

        async listActiveTurns(req) {
          if (!active) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用`);
          }
          const turns: RuntimeActiveTurnStateDto[] = [];
          for (const [sessionId, meta] of activeTurnMeta.entries()) {
            if (req?.workspaceId) {
              const found = await findSessionWithProvider(pluginManager, sessionId, meta.dataInstanceId).catch(() => null);
              if (found?.session.workspaceId !== req.workspaceId) continue;
            }
            turns.push({
              sessionId,
              turnId: meta.turnId,
              runId: meta.runId,
              ...(meta.requestId ? { requestId: meta.requestId } : {}),
              runtimeInstanceId,
              runtimeRunId,
              dataInstanceId: meta.dataInstanceId,
              harnessId: meta.harnessId,
              harnessKind: meta.harnessKind,
              model: meta.model,
              actualModel: meta.actualModel,
              turnGeneration: meta.turnGeneration,
              startedAt: meta.startedAt,
            });
          }
          return peerOk({ turns });
        },

        async listPendingRecoveries() {
          if (!active) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用`);
          }
          return peerOk({ recoveries: [...pendingRecoveries.values()] });
        },

        async recoverStaleRuns(req) {
          if (!active) {
            return peerErr('plugin_disabled', `默认会话运行插件 (${runtimeInstanceId}) 已停用`);
          }
          let recoveredCount = 0;
          const providers = req?.dataInstanceId
            ? [resolveSessionDataProvider(pluginManager, { explicitInstanceId: req.dataInstanceId })]
            : listActiveSessionDataProviders(pluginManager);
          for (const p of providers) {
            const res = await p.service.recoverCrashState().catch(() => null);
            if (res?.ok) {
              recoveredCount += res.value.recoveredRuns + res.value.recoveredItems;
            }
          }
          return peerOk({ recoveredCount });
        },

        async drainAndStop() {
          acceptingTurns = false;
          const activeIds = [...activeTurnMeta.keys()];
          for (const sid of activeIds) {
            await flushSessionDeltasAndWait(sid);
          }
          deltaCoalescer.flushAll();
          const handles = [...liveHandles.values()];
          await Promise.all(handles.map((e) => disposeLiveHandleEntry(e)));
          activeTurnMeta.clear();
          return peerOk({
            drainedTurns: activeIds.length,
            closedHandles: handles.length,
          });
        },
      };

      const controller: SessionRuntimeDefaultController = {
        isActive: () => active,
        sendTurnWithLegacyOptions: (req, legacyOpts) => executeSendTurn(req, legacyOpts),
        hasLiveHandle: (sessionId, harnessId, expectedHandle) => {
          const entry = liveHandles.get(handleKey(sessionId, harnessId));
          if (!entry || entry.disposed) return false;
          return expectedHandle ? entry.handle === expectedHandle : true;
        },
        getLiveHandle: (sessionId, harnessId) => {
          const entry = liveHandles.get(handleKey(sessionId, harnessId));
          return entry && !entry.disposed ? entry.handle : undefined;
        },
        resolveApprovalOnLiveHandle: async (
          sessionId,
          nativeRequestId,
          decision,
          comment,
          secretPayload,
          questionAnswer,
        ) => {
          for (const entry of liveHandles.values()) {
            if (entry.disposed || entry.sessionId !== sessionId) continue;
            if (!entry.nativeToGlobalApprovalId.has(nativeRequestId)) continue;
            entry.nativeToGlobalApprovalId.delete(nativeRequestId);
            if (secretPayload !== undefined) {
              if (decision === 'deny') {
                await entry.handle.resolveApproval(nativeRequestId, 'deny', comment ?? '用户拒绝提供凭据');
              } else if (entry.handle.resolveSecret) {
                await entry.handle.resolveSecret(nativeRequestId, secretPayload);
              } else {
                await entry.handle.resolveApproval(nativeRequestId, 'allow_once', secretPayload);
              }
            } else if (questionAnswer !== undefined) {
              if (decision !== 'deny' && entry.handle.resolveQuestion) {
                await entry.handle.resolveQuestion(nativeRequestId, questionAnswer);
              } else {
                await entry.handle.resolveApproval(nativeRequestId, decision, comment);
              }
            } else {
              await entry.handle.resolveApproval(nativeRequestId, decision, comment);
            }
            return true;
          }
          return false;
        },
        settleHeldNativeTurn: ({ binding, turnId, settlement }) => {
          const meta = activeTurnMeta.get(binding.sessionId);
          if (!meta || meta.turnId !== turnId || meta.settled) {
            return { settled: false, reason: 'already_settled_or_unknown_turn' };
          }
          const entry = liveHandles.get(handleKey(binding.sessionId, meta.harnessId));
          const currentBinding =
            entry?.nativeBinding ??
            deps.nativePort.getActiveBinding(binding.sessionId) ??
            null;
          if (
            currentBinding &&
            (currentBinding.runtimeId !== binding.runtimeId ||
              currentBinding.generation !== binding.generation)
          ) {
            return { settled: false, reason: 'stale_binding' };
          }
          if (!entry || entry.disposed) {
            return { settled: false, reason: 'handle_unavailable' };
          }
          entry.handle.releaseHeldTurn?.(turnId);
          deltaCoalescer.flushSession(binding.sessionId);

          let dataServiceRef;
          try {
            dataServiceRef = resolveData(binding.sessionId, entry.dataInstanceId);
          } catch {
            return { settled: false, reason: 'data_provider_unavailable' };
          }

          meta.settled = true;
          recordSettledTurn(turnId);
          activeTurnMeta.delete(binding.sessionId);
          const now = Date.now();
          const isErrorOutcome = settlement.kind === 'disconnected' || settlement.outcome === 'failed';
          const runStatus =
            settlement.kind === 'disconnected'
              ? 'failed'
              : settlement.outcome === 'completed'
                ? 'completed'
                : settlement.outcome === 'cancelled'
                  ? 'cancelled'
                  : 'failed';
          const terminalType =
            settlement.kind === 'disconnected'
              ? 'turn.failed'
              : settlement.outcome === 'completed'
                ? 'turn.completed'
                : settlement.outcome === 'cancelled'
                  ? 'turn.cancelled'
                  : 'turn.failed';
          const terminalPayload: Record<string, unknown> =
            settlement.kind === 'disconnected'
              ? {
                  message: settlement.reason,
                  code: 'native_transport_disconnected',
                  harnessId: meta.harnessId,
                  harnessKind: meta.harnessKind,
                  model: meta.model,
                }
              : settlement.outcome === 'completed'
                ? {
                    stopReason: settlement.stopReason ?? 'end_turn',
                    harnessId: meta.harnessId,
                    harnessKind: meta.harnessKind,
                    model: meta.model,
                    actualModel: meta.actualModel,
                  }
                : settlement.outcome === 'cancelled'
                  ? {
                      harnessId: meta.harnessId,
                      harnessKind: meta.harnessKind,
                    }
                  : {
                      message: settlement.message ?? 'Native turn failed',
                      ...(settlement.code ? { code: settlement.code } : {}),
                      ...(settlement.failureClass ? { failureClass: settlement.failureClass } : {}),
                      ...(settlement.resetAt !== undefined ? { resetAt: settlement.resetAt } : {}),
                      harnessId: meta.harnessId,
                      harnessKind: meta.harnessKind,
                      model: meta.model,
                    };

          // Invoke commitBatch synchronously up to its first await so in-process SQLite updates
          // land immediately within the synchronous NativeTurnSettlementSink call frame.
          const commitPromise = dataServiceRef.service.commitBatch({
            sessionId: binding.sessionId,
            sessionPatch: { status: isErrorOutcome ? 'error' : 'idle' },
            runFinish: {
              runId: meta.runId,
              status: runStatus,
              ...(settlement.kind === 'disconnected' ? { failureClass: 'native_transport_disconnected' } : {}),
              endedAt: now,
            },
            settleRunningItemsStatus: settlement.kind === 'eligible' && settlement.outcome === 'completed'
              ? 'completed'
              : 'interrupted',
            events: [
              { type: terminalType, turnId, payload: terminalPayload },
              { type: 'session.status', payload: { status: isErrorOutcome ? 'error' : 'idle' } },
            ],
            ...(meta.requestId && meta.requestHash
              ? {
                  turnReceipt: {
                    sessionId: binding.sessionId,
                    requestId: meta.requestId,
                    requestHash: meta.requestHash,
                    turnId: meta.turnId,
                    runId: meta.runId,
                    status: runStatus,
                    runtimeInstanceId,
                    runtimeRunId,
                    createdAt: meta.startedAt,
                    updatedAt: now,
                  },
                }
              : {}),
          });
          void commitPromise.then((res) => {
            if (res.ok) {
              publishCommitted(res.value.session, res.value.committedEvents);
            }
          }).catch(() => {});

          if (settlement.kind === 'disconnected' || (settlement.kind === 'eligible' && settlement.outcome !== 'completed')) {
            deps.requestPort.cancelSessionApprovals(binding.sessionId, '轮次已结束', (denied) => {
              entry.nativeToGlobalApprovalId.delete(denied.nativeRequestId);
              void entry.handle.resolveApproval(denied.nativeRequestId, 'deny', '轮次已结束').catch(() => {});
            });
            deps.collabPort.notifyOrchestratorTurnCancelled(binding.sessionId);
            deps.collabPort.notifyOrchestratorParentIdle(binding.sessionId);
          } else {
            deps.requestPort.expireSessionApprovals(binding.sessionId, (expired) => {
              entry.nativeToGlobalApprovalId.delete(expired.nativeRequestId);
              void entry.handle.resolveApproval(expired.nativeRequestId, 'deny', '轮次已结束').catch(() => {});
            });
            deps.collabPort.notifyOrchestratorTurnCompleted(binding.sessionId);
            deps.collabPort.notifyOrchestratorParentIdle(binding.sessionId);
          }
          if (meta.reloadHandle) void disposeLiveHandleEntry(entry);
          return { settled: true };
        },
        disposeSessionHandles,
        disposeLiveHandle,
        closeSessionsForHarness,
        listActiveTurnSessionIds: () => [...activeTurnMeta.keys()],
        hasActiveTurn: (sessionId) => activeTurnMeta.has(sessionId),
        getActiveTurnId: (sessionId) => activeTurnMeta.get(sessionId)?.turnId,
        flushSessionDeltas: (sessionId) => {
          deltaCoalescer.flushSession(sessionId);
        },
        getLiveHandleInfo: (sessionId, harnessId) => {
          const entry = liveHandles.get(handleKey(sessionId, harnessId));
          if (!entry || entry.disposed) return undefined;
          return {
            handle: entry.handle,
            pluginToolKey: entry.pluginToolKey,
            pluginToolLease: entry.pluginToolLease,
          };
        },
      };

      deps.nativePort.bindTurnSettlementSink({
        settleTurn: (params) => controller.settleHeldNativeTurn(params),
      });
      deps.onControllerReady?.(controller);

      // Watch for data plugin deactivation/unload so active handles/turns cleanly isolate
      const unsubServices = pluginManager.host.onServicesChanged(() => {
        const nextSet = new Set(listActiveSessionDataProviders(pluginManager).map((p) => p.instanceId));
        for (const prevId of activeDataInstances) {
          if (nextSet.has(prevId)) continue;
          for (const [sid, meta] of [...activeTurnMeta.entries()]) {
            if (meta.dataInstanceId !== prevId) continue;
            meta.settled = true;
            activeTurnMeta.delete(sid);
            pendingRecoveries.set(sid, {
              sessionId: sid,
              turnId: meta.turnId,
              runId: meta.runId,
              dataInstanceId: prevId,
              reason: `会话数据插件 (${prevId}) 已停用，停止继续写入并记录待恢复状态`,
              recordedAt: Date.now(),
            });
          }
          for (const entry of [...liveHandles.values()]) {
            if (entry.dataInstanceId === prevId) {
              void disposeLiveHandleEntry(entry);
            }
          }
        }
        activeDataInstances.clear();
        for (const id of nextSet) activeDataInstances.add(id);
      });

      // Startup recovery for crash-interrupted runs across active session.data.v1 providers
      void runtimeService.recoverStaleRuns().catch(() => {});

      ctx.provide(SESSION_RUNTIME_CONTRACT, runtimeService, {
        version: SESSION_RUNTIME_CONTRACT_VERSION,
        metadata: { role: 'session-runtime' },
      });

      ctx.effect(() => () => {
        active = false;
        acceptingTurns = false;
        unsubServices();
        deps.onControllerReady?.(null);
        deltaCoalescer.flushAll();
        deltaCoalescer.dispose();
        deps.requestPort.expireSessionApprovals();
        const entries = [...liveHandles.values()];
        liveHandles.clear();
        activeTurnMeta.clear();
        for (const entry of entries) {
          entry.disposed = true;
          try { entry.unsubscribe(); } catch {}
          try { entry.pluginToolLease?.release(); } catch {}
          void entry.handle.dispose().catch(() => {});
        }
      });
    },
  };
}
