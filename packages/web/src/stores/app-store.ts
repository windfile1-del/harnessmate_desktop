import { openContractPage } from '../api/plugin-navigation';
import { withPluginDevelopmentContext } from '../api/client';
import type { TriageSnoozeExpired } from '@harnessmate/protocol';
import { showSessionNotification } from '../lib/desktop-notifications';
import type {
  AddMcpServerRequest,
  AgyAuthState,
  ApplicationSwitchResult,
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
import { ApiHttpError, DaemonWsClient, daemonApi, getSharedDaemonWs, type HarnessServiceScope } from '../api/client';
import { useKernelStore } from './kernel-store';
import {
  HISTORY_IMPORT_CONTRACT,
  HISTORY_IMPORT_PAGE_SLOT_ID,
  SESSION_SEARCH_CONTRACT,
  SESSION_SEARCH_PAGE_SLOT_ID,
  WORKSPACE_FILES_CONTRACT,
  getPluginInstanceId,
  isContractAvailableClientSide,
  isPluginInstanceReady,
  makeWorkspacePageKey,
  pluginProvidesContract,
  resolveServiceSelectionClientSide,
  type NavigateToFileRequest,
  type NavigateToFileResult,
  type ServiceResolutionV1,
} from '../api/peer-contracts';
import { defaultPeerWorkspaceTransport } from '../api/peer-workspace-client';
import { parseFileLink } from '../lib/file-links';
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
  type ActivityId,
  type CapabilityDescriptor,
  type NativeAgentId,
  type NativeCanonicalEvent,
  type NativeCommandSubmitRequest,
  type NativeControlRequest,
  type NativeFeedSyncState,
  type NativeRuntimeProjection,
  type NativeRuntimeTransport,
  type NativeTimelinePageResponse,
  type NativeWorkflowResourcePageResponse,
  type RuntimeBinding,
  type WorkflowId,
} from '../lib/native-client';
import { isTriageEnabled, mergeTriageState, type TriageStateBySession } from '../lib/triage';

export interface NativeCommandSubmissionState {
  phase: 'idle' | 'submitting' | 'sent_awaiting_evidence' | 'confirmed' | 'conflict' | 'failed';
  message?: string;
  idempotencyKey?: string;
  intentSignature?: string;
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

export interface AppState {
  theme: 'dark' | 'light';
  connected: boolean;
  loading: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorFile: { sessionId: string; path: string; line?: number; column?: number } | null;
  inspectorFileError: {
    sessionId: string | null;
    path: string;
    line?: number;
    column?: number;
    code: string;
    message: string;
  } | null;
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
  triageBySession: TriageStateBySession;
  discoveredSessions: DiscoveredCliSession[];
  remoteStatus: RemoteAccessStatus | null;

  // Modular Plugin System
  plugins: InstalledPluginInfo[];
  emptyComposition: boolean;
  sessionBindingsBySession: Record<string, Record<string, string | null>>;
  workspaceBindingsByWorkspace: Record<string, Record<string, string | null>>;
  compositionBindings: Record<string, string>;
  compositionEntries: Array<{ id: string; name: string; disabled: boolean }>;
  serviceResolutionsByKey: Record<string, ServiceResolutionV1>;
  pluginPermissionRevision: number;
  invalidatePluginPermissions: () => void;
  selectedPluginPanel: string | null;
  focusedTurn: { sessionId: string; turnId: string; itemId?: string } | null;
  openPluginPanel: (key: string) => void;
  focusTurn: (target: AppState['focusedTurn']) => void;
  slashCommands: Array<PluginSlashCommand & { pluginId: string; pluginName: string }>;
  mcpPresets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }>;
  searchPageInitialQuery: string;
  searchPageTargetInstanceId: string | null;
  importPageTargetInstanceId: string | null;
  importPageInitialTab: 'native' | 'bundle';

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
  activePluginPage: string | null;
  activePluginPageContext: Record<string, unknown>;
  setActivePluginPage: (page: string | null, context?: Record<string, unknown>) => void;

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
  disposeLayoutSubscriptions: () => void;
  switchApplicationLayout: (instanceId: string | null) => Promise<ApplicationSwitchResult>;
  toggleTheme: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  openInspectorFile: (sessionId: string, path: string, line?: number, column?: number) => NavigateToFileResult;
  navigateToFile: (req: NavigateToFileRequest) => NavigateToFileResult;
  resolveContractLocal: (
    contract: string,
    opts?: { sessionId?: string; workspaceId?: string; explicitInstanceId?: string; allowSingleCandidate?: boolean },
  ) => ServiceResolutionV1;
  closeInspectorFile: () => void;
  openModal: (modal: ActiveModal, presetHarnessId?: string | null) => void;
  openCommandPalette: (query?: string) => void;
  openSessionSearch: (query: string) => void;
  openSessionSearchPage: (opts?: { query?: string; instanceId?: string | null }) => void;
  openHistoryImportPage: (opts?: { instanceId?: string | null; tab?: 'native' | 'bundle' }) => void;
  openArchivedSession: (sessionId: string) => Promise<void>;
  syncImportedSession: (sessionId: string) => Promise<Session | null>;
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
  refreshCompositionBindings: (workspaceId?: string) => Promise<void>;
  refreshSessionBindings: (sessionId: string) => Promise<void>;
  setSessionBinding: (sessionId: string, contract: string, instanceId: string | null) => Promise<void>;
  refreshWorkspaceBindings: (workspaceId: string) => Promise<void>;
  setWorkspaceBinding: (workspaceId: string, contract: string, instanceId: string | null) => Promise<void>;
  resolveService: (
    contract: string,
    opts?: {
      workspaceId?: string;
      sessionId?: string;
      explicitInstanceId?: string;
      allowSingleCandidate?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<ServiceResolutionV1>;

  refreshMcpServers: (scope?: HarnessServiceScope) => Promise<void>;
  addMcpServer: (req: AddMcpServerRequest, scope?: HarnessServiceScope) => Promise<Array<{ harnessId: string; ok: boolean; message: string }>>;
  toggleMcpServer: (req: ToggleMcpServerRequest, scope?: HarnessServiceScope) => Promise<void>;
  removeMcpServer: (harnessId: string, name: string, scope?: HarnessServiceScope) => Promise<void>;

  refreshAccountUsage: (forceRefresh?: boolean, scope?: HarnessServiceScope) => Promise<void>;
  refreshFailoverPolicy: (scope?: HarnessServiceScope) => Promise<void>;
  updateFailoverPolicy: (policy: FailoverPolicy, scope?: HarnessServiceScope) => Promise<void>;
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
      expectedBinding?: RuntimeBinding;
      expectedCapabilitiesRevision?: number;
    },
  ) => Promise<boolean>;
  dispatchNativeControl: (
    sessionId: string,
    req: Omit<NativeControlRequest, 'generation' | 'idempotencyKey'> & {
      idempotencyKey?: string;
      expectedBinding?: RuntimeBinding;
    },
  ) => Promise<void>;
  loadNativeTimeline: (
    sessionId: string,
    scope: { kind: 'activity' | 'agent'; id: string },
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeTimelinePageResponse>;
  loadNativeWorkflowResource: (
    sessionId: string,
    workflowId: WorkflowId,
    resource: string,
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeWorkflowResourcePageResponse>;
  clearNativeSessionState: (sessionId: string) => void;
}

let wsClient: DaemonWsClient | null = null;
let sharedWsObserverCleanup: (() => void) | null = null;
const commandOutputRefCounts = new Map<string, number>();
const terminalOutputRefCounts = new Map<string, number>();
const nativeFeedControllers = new Map<string, NativeFeedController>();
const nativeScopeEpochBySession = new Map<string, number>();
const inFlightCommandKeyByIntent = new Map<string, string>();
let nativeGlobalScopeEpoch = 0;
let activeNativeTransport: NativeRuntimeTransport = defaultNativeTransport;
let nativeKeyCounter = 0;

function getNativeScopeEpoch(sessionId: string): number {
  return nativeScopeEpochBySession.get(sessionId) ?? 0;
}

function bumpNativeScopeEpoch(sessionId: string): number {
  const next = getNativeScopeEpoch(sessionId) + 1;
  nativeScopeEpochBySession.set(sessionId, next);
  for (const intentKey of [...inFlightCommandKeyByIntent.keys()]) {
    if (intentKey.startsWith(`${sessionId}|`)) {
      inFlightCommandKeyByIntent.delete(intentKey);
    }
  }
  return next;
}

function canonicalizeArgs(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeArgs).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeArgs(v)}`).join(',')}}`;
}

function buildNativeCommandIntentSignature(params: {
  sessionId: string;
  instanceId: string;
  runtimeId: string;
  generation: string;
  catalogRevision: number;
  capabilityId: string;
  actionKey: string;
  args: Record<string, unknown>;
}): string {
  return [
    params.sessionId,
    params.instanceId,
    params.runtimeId,
    params.generation,
    String(params.catalogRevision),
    params.capabilityId,
    params.actionKey,
    canonicalizeArgs(params.args),
  ].join('|');
}

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

  const viewMutation = (sessionId: string, operation: Record<string, unknown>): void => {
    const selected=get().resolveContractLocal('chat.view.v1',{sessionId});
    const plugin=get().plugins.find(item=>(item.instanceId??item.id)===selected.instanceId);
    if(selected.status!=='ready'||!plugin){get().pushToast({kind:'error',title:'聊天插件不可用'});return;}
    void daemonApi.callUiService(selected.instanceId!,{runId:plugin.runId??plugin.packageDigest,
      contract:'chat.view.v1',method:'editViewState',instanceId:selected.instanceId,
      sessionId,args:[{sessionId,operation}]}).catch(error=>get().pushToast({kind:'error',title:'更新聊天草稿失败',body:String(error)}));
  };

  const handleSnoozeReminder = (event: TriageSnoozeExpired, toast: boolean) => {
    const session = get().sessions.find(({ id }) => id === event.sessionId);
    if (!session) return;
    const key = 'snooze:' + event.sessionId + ':' + event.snoozedUntilMs + ':' + event.createdAt;
    if (toast && !snoozeToasts.has(key)) {
      snoozeToasts.add(key);
      if (snoozeToasts.size > 256) snoozeToasts.delete(snoozeToasts.values().next().value!);
      get().pushToast({ kind: 'info', title: '延后提醒已到期', body: session.title });
    }
    showSessionNotification(get(), session, {
      kind: 'snooze', sessionId: session.id, identity: event.snoozedUntilMs + ':' + event.createdAt,
    });
  };
  const snoozeToasts = new Set<string>();

  const handleAttention = (item: AttentionItem) => {
    if (item.kind === 'turn_failed') {
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
    triageBySession: {},
    discoveredSessions: [],
    remoteStatus: null,

    plugins: [],
    emptyComposition: false,
    sessionBindingsBySession: {},
    workspaceBindingsByWorkspace: {},
    compositionBindings: {},
    compositionEntries: [],
    serviceResolutionsByKey: {},
    pluginPermissionRevision: 0,
    invalidatePluginPermissions: () => set((state) => ({ pluginPermissionRevision: state.pluginPermissionRevision + 1 })),
    selectedPluginPanel: null,
    focusedTurn: null,
    openPluginPanel: (key) => set({ selectedPluginPanel: key, inspectorTab: 'plugins', inspectorOpen: true }),
    focusTurn: (focusedTurn) => set({ focusedTurn }),
    slashCommands: [],
    mcpPresets: [],
    searchPageInitialQuery: '',
    searchPageTargetInstanceId: null,
    importPageTargetInstanceId: null,
    importPageInitialTab: 'native',

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
    activePluginPage: null,
    activePluginPageContext: {},
    setActivePluginPage: (activePluginPage, context) => set({ activePluginPage, activePluginPageContext: context ?? {} }),

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

    disposeLayoutSubscriptions: () => {
      sharedWsObserverCleanup?.();
      sharedWsObserverCleanup = null;
    },

    switchApplicationLayout: (instanceId) =>
      useKernelStore.getState().switchApplicationEntry(instanceId),

    init: async () => {
      const handleWsFrame = (frame: import('@harnessmate/protocol').WsServerFrame) => {
        if (frame.op === 'command_output') {
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
                  bumpNativeScopeEpoch(sess.id);
                  delete nextNative[sess.id];
                }
              }
              return { agyAuthStates: nextAuth, nativeRuntimeBySession: nextNative };
            }
            return { agyAuthStates: nextAuth };
          });
        } else if (frame.op === 'triage_updated' && isTriageEnabled(get().plugins)) {
          ingestTriage([frame.session]);
          if (frame.event) handleSnoozeReminder(frame.event, true);
        }
      };

      const existingShared = getSharedDaemonWs();
      if (existingShared) {
        wsClient = existingShared;
        sharedWsObserverCleanup?.();
        sharedWsObserverCleanup = existingShared.observeFrames(handleWsFrame);
      } else if (!wsClient) {
        wsClient = new DaemonWsClient({
          onConnected: (connected) => {
            set({ connected });
            if (connected && !get().loading) void get().refreshPlugins().catch(() => {});
          },
          onFrame: handleWsFrame,
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
    inspectorFileError: null,
    setInspectorTab: (tab) => set({ inspectorTab: tab }),
    resolveContractLocal: (contract, opts) => {
      const state = get();
      return resolveServiceSelectionClientSide({
        contract,
        explicitInstanceId: opts?.explicitInstanceId,
        allowSingleCandidate: opts?.allowSingleCandidate ?? true,
        plugins: state.plugins,
        sessionBindings: opts?.sessionId ? state.sessionBindingsBySession[opts.sessionId] : undefined,
        workspaceBindings: opts?.workspaceId ? state.workspaceBindingsByWorkspace[opts.workspaceId] : undefined,
        compositionBindings: state.compositionBindings,
        compositionEntries: state.compositionEntries,
      });
    },
    navigateToFile: (req) => {
      const state = get();
      const rawPath = typeof req.path === 'string' ? req.path.trim() : '';
      const explicitLine =
        typeof req.line === 'number' && Number.isSafeInteger(req.line) && req.line > 0 ? req.line : undefined;
      const targetSession =
        (req.sessionId ? state.sessions.find((s) => s.id === req.sessionId) : undefined) ??
        (state.selectedSessionId ? state.sessions.find((s) => s.id === state.selectedSessionId) : undefined) ??
        (req.workspaceId ? state.sessions.find((s) => s.workspaceId === req.workspaceId) : undefined);
      const targetSessionId = req.sessionId ?? targetSession?.id ?? state.selectedSessionId ?? null;
      const targetWorkspaceId = req.workspaceId ?? targetSession?.workspaceId ?? null;

      if (!rawPath) {
        const message = '文件路径为空，无法在右侧工作区文件区打开；当前会话已保留。';
        set({
          inspectorFileError: {
            sessionId: targetSessionId,
            path: rawPath,
            line: explicitLine,
            code: 'E_INVALID_INPUT',
            message,
          },
          ...(req.openInspector !== false ? { inspectorTab: 'files', inspectorOpen: true } : {}),
        });
        return {
          opened: false,
          sessionId: targetSessionId,
          workspaceId: targetWorkspaceId,
          path: rawPath,
          line: explicitLine,
          errorCode: 'E_INVALID_INPUT',
          message,
        };
      }

      const parsed = parseFileLink(rawPath);
      if (!parsed) {
        const message = /^https?:\/\//i.test(rawPath)
          ? '外部 HTTP 链接不支持在工作区文件预览中打开；当前会话已保留。'
          : '无效的文件链接路径；当前会话已保留。';
        set({
          inspectorFileError: {
            sessionId: targetSessionId,
            path: rawPath,
            line: explicitLine,
            code: 'E_INVALID_INPUT',
            message,
          },
          ...(req.openInspector !== false ? { inspectorTab: 'files', inspectorOpen: true } : {}),
        });
        return {
          opened: false,
          sessionId: targetSessionId,
          workspaceId: targetWorkspaceId,
          path: rawPath,
          line: explicitLine,
          errorCode: 'E_INVALID_INPUT',
          message,
        };
      }

      const normalizedPath = parsed.path;
      const normalizedLine = explicitLine ?? parsed.line;
      const explicitColumn =
        typeof req.column === 'number' && Number.isSafeInteger(req.column) && req.column > 0
          ? req.column
          : undefined;
      const normalizedColumn = explicitColumn ?? parsed.column;

      if (!targetSessionId) {
        const message = '当前没有可定位的工作区会话，无法打开文件；当前会话状态已保留。';
        set({
          inspectorFileError: {
            sessionId: null,
            path: normalizedPath,
            line: normalizedLine,
            code: 'E_SESSION_NOT_FOUND',
            message,
          },
        });
        return {
          opened: false,
          sessionId: null,
          workspaceId: targetWorkspaceId,
          path: normalizedPath,
          line: normalizedLine,
          errorCode: 'E_SESSION_NOT_FOUND',
          message,
        };
      }

      const filesResolution = resolveServiceSelectionClientSide({
        contract: WORKSPACE_FILES_CONTRACT,
        allowSingleCandidate: true,
        plugins: state.plugins,
        sessionBindings: state.sessionBindingsBySession[targetSessionId],
        workspaceBindings: targetWorkspaceId ? state.workspaceBindingsByWorkspace[targetWorkspaceId] : undefined,
        compositionBindings: state.compositionBindings,
        compositionEntries: state.compositionEntries,
      });
      const filesAvailable = isContractAvailableClientSide({
        contract: WORKSPACE_FILES_CONTRACT,
        legacyPluginId: 'core.terminal-runner',
        allowSingleCandidate: true,
        plugins: state.plugins,
        sessionBindings: state.sessionBindingsBySession[targetSessionId],
        workspaceBindings: targetWorkspaceId ? state.workspaceBindingsByWorkspace[targetWorkspaceId] : undefined,
        compositionBindings: state.compositionBindings,
        compositionEntries: state.compositionEntries,
      });

      const shouldCloseWorkspacePage = Boolean(state.activePluginPage && req.openInspector !== false);
      if (state.plugins.length > 0 && !filesAvailable) {
        const errorCode =
          filesResolution.status === 'disabled' ||
          filesResolution.status === 'unconfigured' ||
          filesResolution.status === 'unavailable'
            ? 'E_PLUGIN_DISABLED'
            : 'E_SERVICE_UNAVAILABLE';
        const message = '工作区文件浏览能力当前已停用或不可用；当前会话已保留。';
        set({
          inspectorFile: { sessionId: targetSessionId, path: normalizedPath, line: normalizedLine },
          inspectorFileError: {
            sessionId: targetSessionId,
            path: normalizedPath,
            line: normalizedLine,
            code: errorCode,
            message,
          },
          ...(req.openInspector !== false ? { inspectorTab: 'files', inspectorOpen: true } : {}),
          ...(shouldCloseWorkspacePage ? { activePluginPage: null } : {}),
        });
        return {
          opened: false,
          sessionId: targetSessionId,
          workspaceId: targetWorkspaceId,
          path: normalizedPath,
          line: normalizedLine,
          errorCode,
          message,
        };
      }

      set({
        inspectorFile: { sessionId: targetSessionId, path: normalizedPath, line: normalizedLine, column: normalizedColumn },
        inspectorFileError: null,
        ...(req.openInspector !== false ? { inspectorTab: 'files', inspectorOpen: true } : {}),
        ...(shouldCloseWorkspacePage ? { activePluginPage: null } : {}),
      });
      return {
        opened: true,
        sessionId: targetSessionId,
        workspaceId: targetWorkspaceId,
        path: normalizedPath,
        line: normalizedLine,
        column: normalizedColumn,
      };
    },
    openInspectorFile: (sessionId, path, line, column) =>
      get().navigateToFile({ sessionId, path, line, column, openInspector: true, preserveSession: true }),
    closeInspectorFile: () => set({ inspectorFile: null, inspectorFileError: null }),
    openModal: (modal, presetHarnessId = null) =>
      set({ activeModal: modal, newSessionPresetHarnessId: presetHarnessId, paletteInitialQuery: '', explorerInitialQuery: '' }),
    openCommandPalette: (query = '') =>
      set({ activeModal: 'command_palette', paletteInitialQuery: query }),
    openSessionSearchPage: (opts) => {
      const state = get();
      const searchProviders = state.plugins.filter((p) =>
        pluginProvidesContract(p, SESSION_SEARCH_CONTRACT),
      );
      const readyProviders = searchProviders.filter(isPluginInstanceReady);
      const explicit = opts?.instanceId ?? null;
      const boundId =
        (state.selectedWorkspaceId
          ? state.workspaceBindingsByWorkspace[state.selectedWorkspaceId]?.[SESSION_SEARCH_CONTRACT]
          : undefined) ?? state.compositionBindings[SESSION_SEARCH_CONTRACT];
      const chosenId =
        explicit ??
        (boundId && readyProviders.some((p) => getPluginInstanceId(p) === boundId) ? boundId : null) ??
        (readyProviders[0] ? getPluginInstanceId(readyProviders[0]) : null) ??
        boundId ??
        (searchProviders[0] ? getPluginInstanceId(searchProviders[0]) : null);
      if (chosenId) {
        set({
          activeModal: null,
          activePluginPage: makeWorkspacePageKey(chosenId, SESSION_SEARCH_PAGE_SLOT_ID),
          searchPageInitialQuery: opts?.query ?? '',
          searchPageTargetInstanceId: explicit ?? chosenId,
        });
        return;
      }
      set({
        activeModal: 'session_explorer',
        explorerInitialQuery: opts?.query ?? '',
      });
    },
    openHistoryImportPage: (opts) => {
      const state = get();
      const importProviders = state.plugins.filter((p) =>
        pluginProvidesContract(p, HISTORY_IMPORT_CONTRACT),
      );
      const readyProviders = importProviders.filter(isPluginInstanceReady);
      const explicit = opts?.instanceId ?? null;
      const boundId =
        (state.selectedWorkspaceId
          ? state.workspaceBindingsByWorkspace[state.selectedWorkspaceId]?.[HISTORY_IMPORT_CONTRACT]
          : undefined) ?? state.compositionBindings[HISTORY_IMPORT_CONTRACT];
      const chosenId =
        explicit ??
        (boundId && readyProviders.some((p) => getPluginInstanceId(p) === boundId) ? boundId : null) ??
        (readyProviders[0] ? getPluginInstanceId(readyProviders[0]) : null) ??
        boundId ??
        (importProviders[0] ? getPluginInstanceId(importProviders[0]) : null);
      if (chosenId) {
        set({
          activeModal: null,
          activePluginPage: makeWorkspacePageKey(chosenId, HISTORY_IMPORT_PAGE_SLOT_ID),
          importPageTargetInstanceId: explicit ?? chosenId,
          importPageInitialTab: opts?.tab ?? 'native',
        });
        return;
      }
      set({ activeModal: 'session_explorer', explorerInitialQuery: '' });
    },
    openSessionSearch: (query) => {
      const state = get();
      const hasSearchPlugin = state.plugins.some((p) =>
        pluginProvidesContract(p, SESSION_SEARCH_CONTRACT),
      );
      if (hasSearchPlugin) {
        state.openSessionSearchPage({ query });
        return;
      }
      set({ activeModal: 'session_explorer', explorerInitialQuery: query });
    },
    openArchivedSession: async (sessionId) => {
      set({ activeModal: null, activePluginPage: null });
      await get().selectSession(sessionId);
    },
    syncImportedSession: async (sessionId) => {
      const [{ workspaces }, { sessions }] = await Promise.all([
        daemonApi.listWorkspaces(),
        daemonApi.listSessions(),
      ]);
      const found = sessions.find((s) => s.id === sessionId) ?? null;
      set((state) => ({
        workspaces,
        sessions: found
          ? [found, ...state.sessions.filter((item) => item.id !== found.id)]
          : sessions,
      }));
      return found;
    },
    refreshTriage: async (checkSnoozes, signal) => {
      if (checkSnoozes) {
        const { sessions, expired, reminders } = await daemonApi.checkTriageSnoozes(signal);
        if (signal.aborted) return;
        ingestTriage(sessions);
        for (const event of expired) handleSnoozeReminder(event, true);
        for (const event of reminders ?? []) handleSnoozeReminder(event, false);
      } else {
        const { sessions } = await daemonApi.getTriageState(signal);
        if (!signal.aborted) ingestTriage(sessions);
      }
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

    setDraftText: (sessionId, text) => viewMutation(sessionId, {type: 'setText', text}),

    addDraftAttachment: (sessionId, attachment) => viewMutation(sessionId, {type: 'addAttachment', attachment}),

    removeDraftAttachment: (sessionId, id) => viewMutation(sessionId, {type: 'removeAttachment', id}),

    clearDraft: (sessionId) => viewMutation(sessionId, {type: 'clear'}),

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

    addPendingTerminalChip: (sessionId, chip) => viewMutation(sessionId, {type: 'addTerminalContext', chip}),

    removePendingTerminalChip: (sessionId, id) => viewMutation(sessionId, {type: 'removeTerminalContext', id}),

    clearPendingTerminalChips: (sessionId) => viewMutation(sessionId, {type: 'clearTerminalContexts'}),

    isPluginEnabled: (pluginId) => {
      const found = get().plugins.find((p) => p.id === pluginId);
      return found ? found.enabled && (!found.runtimeState || found.runtimeState === 'ACTIVE') : true;
    },

    refreshAll: async () => {
      set({ loading: true });
      try {
        const [hRes, wRes, sRes, rRes] = await Promise.all([
          daemonApi.listHarnesses(false),
          daemonApi.listWorkspaces(),
          daemonApi.listSessions(),
          daemonApi.getRemoteStatus(),
          get().refreshPlugins(),
        ]);
        set({
          harnesses: hRes.harnesses,
          workspaces: wRes.workspaces,
          sessions: sRes.sessions,
          remoteStatus: rRes,
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
        emptyComposition: Boolean(pRes.emptyComposition),
        slashCommands: pRes.slashCommands,
        mcpPresets: pRes.mcpPresets,
        serviceResolutionsByKey: {},
      });
      void get().refreshCompositionBindings(get().selectedWorkspaceId ?? undefined).catch(() => {});
    },

    refreshCompositionBindings: async (workspaceId) => {
      if (typeof daemonApi.getPluginComposition !== 'function') return;
      const comp = await daemonApi.getPluginComposition(workspaceId);
      set({
        compositionBindings: comp.bindings ?? {},
        compositionEntries: (comp.entries ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          disabled: e.disabled,
        })),
      });
    },

    refreshWorkspaceBindings: async (workspaceId) => {
      if (typeof daemonApi.getWorkspaceBindings !== 'function') return;
      const res = await daemonApi.getWorkspaceBindings(workspaceId);
      const map: Record<string, string | null> = {};
      for (const item of res.bindings ?? []) {
        map[item.contract] = item.instanceId;
      }
      set((state) => ({
        workspaceBindingsByWorkspace: {
          ...state.workspaceBindingsByWorkspace,
          [workspaceId]: map,
        },
      }));
    },

    setWorkspaceBinding: async (workspaceId, contract, instanceId) => {
      const res = await daemonApi.setWorkspaceBinding(workspaceId, contract, instanceId);
      set((state) => ({
        workspaceBindingsByWorkspace: {
          ...state.workspaceBindingsByWorkspace,
          [workspaceId]: {
            ...(state.workspaceBindingsByWorkspace[workspaceId] ?? {}),
            [contract]: res.resolved.instanceId,
          },
        },
        serviceResolutionsByKey: {},
      }));
      get().pushToast({
        kind: 'success',
        title: instanceId ? '已更新工作区能力绑定' : '已恢复工作区默认能力绑定',
      });
    },

    resolveService: async (contract, opts) => {
      const state = get();
      const workspaceId = opts?.workspaceId;
      const sessionId = opts?.sessionId;
      const explicitInstanceId = opts?.explicitInstanceId;
      const resolution = await defaultPeerWorkspaceTransport.resolveServiceSelection(contract, {
        workspaceId,
        sessionId,
        explicitInstanceId,
        allowSingleCandidate: opts?.allowSingleCandidate ?? true,
        plugins: state.plugins,
        sessionBindings: sessionId ? state.sessionBindingsBySession[sessionId] : undefined,
        workspaceBindings: workspaceId ? state.workspaceBindingsByWorkspace[workspaceId] : undefined,
        compositionBindings: state.compositionBindings,
        compositionEntries: state.compositionEntries,
        signal: opts?.signal,
      });
      const cacheKey = `${contract}|${workspaceId ?? ''}|${sessionId ?? ''}|${explicitInstanceId ?? ''}`;
      set((prev) => ({
        serviceResolutionsByKey: {
          ...prev.serviceResolutionsByKey,
          [cacheKey]: resolution,
        },
      }));
      return resolution;
    },

    refreshSessionBindings: async (sessionId) => {
      if (typeof daemonApi.getSessionBindings !== 'function') return;
      const res = await daemonApi.getSessionBindings(sessionId);
      const map: Record<string, string | null> = {};
      for (const [contract, resolved] of Object.entries(res.resolved ?? {})) {
        map[contract] = resolved.instanceId;
      }
      set((state) => ({
        sessionBindingsBySession: {
          ...state.sessionBindingsBySession,
          [sessionId]: map,
        },
      }));
    },

    setSessionBinding: async (sessionId, contract, instanceId) => {
      const res = await daemonApi.setSessionBinding(sessionId, contract, instanceId);
      set((state) => ({
        sessionBindingsBySession: {
          ...state.sessionBindingsBySession,
          [sessionId]: {
            ...(state.sessionBindingsBySession[sessionId] ?? {}),
            [contract]: res.resolved.instanceId,
          },
        },
      }));
      get().pushToast({
        kind: 'success',
        title: instanceId ? '已更新会话能力绑定' : '已恢复会话默认能力绑定',
      });
    },

    refreshMcpServers: async (scope) => {
      set({ mcpLoading: true });
      try {
        const res = await daemonApi.listMcpServers(scope);
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

    addMcpServer: async (req, scope) => {
      const res = await daemonApi.addMcpServer(req, scope);
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
      return res.results;
    },

    toggleMcpServer: async (req, scope) => {
      const res = await daemonApi.toggleMcpServer(req, scope);
      set({ mcpServers: res.servers });
      get().pushToast({
        kind: res.result.ok ? 'success' : 'warning',
        title: res.result.ok ? `已更新 ${req.name}` : '操作未生效',
        body: res.result.message,
      });
    },

    removeMcpServer: async (harnessId, name, scope) => {
      const res = await daemonApi.removeMcpServer(harnessId, name, scope);
      set({ mcpServers: res.servers });
      get().pushToast({
        kind: res.result.ok ? 'info' : 'error',
        title: res.result.ok ? `已从 ${harnessId} 移除 ${name}` : '移除失败',
        body: res.result.message,
      });
    },

    refreshAccountUsage: async (forceRefresh = false, scope) => {
      set({ usageLoading: true });
      try {
        const res = await daemonApi.getAccountUsage(forceRefresh, scope);
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

    refreshFailoverPolicy: async (scope) => {
      try {
        const { policy } = await daemonApi.getFailoverPolicy(scope);
        set({ failoverPolicy: policy });
      } catch {
        // ignore if failover plugin disabled
      }
    },

    updateFailoverPolicy: async (policy, scope) => {
      const res = await daemonApi.updateFailoverPolicy(policy, scope);
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
      const previous=get().selectedSessionId;
      if(previous && previous!==sessionId){ disposeNativeFeedController(previous); bumpNativeScopeEpoch(previous); }
      set({selectedSessionId:sessionId,focusedTurn:null,activePluginPage:null});
      if(!sessionId)return;
      try {
        const detail=await daemonApi.getSession(sessionId);
        if(get().selectedSessionId!==sessionId)return;
        set(state=>({sessions:state.sessions.some(s=>s.id===sessionId)
          ? state.sessions.map(s=>s.id===sessionId?detail.session:s):[detail.session,...state.sessions],
          ...(detail.taskState?{taskStateBySession:{...state.taskStateBySession,[sessionId]:detail.taskState}}:{})}));
        void get().refreshSessionBindings(sessionId);
        void get().refreshWorkspaceBindings(detail.session.workspaceId);
        if(get().agyNativeWorkbenchEnabled && detail.session.harnessKind==='agy')void get().hydrateNativeRuntime(sessionId);
      } catch(error){get().pushToast({kind:'error',title:'加载会话失败',body:String(error)});}
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
      bumpNativeScopeEpoch(id);
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
        await daemonApi.sendTurn(sessionId, await withPluginDevelopmentContext(text, options?.mode), attachments, options);
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
        nativeGlobalScopeEpoch += 1;
        inFlightCommandKeyByIntent.clear();
        for (const sid of [...nativeFeedControllers.keys()]) {
          disposeNativeFeedController(sid);
          bumpNativeScopeEpoch(sid);
        }
        for (const sid of Object.keys(get().nativeRuntimeBySession)) {
          bumpNativeScopeEpoch(sid);
        }
      }
      set({ agyNativeWorkbenchEnabled: enabled });
    },

    setNativeTransport: (transport) => {
      activeNativeTransport = transport ?? defaultNativeTransport;
    },

    hydrateNativeRuntime: async (sessionId) => {
      if (!get().agyNativeWorkbenchEnabled) return;
      const globalEpoch = nativeGlobalScopeEpoch;
      const scopeEpoch = getNativeScopeEpoch(sessionId);
      const sessionSnapshot = get().sessions.find((s) => s.id === sessionId);
      const expectedInstanceId = sessionSnapshot?.harnessId;
      disposeNativeFeedController(sessionId);
      const controller = new NativeFeedController({
        sessionId,
        transport: activeNativeTransport,
        onUpdate: ({ projection, capabilities, syncState }) => {
          const cur = get();
          if (
            !cur.agyNativeWorkbenchEnabled ||
            nativeGlobalScopeEpoch !== globalEpoch ||
            getNativeScopeEpoch(sessionId) !== scopeEpoch
          ) {
            return;
          }
          if (expectedInstanceId) {
            const liveSession = cur.sessions.find((s) => s.id === sessionId);
            if (!liveSession || liveSession.harnessId !== expectedInstanceId) return;
          }
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
      if (events.length === 0 || !get().agyNativeWorkbenchEnabled) return;
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
                incompleteReason: null,
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
      if (!get().agyNativeWorkbenchEnabled) return false;
      const slice = get().nativeRuntimeBySession[sessionId];
      const projection = slice?.projection;
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!projection || !session ||
          (activeNativeTransport.mode === 'http' && (!projection.enabled || slice?.syncState.phase !== 'live'))) {
        get().pushToast({
          kind: 'warning',
          title: '原生运行时尚未就绪',
          body: '请刷新能力探测或先以普通对话模式发送。',
        });
        return false;
      }

      const binding = req.expectedBinding ?? projection.binding;
      const catalogRevision = req.expectedCapabilitiesRevision ?? projection.capabilitiesRevision;

      // Reject if rendered binding or revision is already stale against live projection
      if (
        binding.runtimeId !== projection.binding.runtimeId ||
        binding.generation !== projection.binding.generation ||
        binding.instanceId !== session.harnessId ||
        projection.status === 'disconnected'
      ) {
        set((state) => {
          const cur = state.nativeRuntimeBySession[sessionId];
          if (!cur) return state;
          return {
            nativeRuntimeBySession: {
              ...state.nativeRuntimeBySession,
              [sessionId]: {
                ...cur,
                commandSubmission: {
                  phase: 'conflict',
                  message: '当前绑定已变更或断开，已保留草稿，请刷新后再提交。',
                  updatedAt: Date.now(),
                },
              },
            },
          };
        });
        return false;
      }

      const capturedScope = {
        globalEpoch: nativeGlobalScopeEpoch,
        scopeEpoch: getNativeScopeEpoch(sessionId),
        instanceId: session.harnessId,
        runtimeId: binding.runtimeId,
        generation: binding.generation,
      };

      const intentSignature = buildNativeCommandIntentSignature({
        sessionId,
        instanceId: session.harnessId,
        runtimeId: binding.runtimeId,
        generation: binding.generation,
        catalogRevision,
        capabilityId: req.capabilityId,
        actionKey: req.actionKey,
        args: req.args,
      });

      // Only reuse idempotency key for an identical in-flight intent (never across different prompts/args)
      const existingKey = inFlightCommandKeyByIntent.get(intentSignature);
      const key =
        req.idempotencyKey ??
        existingKey ??
        createNativeIdempotencyKey(
          req.capabilityId,
          req.actionKey,
          `${Date.now().toString(36)}_${(++nativeKeyCounter).toString(36)}`,
        );
      inFlightCommandKeyByIntent.set(intentSignature, key);

      const isScopeStillValid = () => {
        const cur = get();
        if (!cur.agyNativeWorkbenchEnabled) return false;
        if (nativeGlobalScopeEpoch !== capturedScope.globalEpoch) return false;
        if (getNativeScopeEpoch(sessionId) !== capturedScope.scopeEpoch) return false;
        const curSession = cur.sessions.find((s) => s.id === sessionId);
        if (!curSession || curSession.harnessId !== capturedScope.instanceId) return false;
        const curSlice = cur.nativeRuntimeBySession[sessionId];
        if (!curSlice?.projection) return false;
        return (
          curSlice.projection.binding.runtimeId === capturedScope.runtimeId &&
          curSlice.projection.binding.generation === capturedScope.generation
        );
      };

      set((state) => {
        const prev = state.nativeRuntimeBySession[sessionId];
        if (!prev) return state;
        return {
          nativeRuntimeBySession: {
            ...state.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              commandSubmission: {
                phase: 'submitting',
                message: '正在发起原生命令…',
                idempotencyKey: key,
                intentSignature,
                updatedAt: Date.now(),
              },
            },
          },
        };
      });

      try {
        const res = await activeNativeTransport.submitCommand(sessionId, {
          bindingGeneration: binding.generation,
          catalogRevision,
          capabilityId: req.capabilityId,
          actionKey: req.actionKey,
          args: req.args,
          idempotencyKey: key,
        });
        if (inFlightCommandKeyByIntent.get(intentSignature) === key) {
          inFlightCommandKeyByIntent.delete(intentSignature);
        }
        // Ignore late receipt if session was cleared, switched, logged out, or gate disabled
        if (!isScopeStillValid()) return false;

        set((state) => {
          const prev = state.nativeRuntimeBySession[sessionId];
          if (!prev) return state;
          return {
            nativeRuntimeBySession: {
              ...state.nativeRuntimeBySession,
              [sessionId]: {
                ...prev,
                commandSubmission: {
                  phase: res.status === 'completed' || res.modeEvidenceObserved ? 'confirmed' : 'sent_awaiting_evidence',
                  message: res.status === 'completed' ? res.output ?? '命令已返回结果'
                    : res.modeEvidenceObserved ? '已收到原生模式确认' : '已发送，等待原生确认',
                  idempotencyKey: key,
                  intentSignature,
                  updatedAt: Date.now(),
                },
              },
            },
          };
        });
        return true;
      } catch (err) {
        if (inFlightCommandKeyByIntent.get(intentSignature) === key) {
          inFlightCommandKeyByIntent.delete(intentSignature);
        }
        if (!isScopeStillValid()) return false;

        const isConflict = err instanceof NativeClientError && err.code === 'STALE_BINDING';
        set((state) => {
          const prev = state.nativeRuntimeBySession[sessionId];
          if (!prev) return state;
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
                  intentSignature,
                  updatedAt: Date.now(),
                },
              },
            },
          };
        });
        if (isConflict && isScopeStillValid()) {
          void get().hydrateNativeRuntime(sessionId);
        }
        return false;
      }
    },

    dispatchNativeControl: async (sessionId, req) => {
      if (!get().agyNativeWorkbenchEnabled) {
        throw new Error('AGY 原生工作台门控已关闭');
      }
      const slice = get().nativeRuntimeBySession[sessionId];
      const projection = slice?.projection;
      if (!projection ||
          (activeNativeTransport.mode === 'http' && (!projection.enabled || slice?.syncState.phase !== 'live'))) {
        throw new Error('原生运行时未连接，无法执行控制操作');
      }
      const binding = req.expectedBinding ?? projection.binding;
      if (
        binding.runtimeId !== projection.binding.runtimeId ||
        binding.generation !== projection.binding.generation
      ) {
        throw new NativeClientError('绑定代次已过期，拒绝发送旧目标控制命令', 409, 'STALE_BINDING');
      }
      const key =
        req.idempotencyKey ??
        createNativeIdempotencyKey(
          `ctrl_${req.target.type}`,
          `${req.target.id}_${req.action}`,
          `${Date.now().toString(36)}_${(++nativeKeyCounter).toString(36)}`,
        );
      await activeNativeTransport.dispatchControl(sessionId, {
        generation: binding.generation,
        target: req.target,
        action: req.action,
        expectedRevision: req.expectedRevision,
        idempotencyKey: key,
      });
    },

    loadNativeTimeline: (sessionId, scope, pageToken, signal) =>
      scope.kind === 'activity'
        ? activeNativeTransport.getActivityTimeline(
            sessionId,
            scope.id as ActivityId,
            { pageToken },
            signal,
          )
        : activeNativeTransport.getAgentTimeline(
            sessionId,
            scope.id as NativeAgentId,
            { pageToken },
            signal,
          ),

    loadNativeWorkflowResource: (sessionId, workflowId, resource, pageToken, signal) =>
      activeNativeTransport.getWorkflowResource(
        sessionId,
        workflowId,
        resource,
        { pageToken },
        signal,
      ),

    clearNativeSessionState: (sessionId) => {
      disposeNativeFeedController(sessionId);
      bumpNativeScopeEpoch(sessionId);
      set((state) => {
        if (!state.nativeRuntimeBySession[sessionId]) return state;
        const next = { ...state.nativeRuntimeBySession };
        delete next[sessionId];
        return { nativeRuntimeBySession: next };
      });
    },
  };
});

// Keep legacy test mutations of useAppStore synchronized with kernel-store so B1–B4 component
// tests keep passing without requiring kernel modules to import app-store.
useAppStore.subscribe((state, prev) => {
  const patch: Partial<ReturnType<typeof useKernelStore.getState>> = {};
  let changed = false;
  if (state.theme !== prev.theme) { patch.theme = state.theme; changed = true; }
  if (state.connected !== prev.connected) { patch.connected = state.connected; changed = true; }
  if (state.plugins !== prev.plugins) { patch.plugins = state.plugins; changed = true; }
  if (state.emptyComposition !== prev.emptyComposition) { patch.emptyComposition = state.emptyComposition; changed = true; }
  if (state.compositionBindings !== prev.compositionBindings) { patch.compositionBindings = state.compositionBindings; changed = true; }
  if (state.compositionEntries !== prev.compositionEntries) { patch.compositionEntries = state.compositionEntries; changed = true; }
  if (state.workspaceBindingsByWorkspace !== prev.workspaceBindingsByWorkspace) { patch.workspaceBindingsByWorkspace = state.workspaceBindingsByWorkspace; changed = true; }
  if (state.sessionBindingsBySession !== prev.sessionBindingsBySession) { patch.sessionBindingsBySession = state.sessionBindingsBySession; changed = true; }
  if (state.pluginPermissionRevision !== prev.pluginPermissionRevision) { patch.pluginPermissionRevision = state.pluginPermissionRevision; changed = true; }
  if (changed) useKernelStore.setState(patch);
});
