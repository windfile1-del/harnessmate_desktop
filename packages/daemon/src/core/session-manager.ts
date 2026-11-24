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
  PortableSessionBundleV2,
  ResolveApprovalRequest,
  RevertCheckpointRequest,
  RunHarnessCommandRequest,
  RunPluginActionRequest,
  RuntimeRequestKind,
  Session,
  SessionCheckpointRecord,
  SessionPluginAction,
  SessionRunRecord,
  SessionSearchResponse,
  SessionStatus,
  SessionTaskState,
  SideChatMessage,
  SideChatPromoteRequest,
  SideChatRequest,
  SwitchHarnessRequest,
  TerminalContextChip,
  TurnBlockRecord,
  TurnOptionsMap,
  UpdateSessionRequest,
  UpdateTaskStateRequest,
  Workspace,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { AcpAdapter } from '../harnesses/acp-adapter.js';
import { findLocalSession, readJsonlHistory } from '../harnesses/history-scanner.js';
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
import { pluginDevelopmentBrief } from '../plugins/plugin-development-prompt.js';
import { ApprovalCenterService, SECRET_RECEIPT_LABEL, type ExternalApprovalAnnotator } from './approval-center-service.js';
import {
  CONTEXT_COMPRESSION_PLUGIN_ID,
  ContextCompressionService,
} from './context-compression-service.js';
import { ORCHESTRATOR_PLUGIN_ID, OrchestratorService } from './orchestrator-service.js';
import { CheckpointError, type CheckpointDiffResult, type CheckpointService } from './checkpoint-service.js';
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
import { PluginApiError } from '@harnessmate/plugin-api';
import type { FailoverService, GitService, NativeCommandsService } from '../plugin-host/builtin/services.js';
import { sessionPluginEvent } from '../plugin-host/runtime/events.js';
import { dispatchTurn } from './outbound-gate.js';

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
  harnessId?: string;
  model?: string | null;
  turnOptions?: TurnOptionsMap;
  omitHandoff?: boolean;
  literalText?: boolean;
  mode?: 'plugin_development';
  terminalContexts?: TerminalContextChip[];
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
  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private readonly eventBus: DaemonEventBus,
    private readonly pluginManager: PluginManager,
    private readonly pluginCapabilities?: PluginCapabilities,
    commandOutputHub?: CommandOutputHub,
    private readonly terminalWorkspace?: TerminalWorkspaceService,
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
    this.recoverStaleSessions();
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

  private recoverStaleSessions(): void {
    this.store.recoverCrashStateOnStartup();
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
    return this.store.listTurnItems(sessionId, opts);
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

  getSessionRuns(sessionId: string, limit = 100): SessionRunRecord[] {
    return this.store.listSessionRuns(sessionId, limit);
  }

  // ── Session Checkpoints & Atomic Revert ──────────────────────────────

  listSessionCheckpoints(sessionId: string, limit = 100): SessionCheckpointRecord[] {
    const svc = this.pluginManager.host.get<CheckpointService>('checkpoints');
    if (svc) return svc.list(sessionId, limit);
    return this.store.listCheckpointRecords(sessionId, limit);
  }

  async captureManualCheckpoint(sessionId: string): Promise<SessionCheckpointRecord> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new CheckpointError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    const svc = this.service<CheckpointService>('checkpoints');
    const latest = svc.list(sessionId, 1)[0];
    const record = await svc.capture({
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
    const svc = this.service<CheckpointService>('checkpoints');
    return svc.diff({
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

    const svc = this.service<CheckpointService>('checkpoints');
    const adapter = this.registry.get(session.harnessId);
    const supportsNativeRollback = Boolean(adapter?.capabilitiesV2?.supportsNativeRollback);

    // Estimate how many turns have occurred since targetTurnSeq for native rollback
    const allCheckpoints = svc.list(sessionId, 500);
    const targetSeq =
      req.targetTurnSeq ??
      (req.checkpointId ? svc.get(req.checkpointId)?.turnSeq : undefined) ??
      0;
    const turnsSinceTarget = Math.max(
      1,
      allCheckpoints.filter((c) => c.phase === 'turn_pre' && c.turnSeq >= targetSeq).length,
    );

    const result = await svc.revert({
      sessionId,
      cwd: session.cwd,
      checkpointId: req.checkpointId,
      targetTurnSeq: req.targetTurnSeq,
      mode: req.mode,
      hooks: {
        supportsNativeRollback,
        turnsToRollback: turnsSinceTarget,
        performNativeRollback: async (numTurns) => {
          const key = this.handleKey(sessionId, session.harnessId);
          const existing = this.liveHandles.get(key);
          const entry = existing ?? (await this.ensureLiveHandle(sessionId, session.harnessId, false));
          if (!entry.handle.runNativeCommand) {
            throw new CheckpointError(
              'E_NATIVE_ROLLBACK_FAILED',
              `当前驱动 (${session.harnessId}) 未暴露原生回滚接口，已中止回滚且未修改任何工作区文件`,
            );
          }
          try {
            await entry.handle.runNativeCommand('rollback', String(numTurns));
          } catch (err) {
            throw new CheckpointError(
              'E_NATIVE_ROLLBACK_FAILED',
              `原生对话回滚失败，已中止回滚且未修改任何工作区文件：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        resetNativeBinding: async () => {
          await this.disposeLiveHandle(sessionId, session.harnessId);
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
        onReverted: (revertResult, target) => {
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
      },
    });

    return result;
  }

  async gcSessionCheckpoints(
    sessionId: string,
    req: GcCheckpointsRequest,
  ): Promise<{ deletedCount: number; deletedRefs: string[] }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new CheckpointError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    const svc = this.service<CheckpointService>('checkpoints');
    return svc.gcCheckpoints({
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
    const svc = this.pluginManager.host.get<CheckpointService>('checkpoints');
    if (!svc) return;
    try {
      const record = await svc.capture({
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
        const entry = this.liveHandles.get(this.handleKey(source.id, source.harnessId));
        if (entry?.handle.runNativeCommand) {
          const out = await entry.handle.runNativeCommand('fork', source.nativeSessionId ?? '');
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
      getGitService: () => this.pluginManager.host.get<GitService>('git'),
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
        return this.pluginManager.host.get<TaskLedgerService>('ledger')?.getOrCreate(session);
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

  private get taskLedger(): TaskLedgerService {
    return this.service('ledger');
  }

  // ── Workspaces ───────────────────────────────────────────────────────

  async addWorkspace(rootPath: string, name?: string): Promise<Workspace> {
    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Workspace directory does not exist: ${resolved}`);
    }

    const existing = this.store.getWorkspaceByPath(resolved);
    if (existing) {
      const git = await this.pluginManager.host.get<GitService>('git')?.inspect(resolved);
      if (git) this.store.updateWorkspaceGit(existing.id, git.isGitRepo, git.branch);
      return this.store.getWorkspace(existing.id)!;
    }

    const git = await this.pluginManager.host.get<GitService>('git')?.inspect(resolved) ?? { isGitRepo: false, branch: null };
    const registeredWhileInspecting = this.store.getWorkspaceByPath(resolved);
    if (registeredWhileInspecting) return registeredWhileInspecting;
    const ws: Workspace = {
      id: `ws_${crypto.randomBytes(6).toString('hex')}`,
      name: name?.trim() || path.basename(resolved) || resolved,
      rootPath: resolved,
      isGitRepo: git.isGitRepo,
      gitBranch: git.branch,
      createdAt: Date.now(),
    };
    return this.store.createWorkspace(ws);
  }

  listWorkspaces(): Workspace[] {
    return this.store.listWorkspaces();
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    await this.terminalWorkspace?.closeWorkspaceTerminals(id);
    const sessions = this.store.listSessions({ workspaceId: id, includeArchived: true });
    for (const s of sessions) {
      await this.disposeSessionHandles(s.id);
    }
    return this.store.deleteWorkspace(id);
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
    return this.store.listSessions(filter);
  }

  getSession(id: string): Session | null {
    return this.store.getSession(id);
  }

  getSessionEvents(sessionId: string, afterSeq = 0): CanonicalEvent[] {
    return this.store.getEventsAfter(sessionId, afterSeq);
  }

  iterateSessionEvents(sessionId: string, afterSeq = 0): Iterable<CanonicalEvent> {
    return this.store.iterateEvents(sessionId, afterSeq);
  }

  listPendingApprovals(sessionId?: string): ApprovalRequest[] {
    return this.store.listPendingApprovals(sessionId);
  }

  async createSession(req: CreateSessionRequest): Promise<Session> {
    const session = await this.buildSession(req);
    const created = this.store.createSession(session);
    this.emitCanonical(created.id, 'session.status', { status: 'idle' });

    await this.pluginManager.dispatchLifecycleEvent(sessionPluginEvent('session.created', created), created.workspaceId);

    return this.store.getSession(created.id)!;
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
    const ws = this.store.getWorkspace(req.workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${req.workspaceId}`);

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
      const wt = await this.service<GitService>('git').worktree(ws.rootPath, branch);
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

  async updateSession(id: string, req: UpdateSessionRequest): Promise<Session> {
    const current = this.store.getSession(id);
    if (!current) throw new Error(`Session not found: ${id}`);

    const configChanged =
      (req.model !== undefined && req.model !== current.model) ||
      (req.reasoningEffort !== undefined && req.reasoningEffort !== current.reasoningEffort) ||
      (req.permissionMode !== undefined && req.permissionMode !== current.permissionMode);

    const updated = this.store.updateSession(id, {
      title: req.title,
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      permissionMode: req.permissionMode,
      contextSyncMode: req.contextSyncMode,
      ...(req.model !== undefined && req.model !== current.model
        ? { actualModel: null, modelReroutedReason: null }
        : {}),
      status: req.archived === true ? 'archived' : req.archived === false ? 'idle' : undefined,
    });
    if (!updated) throw new Error(`Failed to update session: ${id}`);

    // Mirror model/effort preference into active harness binding
    this.store.upsertSessionBinding({
      sessionId: id,
      harnessId: updated.harnessId,
      harnessKind: updated.harnessKind,
      nativeSessionId: updated.nativeSessionId,
      lastModel: updated.model,
      lastActualModel: updated.actualModel ?? null,
      lastEffort: updated.reasoningEffort,
      syncedUpToSeq: this.store.getSessionBinding(id, updated.harnessId)?.syncedUpToSeq ?? 0,
      driverUsed: null,
      updatedAt: Date.now(),
    });

    if (req.archived !== undefined) {
      if (req.archived === true) {
        await this.getActiveOrchestrator()?.cascadeStopChildren(id, 'Parent session archived');
      }
      await this.disposeSessionHandles(id);
    } else if (configChanged && current.status === 'idle') {
      const live = this.liveHandles.get(this.handleKey(id, updated.harnessId));
      if (live) {
        if (live.handle.updateConfig) {
          await live.handle.updateConfig({
            model: updated.model,
            reasoningEffort: updated.reasoningEffort,
            permissionMode: updated.permissionMode,
          });
        } else {
          await this.disposeLiveHandle(id, updated.harnessId);
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
    return this.store.getSession(id)!;
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = this.store.getSession(id);
    await this.getActiveOrchestrator()?.cascadeStopChildren(id, 'Parent session deleted');
    if (session) await this.pluginManager.dispatchLifecycleEvent(sessionPluginEvent('session.closing', session), session.workspaceId);
    await this.disposeSessionHandles(id);
    return this.store.deleteSession(id);
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
      const git = await this.pluginManager.host.get<GitService>('git')?.status(updated.cwd);
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

    this.pluginManager.host.get<TaskLedgerService>('ledger')?.syncSession(updated);

    // If a warm handle for target harness exists with stale model config, apply config now
    const warmTarget = this.liveHandles.get(this.handleKey(sessionId, targetAdapter.id));
    if (warmTarget && warmTarget.handle.updateConfig) {
      try {
        await warmTarget.handle.updateConfig({
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
  ): Promise<{ session: Session; retriedTurnId: string | null }> {
    const current = this.store.getSession(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);

    const failover = this.service<FailoverService>('failover');
    const retry = req.retryLastFailedTurn === false ? undefined : failover.retryInput(sessionId);

    if (current.status === 'error') {
      this.setSessionStatus(sessionId, 'idle');
    }

    const { session: switched } = await this.switchHarness(sessionId, {
      targetHarnessId: req.targetHarnessId,
      targetModel: req.targetModel,
    });

    if (retry) {
      const { turnId } = await this.sendTurn(sessionId, retry.text, retry.attachments);
      return { session: this.store.getSession(sessionId)!, retriedTurnId: turnId };
    }

    return { session: switched, retriedTurnId: null };
  }

  // ── Task State Ledger APIs ───────────────────────────────────────────

  getTaskState(sessionId: string): SessionTaskState {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return this.taskLedger.getOrCreate(session);
  }

  updateTaskState(sessionId: string, patch: UpdateTaskStateRequest): SessionTaskState {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const updated = this.taskLedger.updateManual(session, patch);
    this.emitCanonical(sessionId, 'task.state_updated', {
      version: updated.version,
      objective: updated.objective,
      stepsCount: updated.steps.length,
      doneStepsCount: updated.steps.filter((s) => s.status === 'done').length,
      pinnedFactsCount: updated.pinnedFacts.length,
      ledgerFilePath: updated.ledgerFilePath ?? null,
    });
    return updated;
  }

  summarizeTaskState(sessionId: string): SessionTaskState {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const updated = this.taskLedger.generateDeterministicDigest(session);
    this.emitCanonical(sessionId, 'task.state_updated', {
      version: updated.version,
      objective: updated.objective,
      summarizedUpToSeq: updated.summarizedUpToSeq,
      ledgerFilePath: updated.ledgerFilePath ?? null,
    });
    return updated;
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
    const sourceLedger = this.taskLedger.getOrCreate(source);
    this.taskLedger.updateManual(newSession, {
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
    const ledgerService = this.pluginManager.host.get<TaskLedgerService>('ledger');
    const ledger = ledgerService?.getOrCreate(session);
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
    return service.list(session.harnessKind, source === 'agy_desktop');
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
    const tools = this.pluginCapabilities?.getTools(session) ?? [];
    const count = tools.length;
    if (!count) return { count, status: 'none' as const };
    if (!this.registry.get(session.harnessId)?.pluginMcpTransport) return { count, status: 'unsupported' as const };
    const handle = this.liveHandles.get(this.handleKey(session.id, session.harnessId));
    if (!handle || handle.pluginToolKey !== this.pluginToolKey(tools)) return { count, status: 'next_turn' as const };
    if (!handle.pluginToolLease) return { count, status: 'unsupported' as const };
    return { count, status: handle.pluginToolLease.discovered ? 'connected' as const : 'configured' as const };
  }

  async runPluginAction(sessionId: string, req: RunPluginActionRequest): Promise<HarnessCommandResult> {
    return this.withSessionStartup(sessionId, async () => {
      const session = this.store.getSession(sessionId);
      const capabilities = this.pluginCapabilities;
      if (!session || !capabilities) throw new Error('会话或插件动作服务不存在');
      if (session.harnessId !== req.harnessId) throw new Error('当前引擎已切换，请重试');
      if (session.status === 'archived') throw new Error('会话已归档');
      const entry = capabilities.listActions(session).find(({ action }) => action.command === req.command);
      if (entry) {
        if (!entry.granted) throw new Error('请在插件中心授权当前工作区');
        const { action, plugin } = entry;
        if (action.kind === 'program') return { output: capabilities.executeProgramAction(plugin, action, req.args), session };
        const unavailable = this.nativeActionReason(session, action.nativeCommand);
        if (unavailable) throw new Error(unavailable);
        if (action.args !== undefined && req.args.trim()) throw new Error(`请单独发送 /${action.command}，该动作使用插件配置的参数`);
        return this.executeHarnessCommand(sessionId, { command: action.nativeCommand, args: (action.args ?? req.args).trim(), harnessId: req.harnessId });
      }
      const isolatedCmd = this.pluginManager.isolated?.listCommands().find(({ command }) => command === req.command);
      if (!isolatedCmd) throw new Error('找不到已启用的插件动作');
      const result = await this.pluginManager.isolated!.runCommand(session, req.command, req.args, isolatedCmd.runId);
      if (result.kind === 'message') return { output: result.text, session };
      if (result.kind === 'compose') return { output: result.text, session };
      if (result.kind === 'native') {
        const nativeCmd = result.command as RunHarnessCommandRequest['command'];
        const unavailable = this.nativeActionReason(session, nativeCmd);
        if (unavailable) throw new Error(unavailable);
        return this.executeHarnessCommand(sessionId, { command: nativeCmd, args: (result.args ?? '').trim(), harnessId: req.harnessId });
      }
      return { output: '', session };
    });
  }

  async runHarnessCommand(sessionId: string, req: RunHarnessCommandRequest): Promise<HarnessCommandResult> {
    return this.withSessionStartup(sessionId, () => this.executeHarnessCommand(sessionId, req));
  }

  private async executeHarnessCommand(sessionId: string, req: RunHarnessCommandRequest): Promise<HarnessCommandResult> {
      const session = this.store.getSession(sessionId);
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
    const tools = this.service<NativeCommandsService>('native-commands').tools;

    const result = (output: string, turnId?: string): HarnessCommandResult => ({
      output, turnId, session: this.store.getSession(sessionId)!,
    });
    const rawCommand = async (text: string) => {
      const { turnId } = await this.startTurn(sessionId, text, undefined, undefined, { cliCommand: text });
      return result('', turnId);
    };
    const getHandle = async () => (await this.ensureLiveHandle(sessionId, session.harnessId, false)).handle;
    const { command, args } = req;
    switch (command) {
      case 'model': {
        if (!args) {
          const info = (await this.registry.probeAll()).find((h) => h.id === session.harnessId);
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
        const turn = args ? await this.startTurn(sessionId, args) : undefined;
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
        if (args.startsWith('install ')) await this.disposeLiveHandle(sessionId, session.harnessId);
        return result(output);
      }
      case 'skills':
      case 'skill': {
        const skills = session.harnessKind === 'agy' ? await tools.listAgySkills(session.cwd)
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
          const { turnId } = await this.startTurn(sessionId, skillArgs || `调用技能 ${name}`, undefined, undefined,
            { nativeSkill: { name, path: skill.path } });
          return result('', turnId);
        }
        return rawCommand(`/${name}${skillArgs ? ` ${skillArgs}` : ''}`);
      }
    }
  }

  async sendTurn(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    turnOpts?: TurnOptions,
  ): Promise<{ turnId: string }> {
    return this.withSessionStartup(sessionId, () => this.startTurn(sessionId, text, attachments, turnOpts));
  }

  previewTurnSuggestion(sessionId: string, text: string, attachments?: Attachment[]) {
    const session = this.store.getSession(sessionId);
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
    if (session.status === 'running' || session.status === 'awaiting_approval') {
      throw new Error('Session already has an active turn in progress.');
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
    this.store.indexSearchItem({
      sessionId,
      itemId: userItemId,
      turnId,
      driverId: session.harnessKind,
      title: session.title,
      body: text,
    });
    this.setSessionStatus(sessionId, 'running');

    // Capture turn_pre hidden Git checkpoint (non-blocking, timeout-protected, skips non-Git)
    if (!native?.cliCommand) {
      const turnMeta = this.activeTurnMeta.get(sessionId);
      if (turnMeta) {
        turnMeta.turnSeq = userEvent.seq;
      }
      const checkpointSvc = this.pluginManager.host.get<CheckpointService>('checkpoints');
      if (checkpointSvc) {
        try {
          const preRecord = await checkpointSvc.capture({
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

      const entry = await this.ensureLiveHandle(
        sessionId,
        session.harnessId,
        Boolean(compiled?.syncNeeded && !native?.cliCommand),
        true,
      );
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

      const finalDriver = await dispatchTurn(entry.handle, { id: session.harnessId, kind: session.harnessKind }, {
        turnId,
        text: effectiveText,
        attachments,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        permissionMode: session.permissionMode,
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
    this.deltaCoalescer.flushSession(sessionId);
    const session = this.store.getSession(sessionId);
    const meta = this.activeTurnMeta.get(sessionId);
    const targetHarnessId = meta?.harnessId ?? session?.harnessId;
    if (targetHarnessId) {
      const entry = this.liveHandles.get(this.handleKey(sessionId, targetHarnessId));
      if (entry) {
        await entry.handle.interrupt();
      }
    }
    if (meta) {
      this.store.finishSessionRun(meta.runId, { status: 'cancelled' });
    }
    this.store.settleRunningTurnItems(sessionId, 'interrupted');
    this.activeTurnMeta.delete(sessionId);
    this.cancelSessionApprovals(sessionId, '轮次已中断');
    this.setSessionStatus(sessionId, 'idle');
    const orch = this.getActiveOrchestrator();
    if (orch) {
      await orch.cascadeStopChildren(sessionId, 'Parent session interrupted');
      await orch.handleChildTurnCancelled(sessionId);
    }
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
      for (const entry of this.liveHandles.values()) {
        if (
          entry.sessionId === approval.sessionId &&
          entry.nativeToGlobalApprovalId.get(approval.nativeRequestId) === approval.id
        ) {
          entry.nativeToGlobalApprovalId.delete(approval.nativeRequestId);
          if (denied) {
            await entry.handle.resolveApproval(approval.nativeRequestId, 'deny', '用户拒绝提供凭据');
          } else if (entry.handle.resolveSecret) {
            await entry.handle.resolveSecret(approval.nativeRequestId, secretPayload!);
          } else {
            await entry.handle.resolveApproval(approval.nativeRequestId, 'allow_once', secretPayload!);
          }
          break;
        }
      }

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

      for (const entry of this.liveHandles.values()) {
        if (
          entry.sessionId === approval.sessionId &&
          entry.nativeToGlobalApprovalId.get(approval.nativeRequestId) === approval.id
        ) {
          entry.nativeToGlobalApprovalId.delete(approval.nativeRequestId);
          if (!denied && entry.handle.resolveQuestion && answer) {
            await entry.handle.resolveQuestion(approval.nativeRequestId, answer);
          } else {
            await entry.handle.resolveApproval(
              approval.nativeRequestId,
              denied ? 'deny' : 'allow_once',
              formattedAnswer,
            );
          }
          break;
        }
      }

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
    for (const entry of this.liveHandles.values()) {
      if (
        entry.sessionId === approval.sessionId &&
        entry.nativeToGlobalApprovalId.get(approval.nativeRequestId) === approval.id
      ) {
        entry.nativeToGlobalApprovalId.delete(approval.nativeRequestId);
        await entry.handle.resolveApproval(approval.nativeRequestId, decision, req.comment);
        break;
      }
    }

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
      turnId: this.activeTurnMeta.get(approval.sessionId)?.turnId ?? `rtreq_${seq}`,
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

  private resumeSessionAfterApprovalIfClear(sessionId: string): void {
    const remaining = this.store.listPendingApprovals(sessionId);
    if (remaining.length === 0) {
      const sess = this.store.getSession(sessionId);
      if (sess && sess.status === 'awaiting_approval') {
        this.setSessionStatus(sessionId, this.activeTurnMeta.has(sessionId) ? 'running' : 'idle');
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
      for (const entry of this.liveHandles.values()) {
        if (
          entry.sessionId !== approval.sessionId ||
          entry.nativeToGlobalApprovalId.get(approval.nativeRequestId) !== approval.id
        ) {
          continue;
        }
        entry.nativeToGlobalApprovalId.delete(approval.nativeRequestId);
        void entry.handle.resolveApproval(approval.nativeRequestId, 'deny', reason).catch(() => {});
        break;
      }
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
    for (const entry of this.liveHandles.values()) {
      if (entry.sessionId !== approval.sessionId || entry.nativeToGlobalApprovalId.get(approval.nativeRequestId) !== approval.id) continue;
      entry.nativeToGlobalApprovalId.delete(approval.nativeRequestId);
      void entry.handle.resolveApproval(approval.nativeRequestId, 'deny', '审批已过期').catch(() => {});
      break;
    }
    if (this.store.getSession(approval.sessionId)?.status === 'awaiting_approval' &&
        this.store.listPendingApprovals(approval.sessionId).length === 0) {
      this.setSessionStatus(approval.sessionId, this.activeTurnMeta.has(approval.sessionId) ? 'running' : 'idle');
    }
  }

  private expireSessionApprovals(sessionId?: string): void {
    for (const approval of this.store.listPendingApprovals(sessionId)) this.expireApproval(approval);
  }

  async shutdown(): Promise<void> {
    this.deltaCoalescer.flushAll();
    this.deltaCoalescer.dispose();
    await this.terminalWorkspace?.disposeAll();
    this.store.settleRunningTurnItems(undefined, 'interrupted');
    this.expireSessionApprovals();
    const entries = Array.from(this.liveHandles.values());
    this.liveHandles.clear();
    await Promise.all([...new Set(entries.map(({ sessionId }) => sessionId))].map(async (sessionId) => {
      const session = this.store.getSession(sessionId);
      if (session) await this.pluginManager.dispatchLifecycleEvent(sessionPluginEvent('session.closing', session), session.workspaceId);
    }));
    await Promise.all(
      entries.map(async (entry) => {
        entry.unsubscribe();
        entry.pluginToolLease?.release();
        await entry.handle.dispose();
      }),
    );
  }

  // ── Warm Multi-Handle Runtime Pool ───────────────────────────────────

  private pluginToolKey(tools: ReturnType<PluginCapabilities['getTools']>): string {
    return tools.map((tool) => tool.kind === 'isolated'
      ? `${tool.name}:${tool.permission.digest}:${tool.runId}`
      : `${tool.name}:${tool.permission.digest}`).join(',');
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
    const tools = adapter.pluginMcpTransport ? this.pluginCapabilities?.getTools(session) ?? [] : [];
    const pluginToolKey = this.pluginToolKey(tools);
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
    };
    const shouldAttachMcpLease =
      Boolean(adapter.pluginMcpTransport) &&
      (tools.length > 0 || this.pluginManager.isPluginEnabled(ORCHESTRATOR_PLUGIN_ID));
    let lease = shouldAttachMcpLease ? this.pluginCapabilities?.openLease(session, harnessId, tools) : undefined;
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
    if (lease && !handle.pluginMcpAvailable) {
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
    };
    this.liveHandles.set(key, entry);
    return entry;
  }

  private async evictWarmPoolIfNeeded(protectedSessionId: string): Promise<void> {
    if (this.liveHandles.size < MAX_WARM_HANDLES) return;
    const candidates = Array.from(this.liveHandles.values())
      .filter((e) => {
        if (e.sessionId === protectedSessionId) return false;
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
    entry.unsubscribe();
    entry.pluginToolLease?.release();
    await entry.handle.dispose();
  }

  private async disposeSessionHandles(sessionId: string): Promise<void> {
    this.expireSessionApprovals(sessionId);
    const matching = Array.from(this.liveHandles.values()).filter((e) => e.sessionId === sessionId);
    for (const entry of matching) {
      await this.disposeLiveHandle(entry.sessionId, entry.harnessId);
    }
  }

  private handleAdapterEvent(
    sessionId: string,
    eventHarnessId: string,
    eventHarnessKind: HarnessKind,
    ev: NormalizedAdapterEvent,
    nativeToGlobalApprovalId: Map<string, string>,
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
        const failureClass = ev.failureClass || classifyTerminalFailure(ev.code, ev.message);
        let cooldownResetsAt: number | null = ev.resetAt ?? null;
        if (FAILOVER_TRIGGER_CLASSES.has(failureClass)) {
          const failoverSvc = this.pluginManager.host.get<FailoverService>('failover');
          const rec = failoverSvc?.recordFailure?.(eventHarnessId, failureClass, ev.resetAt);
          cooldownResetsAt = rec?.resetsAt ?? cooldownResetsAt;
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
        if (meta?.reloadHandle) void this.disposeLiveHandle(sessionId, eventHarnessId);

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
        this.store.indexSearchItem({
          sessionId,
          itemId,
          turnId: ev.turnId,
          driverId: eventHarnessKind,
          title: session.title,
          body: ev.text,
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
    const current = this.store.getSession(sessionId);
    if (!current || current.status === status) return;
    this.store.updateSession(sessionId, { status });
    this.emitCanonical(sessionId, 'session.status', { status });
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
    const meta = this.activeTurnMeta.get(sessionId);
    const body = meta?.maintenance && turnId === meta.turnId ? { ...payload, maintenance: true } : payload;
    const event = this.store.appendEvent(sessionId, type, body, turnId);
    this.eventBus.publishEvent(event);
    const workspaceId = this.store.getSession(sessionId)?.workspaceId;
    this.pluginManager?.notifyEvent(event, workspaceId);
    return event;
  }
}
