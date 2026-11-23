import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  ContextPreview,
  ContextSyncMode,
  CreateSessionRequest,
  DiscoveredCliSession,
  FailoverRequest,
  HarnessKind,
  HarnessCommandInfo,
  HarnessCommandResult,
  ImportNativeSessionRequest,
  RunHarnessCommandRequest,
  RunPluginActionRequest,
  Session,
  SessionPluginAction,
  SessionStatus,
  SessionTaskState,
  SwitchHarnessRequest,
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
import type { ContextCompiler } from './context-compiler.js';
import type { DaemonEventBus } from './event-bus.js';
import type { TaskLedgerService } from './task-ledger-service.js';
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
  turnId: string;
  harnessId: string;
  harnessKind: HarnessKind;
  model: string | null;
  actualModel: string | null;
  advanceWatermark?: boolean;
  reloadHandle?: boolean;
  maintenance?: boolean;
}

const MAX_WARM_HANDLES = 6;
type TurnOptions = { harnessId?: string; model?: string | null; omitHandoff?: boolean; literalText?: boolean };

export class SessionManager {
  private readonly liveHandles = new Map<string, LiveHandleEntry>();
  private readonly activeTurnMeta = new Map<string, ActiveTurnMeta>();
  private readonly startingSessions = new Set<string>();
  private readonly importingSessions = new Map<string, Promise<Session>>();
  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private readonly eventBus: DaemonEventBus,
    private readonly pluginManager: PluginManager,
    private readonly pluginCapabilities?: PluginCapabilities,
  ) {
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
    this.store.expirePendingApprovals();
    const sessions = this.store.listSessions({ includeArchived: true });
    for (const s of sessions) {
      if (s.status === 'running' || s.status === 'awaiting_approval') {
        this.store.updateSession(s.id, { status: 'idle' });
      }
    }
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
    const sessions = this.store.listSessions({ workspaceId: id, includeArchived: true });
    for (const s of sessions) {
      await this.disposeSessionHandles(s.id);
    }
    return this.store.deleteWorkspace(id);
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
          if (!handle.runCodexGoal) throw new Error('此 Codex 适配器未提供目标接口');
          const output = await handle.runCodexGoal(args);
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

    const { text: effectiveText, expandedCommand } = native || turnOpts?.literalText
      ? { text, expandedCommand: undefined } : this.pluginManager.expandSlashCommand(text);

    // Auto-title session from first user prompt if still default
    if (!native && session.lastSeq <= 2 && session.title.includes('·')) {
      const compactTitle = text.replace(/\s+/g, ' ').trim().slice(0, 64);
      if (compactTitle) {
        session = this.store.updateSession(sessionId, { title: compactTitle }) ?? session;
      }
    }

    // Track per-turn attribution before emitting events
    this.activeTurnMeta.set(sessionId, {
      turnId,
      harnessId: session.harnessId,
      harnessKind: session.harnessKind,
      model: session.model,
      actualModel: session.actualModel ?? null,
      advanceWatermark: !native?.cliCommand && !turnOpts?.omitHandoff,
      reloadHandle: session.harnessKind === 'agy' && Boolean(native?.cliCommand),
      maintenance: ['/compact', '/usage', '/reload-plugins'].includes(native?.cliCommand?.split(/\s+/)[0] ?? ''),
    });

    this.emitCanonical(
      sessionId,
      'message.user',
      {
        text,
        ...(effectiveText !== text ? { sentText: effectiveText } : {}),
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
    this.setSessionStatus(sessionId, 'running');

    try {
      // Compile incremental context delta if Context Bridge plugin is active
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
      const meta = this.activeTurnMeta.get(sessionId);
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
    const session = this.store.getSession(sessionId);
    const meta = this.activeTurnMeta.get(sessionId);
    const targetHarnessId = meta?.harnessId ?? session?.harnessId;
    if (targetHarnessId) {
      const entry = this.liveHandles.get(this.handleKey(sessionId, targetHarnessId));
      if (entry) {
        await entry.handle.interrupt();
      }
    }
    this.activeTurnMeta.delete(sessionId);
    this.store.expirePendingApprovals(sessionId);
    this.setSessionStatus(sessionId, 'idle');
  }

  // ── Atomic Approval Broker ───────────────────────────────────────────

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: 'desktop' | 'mobile' | 'auto',
    comment?: string,
  ): Promise<ApprovalRequest> {
    const { updated, approval } = this.store.resolveApprovalIfPending(
      approvalId,
      decision,
      resolvedBy,
      comment,
    );
    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }
    if (!updated) {
      return approval;
    }

    this.emitCanonical(approval.sessionId, 'approval.resolved', {
      approvalId: approval.id,
      decision,
      resolvedBy,
      comment: comment ?? null,
    });

    // Deliver approval to whichever warm handle in this session owns nativeRequestId
    for (const entry of this.liveHandles.values()) {
      if (
        entry.sessionId === approval.sessionId &&
        entry.nativeToGlobalApprovalId.has(approval.nativeRequestId)
      ) {
        await entry.handle.resolveApproval(approval.nativeRequestId, decision, comment);
        break;
      }
    }

    const remaining = this.store.listPendingApprovals(approval.sessionId);
    if (remaining.length === 0) {
      const sess = this.store.getSession(approval.sessionId);
      if (sess && sess.status === 'awaiting_approval') {
        this.setSessionStatus(approval.sessionId, 'running');
      }
    }

    return approval;
  }

  async shutdown(): Promise<void> {
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
    let lease = tools.length ? this.pluginCapabilities?.openLease(session, harnessId, tools) : undefined;
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
        if (ev.continuation && !meta) {
          this.activeTurnMeta.set(sessionId, {
            turnId: ev.turnId, harnessId: eventHarnessId, harnessKind: eventHarnessKind,
            model: activeTurnModel, actualModel: activeTurnActualModel,
            advanceWatermark: false,
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
        this.emitCanonical(
          sessionId,
          'turn.cancelled',
          { harnessId: eventHarnessId, harnessKind: eventHarnessKind },
          ev.turnId,
        );
        this.activeTurnMeta.delete(sessionId);
        this.setSessionStatus(sessionId, 'idle');
        if (meta?.reloadHandle) void this.disposeLiveHandle(sessionId, eventHarnessId);
        break;
      }

      case 'turn.failed': {
        this.emitCanonical(
          sessionId,
          'turn.failed',
          {
            message: ev.message,
            code: ev.code ?? null,
            harnessId: eventHarnessId,
            harnessKind: eventHarnessKind,
            model: activeTurnModel,
            actualModel: activeTurnActualModel,
          },
          ev.turnId,
        );
        this.activeTurnMeta.delete(sessionId);
        this.setSessionStatus(sessionId, 'error');
        if (meta?.reloadHandle) void this.disposeLiveHandle(sessionId, eventHarnessId);

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
        this.emitCanonical(
          sessionId,
          'message.assistant.delta',
          {
            text: ev.text,
            messageId: ev.messageId ?? null,
            parentToolUseId: ev.parentToolUseId ?? null,
            harnessId: activeTurnHarness,
            actualModel: activeTurnActualModel,
          },
          ev.turnId,
        );
        break;
      }

      case 'message.assistant.completed': {
        this.emitCanonical(
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
        break;
      }

      case 'thinking.delta': {
        this.emitCanonical(sessionId, 'thinking.delta', { text: ev.text }, ev.turnId);
        break;
      }

      case 'thinking.completed': {
        this.emitCanonical(sessionId, 'thinking.completed', { text: ev.text }, ev.turnId);
        break;
      }

      case 'tool.call.started': {
        this.emitCanonical(
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
        break;
      }

      case 'tool.call.delta': {
        this.emitCanonical(
          sessionId,
          'tool.call.delta',
          {
            toolCallId: ev.toolCallId,
            outputDelta: ev.outputDelta,
            diffDelta: ev.diffDelta ?? null,
          },
          ev.turnId,
        );
        break;
      }

      case 'tool.call.completed': {
        this.emitCanonical(
          sessionId,
          'tool.call.completed',
          {
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            status: ev.status,
            output: ev.output ?? null,
            diff: ev.diff ?? null,
            harnessId: activeTurnHarness,
          },
          ev.turnId,
        );
        break;
      }

      case 'approval.requested': {
        const approvalId = `appr_${crypto.randomBytes(6).toString('hex')}`;
        nativeToGlobalApprovalId.set(ev.nativeRequestId, approvalId);
        const approval: ApprovalRequest = {
          id: approvalId,
          sessionId,
          nativeRequestId: ev.nativeRequestId,
          toolName: ev.toolName,
          toolKind: ev.toolKind,
          summary: ev.summary,
          input: ev.input,
          diffPreview: ev.diffPreview ?? null,
          riskLevel: ev.riskLevel,
          status: 'pending',
          resolvedBy: null,
          decision: null,
          comment: null,
          createdAt: Date.now(),
          resolvedAt: null,
        };
        this.store.createApproval(approval);
        this.setSessionStatus(sessionId, 'awaiting_approval');
        this.emitCanonical(sessionId, 'approval.requested', { approval }, ev.turnId);
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

  async annotatePendingApproval(session: Session, approval: ApprovalRequest) {
    const collected = await this.pluginManager.isolated?.annotateApproval({
      approvalId: approval.id,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      toolName: approval.toolName,
      toolKind: approval.toolKind,
      summary: approval.summary,
      riskLevel: approval.riskLevel,
    }) ?? [];
    for (const note of collected) {
      this.store.addApprovalAnnotation(approval.id, note);
    }
    return this.store.getApproval(approval.id);
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
