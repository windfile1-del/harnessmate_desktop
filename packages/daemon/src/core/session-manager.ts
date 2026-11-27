import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  CheckpointRevertResult,
  ContextPreview,
  ContextSyncMode,
  CreateSessionRequest,
  DiscoveredCliSession,
  FailoverRequest,
  ForkSessionRequest,
  ForkSessionResult,
  GcCheckpointsRequest,
  HarnessKind,
  HarnessCommandInfo,
  HarnessCommandResult,
  ImportNativeSessionRequest,
  ImportSessionBundleRequest,
  MergeBackRequest,
  MergeBackResult,
  PermissionMode,
  PortableSessionBundleV2,
  ReasoningEffort,
  ResolveApprovalRequest,
  RevertCheckpointRequest,
  RunHarnessCommandRequest,
  RunPluginActionRequest,
  RuntimeBinding,
  RuntimeRequestKind,
  Session,
  SessionCheckpointRecord,
  SessionPluginAction,
  SessionRunRecord,
  SessionSearchResponse,
  SessionStatus,
  SideChatMessage,
  SideChatPromoteRequest,
  SideChatRequest,
  SwitchHarnessRequest,
  TerminalContextChip,
  TurnBlockRecord,
  TurnOptionsMap,
  UpdateSessionRequest,
  Workspace,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { AcpAdapter } from '../harnesses/acp-adapter.js';
import { findLocalSession, readJsonlHistory } from '../harnesses/history-scanner.js';
import { AgyAdapter } from '../harnesses/agy/agy-driver.js';
import {
  assertAgyConsumerProvenance,
  mintAgyDispatchProvenance,
  type AgyDispatchProvenance,
} from '../harnesses/agy/native/wiring/provenance.js';
import type { AgyNativeRuntimeRegistry } from '../harnesses/agy/native/wiring/registry.js';
import type { TurnSettlement } from '../harnesses/agy/native/wiring/types.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../harnesses/types.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { PluginCapabilities, PluginToolLease } from '../plugins/plugin-capabilities.js';
import {
  failoverContract, modelCatalogContract, modelToolsContract, selectedHarnessService,
  type FailoverContract, type ModelCatalog, type ModelToolRouter,
} from '../plugin-host/builtin/harness-integration.js';
import { pluginDevelopmentBrief } from '../plugins/plugin-development-prompt.js';
import { ApprovalCenterService, SECRET_RECEIPT_LABEL, type ExternalApprovalAnnotator } from './approval-center-service.js';
import {
  CONTEXT_COMPRESSION_PLUGIN_ID,
  ContextCompressionService,
} from './context-compression-service.js';
import { ORCHESTRATOR_PLUGIN_ID, OrchestratorService } from './orchestrator-service.js';
import { CheckpointError, type CheckpointDiffResult, type CheckpointRevertHooks, type CheckpointService } from './checkpoint-service.js';
import { CommandOutputHub } from './command-output-hub.js';
import type { ContextCompiler } from './context-compiler.js';
import type { DaemonEventBus } from './event-bus.js';
import { classifyTerminalFailure, FAILOVER_TRIGGER_CLASSES } from './failover-service.js';
import { SessionExplorerService, type SessionExplorerQueryOptions } from './session-explorer-service.js';
import type { TaskLedgerService } from './task-ledger-service.js';
import {
  stripAnsiAndClip,
  type TerminalWorkspaceService,
} from './terminal-workspace-service.js';
import { TextDeltaCoalescer } from './text-delta-coalescer.js';
import {
  PEER_CONTRACTS,
  PluginApiError,
  type PublicTurnBlock,
  type SessionCanonicalEventDto,
  type SessionDataStreamIdentity,
  type SessionRecordDto,
  type SessionRunRecordDto,
  type SessionWorkspaceDto,
} from '@harnessmate/plugin-api';
import type { GitService, NativeCommandsService } from '../plugin-host/builtin/services.js';
import { sessionPluginEvent } from '../plugin-host/runtime/events.js';
import { dispatchTurn } from './outbound-gate.js';
import {
  SESSION_DATA_DEFAULT_PLUGIN_ID,
} from '../plugins/session-data-default/index.js';
import {
  SESSION_RUNTIME_DEFAULT_PLUGIN_ID,
  type SessionRuntimeDefaultController,
} from '../plugins/session-runtime-default/index.js';
import {
  findSessionWithProvider,
  findWorkspaceWithProvider,
  listActiveSessionDataProviders,
  recordResourceOwner,
  removeResourceOwner,
  resolveOptionalSessionDataProvider,
  resolveSessionDataProvider,
  resolveSessionRuntimeProvider,
} from './session-peer-router.js';
import {
  releaseTerminalsUsingPath,
  resolveGitCheckpointProvider,
  resolveGitWorkspaceProvider,
  resolveOptionalGitWorkspaceProvider,
  unwrapPeerServiceResult,
} from './w1-service-helpers.js';

function workspaceDtoToModel(dto: SessionWorkspaceDto): Workspace {
  return {
    id: dto.id,
    name: dto.name,
    rootPath: dto.rootPath,
    isGitRepo: dto.isGitRepo,
    gitBranch: dto.gitBranch,
    createdAt: dto.createdAt,
  };
}

function sessionDtoToModel(dto: SessionRecordDto): Session {
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

function eventDtoToModel(dto: SessionCanonicalEventDto): CanonicalEvent {
  return {
    sessionId: dto.sessionId,
    seq: dto.seq,
    turnId: dto.turnId,
    type: dto.type as CanonicalEvent['type'],
    payload: dto.payload,
    createdAt: dto.createdAt,
  };
}

function turnBlockDtoToModel(dto: PublicTurnBlock): TurnBlockRecord {
  return {
    itemId: dto.itemId,
    schemaVersion: 2,
    sessionId: dto.sessionId,
    turnId: dto.turnId,
    seq: dto.seq,
    instanceId: dto.instanceId,
    driverId: dto.driverId,
    blockType: dto.blockType as TurnBlockRecord['blockType'],
    status: dto.status as TurnBlockRecord['status'],
    title: dto.title,
    textBody: dto.textBody,
    payload: dto.payload,
    outputOmitted: dto.outputOmitted,
    omittedBytes: dto.omittedBytes,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function runDtoToModel(dto: SessionRunRecordDto): SessionRunRecord {
  return {
    runId: dto.runId,
    sessionId: dto.sessionId,
    turnId: dto.turnId,
    instanceId: dto.instanceId,
    driverId: dto.driverId,
    model: dto.model ?? null,
    status: dto.status as SessionRunRecord['status'],
    failureClass: dto.failureClass ?? null,
    usage: dto.usage ?? null,
    startedAt: dto.startedAt,
    endedAt: dto.endedAt ?? null,
  };
}

interface LiveHandleEntry {
  key: string;
  sessionId: string;
  harnessId: string;
  harnessKind: HarnessKind;
  adapter: HarnessAdapter;
  handle: AdapterSessionHandle;
  unsubscribe: () => void;
  nativeToGlobalApprovalId: Map<string, string>;
  lastUsedAt: number;
  pluginToolKey: string;
  pluginToolLease?: PluginToolLease;
  nativeBinding?: RuntimeBinding;
}

interface ActiveTurnMeta {
  runId: string;
  turnId: string;
  harnessId: string;
  harnessKind: HarnessKind;
  model: string | null;
  actualModel: string | null;
  turnSeq?: number;
  preTurnTreeSha?: string | null;
  advanceWatermark?: boolean;
  reloadHandle?: boolean;
  maintenance?: boolean;
}

const MAX_WARM_HANDLES = 6;
const MAX_STORED_TOOL_OUTPUT_CHARS = 16_384;
const MAX_TURN_ITEM_TEXT_CHARS = 512_000;
type TurnOptions = {
  requestId?: string;
  harnessId?: string;
  model?: string | null;
  turnOptions?: TurnOptionsMap;
  omitHandoff?: boolean;
  literalText?: boolean;
  mode?: 'plugin_development';
  terminalContexts?: TerminalContextChip[];
  dispatchProvenance?: AgyDispatchProvenance;
  expectedNativeHandle?: AdapterSessionHandle;
  verifyNativeDispatch?: () => void;
  cliCommand?: string;
  nativeSkill?: { name: string; path: string };
};

export class SessionManager {
  readonly commandOutputHub: CommandOutputHub;
  private readonly deltaCoalescer: TextDeltaCoalescer;
  private readonly liveHandles = new Map<string, LiveHandleEntry>();
  private readonly activeTurnMeta = new Map<string, ActiveTurnMeta>();
  private readonly startingSessions = new Set<string>();
  private readonly importingSessions = new Map<string, Promise<Session>>();
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fallbackExplorer?: SessionExplorerService;
  private fallbackApprovalCenter?: ApprovalCenterService;
  private fallbackOrchestrator?: OrchestratorService;
  private fallbackCompressor?: ContextCompressionService;
  private runtimeController: SessionRuntimeDefaultController | null = null;
  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private readonly eventBus: DaemonEventBus,
    private readonly pluginManager: PluginManager,
    private readonly pluginCapabilities?: PluginCapabilities,
    commandOutputHub?: CommandOutputHub,
    private readonly terminalWorkspace?: TerminalWorkspaceService,
    private readonly nativeRegistry?: AgyNativeRuntimeRegistry,
  ) {
    this.commandOutputHub = commandOutputHub ?? new CommandOutputHub();
    this.deltaCoalescer = new TextDeltaCoalescer({
      windowMs: 50,
      onFlush: (batch) => {
        if (batch.channel === 'assistant') {
          this.emitCanonical(
            batch.sessionId,
            'message.assistant.delta',
            {
              text: batch.text,
              messageId: batch.messageId,
              parentToolUseId: batch.parentToolUseId,
              harnessId: batch.harnessId,
              actualModel: batch.actualModel,
            },
            batch.turnId,
          );
        } else {
          this.emitCanonical(batch.sessionId, 'thinking.delta', { text: batch.text }, batch.turnId);
        }
      },
    });
    // Stale running/turn crash recovery is owned by session.runtime.v1 & session.data.v1 plugins.
    // Host only marks AGY native attached bindings as reconciling during boot and publishes legacy
    // unpublished expired Batch-4 approvals if default session-data is not explicitly disabled.
    this.nativeRegistry?.persistence.markAttachedBindingsReconcilingOnStartup();
    if (!this.pluginManager.isInstanceKnownDisabled(SESSION_DATA_DEFAULT_PLUGIN_ID)) {
      for (const approval of this.store.listUnpublishedExpiredApprovals()) {
        this.publishExpiredApproval(approval);
        if (
          this.store.getSession(approval.sessionId)?.status === 'awaiting_approval' &&
          this.store.listPendingApprovals(approval.sessionId).length === 0
        ) {
          this.setSessionStatus(approval.sessionId, 'idle');
        }
      }
    }
    this.nativeRegistry?.bindTurnSettlementSink({
      settleTurn: (params) => {
        if (this.runtimeController?.isActive()) {
          return this.runtimeController.settleHeldNativeTurn(params);
        }
        return this.settleHeldNativeTurn(params);
      },
    });
  }

  attachRuntimeController(controller: SessionRuntimeDefaultController | null): void {
    this.runtimeController = controller;
  }

  getRuntimeController(): SessionRuntimeDefaultController | null {
    return this.runtimeController;
  }

  attachCompressorForRuntime(): void {
    this.attachActiveCompressorHooks();
  }

  getOrchestratorIfEnabled(): OrchestratorService | undefined {
    return this.getActiveOrchestrator() ?? undefined;
  }

  private assertDefaultDataEnabledForSyncRead(): void {
    if (
      this.pluginManager.hasLoadedRegistry() &&
      this.pluginManager.isInstanceKnownDisabled(SESSION_DATA_DEFAULT_PLUGIN_ID)
    ) {
      throw new PluginApiError(
        'E_PLUGIN_DISABLED',
        `默认会话数据插件 (${SESSION_DATA_DEFAULT_PLUGIN_ID}) 已停用`,
      );
    }
  }

  private handleKey(sessionId: string, harnessId: string): string {
    return `${sessionId}::${harnessId}`;
  }

  private async withSessionStartup<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.startingSessions.has(sessionId)) throw new Error('此会话正在启动另一项操作');
    this.startingSessions.add(sessionId);
    try {
      return await operation();
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }

  getNativeRegistry(): AgyNativeRuntimeRegistry | undefined {
    return this.nativeRegistry;
  }

  private recoverStaleSessions(): void {
    this.store.recoverCrashStateOnStartup();
    this.nativeRegistry?.persistence.markAttachedBindingsReconcilingOnStartup();
    for (const approval of this.store.listUnpublishedExpiredApprovals()) {
      this.publishExpiredApproval(approval);
    }
    const sessions = this.store.listSessions({ includeArchived: true });
    for (const s of sessions) {
      if (s.status === 'running' || s.status === 'awaiting_approval') {
        this.setSessionStatus(s.id, 'idle');
      }
    }
  }

  getSessionTurnItems(
    sessionId: string,
    opts?: { afterSeq?: number; turnId?: string; blockTypes?: string[]; limit?: number },
  ): TurnBlockRecord[] {
    this.assertDefaultDataEnabledForSyncRead();
    return this.store.listTurnItems(sessionId, opts);
  }

  async getSessionTurnItemsAsync(
    sessionId: string,
    opts?: { afterSeq?: number; turnId?: string; blockTypes?: string[]; limit?: number },
  ): Promise<TurnBlockRecord[]> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, sessionId);
    if (!found) {
      if (this.pluginManager.hasLoadedRegistry()) return [];
      return this.store.listTurnItems(sessionId, opts);
    }
    const res = unwrapPeerServiceResult(
      await found.provider.service.listTurnItems({ sessionId, ...opts }),
    );
    return res.items.map(turnBlockDtoToModel);
  }

  getSessionTurnItemSlice(
    sessionId: string,
    itemId: string,
    opts: { textOffset: number; maxChars: number },
  ): {
    item: TurnBlockRecord;
    text: string;
    totalChars: number;
    textOffset: number;
    nextTextOffset: number | null;
    hasMore: boolean;
  } | null {
    this.assertDefaultDataEnabledForSyncRead();
    const item = this.store.getTurnItem(itemId);
    if (!item || item.sessionId !== sessionId) return null;
    let fullText = item.textBody;
    const toolCallId =
      typeof item.payload?.toolCallId === 'string'
        ? item.payload.toolCallId
        : item.itemId.startsWith('tool:')
          ? item.itemId.slice(5)
          : undefined;
    if (toolCallId) {
      const liveSnap = this.commandOutputHub.getSnapshot(sessionId, toolCallId);
      if (liveSnap && liveSnap.text.length > fullText.length) {
        fullText = liveSnap.text;
      }
    }
    const totalChars = fullText.length;
    const start = Math.min(Math.max(0, opts.textOffset), totalChars);
    const end = Math.min(start + Math.max(1, opts.maxChars), totalChars);
    const text = fullText.slice(start, end);
    const hasMore = end < totalChars;
    return {
      item: { ...item, textBody: text },
      text,
      totalChars,
      textOffset: start,
      nextTextOffset: hasMore ? end : null,
      hasMore,
    };
  }

  async getSessionTurnItemSliceAsync(
    sessionId: string,
    itemId: string,
    opts: { textOffset: number; maxChars: number },
  ): Promise<{
    item: TurnBlockRecord;
    text: string;
    totalChars: number;
    textOffset: number;
    nextTextOffset: number | null;
    hasMore: boolean;
  } | null> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, sessionId);
    if (!found) {
      if (this.pluginManager.hasLoadedRegistry()) return null;
      return this.getSessionTurnItemSlice(sessionId, itemId, opts);
    }
    const sliceRes = unwrapPeerServiceResult(await found.provider.service.getTurnItem({ sessionId, itemId }));
    if (!sliceRes) return null;
    const item = turnBlockDtoToModel(sliceRes.item);
    let fullText = item.textBody;
    const toolCallId =
      typeof item.payload?.toolCallId === 'string'
        ? item.payload.toolCallId
        : item.itemId.startsWith('tool:')
          ? item.itemId.slice(5)
          : undefined;
    if (toolCallId) {
      const liveSnap = this.commandOutputHub.getSnapshot(sessionId, toolCallId);
      if (liveSnap && liveSnap.text.length > fullText.length) {
        fullText = liveSnap.text;
      }
    }
    const totalChars = fullText.length;
    const start = Math.min(Math.max(0, opts.textOffset), totalChars);
    const end = Math.min(start + Math.max(1, opts.maxChars), totalChars);
    const text = fullText.slice(start, end);
    const hasMore = end < totalChars;
    return {
      item: { ...item, textBody: text },
      text,
      totalChars,
      textOffset: start,
      nextTextOffset: hasMore ? end : null,
      hasMore,
    };
  }

  getSessionRuns(sessionId: string, limit = 100): SessionRunRecord[] {
    this.assertDefaultDataEnabledForSyncRead();
    return this.store.listSessionRuns(sessionId, limit);
  }

  async getSessionRunsAsync(sessionId: string, limit = 100): Promise<SessionRunRecord[]> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, sessionId);
    if (!found) {
      if (this.pluginManager.hasLoadedRegistry()) return [];
      return this.store.listSessionRuns(sessionId, limit);
    }
    const res = unwrapPeerServiceResult(
      await found.provider.service.listSessionRuns({ sessionId, limit }),
    );
    return res.runs.map(runDtoToModel);
  }

  // ── Session Checkpoints & Atomic Revert ──────────────────────────────

  listSessionCheckpoints(sessionId: string, limit = 100): SessionCheckpointRecord[] {
    const svc = this.pluginManager.host.get<CheckpointService>('checkpoints');
    if (svc) return svc.list(sessionId, limit);
    return this.store.listCheckpointRecords(sessionId, limit);
  }

  async listSessionCheckpointsAsync(sessionId: string, limit = 100): Promise<SessionCheckpointRecord[]> {
    const session = this.store.getSession(sessionId);
    try {
      const { provider } = resolveGitCheckpointProvider(this.pluginManager, {
        sessionId,
        workspaceId: session?.workspaceId,
      });
      return await provider.list(sessionId, limit);
    } catch {
      return this.store.listCheckpointRecords(sessionId, limit);
    }
  }

  async captureManualCheckpoint(sessionId: string): Promise<SessionCheckpointRecord> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new CheckpointError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    const { provider } = resolveGitCheckpointProvider(this.pluginManager, {
      sessionId,
      workspaceId: session.workspaceId,
    });
    const latest = (await provider.list(sessionId, 1))[0];
    const record = await provider.capture({
      sessionId,
      cwd: session.cwd,
      turnSeq: session.lastSeq,
      phase: 'manual',
      compareAgainstTreeSha: latest?.treeSha ?? null,
    });
    if (!record) {
      throw new CheckpointError('E_NOT_GIT_REPO', '当前工作区不是有效的 Git 仓库，无法捕获检查点');
    }
    this.emitCanonical(sessionId, 'checkpoint.captured', {
      checkpoint: record,
      phase: record.phase,
    });
    return record;
  }

  async diffSessionCheckpoints(
    sessionId: string,
    opts: { fromCheckpointId?: string; toCheckpointId?: string; fromSeq?: number; toSeq?: number },
  ): Promise<CheckpointDiffResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new CheckpointError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    const { provider } = resolveGitCheckpointProvider(this.pluginManager, {
      sessionId,
      workspaceId: session.workspaceId,
    });
    return provider.diff({
      sessionId,
      cwd: session.cwd,
      ...opts,
    });
  }

  async revertSessionCheckpoint(
    sessionId: string,
    req: RevertCheckpointRequest,
  ): Promise<CheckpointRevertResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new CheckpointError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    if (session.status === 'running' || session.status === 'awaiting_approval') {
      throw new CheckpointError('E_SESSION_BUSY', '请先等待或中止当前运行中的轮次后再执行回滚');
    }

    const { provider } = resolveGitCheckpointProvider(this.pluginManager, {
      sessionId,
      workspaceId: session.workspaceId,
    });
    const adapter = this.registry.get(session.harnessId);
    const supportsNativeRollback = Boolean(adapter?.capabilitiesV2?.supportsNativeRollback);

    // Estimate how many turns have occurred since targetTurnSeq for native rollback
    const allCheckpoints = await provider.list(sessionId, 500);
    const targetRecord = req.checkpointId ? await provider.get(req.checkpointId) : undefined;
    const targetSeq =
      req.targetTurnSeq ??
      targetRecord?.turnSeq ??
      0;
    const turnsSinceTarget = Math.max(
      1,
      allCheckpoints.filter((c) => c.phase === 'turn_pre' && c.turnSeq >= targetSeq).length,
    );

    const hooks: CheckpointRevertHooks = {
      supportsNativeRollback,
      turnsToRollback: turnsSinceTarget,
      performNativeRollback: async (numTurns: number) => {
        const runtimeProvider = resolveSessionRuntimeProvider(this.pluginManager, {
          sessionId,
          workspaceId: session.workspaceId,
        });
        if (runtimeProvider.instanceId !== SESSION_RUNTIME_DEFAULT_PLUGIN_ID || !this.runtimeController?.isActive()) {
          throw new CheckpointError(
            'E_NATIVE_ROLLBACK_FAILED',
            '当前会话未绑定默认运行时插件，无法执行原生对话回滚',
          );
        }
        const handle = this.runtimeController.getLiveHandle(sessionId, session.harnessId);
        if (!handle?.runNativeCommand) {
          throw new CheckpointError(
            'E_NATIVE_ROLLBACK_FAILED',
            `当前驱动 (${session.harnessId}) 未暴露原生回滚接口，已中止回滚且未修改任何工作区文件`,
          );
        }
        try {
          await handle.runNativeCommand('rollback', String(numTurns));
        } catch (err) {
          throw new CheckpointError(
            'E_NATIVE_ROLLBACK_FAILED',
            `原生对话回滚失败，已中止回滚且未修改任何工作区文件：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      resetNativeBinding: async () => {
        await this.disposeSessionHandles(sessionId);
        this.store.updateSession(sessionId, { nativeSessionId: null });
        const existingBinding = this.store.getSessionBinding(sessionId, session.harnessId);
        this.store.upsertSessionBinding({
          sessionId,
          harnessId: session.harnessId,
          harnessKind: session.harnessKind,
          nativeSessionId: null,
          lastModel: existingBinding?.lastModel ?? session.model,
          lastActualModel: existingBinding?.lastActualModel ?? session.actualModel ?? null,
          lastEffort: existingBinding?.lastEffort ?? session.reasoningEffort,
          syncedUpToSeq: targetSeq,
          driverUsed: null,
          updatedAt: Date.now(),
        });
      },
      onReverted: (revertResult: CheckpointRevertResult, target: SessionCheckpointRecord) => {
        const ev = this.emitCanonical(sessionId, 'checkpoint.reverted', {
          ...revertResult,
          checkpointId: target.checkpointId,
          gitRef: target.gitRef,
          treeSha: target.treeSha,
          harnessId: session.harnessId,
        });
        const modeLabel =
          revertResult.modeUsed === 'native_and_files'
            ? '原生对话与工作区文件已同步回滚'
            : revertResult.modeUsed === 'fork_new_branch'
              ? '工作区文件已还原，并已重置原生会话绑定以新分支续跑'
              : '仅还原了工作区文件（对话上下文保留原状，未伪造对话回滚）';
        this.store.upsertTurnItem({
          itemId: `revert:${ev.seq}`,
          schemaVersion: 2,
          sessionId,
          turnId: `revert_${ev.seq}`,
          seq: ev.seq,
          instanceId: session.harnessId,
          driverId: session.harnessKind,
          blockType: 'system_notice',
          status: 'completed',
          title: '检查点回滚完成',
          textBody: `${modeLabel}（还原 ${revertResult.filesRestored} 个文件，清理 ${revertResult.untrackedRemoved} 个新增文件；已自动保存撤销点 ${revertResult.preRevertCheckpointId}）。`,
          payload: { ...revertResult },
          outputOmitted: false,
          omittedBytes: 0,
          createdAt: ev.createdAt,
          updatedAt: ev.createdAt,
        });
        const refreshed = this.store.getSession(sessionId);
        if (refreshed) {
          this.pluginManager.host.get<TaskLedgerService>('ledger')?.syncSession(refreshed);
        }
      },
    };

    if (this.pluginManager.host.getServiceByInstance(provider.instanceId, 'checkpoints')) {
      return await provider.revert({
        sessionId,
        cwd: session.cwd,
        checkpointId: req.checkpointId,
        targetTurnSeq: req.targetTurnSeq,
        mode: req.mode,
        hooks,
      });
    }

    // External isolated git.checkpoint.v1 provider: enforce conversation rollback guard before calling peer revert
    if (req.mode === 'native_and_files') {
      if (!hooks.supportsNativeRollback) {
        throw new CheckpointError(
          'E_NATIVE_ROLLBACK_UNSUPPORTED',
          '当前 Harness 驱动不支持原生对话回滚，严禁静默伪造。请明确选择“仅还原文件 (files_only)”或“还原文件并开启新原生分支 (fork_new_branch)”。',
        );
      }
      await hooks.performNativeRollback?.(turnsSinceTarget);
    } else if (req.mode === 'fork_new_branch') {
      await hooks.resetNativeBinding?.();
    }
    const result = await provider.revert({
      sessionId,
      cwd: session.cwd,
      checkpointId: req.checkpointId,
      targetTurnSeq: req.targetTurnSeq,
      mode: req.mode,
      hooks,
    });
    const fallbackTarget = targetRecord ?? (await provider.get(result.revertedToCheckpointId)) ?? {
      checkpointId: result.revertedToCheckpointId,
      sessionId,
      turnSeq: result.targetTurnSeq,
      phase: 'turn_pre' as const,
      gitRef: `refs/harnessmate/checkpoints/${sessionId}/${result.revertedToCheckpointId}`,
      treeSha: '',
      baseHeadSha: null,
      filesChanged: result.filesRestored,
      insertions: 0,
      deletions: 0,
      skippedLargeFiles: result.skippedLargeFiles ?? [],
      createdAt: Date.now(),
    };
    await hooks.onReverted?.(result, fallbackTarget);
    return result;
  }

  async gcSessionCheckpoints(
    sessionId: string,
    req: GcCheckpointsRequest,
  ): Promise<{ deletedCount: number; deletedRefs: string[] }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new CheckpointError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    const { provider } = resolveGitCheckpointProvider(this.pluginManager, {
      sessionId,
      workspaceId: session.workspaceId,
    });
    return provider.gcCheckpoints({
      sessionId,
      cwd: session.cwd,
      keepLast: req.keepLast,
      olderThanDays: req.olderThanDays,
    });
  }

  private async capturePostTurnCheckpoint(
    session: Session,
    meta: ActiveTurnMeta,
    turnId: string,
  ): Promise<void> {
    if (meta.maintenance || meta.turnSeq === undefined) return;
    let provider;
    try {
      provider = resolveGitCheckpointProvider(this.pluginManager, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
      }).provider;
    } catch {
      return;
    }
    try {
      const record = await provider.capture({
        sessionId: session.id,
        cwd: session.cwd,
        turnSeq: meta.turnSeq,
        phase: 'turn_post',
        skipIfUnchangedFromTreeSha: meta.preTurnTreeSha ?? null,
        compareAgainstTreeSha: meta.preTurnTreeSha ?? null,
      });
      if (!record) return;
      const ev = this.emitCanonical(
        session.id,
        'checkpoint.captured',
        {
          checkpoint: record,
          phase: record.phase,
          turnSeq: record.turnSeq,
          filesChanged: record.filesChanged,
          insertions: record.insertions,
          deletions: record.deletions,
        },
        turnId,
      );
      this.store.upsertTurnItem({
        itemId: `${turnId}:checkpoint:${record.checkpointId}`,
        schemaVersion: 2,
        sessionId: session.id,
        turnId,
        seq: ev.seq,
        instanceId: meta.harnessId,
        driverId: meta.harnessKind,
        blockType: 'checkpoint_marker',
        status: 'completed',
        title: `检查点 · Turn #${record.turnSeq}`,
        textBody: `+${record.insertions} -${record.deletions} · ${record.filesChanged} 个文件变更`,
        payload: {
          checkpointId: record.checkpointId,
          turnSeq: record.turnSeq,
          phase: record.phase,
          gitRef: record.gitRef,
          treeSha: record.treeSha,
          filesChanged: record.filesChanged,
          insertions: record.insertions,
          deletions: record.deletions,
          skippedLargeFiles: record.skippedLargeFiles,
        },
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: ev.createdAt,
        updatedAt: ev.createdAt,
      });
    } catch {
      // Never fail or crash a completed turn due to checkpoint capture errors
    }
  }

  settleOrphanedSession(sessionId: string, reason = 'Adapter process exited unexpectedly'): void {
    this.deltaCoalescer.flushSession(sessionId);
    const meta = this.activeTurnMeta.get(sessionId);
    if (meta) {
      this.store.finishSessionRun(meta.runId, {
        status: 'interrupted',
        failureClass: 'process_exit',
      });
      this.activeTurnMeta.delete(sessionId);
    }
    this.store.settleRunningTurnItems(sessionId, 'interrupted');
    this.cancelSessionApprovals(sessionId, '会话连接中断，待处理请求已自动取消');
    const session = this.store.getSession(sessionId);
    if (session && (session.status === 'running' || session.status === 'awaiting_approval')) {
      this.emitCanonical(sessionId, 'diagnostic.log', {
        level: 'warn',
        stream: 'protocol',
        message: reason,
        harnessId: session.harnessId,
      });
      this.setSessionStatus(sessionId, 'error');
    }
  }

  getExplorerService(): SessionExplorerService {
    const svc =
      this.pluginManager.host.get<SessionExplorerService>('session-search') ??
      (this.fallbackExplorer ??= new SessionExplorerService(this.store, this.registry));
    svc.attachHooks({
      emitCanonical: (sessionId, type, payload, turnId) =>
        this.emitCanonical(sessionId, type, payload, turnId ?? null),
      createSession: (req) => this.createSession(req),
      addWorkspace: (rootPath, name) => this.addWorkspace(rootPath, name),
      tryNativeFork: async (source, _fromTurnSeq) => {
        const handle = this.runtimeController?.getLiveHandle(source.id, source.harnessId);
        if (handle?.runNativeCommand) {
          const out = await handle.runNativeCommand('fork', source.nativeSessionId ?? '');
          const trimmed = out.trim();
          if (trimmed && !/\s/.test(trimmed)) return trimmed;
        }
        return null;
      },
      getTaskLedger: () => this.pluginManager.host.get<TaskLedgerService>('ledger'),
      onSessionImported: (importedSession, meta) => {
        this.eventBus.publishAttention({
          kind: 'session_updated',
          sessionId: importedSession.id,
          sessionTitle: importedSession.title,
          harnessId: importedSession.harnessId,
          summary: `Imported session (${String(meta.mode ?? 'attach')})`,
          timestamp: Date.now(),
        });
      },
    });
    return svc;
  }

  getApprovalCenter(): ApprovalCenterService {
    return (
      this.pluginManager.host.get<ApprovalCenterService>('approval-center') ??
      (this.fallbackApprovalCenter ??= new ApprovalCenterService(this.store))
    );
  }

  getOrchestratorService(): OrchestratorService {
    const svc =
      this.pluginManager.host.get<OrchestratorService>('orchestrator') ??
      (this.fallbackOrchestrator ??= new OrchestratorService(this.store, this.registry));
    svc.attachHooks({
      createChildSession: async ({
        parentSession,
        targetInstanceId,
        roleTitle,
        cwd,
        worktreeBranch,
        permissionMode,
        model,
      }) => {
        const adapter = this.registry.get(targetInstanceId);
        if (!adapter) {
          throw new Error(`Target harness instance not registered: ${targetInstanceId}`);
        }
        const now = Date.now();
        const child = this.store.createSession({
          id: `sess_${crypto.randomBytes(6).toString('hex')}`,
          workspaceId: parentSession.workspaceId,
          harnessId: adapter.id,
          harnessKind: adapter.kind,
          nativeSessionId: null,
          parentSessionId: parentSession.id,
          participatingHarnesses: [adapter.id],
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
        this.emitCanonical(child.id, 'session.status', { status: 'idle' });
        await this.pluginManager.dispatchLifecycleEvent(
          sessionPluginEvent('session.created', child),
          child.workspaceId,
        );
        return this.store.getSession(child.id)!;
      },
      sendTurn: (sessionId, text, opts) => this.sendTurn(sessionId, text, undefined, opts),
      interruptSession: (sessionId) => this.interruptSession(sessionId),
      disposeSessionHandles: (sessionId) => this.disposeSessionHandles(sessionId),
      emitCanonical: (sessionId, type, payload, turnId) =>
        this.emitCanonical(sessionId, type, payload, turnId ?? null),
      publishAttention: (item) => this.eventBus.publishAttention(item),
      getGitService: () => {
        const provider = resolveOptionalGitWorkspaceProvider(this.pluginManager, {
          workspaceId: undefined,
        });
        return provider as unknown as GitService | undefined;
      },
      getTaskLedger: () => this.pluginManager.host.get<TaskLedgerService>('ledger'),
      isOrchestratorEnabled: () => this.pluginManager.isPluginEnabled(ORCHESTRATOR_PLUGIN_ID),
    });
    return svc;
  }

  private getActiveOrchestrator(): OrchestratorService | null {
    if (!this.pluginManager.isPluginEnabled(ORCHESTRATOR_PLUGIN_ID)) return null;
    if (!this.pluginManager.host.get<OrchestratorService>('orchestrator')) return null;
    return this.getOrchestratorService();
  }

  getContextCompressionService(): ContextCompressionService {
    const active = this.pluginManager.host.get<ContextCompressionService>('compressor');
    const svc = active ?? (this.fallbackCompressor ??= new ContextCompressionService(this.store, this.registry));
    svc.attachHooks({
      isEnabled: () => this.pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID),
      emitEvent: (sessionId, type, payload) => this.emitCanonical(sessionId, type, payload, null),
      getTaskState: (sessionId) => {
        const session = this.store.getSession(sessionId);
        if (!session) return undefined;
        return this.getLocalLedger(session)?.getOrCreate(session) ?? this.store.getTaskState(sessionId) ?? undefined;
      },
    });
    return svc;
  }

  private attachActiveCompressorHooks(): void {
    if (!this.pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID)) return;
    if (!this.pluginManager.host.get<ContextCompressionService>('compressor')) return;
    this.getContextCompressionService();
  }

  searchSessions(opts: SessionExplorerQueryOptions): SessionSearchResponse {
    return this.getExplorerService().query(opts);
  }

  async rebuildSearchIndex(): Promise<{ indexedCount: number }> {
    return this.getExplorerService().rebuildBacklogIndex(20);
  }

  async discoverExternalSessions(opts?: { limit?: number; forceRefresh?: boolean }) {
    return this.getExplorerService().discoverExternal(opts);
  }

  async importExternalSession(req: ImportNativeSessionRequest) {
    return this.getExplorerService().importExternal(req);
  }

  async forkSession(sessionId: string, req: ForkSessionRequest): Promise<ForkSessionResult> {
    return this.getExplorerService().forkSession(sessionId, req);
  }

  mergeBackSession(childSessionId: string, req: MergeBackRequest): MergeBackResult {
    return this.getExplorerService().mergeBack(childSessionId, req);
  }

  getSideChat(sessionId: string): SideChatMessage[] {
    return this.getExplorerService().getSideChat(sessionId);
  }

  clearSideChat(sessionId: string): void {
    this.getExplorerService().clearSideChat(sessionId);
  }

  async sendSideChat(sessionId: string, req: SideChatRequest) {
    return this.getExplorerService().sendSideChat(sessionId, req);
  }

  async promoteSideChatToFork(sessionId: string, req?: SideChatPromoteRequest): Promise<ForkSessionResult> {
    return this.getExplorerService().promoteSideChatToFork(sessionId, req);
  }

  exportSession(
    sessionId: string,
    format: 'markdown' | 'json_bundle',
    opts?: { redact?: boolean },
  ) {
    return this.getExplorerService().exportSession(sessionId, format, opts);
  }

  async importSessionBundle(req: ImportSessionBundleRequest): Promise<Session> {
    return this.getExplorerService().importSessionBundle(req);
  }

  private service<Service>(name: string): Service {
    const service = this.pluginManager.host.get<Service>(name);
    if (!service) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${name} 当前不可用`);
    return service;
  }

  private getLocalLedger(session: Session): TaskLedgerService | undefined {
    const selection = this.pluginManager.resolveServiceSelection('session.ledger.v1', {
      sessionId: session.id, allowSingleCandidate: true,
    });
    if (selection.status === 'ready') {
      return this.pluginManager.host.getServiceByInstance<TaskLedgerService>(selection.instanceId, 'ledger');
    }
  }

  // ── Workspaces ───────────────────────────────────────────────────────

  async addWorkspace(rootPath: string, name?: string, dataInstanceId?: string): Promise<Workspace> {
    await this.pluginManager.ensureBootstrapped();
    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Workspace directory does not exist: ${resolved}`);
    }

    const provider = resolveSessionDataProvider(
      this.pluginManager,
      dataInstanceId ? { explicitInstanceId: dataInstanceId } : undefined,
    );
    const existingRes = unwrapPeerServiceResult(await provider.service.getWorkspaceByPath({ rootPath: resolved }));
    if (existingRes.workspace) {
      const existing = existingRes.workspace;
      recordResourceOwner(this.store, 'workspace', existing.id, provider.instanceId, existing.id);
      if (dataInstanceId) {
        await this.pluginManager.setWorkspaceBinding(existing.id, PEER_CONTRACTS.sessionData, provider.instanceId).catch(() => {});
      }
      const gitProvider = resolveOptionalGitWorkspaceProvider(this.pluginManager, { workspaceId: existing.id });
      const git = await gitProvider?.inspect(resolved, existing.id).catch(() => undefined);
      if (git) {
        const updatedRes = unwrapPeerServiceResult(
          await provider.service.updateWorkspaceGit({
            workspaceId: existing.id,
            isGitRepo: git.isGitRepo,
            gitBranch: git.branch,
          }),
        );
        if (updatedRes.workspace) return workspaceDtoToModel(updatedRes.workspace);
      }
      return workspaceDtoToModel(existing);
    }

    const gitProvider = resolveOptionalGitWorkspaceProvider(this.pluginManager);
    const git = (await gitProvider?.inspect(resolved).catch(() => undefined)) ?? { isGitRepo: false, branch: null };
    const createdRes = unwrapPeerServiceResult(
      await provider.service.createWorkspace({
        id: `ws_${crypto.randomBytes(6).toString('hex')}`,
        name: name?.trim() || path.basename(resolved) || resolved,
        rootPath: resolved,
        isGitRepo: git.isGitRepo,
        gitBranch: git.branch,
        createdAt: Date.now(),
      }),
    );
    recordResourceOwner(
      this.store,
      'workspace',
      createdRes.workspace.id,
      provider.instanceId,
      createdRes.workspace.id,
    );
    if (dataInstanceId) {
      await this.pluginManager.setWorkspaceBinding(
        createdRes.workspace.id,
        PEER_CONTRACTS.sessionData,
        provider.instanceId,
      ).catch(() => {});
    }
    return workspaceDtoToModel(createdRes.workspace);
  }

  listWorkspaces(): Workspace[] {
    this.assertDefaultDataEnabledForSyncRead();
    return this.store.listWorkspaces();
  }

  async listWorkspacesAsync(): Promise<Workspace[]> {
    await this.pluginManager.ensureBootstrapped();
    const providers = listActiveSessionDataProviders(this.pluginManager);
    if (providers.length === 0) {
      this.assertDefaultDataEnabledForSyncRead();
      if (this.pluginManager.hasLoadedRegistry()) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '当前没有可用的会话数据插件实例');
      }
      return this.store.listWorkspaces();
    }
    const seen = new Map<string, Workspace>();
    for (const provider of providers) {
      const res = await provider.service.listWorkspaces();
      if (!res.ok) continue;
      for (const ws of res.value.workspaces) {
        if (!seen.has(ws.id)) seen.set(ws.id, workspaceDtoToModel(ws));
      }
    }
    return [...seen.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async getWorkspaceAsync(id: string): Promise<Workspace | null> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findWorkspaceWithProvider(this.pluginManager, id);
    return found ? workspaceDtoToModel(found.workspace) : null;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findWorkspaceWithProvider(this.pluginManager, id);
    if (!found) return false;
    const { provider, workspace: ws } = found;
    await this.terminalWorkspace?.closeWorkspaceTerminals(id);
    await releaseTerminalsUsingPath(this.pluginManager, ws.rootPath, id).catch(() => {});
    const sessRes = unwrapPeerServiceResult(
      await provider.service.listSessions({ workspaceId: id, includeArchived: true }),
    );
    for (const s of sessRes.sessions) {
      if (s.cwd) {
        await releaseTerminalsUsingPath(this.pluginManager, s.cwd, id).catch(() => {});
      }
      await this.disposeSessionHandles(s.id);
      removeResourceOwner(this.store, 'session', s.id);
    }
    const deletedRes = unwrapPeerServiceResult(await provider.service.deleteWorkspace({ workspaceId: id }));
    if (deletedRes.deleted) {
      removeResourceOwner(this.store, 'workspace', id);
    }
    return deletedRes.deleted;
  }

  recordTerminalEvent(
    sessionId: string,
    type: 'terminal.opened' | 'terminal.exited' | 'terminal.context_attached',
    payload: Record<string, unknown>,
  ): void {
    if (!this.store.getSession(sessionId)) return;
    this.emitCanonical(sessionId, type, payload, null);
  }

  private formatTerminalContextsBlock(chips: readonly TerminalContextChip[]): string {
    const sections = chips.slice(0, 12).map((chip) => {
      const sanitized = stripAnsiAndClip(chip.cleanText, {
        lineStart: 1,
        lineEnd: 500,
        maxBytes: 16_384,
      });
      const exitLabel =
        chip.exitCode !== null && chip.exitCode !== undefined ? ` · exit ${chip.exitCode}` : '';
      const truncLabel = chip.truncated || sanitized.truncated ? ' · truncated' : '';
      return [
        `### ${chip.terminalTitle} (lines ${chip.lineStart}–${chip.lineEnd}${exitLabel}${truncLabel})`,
        `- **CWD**: \`${chip.cwd}\``,
        '```text',
        sanitized.cleanText,
        '```',
      ].join('\n');
    });
    return [`## Attached Terminal Context (${sections.length})`, '', ...sections].join('\n');
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  listSessions(filter?: { workspaceId?: string; harnessId?: string; includeArchived?: boolean }): Session[] {
    this.assertDefaultDataEnabledForSyncRead();
    return this.store.listSessions(filter);
  }

  async listSessionsAsync(filter?: {
    workspaceId?: string;
    harnessId?: string;
    includeArchived?: boolean;
  }): Promise<Session[]> {
    await this.pluginManager.ensureBootstrapped();
    if (filter?.workspaceId) {
      const wsFound = await findWorkspaceWithProvider(this.pluginManager, filter.workspaceId);
      if (!wsFound) {
        if (this.pluginManager.hasLoadedRegistry()) return [];
        return this.store.listSessions(filter);
      }
      const res = unwrapPeerServiceResult(await wsFound.provider.service.listSessions(filter));
      return res.sessions.map(sessionDtoToModel);
    }
    const providers = listActiveSessionDataProviders(this.pluginManager);
    if (providers.length === 0) {
      this.assertDefaultDataEnabledForSyncRead();
      if (this.pluginManager.hasLoadedRegistry()) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '当前没有可用的会话数据插件实例');
      }
      return this.store.listSessions(filter);
    }
    const seen = new Map<string, Session>();
    for (const provider of providers) {
      const res = await provider.service.listSessions(filter ?? {});
      if (!res.ok) continue;
      for (const s of res.value.sessions) {
        if (!seen.has(s.id)) seen.set(s.id, sessionDtoToModel(s));
      }
    }
    return [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(id: string): Session | null {
    this.assertDefaultDataEnabledForSyncRead();
    return this.store.getSession(id);
  }

  async getSessionAsync(id: string): Promise<Session | null> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, id);
    if (found) return sessionDtoToModel(found.session);
    if (this.pluginManager.hasLoadedRegistry()) return null;
    return this.store.getSession(id);
  }

  getSessionEvents(sessionId: string, afterSeq = 0): CanonicalEvent[] {
    this.assertDefaultDataEnabledForSyncRead();
    return this.store.getEventsAfter(sessionId, afterSeq);
  }

  async getSessionEventsAsync(sessionId: string, afterSeq = 0): Promise<CanonicalEvent[]> {
    const page = await this.getSessionEventsPageAsync(sessionId, afterSeq);
    return page.events;
  }

  async getSessionEventsPageAsync(sessionId: string, afterSeq = 0): Promise<{
    events: CanonicalEvent[];
    lastSeq: number;
    hasMore: boolean;
    stream: SessionDataStreamIdentity | null;
  }> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, sessionId);
    if (!found) {
      if (this.pluginManager.hasLoadedRegistry()) {
        return { events: [], lastSeq: 0, hasMore: false, stream: null };
      }
      const events = this.store.getEventsAfter(sessionId, afterSeq);
      const sess = this.store.getSession(sessionId);
      return {
        events,
        lastSeq: sess?.lastSeq ?? 0,
        hasMore: false,
        stream: null,
      };
    }
    const res = unwrapPeerServiceResult(
      await found.provider.service.listEvents({ sessionId, afterSeq }),
    );
    return {
      events: res.events.map(eventDtoToModel),
      lastSeq: res.lastSeq,
      hasMore: res.hasMore,
      stream: res.stream,
    };
  }

  iterateSessionEvents(sessionId: string, afterSeq = 0): Iterable<CanonicalEvent> {
    this.assertDefaultDataEnabledForSyncRead();
    return this.store.iterateEvents(sessionId, afterSeq);
  }

  listPendingApprovals(sessionId?: string): ApprovalRequest[] {
    return this.store.listPendingApprovals(sessionId);
  }

  async createSession(req: CreateSessionRequest): Promise<Session> {
    await this.pluginManager.ensureBootstrapped();
    const wsFound = await findWorkspaceWithProvider(this.pluginManager, req.workspaceId);
    if (!wsFound) {
      throw new Error(`Workspace not found: ${req.workspaceId}`);
    }
    const session = await this.buildSessionFromWorkspace(req, workspaceDtoToModel(wsFound.workspace));
    const createdRes = unwrapPeerServiceResult(
      await wsFound.provider.service.createSession({
        session: {
          id: session.id,
          workspaceId: session.workspaceId,
          harnessId: session.harnessId,
          harnessKind: session.harnessKind,
          nativeSessionId: session.nativeSessionId,
          parentSessionId: session.parentSessionId ?? null,
          forkedFromTurnSeq: session.forkedFromTurnSeq ?? null,
          forkMode:
            session.forkMode === 'native'
              ? 'clean_fork'
              : session.forkMode === 'portable'
                ? 'with_context'
                : null,
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
          reasoningEffort: session.reasoningEffort ?? null,
          permissionMode: session.permissionMode,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      }),
    );
    const created = sessionDtoToModel(createdRes.session);
    recordResourceOwner(this.store, 'session', created.id, wsFound.provider.instanceId, created.workspaceId);

    const statusEvRes = unwrapPeerServiceResult(
      await wsFound.provider.service.appendEvent({
        sessionId: created.id,
        type: 'session.status',
        turnId: null,
        payload: { status: 'idle' },
      }),
    );
    const statusEv = eventDtoToModel(statusEvRes.event);
    this.eventBus.publishEvent(statusEv);
    this.pluginManager?.notifyEvent(statusEv, created.workspaceId);

    await this.pluginManager.dispatchLifecycleEvent(sessionPluginEvent('session.created', created), created.workspaceId);

    const latestRes = unwrapPeerServiceResult(await wsFound.provider.service.getSession({ sessionId: created.id }));
    return latestRes.session ? sessionDtoToModel(latestRes.session) : created;
  }

  async importNativeSession(req: ImportNativeSessionRequest): Promise<Session> {
    const existing = this.store.getImportedSession(req.source, req.nativeSessionId);
    if (existing) return existing;
    const importKey = `${req.source}:${req.nativeSessionId}`;
    const pending = this.importingSessions.get(importKey);
    if (pending) return pending;
    const importing = this.loadNativeHistory(req);
    this.importingSessions.set(importKey, importing);
    try {
      return await importing;
    } finally {
      this.importingSessions.delete(importKey);
    }
  }

  private async loadNativeHistory(req: ImportNativeSessionRequest): Promise<Session> {
    const kind = req.source.startsWith('codex_') ? 'codex' : req.source.startsWith('agy_') ? 'agy' : 'claude';
    const native = await findLocalSession(kind, req.nativeSessionId, req.source);
    if (!native || native.source !== req.source) throw new Error('找不到此原生会话');
    return this.importHistory(native, req.workspaceId);
  }

  private async importHistory(native: DiscoveredCliSession, workspaceId?: string): Promise<Session> {
    const fallback = workspaceId ? this.store.getWorkspace(workspaceId) : null;
    let hasLocalCwd = false;
    if (native.cwd && path.isAbsolute(native.cwd)) {
      try { hasLocalCwd = fs.statSync(native.cwd, { throwIfNoEntry: false })?.isDirectory() ?? false; }
      catch { /* the original root may no longer be accessible */ }
    }
    const cwd = hasLocalCwd ? native.cwd! : fallback?.rootPath;
    if (!cwd) throw new Error('原工作目录不可用，请选择一个本地工作区');
    const adapter = this.registry.get(native.harnessKind);
    if (!adapter) throw new Error('原生会话对应的 Harness 尚未注册');
    const messages = native.harnessKind === 'agy' && adapter instanceof AcpAdapter
      ? await adapter.readHistory(native, cwd)
      : await readJsonlHistory(native);
    if (!messages.some((message) => message.text.trim())) throw new Error('此会话没有可导入的文本消息');

    const workspace = hasLocalCwd ? await this.addWorkspace(cwd) : fallback!;
    const session = await this.buildSession({
      workspaceId: workspace.id, harnessId: adapter.id, title: native.title,
      nativeSessionId: native.nativeSessionId, permissionMode: 'manual',
    });
    const attribution = { harnessId: adapter.id, harnessKind: adapter.kind, imported: true };
    const events: Array<Omit<CanonicalEvent, 'sessionId' | 'seq'>> = [];
    let user: { text: string; timestamp?: number } | undefined;
    let assistant: string[] = [];
    let assistantTimestamp: number | undefined;
    let turn = 0;
    const flush = () => {
      if (!user && !assistant.length) return;
      const turnId = `import_${++turn}`;
      const createdAt = user?.timestamp || assistantTimestamp || native.updatedAt || session.createdAt;
      if (user) events.push({
        type: 'message.user', turnId, createdAt, payload: { ...attribution, text: user.text },
      });
      if (assistant.length) events.push({
        type: 'message.assistant.completed', turnId, createdAt: assistantTimestamp || createdAt,
        payload: { ...attribution, text: assistant.join('\n\n') },
      });
      events.push({
        type: 'turn.completed', turnId, createdAt: assistantTimestamp || createdAt,
        payload: { ...attribution, stopReason: 'imported_history' },
      });
      user = undefined;
      assistant = [];
      assistantTimestamp = undefined;
    };
    for (const message of messages) {
      if (!message.text.trim()) continue;
      if (message.role === 'user') {
        flush();
        user = message;
      } else {
        assistant.push(message.text);
        assistantTimestamp = message.timestamp || assistantTimestamp;
      }
    }
    flush();
    return this.store.importSession(session, native.source!, native.sourcePath, events);
  }

  private async buildSession(req: CreateSessionRequest): Promise<Session> {
    const found = await findWorkspaceWithProvider(this.pluginManager, req.workspaceId);
    if (!found) throw new Error(`Workspace not found: ${req.workspaceId}`);
    return this.buildSessionFromWorkspace(req, workspaceDtoToModel(found.workspace));
  }

  private async buildSessionFromWorkspace(req: CreateSessionRequest, ws: Workspace): Promise<Session> {
    let adapter = req.harnessId ? this.registry.get(req.harnessId) : undefined;
    if (!adapter && !req.harnessId) {
      // Pick first ready harness (fallback to first registered)
      const adapters = this.registry.listAdapters();
      adapter = adapters[0];
    }
    if (!adapter) {
      throw new Error(`Harness not registered: ${req.harnessId ?? '(none available)'}`);
    }

    let cwd = ws.rootPath;
    let worktreeBranch: string | null = null;
    if (req.createWorktree && ws.isGitRepo) {
      const branch = req.worktreeBranch?.trim() || `hm/task-${Date.now().toString(36)}`;
      const wt = await resolveGitWorkspaceProvider(this.pluginManager, {
        workspaceId: ws.id,
      }).provider.createWorktree(ws.rootPath, branch);
      cwd = wt.worktreePath;
      worktreeBranch = wt.branch;
    }

    const now = Date.now();
    return {
      id: `sess_${crypto.randomBytes(6).toString('hex')}`,
      workspaceId: ws.id,
      harnessId: adapter.id,
      harnessKind: adapter.kind,
      nativeSessionId: req.nativeSessionId ?? null,
      participatingHarnesses: [adapter.id],
      contextSyncMode: req.contextSyncMode ?? 'auto',
      cwd,
      worktreeBranch,
      title: req.title?.trim() || `任务 · ${ws.name}`,
      status: 'idle',
      model: req.model ?? null,
      actualModel: null,
      modelReroutedReason: null,
      reasoningEffort: req.reasoningEffort ?? null,
      permissionMode: req.permissionMode,
      lastSeq: 0,
      usage: null,
      pendingApprovalCount: 0,
      createdAt: now,
      updatedAt: now,
    };

  }

  async updateSession(id: string, req: UpdateSessionRequest, configAlreadyApplied = false): Promise<Session> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, id);
    if (!found) throw new Error(`Session not found: ${id}`);
    const { provider, session: currentDto } = found;
    const current = sessionDtoToModel(currentDto);

    const configChanged =
      (req.model !== undefined && req.model !== current.model) ||
      (req.reasoningEffort !== undefined && req.reasoningEffort !== current.reasoningEffort) ||
      (req.permissionMode !== undefined && req.permissionMode !== current.permissionMode);

    const updatedRes = unwrapPeerServiceResult(
      await provider.service.updateSession({
        sessionId: id,
        patch: {
          title: req.title,
          model: req.model,
          reasoningEffort: req.reasoningEffort,
          permissionMode: req.permissionMode,
          contextSyncMode: req.contextSyncMode,
          ...(req.model !== undefined && req.model !== current.model
            ? { actualModel: null, modelReroutedReason: null }
            : {}),
          status: req.archived === true ? 'archived' : req.archived === false ? 'idle' : undefined,
        },
      }),
    );
    if (!updatedRes.session) throw new Error(`Failed to update session: ${id}`);
    const updated = sessionDtoToModel(updatedRes.session);

    // Mirror model/effort preference into active harness binding
    const prevBinding = unwrapPeerServiceResult(
      await provider.service.getHarnessBinding({ sessionId: id, harnessId: updated.harnessId }),
    ).binding;
    unwrapPeerServiceResult(
      await provider.service.upsertHarnessBinding({
        binding: {
          sessionId: id,
          harnessId: updated.harnessId,
          harnessKind: updated.harnessKind,
          nativeSessionId: updated.nativeSessionId,
          lastModel: updated.model,
          lastActualModel: updated.actualModel ?? null,
          lastEffort: updated.reasoningEffort,
          syncedUpToSeq: prevBinding?.syncedUpToSeq ?? 0,
          driverUsed: null,
          updatedAt: Date.now(),
        },
      }),
    );

    if (req.archived !== undefined) {
      if (req.archived === true) {
        await this.getActiveOrchestrator()?.cascadeStopChildren(id, 'Parent session archived');
      }
      await this.disposeSessionHandles(id);
    } else if (!configAlreadyApplied && configChanged && current.status === 'idle') {
      const runtimeRes = this.pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionRuntime, {
        sessionId: id,
        workspaceId: updated.workspaceId,
        allowSingleCandidate: true,
      });
      if (runtimeRes.status === 'ready' && runtimeRes.instanceId) {
        const runtimeSvc = this.pluginManager.host.getServiceByInstance<
          import('@harnessmate/plugin-api').SessionRuntimeServiceV1
        >(runtimeRes.instanceId, PEER_CONTRACTS.sessionRuntime);
        if (runtimeSvc) {
          unwrapPeerServiceResult(
            await runtimeSvc.applyConfig({
              sessionId: id,
              patch: {
                model: updated.model,
                reasoningEffort: updated.reasoningEffort,
                permissionMode: updated.permissionMode,
              },
            }),
          );
        }
      }
    }

    this.eventBus.publishAttention({
      kind: 'session_updated',
      sessionId: updated.id,
      sessionTitle: updated.title,
      harnessId: updated.harnessId,
      summary: 'Session updated',
      timestamp: Date.now(),
    });
    const refreshed = unwrapPeerServiceResult(await provider.service.getSession({ sessionId: id })).session;
    return refreshed ? sessionDtoToModel(refreshed) : updated;
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, id);
    if (!found) return false;
    const session = sessionDtoToModel(found.session);
    await this.getActiveOrchestrator()?.cascadeStopChildren(id, 'Parent session deleted');
    await this.pluginManager.dispatchLifecycleEvent(sessionPluginEvent('session.closing', session), session.workspaceId);
    await this.disposeSessionHandles(id);
    const deletedRes = unwrapPeerServiceResult(await found.provider.service.deleteSession({ sessionId: id }));
    if (deletedRes.deleted) {
      removeResourceOwner(this.store, 'session', id);
    }
    return deletedRes.deleted;
  }

  // ── Seamless In-Session Harness Switching & Context Bridge ───────────

  async getContextPreview(
    sessionId: string,
    targetHarnessId?: string,
    syncMode?: ContextSyncMode,
  ): Promise<ContextPreview> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const targetId = targetHarnessId || session.harnessId;
    const adapter = this.registry.get(targetId);
    if (!adapter) throw new Error(`Harness not registered: ${targetId}`);

    const binding = this.store.getSessionBinding(sessionId, targetId);
    this.attachActiveCompressorHooks();
    const compiler = this.pluginManager.host.get<ContextCompiler>('handoff');
    if (!compiler) return {
      sessionId, targetHarnessId: targetId, targetHarnessKind: adapter.kind, currentLastSeq: session.lastSeq,
      syncedUpToSeq: binding?.syncedUpToSeq ?? 0, unsyncedTurnCount: 0, estimatedTokens: 0, budgetTokens: 12_000,
      driverPlanned: 'native_warm', isWarmBinding: Boolean(binding?.nativeSessionId), syncNeeded: false,
      compiledMarkdown: '交接服务当前不可用', ledgerMarkdown: '', deltaTurnSummary: [],
    };
    const packet = await compiler.compile({
      session,
      targetHarnessId: adapter.id,
      targetHarnessKind: adapter.kind,
      binding,
      syncMode,
    });
    return compiler.options.autoAttach ? packet.preview : { ...packet.preview, syncNeeded: false };
  }

  /**
   * Switches the active Harness inside the SAME unified session without
   * splitting history or losing context. Previously warm handles stay cached
   * in the LRU pool for fast round-trip switching.
   */
  async switchHarness(
    sessionId: string,
    req: SwitchHarnessRequest,
  ): Promise<{ session: Session; contextPreview: ContextPreview }> {
    return this.withSessionStartup(sessionId, () => this.switchHarnessInternal(sessionId, req));
  }

  private async switchHarnessInternal(
    sessionId: string,
    req: SwitchHarnessRequest,
  ): Promise<{ session: Session; contextPreview: ContextPreview }> {
    const current = this.store.getSession(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    if (current.status === 'running' || current.status === 'awaiting_approval') {
      throw new Error('Cannot switch harness while a turn is active or awaiting approval.');
    }

    const targetAdapter = this.registry.get(req.targetHarnessId);
    if (!targetAdapter) {
      throw new Error(`Target harness not registered: ${req.targetHarnessId}`);
    }

    const existingBinding = this.store.getSessionBinding(sessionId, targetAdapter.id);
    const resolvedModel =
      req.targetModel !== undefined
        ? req.targetModel
        : existingBinding?.lastModel ?? null;
    const resolvedEffort =
      req.reasoningEffort !== undefined
        ? req.reasoningEffort
        : existingBinding?.lastEffort ?? null;
    const resolvedSyncMode = req.syncMode ?? current.contextSyncMode ?? 'auto';

    // If same harness and only updating model/effort/syncMode
    if (current.harnessId === targetAdapter.id) {
      const updatedSame = await this.updateSession(sessionId, {
        model: resolvedModel,
        reasoningEffort: resolvedEffort,
        contextSyncMode: resolvedSyncMode,
      });
      const preview = await this.getContextPreview(sessionId, targetAdapter.id, resolvedSyncMode);
      return { session: updatedSame, contextPreview: preview };
    }

    const fromHarnessId = current.harnessId;
    const fromHarnessKind = current.harnessKind;

    // Preview exact delta that target harness will receive on next turn
    const previewBefore = await this.getContextPreview(sessionId, targetAdapter.id, resolvedSyncMode);

    const participating = Array.from(
      new Set([...(current.participatingHarnesses ?? []), fromHarnessId, targetAdapter.id]),
    );

    const updated = this.store.updateSession(sessionId, {
      harnessId: targetAdapter.id,
      harnessKind: targetAdapter.kind,
      nativeSessionId: existingBinding?.nativeSessionId ?? null,
      participatingHarnesses: participating,
      contextSyncMode: resolvedSyncMode,
      model: resolvedModel,
      actualModel: existingBinding?.lastActualModel ?? null,
      modelReroutedReason: null,
      reasoningEffort: resolvedEffort,
      status: current.status === 'error' ? 'idle' : current.status,
    });
    if (!updated) throw new Error(`Failed to switch harness for session: ${sessionId}`);

    // Ensure binding row exists while preserving its prior syncedUpToSeq watermark!
    this.store.upsertSessionBinding({
      sessionId,
      harnessId: targetAdapter.id,
      harnessKind: targetAdapter.kind,
      nativeSessionId: existingBinding?.nativeSessionId ?? null,
      lastModel: resolvedModel,
      lastActualModel: existingBinding?.lastActualModel ?? null,
      lastEffort: resolvedEffort,
      syncedUpToSeq: existingBinding?.syncedUpToSeq ?? 0,
      driverUsed: existingBinding?.driverUsed ?? null,
      updatedAt: Date.now(),
    });

    // Capture lightweight Git anchor for timeline switch divider
    let gitAnchor: string | null = null;
    try {
      const gitProvider = resolveOptionalGitWorkspaceProvider(this.pluginManager, {
        workspaceId: updated.workspaceId,
        sessionId: updated.id,
      });
      const git = await gitProvider?.status(updated.cwd, {
        workspaceId: updated.workspaceId,
        sessionId: updated.id,
      });
      if (git?.isGitRepo) {
        const dirty = git.changes.filter((c) => !c.path.startsWith('.harnessmate/')).length;
        gitAnchor = `${git.branch || 'detached'}${dirty > 0 ? ` · ${dirty} 个改动文件` : ' · clean'}`;
      }
    } catch {
      // ignore
    }

    this.emitCanonical(sessionId, 'session.harness_switched', {
      fromHarnessId,
      fromHarnessKind,
      toHarnessId: targetAdapter.id,
      toHarnessKind: targetAdapter.kind,
      toModel: resolvedModel,
      syncedUpToSeq: previewBefore.syncedUpToSeq,
      currentLastSeq: previewBefore.currentLastSeq,
      unsyncedTurnCount: previewBefore.unsyncedTurnCount,
      estimatedTokens: previewBefore.estimatedTokens,
      driverPlanned: previewBefore.driverPlanned,
      isWarmBinding: previewBefore.isWarmBinding,
      syncMode: resolvedSyncMode,
      gitAnchor,
    });

    // If a warm handle for target harness exists with stale model config, apply config now
    const warmHandle = this.runtimeController?.getLiveHandle(sessionId, targetAdapter.id);
    if (warmHandle && warmHandle.updateConfig) {
      try {
        await warmHandle.updateConfig({
          model: resolvedModel,
          reasoningEffort: resolvedEffort,
          permissionMode: updated.permissionMode,
        });
      } catch {
        // will be applied cleanly on next sendTurn
      }
    }

    this.eventBus.publishAttention({
      kind: 'harness_switched',
      sessionId,
      sessionTitle: updated.title,
      harnessId: targetAdapter.id,
      summary: `已从 ${fromHarnessId} 切换至 ${targetAdapter.id}（待同步 ${previewBefore.unsyncedTurnCount} 轮增量上下文）`,
      timestamp: Date.now(),
    });

    const refreshed = this.store.getSession(sessionId)!;
    return { session: refreshed, contextPreview: previewBefore };
  }

  /**
   * 1-Click Rate-Limit / Error Failover inside the SAME session.
   */
  async failoverSession(
    sessionId: string,
    req: FailoverRequest,
    provenance?: AgyDispatchProvenance,
  ): Promise<{ session: Session; retriedTurnId: string | null }> {
    const current = await this.getSessionAsync(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    const targetAdapter = this.registry.get(req.targetHarnessId);
    if (!targetAdapter) throw new Error(`Target harness not registered: ${req.targetHarnessId}`);
    this.assertDispatchTarget(targetAdapter.id, targetAdapter.kind, provenance);

    const failover = selectedHarnessService<FailoverContract>(this.pluginManager, failoverContract, { sessionId });
    const retry = req.retryLastFailedTurn === false ? undefined : await failover?.retryInput(sessionId);

    if (current.status === 'error') await this.setSessionStatusAsync(sessionId, 'idle');
    const { session: switched } = await this.switchHarnessInternal(sessionId, {
      targetHarnessId: targetAdapter.id,
      targetModel: req.targetModel,
    });

    if (retry) {
      const { turnId } = await this.sendTurn(sessionId, retry.text, retry.attachments, {
        dispatchProvenance: provenance,
      });
      return { session: (await this.getSessionAsync(sessionId)) ?? switched, retriedTurnId: turnId };
    }
    return { session: switched, retriedTurnId: null };
  }

  /**
   * Fork & Switch (legacy Handoff upgraded): creates a parallel branch session
   * on targetHarnessId seeded with full compiled Task State Ledger + Context Packet.
   */
  async handoffSession(
    sourceSessionId: string,
    targetHarnessId: string,
    targetModel?: string | null,
  ): Promise<{ session: Session; handoffPrompt: string }> {
    const source = this.store.getSession(sourceSessionId);
    if (!source) throw new Error(`Source session not found: ${sourceSessionId}`);

    const targetAdapter = this.registry.get(targetHarnessId);
    if (!targetAdapter) throw new Error(`Target harness not registered: ${targetHarnessId}`);

    this.attachActiveCompressorHooks();
    const packet = await this.service<ContextCompiler>('handoff').compile({
      session: source,
      targetHarnessId: targetAdapter.id,
      targetHarnessKind: targetAdapter.kind,
      binding: null,
      syncMode: 'full_ledger',
    });

    const newSession = await this.createSession({
      workspaceId: source.workspaceId,
      harnessId: targetHarnessId,
      title: `分支 · ${source.title}`,
      model: targetModel ?? null,
      permissionMode: source.permissionMode,
    });

    // Copy structured Task State Ledger to forked session
    const sourceLedger = this.getLocalLedger(source)?.getOrCreate(source) ?? this.store.getTaskState(source.id);
    if (sourceLedger) this.getLocalLedger(newSession)?.updateManual(newSession, {
      objective: sourceLedger.objective,
      steps: sourceLedger.steps,
      decisions: sourceLedger.decisions,
      touchedFiles: sourceLedger.touchedFiles,
      verifications: sourceLedger.verifications,
      blockers: sourceLedger.blockers,
      pinnedFacts: sourceLedger.pinnedFacts,
      rollingSummary: sourceLedger.rollingSummary,
    });

    const handoffPrompt = [
      `[Cross-Harness Handoff from ${source.harnessId} · Session "${source.title}"]`,
      packet.deltaMarkdown,
      '',
      '请基于以上任务状态与历史上下文继续推进任务。',
    ].join('\n');
    return { session: this.store.getSession(newSession.id)!, handoffPrompt };
  }

  exportSessionMarkdown(sessionId: string): { filename: string; markdown: string } {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const events = this.store.iterateEvents(sessionId, 0, session.lastSeq);
    const ledgerService = this.getLocalLedger(session);
    const ledger = ledgerService?.getOrCreate(session) ?? this.store.getTaskState(session.id);
    const lines: string[] = [
      `# ${session.title}`,
      '',
      `- **Active Harness**: ${session.harnessId} (${session.harnessKind})`,
      `- **Collaborating Harnesses**: ${(session.participatingHarnesses ?? [session.harnessId]).join(', ')}`,
      `- **Model**: ${session.actualModel || session.model || 'default'}`,
      `- **Workspace**: \`${session.cwd}\``,
      `- **Exported**: ${new Date().toISOString()}`,
      '',
    ];

    if (ledgerService && ledger && (ledger.objective || ledger.steps.length > 0 || ledger.pinnedFacts.length > 0)) {
      lines.push(ledgerService.renderLedgerMarkdown(ledger, session), '---', '');
    } else {
      lines.push('---', '');
    }

    let assistantBuf = '';
    let currentTurnActor = session.harnessId;
    const flushAssistant = () => {
      if (assistantBuf.trim()) {
        lines.push(`### Assistant (${currentTurnActor})`, '', assistantBuf.trim(), '');
        assistantBuf = '';
      }
    };

    for (const ev of events) {
      if (ev.type === 'handoff.snapshot') {
        flushAssistant();
        const { driver, content } = ev.payload;
        lines.push(`### 上下文交接 · ${String(driver ?? '')}`, '',
          typeof content === 'string' ? content : JSON.stringify(content, null, 2), '');
        continue;
      }
      if (typeof ev.payload.harnessId === 'string') {
        const m =
          typeof ev.payload.actualModel === 'string' && ev.payload.actualModel
            ? ev.payload.actualModel
            : typeof ev.payload.model === 'string' && ev.payload.model
              ? ev.payload.model
              : '';
        currentTurnActor = m ? `${ev.payload.harnessId} · ${m}` : ev.payload.harnessId;
      }

      if (ev.type === 'session.harness_switched') {
        flushAssistant();
        lines.push(
          `> **Harness 切换**: \`${String(ev.payload.fromHarnessId)}\` → \`${String(ev.payload.toHarnessId)}\`（同步 ${String(ev.payload.unsyncedTurnCount ?? 0)} 轮增量上下文）`,
          '',
        );
      } else if (ev.type === 'message.user') {
        flushAssistant();
        lines.push('### User', '', String(ev.payload.text ?? ''), '');
      } else if (ev.type === 'message.assistant.delta') {
        assistantBuf += String(ev.payload.text ?? '');
      } else if (ev.type === 'message.assistant.completed') {
        const t = String(ev.payload.text ?? '');
        if (t.length >= assistantBuf.length) assistantBuf = t;
      } else if (ev.type === 'tool.call.started') {
        flushAssistant();
        lines.push(`> **Tool**: \`${String(ev.payload.toolName ?? 'tool')}\` — ${String(ev.payload.summary ?? '')}`, '');
      } else if (ev.type === 'turn.completed') {
        flushAssistant();
      }
    }
    flushAssistant();

    const safeTitle = session.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 48);
    return {
      filename: `${safeTitle || session.id}.md`,
      markdown: lines.join('\n'),
    };
  }

  // ── Turn Execution (Unified Multi-Harness + Context Bridge) ──────────

  getHarnessCommands(session: Session): HarnessCommandInfo[] {
    const service = this.pluginManager.host.get<NativeCommandsService>('native-commands');
    if (!service) return [];
    const source = session.nativeSessionId && this.store.getNativeHistory(session.id, session.nativeSessionId)?.source;
    const base: HarnessCommandInfo[] = service
      .list(session.harnessKind, source === 'agy_desktop')
      .map((cmd) => ({
        ...cmd,
        source: 'builtin' as const,
      }));
    const adapter = this.registry.get(session.harnessId);
    if (adapter instanceof AgyAdapter) {
      const seen = new Set(base.map((c) => c.command));
      for (const liveCmd of adapter.getAdvertisedCommands()) {
        if (!liveCmd.name || seen.has(liveCmd.name)) continue;
        seen.add(liveCmd.name);
        base.push({
          command: liveCmd.name,
          description: liveCmd.description ?? `AGY 原生命令 /${liveCmd.name}`,
          ...(liveCmd.argumentHint ? { argumentHint: liveCmd.argumentHint } : {}),
          source: 'native_advertised' as const,
        });
      }
    }
    return base;
  }

  private nativeActionReason(session: Session, command: RunHarnessCommandRequest['command']): string | undefined {
    if (!this.registry.get(session.harnessId)) return '当前 Harness 适配器不可用';
    if (!this.getHarnessCommands(session).some((entry) => entry.command === command)) return '当前 Harness 或会话来源未开放此命令';
    if (command === 'compact' && !session.nativeSessionId && session.harnessKind !== 'claude') return '此会话尚无可压缩的原生上下文';
  }

  listPluginActions(session: Session): SessionPluginAction[] {
    return this.pluginCapabilities?.listActions(session).map(({ plugin, action, granted }) => ({
      ...action, pluginId: plugin.id, pluginName: plugin.name,
      reason: session.status === 'archived' ? '会话已归档' : !granted ? '请在插件中心授权当前工作区'
        : action.kind === 'harness' ? this.nativeActionReason(session, action.nativeCommand) : undefined,
    })) ?? [];
  }

  getModelPluginTools(session: Session) {
    const router = this.getModelToolRouter(session.id);
    const tools = router?.list(session) ?? [];
    const count = tools.length;
    if (!count) return { count, status: 'none' as const };
    if (!this.registry.get(session.harnessId)?.pluginMcpTransport) return { count, status: 'unsupported' as const };
    const handleInfo = this.runtimeController?.getLiveHandleInfo(session.id, session.harnessId);
    if (!handleInfo || handleInfo.pluginToolKey !== this.pluginToolKey(router, tools)) return { count, status: 'next_turn' as const };
    if (!handleInfo.pluginToolLease) return { count, status: 'unsupported' as const };
    if (!this.pluginCapabilities?.isLeaseActive(handleInfo.pluginToolLease)) return { count, status: 'next_turn' as const };
    return { count, status: handleInfo.pluginToolLease.discovered ? 'connected' as const : 'configured' as const };
  }

  async runPluginAction(sessionId: string, req: RunPluginActionRequest): Promise<HarnessCommandResult> {
    return this.withSessionStartup(sessionId, async () => {
      const session = await this.getSessionAsync(sessionId);
      const capabilities = this.pluginCapabilities;
      if (!session || !capabilities) throw new Error('会话或插件动作服务不存在');
      if (session.harnessId !== req.harnessId) throw new Error('当前引擎已切换，请重试');
      if (session.status === 'archived') throw new Error('会话已归档');
      const provenance = mintAgyDispatchProvenance('plugin_automated', 'plugin', 'SessionManager.runPluginAction');
      const entry = capabilities.listActions(session).find(({ action, plugin }) =>
        action.command === req.command && (!req.pluginId || plugin.id === req.pluginId));
      if (entry) {
        if (!entry.granted) throw new Error('请在插件中心授权当前工作区');
        const { action, plugin } = entry;
        if (action.kind === 'program') return { output: capabilities.executeProgramAction(plugin, action, req.args), session };
        const unavailable = this.nativeActionReason(session, action.nativeCommand);
        if (unavailable) throw new Error(unavailable);
        if (action.args !== undefined && req.args.trim()) throw new Error(`请单独发送 /${action.command}，该动作使用插件配置的参数`);
        return this.executeHarnessCommand(sessionId, { command: action.nativeCommand, args: (action.args ?? req.args).trim(), harnessId: req.harnessId }, provenance);
      }
      const isolatedCmd = this.pluginManager.isolated?.listCommands().find(({ command, pluginId }) =>
        command === req.command && (!req.pluginId || pluginId === req.pluginId));
      if (!isolatedCmd) throw new Error('找不到已启用的插件动作');
      const result = await this.pluginManager.isolated!.runCommand(session, req.command, req.args, isolatedCmd.runId, isolatedCmd.pluginId);
      if (result.kind === 'message') return { output: result.text, session };
      if (result.kind === 'compose') return { output: result.text, session };
      if (result.kind === 'native') {
        const nativeCmd = result.command as RunHarnessCommandRequest['command'];
        const unavailable = this.nativeActionReason(session, nativeCmd);
        if (unavailable) throw new Error(unavailable);
        return this.executeHarnessCommand(sessionId, { command: nativeCmd, args: (result.args ?? '').trim(), harnessId: req.harnessId }, provenance);
      }
      return { output: '', session };
    });
  }

  async runHarnessCommand(
    sessionId: string, req: RunHarnessCommandRequest, provenance?: AgyDispatchProvenance,
  ): Promise<HarnessCommandResult> {
    return this.withSessionStartup(sessionId, () => this.executeHarnessCommand(sessionId, req, provenance));
  }

  private assertDispatchTarget(instanceId: string, fallbackKind: string, provenance?: AgyDispatchProvenance): void {
    const adapter = this.registry.get(instanceId);
    assertAgyConsumerProvenance({
      instanceId,
      driverId: adapter?.driverId ?? adapter?.kind ?? fallbackKind,
      profile: adapter instanceof AgyAdapter ? adapter.getProfile() : null,
    }, provenance);
  }

  private async executeHarnessCommand(
    sessionId: string, req: RunHarnessCommandRequest, provenance?: AgyDispatchProvenance,
  ): Promise<HarnessCommandResult> {
    const session = await this.getSessionAsync(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.harnessId !== req.harnessId) throw new Error('当前引擎已切换，请重试');
    if (!this.getHarnessCommands(session).some((entry) => entry.command === req.command)) {
      throw new Error('当前 Harness 或会话来源未开放此命令');
    }
    const busy = session.status === 'running' || session.status === 'awaiting_approval';
    const goalControl = session.harnessKind === 'codex' && req.command === 'goal'
      && ['', 'status', 'pause', 'clear'].includes(req.args);
    if ((busy && !goalControl) || session.status === 'archived') {
      throw new Error('请在会话空闲时运行原生命令');
    }
    const adapter = this.registry.get(session.harnessId);
    if (!adapter) throw new Error('当前 Harness 命令服务不可用');
    this.assertDispatchTarget(session.harnessId, session.harnessKind, provenance);
    const turnOpts = { dispatchProvenance: provenance };
    const tools = this.service<NativeCommandsService>('native-commands').tools;

    const result = async (output: string, turnId?: string): Promise<HarnessCommandResult> => ({
      output,
      turnId,
      session: (await this.getSessionAsync(sessionId)) ?? session,
    });
    const rawCommand = async (text: string) => {
      const { turnId } = await this.sendTurn(sessionId, text, undefined, { ...turnOpts, cliCommand: text });
      return result('', turnId);
    };
    const getHandle = async () => {
      const existing = this.runtimeController?.getLiveHandle(sessionId, session.harnessId);
      if (existing) return existing;
      return (await this.ensureLiveHandle(sessionId, session.harnessId, false)).handle;
    };
    const { command, args } = req;
    switch (command) {
      case 'model': {
        if (!args) {
          const catalog = selectedHarnessService<ModelCatalog>(this.pluginManager, modelCatalogContract, { sessionId: session.id });
          const info = catalog
            ? await catalog.listModels({ sessionId: session.id, harnessInstanceId: session.harnessId })
            : await this.registry.probeInstance(session.harnessId);
          const models = info?.models.map((model) => `${model.id} · ${model.displayName}`) ?? [];
          return result([`当前模型 ${session.model || session.actualModel || info?.defaultModelId || 'CLI 默认'}`, ...models].join('\n'));
        }
        if (!/^[a-z0-9][a-z0-9_.:/\[\]-]*$/i.test(args)) throw new Error('请输入一个有效的模型 ID');
        await this.updateSession(sessionId, { model: args === 'default' ? null : args, reasoningEffort: null });
        return result(`已选择 ${args === 'default' ? 'CLI 默认模型' : args}`);
      }
      case 'plan': {
        if (args === 'off') {
          if (session.permissionMode === 'plan') await this.updateSession(sessionId, { permissionMode: 'manual' });
          return result('已退出计划模式');
        }
        await this.updateSession(sessionId, { permissionMode: 'plan' });
        const turn = args ? await this.sendTurn(sessionId, args, undefined, turnOpts) : undefined;
        return result('已启用计划模式', turn?.turnId);
      }
      case 'compact': {
        if (args && session.harnessKind !== 'claude') throw new Error('请使用 /compact');
        if (!session.nativeSessionId && session.harnessKind !== 'claude') throw new Error('此会话尚无可压缩的原生上下文');
        return rawCommand(args ? `/compact ${args}` : '/compact');
      }
      case 'usage': {
        if (args) throw new Error('用法 /usage');
        return session.harnessKind === 'claude' ? rawCommand('/usage')
          : result(await tools.getUsage(session));
      }
      case 'goal': {
        if (session.harnessKind === 'codex') {
          const handle = await getHandle();
          if (!handle.runNativeCommand) throw new Error('此 Codex 适配器未提供目标接口');
          const output = await handle.runNativeCommand('goal', args);
          return result(output);
        }
        if (session.harnessKind === 'agy' && !args) throw new Error('用法 /goal <目标>');
        return rawCommand(args ? `/goal ${args}` : '/goal');
      }
      case 'plugin': {
        if (args === 'reload' && session.harnessKind === 'claude') return rawCommand('/reload-plugins');
        const output = await tools.runPluginCommand(session, args);
        if (args.startsWith('install ')) {
          await this.runtimeController?.disposeLiveHandle(sessionId, session.harnessId);
        }
        return result(output);
      }
      case 'skills':
      case 'skill': {
        const skills = session.harnessKind === 'agy' ? await tools.listAgySkillsForSession(session)
          : await (await getHandle()).listSkills?.() ?? [];
        const availableSkills = skills.filter((skill) => skill.enabled !== false);
        if (command === 'skills') {
          if (args) throw new Error('用法 /skills');
          return result(availableSkills.map((skill) =>
            `${skill.name}${skill.description ? ` · ${skill.description}` : ''}`).join('\n') || '未发现可调用技能');
        }
        const [name = '', ...words] = args.split(/\s+/);
        if (!/^[a-z0-9][a-z0-9_.:-]*$/i.test(name)) throw new Error('用法 /skill <名称> [参数]');
        const skill = availableSkills.find((entry) => entry.name === name);
        if (!skill) throw new Error(`未找到技能 ${name}，可用 /skills 查看列表`);
        const skillArgs = words.join(' ');
        if (session.harnessKind === 'codex') {
          if (!skill.path) throw new Error('Codex 未返回技能路径');
          const { turnId } = await this.sendTurn(sessionId, skillArgs || `调用技能 ${name}`, undefined, {
            ...turnOpts,
            nativeSkill: { name, path: skill.path },
          });
          return result('', turnId);
        }
        return rawCommand(`/${name}${skillArgs ? ` ${skillArgs}` : ''}`);
      }
    }
  }

  withIdleNativeHandle<T>(
    binding: RuntimeBinding, handle: AdapterSessionHandle, apply: () => Promise<T>,
  ): Promise<T> {
    const runtimeProvider = resolveSessionRuntimeProvider(this.pluginManager, { sessionId: binding.sessionId });
    if (runtimeProvider.instanceId !== SESSION_RUNTIME_DEFAULT_PLUGIN_ID || !this.runtimeController?.isActive()) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', '当前会话未绑定默认运行时插件，无法附着 AGY 原生句柄');
    }
    return this.withSessionStartup(binding.sessionId, () => {
      const session = this.store.getSession(binding.sessionId);
      if (
        session?.status !== 'idle' ||
        session.harnessId !== binding.instanceId ||
        !this.runtimeController?.hasLiveHandle(binding.sessionId, binding.instanceId, handle)
      ) {
        throw new Error('The bound AGY session is no longer idle and attached');
      }
      return apply();
    });
  }

  async sendTurn(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    turnOpts?: TurnOptions,
  ): Promise<{
    turnId: string;
    runId?: string;
    requestId?: string;
    deduplicated?: boolean;
    dataInstanceId?: string;
    runtimeInstanceId?: string;
  }> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, sessionId);
    if (!found) throw new Error(`Session not found: ${sessionId}`);
    const targetHarnessId = found.session.status === 'running'
      ? found.session.harnessId
      : turnOpts?.harnessId ?? found.session.harnessId;
    this.assertDispatchTarget(targetHarnessId, found.session.harnessKind, turnOpts?.dispatchProvenance);
    const runtimeProvider = resolveSessionRuntimeProvider(this.pluginManager, {
      sessionId,
      workspaceId: found.session.workspaceId,
    });
    const req: import('@harnessmate/plugin-api').SendTurnRuntimeRequest = {
      sessionId,
      requestId: turnOpts?.requestId,
      text,
      attachments: attachments as import('@harnessmate/plugin-api').PublicDriverTurnInput['attachments'],
      harnessId: turnOpts?.harnessId,
      model: turnOpts?.model,
      turnOptions: turnOpts?.turnOptions as Record<string, string | number | boolean> | undefined,
      omitHandoff: turnOpts?.omitHandoff,
      literalText: turnOpts?.literalText,
      mode: turnOpts?.mode,
      terminalContexts: turnOpts?.terminalContexts as import('@harnessmate/plugin-api').SendTurnRuntimeRequest['terminalContexts'],
      cliCommand: turnOpts?.cliCommand,
      nativeSkill: turnOpts?.nativeSkill,
    };
    if (turnOpts?.expectedNativeHandle || turnOpts?.verifyNativeDispatch || turnOpts?.dispatchProvenance) {
      if (runtimeProvider.instanceId === SESSION_RUNTIME_DEFAULT_PLUGIN_ID && this.runtimeController?.isActive()) {
        const receipt = await this.runtimeController.sendTurnWithLegacyOptions(req, {
          dispatchProvenance: turnOpts.dispatchProvenance,
          expectedNativeHandle: turnOpts.expectedNativeHandle,
          verifyNativeDispatch: turnOpts.verifyNativeDispatch,
        });
        return {
          turnId: receipt.turnId,
          runId: receipt.runId,
          requestId: receipt.requestId,
          deduplicated: receipt.disposition === 'reused',
          dataInstanceId: receipt.dataInstanceId,
          runtimeInstanceId: receipt.runtimeInstanceId,
        };
      }
      if (turnOpts?.expectedNativeHandle || turnOpts?.verifyNativeDispatch) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'AGY 原生直发要求默认会话运行插件处于启用状态');
      }
    }
    const receipt = unwrapPeerServiceResult(await runtimeProvider.service.sendTurn(req));
    return {
      turnId: receipt.turnId,
      runId: receipt.runId,
      requestId: receipt.requestId,
      deduplicated: receipt.disposition === 'reused',
      dataInstanceId: receipt.dataInstanceId,
      runtimeInstanceId: receipt.runtimeInstanceId,
    };
  }

  async previewTurnSuggestionAsync(sessionId: string, text: string, attachments?: Attachment[]) {
    const session = await this.getSessionAsync(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return this.pluginManager.suggestBeforeTurn({ sessionId, harnessId: session.harnessId, cwd: session.cwd, text, attachments });
  }

  previewTurnSuggestion(sessionId: string, text: string, attachments?: Attachment[]) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return this.pluginManager.suggestBeforeTurn({ sessionId, harnessId: session.harnessId, cwd: session.cwd, text, attachments });
  }

  private async startTurn(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    turnOpts?: TurnOptions,
    native?: Pick<TurnInput, 'cliCommand' | 'nativeSkill'>,
  ): Promise<{ turnId: string }> {
    let session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const targetId = session.status === 'running' ? session.harnessId : turnOpts?.harnessId ?? session.harnessId;
    this.assertDispatchTarget(targetId, session.harnessKind, turnOpts?.dispatchProvenance);

    const expectedNativeHandle = turnOpts?.expectedNativeHandle;
    turnOpts?.verifyNativeDispatch?.();
    if (expectedNativeHandle && (
      session.status !== 'idle' ||
      this.liveHandles.get(this.handleKey(sessionId, session.harnessId))?.handle !== expectedNativeHandle
    )) {
      throw new Error('The bound AGY session is no longer idle and attached');
    }

    if (session.status === 'awaiting_approval') {
      throw new Error('Session already has a pending approval blocking the turn.');
    }
    if (session.status === 'running') {
      const adapter = this.registry.get(session.harnessId);
      const liveEntry = this.liveHandles.get(this.handleKey(sessionId, session.harnessId));
      const canSteer = Boolean(
        !native &&
          adapter?.capabilitiesV2?.supportsActiveSteering &&
          liveEntry?.handle.steerTurn &&
          this.activeTurnMeta.has(sessionId),
      );
      if (!canSteer || !liveEntry?.handle.steerTurn) {
        throw new Error('Session already has an active turn in progress.');
      }
      const turnId = this.activeTurnMeta.get(sessionId)!.turnId;
      this.emitCanonical(
        sessionId,
        'message.user',
        {
          text,
          steering: true,
          harnessId: session.harnessId,
          harnessKind: session.harnessKind,
          model: session.model,
          actualModel: session.actualModel ?? null,
          attachments: (attachments ?? []).map((a) => ({
            id: a.id,
            kind: a.kind,
            name: a.name,
            relativePath: a.relativePath,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            previewUrl: a.previewUrl,
          })),
        },
        turnId,
      );
      await liveEntry.handle.steerTurn({
        turnId,
        text,
        attachments,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        permissionMode: session.permissionMode,
      });
      return { turnId };
    }

    // Optional per-turn seamless harness/model override (e.g. from Mobile or API)
    if (turnOpts?.harnessId && turnOpts.harnessId !== session.harnessId) {
      const switched = await this.switchHarnessInternal(sessionId, {
        targetHarnessId: turnOpts.harnessId,
        targetModel: turnOpts.model,
      });
      session = switched.session;
    } else if (turnOpts?.model !== undefined && turnOpts.model !== session.model) {
      session = await this.updateSession(sessionId, { model: turnOpts.model });
    }

    const turnId = `turn_${crypto.randomBytes(5).toString('hex')}`;
    const preTurnSeq = session.lastSeq;

    const { text: expandedText, expandedCommand } = native || turnOpts?.literalText || turnOpts?.mode
      ? { text, expandedCommand: undefined } : this.pluginManager.expandSlashCommand(text);
    const baseEffectiveText = !native && turnOpts?.mode === 'plugin_development'
      ? `${expandedText}\n\n${pluginDevelopmentBrief}` : expandedText;
    const terminalChips = !native && turnOpts?.terminalContexts?.length
      ? turnOpts.terminalContexts
      : undefined;
    const effectiveText = terminalChips
      ? `${baseEffectiveText}\n\n${this.formatTerminalContextsBlock(terminalChips)}`
      : baseEffectiveText;
    const compactTerminalChips = terminalChips?.map((c) => ({
      id: c.id,
      terminalId: c.terminalId,
      terminalTitle: c.terminalTitle,
      cwd: c.cwd,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      truncated: c.truncated,
      exitCode: c.exitCode ?? null,
    }));

    // Auto-title session from first user prompt if still default
    if (!native && session.lastSeq <= 2 && session.title.includes('·')) {
      const compactTitle = text.replace(/\s+/g, ' ').trim().slice(0, 64);
      if (compactTitle) {
        session = this.store.updateSession(sessionId, { title: compactTitle }) ?? session;
      }
    }

    // Track per-turn attribution and durable session run before emitting events
    const runId = `run_${crypto.randomBytes(6).toString('hex')}`;
    this.activeTurnMeta.set(sessionId, {
      runId,
      turnId,
      harnessId: session.harnessId,
      harnessKind: session.harnessKind,
      model: session.model,
      actualModel: session.actualModel ?? null,
      advanceWatermark: !native?.cliCommand && !turnOpts?.omitHandoff,
      reloadHandle: session.harnessKind === 'agy' && Boolean(native?.cliCommand),
      maintenance: ['/compact', '/usage', '/reload-plugins'].includes(native?.cliCommand?.split(/\s+/)[0] ?? ''),
    });
    this.store.startSessionRun({
      runId,
      sessionId,
      turnId,
      instanceId: session.harnessId,
      driverId: session.harnessKind,
      model: session.model,
      status: 'running',
      startedAt: Date.now(),
    });

    const userEvent = this.emitCanonical(
      sessionId,
      'message.user',
      {
        text,
        ...(effectiveText !== text ? { sentText: effectiveText } : {}),
        ...(turnOpts?.mode ? { mode: turnOpts.mode } : {}),
        ...(compactTerminalChips ? { terminalContexts: compactTerminalChips } : {}),
        expandedCommand: expandedCommand ?? null,
        harnessId: session.harnessId,
        harnessKind: session.harnessKind,
        model: session.model,
        actualModel: session.actualModel ?? null,
        attachments: (attachments ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          name: a.name,
          relativePath: a.relativePath,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          previewUrl: a.previewUrl,
        })),
      },
      turnId,
    );
    if (compactTerminalChips) {
      this.emitCanonical(
        sessionId,
        'terminal.context_attached',
        { terminalContexts: compactTerminalChips, count: compactTerminalChips.length },
        turnId,
      );
    }
    const userItemId = `${turnId}:user`;
    this.store.upsertTurnItem({
      itemId: userItemId,
      schemaVersion: 2,
      sessionId,
      turnId,
      seq: userEvent.seq,
      instanceId: session.harnessId,
      driverId: session.harnessKind,
      blockType: 'user_message',
      status: 'completed',
      title: 'User',
      textBody: text,
      payload: {
        expandedCommand: expandedCommand ?? null,
        ...(compactTerminalChips ? { terminalContexts: compactTerminalChips } : {}),
      },
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: userEvent.createdAt,
      updatedAt: userEvent.createdAt,
    });
    this.setSessionStatus(sessionId, 'running');

    // Capture turn_pre hidden Git checkpoint (non-blocking, timeout-protected, skips non-Git)
    if (!native?.cliCommand) {
      const turnMeta = this.activeTurnMeta.get(sessionId);
      if (turnMeta) {
        turnMeta.turnSeq = userEvent.seq;
      }
      let ckptProvider;
      try {
        ckptProvider = resolveGitCheckpointProvider(this.pluginManager, {
          sessionId,
          workspaceId: session.workspaceId,
        }).provider;
      } catch {
        ckptProvider = undefined;
      }
      if (ckptProvider) {
        try {
          const preRecord = await ckptProvider.capture({
            sessionId,
            cwd: session.cwd,
            turnSeq: userEvent.seq,
            phase: 'turn_pre',
          });
          if (preRecord && turnMeta) {
            turnMeta.preTurnTreeSha = preRecord.treeSha;
            if (preRecord.skippedLargeFiles.length > 0) {
              this.emitCanonical(
                sessionId,
                'diagnostic.log',
                {
                  level: 'warn',
                  stream: 'protocol',
                  message: `[Checkpoints] 跳过 ${preRecord.skippedLargeFiles.length} 个超大未追踪文件（>10MB 或总计 >100MB）：${preRecord.skippedLargeFiles.slice(0, 5).join(', ')}`,
                },
                turnId,
              );
            }
          }
        } catch {
          // Never block turn start if checkpoint capture fails
        }
      }
    }

    try {
      // Compile incremental context delta if Context Bridge plugin is active
      this.attachActiveCompressorHooks();
      const compiler = this.pluginManager.host.get<ContextCompiler>('handoff');
      const binding = this.store.getSessionBinding(sessionId, session.harnessId);
      if (!compiler?.options.autoAttach && (session.participatingHarnesses?.length ?? 0) > 1) {
        const meta = this.activeTurnMeta.get(sessionId);
        if (meta) meta.advanceWatermark = false;
      }
      let compiled = compiler?.options.autoAttach && !turnOpts?.omitHandoff
        ? await compiler.compile({
            session,
            targetHarnessId: session.harnessId,
            targetHarnessKind: session.harnessKind,
            binding,
            upToSeq: preTurnSeq,
            excludeTurnId: turnId,
          })
        : null;

      const entry = expectedNativeHandle
        ? this.liveHandles.get(this.handleKey(sessionId, session.harnessId))
        : await this.ensureLiveHandle(
            sessionId,
            session.harnessId,
            Boolean(compiled?.syncNeeded && !native?.cliCommand),
            true,
          );
      if (!entry || (expectedNativeHandle && entry.handle !== expectedNativeHandle)) {
        throw new Error('The bound AGY connection changed before dispatch');
      }
      const currentBinding = this.store.getSessionBinding(sessionId, session.harnessId);
      if (compiler?.options.autoAttach && !turnOpts?.omitHandoff && binding?.nativeSessionId &&
        currentBinding?.nativeSessionId !== binding.nativeSessionId) {
        compiled = await compiler.compile({
          session, targetHarnessId: session.harnessId, targetHarnessKind: session.harnessKind,
          binding: currentBinding, upToSeq: preTurnSeq, excludeTurnId: turnId,
        });
      }
      if (native?.cliCommand && binding?.nativeSessionId && binding.nativeSessionId === currentBinding?.nativeSessionId) {
        const meta = this.activeTurnMeta.get(sessionId);
        if (meta) meta.advanceWatermark = !compiled?.syncNeeded;
      }

      turnOpts?.verifyNativeDispatch?.();
      const finalDriver = await dispatchTurn(entry.handle, { id: session.harnessId, kind: session.harnessKind }, {
        turnId,
        text: effectiveText,
        attachments,
        ...(expectedNativeHandle ? {} : {
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          permissionMode: session.permissionMode,
        }),
        ...(turnOpts?.turnOptions ? { turnOptions: turnOpts.turnOptions } : {}),
        ...native,
      }, compiled, (type, payload) => { this.emitCanonical(sessionId, type, payload, turnId); });

      // Record that target harness has now received context up to preTurnSeq
      if (compiled?.syncNeeded && !native?.cliCommand) {
        this.store.upsertSessionBinding({
          sessionId,
          harnessId: session.harnessId,
          harnessKind: session.harnessKind,
          nativeSessionId: entry.handle.nativeSessionId ?? binding?.nativeSessionId ?? null,
          lastModel: session.model,
          lastActualModel: session.actualModel ?? null,
          lastEffort: session.reasoningEffort,
          syncedUpToSeq: Math.max(preTurnSeq,
            this.store.getSessionBinding(sessionId, session.harnessId)?.syncedUpToSeq ?? 0),
          driverUsed: finalDriver,
          updatedAt: Date.now(),
        });
        this.emitCanonical(
          sessionId,
          'diagnostic.log',
          {
            level: 'info',
            stream: 'protocol',
            message: `[ContextBridge] Synced ${compiled.preview.unsyncedTurnCount} un-synced turns (~${compiled.preview.estimatedTokens} tokens) into ${session.harnessId} via ${finalDriver}`,
          },
          turnId,
        );
      }

      return { turnId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deltaCoalescer.flushSession(sessionId);
      const meta = this.activeTurnMeta.get(sessionId);
      if (meta) {
        this.store.finishSessionRun(meta.runId, { status: 'failed', failureClass: 'dispatch_error' });
      }
      this.store.settleRunningTurnItems(sessionId, 'interrupted');
      this.activeTurnMeta.delete(sessionId);
      this.emitCanonical(
        sessionId,
        'turn.failed',
        {
          message,
          harnessId: meta?.harnessId ?? session.harnessId,
          harnessKind: meta?.harnessKind ?? session.harnessKind,
          model: meta?.model ?? session.model,
        },
        turnId,
      );
      this.setSessionStatus(sessionId, 'error');
      throw err;
    }
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.pluginManager.ensureBootstrapped();
    const found = await findSessionWithProvider(this.pluginManager, sessionId);
    if (!found) throw new Error(`Session not found: ${sessionId}`);
    const runtimeProvider = resolveSessionRuntimeProvider(this.pluginManager, {
      sessionId,
      workspaceId: found.session.workspaceId,
    });
    unwrapPeerServiceResult(
      await runtimeProvider.service.interrupt({
        sessionId,
        reason: '用户手动中断',
      }),
    );
  }

  // ── Atomic Approval, Question & Secret Broker ────────────────────────

  async resolveRuntimeRequest(
    approvalId: string,
    req: ResolveApprovalRequest,
    resolvedBy: 'desktop' | 'mobile',
  ): Promise<{ updated: boolean; conflict: boolean; approval: ApprovalRequest }> {
    const existing = this.store.getApproval(approvalId);
    if (!existing) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    // Unified CAS check when native permission routing owns a receipt for this approval
    let nativeClaimedReceiptId: string | null = null;
    if (
      this.nativeRegistry?.getFeatureFlags().enabled &&
      this.nativeRegistry?.getFeatureFlags().nativePermissions &&
      this.nativeRegistry.getSchemaStatus().compatible
    ) {
      const existingNativeReceipt =
        this.nativeRegistry.persistence.getApprovalReceiptByApprovalId(approvalId);
      if (existingNativeReceipt && existingNativeReceipt.sessionId === existing.sessionId) {
        const activeBinding = this.nativeRegistry.getActiveBinding(existing.sessionId);
        if (!activeBinding) {
          return { updated: false, conflict: true, approval: existing };
        }
        const permissionPort = this.nativeRegistry.getPermissionPort();
        if (permissionPort?.resolveLegacyWithCas) {
          const outcome = await permissionPort.resolveLegacyWithCas({
            binding: activeBinding,
            approvalId,
            request: req,
            resolvedBy,
          });
          const approval = this.store.getApproval(approvalId) ?? existing;
          return { updated: !outcome.conflict && approval.status !== 'pending', conflict: outcome.conflict, approval };
        }
        const cas = this.nativeRegistry.persistence.claimApprovalReceiptCas({
          approvalId,
          expectedGeneration: activeBinding.generation,
          expectedSessionId: existing.sessionId,
        });
        if (!cas.claimed || !cas.receipt) {
          return { updated: false, conflict: true, approval: existing };
        }
        nativeClaimedReceiptId = cas.receipt.receiptId;
      }
    }

    const finalizeNativeReceipt = (written: boolean) => {
      if (!nativeClaimedReceiptId || !this.nativeRegistry) return;
      try {
        this.nativeRegistry.persistence.transitionApprovalReceiptState(
          nativeClaimedReceiptId,
          ['claimed'],
          written ? 'response_written' : 'connection_lost',
          { resolvedBy },
        );
      } catch {
        // ignore secondary receipt transition errors
      }
    };

    const kind: RuntimeRequestKind = existing.kind ?? 'command_approval';

    // Handle secret_request: STRICT ZERO-DISK / ZERO-LOG / ZERO-ECHO PIPELINE
    if (kind === 'secret_request') {
      const denied = req.decision === 'deny';
      const secretPayload = !denied ? req.secretValue : undefined;
      if (!denied && (!secretPayload || !secretPayload.length)) {
        throw new Error('请提供凭据内容或选择拒绝');
      }
      const { updated, approval } = this.store.resolveApprovalIfPending(
        approvalId,
        denied ? 'deny' : 'allow_once',
        resolvedBy,
        undefined, // NEVER persist secret or comment containing secret to SQLite
        {
          statusOverride: denied ? 'denied' : 'resolved',
          secretProvided: !denied,
        },
      );
      if (!approval) throw new Error(`Approval not found: ${approvalId}`);
      if (!updated) {
        return { updated: false, conflict: true, approval };
      }
      this.clearApprovalTimer(approval.id);

      // Deliver secret directly to live adapter memory/stdin; NEVER emit or log plaintext
      await this.runtimeController?.resolveApprovalOnLiveHandle(
        approval.sessionId,
        approval.nativeRequestId,
        denied ? 'deny' : 'allow_once',
        denied ? '用户拒绝提供凭据' : req.comment,
        secretPayload,
      );

      const ev = this.emitCanonical(approval.sessionId, 'approval.resolved', {
        approvalId: approval.id,
        kind: 'secret_request',
        decision: approval.decision ?? (denied ? 'deny' : 'allow_once'),
        status: approval.status,
        resolvedBy,
        secretProvided: !denied,
        receiptText: denied ? '已拒绝提供凭据' : SECRET_RECEIPT_LABEL,
      });
      this.emitCanonical(approval.sessionId, 'runtime_request.updated', {
        request: approval,
        receiptText: denied ? '已拒绝提供凭据' : SECRET_RECEIPT_LABEL,
      });
      this.recordRuntimeRequestReceipt(approval, ev.seq, ev.createdAt);
      this.resumeSessionAfterApprovalIfClear(approval.sessionId);
      return { updated: true, conflict: false, approval };
    }

    // Handle user_question
    if (kind === 'user_question') {
      const denied = req.decision === 'deny';
      const answer = req.questionAnswer ?? (req.comment ? { freeText: req.comment } : undefined);
      const { updated, approval } = this.store.resolveApprovalIfPending(
        approvalId,
        denied ? 'deny' : 'allow_once',
        resolvedBy,
        req.comment,
        {
          statusOverride: denied ? 'denied' : 'resolved',
          questionAnswer: answer ?? null,
        },
      );
      if (!approval) throw new Error(`Approval not found: ${approvalId}`);
      if (!updated) {
        return { updated: false, conflict: true, approval };
      }
      this.clearApprovalTimer(approval.id);

      const formattedAnswer = answer
        ? [
            answer.selectedOptionIds?.length ? `selected: ${answer.selectedOptionIds.join(', ')}` : '',
            answer.freeText?.trim() ? answer.freeText.trim() : '',
          ]
            .filter(Boolean)
            .join(' | ')
        : req.comment;

      const written = (await this.runtimeController?.resolveApprovalOnLiveHandle(
        approval.sessionId,
        approval.nativeRequestId,
        denied ? 'deny' : 'allow_once',
        formattedAnswer,
        undefined,
        !denied ? answer : undefined,
      )) ?? false;
      finalizeNativeReceipt(written);

      const ev = this.emitCanonical(approval.sessionId, 'approval.resolved', {
        approvalId: approval.id,
        kind: 'user_question',
        decision: approval.decision ?? (denied ? 'deny' : 'allow_once'),
        status: approval.status,
        resolvedBy,
        questionAnswer: answer ?? null,
        comment: req.comment ?? null,
      });
      this.emitCanonical(approval.sessionId, 'runtime_request.updated', { request: approval });
      this.recordRuntimeRequestReceipt(approval, ev.seq, ev.createdAt);
      this.resumeSessionAfterApprovalIfClear(approval.sessionId);
      return { updated: true, conflict: false, approval };
    }

    // Standard approval: command_approval / file_change_approval / mcp_tool_approval
    const decision = req.decision;
    if (!decision) {
      throw new Error('缺少审批决策 decision');
    }
    const { updated, approval } = this.store.resolveApprovalIfPending(
      approvalId,
      decision,
      resolvedBy,
      req.comment,
    );
    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }
    if (!updated) {
      return { updated: false, conflict: true, approval };
    }
    this.clearApprovalTimer(approval.id);

    const ev = this.emitCanonical(approval.sessionId, 'approval.resolved', {
      approvalId: approval.id,
      kind,
      decision,
      status: approval.status,
      resolvedBy,
      comment: req.comment ?? null,
    });
    this.emitCanonical(approval.sessionId, 'runtime_request.updated', { request: approval });
    this.recordRuntimeRequestReceipt(approval, ev.seq, ev.createdAt);

    // Deliver approval to whichever warm handle in this session owns nativeRequestId
    const deliveredToLiveHandle = (await this.runtimeController?.resolveApprovalOnLiveHandle(
      approval.sessionId,
      approval.nativeRequestId,
      decision,
      req.comment,
    )) ?? false;
    finalizeNativeReceipt(deliveredToLiveHandle);

    this.resumeSessionAfterApprovalIfClear(approval.sessionId);
    return { updated: true, conflict: false, approval };
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: 'desktop' | 'mobile' | 'auto',
    comment?: string,
  ): Promise<ApprovalRequest> {
    // Enforce human-origin channel: map legacy 'auto' only if directly invoked internally, never from plugins
    const actor: 'desktop' | 'mobile' = resolvedBy === 'mobile' ? 'mobile' : 'desktop';
    const { approval } = await this.resolveRuntimeRequest(
      approvalId,
      { decision, comment, resolvedBy: actor },
      actor,
    );
    return approval;
  }

  private recordRuntimeRequestReceipt(approval: ApprovalRequest, seq: number, createdAt: number): void {
    const session = this.store.getSession(approval.sessionId);
    if (!session) return;
    const receipt = this.getApprovalCenter().buildReceiptSummary(approval);
    this.store.upsertTurnItem({
      itemId: `rtreq:${approval.id}`,
      schemaVersion: 2,
      sessionId: approval.sessionId,
      turnId: this.runtimeController?.getActiveTurnId(approval.sessionId) ?? `rtreq_${seq}`,
      seq,
      instanceId: approval.instanceId ?? session.harnessId,
      driverId: session.harnessKind,
      blockType: 'runtime_request',
      status: approval.status === 'cancelled' || approval.status === 'expired' ? 'cancelled' : 'completed',
      title: receipt.title,
      textBody: receipt.textBody,
      payload: receipt.payload,
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: approval.createdAt,
      updatedAt: createdAt,
    });
  }

  mirrorNativeApproval(approval: ApprovalRequest): void {
    this.store.createApproval(approval);
    const session = this.store.getSession(approval.sessionId);
    if (!session) return;
    const turnId = this.runtimeController?.getActiveTurnId(session.id);
    this.runtimeController?.flushSessionDeltas(session.id);
    this.setSessionStatus(session.id, 'awaiting_approval');
    this.emitCanonical(session.id, 'approval.requested', { approval }, turnId);
    this.emitCanonical(session.id, 'runtime_request.updated', { request: approval }, turnId);
    this.getActiveOrchestrator()?.handleChildApprovalRequested(session.id, approval.id, approval.toolName);
    this.eventBus.publishAttention({
      kind: 'approval_needed',
      sessionId: session.id,
      sessionTitle: session.title,
      harnessId: approval.instanceId ?? session.harnessId,
      summary: approval.summary,
      approvalId: approval.id,
      timestamp: Date.now(),
    });
  }

  syncNativeApproval({
    approvalId, status, decision, resolvedBy, comment,
  }: Parameters<NonNullable<import('../harnesses/agy/native/requests/types.js').NativeApprovalCenterBridge['syncResolvedApproval']>>[0]): void {
    const updated = status === 'expired'
      ? this.store.expireApprovalIfPending(approvalId)
      : this.store.resolveApprovalIfPending(
          approvalId, decision ?? 'deny', resolvedBy ?? 'auto', comment ?? undefined, { statusOverride: status },
        ).updated;
    const approval = updated ? this.store.getApproval(approvalId) : null;
    if (!approval) return;
    const event = this.emitCanonical(approval.sessionId, 'approval.resolved', {
      approvalId, status: approval.status, decision: approval.decision, resolvedBy: approval.resolvedBy,
    });
    this.emitCanonical(approval.sessionId, 'runtime_request.updated', { request: approval });
    this.recordRuntimeRequestReceipt(approval, event.seq, event.createdAt);
    this.resumeSessionAfterApprovalIfClear(approval.sessionId);
  }

  private resumeSessionAfterApprovalIfClear(sessionId: string): void {
    const remaining = this.store.listPendingApprovals(sessionId);
    if (remaining.length === 0) {
      const sess = this.store.getSession(sessionId);
      if (sess && sess.status === 'awaiting_approval') {
        this.setSessionStatus(sessionId, this.runtimeController?.hasActiveTurn(sessionId) ? 'running' : 'idle');
      }
      this.getActiveOrchestrator()?.handleChildApprovalResolved(sessionId);
    }
  }

  private cancelSessionApprovals(sessionId: string, reason = '会话中断'): void {
    const cancelled = this.store.cancelPendingApprovals(sessionId);
    for (const approval of cancelled) {
      this.clearApprovalTimer(approval.id);
      const ev = this.emitCanonical(approval.sessionId, 'approval.resolved', {
        approvalId: approval.id,
        kind: approval.kind ?? 'command_approval',
        status: 'cancelled',
        resolvedAt: approval.resolvedAt,
        comment: reason,
      });
      this.emitCanonical(approval.sessionId, 'runtime_request.updated', { request: approval });
      this.recordRuntimeRequestReceipt(approval, ev.seq, ev.createdAt);
      void this.runtimeController?.resolveApprovalOnLiveHandle(
        approval.sessionId,
        approval.nativeRequestId,
        'deny',
        reason,
      ).catch(() => {});
    }
    this.resumeSessionAfterApprovalIfClear(sessionId);
  }

  private clearApprovalTimer(id: string): void {
    clearTimeout(this.approvalTimers.get(id));
    this.approvalTimers.delete(id);
  }

  private publishExpiredApproval(approval: ApprovalRequest): void {
    this.emitCanonical(approval.sessionId, 'approval.resolved', {
      approvalId: approval.id, status: 'expired', resolvedAt: approval.resolvedAt,
    });
  }

  private expireApproval(approval: ApprovalRequest): void {
    this.clearApprovalTimer(approval.id);
    if (!this.store.expireApprovalIfPending(approval.id)) return;
    this.publishExpiredApproval({ ...approval, resolvedAt: Date.now() });
    void this.runtimeController?.resolveApprovalOnLiveHandle(
      approval.sessionId,
      approval.nativeRequestId,
      'deny',
      '审批已过期',
    ).catch(() => {});
    if (this.store.getSession(approval.sessionId)?.status === 'awaiting_approval' &&
        this.store.listPendingApprovals(approval.sessionId).length === 0) {
      this.setSessionStatus(
        approval.sessionId,
        this.runtimeController?.hasActiveTurn(approval.sessionId) ? 'running' : 'idle',
      );
    }
  }

  private expireSessionApprovals(sessionId?: string): void {
    for (const approval of this.store.listPendingApprovals(sessionId)) this.expireApproval(approval);
  }

  async shutdown(): Promise<void> {
    await this.terminalWorkspace?.disposeAll();
    const runtimeProviders = this.pluginManager.host.listServiceProviders(PEER_CONTRACTS.sessionRuntime);
    for (const prov of runtimeProviders) {
      if (this.pluginManager.isInstanceKnownDisabled(prov.instanceId)) continue;
      const svc = this.pluginManager.host.getServiceByInstance<
        import('@harnessmate/plugin-api').SessionRuntimeServiceV1
      >(prov.instanceId, PEER_CONTRACTS.sessionRuntime);
      if (svc) {
        await svc.drainAndStop({ reason: 'daemon_shutdown' }).catch(() => {});
      }
    }
    if (!this.pluginManager.isInstanceKnownDisabled(SESSION_DATA_DEFAULT_PLUGIN_ID)) {
      this.store.settleRunningTurnItems(undefined, 'interrupted');
      this.expireSessionApprovals();
    }
  }

  // ── Warm Multi-Handle Runtime Pool ───────────────────────────────────

  private getModelToolRouter(sessionId: string) {
    const router = selectedHarnessService<ModelToolRouter>(this.pluginManager, modelToolsContract, { sessionId });
    // Transport leases hold a callback to the local adapter generation.
    return typeof router?.generation === 'string' ? router : undefined;
  }

  private pluginToolKey(router: ModelToolRouter | undefined, tools: ReturnType<PluginCapabilities['getTools']>): string {
    const toolKey = tools.map((tool) => tool.kind === 'isolated'
      ? `${tool.name}:${tool.permission.digest}:${tool.runId}`
      : `${tool.name}:${tool.permission.digest}`).join(',');
    return router ? `${router.instanceId}:${router.generation}:${toolKey}` : '';
  }

  private async ensureLiveHandle(
    sessionId: string,
    harnessId: string,
    handoffContinuity: boolean,
    refreshPluginTools = false,
  ): Promise<LiveHandleEntry> {
    const key = this.handleKey(sessionId, harnessId);
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const adapter = this.registry.get(harnessId);
    if (!adapter) throw new Error(`Harness adapter not found: ${harnessId}`);
    const router = adapter.pluginMcpTransport ? this.getModelToolRouter(sessionId) : undefined;
    const tools = router?.list(session) ?? [];
    const pluginToolKey = this.pluginToolKey(router, tools);
    const existing = this.liveHandles.get(key);
    if (existing?.adapter === adapter && (!refreshPluginTools || existing.pluginToolKey === pluginToolKey)) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing) await this.disposeLiveHandle(sessionId, harnessId);

    const binding = this.store.getSessionBinding(sessionId, harnessId);
    const nativeSessionId =
      binding?.nativeSessionId ??
      (session.harnessId === harnessId ? session.nativeSessionId : null);
    const nativeHistory = nativeSessionId ? this.store.getNativeHistory(sessionId, nativeSessionId) : undefined;

    // Evict oldest idle handle if warm pool is full
    await this.evictWarmPoolIfNeeded(sessionId);

    // Optional AGY Native Runtime binding + generation + DI hooks:
    // - Strictly ZERO native DB writes or runtime hooks when feature gate is OFF (R4).
    // - When enabled, every newly spawned handle advances generation if a prior binding existed
    //   (covers warm-pool eviction reconnect, handle disposal, profile reload, and daemon restart - R1).
    let nativeBinding: RuntimeBinding | undefined;
    let nativeRuntimeHooks: AdapterSessionConfig['nativeRuntimeHooks'];
    if (adapter.kind === 'agy' && this.nativeRegistry) {
      const nativeFlags = this.nativeRegistry.getFeatureFlags();
      if (nativeFlags.enabled && this.nativeRegistry.getSchemaStatus().compatible) {
        try {
          const storedBinding = this.nativeRegistry.ensureRuntimeBinding({
            sessionId,
            instanceId: adapter.id,
            profileRef: adapter.continuationKey ?? adapter.id,
            sourceRef: nativeHistory?.source ?? 'acp',
            advanceGeneration: true,
            status: 'attached',
          });
          nativeBinding = {
            runtimeId: storedBinding.runtimeId,
            sessionId: storedBinding.sessionId,
            instanceId: storedBinding.instanceId,
            generation: storedBinding.generation,
          };
          nativeRuntimeHooks = this.nativeRegistry.createAdapterRuntimeHooks(nativeBinding);
        } catch {
          // Never allow native runtime persistence issues to break legacy AGY session startup
          nativeBinding = undefined;
          nativeRuntimeHooks = undefined;
        }
      } else if (nativeFlags.observatoryTap) {
        nativeRuntimeHooks = this.nativeRegistry.createObservatoryOnlyHooks(sessionId, adapter.id);
      }
    }

    const config: AdapterSessionConfig = {
      cwd: session.cwd,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      permissionMode: session.permissionMode,
      nativeSessionId,
      nativeHistorySource: nativeHistory?.source,
      nativeHistoryPath: nativeHistory?.sourcePath,
      requireNativeResume: Boolean(nativeHistory || (existing && nativeSessionId)),
      handoffContinuity: handoffContinuity && (adapter.kind === 'codex' || adapter.kind === 'claude'),
      onContinuityNotice: (channel, text) => {
        this.emitCanonical(sessionId, 'handoff.system_notice', { harnessId, channel, text },
          this.activeTurnMeta.get(sessionId)?.turnId);
      },
      ...(nativeRuntimeHooks ? { nativeRuntimeHooks } : {}),
    };
    const shouldAttachMcpLease =
      Boolean(adapter.pluginMcpTransport) &&
      (tools.length > 0 || this.pluginManager.isPluginEnabled(ORCHESTRATOR_PLUGIN_ID));
    let lease = shouldAttachMcpLease
      ? router?.prepareLease(session, harnessId, tools, () => this.registry.get(harnessId) === adapter)
      : undefined;
    let handle: AdapterSessionHandle;
    try {
      handle = await adapter.createSession({ ...config, pluginMcp: lease?.connection });
    } catch (error) {
      if (!lease) throw error;
      lease.release();
      lease = undefined;
      this.emitCanonical(sessionId, 'diagnostic.log', { level: 'warn', stream: 'protocol', message: '插件模型工具挂载失败，使用原会话能力重试' });
      handle = await adapter.createSession(config);
    }
    if (lease && (!handle.pluginMcpAvailable || !this.pluginCapabilities?.isLeaseActive(lease))) {
      lease.release();
      lease = undefined;
    }

    const resolvedNativeId = handle.nativeSessionId ?? nativeSessionId;
    if (resolvedNativeId) {
      this.store.upsertSessionBinding({
        sessionId,
        harnessId: adapter.id,
        harnessKind: adapter.kind,
        nativeSessionId: resolvedNativeId,
        lastModel: session.model,
        lastActualModel: session.actualModel ?? null,
        lastEffort: session.reasoningEffort,
        syncedUpToSeq: resolvedNativeId === nativeSessionId ? binding?.syncedUpToSeq ?? 0 : 0,
        driverUsed: resolvedNativeId === nativeSessionId ? binding?.driverUsed ?? null : null,
        updatedAt: Date.now(),
      });
      if (session.harnessId === harnessId && resolvedNativeId !== session.nativeSessionId) {
        this.store.updateSession(sessionId, { nativeSessionId: resolvedNativeId });
      }
    }

    const nativeToGlobalApprovalId = new Map<string, string>();
    const unsubscribe = handle.onEvent((ev) => {
      this.handleAdapterEvent(sessionId, adapter.id, adapter.kind, ev, nativeToGlobalApprovalId);
    });

    const entry: LiveHandleEntry = {
      key,
      sessionId,
      harnessId: adapter.id,
      harnessKind: adapter.kind,
      adapter,
      handle,
      unsubscribe,
      nativeToGlobalApprovalId,
      lastUsedAt: Date.now(),
      pluginToolKey,
      pluginToolLease: lease,
      ...(nativeBinding ? { nativeBinding } : {}),
    };
    this.liveHandles.set(key, entry);
    if (nativeBinding && this.nativeRegistry) {
      const reconnectMode = nativeSessionId ? 'resume' : 'fresh';
      this.nativeRegistry.notifyReconnect(nativeBinding, reconnectMode);
    }
    return entry;
  }

  private async evictWarmPoolIfNeeded(protectedSessionId: string): Promise<void> {
    if (this.liveHandles.size < MAX_WARM_HANDLES) return;
    const candidates = Array.from(this.liveHandles.values())
      .filter((e) => {
        if (e.sessionId === protectedSessionId) return false;
        if (e.handle.hasActiveBackgroundWork?.()) return false;
        if ((e.handle.listRetentionReasons?.().length ?? 0) > 0) return false;
        const nativeEvict = this.nativeRegistry?.checkWarmPoolEvict(e.nativeBinding ?? null);
        if (nativeEvict && !nativeEvict.allowEvict) return false;
        const s = this.store.getSession(e.sessionId);
        return !s || (s.status !== 'running' && s.status !== 'awaiting_approval');
      })
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    if (candidates[0]) {
      await this.disposeLiveHandle(candidates[0].sessionId, candidates[0].harnessId);
    }
  }

  private async disposeLiveHandle(sessionId: string, harnessId: string): Promise<void> {
    const key = this.handleKey(sessionId, harnessId);
    const entry = this.liveHandles.get(key);
    if (!entry) return;
    this.liveHandles.delete(key);
    this.nativeRegistry?.handleTransportClosed(
      entry.nativeBinding ?? null,
      entry.handle.getConnectionId?.() ?? 'disposed',
      'handle_disposed',
    );
    entry.unsubscribe();
    entry.pluginToolLease?.release();
    await entry.handle.dispose();
  }

  async closeSessionsForHarness(harnessId: string): Promise<void> {
    const runtimeProviders = this.pluginManager.host.listServiceProviders(PEER_CONTRACTS.sessionRuntime);
    for (const prov of runtimeProviders) {
      if (this.pluginManager.isInstanceKnownDisabled(prov.instanceId)) continue;
      const svc = this.pluginManager.host.getServiceByInstance<
        import('@harnessmate/plugin-api').SessionRuntimeServiceV1
      >(prov.instanceId, PEER_CONTRACTS.sessionRuntime);
      if (svc) {
        await svc.closeHarnessSessions({ harnessId }).catch(() => {});
      }
    }
    if (this.runtimeController?.isActive()) {
      await this.runtimeController.closeSessionsForHarness(harnessId);
    }
  }

  private async disposeSessionHandles(sessionId: string): Promise<void> {
    this.expireSessionApprovals(sessionId);
    const runtimeRes = this.pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionRuntime, {
      sessionId,
      allowSingleCandidate: true,
    });
    if (runtimeRes.status === 'ready' && runtimeRes.instanceId) {
      const svc = this.pluginManager.host.getServiceByInstance<
        import('@harnessmate/plugin-api').SessionRuntimeServiceV1
      >(runtimeRes.instanceId, PEER_CONTRACTS.sessionRuntime);
      if (svc) {
        await svc.closeSession({ sessionId, reason: 'handle_disposed' }).catch(() => {});
      }
    }
    if (this.runtimeController?.isActive()) {
      await this.runtimeController.disposeSessionHandles(sessionId);
    }
  }

  private settleHeldNativeTurn(params: {
    readonly binding: RuntimeBinding;
    readonly turnId: string;
    readonly settlement: Extract<TurnSettlement, { kind: 'eligible' | 'disconnected' }>;
  }): { readonly settled: boolean; readonly reason?: string } {
    const { binding, turnId, settlement } = params;
    const meta = this.activeTurnMeta.get(binding.sessionId);
    if (!meta || meta.turnId !== turnId) {
      return { settled: false, reason: 'already_settled_or_unknown_turn' };
    }
    const liveEntry = this.liveHandles.get(this.handleKey(binding.sessionId, meta.harnessId));
    const currentBinding =
      liveEntry?.nativeBinding ??
      this.nativeRegistry?.getActiveBinding(binding.sessionId, meta.harnessId) ??
      null;
    if (
      currentBinding &&
      (currentBinding.runtimeId !== binding.runtimeId ||
        currentBinding.generation !== binding.generation)
    ) {
      return { settled: false, reason: 'stale_binding' };
    }

    liveEntry?.handle.releaseHeldTurn?.(turnId);
    const approvalMap = liveEntry?.nativeToGlobalApprovalId ?? new Map<string, string>();

    if (settlement.kind === 'disconnected') {
      this.handleAdapterEvent(
        binding.sessionId,
        meta.harnessId,
        meta.harnessKind,
        {
          type: 'turn.failed',
          turnId,
          message: settlement.reason,
          code: 'native_transport_disconnected',
        },
        approvalMap,
        { bypassNativeHold: true },
      );
      return { settled: true };
    }

    if (settlement.outcome === 'completed') {
      this.handleAdapterEvent(
        binding.sessionId,
        meta.harnessId,
        meta.harnessKind,
        {
          type: 'turn.completed',
          turnId,
          stopReason: settlement.stopReason ?? 'end_turn',
        },
        approvalMap,
        { bypassNativeHold: true },
      );
      return { settled: true };
    }

    if (settlement.outcome === 'cancelled') {
      this.handleAdapterEvent(
        binding.sessionId,
        meta.harnessId,
        meta.harnessKind,
        {
          type: 'turn.cancelled',
          turnId,
        },
        approvalMap,
        { bypassNativeHold: true },
      );
      return { settled: true };
    }

    this.handleAdapterEvent(
      binding.sessionId,
      meta.harnessId,
      meta.harnessKind,
      {
        type: 'turn.failed',
        turnId,
        message: settlement.message ?? 'Native turn failed',
        ...(settlement.code ? { code: settlement.code } : {}),
        ...(settlement.failureClass ? { failureClass: settlement.failureClass } : {}),
        ...(settlement.resetAt !== undefined ? { resetAt: settlement.resetAt } : {}),
      },
      approvalMap,
      { bypassNativeHold: true },
    );
    return { settled: true };
  }

  private handleAdapterEvent(
    sessionId: string,
    eventHarnessId: string,
    eventHarnessKind: HarnessKind,
    ev: NormalizedAdapterEvent,
    nativeToGlobalApprovalId: Map<string, string>,
    opts?: { bypassNativeHold?: boolean },
  ): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    const meta = this.activeTurnMeta.get(sessionId);
    const activeTurnHarness = meta?.harnessId ?? eventHarnessId;
    const activeTurnModel = meta?.model ?? session.model;
    const activeTurnActualModel = meta?.actualModel ?? session.actualModel ?? null;

    switch (ev.type) {
      case 'native_session_ready': {
        const existingBinding = this.store.getSessionBinding(sessionId, eventHarnessId);
        const sameBinding = existingBinding?.nativeSessionId === ev.nativeSessionId;
        this.store.upsertSessionBinding({
          sessionId,
          harnessId: eventHarnessId,
          harnessKind: eventHarnessKind,
          nativeSessionId: ev.nativeSessionId,
          lastModel: existingBinding?.lastModel ?? session.model,
          lastActualModel: existingBinding?.lastActualModel ?? session.actualModel ?? null,
          lastEffort: existingBinding?.lastEffort ?? session.reasoningEffort,
          syncedUpToSeq: sameBinding ? existingBinding?.syncedUpToSeq ?? 0 : 0,
          driverUsed: sameBinding ? existingBinding?.driverUsed ?? null : null,
          updatedAt: Date.now(),
        });
        if (session.harnessId === eventHarnessId) {
          this.store.updateSession(sessionId, { nativeSessionId: ev.nativeSessionId });
        }
        break;
      }

      case 'model.confirmed': {
        if (meta && meta.harnessId === eventHarnessId) {
          meta.actualModel = ev.actualModel;
        }
        if (session.harnessId === eventHarnessId) {
          this.store.updateSession(sessionId, {
            actualModel: ev.actualModel,
            modelReroutedReason: ev.reroutedFrom
              ? ev.reason || `请求 ${ev.reroutedFrom}，实际使用 ${ev.actualModel}`
              : null,
          });
        }
        const existingBinding = this.store.getSessionBinding(sessionId, eventHarnessId);
        this.store.upsertSessionBinding({
          sessionId,
          harnessId: eventHarnessId,
          harnessKind: eventHarnessKind,
          nativeSessionId: existingBinding?.nativeSessionId ?? null,
          lastModel: existingBinding?.lastModel ?? session.model,
          lastActualModel: ev.actualModel,
          lastEffort: existingBinding?.lastEffort ?? session.reasoningEffort,
          syncedUpToSeq: existingBinding?.syncedUpToSeq ?? 0,
          driverUsed: existingBinding?.driverUsed ?? null,
          updatedAt: Date.now(),
        });
        this.emitCanonical(
          sessionId,
          'session.model_confirmed',
          {
            harnessId: eventHarnessId,
            harnessKind: eventHarnessKind,
            actualModel: ev.actualModel,
            reroutedFrom: ev.reroutedFrom ?? null,
            reason: ev.reason ?? null,
          },
          meta?.turnId ?? null,
        );
        break;
      }

      case 'config.confirmed': {
        this.emitCanonical(
          sessionId,
          'session.config_confirmed',
          {
            harnessId: eventHarnessId,
            model: ev.model ?? null,
            thoughtLevel: ev.thoughtLevel ?? null,
            availableThoughtLevels: ev.availableThoughtLevels ?? [],
            modeId: ev.modeId ?? null,
            permissionEnforcement: ev.permissionEnforcement ?? 'native',
            tierName: ev.tierName ?? null,
          },
          meta?.turnId ?? null,
        );
        break;
      }

      case 'commands.updated': {
        this.emitCanonical(
          sessionId,
          'session.commands_updated',
          {
            harnessId: eventHarnessId,
            commands: ev.commands,
          },
          meta?.turnId ?? null,
        );
        break;
      }

      case 'session.title_updated': {
        const nextTitle = ev.title.trim().slice(0, 160);
        if (nextTitle && session.title.includes('·')) {
          this.store.updateSession(sessionId, { title: nextTitle });
          this.emitCanonical(
            sessionId,
            'session.title_updated',
            { title: nextTitle, harnessId: eventHarnessId },
            meta?.turnId ?? null,
          );
        }
        break;
      }

      case 'turn.started': {
        this.deltaCoalescer.flushSession(sessionId);
        if (ev.continuation && !meta) {
          const contRunId = `run_${crypto.randomBytes(6).toString('hex')}`;
          this.activeTurnMeta.set(sessionId, {
            runId: contRunId,
            turnId: ev.turnId, harnessId: eventHarnessId, harnessKind: eventHarnessKind,
            model: activeTurnModel, actualModel: activeTurnActualModel,
            advanceWatermark: false,
          });
          this.store.startSessionRun({
            runId: contRunId,
            sessionId,
            turnId: ev.turnId,
            instanceId: eventHarnessId,
            driverId: eventHarnessKind,
            model: activeTurnModel,
            status: 'running',
            startedAt: Date.now(),
          });
        }
        this.emitCanonical(
          sessionId,
          'turn.started',
          {
            harnessId: eventHarnessId,
            harnessKind: eventHarnessKind,
            model: activeTurnModel,
            actualModel: activeTurnActualModel,
          },
          ev.turnId,
        );
        this.setSessionStatus(sessionId, 'running');
        break;
      }

      case 'turn.completed': {
        if (!opts?.bypassNativeHold && eventHarnessKind === 'agy' && this.nativeRegistry) {
          const liveEntry = this.liveHandles.get(this.handleKey(sessionId, eventHarnessId));
          const settlement = this.nativeRegistry.decideTurnSettlement(
            ev.turnId,
            liveEntry?.nativeBinding ?? null,
          );
          if (settlement?.kind === 'held') {
            // Native lifecycle holds user turn settlement until blocking native work completes.
            // Release happens via NativeTurnSettlementSink.settleTurn(...) once blocking work settles.
            break;
          }
          if (
            this.nativeRegistry.getFeatureFlags().enabled &&
            this.nativeRegistry.getFeatureFlags().nativeLifecycle &&
            meta &&
            meta.turnId !== ev.turnId
          ) {
            // Single-settlement guard: ignore stale completion for an already-replaced turn.
            break;
          }
        }
        this.deltaCoalescer.flushSession(sessionId);
        this.expireSessionApprovals(sessionId);
        if (meta) {
          this.store.finishSessionRun(meta.runId, { status: 'completed' });
        }
        this.store.settleRunningTurnItems(sessionId, 'completed');
        const completedEv = this.emitCanonical(
          sessionId,
          'turn.completed',
          {
            stopReason: ev.stopReason ?? 'end_turn',
            harnessId: eventHarnessId,
            harnessKind: eventHarnessKind,
            model: activeTurnModel,
            actualModel: activeTurnActualModel,
          },
          ev.turnId,
        );
        this.activeTurnMeta.delete(sessionId);
        if (meta) {
          void this.capturePostTurnCheckpoint(session, meta, ev.turnId);
        }

        // Advance this harness's exact sync watermark through its own completed turn!
        const existingBinding = this.store.getSessionBinding(sessionId, eventHarnessId);
        this.store.upsertSessionBinding({
          sessionId,
          harnessId: eventHarnessId,
          harnessKind: eventHarnessKind,
          nativeSessionId: existingBinding?.nativeSessionId ?? session.nativeSessionId,
          lastModel: activeTurnModel,
          lastActualModel: activeTurnActualModel,
          lastEffort: session.reasoningEffort,
          syncedUpToSeq: meta?.advanceWatermark !== false ? completedEv.seq : existingBinding?.syncedUpToSeq ?? 0,
          driverUsed: existingBinding?.driverUsed ?? null,
          updatedAt: Date.now(),
        });

        this.setSessionStatus(sessionId, 'idle');
        if (meta?.reloadHandle) void this.disposeLiveHandle(sessionId, eventHarnessId);

        const orchCompleted = this.getActiveOrchestrator();
        if (orchCompleted) {
          void orchCompleted.handleChildTurnCompleted(sessionId).catch(() => {});
          orchCompleted.onParentSessionIdle(sessionId);
        }
        this.attachActiveCompressorHooks();

        this.eventBus.publishAttention({
          kind: 'turn_completed',
          sessionId,
          sessionTitle: session.title,
          harnessId: eventHarnessId,
          summary: `Turn completed (${eventHarnessId})`,
          timestamp: Date.now(),
        });
        break;
      }

      case 'turn.cancelled': {
        this.deltaCoalescer.flushSession(sessionId);
        this.cancelSessionApprovals(sessionId, '轮次已取消');
        if (meta) {
          this.store.finishSessionRun(meta.runId, { status: 'cancelled' });
        }
        this.store.settleRunningTurnItems(sessionId, 'interrupted');
        this.emitCanonical(
          sessionId,
          'turn.cancelled',
          { harnessId: eventHarnessId, harnessKind: eventHarnessKind },
          ev.turnId,
        );
        this.activeTurnMeta.delete(sessionId);
        this.setSessionStatus(sessionId, 'idle');
        if (meta?.reloadHandle) void this.disposeLiveHandle(sessionId, eventHarnessId);
        const orchCancelled = this.getActiveOrchestrator();
        if (orchCancelled) {
          void orchCancelled.handleChildTurnCancelled(sessionId).catch(() => {});
          orchCancelled.onParentSessionIdle(sessionId);
        }
        break;
      }

      case 'turn.failed': {
        this.deltaCoalescer.flushSession(sessionId);
        this.cancelSessionApprovals(sessionId, '轮次执行失败');
        const failoverSvc = selectedHarnessService<FailoverContract>(this.pluginManager, failoverContract, { sessionId });
        const failureClass = ev.failureClass || classifyTerminalFailure(ev.code, ev.message);
        let cooldownResetsAt: number | null = ev.resetAt ?? null;
        if (FAILOVER_TRIGGER_CLASSES.has(failureClass)) {
          const receipt = failoverSvc?.recordFailure?.(eventHarnessId, failureClass, ev.resetAt);
          if (receipt instanceof Promise) void receipt.catch(() => {});
          else cooldownResetsAt = receipt?.resetsAt ?? cooldownResetsAt;
        }
        if (meta) {
          this.store.finishSessionRun(meta.runId, {
            status: 'failed',
            failureClass,
          });
        }
        this.store.settleRunningTurnItems(sessionId, 'interrupted');
        this.emitCanonical(
          sessionId,
          'turn.failed',
          {
            message: ev.message,
            code: ev.code ?? null,
            failureClass,
            ...(cooldownResetsAt ? { resetsAt: cooldownResetsAt } : {}),
            harnessId: eventHarnessId,
            harnessKind: eventHarnessKind,
            model: activeTurnModel,
            actualModel: activeTurnActualModel,
          },
          ev.turnId,
        );
        this.activeTurnMeta.delete(sessionId);
        if (meta) {
          void this.capturePostTurnCheckpoint(session, meta, ev.turnId);
        }
        this.setSessionStatus(sessionId, 'error');
        if (ev.code === 'invalid_thinking_signature') {
          if (session.harnessId === eventHarnessId) {
            this.store.updateSession(sessionId, { nativeSessionId: null });
          }
          const badBinding = this.store.getSessionBinding(sessionId, eventHarnessId);
          if (badBinding) {
            this.store.upsertSessionBinding({
              ...badBinding,
              nativeSessionId: null,
              updatedAt: Date.now(),
            });
          }
          void this.disposeLiveHandle(sessionId, eventHarnessId);
        } else if (meta?.reloadHandle) {
          void this.disposeLiveHandle(sessionId, eventHarnessId);
        }

        const orchFailed = this.getActiveOrchestrator();
        if (orchFailed) {
          void orchFailed.handleChildTurnFailed(sessionId, ev.message).catch(() => {});
        }

        this.eventBus.publishAttention({
          kind: 'turn_failed',
          sessionId,
          sessionTitle: session.title,
          harnessId: eventHarnessId,
          summary: ev.message.slice(0, 140),
          timestamp: Date.now(),
        });
        void this.evaluateHandoffOffer(session, eventHarnessId, ev.message);
        break;
      }

      case 'message.assistant.delta': {
        this.deltaCoalescer.push({
          sessionId,
          turnId: ev.turnId,
          channel: 'assistant',
          text: ev.text,
          messageId: ev.messageId ?? null,
          parentToolUseId: ev.parentToolUseId ?? null,
          harnessId: activeTurnHarness,
          actualModel: activeTurnActualModel,
        });
        break;
      }

      case 'message.assistant.completed': {
        this.deltaCoalescer.flushSession(sessionId);
        const completed = this.emitCanonical(
          sessionId,
          'message.assistant.completed',
          {
            text: ev.text,
            messageId: ev.messageId ?? null,
            parentToolUseId: ev.parentToolUseId ?? null,
            harnessId: activeTurnHarness,
            actualModel: activeTurnActualModel,
          },
          ev.turnId,
        );
        const itemId = `${ev.turnId}:assistant:${ev.messageId ?? 'main'}`;
        this.store.upsertTurnItem({
          itemId,
          schemaVersion: 2,
          sessionId,
          turnId: ev.turnId,
          seq: completed.seq,
          instanceId: activeTurnHarness,
          driverId: eventHarnessKind,
          blockType: 'assistant_text',
          status: 'completed',
          title: 'Assistant',
          textBody: ev.text,
          payload: {
            messageId: ev.messageId ?? null,
            parentToolUseId: ev.parentToolUseId ?? null,
            actualModel: activeTurnActualModel,
          },
          outputOmitted: false,
          omittedBytes: 0,
          createdAt: completed.createdAt,
          updatedAt: completed.createdAt,
        });
        break;
      }

      case 'thinking.delta': {
        this.deltaCoalescer.push({
          sessionId,
          turnId: ev.turnId,
          channel: 'thinking',
          text: ev.text,
          harnessId: activeTurnHarness,
          actualModel: activeTurnActualModel,
        });
        break;
      }

      case 'thinking.completed': {
        this.deltaCoalescer.flushSession(sessionId);
        const thoughtEv = this.emitCanonical(sessionId, 'thinking.completed', { text: ev.text }, ev.turnId);
        this.store.upsertTurnItem({
          itemId: `${ev.turnId}:reasoning`,
          schemaVersion: 2,
          sessionId,
          turnId: ev.turnId,
          seq: thoughtEv.seq,
          instanceId: activeTurnHarness,
          driverId: eventHarnessKind,
          blockType: 'reasoning',
          status: 'completed',
          title: 'Reasoning',
          textBody: ev.text,
          payload: {},
          outputOmitted: false,
          omittedBytes: 0,
          createdAt: thoughtEv.createdAt,
          updatedAt: thoughtEv.createdAt,
        });
        break;
      }

      case 'tool.call.started': {
        this.deltaCoalescer.flushSession(sessionId);
        const toolStartEv = this.emitCanonical(
          sessionId,
          'tool.call.started',
          {
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            toolKind: ev.toolKind,
            summary: ev.summary,
            input: ev.input ?? null,
            parentToolUseId: ev.parentToolUseId ?? null,
            harnessId: activeTurnHarness,
          },
          ev.turnId,
        );
        this.store.upsertTurnItem({
          itemId: `tool:${ev.toolCallId}`,
          schemaVersion: 2,
          sessionId,
          turnId: ev.turnId,
          seq: toolStartEv.seq,
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
          createdAt: toolStartEv.createdAt,
          updatedAt: toolStartEv.createdAt,
        });
        break;
      }

      case 'tool.call.delta': {
        // Phase 0 side-channel: stream raw stdout/diff deltas via CommandOutputHub without bloating SQLite session_events
        if (ev.outputDelta) {
          this.commandOutputHub.append(sessionId, ev.toolCallId, ev.outputDelta, 'stdout');
        }
        if (ev.diffDelta) {
          this.commandOutputHub.append(sessionId, ev.toolCallId, ev.diffDelta, 'stdout');
        }
        break;
      }

      case 'command.output.delta': {
        this.commandOutputHub.append(sessionId, ev.toolCallId, ev.chunk, ev.stream ?? 'stdout');
        break;
      }

      case 'tool.call.completed': {
        this.deltaCoalescer.flushSession(sessionId);
        this.commandOutputHub.complete(sessionId, ev.toolCallId);
        const hubSnap = this.commandOutputHub.getSnapshot(sessionId, ev.toolCallId);
        const rawOutput = ev.output ?? hubSnap?.text ?? null;
        const outputBytes = rawOutput ? Buffer.byteLength(rawOutput, 'utf8') : 0;
        const existingItem = this.store.getTurnItem(`tool:${ev.toolCallId}`);
        const outputOmitted = Boolean(rawOutput && rawOutput.length > MAX_STORED_TOOL_OUTPUT_CHARS);
        const storedOutput = outputOmitted && rawOutput
          ? rawOutput.slice(0, MAX_STORED_TOOL_OUTPUT_CHARS)
          : rawOutput;
        const turnItemBody = rawOutput
          ? rawOutput.slice(0, MAX_TURN_ITEM_TEXT_CHARS)
          : existingItem?.textBody ?? '';

        const toolDoneEv = this.emitCanonical(
          sessionId,
          'tool.call.completed',
          {
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            status: ev.status,
            output: storedOutput,
            diff: ev.diff ?? null,
            outputOmitted,
            omittedBytes: outputOmitted ? outputBytes : 0,
            harnessId: activeTurnHarness,
          },
          ev.turnId,
        );
        this.store.upsertTurnItem({
          itemId: `tool:${ev.toolCallId}`,
          schemaVersion: 2,
          sessionId,
          turnId: ev.turnId,
          seq: existingItem?.seq ?? toolDoneEv.seq,
          instanceId: activeTurnHarness,
          driverId: eventHarnessKind,
          blockType: existingItem?.blockType ?? 'tool_call',
          status: ev.status === 'success' ? 'completed' : ev.status === 'cancelled' ? 'cancelled' : 'failed',
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
          createdAt: existingItem?.createdAt ?? toolDoneEv.createdAt,
          updatedAt: toolDoneEv.createdAt,
        });
        break;
      }

      case 'turn_block.ext': {
        this.deltaCoalescer.flushSession(sessionId);
        const now = Date.now();
        this.store.upsertTurnItem({
          itemId: ev.itemId,
          schemaVersion: 2,
          sessionId,
          turnId: ev.turnId,
          seq: session.lastSeq,
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
        });
        break;
      }

      case 'approval.requested': {
        this.deltaCoalescer.flushSession(sessionId);
        const approvalId = `appr_${crypto.randomBytes(6).toString('hex')}`;
        nativeToGlobalApprovalId.set(ev.nativeRequestId, approvalId);
        const inferredKind: RuntimeRequestKind =
          ev.kind ??
          (ev.toolKind === 'file_edit'
            ? 'file_change_approval'
            : ev.toolKind === 'mcp'
              ? 'mcp_tool_approval'
              : 'command_approval');
        const adapter = this.registry.get(eventHarnessId);
        const supportedDecisions =
          ev.supportedDecisions ??
          adapter?.capabilitiesV2?.supportedApprovalDecisions ??
          ['allow_once', 'allow_session', 'deny'];

        const approvalCenter = this.getApprovalCenter();
        const localAnnotations = approvalCenter.evaluateLocalRules({
          approvalId,
          sessionId,
          workspaceId: session.workspaceId,
          cwd: session.cwd,
          kind: inferredKind,
          toolName: ev.toolName,
          toolKind: ev.toolKind,
          summary: ev.summary,
          input: ev.input,
          diffPreview: ev.diffPreview ?? null,
          riskLevel: ev.riskLevel,
        });
        const riskRank: Record<ApprovalRequest['riskLevel'], number> = { low: 0, medium: 1, high: 2, critical: 3 };
        let effectiveRisk: ApprovalRequest['riskLevel'] = ev.riskLevel;
        for (const note of localAnnotations) {
          if (note.risk && riskRank[note.risk] > riskRank[effectiveRisk]) {
            effectiveRisk = note.risk;
          }
        }

        const approval: ApprovalRequest = {
          id: approvalId,
          sessionId,
          parentSessionId: session.parentSessionId ?? null,
          instanceId: eventHarnessId,
          nativeRequestId: ev.nativeRequestId,
          kind: inferredKind,
          toolName: ev.toolName,
          toolKind: ev.toolKind,
          summary: ev.summary,
          input: inferredKind === 'secret_request' ? {} : ev.input,
          diffPreview: ev.diffPreview ?? null,
          riskLevel: effectiveRisk,
          supportedDecisions,
          questionSpec: ev.questionSpec ?? null,
          secretSpec: ev.secretSpec ?? null,
          annotations: localAnnotations.length > 0 ? localAnnotations : undefined,
          status: 'pending',
          resolvedBy: null,
          decision: null,
          comment: null,
          createdAt: Date.now(),
          resolvedAt: null,
        };
        this.store.createApproval(approval);
        const expiry = setTimeout(() => this.expireApproval(approval), 120_000);
        expiry.unref();
        this.approvalTimers.set(approvalId, expiry);
        this.setSessionStatus(sessionId, 'awaiting_approval');
        this.emitCanonical(sessionId, 'approval.requested', { approval }, ev.turnId);
        this.emitCanonical(sessionId, 'runtime_request.updated', { request: approval }, ev.turnId);
        this.getActiveOrchestrator()?.handleChildApprovalRequested(sessionId, approvalId, ev.toolName);
        void this.annotatePendingApproval(session, approval);
        this.eventBus.publishAttention({
          kind: 'approval_needed',
          sessionId,
          sessionTitle: session.title,
          harnessId: eventHarnessId,
          summary: ev.summary,
          approvalId,
          timestamp: Date.now(),
        });
        break;
      }

      case 'usage.updated': {
        const prev = session.usage;
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
        this.store.updateSession(sessionId, { usage: merged });
        this.emitCanonical(
          sessionId,
          'usage.updated',
          { usage: merged, harnessId: eventHarnessId },
          ev.turnId,
        );
        break;
      }

      case 'diagnostic.log': {
        this.emitCanonical(sessionId, 'diagnostic.log', {
          level: ev.level,
          stream: ev.stream,
          message: ev.message,
          harnessId: eventHarnessId,
        });
        break;
      }
    }
  }

  private setSessionStatus(sessionId: string, status: SessionStatus): void {
    this.assertDefaultDataEnabledForSyncRead();
    const current = this.store.getSession(sessionId);
    if (!current || current.status === status) return;
    this.store.updateSession(sessionId, { status });
    this.emitCanonical(sessionId, 'session.status', { status });
  }

  private async setSessionStatusAsync(sessionId: string, status: SessionStatus): Promise<void> {
    const found = await findSessionWithProvider(this.pluginManager, sessionId);
    if (!found || found.session.status === status) return;
    unwrapPeerServiceResult(await found.provider.service.updateSession({ sessionId, patch: { status } }));
    const ev = unwrapPeerServiceResult(
      await found.provider.service.appendEvent({
        sessionId,
        type: 'session.status',
        turnId: null,
        payload: { status },
      }),
    ).event;
    const modelEv = eventDtoToModel(ev);
    this.eventBus.publishEvent(modelEv);
    this.pluginManager?.notifyEvent(modelEv, found.session.workspaceId);
  }

  async annotatePendingApproval(
    session: Session,
    approval: ApprovalRequest,
    extraAnnotators?: readonly ExternalApprovalAnnotator[],
  ) {
    const isolatedNotes =
      (await this.pluginManager.isolated?.annotateApproval({
        approvalId: approval.id,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        toolName: approval.toolName,
        toolKind: approval.toolKind,
        summary: approval.summary,
        riskLevel: approval.riskLevel === 'critical' ? 'high' : approval.riskLevel,
      })) ?? [];

    for (const note of isolatedNotes) {
      this.store.addApprovalAnnotation(approval.id, note);
    }

    if (extraAnnotators && extraAnnotators.length > 0) {
      const evaluation = await this.getApprovalCenter().evaluateWithPlugins(
        {
          approvalId: approval.id,
          sessionId: session.id,
          workspaceId: session.workspaceId,
          cwd: session.cwd,
          kind: approval.kind ?? 'command_approval',
          toolName: approval.toolName,
          toolKind: approval.toolKind,
          summary: approval.summary,
          input: approval.input,
          diffPreview: approval.diffPreview ?? null,
          riskLevel: approval.riskLevel,
        },
        extraAnnotators,
      );
      for (const note of evaluation.annotations) {
        if (note.pluginId !== 'hm.plugin.approval-center') {
          this.store.addApprovalAnnotation(approval.id, note);
        }
      }
    }

    const updated = this.store.getApproval(approval.id);
    if (updated && (isolatedNotes.length > 0 || (extraAnnotators?.length ?? 0) > 0)) {
      this.emitCanonical(session.id, 'runtime_request.updated', { request: updated });
    }
    return updated;
  }

  async evaluateHandoffOffer(session: Session, harnessId: string, message?: string | null) {
    const reason = message && /rate.?limit|quota|429/i.test(message) ? 'rate_limit' as const : 'turn_failed' as const;
    const hostDecision = this.pluginManager.host.events.bail('handoff.shouldOffer', []);
    if (hostDecision !== undefined) return hostDecision;
    return this.pluginManager.isolated?.shouldOfferHandoff({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      harnessId,
      reason,
      message: message ?? null,
    });
  }

  private emitCanonical(
    sessionId: string,
    type: CanonicalEvent['type'],
    payload: Record<string, unknown>,
    turnId: string | null = null,
  ): CanonicalEvent {
    this.assertDefaultDataEnabledForSyncRead();
    const event = this.store.appendEvent(sessionId, type, payload, turnId);
    this.eventBus.publishEvent(event);
    const workspaceId = this.store.getSession(sessionId)?.workspaceId;
    this.pluginManager?.notifyEvent(event, workspaceId);
    return event;
  }
}
