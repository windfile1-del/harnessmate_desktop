import type {
  AddMcpServerRequest,
  AgyAuthState,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  AttentionItem,
  CanonicalEvent,
  CheckpointRevertResult,
  ContextPreview,
  ContextSyncMode,
  CreateSessionRequest,
  CustomAcpHarnessConfig,
  DelegateSubagentRequest,
  DiscoveredCliSession,
  FailoverPolicy,
  FailoverRequest,
  ForkSessionRequest,
  ForkSessionResult,
  GitDryRunMergeResult,
  GitStatusSummary,
  HarnessAccountUsage,
  HarnessCommandResult,
  HarnessInfo,
  HarnessKind,
  InstalledPluginInfo,
  ImportNativeSessionRequest,
  ImportSessionBundleRequest,
  InstallPluginRequest,
  ManagedTerminalTab,
  McpServerEntry,
  MergeBackRequest,
  MergeBackResult,
  MergeSubagentRequest,
  MarkSessionViewedRequest,
  OpenTerminalRequest,
  OrchestratorBoardResponse,
  PluginCatalogItem,
  PluginMcpPreset,
  PluginSlashCommand,
  RemoteAccessStatus,
  ResolveApprovalRequest,
  RevertCheckpointRequest,
  RunHarnessCommandRequest,
  RunPluginActionRequest,
  Session,
  SessionCheckpointRecord,
  SessionTaskState,
  SessionTriageState,
  SubagentDiffStat,
  SubagentMergeBackResult,
  SubagentRunRecord,
  SwitchHarnessRequest,
  TerminalContextChip,
  ToggleMcpServerRequest,
  TurnBlockRecord,
  TurnOptionValue,
  TurnOptionsMap,
  UpdateSessionRequest,
  UpdateTaskStateRequest,
  UpdateSessionTriageRequest,
  Workspace,
} from '@harnessmate/protocol';
import { create } from 'zustand';
import { ApiHttpError, DaemonWsClient, daemonApi } from '../api/client';
import {
  DEFAULT_WORKBENCH_ROUTE,
  type WorkbenchRouteState,
} from '../components/agy/native/shared/workbench-registry';
import { loadSavedTraitValues, persistTraitValues } from '../components/TraitsPicker';
import {
  NativeClientError,
  NativeFeedController,
  applyNativeEventBatch,
  createNativeIdempotencyKey,
  defaultNativeTransport,
  type CapabilityDescriptor,
  type NativeCanonicalEvent,
  type NativeCommandSubmitRequest,
  type NativeControlRequest,
  type NativeFeedSyncState,
  type NativeRuntimeProjection,
  type NativeRuntimeTransport,
} from '../lib/native-client';
import { isTriageEnabled, mergeTriageState, type TriageStateBySession } from '../lib/triage';

export interface NativeCommandSubmissionState {
  phase: 'idle' | 'submitting' | 'sent_awaiting_evidence' | 'confirmed' | 'conflict' | 'failed';
  message?: string;
  idempotencyKey?: string;
  updatedAt: number;
}

export interface NativeSessionRuntimeSlice {
  projection: NativeRuntimeProjection | null;
  capabilities: CapabilityDescriptor[];
  syncState: NativeFeedSyncState;
  route: WorkbenchRouteState;
  selectedModeId: string;
  commandSubmission: NativeCommandSubmissionState | null;
}

const DEFAULT_NATIVE_SYNC_STATE: NativeFeedSyncState = {
  phase: 'idle',
  resyncCount: 0,
  droppedStaleEvents: 0,
  lastError: null,
  lastSyncedAt: null,
};

function createEmptyNativeSlice(): NativeSessionRuntimeSlice {
  return {
    projection: null,
    capabilities: [],
    syncState: { ...DEFAULT_NATIVE_SYNC_STATE },
    route: { ...DEFAULT_WORKBENCH_ROUTE },
    selectedModeId: 'normal',
    commandSubmission: null,
  };
}

export type ActiveModal =
  | 'new_session'
  | 'harnesses'
  | 'plugins'
  | 'mcp'
  | 'usage'
  | 'remote_pairing'
  | 'add_workspace'
  | 'handoff'
  | 'context_preview'
  | 'command_palette'
  | 'keyboard_shortcuts'
  | 'worktrees'
  | 'session_explorer'
  | 'risk_rules'
  | 'subagent_merge_back'
  | null;

export type InspectorTab = 'task' | 'git' | 'files' | 'terminal' | 'diagnostics' | 'info' | 'plugins';

export interface ToastNotice {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
}

interface AppState {
  theme: 'dark' | 'light';
  connected: boolean;
  loading: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorFile: { sessionId: string; path: string; line?: number } | null;
  activeModal: ActiveModal;
  newSessionPresetHarnessId: string | null;
  paletteInitialQuery: string;
  explorerInitialQuery: string;

  harnesses: HarnessInfo[];
  agyAuthStates: Record<string, AgyAuthState>;
  /** Feature gate for NP-03 AGY Native Workbench UI. Defaults to `false` pre-G2 to preserve AGY-5 components. */
  agyNativeWorkbenchEnabled: boolean;
  nativeRuntimeBySession: Record<string, NativeSessionRuntimeSlice>;
  workspaces: Workspace[];
  sessions: Session[];
  pendingApprovals: ApprovalRequest[];
  triageBySession: TriageStateBySession;
  discoveredSessions: DiscoveredCliSession[];
  remoteStatus: RemoteAccessStatus | null;

  // Modular Plugin System
  plugins: InstalledPluginInfo[];
  pluginPermissionRevision: number;
  invalidatePluginPermissions: () => void;
  selectedPluginPanel: string | null;
  focusedTurn: { sessionId: string; turnId: string } | null;
  openPluginPanel: (key: string) => void;
  focusTurn: (target: AppState['focusedTurn']) => void;
  pluginCatalog: PluginCatalogItem[];
  slashCommands: Array<PluginSlashCommand & { pluginId: string; pluginName: string }>;
  mcpPresets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }>;
  pluginsDir: string;

  // MCP Hub & Usage Telemetry
  mcpServers: McpServerEntry[];
  mcpLoading: boolean;
  accountUsage: HarnessAccountUsage[];
  usageLoading: boolean;
  usageCollectedAt: number | null;
  failoverPolicy: FailoverPolicy | null;

  selectedWorkspaceId: string | null;
  harnessFilter: string | null;
  searchQuery: string;
  selectedSessionId: string | null;

  eventsBySession: Record<string, CanonicalEvent[]>;
  turnItemsBySession: Record<string, TurnBlockRecord[]>;
  liveCommandOutputByKey: Record<string, { text: string; done: boolean; updatedAt: number }>;
  traitsByScope: Record<string, Record<string, TurnOptionValue>>;
  gitBySession: Record<string, GitStatusSummary | null>;
  checkpointsBySession: Record<string, SessionCheckpointRecord[]>;
  supportsNativeRollbackBySession: Record<string, boolean>;
  lastRevertBySession: Record<string, CheckpointRevertResult | null>;
  orchestratorBoardBySession: Record<string, OrchestratorBoardResponse | undefined>;
  mergeBackReviewTarget: {
    subagent: SubagentRunRecord;
    dryRun: GitDryRunMergeResult | null;
    diffStat: SubagentDiffStat | null;
    loading: boolean;
    error: string | null;
  } | null;
  focusedCheckpointDiff: {
    sessionId: string;
    fromCheckpointId: string;
    toCheckpointId?: string;
  } | null;
  taskStateBySession: Record<string, SessionTaskState | null>;
  contextPreviewBySession: Record<string, ContextPreview | null>;
  draftTextBySession: Record<string, string>;
  draftAttachmentsBySession: Record<string, Attachment[]>;
  pendingTerminalChipsBySession: Record<string, TerminalContextChip[]>;
  terminalsByWorkspace: Record<string, ManagedTerminalTab[]>;
  terminalPtyAvailable: boolean;
  terminalOutputById: Record<string, { text: string; truncated: boolean; ringBufferBytes: number; updatedAt: number }>;
  toasts: ToastNotice[];

  // Actions
  init: () => Promise<void>;
  toggleTheme: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  openInspectorFile: (sessionId: string, path: string, line?: number) => void;
  closeInspectorFile: () => void;
  openModal: (modal: ActiveModal, presetHarnessId?: string | null) => void;
  openCommandPalette: (query?: string) => void;
  openSessionSearch: (query: string) => void;
  refreshTriage: (checkSnoozes: boolean, signal: AbortSignal) => Promise<void>;
  updateTriage: (id: string, patch: UpdateSessionTriageRequest) => Promise<void>;
  markTriageViewed: (id: string, req: MarkSessionViewedRequest, signal?: AbortSignal) => Promise<void>;
  setSelectedWorkspaceId: (id: string | null) => void;
  setHarnessFilter: (id: string | null) => void;
  setSearchQuery: (q: string) => void;

  setDraftText: (sessionId: string, text: string) => void;
  addDraftAttachment: (sessionId: string, att: Attachment) => void;
  removeDraftAttachment: (sessionId: string, attId: string) => void;
  clearDraft: (sessionId: string) => void;

  // Integrated PTY Terminal Workspace & Context Chips
  subscribeTerminalOutput: (terminalId: string) => () => void;
  refreshWorkspaceTerminals: (workspaceId: string, cwd?: string) => Promise<void>;
  openWorkspaceTerminal: (workspaceId: string, req?: OpenTerminalRequest) => Promise<ManagedTerminalTab | null>;
  closeTerminal: (workspaceId: string, terminalId: string) => Promise<void>;
  restartTerminal: (terminalId: string) => Promise<ManagedTerminalTab | null>;
  interruptTerminal: (terminalId: string) => Promise<void>;
  sendTerminalInput: (terminalId: string, data: string) => Promise<void>;
  attachTerminalContextChip: (
    sessionId: string,
    terminalId: string,
    req?: { lineStart?: number; lineEnd?: number; recentLines?: number; selectedText?: string },
  ) => Promise<TerminalContextChip | null>;
  addPendingTerminalChip: (sessionId: string, chip: TerminalContextChip) => void;
  removePendingTerminalChip: (sessionId: string, chipId: string) => void;
  clearPendingTerminalChips: (sessionId: string) => void;

  isPluginEnabled: (pluginId: string) => boolean;

  refreshAll: () => Promise<void>;
  refreshHarnesses: () => Promise<void>;
  refreshPlugins: () => Promise<void>;
  installPlugin: (req: InstallPluginRequest) => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  reloadPlugins: () => Promise<void>;
  rollbackPlugin: (id: string) => Promise<void>;
  uninstallPlugin: (id: string) => Promise<void>;

  refreshMcpServers: () => Promise<void>;
  addMcpServer: (req: AddMcpServerRequest) => Promise<void>;
  toggleMcpServer: (req: ToggleMcpServerRequest) => Promise<void>;
  removeMcpServer: (harnessId: 'codex' | 'agy' | 'claude', name: string) => Promise<void>;

  refreshAccountUsage: (forceRefresh?: boolean) => Promise<void>;
  refreshFailoverPolicy: () => Promise<void>;
  updateFailoverPolicy: (policy: FailoverPolicy) => Promise<void>;
  refreshTurnItems: (sessionId: string) => Promise<void>;
  subscribeCommandOutput: (sessionId: string, toolCallId: string) => () => void;
  setTraitValue: (scopeKey: string, key: string, value: TurnOptionValue | null) => void;
  refreshRemoteStatus: () => Promise<void>;
  loadDiscoveredSessions: (limit?: number) => Promise<boolean>;

  addWorkspace: (rootPath: string, name?: string) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createSession: (req: CreateSessionRequest) => Promise<Session>;
  importNativeSession: (req: ImportNativeSessionRequest) => Promise<Session>;
  runHarnessCommand: (id: string, req: RunHarnessCommandRequest) => Promise<HarnessCommandResult>;
  runPluginAction: (id: string, req: RunPluginActionRequest) => Promise<HarnessCommandResult>;
  updateSession: (id: string, patch: UpdateSessionRequest) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  switchHarness: (sessionId: string, req: SwitchHarnessRequest) => Promise<void>;
  failoverSession: (sessionId: string, req: FailoverRequest) => Promise<void>;
  refreshContextPreview: (sessionId: string, targetHarnessId?: string, syncMode?: ContextSyncMode) => Promise<ContextPreview | null>;
  refreshTaskState: (sessionId: string) => Promise<void>;
  updateTaskState: (sessionId: string, patch: UpdateTaskStateRequest) => Promise<void>;
  summarizeTaskState: (sessionId: string) => Promise<void>;
  handoffSession: (sourceId: string, targetHarnessId: string, targetModel?: string | null) => Promise<void>;
  sendTurn: (
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    options?: {
      omitHandoff?: boolean;
      literalText?: boolean;
      mode?: 'plugin_development';
      turnOptions?: TurnOptionsMap;
      terminalContexts?: TerminalContextChip[];
    },
  ) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  refreshPendingApprovals: () => Promise<void>;
  resolveApproval: (approvalId: string, decision: ApprovalDecision, comment?: string) => Promise<void>;
  resolveRuntimeRequest: (
    approvalId: string,
    req: ResolveApprovalRequest,
  ) => Promise<{ conflict?: boolean; resolvedBy?: string | null }>;
  forkSession: (sessionId: string, req?: ForkSessionRequest) => Promise<ForkSessionResult | null>;
  mergeBackSession: (sessionId: string, req?: MergeBackRequest) => Promise<MergeBackResult | null>;
  importSessionBundle: (req: ImportSessionBundleRequest) => Promise<Session>;
  refreshGitStatus: (sessionId: string) => Promise<void>;
  initSessionGit: (sessionId: string) => Promise<void>;
  refreshCheckpoints: (sessionId: string) => Promise<void>;
  revertCheckpoint: (
    sessionId: string,
    req: RevertCheckpointRequest,
  ) => Promise<CheckpointRevertResult | null>;
  clearLastRevert: (sessionId: string) => void;
  focusCheckpointDiff: (
    sessionId: string,
    fromCheckpointId: string,
    toCheckpointId?: string,
  ) => void;

  // Multi-Harness Parallel Orchestrator
  refreshOrchestratorBoard: (parentSessionId: string) => Promise<void>;
  delegateSubagent: (
    parentSessionId: string,
    req: DelegateSubagentRequest,
  ) => Promise<SubagentRunRecord | null>;
  stopSubagent: (subagentId: string, parentSessionId: string, reason?: string) => Promise<void>;
  openSubagentMergeReview: (subagent: SubagentRunRecord) => Promise<void>;
  closeSubagentMergeReview: () => void;
  confirmSubagentMergeBack: (
    subagentId: string,
    req: MergeSubagentRequest,
  ) => Promise<SubagentMergeBackResult | null>;
  cleanupSubagentWorktree: (
    subagentId: string,
    parentSessionId: string,
    opts?: { force?: boolean; deleteBranch?: boolean },
  ) => Promise<void>;

  registerCustomHarness: (cfg: CustomAcpHarnessConfig) => Promise<void>;
  deleteCustomHarness: (id: string) => Promise<void>;

  toggleLanAccess: (enabled: boolean) => Promise<void>;
  generatePairingCode: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;

  pushToast: (toast: Omit<ToastNotice, 'id'>) => void;
  dismissToast: (id: string) => void;

  // NP-03 AGY Native Workbench & Runtime Projection Actions
  setAgyNativeWorkbenchEnabled: (enabled: boolean) => void;
  setNativeTransport: (transport: NativeRuntimeTransport | null) => void;
  hydrateNativeRuntime: (sessionId: string) => Promise<void>;
  applyNativeEvents: (sessionId: string, events: readonly NativeCanonicalEvent[]) => void;
  ingestNativeProjectionFixture: (
    sessionId: string,
    projection: NativeRuntimeProjection,
    capabilities?: readonly CapabilityDescriptor[],
  ) => void;
  setNativeWorkbenchRoute: (sessionId: string, patch: Partial<WorkbenchRouteState>) => void;
  setNativeAgentMode: (sessionId: string, modeId: string) => void;
  submitNativeCommand: (
    sessionId: string,
    req: Omit<NativeCommandSubmitRequest, 'bindingGeneration' | 'catalogRevision' | 'idempotencyKey'> & {
      idempotencyKey?: string;
    },
  ) => Promise<boolean>;
  dispatchNativeControl: (
    sessionId: string,
    req: Omit<NativeControlRequest, 'generation' | 'idempotencyKey'> & { idempotencyKey?: string },
  ) => Promise<void>;
  clearNativeSessionState: (sessionId: string) => void;
}

let wsClient: DaemonWsClient | null = null;
const commandOutputRefCounts = new Map<string, number>();
const terminalOutputRefCounts = new Map<string, number>();
const nativeFeedControllers = new Map<string, NativeFeedController>();
let activeNativeTransport: NativeRuntimeTransport = defaultNativeTransport;

function disposeNativeFeedController(sessionId: string): void {
  const controller = nativeFeedControllers.get(sessionId);
  if (controller) {
    controller.dispose();
    nativeFeedControllers.delete(sessionId);
  }
}

function getInitialAgyNativeWorkbenchEnabled(): boolean {
  try {
    return localStorage.getItem('hm_agy_native_ui') === '1';
  } catch {
    return false;
  }
}

function contiguousCursor(events: CanonicalEvent[]): number {
  let seq = 0;
  for (const event of events) {
    if (event.seq !== seq + 1) break;
    seq = event.seq;
  }
  return seq;
}

function applyThemeToDocument(theme: 'dark' | 'light'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    localStorage.setItem('hm_desktop_theme', theme);
  } catch {
    // ignore
  }
}

function getInitialTheme(): 'dark' | 'light' {
  try {
    const saved = localStorage.getItem('hm_desktop_theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore
  }
  return 'dark';
}

export const useAppStore = create<AppState>((set, get) => {
  const initialTheme = getInitialTheme();
  applyThemeToDocument(initialTheme);

  let eventQueue: CanonicalEvent[] = [];
  let eventFlush: ReturnType<typeof setTimeout> | undefined;
  const ingestEvents = (batch: CanonicalEvent[]) => {
    const accepted: CanonicalEvent[] = [];
    set((state) => {
      const grouped = new Map<string, CanonicalEvent[]>();
      for (const event of batch) {
        const list = grouped.get(event.sessionId) ?? [];
        list.push(event);
        grouped.set(event.sessionId, list);
      }
      const eventsBySession = { ...state.eventsBySession };
      const metadata = new Map<string, CanonicalEvent[]>();
      for (const [sessionId, incoming] of grouped) {
        const existing = eventsBySession[sessionId] ?? [];
        const lastSeq = existing.at(-1)?.seq ?? 0;
        let seen: Set<number> | undefined;
        const fresh = incoming.sort((a, b) => a.seq - b.seq).filter((event, index) => {
          if (event.seq === incoming[index - 1]?.seq) return false;
          if (event.seq > lastSeq) return true;
          seen ??= new Set(existing.map(({ seq }) => seq));
          return !seen.has(event.seq);
        });
        if (!fresh.length) continue;
        const next = [...existing, ...fresh];
        if (fresh[0]!.seq < lastSeq) next.sort((a, b) => a.seq - b.seq);
        eventsBySession[sessionId] = next;
        accepted.push(...fresh);
        wsClient?.updateCursor(sessionId, fresh.at(-1)!.seq);
        const updates = fresh.filter(({ type }) => !type.endsWith('.delta'));
        if (updates.length) metadata.set(sessionId, updates);
      }
      if (!accepted.length) return state;

      const sessions = metadata.size ? state.sessions.map((s) => (metadata.get(s.id) ?? []).reduce((s, event) => {
        if (event.seq <= s.lastSeq) return s;
        let status = s.status;
        let pendingApprovalCount = s.pendingApprovalCount;
        let usage = s.usage;
        let actualModel = s.actualModel ?? null;
        let modelReroutedReason = s.modelReroutedReason ?? null;
        let harnessId = s.harnessId;
        let harnessKind = s.harnessKind;
        let participatingHarnesses = s.participatingHarnesses ?? [s.harnessId];

        if (event.type === 'session.status' && typeof event.payload.status === 'string') {
          status = event.payload.status as Session['status'];
        } else if (event.type === 'session.harness_switched') {
          if (typeof event.payload.toHarnessId === 'string') {
            harnessId = event.payload.toHarnessId;
            if (!participatingHarnesses.includes(harnessId)) {
              participatingHarnesses = [...participatingHarnesses, harnessId];
            }
          }
          if (typeof event.payload.toHarnessKind === 'string') {
            harnessKind = event.payload.toHarnessKind as HarnessKind;
          }
        } else if (event.type === 'session.model_confirmed') {
          if (typeof event.payload.actualModel === 'string') {
            actualModel = event.payload.actualModel;
          }
          modelReroutedReason =
            typeof event.payload.reason === 'string' && event.payload.reroutedFrom
              ? event.payload.reason
              : null;
        } else if (event.type === 'session.config_confirmed') {
          if (typeof event.payload.model === 'string') {
            actualModel = event.payload.thoughtLevel
              ? `${event.payload.model} (${String(event.payload.thoughtLevel)})`
              : event.payload.model;
          }
        } else if (event.type === 'session.title_updated' && typeof event.payload.title === 'string') {
          s = { ...s, title: event.payload.title };
        } else if (event.type === 'approval.requested') {
          pendingApprovalCount += 1;
          status = 'awaiting_approval';
        } else if (event.type === 'approval.resolved') {
          pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
        } else if (event.type === 'usage.updated' && event.payload.usage) {
          usage = event.payload.usage as Session['usage'];
        }

        return {
          ...s,
          harnessId,
          harnessKind,
          participatingHarnesses,
          status,
          pendingApprovalCount,
          usage,
          actualModel,
          modelReroutedReason,
          lastSeq: Math.max(s.lastSeq, event.seq),
          updatedAt: event.createdAt,
        };
      }, s)) : state.sessions;

      return {
        eventsBySession,
        sessions,
      };
    });

    const currentSelected = get().selectedSessionId;
    const relevant = accepted.filter(({ sessionId }) => sessionId === currentSelected);
    if (!currentSelected) return;
    const turnEnded = relevant.some(({ type }) => type === 'turn.completed' || type === 'turn.failed' || type === 'turn.cancelled');
    const orchestratorChanged = relevant.some(({ type }) => type.startsWith('subagent.'));
    if (orchestratorChanged) {
      void get().refreshOrchestratorBoard(currentSelected);
      void get().refreshTurnItems(currentSelected);
      if (relevant.some(({ type }) => type === 'subagent.spawned')) {
        void daemonApi.listSessions().then(({ sessions }) => set({ sessions })).catch(() => {});
      }
      if (relevant.some(({ type }) => type === 'subagent.merged')) {
        void get().refreshGitStatus(currentSelected);
      }
    }
    if (get().inspectorOpen && (turnEnded || relevant.some(({ type }) => type === 'tool.call.completed'))) {
      void get().refreshGitStatus(currentSelected);
    }
    if (turnEnded) {
      void get().refreshContextPreview(currentSelected);
      void get().refreshTurnItems(currentSelected);
      void get().refreshCheckpoints(currentSelected);
      void daemonApi.getSession(currentSelected).then(({ session, taskState }) =>
        set((state) => ({
          sessions: state.sessions.map((s) => s.id === session.id && s.lastSeq <= session.lastSeq ? session : s),
          ...(taskState ? { taskStateBySession: { ...state.taskStateBySession, [session.id]: taskState } } : {}),
        })),
      ).catch(() => {});
    } else if (relevant.some(({ type }) => type === 'checkpoint.captured' || type === 'checkpoint.reverted')) {
      void get().refreshCheckpoints(currentSelected);
      void get().refreshTurnItems(currentSelected);
      if (get().inspectorOpen) {
        void get().refreshGitStatus(currentSelected);
      }
    } else if (relevant.some(({ type }) => type === 'task.state_updated')) {
      void get().refreshTaskState(currentSelected);
    }
    if (
      accepted.some(
        ({ type }) =>
          type === 'approval.requested' ||
          type === 'approval.resolved' ||
          type === 'runtime_request.updated',
      )
    ) {
      void get().refreshPendingApprovals();
    }
  };

  const handleAttention = (item: AttentionItem) => {
    if (item.kind === 'approval_needed') {
      void get().refreshPendingApprovals();
      get().pushToast({
        kind: 'warning',
        title: `需要审批 · ${item.sessionTitle}`,
        body: item.summary,
      });
      window.harnessMateBridge?.notify(`HarnessMate 需要审批`, `${item.sessionTitle}: ${item.summary}`);
    } else if (item.kind === 'turn_failed') {
      get().pushToast({
        kind: 'error',
        title: `执行出错 · ${item.sessionTitle}`,
        body: item.summary,
      });
    } else if (item.kind === 'turn_completed' && get().selectedSessionId !== item.sessionId) {
      get().pushToast({
        kind: 'success',
        title: `已完成 · ${item.sessionTitle}`,
        body: `${item.harnessId} 已完成本轮回复`,
      });
    }
    void daemonApi.listSessions().then(({ sessions }) => set({ sessions })).catch(() => {});
  };

  const ingestTriage = (sessions: SessionTriageState[]) => {
    if (!isTriageEnabled(get().plugins)) return;
    set((state) => {
      const triageBySession = { ...state.triageBySession };
      for (const session of sessions) {
        triageBySession[session.sessionId] = mergeTriageState(triageBySession[session.sessionId], session);
      }
      return { triageBySession };
    });
  };

  return {
    theme: initialTheme,
    connected: false,
    loading: true,
    sidebarCollapsed: false,
    inspectorOpen: false,
    inspectorTab: 'task',
    activeModal: null,
    paletteInitialQuery: '',
    explorerInitialQuery: '',
    newSessionPresetHarnessId: null,

    harnesses: [],
    workspaces: [],
    sessions: [],
    pendingApprovals: [],
    triageBySession: {},
    discoveredSessions: [],
    remoteStatus: null,

    plugins: [],
    pluginPermissionRevision: 0,
    invalidatePluginPermissions: () => set((state) => ({ pluginPermissionRevision: state.pluginPermissionRevision + 1 })),
    selectedPluginPanel: null,
    focusedTurn: null,
    openPluginPanel: (key) => set({ selectedPluginPanel: key, inspectorTab: 'plugins', inspectorOpen: true }),
    focusTurn: (focusedTurn) => set({ focusedTurn }),
    pluginCatalog: [],
    slashCommands: [],
    mcpPresets: [],
    pluginsDir: '',

    mcpServers: [],
    mcpLoading: false,
    accountUsage: [],
    usageLoading: false,
    usageCollectedAt: null,
    failoverPolicy: null,

    selectedWorkspaceId: null,
    harnessFilter: null,
    searchQuery: '',
    selectedSessionId: null,

    eventsBySession: {},
    turnItemsBySession: {},
    liveCommandOutputByKey: {},
    traitsByScope: {},
    gitBySession: {},
    checkpointsBySession: {},
    supportsNativeRollbackBySession: {},
    lastRevertBySession: {},
    orchestratorBoardBySession: {},
    mergeBackReviewTarget: null,
    focusedCheckpointDiff: null,
    taskStateBySession: {},
    contextPreviewBySession: {},
    draftTextBySession: {},
    draftAttachmentsBySession: {},
    pendingTerminalChipsBySession: {},
    terminalsByWorkspace: {},
    terminalPtyAvailable: false,
    terminalOutputById: {},
    agyAuthStates: {},
    agyNativeWorkbenchEnabled: getInitialAgyNativeWorkbenchEnabled(),
    nativeRuntimeBySession: {},
    toasts: [],

    init: async () => {
      if (!wsClient) {
        wsClient = new DaemonWsClient({
          onConnected: (connected) => {
            set({ connected });
            if (connected && !get().loading) void get().refreshPlugins().catch(() => {});
          },
          onFrame: (frame) => {
            if (frame.op === 'event') {
              eventQueue.push(frame.event);
              eventFlush ??= setTimeout(() => {
                eventFlush = undefined;
                const batch = eventQueue;
                eventQueue = [];
                ingestEvents(batch);
              }, 25);
            } else if (frame.op === 'command_output') {
              const key = `${frame.sessionId}::${frame.toolCallId}`;
              set((state) => {
                const prev = state.liveCommandOutputByKey[key];
                const nextText = frame.snapshot
                  ? frame.chunk
                  : `${prev?.text ?? ''}${frame.chunk}`.slice(-256_000);
                return {
                  liveCommandOutputByKey: {
                    ...state.liveCommandOutputByKey,
                    [key]: {
                      text: nextText,
                      done: Boolean(frame.done || prev?.done),
                      updatedAt: frame.timestamp,
                    },
                  },
                };
              });
            } else if (frame.op === 'terminal_output') {
              set((state) => {
                const prev = state.terminalOutputById[frame.terminalId];
                const nextText = frame.snapshot
                  ? frame.chunk
                  : `${prev?.text ?? ''}${frame.chunk}`.slice(-524_288);
                return {
                  terminalOutputById: {
                    ...state.terminalOutputById,
                    [frame.terminalId]: {
                      text: nextText,
                      truncated: Boolean(frame.truncated || prev?.truncated),
                      ringBufferBytes: frame.ringBufferBytes ?? prev?.ringBufferBytes ?? nextText.length,
                      updatedAt: frame.timestamp,
                    },
                  },
                };
              });
            } else if (frame.op === 'terminal_status') {
              const term = frame.terminal;
              set((state) => {
                const existing = state.terminalsByWorkspace[term.workspaceId] ?? [];
                if (frame.event === 'closed') {
                  const nextOutput = { ...state.terminalOutputById };
                  delete nextOutput[term.terminalId];
                  return {
                    terminalsByWorkspace: {
                      ...state.terminalsByWorkspace,
                      [term.workspaceId]: existing.filter((t) => t.terminalId !== term.terminalId),
                    },
                    terminalOutputById: nextOutput,
                  };
                }
                const nextList = [
                  ...existing.filter((t) => t.terminalId !== term.terminalId),
                  term,
                ].sort((a, b) => a.createdAt - b.createdAt);
                return {
                  terminalsByWorkspace: {
                    ...state.terminalsByWorkspace,
                    [term.workspaceId]: nextList,
                  },
                };
              });
            } else if (frame.op === 'attention') {
              handleAttention(frame.item);
            } else if (frame.op === 'plugins_changed') {
              void get().refreshPlugins().catch(() => {});
            } else if (frame.op === 'agy_auth_state') {
              set((state) => {
                const nextAuth = {
                  ...state.agyAuthStates,
                  [frame.state.instanceId]: frame.state,
                };
                if (frame.state.phase === 'unauthenticated' || frame.state.phase === 'failed') {
                  const nextNative = { ...state.nativeRuntimeBySession };
                  for (const sess of state.sessions) {
                    if (sess.harnessId === frame.state.instanceId) {
                      disposeNativeFeedController(sess.id);
                      delete nextNative[sess.id];
                    }
                  }
                  return { agyAuthStates: nextAuth, nativeRuntimeBySession: nextNative };
                }
                return { agyAuthStates: nextAuth };
              });
            } else if (frame.op === 'triage_updated' && isTriageEnabled(get().plugins)) {
              ingestTriage([frame.session]);
              if (frame.event) {
                const session = get().sessions.find(({ id }) => id === frame.session.sessionId);
                if (session) get().pushToast({ kind: 'info', title: '延后提醒已到期', body: session.title });
              }
            }
          },
        });
        wsClient.connect();
      }
      await get().refreshAll();
    },

    toggleTheme: () => {
      const next = get().theme === 'dark' ? 'light' : 'dark';
      applyThemeToDocument(next);
      set({ theme: next });
    },

    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
    setInspectorOpen: (open) => {
      set({ inspectorOpen: open });
      const sid = get().selectedSessionId;
      if (open && sid) {
        void get().refreshGitStatus(sid);
      }
    },
    inspectorFile: null,
    setInspectorTab: (tab) => set({ inspectorTab: tab }),
    openInspectorFile: (sessionId, path, line) => set({
      inspectorFile: { sessionId, path, line }, inspectorTab: 'files', inspectorOpen: true,
    }),
    closeInspectorFile: () => set({ inspectorFile: null }),
    openModal: (modal, presetHarnessId = null) =>
      set({ activeModal: modal, newSessionPresetHarnessId: presetHarnessId, paletteInitialQuery: '', explorerInitialQuery: '' }),
    openCommandPalette: (query = '') =>
      set({ activeModal: 'command_palette', paletteInitialQuery: query }),
    openSessionSearch: (query) =>
      set({ activeModal: 'session_explorer', explorerInitialQuery: query }),
    refreshTriage: async (checkSnoozes, signal) => {
      const result = await (checkSnoozes ? daemonApi.checkTriageSnoozes(signal) : daemonApi.getTriageState(signal));
      if (!signal.aborted) ingestTriage(result.sessions);
    },
    updateTriage: async (id, patch) => {
      const { session } = await daemonApi.updateSessionTriage(id, patch);
      ingestTriage([session]);
    },
    markTriageViewed: async (id, req, signal) => {
      const { session } = await daemonApi.markSessionViewed(id, req, signal);
      if (!signal?.aborted) ingestTriage([session]);
    },
    setSelectedWorkspaceId: (id) => set({ selectedWorkspaceId: id }),
    setHarnessFilter: (id) => set({ harnessFilter: id }),
    setSearchQuery: (q) => set({ searchQuery: q }),

    setDraftText: (sessionId, text) =>
      set((s) => ({ draftTextBySession: { ...s.draftTextBySession, [sessionId]: text } })),

    addDraftAttachment: (sessionId, att) =>
      set((s) => {
        const curr = s.draftAttachmentsBySession[sessionId] ?? [];
        if (curr.some((x) => x.id === att.id || (att.relativePath && x.relativePath === att.relativePath))) {
          return s;
        }
        return {
          draftAttachmentsBySession: {
            ...s.draftAttachmentsBySession,
            [sessionId]: [...curr, att],
          },
        };
      }),

    removeDraftAttachment: (sessionId, attId) =>
      set((s) => ({
        draftAttachmentsBySession: {
          ...s.draftAttachmentsBySession,
          [sessionId]: (s.draftAttachmentsBySession[sessionId] ?? []).filter((a) => a.id !== attId),
        },
      })),

    clearDraft: (sessionId) =>
      set((s) => ({
        draftTextBySession: { ...s.draftTextBySession, [sessionId]: '' },
        draftAttachmentsBySession: { ...s.draftAttachmentsBySession, [sessionId]: [] },
        pendingTerminalChipsBySession: { ...s.pendingTerminalChipsBySession, [sessionId]: [] },
      })),

    subscribeTerminalOutput: (terminalId) => {
      const prev = terminalOutputRefCounts.get(terminalId) ?? 0;
      terminalOutputRefCounts.set(terminalId, prev + 1);
      if (prev === 0) {
        wsClient?.subscribeTerminal(terminalId);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (terminalOutputRefCounts.get(terminalId) ?? 1) - 1;
        if (count <= 0) {
          terminalOutputRefCounts.delete(terminalId);
          wsClient?.unsubscribeTerminal(terminalId);
        } else {
          terminalOutputRefCounts.set(terminalId, count);
        }
      };
    },

    refreshWorkspaceTerminals: async (workspaceId, cwd) => {
      try {
        const res = await daemonApi.listWorkspaceTerminals(workspaceId, cwd);
        set((state) => ({
          terminalPtyAvailable: res.ptyAvailable,
          terminalsByWorkspace: {
            ...state.terminalsByWorkspace,
            [workspaceId]: res.terminals,
          },
        }));
      } catch {
        // ignore if workspace unavailable
      }
    },

    openWorkspaceTerminal: async (workspaceId, req) => {
      try {
        const res = await daemonApi.openWorkspaceTerminal(workspaceId, req);
        set((state) => {
          const existing = state.terminalsByWorkspace[workspaceId] ?? [];
          return {
            terminalsByWorkspace: {
              ...state.terminalsByWorkspace,
              [workspaceId]: [...existing.filter((t) => t.terminalId !== res.terminal.terminalId), res.terminal],
            },
            terminalOutputById: {
              ...state.terminalOutputById,
              [res.terminal.terminalId]: {
                text: res.snapshot,
                truncated: false,
                ringBufferBytes: res.terminal.ringBufferBytes ?? 0,
                updatedAt: Date.now(),
              },
            },
          };
        });
        return res.terminal;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '启动工作区终端失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    closeTerminal: async (workspaceId, terminalId) => {
      try {
        await daemonApi.closeTerminal(terminalId);
        set((state) => {
          const nextOutput = { ...state.terminalOutputById };
          delete nextOutput[terminalId];
          return {
            terminalsByWorkspace: {
              ...state.terminalsByWorkspace,
              [workspaceId]: (state.terminalsByWorkspace[workspaceId] ?? []).filter(
                (t) => t.terminalId !== terminalId,
              ),
            },
            terminalOutputById: nextOutput,
          };
        });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '关闭终端失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    restartTerminal: async (terminalId) => {
      try {
        const { terminal } = await daemonApi.restartTerminal(terminalId);
        set((state) => ({
          terminalsByWorkspace: {
            ...state.terminalsByWorkspace,
            [terminal.workspaceId]: (state.terminalsByWorkspace[terminal.workspaceId] ?? []).map((t) =>
              t.terminalId === terminal.terminalId ? terminal : t,
            ),
          },
        }));
        return terminal;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '重启终端失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    interruptTerminal: async (terminalId) => {
      try {
        await daemonApi.interruptTerminal(terminalId);
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '中断终端命令失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    sendTerminalInput: async (terminalId, data) => {
      if (wsClient?.sendTerminalInput(terminalId, data)) return;
      try {
        await daemonApi.sendTerminalInput(terminalId, data);
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '终端输入发送失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    attachTerminalContextChip: async (sessionId, terminalId, req) => {
      try {
        const { chip } = await daemonApi.createTerminalContextChip(terminalId, {
          ...req,
          sessionId,
        });
        get().addPendingTerminalChip(sessionId, chip);
        get().pushToast({
          kind: 'success',
          title: `已附加 ${chip.terminalTitle} (lines ${chip.lineStart}–${chip.lineEnd})`,
        });
        return chip;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '提取终端上下文失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    addPendingTerminalChip: (sessionId, chip) =>
      set((state) => {
        const curr = state.pendingTerminalChipsBySession[sessionId] ?? [];
        if (curr.some((item) => item.id === chip.id)) return state;
        return {
          pendingTerminalChipsBySession: {
            ...state.pendingTerminalChipsBySession,
            [sessionId]: [...curr.slice(-11), chip],
          },
        };
      }),

    removePendingTerminalChip: (sessionId, chipId) =>
      set((state) => ({
        pendingTerminalChipsBySession: {
          ...state.pendingTerminalChipsBySession,
          [sessionId]: (state.pendingTerminalChipsBySession[sessionId] ?? []).filter(
            (item) => item.id !== chipId,
          ),
        },
      })),

    clearPendingTerminalChips: (sessionId) =>
      set((state) => ({
        pendingTerminalChipsBySession: {
          ...state.pendingTerminalChipsBySession,
          [sessionId]: [],
        },
      })),

    isPluginEnabled: (pluginId) => {
      const found = get().plugins.find((p) => p.id === pluginId);
      return found ? found.enabled && (!found.runtimeState || found.runtimeState === 'ACTIVE') : true;
    },

    refreshAll: async () => {
      set({ loading: true });
      try {
        const [hRes, wRes, sRes, rRes, pRes, aRes] = await Promise.all([
          daemonApi.listHarnesses(false),
          daemonApi.listWorkspaces(),
          daemonApi.listSessions(),
          daemonApi.getRemoteStatus(),
          daemonApi.listPlugins(),
          daemonApi.listPendingApprovals().catch(() => ({ approvals: [] as ApprovalRequest[] })),
        ]);
        set({
          harnesses: hRes.harnesses,
          workspaces: wRes.workspaces,
          sessions: sRes.sessions,
          pendingApprovals: aRes.approvals,
          remoteStatus: rRes,
          plugins: pRes.plugins,
          pluginCatalog: pRes.catalog,
          slashCommands: pRes.slashCommands,
          mcpPresets: pRes.mcpPresets,
          pluginsDir: pRes.pluginsDir,
          loading: false,
        });
      } catch (err) {
        set({ loading: false });
        get().pushToast({
          kind: 'error',
          title: '无法连接本地 Daemon',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshHarnesses: async () => {
      const { harnesses } = await daemonApi.listHarnesses(true);
      set({ harnesses });
      get().pushToast({ kind: 'success', title: '已刷新本机 CLI 与动态模型目录' });
    },

    refreshPlugins: async () => {
      const pRes = await daemonApi.listPlugins();
      set({
        plugins: pRes.plugins,
        pluginCatalog: pRes.catalog,
        slashCommands: pRes.slashCommands,
        mcpPresets: pRes.mcpPresets,
        pluginsDir: pRes.pluginsDir,
      });
    },

    installPlugin: async (req) => {
      const pRes = await daemonApi.installPlugin(req);
      set({
        plugins: pRes.plugins,
        pluginCatalog: pRes.catalog,
        slashCommands: pRes.slashCommands,
        mcpPresets: pRes.mcpPresets,
        pluginsDir: pRes.pluginsDir,
        ...(pRes.harnesses ? { harnesses: pRes.harnesses } : {}),
      });
      get().pushToast({ kind: 'success', title: '插件已安装' });
    },

    togglePlugin: async (id, enabled) => {
      const pRes = await daemonApi.togglePlugin(id, enabled);
      set({
        plugins: pRes.plugins,
        pluginCatalog: pRes.catalog,
        slashCommands: pRes.slashCommands,
        mcpPresets: pRes.mcpPresets,
        ...(pRes.harnesses ? { harnesses: pRes.harnesses } : {}),
      });
      get().pushToast({ kind: 'info', title: enabled ? '已启用插件' : '已停用插件' });
    },

    reloadPlugins: async () => {
      const pRes = await daemonApi.reloadPlugins();
      set({
        plugins: pRes.plugins,
        pluginCatalog: pRes.catalog,
        slashCommands: pRes.slashCommands,
        mcpPresets: pRes.mcpPresets,
        ...(pRes.harnesses ? { harnesses: pRes.harnesses } : {}),
      });
      const failures = pRes.plugins.filter((plugin) => plugin.loadError);
      get().pushToast(failures.length
        ? { kind: 'warning', title: '部分插件加载异常', body: failures.map((plugin) => plugin.name).join('、') }
        : { kind: 'success', title: '插件已热重载' });
    },

    rollbackPlugin: async (id) => {
      const pRes = await daemonApi.rollbackPlugin(id);
      set({
        plugins: pRes.plugins, pluginCatalog: pRes.catalog, slashCommands: pRes.slashCommands,
        mcpPresets: pRes.mcpPresets, ...(pRes.harnesses ? { harnesses: pRes.harnesses } : {}),
      });
      get().pushToast({ kind: 'success', title: '已切换到上一版插件' });
    },
    uninstallPlugin: async (id) => {
      const pRes = await daemonApi.uninstallPlugin(id);
      set({
        plugins: pRes.plugins,
        pluginCatalog: pRes.catalog,
        slashCommands: pRes.slashCommands,
        mcpPresets: pRes.mcpPresets,
        ...(pRes.harnesses ? { harnesses: pRes.harnesses } : {}),
      });
      get().pushToast({ kind: 'info', title: '已卸载外部插件' });
    },

    refreshMcpServers: async () => {
      set({ mcpLoading: true });
      try {
        const res = await daemonApi.listMcpServers();
        set({ mcpServers: res.servers, mcpPresets: res.presets, mcpLoading: false });
      } catch (err) {
        set({ mcpLoading: false });
        get().pushToast({
          kind: 'error',
          title: '读取 MCP 列表失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    addMcpServer: async (req) => {
      const res = await daemonApi.addMcpServer(req);
      set({ mcpServers: res.servers });
      const okTargets = res.results.filter((r) => r.ok).map((r) => r.harnessId);
      const failTargets = res.results.filter((r) => !r.ok);
      if (okTargets.length > 0) {
        get().pushToast({
          kind: 'success',
          title: `MCP "${req.name}" 已写入 ${okTargets.join(', ')}`,
          body: failTargets.length > 0 ? `失败: ${failTargets.map((f) => `${f.harnessId}(${f.message})`).join('; ')}` : undefined,
        });
      } else {
        get().pushToast({
          kind: 'error',
          title: `MCP "${req.name}" 安装失败`,
          body: failTargets.map((f) => `${f.harnessId}: ${f.message}`).join('\n'),
        });
      }
    },

    toggleMcpServer: async (req) => {
      const res = await daemonApi.toggleMcpServer(req);
      set({ mcpServers: res.servers });
      get().pushToast({
        kind: res.result.ok ? 'success' : 'warning',
        title: res.result.ok ? `已更新 ${req.name}` : '操作未生效',
        body: res.result.message,
      });
    },

    removeMcpServer: async (harnessId, name) => {
      const res = await daemonApi.removeMcpServer(harnessId, name);
      set({ mcpServers: res.servers });
      get().pushToast({
        kind: res.result.ok ? 'info' : 'error',
        title: res.result.ok ? `已从 ${harnessId} 移除 ${name}` : '移除失败',
        body: res.result.message,
      });
    },

    refreshAccountUsage: async (forceRefresh = false) => {
      set({ usageLoading: true });
      try {
        const res = await daemonApi.getAccountUsage(forceRefresh);
        set({ accountUsage: res.accounts, usageCollectedAt: res.collectedAt, usageLoading: false });
      } catch (err) {
        set({ usageLoading: false });
        get().pushToast({
          kind: 'error',
          title: '采集账号与用量失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshFailoverPolicy: async () => {
      try {
        const { policy } = await daemonApi.getFailoverPolicy();
        set({ failoverPolicy: policy });
      } catch {
        // ignore if failover plugin disabled
      }
    },

    updateFailoverPolicy: async (policy) => {
      const res = await daemonApi.updateFailoverPolicy(policy);
      set({ failoverPolicy: res.policy });
      get().pushToast({ kind: 'success', title: '已保存 Failover 接力策略' });
    },

    refreshTurnItems: async (sessionId) => {
      try {
        const { items } = await daemonApi.getSessionTurnItems(sessionId, { limit: 1000 });
        set((state) => ({
          turnItemsBySession: { ...state.turnItemsBySession, [sessionId]: items },
        }));
      } catch {
        // ignore if endpoint unavailable
      }
    },

    subscribeCommandOutput: (sessionId, toolCallId) => {
      const key = `${sessionId}::${toolCallId}`;
      const prev = commandOutputRefCounts.get(key) ?? 0;
      commandOutputRefCounts.set(key, prev + 1);
      if (prev === 0) {
        wsClient?.subscribeCommandOutput(sessionId, toolCallId);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (commandOutputRefCounts.get(key) ?? 1) - 1;
        if (count <= 0) {
          commandOutputRefCounts.delete(key);
          wsClient?.unsubscribeCommandOutput(sessionId, toolCallId);
        } else {
          commandOutputRefCounts.set(key, count);
        }
      };
    },

    setTraitValue: (scopeKey, key, value) => {
      set((state) => {
        const existing = state.traitsByScope[scopeKey] ?? loadSavedTraitValues(scopeKey);
        const next = { ...existing };
        if (value === null || value === undefined || value === '') {
          delete next[key];
        } else {
          next[key] = value;
        }
        persistTraitValues(scopeKey, next);
        return {
          traitsByScope: { ...state.traitsByScope, [scopeKey]: next },
        };
      });
    },

    refreshRemoteStatus: async () => {
      const remoteStatus = await daemonApi.getRemoteStatus();
      set({ remoteStatus });
    },

    loadDiscoveredSessions: async (limit) => {
      const { sessions, hasMore } = await daemonApi.discoverLocalCliSessions(limit);
      set({ discoveredSessions: sessions });
      return hasMore;
    },

    addWorkspace: async (rootPath, name) => {
      const { workspace } = await daemonApi.createWorkspace(rootPath, name);
      set((state) => ({
        workspaces: [workspace, ...state.workspaces.filter((w) => w.id !== workspace.id)],
      }));
      get().pushToast({ kind: 'success', title: `已添加工作区 ${workspace.name}` });
      return workspace;
    },

    deleteWorkspace: async (id) => {
      await daemonApi.deleteWorkspace(id);
      set((state) => ({
        workspaces: state.workspaces.filter((w) => w.id !== id),
        sessions: state.sessions.filter((s) => s.workspaceId !== id),
        selectedWorkspaceId: state.selectedWorkspaceId === id ? null : state.selectedWorkspaceId,
      }));
    },

    selectSession: async (sessionId) => {
      const prevSessionId = get().selectedSessionId;
      if (prevSessionId && prevSessionId !== sessionId) {
        disposeNativeFeedController(prevSessionId);
      }
      set({ selectedSessionId: sessionId, focusedTurn: null });
      if (!sessionId) return;

      const existing = get().eventsBySession[sessionId] ?? [];
      try {
        let cursor = contiguousCursor(existing);
        let snapshot: number | undefined;
        const history: CanonicalEvent[] = [];
        do {
          const page = await daemonApi.getSessionEvents(sessionId, cursor);
          snapshot ??= page.lastSeq;
          if (page.events.length === 0) {
            if (cursor < snapshot) throw new Error('历史分页未到达会话末尾');
            break;
          }
          history.push(...page.events);
          cursor = page.events.at(-1)!.seq;
        } while (cursor < snapshot);
        if (get().selectedSessionId !== sessionId) return;
        const detail = await daemonApi.getSession(sessionId);
        if (get().selectedSessionId !== sessionId) return;
        if (history.length) {
          set((state) => {
            const bySeq = new Map([...history, ...(state.eventsBySession[sessionId] ?? [])]
              .map((event) => [event.seq, event]));
            return { eventsBySession: { ...state.eventsBySession,
              [sessionId]: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
            } };
          });
        }
        set((state) => ({
          sessions: state.sessions.some((s) => s.id === sessionId)
            ? state.sessions.map((s) => (s.id === sessionId && s.lastSeq <= detail.session.lastSeq ? detail.session : s))
            : [detail.session, ...state.sessions],
          ...(detail.taskState
            ? { taskStateBySession: { ...state.taskStateBySession, [sessionId]: detail.taskState } }
            : {}),
        }));

        const latestList = get().eventsBySession[sessionId] ?? [];
        wsClient?.subscribeSession(sessionId, contiguousCursor(latestList));

        void get().refreshContextPreview(sessionId);
        void get().refreshTurnItems(sessionId);
        void get().refreshCheckpoints(sessionId);
        void get().refreshFailoverPolicy();
        if (get().agyNativeWorkbenchEnabled && detail.session.harnessKind === 'agy') {
          void get().hydrateNativeRuntime(sessionId);
        }
        if (get().inspectorOpen) {
          void get().refreshGitStatus(sessionId);
        }
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '加载会话事件失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    createSession: async (req) => {
      const { session } = await daemonApi.createSession(req);
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeModal: null,
        newSessionPresetHarnessId: null,
      }));
      await get().selectSession(session.id);
      return session;
    },

    importNativeSession: async (req) => {
      const { session } = await daemonApi.importNativeSession(req);
      const { workspaces } = await daemonApi.listWorkspaces();
      set((state) => ({
        workspaces,
        sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
        selectedWorkspaceId: session.workspaceId,
        activeModal: null,
        newSessionPresetHarnessId: null,
      }));
      await get().selectSession(session.id);
      return session;
    },

    runHarnessCommand: async (id, req) => {
      const result = await daemonApi.runHarnessCommand(id, req);
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === id && session.lastSeq <= result.session.lastSeq
          ? result.session : session),
      }));
      return result;
    },

    runPluginAction: async (id, req) => {
      const result = await daemonApi.runPluginAction(id, req);
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === id && session.lastSeq <= result.session.lastSeq
          ? result.session : session),
      }));
      return result;
    },

    updateSession: async (id, patch) => {
      const { session } = await daemonApi.updateSession(id, patch);
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? session : s)),
      }));
    },

    deleteSession: async (id) => {
      await daemonApi.deleteSession(id);
      disposeNativeFeedController(id);
      set((state) => {
        const nextSessions = state.sessions.filter((s) => s.id !== id);
        const nextNative = { ...state.nativeRuntimeBySession };
        delete nextNative[id];
        return {
          sessions: nextSessions,
          nativeRuntimeBySession: nextNative,
          selectedSessionId:
            state.selectedSessionId === id ? (nextSessions[0]?.id ?? null) : state.selectedSessionId,
        };
      });
    },

    switchHarness: async (sessionId, req) => {
      try {
        const res = await daemonApi.switchHarness(sessionId, req);
        // Switching account/profile or harness clears stale native subscriptions and selections
        get().clearNativeSessionState(sessionId);
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? res.session : s)),
          contextPreviewBySession: {
            ...state.contextPreviewBySession,
            [sessionId]: res.contextPreview,
          },
        }));
        if (get().agyNativeWorkbenchEnabled && res.session.harnessKind === 'agy') {
          void get().hydrateNativeRuntime(sessionId);
        }
        const preview = res.contextPreview;
        const syncSummary = preview.syncNeeded
          ? `发送下条消息时将自动同步 ${preview.unsyncedTurnCount} 轮增量上下文 (~${preview.estimatedTokens} tokens)`
          : '该引擎已保有最新上下文，无需重复同步';
        get().pushToast({
          kind: 'success',
          title: `已无缝切换至 ${req.targetHarnessId}`,
          body: syncSummary,
        });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '切换引擎失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    failoverSession: async (sessionId, req) => {
      try {
        const res = await daemonApi.failoverSession(sessionId, req);
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? res.session : s)),
        }));
        void get().refreshContextPreview(sessionId);
        get().pushToast({
          kind: 'success',
          title: `已一键切换至 ${req.targetHarnessId} 续接任务`,
          body: res.retriedTurnId ? '已带着完整上下文自动重发中断的指令。' : '可继续发送后续指令。',
        });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '接力续跑失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshContextPreview: async (sessionId, targetHarnessId, syncMode) => {
      try {
        const { preview } = await daemonApi.getContextPreview(sessionId, targetHarnessId, syncMode);
        set((state) => ({
          contextPreviewBySession: {
            ...state.contextPreviewBySession,
            [sessionId]: preview,
          },
        }));
        return preview;
      } catch {
        return null;
      }
    },

    refreshTaskState: async (sessionId) => {
      try {
        const { taskState } = await daemonApi.getTaskState(sessionId);
        set((state) => ({
          taskStateBySession: { ...state.taskStateBySession, [sessionId]: taskState },
        }));
      } catch {
        // ignore
      }
    },

    updateTaskState: async (sessionId, patch) => {
      try {
        const { taskState } = await daemonApi.updateTaskState(sessionId, patch);
        set((state) => ({
          taskStateBySession: { ...state.taskStateBySession, [sessionId]: taskState },
        }));
        void get().refreshContextPreview(sessionId);
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '更新任务账本失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    summarizeTaskState: async (sessionId) => {
      try {
        const { taskState } = await daemonApi.summarizeTaskState(sessionId);
        set((state) => ({
          taskStateBySession: { ...state.taskStateBySession, [sessionId]: taskState },
        }));
        void get().refreshContextPreview(sessionId);
        get().pushToast({
          kind: 'success',
          title: '已提炼历史对话摘要并同步至 .harnessmate/task-ledger.md',
        });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '提炼摘要失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    handoffSession: async (sourceId, targetHarnessId, targetModel) => {
      const res = await daemonApi.handoffSession(sourceId, targetHarnessId, targetModel);
      set((state) => ({
        sessions: [res.session, ...state.sessions],
        activeModal: null,
        draftTextBySession: {
          ...state.draftTextBySession,
          [res.session.id]: res.handoffPrompt,
        },
      }));
      await get().selectSession(res.session.id);
      get().pushToast({
        kind: 'success',
        title: `已生成跨 Harness 接力会话 (${targetHarnessId})`,
        body: '上下文摘要已预填到输入框，检查后可直接发送。',
      });
    },

    sendTurn: async (sessionId, text, attachments, options) => {
      try {
        await daemonApi.sendTurn(sessionId, text, attachments, options);
        const { session } = await daemonApi.getSession(sessionId);
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? session : s)),
        }));
      } catch (err) {
        if (options?.terminalContexts?.length) {
          for (const chip of options.terminalContexts) {
            get().addPendingTerminalChip(sessionId, chip);
          }
        }
        get().pushToast({
          kind: 'error',
          title: '发送失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    interruptSession: async (sessionId) => {
      await daemonApi.interruptSession(sessionId);
      get().pushToast({ kind: 'info', title: '已发送中断信号' });
    },

    refreshPendingApprovals: async () => {
      try {
        const { approvals } = await daemonApi.listPendingApprovals();
        set({ pendingApprovals: approvals });
      } catch {
        // ignore
      }
    },

    resolveApproval: async (approvalId, decision, comment) => {
      await get().resolveRuntimeRequest(approvalId, { decision, comment, resolvedBy: 'desktop' });
    },

    resolveRuntimeRequest: async (approvalId, req) => {
      try {
        await daemonApi.resolveRuntimeRequest(approvalId, req);
        set((state) => ({
          pendingApprovals: state.pendingApprovals.filter((a) => a.id !== approvalId),
        }));
        void get().refreshPendingApprovals();
        return { conflict: false };
      } catch (err) {
        if (err instanceof ApiHttpError && err.status === 409) {
          const resolvedBy =
            typeof err.payload?.resolvedBy === 'string' ? err.payload.resolvedBy : null;
          set((state) => ({
            pendingApprovals: state.pendingApprovals.filter((a) => a.id !== approvalId),
          }));
          const actorLabel = resolvedBy === 'mobile' ? '移动端' : '其他客户端';
          get().pushToast({
            kind: 'info',
            title: `该请求已由${actorLabel}处理`,
            body: '已自动收起重复审批条。',
          });
          return { conflict: true, resolvedBy };
        }
        get().pushToast({
          kind: 'error',
          title: '审批提交失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return { conflict: false };
      }
    },

    forkSession: async (sessionId, req) => {
      try {
        const res = await daemonApi.forkSession(sessionId, req ?? {});
        set((state) => ({
          sessions: [res.session, ...state.sessions.filter((s) => s.id !== res.session.id)],
        }));
        await get().selectSession(res.session.id);
        get().pushToast({
          kind: 'success',
          title: res.modeUsed === 'native' ? '已创建原生分叉子会话' : '已创建便携分叉子会话',
          body: res.notice,
        });
        return res;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '创建分叉失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    mergeBackSession: async (sessionId, req) => {
      try {
        const res = await daemonApi.mergeBackSession(sessionId, req ?? {});
        await get().selectSession(res.parentSessionId);
        void get().refreshTurnItems(res.parentSessionId);
        get().pushToast({
          kind: 'success',
          title: '已将分叉结论合并回父会话',
          body: `已注入 fork_delta_summary（seq #${res.eventSeq}）`,
        });
        return res;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '合并回父会话失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    importSessionBundle: async (req) => {
      const { session } = await daemonApi.importSessionBundle(req);
      const { workspaces } = await daemonApi.listWorkspaces();
      set((state) => ({
        workspaces,
        sessions: [session, ...state.sessions.filter((s) => s.id !== session.id)],
        selectedWorkspaceId: session.workspaceId,
      }));
      await get().selectSession(session.id);
      get().pushToast({
        kind: 'success',
        title: `已还原会话 · ${session.title}`,
      });
      return session;
    },

    refreshGitStatus: async (sessionId) => {
      try {
        const { git } = await daemonApi.getSessionGit(sessionId);
        set((state) => ({
          gitBySession: { ...state.gitBySession, [sessionId]: git },
        }));
      } catch {
        // ignore
      }
    },

    initSessionGit: async (sessionId) => {
      try {
        const res = await daemonApi.initSessionGit(sessionId);
        set((state) => ({
          gitBySession: { ...state.gitBySession, [sessionId]: res.git },
        }));
        get().pushToast({ kind: 'success', title: res.result.message });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '初始化 Git 仓库失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    refreshCheckpoints: async (sessionId) => {
      try {
        const res = await daemonApi.listCheckpoints(sessionId);
        set((state) => ({
          checkpointsBySession: {
            ...state.checkpointsBySession,
            [sessionId]: res.checkpoints,
          },
          supportsNativeRollbackBySession: {
            ...state.supportsNativeRollbackBySession,
            [sessionId]: res.supportsNativeRollback,
          },
        }));
      } catch {
        // ignore if checkpoints service disabled
      }
    },

    revertCheckpoint: async (sessionId, req) => {
      try {
        const res = await daemonApi.revertCheckpoint(sessionId, req);
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? res.session : s)),
          checkpointsBySession: {
            ...state.checkpointsBySession,
            [sessionId]: res.checkpoints,
          },
          lastRevertBySession: {
            ...state.lastRevertBySession,
            [sessionId]: res.result,
          },
        }));
        void get().refreshGitStatus(sessionId);
        void get().refreshTurnItems(sessionId);
        get().pushToast({
          kind: 'success',
          title: `已回滚至 Turn #${res.result.targetTurnSeq}`,
          body: `还原 ${res.result.filesRestored} 个文件，清理 ${res.result.untrackedRemoved} 个新增文件。可随时点击顶部横幅“撤销回滚”。`,
        });
        return res.result;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '回滚检查点失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    clearLastRevert: (sessionId) =>
      set((state) => ({
        lastRevertBySession: { ...state.lastRevertBySession, [sessionId]: null },
      })),

    focusCheckpointDiff: (sessionId, fromCheckpointId, toCheckpointId) =>
      set({
        inspectorOpen: true,
        inspectorTab: 'git',
        focusedCheckpointDiff: { sessionId, fromCheckpointId, toCheckpointId },
      }),

    refreshOrchestratorBoard: async (parentSessionId) => {
      try {
        const board = await daemonApi.listSubagents(parentSessionId);
        set((state) => ({
          orchestratorBoardBySession: {
            ...state.orchestratorBoardBySession,
            [parentSessionId]: board,
          },
        }));
      } catch {
        // ignore transient refresh failure
      }
    },

    delegateSubagent: async (parentSessionId, req) => {
      try {
        const { subagent } = await daemonApi.delegateSubagent(parentSessionId, req);
        await Promise.all([
          get().refreshOrchestratorBoard(parentSessionId),
          daemonApi.listSessions().then(({ sessions }) => set({ sessions })).catch(() => {}),
        ]);
        get().pushToast({
          kind: 'success',
          title: `已派生并行子任务：${subagent.roleTitle}`,
          body: subagent.branchName ? `隔离分支 ${subagent.branchName}` : '只读并行模式',
        });
        return subagent;
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '派生并行子任务失败',
          body: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    stopSubagent: async (subagentId, parentSessionId, reason) => {
      try {
        await daemonApi.stopSubagent(subagentId, reason);
        await get().refreshOrchestratorBoard(parentSessionId);
        get().pushToast({
          kind: 'info',
          title: '已停止子任务',
          body: '未合回的 Worktree 分支已完整保留。',
        });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '停止子任务失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    openSubagentMergeReview: async (subagent) => {
      set({
        activeModal: 'subagent_merge_back',
        mergeBackReviewTarget: {
          subagent,
          dryRun: null,
          diffStat: subagent.diffStat ?? null,
          loading: true,
          error: null,
        },
      });
      try {
        const res = await daemonApi.dryRunMergeSubagent(subagent.subagentId);
        set({
          mergeBackReviewTarget: {
            subagent: res.subagent,
            dryRun: res.dryRun,
            diffStat: res.diffStat,
            loading: false,
            error: null,
          },
        });
      } catch (err) {
        set((state) => ({
          mergeBackReviewTarget: state.mergeBackReviewTarget
            ? {
                ...state.mergeBackReviewTarget,
                loading: false,
                error: err instanceof Error ? err.message : String(err),
              }
            : null,
        }));
      }
    },

    closeSubagentMergeReview: () =>
      set((state) => ({
        activeModal: state.activeModal === 'subagent_merge_back' ? null : state.activeModal,
        mergeBackReviewTarget: null,
      })),

    confirmSubagentMergeBack: async (subagentId, req) => {
      try {
        const res = await daemonApi.mergeBackSubagent(subagentId, req);
        const parentSessionId = get().mergeBackReviewTarget?.subagent.parentSessionId ?? get().selectedSessionId;
        if (parentSessionId) {
          await Promise.all([
            get().refreshOrchestratorBoard(parentSessionId),
            get().refreshTurnItems(parentSessionId),
            get().refreshGitStatus(parentSessionId),
          ]);
        }
        set({
          activeModal: null,
          mergeBackReviewTarget: null,
        });
        get().pushToast({
          kind: 'success',
          title: '子任务分支合回成功',
          body: res.message,
        });
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => ({
          mergeBackReviewTarget: state.mergeBackReviewTarget
            ? { ...state.mergeBackReviewTarget, error: message }
            : null,
        }));
        get().pushToast({
          kind: 'error',
          title: '合回被阻断或失败',
          body: message,
        });
        return null;
      }
    },

    cleanupSubagentWorktree: async (subagentId, parentSessionId, opts) => {
      try {
        await daemonApi.cleanupSubagentWorktree(subagentId, opts);
        await get().refreshOrchestratorBoard(parentSessionId);
        get().pushToast({ kind: 'success', title: '已安全清理子任务 Worktree' });
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '清理 Worktree 失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },

    registerCustomHarness: async (cfg) => {
      const { harnesses } = await daemonApi.registerCustomHarness(cfg);
      set({ harnesses });
      get().pushToast({ kind: 'success', title: `已添加 ACP Harness: ${cfg.displayName}` });
    },

    deleteCustomHarness: async (id) => {
      const { harnesses } = await daemonApi.deleteCustomHarness(id);
      set({ harnesses });
      get().pushToast({ kind: 'info', title: '已移除自定义 Harness' });
    },

    toggleLanAccess: async (enabled) => {
      const res = await daemonApi.updateRemoteConfig(enabled);
      set({ remoteStatus: res });
      get().pushToast({
        kind: 'info',
        title: enabled ? '已开启局域网远程访问' : '已关闭局域网远程访问',
        body: res.restartRequired ? '请重启桌面端 Daemon 以应用网络监听地址变更。' : undefined,
      });
    },

    generatePairingCode: async () => {
      const res = await daemonApi.createPairingCode();
      set({ remoteStatus: res });
    },

    revokeDevice: async (deviceId) => {
      await daemonApi.revokePairedDevice(deviceId);
      await get().refreshRemoteStatus();
      get().pushToast({ kind: 'info', title: '已吊销该移动设备的远程访问凭证' });
    },

    pushToast: (toast) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      set((state) => ({ toasts: [...state.toasts.slice(-3), { ...toast, id }] }));
      window.setTimeout(() => {
        get().dismissToast(id);
      }, 4500);
    },

    dismissToast: (id) =>
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

    setAgyNativeWorkbenchEnabled: (enabled) => {
      try {
        if (enabled) localStorage.setItem('hm_agy_native_ui', '1');
        else localStorage.removeItem('hm_agy_native_ui');
      } catch {
        // ignore storage errors
      }
      if (!enabled) {
        for (const sid of [...nativeFeedControllers.keys()]) {
          disposeNativeFeedController(sid);
        }
      }
      set({ agyNativeWorkbenchEnabled: enabled });
    },

    setNativeTransport: (transport) => {
      activeNativeTransport = transport ?? defaultNativeTransport;
    },

    hydrateNativeRuntime: async (sessionId) => {
      if (!get().agyNativeWorkbenchEnabled) return;
      disposeNativeFeedController(sessionId);
      const controller = new NativeFeedController({
        sessionId,
        transport: activeNativeTransport,
        onUpdate: ({ projection, capabilities, syncState }) => {
          set((state) => {
            const prev = state.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
            return {
              nativeRuntimeBySession: {
                ...state.nativeRuntimeBySession,
                [sessionId]: {
                  ...prev,
                  projection,
                  capabilities,
                  syncState,
                },
              },
            };
          });
        },
      });
      nativeFeedControllers.set(sessionId, controller);
      await controller.hydrate();
    },

    applyNativeEvents: (sessionId, events) => {
      if (events.length === 0) return;
      const controller = nativeFeedControllers.get(sessionId);
      if (controller) {
        controller.enqueueLiveEvents(events);
        return;
      }
      set((state) => {
        const prev = state.nativeRuntimeBySession[sessionId];
        if (!prev?.projection) return state;
        const outcome = applyNativeEventBatch(prev.projection, events);
        if (outcome.appliedCount === 0 && outcome.droppedStaleGenerationCount === 0) return state;
        return {
          nativeRuntimeBySession: {
            ...state.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              projection: outcome.projection,
              capabilities: outcome.updatedCapabilities ?? prev.capabilities,
              syncState: {
                ...prev.syncState,
                droppedStaleEvents:
                  prev.syncState.droppedStaleEvents + outcome.droppedStaleGenerationCount,
              },
            },
          },
        };
      });
    },

    ingestNativeProjectionFixture: (sessionId, projection, capabilities) =>
      set((state) => {
        const prev = state.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
        return {
          nativeRuntimeBySession: {
            ...state.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              projection,
              capabilities: capabilities ? [...capabilities] : prev.capabilities,
              syncState: {
                phase: 'live',
                resyncCount: 0,
                droppedStaleEvents: 0,
                lastError: null,
                lastSyncedAt: Date.now(),
              },
            },
          },
        };
      }),

    setNativeWorkbenchRoute: (sessionId, patch) =>
      set((state) => {
        const prev = state.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
        return {
          nativeRuntimeBySession: {
            ...state.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              route: { ...prev.route, ...patch },
            },
          },
        };
      }),

    setNativeAgentMode: (sessionId, modeId) =>
      set((state) => {
        const prev = state.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
        return {
          nativeRuntimeBySession: {
            ...state.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              selectedModeId: modeId,
              commandSubmission: null,
            },
          },
        };
      }),

    submitNativeCommand: async (sessionId, req) => {
      const slice = get().nativeRuntimeBySession[sessionId];
      const projection = slice?.projection;
      if (!projection) {
        get().pushToast({
          kind: 'warning',
          title: '原生运行时尚未就绪',
          body: '请刷新能力探测或先以普通对话模式发送。',
        });
        return false;
      }
      // Reuse pending idempotency key on repeated click while submitting
      const key =
        req.idempotencyKey ??
        (slice.commandSubmission?.phase === 'submitting' && slice.commandSubmission.idempotencyKey
          ? slice.commandSubmission.idempotencyKey
          : createNativeIdempotencyKey(req.capabilityId, req.actionKey));

      set((state) => {
        const prev = state.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
        return {
          nativeRuntimeBySession: {
            ...state.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              commandSubmission: {
                phase: 'submitting',
                message: '正在发起原生命令…',
                idempotencyKey: key,
                updatedAt: Date.now(),
              },
            },
          },
        };
      });

      try {
        const res = await activeNativeTransport.submitCommand(sessionId, {
          bindingGeneration: projection.binding.generation,
          catalogRevision: projection.capabilitiesRevision,
          capabilityId: req.capabilityId,
          actionKey: req.actionKey,
          args: req.args,
          idempotencyKey: key,
        });
        set((state) => {
          const prev = state.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
          return {
            nativeRuntimeBySession: {
              ...state.nativeRuntimeBySession,
              [sessionId]: {
                ...prev,
                commandSubmission: {
                  phase: res.modeEvidenceObserved ? 'confirmed' : 'sent_awaiting_evidence',
                  message: res.modeEvidenceObserved
                    ? '已收到原生模式确认'
                    : '已发送，等待原生确认',
                  idempotencyKey: key,
                  updatedAt: Date.now(),
                },
              },
            },
          };
        });
        return true;
      } catch (err) {
        const isConflict = err instanceof NativeClientError && err.status === 409;
        set((state) => {
          const prev = state.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
          return {
            nativeRuntimeBySession: {
              ...state.nativeRuntimeBySession,
              [sessionId]: {
                ...prev,
                commandSubmission: {
                  phase: isConflict ? 'conflict' : 'failed',
                  message: isConflict
                    ? '会话绑定或状态已变化，已保留草稿并正在刷新能力目录。'
                    : err instanceof Error
                      ? err.message
                      : String(err),
                  idempotencyKey: key,
                  updatedAt: Date.now(),
                },
              },
            },
          };
        });
        if (isConflict) {
          void get().hydrateNativeRuntime(sessionId);
        }
        return false;
      }
    },

    dispatchNativeControl: async (sessionId, req) => {
      const projection = get().nativeRuntimeBySession[sessionId]?.projection;
      if (!projection) {
        throw new Error('原生运行时未连接，无法执行控制操作');
      }
      const key =
        req.idempotencyKey ?? createNativeIdempotencyKey(`ctrl_${req.target.type}`, req.action);
      await activeNativeTransport.dispatchControl(sessionId, {
        generation: projection.binding.generation,
        target: req.target,
        action: req.action,
        expectedRevision: req.expectedRevision,
        idempotencyKey: key,
      });
    },

    clearNativeSessionState: (sessionId) => {
      disposeNativeFeedController(sessionId);
      set((state) => {
        if (!state.nativeRuntimeBySession[sessionId]) return state;
        const next = { ...state.nativeRuntimeBySession };
        delete next[sessionId];
        return { nativeRuntimeBySession: next };
      });
    },
  };
});
