import type { DeveloperTaskV1, PluginSettingsDescriptorV1 } from '@harnessmate/protocol';
import type {
  AddMcpServerRequest,
  AddTrustedPublisherRequest,
  AgyAuthState,
  AgyProfileConfig,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  FilePreviewResult,
  UpsertAgyInstanceRequest,
  BuilderV2AuditRequest,
  BuilderV2GenerateRequest,
  BuilderV2InstallRequest,
  BuilderV2Result,
  CanonicalEvent,
  CheckpointRevertMode,
  CheckpointRevertResult,
  CompressedTurnChunk,
  ContextCompressionConfig,
  ContextPreview,
  ContextSyncMode,
  CreateCustomRiskRuleRequest,
  CreateSessionRequest,
  CreateTerminalContextChipRequest,
  CreateWorktreeRequest,
  CustomAcpHarnessConfig,
  CustomRiskRule,
  DelegateSubagentRequest,
  DiscoveredCliSession,
  DryRunMergeRequest,
  DryRunSubagentMergeRequest,
  FailoverPolicy,
  FailoverRecommendation,
  FailoverRequest,
  ForkSessionRequest,
  ForkSessionResult,
  GcCheckpointsRequest,
  GitActionResult,
  GitCommitRequest,
  GitCreatePrRequest,
  GitDryRunMergeResult,
  GitFileDiffResult,
  GitPullRequest,
  GitPushRequest,
  GitStatusSummary,
  GitWorkspaceTruthDigest,
  GitWorktreeEntry,
  HarnessAccountUsage,
  HarnessCommandInfo,
  HarnessCommandResult,
  HarnessInfo,
  InstalledPluginInfo,
  InstallPluginRequest,
  GeneratePluginDraftRequest,
  ManagedTerminalTab,
  PluginManifest,
  ImportNativeSessionRequest,
  ImportSessionBundleRequest,
  ManualCompressRequest,
  MarkSessionViewedRequest,
  McpServerEntry,
  MergeBackRequest,
  MergeBackResult,
  MergeSubagentRequest,
  OpenTerminalRequest,
  OrchestratorBoardResponse,
  PluginCatalogItem,
  PluginLogEntryDto,
  PluginMcpPreset,
  PluginPermission,
  PluginRegistryStateDto,
  PluginStaticAuditReport,
  PortableSessionBundleV2,
  PreviewPluginProgramRequest,
  PluginSlashCommand,
  RemoteAccessStatus,
  ReplayPluginDraftRequest,
  ResolveApprovalRequest,
  RevertCheckpointRequest,
  RunHarnessCommandRequest,
  RunPluginActionRequest,
  ScaffoldPluginRequest,
  Session,
  SessionCheckpointRecord,
  SessionCompressionStatus,
  SessionModelPluginTools,
  SubagentDiffStat,
  SubagentMergeBackResult,
  SubagentRunRecord,
  SessionPluginAction,
  SessionPluginCommand,
  SessionSearchResponse,
  SetPluginPermissionRequest,
  SessionTaskState,
  SessionTriageState,
  SideChatMessage,
  SideChatPromoteRequest,
  SideChatRequest,
  PluginPanelQuery,
  PluginPanelSnapshot,
  PluginUiMessageRequest,
  PluginBrowserFrame,
  PluginBrowserStatus,
  DesktopViewFrame,
  DesktopViewStatus,
  SwitchHarnessRequest,
  TerminalContextChip,
  ToggleMcpServerRequest,
  TriageCheckSnoozesResponse,
  TriageStateResponse,
  TrustSetupScriptRequest,
  TurnBlockRecord,
  TurnOptionsMap,
  UpdateCompressionConfigRequest,
  UpdatePluginRegistryConfigRequest,
  UpdateSessionRequest,
  UpdateSessionTriageRequest,
  UpdateTaskStateRequest,
  UploadAttachmentRequest,
  Workspace,
  WorkspaceFileEntry,
  WorkspaceSetupScriptInfo,
  WsClientFrame,
  WsServerFrame,
} from '@harnessmate/protocol';
import { frontendPerfDiagnostics } from '../lib/perf-diagnostics';
import {
  unwrapContractResult,
  type ContractResult,
  type HistoryImportCommitRequest,
  type HistoryImportCommitValue,
  type HistoryImportPreviewRequest,
  type HistoryImportPreviewValue,
  type HistorySourceDiscoverRequest,
  type HistorySourceDiscoverValue,
  type HistorySourceReadRequest,
  type HistorySourceReadValue,
  type HistorySourceStatusValue,
  type SearchCancelRequest,
  type SearchInstanceStatus,
  type SearchQueryRequest,
  type SearchQueryValue,
  type SearchReindexJob,
  type SearchReindexRequest,
  type SearchResumeRequest,
  type ServiceResolutionV1,
} from './peer-contracts';

declare global {
  interface Window {
    harnessMateBridge?: {
      daemonUrl?: string;
      pickDirectory: () => Promise<string | null>;
      openExternal: (url: string) => Promise<void>;
      notify: (title: string, body: string) => void;
      restartApp?: (options?: { safeMode?: boolean }) => Promise<{ ok?: boolean; reason?: string }>;
      menu?: {
        syncContributions: (items: import('@harnessmate/protocol').DesktopMenuContributionDto[]) => void;
        onInvoke: (
          listener: (payload: { key: string; ownerInstanceId: string; ownerRunId: string }) => void,
        ) => () => void;
      };
      desktopView?: {
        call: (viewId: string, method: string, data?: unknown) => Promise<void>;
        subscribe: (viewId: string, listener: (payload: { frame: DesktopViewFrame } | { status: DesktopViewStatus }) => void) => () => void;
      };
      pluginBrowser?: {
        call: (viewId: string, method: string, data?: unknown) => Promise<void>;
        subscribe: (viewId: string, listener: (payload: { frame: PluginBrowserFrame } | { status: PluginBrowserStatus }) => void) => () => void;
      };
    };
  }
}

export interface ProjectInstructionInfo {
  name: string;
  relativePath: string;
  kind: 'rules' | 'skill';
  sizeBytes: number;
}

export interface TerminalExecResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type RenderedFilePreview = FilePreviewResult & { pluginId: string; instanceId?: string; pluginName: string };

export interface ServiceProviderDto {
  pluginId: string;
  instanceId: string;
  contract: string;
  version: string;
  metadata?: Record<string, unknown>;
  state: string;
  name: string;
  sourceKind: string;
}

export interface FilePreviewViewerDto {
  instanceId: string;
  pluginId: string;
  name: string;
  extensions: string[];
  viewerKind: 'text' | 'markdown' | 'custom';
  ready: boolean;
  authorized: boolean;
  sourceKind: string;
}

export interface SessionFileViewResponse {
  file: { relativePath: string; content: string; truncated: boolean; sizeBytes: number };
  preview: RenderedFilePreview | null;
  resolvedInstanceId: string | null;
  boundInstanceId: string | null;
  boundSource: string;
  dependencyStatus: 'ready' | 'unavailable' | 'unauthorized' | 'unsupported_extension' | 'failed';
  dependencyMessage?: string;
  availableViewers: FilePreviewViewerDto[];
}

export interface PluginBundleResponse {
  plugins: InstalledPluginInfo[];
  catalog: PluginCatalogItem[];
  slashCommands: Array<PluginSlashCommand & { pluginId: string; pluginName: string }>;
  mcpPresets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }>;
  pluginsDir: string;
  emptyComposition?: boolean;
  harnesses?: HarnessInfo[];
}

export interface PluginPreview {
  manifest: PluginManifest;
  installedVersion?: string;
  installedManifest?: PluginManifest;
  installedDigest: string | null;
  installedEnabled?: boolean;
  digest?: string;
  fileCount?: number;
  requiresTrust?: boolean;
  missingServices?: string[];
}

export function getDaemonBaseUrl(): string {
  if (typeof window !== 'undefined' && window.harnessMateBridge?.daemonUrl) {
    return window.harnessMateBridge.daemonUrl.replace(/\/$/, '');
  }
  return '';
}

export function getDaemonWsUrl(): string {
  const base = getDaemonBaseUrl();
  if (base) {
    return `${base.replace(/^http/i, 'ws')}/api/v1/ws`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/v1/ws`;
}

export function resolveAttachmentUrl(previewUrl?: string): string | undefined {
  if (!previewUrl) return undefined;
  if (/^https?:\/\//i.test(previewUrl) || previewUrl.startsWith('data:')) return previewUrl;
  return `${getDaemonBaseUrl()}${previewUrl}`;
}

export class ApiHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload?: Record<string, unknown>;

  constructor(message: string, status: number, payload?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = typeof payload?.code === 'string' ? payload.code : undefined;
    this.payload = payload;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof window !== 'undefined' && (window as unknown as { harnessMate?: { call: unknown } }).harnessMate) {
    const bridge = (window as unknown as { harnessMate: { call(method: string, params: unknown): Promise<T> } }).harnessMate;
    return bridge.call('transport.request', { path, method: init?.method ?? 'GET', body: init?.body });
  }
  const url = `${getDaemonBaseUrl()}${path}`;
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
    const errMsg = obj && 'error' in obj ? String(obj.error) : `HTTP ${res.status}`;
    throw new ApiHttpError(errMsg, res.status, obj);
  }
  return data as T;
}

function instanceQuery(instanceId?: string): string {
  return instanceId ? '?instanceId=' + encodeURIComponent(instanceId) : '';
}

function sessionAssistanceUrl(sessionId: string, route: string, instanceId?: string): string {
  return '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/' + route + instanceQuery(instanceId);
}

export interface HarnessServiceScope {
  sessionId?: string;
  workspaceId?: string;
}

function scopedHarnessUrl(path: string, scope?: HarnessServiceScope, refresh = false): string {
  const query = new URLSearchParams();
  if (scope?.sessionId) query.set('sessionId', scope.sessionId);
  if (scope?.workspaceId) query.set('workspaceId', scope.workspaceId);
  if (refresh) query.set('refresh', '1');
  return query.size ? `${path}?${query}` : path;
}


export async function requestDeveloperRoute<T = unknown>(path: string, init?: RequestInit, instanceId?: string): Promise<T> {
  if (!instanceId) {
    const selection = await apiFetch<ServiceResolutionV1>('/api/v1/plugins/services/resolve?contract=developer.tools.v1&allowSingleCandidate=0', { signal: init?.signal });
    if (selection.status !== 'ready' || !selection.instanceId) throw new Error('开发工具服务未绑定或已停用');
    instanceId = selection.instanceId;
  }
  return apiFetch<T>('/api/v1/plugin-instances/' + encodeURIComponent(instanceId) + '/routes' + path, init);
}
async function generateWithTask<T>(input: unknown, kind: 'generate' | 'author', signal?: AbortSignal, explicitInstanceId?: string, closePolicy: 'cancel' | 'background' = 'cancel'): Promise<T> {
  const selection = explicitInstanceId ? { instanceId: explicitInstanceId } : await apiFetch<ServiceResolutionV1>('/api/v1/plugins/services/resolve?contract=developer.tools.v1&allowSingleCandidate=0', { signal });
  const instanceId = selection.instanceId;
  if (!instanceId) throw new Error('开发工具服务不可用');
  const taskId = crypto.randomUUID();
  const cancel = () => { if (closePolicy !== 'cancel' && signal?.reason !== 'user_cancel') return; void requestDeveloperRoute('/tasks/' + taskId + '/cancel', { method: 'POST', body: '{}' }, instanceId).catch(() => {}); };
  signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
  try {
    // Let the fast start acknowledgement finish even if the page closes. Then
    // repeat cancellation so a cancel request cannot race ahead of task creation.
    await requestDeveloperRoute('/tasks', { method: 'POST', body: JSON.stringify({ taskId, kind, input, closePolicy }) }, instanceId);
    if (signal?.aborted) { cancel(); signal.throwIfAborted(); }
    for (;;) {
      signal?.throwIfAborted();
      const { task } = await requestDeveloperRoute<{ task: DeveloperTaskV1 }>('/tasks/' + taskId, { signal }, instanceId);
      if (task.status === 'completed') return task.result as T;
      if (task.status === 'cancelled') throw new DOMException(task.error ?? '生成已取消', 'AbortError');
      if (task.status === 'failed') { if (task.result) return task.result as T; throw new Error(task.error ?? '生成失败'); }
      await new Promise<void>((resolve, reject) => { const stop = () => { clearTimeout(timer); reject(signal?.reason); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, 200); signal?.addEventListener('abort', stop, { once: true }); });
    }
  } finally { signal?.removeEventListener('abort', cancel); }
}
export async function withPluginDevelopmentContext(text: string, mode?: string): Promise<string> {
  if (mode !== 'plugin_development') return text;
  const context = await requestDeveloperRoute<{ userMessage: string }>('/context');
  return text + '\n\n' + context.userMessage;
}

export const daemonApi = {
  developerRoute: requestDeveloperRoute,
  listPluginSettings: () => apiFetch<{ settings: PluginSettingsDescriptorV1[] }>('/api/v1/plugins/settings'),
  getPluginSettings: (id: string) => apiFetch<PluginSettingsDescriptorV1>('/api/v1/plugins/' + encodeURIComponent(id) + '/settings'),
  savePluginSettings: (id: string, input: { config: Record<string, unknown>; schemaVersion?: number; expectedVersion?: string }) => apiFetch<{ settings: PluginSettingsDescriptorV1 }>('/api/v1/plugins/' + encodeURIComponent(id) + '/settings', { method: 'PUT', body: JSON.stringify(input) }),
  getHostConfig: () => apiFetch<{ port: number; dataRoot: string }>('/api/v1/plugins/host-config'),
  saveHostConfig: (input: { port: number; dataRoot: string }) => apiFetch<unknown>('/api/v1/plugins/host-config', { method: 'PUT', body: JSON.stringify(input) }),
  callUiService: (callerInstanceId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    apiFetch<{ resolution: ServiceResolutionV1; value: unknown }>(
      `/api/v1/plugin-instances/${encodeURIComponent(callerInstanceId)}/services/call`,
      { method: 'POST', body: JSON.stringify(params), signal }),
  request: <T>(path: string, init?: RequestInit) => apiFetch<T>(path, init),
  health: () =>
    apiFetch<{
      status: string;
      emptyComposition?: boolean;
      protocolVersion: string;
      desktopId: string;
      desktopName: string;
      port: number;
      lanEnabled: boolean;
      uptimeSec: number;
    }>('/api/v1/health'),

  listHarnesses: (refresh = false) =>
    apiFetch<{ harnesses: HarnessInfo[] }>(`/api/v1/harnesses${refresh ? '?refresh=1' : ''}`),

  registerCustomHarness: (config: CustomAcpHarnessConfig) =>
    apiFetch<{ harnesses: HarnessInfo[] }>('/api/v1/harnesses/custom', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  deleteCustomHarness: (id: string) =>
    apiFetch<{ harnesses: HarnessInfo[] }>(`/api/v1/harnesses/custom/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  discoverLocalCliSessions: (limit = 20, refresh = false) =>
    apiFetch<{ sessions: DiscoveredCliSession[]; hasMore: boolean }>(
      `/api/v1/harnesses/discovered-sessions?limit=${limit}${refresh ? '&refresh=1' : ''}`,
    ),

  importNativeSession: (req: ImportNativeSessionRequest) =>
    apiFetch<{ session: Session; partial?: boolean; lockWarning?: string; mode?: 'mirror' | 'attach' }>(
      '/api/v1/harnesses/import-session',
      { method: 'POST', body: JSON.stringify(req) },
    ),

  searchSessions: (opts: {
    q: string;
    workspaceId?: string;
    driverId?: string;
    fromTs?: number;
    toTs?: number;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    params.set('q', opts.q);
    if (opts.workspaceId) params.set('workspaceId', opts.workspaceId);
    if (opts.driverId) params.set('driverId', opts.driverId);
    if (opts.fromTs !== undefined) params.set('fromTs', String(opts.fromTs));
    if (opts.toTs !== undefined) params.set('toTs', String(opts.toTs));
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    return apiFetch<SessionSearchResponse>(`/api/v1/search/sessions?${params.toString()}`);
  },

  rebuildSearchIndex: () =>
    apiFetch<{ indexedCount: number }>('/api/v1/search/reindex', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  forkSession: (sessionId: string, req: ForkSessionRequest = {}) =>
    apiFetch<ForkSessionResult>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  mergeBackSession: (sessionId: string, req: MergeBackRequest = {}) =>
    apiFetch<MergeBackResult>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/merge-back`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  getSideChat: (sessionId: string) =>
    apiFetch<{ messages: SideChatMessage[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/side-chat`,
    ),

  sendSideChat: (sessionId: string, req: SideChatRequest) =>
    apiFetch<{ messages: SideChatMessage[]; reply: SideChatMessage }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/side-chat`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  clearSideChat: (sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/side-chat`, {
      method: 'DELETE',
    }),

  promoteSideChat: (sessionId: string, req: SideChatPromoteRequest = {}) =>
    apiFetch<ForkSessionResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/side-chat/promote`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  exportSessionBundle: (sessionId: string, redact = true) =>
    apiFetch<{ format: 'json_bundle'; filename: string; bundle: PortableSessionBundleV2 }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/export?format=json_bundle&redact=${redact ? '1' : '0'}`,
    ),

  importSessionBundle: (req: ImportSessionBundleRequest) =>
    apiFetch<{ session: Session }>('/api/v1/sessions/import-bundle', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  getTriageState: (signal?: AbortSignal) =>
    apiFetch<TriageStateResponse>('/api/v1/triage/state', { signal }),
  updateSessionTriage: (id: string, patch: UpdateSessionTriageRequest, options?: { instanceId?: string; signal?: AbortSignal }) =>
    apiFetch<{ session: SessionTriageState }>(`/api/v1/triage/sessions/${encodeURIComponent(id)}` + instanceQuery(options?.instanceId), {
      method: 'PATCH', body: JSON.stringify(patch), signal: options?.signal,
    }),
  markSessionViewed: (id: string, request: MarkSessionViewedRequest, signal?: AbortSignal, instanceId?: string) =>
    apiFetch<{ session: SessionTriageState }>(`/api/v1/triage/sessions/${encodeURIComponent(id)}/viewed` + instanceQuery(instanceId), {
      method: 'POST', body: JSON.stringify(request), signal,
    }),
  checkTriageSnoozes: (signal?: AbortSignal) =>
    apiFetch<TriageCheckSnoozesResponse>('/api/v1/triage/check-snoozes', { method: 'POST', signal }),

  planSessionNotification: (intent: {
    kind: 'approval' | 'snooze';
    sessionId: string;
    identity: string;
    summary?: string;
  }) => apiFetch<{ notice: { id: string; title: string; body: string } | null }>(
    '/api/v1/desktop/session-notifications/plan',
    { method: 'POST', body: JSON.stringify(intent) },
  ),

  // Plugins
  listPlugins: () => apiFetch<PluginBundleResponse>('/api/v1/plugins'),

  getPluginPanel: (sessionId: string, pluginId: string, panelId: string, query: Partial<PluginPanelQuery> = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.harnessId) params.set('harnessId', query.harnessId);
    if (query.event) params.set('event', query.event);
    if (query.offset) params.set('offset', String(query.offset));
    return apiFetch<PluginPanelSnapshot>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/plugin-panels/${encodeURIComponent(pluginId)}/${encodeURIComponent(panelId)}?${params}`,
      { signal },
    );
  },

  previewPlugin: (req: InstallPluginRequest) =>
    apiFetch<PluginPreview>('/api/v1/plugins/preview', { method: 'POST', body: JSON.stringify(req) }),

  listServiceProviders: (contract?: string) =>
    apiFetch<{ providers: ServiceProviderDto[] }>(
      `/api/v1/plugins/services${contract ? `?contract=${encodeURIComponent(contract)}` : ''}`,
    ),

  resolveServiceSelection: (
    contract: string,
    opts?: {
      versionRange?: string;
      sessionId?: string;
      workspaceId?: string;
      callerInstanceId?: string;
      explicitInstanceId?: string;
      allowSingleCandidate?: boolean;
      signal?: AbortSignal;
    },
  ) => {
    const params = new URLSearchParams();
    params.set('contract', contract);
    if (opts?.versionRange) params.set('versionRange', opts.versionRange);
    if (opts?.sessionId) params.set('sessionId', opts.sessionId);
    if (opts?.workspaceId) params.set('workspaceId', opts.workspaceId);
    if (opts?.callerInstanceId) params.set('callerInstanceId', opts.callerInstanceId);
    if (opts?.explicitInstanceId) params.set('explicitInstanceId', opts.explicitInstanceId);
    if (opts?.allowSingleCandidate !== undefined) {
      params.set('allowSingleCandidate', opts.allowSingleCandidate ? '1' : '0');
    }
    return apiFetch<ServiceResolutionV1>(`/api/v1/plugins/services/resolve?${params.toString()}`, {
      signal: opts?.signal,
    });
  },

  callPluginInstanceRoute: <T = unknown>(
    instanceId: string,
    routePath: string,
    init?: RequestInit,
  ) => {
    const normalized = routePath.startsWith('/') ? routePath : `/${routePath}`;
    return apiFetch<T>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes${normalized}`,
      init,
    );
  },

  discoverHistoryFromInstance: async (
    instanceId: string,
    req: HistorySourceDiscoverRequest,
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<HistorySourceDiscoverValue> | HistorySourceDiscoverValue>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/discover`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  readHistoryFromInstance: async (
    instanceId: string,
    req: HistorySourceReadRequest,
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<HistorySourceReadValue> | HistorySourceReadValue>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/read`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  getHistorySourceStatus: async (instanceId: string, signal?: AbortSignal) => {
    const res = await apiFetch<ContractResult<HistorySourceStatusValue> | HistorySourceStatusValue>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/status`,
      { signal },
    );
    return unwrapContractResult(res);
  },

  cancelHistorySource: async (instanceId: string, operationId: string) => {
    const res = await apiFetch<ContractResult<{ cancelled: boolean }> | { cancelled: boolean }>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/cancel`,
      { method: 'POST', body: JSON.stringify({ operationId }) },
    );
    return unwrapContractResult(res);
  },

  previewHistoryImport: async (
    instanceId: string,
    req: HistoryImportPreviewRequest,
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<HistoryImportPreviewValue> | HistoryImportPreviewValue>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/preview`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  commitHistoryImport: async (
    instanceId: string,
    req: HistoryImportCommitRequest,
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<HistoryImportCommitValue> | HistoryImportCommitValue>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/import`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  cancelHistoryImport: async (instanceId: string, payload: { requestId?: string; operationId?: string }) => {
    const res = await apiFetch<ContractResult<{ cancelled: boolean }> | { cancelled: boolean }>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/cancel`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    return unwrapContractResult(res);
  },

  querySessionSearchInstance: async (
    instanceId: string,
    req: SearchQueryRequest,
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<SearchQueryValue> | SearchQueryValue>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/query`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  getSessionSearchStatus: async (instanceId: string, signal?: AbortSignal) => {
    const res = await apiFetch<ContractResult<SearchInstanceStatus> | SearchInstanceStatus>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/status`,
      { signal },
    );
    return unwrapContractResult(res);
  },

  reindexSessionSearchInstance: async (
    instanceId: string,
    req: SearchReindexRequest = {},
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<SearchReindexJob> | SearchReindexJob>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/reindex`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  cancelSessionSearchReindex: async (
    instanceId: string,
    req: SearchCancelRequest = {},
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<SearchReindexJob> | SearchReindexJob>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/reindex/cancel`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  resumeSessionSearchReindex: async (
    instanceId: string,
    req: SearchResumeRequest = {},
    signal?: AbortSignal,
  ) => {
    const res = await apiFetch<ContractResult<SearchReindexJob> | SearchReindexJob>(
      `/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/routes/reindex/resume`,
      { method: 'POST', body: JSON.stringify(req), signal },
    );
    return unwrapContractResult(res);
  },

  getPluginComposition: (workspaceId?: string) => apiFetch<{
    bundles: string[];
    error?: string;
    safeMode: boolean;
    canRestore: boolean;
    emptyComposition?: boolean;
    bindings?: Record<string, string>;
    startPage?: string;
    serviceProviders?: ServiceProviderDto[];
    entries: Array<{ id: string; name: string; disabled: boolean; config: Record<string, unknown>; bindings?: Record<string, string>; sources: string[] }>;
    extensions?: { filePreviewProvider?: string };
    filePreviewProviders: Array<{ id: string; name: string; extensions: string[]; ready: boolean; authorized: boolean }>;
    filePreviewViewers?: FilePreviewViewerDto[];
  }>(`/api/v1/plugins/composition${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),

  setCompositionBinding: (contract: string, instanceId: string | null) =>
    apiFetch<{ ok: true }>('/api/v1/plugins/composition/bindings', {
      method: 'PUT',
      body: JSON.stringify({ contract, instanceId }),
    }),

  upsertCompositionInstance: (entry: {
    id: string;
    name?: string;
    disabled?: boolean;
    config?: Record<string, unknown>;
    bindings?: Record<string, string>;
  }) =>
    apiFetch<PluginBundleResponse>('/api/v1/plugins/composition/instances', {
      method: 'PUT',
      body: JSON.stringify(entry),
    }),

  removeCompositionInstance: (instanceId: string) =>
    apiFetch<PluginBundleResponse>(`/api/v1/plugins/composition/instances/${encodeURIComponent(instanceId)}`, {
      method: 'DELETE',
    }),

  setFilePreviewProvider: (pluginId: string | null, workspaceId?: string) =>
    apiFetch<{ ok: true }>('/api/v1/plugins/composition/file-preview', {
      method: 'PUT', body: JSON.stringify({ pluginId, workspaceId }),
    }),

  restorePluginComposition: (source: 'previous' | 'builtin' | 'empty') =>
    apiFetch<PluginBundleResponse>('/api/v1/plugins/composition/restore', {
      method: 'POST', body: JSON.stringify({ source }),
    }),

  getWorkspaceBindings: (workspaceId: string) =>
    apiFetch<{
      workspaceId: string;
      bindings: Array<{ contract: string; instanceId: string; updatedAt: number }>;
      resolved: Record<string, { contract: string; instanceId: string | null; source: string }>;
    }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/bindings`),

  setWorkspaceBinding: (workspaceId: string, contract: string, instanceId: string | null) =>
    apiFetch<{ workspaceId: string; resolved: { contract: string; instanceId: string | null; source: string } }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/bindings`,
      { method: 'PUT', body: JSON.stringify({ contract, instanceId }) },
    ),

  getSessionBindings: (sessionId: string) =>
    apiFetch<{
      sessionId: string;
      bindings: Array<{ contract: string; instanceId: string; updatedAt: number }>;
      resolved: Record<string, { contract: string; instanceId: string | null; source: string }>;
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/bindings`),

  setSessionBinding: (sessionId: string, contract: string, instanceId: string | null) =>
    apiFetch<{ sessionId: string; resolved: { contract: string; instanceId: string | null; source: string } }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/bindings`,
      { method: 'PUT', body: JSON.stringify({ contract, instanceId }) },
    ),

  openSessionBrowser: (sessionId: string, url: string, instanceId?: string) =>
    apiFetch<{
      ok: boolean;
      dependencyStatus: string;
      instanceId: string | null;
      boundSource: string;
      pageKey?: string | null;
      dependencyMessage?: string;
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/browser/open`, {
      method: 'POST',
      body: JSON.stringify({ url, ...(instanceId ? { instanceId } : {}) }),
    }),

  previewTurnSuggestion: (id: string, text: string, attachments?: Attachment[]) =>
    apiFetch<{ suggestion: { text: string; pluginNames: string[] } | null }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/turn-suggestion`,
      { method: 'POST', body: JSON.stringify({ text, attachments }) },
    ),

  replayPluginDraft: (req: ReplayPluginDraftRequest, signal?: AbortSignal) =>
    requestDeveloperRoute<PluginPanelSnapshot>('/preview/replay', { method: 'POST', body: JSON.stringify(req), signal }),

  previewPluginProgram: (request: PreviewPluginProgramRequest) =>
    requestDeveloperRoute<{ output: string }>('/preview/program', { method: 'POST', body: JSON.stringify(request) }),

  listPluginPermissions: (id: string, workspaceId: string) =>
    apiFetch<{ permissions: PluginPermission[] }>(`/api/v1/plugins/${encodeURIComponent(id)}/permissions?workspaceId=${encodeURIComponent(workspaceId)}`),

  setPluginPermission: (id: string, request: SetPluginPermissionRequest) =>
    apiFetch<{ permissions: PluginPermission[] }>(`/api/v1/plugins/${encodeURIComponent(id)}/permissions`,
      { method: 'PUT', body: JSON.stringify(request) }),

  runPluginAction: (sessionId: string, request: RunPluginActionRequest) =>
    apiFetch<HarnessCommandResult>(`/api/v1/plugins/actions/${encodeURIComponent(sessionId)}`,
      { method: 'POST', body: JSON.stringify(request) }),

  getPluginUiDoc: (pluginId: string, uiPath: string, signal?: AbortSignal) =>
    apiFetch<{
      pluginId: string;
      digest: string | null;
      runId: string;
      path: string;
      csp: string;
      html: string;
    }>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/ui-doc?path=${encodeURIComponent(uiPath)}`,
      { signal },
    ),

  sendPluginUiMessage: (pluginId: string, request: PluginUiMessageRequest) =>
    apiFetch<{ result: unknown }>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/ui-message`,
      { method: 'POST', body: JSON.stringify(request) },
    ),

  generatePlugin: (req: GeneratePluginDraftRequest, signal: AbortSignal, instanceId?: string, closePolicy?: 'cancel' | 'background') => generateWithTask<{ manifest: PluginManifest }>(req, 'author', signal, instanceId, closePolicy),
  generatePluginV2: (req: BuilderV2GenerateRequest, signal?: AbortSignal, instanceId?: string, closePolicy?: 'cancel' | 'background') => generateWithTask<BuilderV2Result>(req, 'generate', signal, instanceId, closePolicy),
  auditPluginPackage: (req: BuilderV2AuditRequest) => requestDeveloperRoute<{ audit: PluginStaticAuditReport }>('/audit', { method: 'POST', body: JSON.stringify(req) }),
  installPluginV2: (req: BuilderV2InstallRequest, instanceId?: string) => requestDeveloperRoute<PluginBundleResponse & { installedId: string; installMode: 'local_install' | 'dev_link'; dirPath: string; activation?: { status: string; restartRequired: boolean; previewPages?: Array<{ instanceId: string; pageId: string }> } }>('/install', { method: 'POST', body: JSON.stringify(req) }, instanceId),

  rollbackPlugin: (id: string) =>
    apiFetch<PluginBundleResponse>(`/api/v1/plugins/${encodeURIComponent(id)}/rollback`, { method: 'POST' }),

  installPlugin: (req: InstallPluginRequest) =>
    apiFetch<PluginBundleResponse>('/api/v1/plugins/install', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  togglePlugin: (id: string, enabled: boolean) =>
    apiFetch<PluginBundleResponse>(`/api/v1/plugins/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  reloadPlugins: () =>
    apiFetch<PluginBundleResponse>('/api/v1/plugins/reload', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  uninstallPlugin: (id: string) =>
    apiFetch<PluginBundleResponse>(`/api/v1/plugins/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  getPluginLogs: (pluginId?: string) =>
    apiFetch<{ logs: PluginLogEntryDto[] }>(
      pluginId ? `/api/v1/plugins/${encodeURIComponent(pluginId)}/logs` : '/api/v1/plugins/logs',
    ),

  clearPluginLogs: (pluginId?: string) =>
    apiFetch<{ ok: boolean }>(
      pluginId ? `/api/v1/plugins/${encodeURIComponent(pluginId)}/logs` : '/api/v1/plugins/logs',
      { method: 'DELETE' },
    ),

  previewDevPlugin: (dirPath: string) =>
    apiFetch<{ dirPath: string; id: string; name: string; hasBackend: boolean }>('/api/v1/plugins/dev/preview', {
      method: 'POST',
      body: JSON.stringify({ dirPath }),
    }),

  linkDevPlugin: (dirPath: string, trustedId?: string) =>
    apiFetch<PluginBundleResponse>('/api/v1/plugins/dev/link', {
      method: 'POST',
      body: JSON.stringify({ dirPath, trustedId }),
    }),

  revokeDevPluginTrust: (id: string) =>
    apiFetch<PluginBundleResponse>(`/api/v1/plugins/dev/${encodeURIComponent(id)}/trust`, {
      method: 'DELETE',
    }),

  reloadDevPlugin: (id: string) =>
    apiFetch<PluginBundleResponse>(`/api/v1/plugins/dev/${encodeURIComponent(id)}/reload`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  unlinkDevPlugin: (id: string) =>
    apiFetch<PluginBundleResponse>(`/api/v1/plugins/dev/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  scaffoldPlugin: (req: ScaffoldPluginRequest, instanceId?: string) =>
    requestDeveloperRoute<PluginBundleResponse & { dirPath: string; files: string[] }>('/scaffold', {
      method: 'POST',
      body: JSON.stringify(req),
    }, instanceId),

  getPluginRegistry: () =>
    apiFetch<{ registry: PluginRegistryStateDto; catalog: PluginCatalogItem[] }>('/api/v1/plugins/registry'),

  refreshPluginRegistry: () =>
    apiFetch<PluginBundleResponse & { registry: PluginRegistryStateDto }>('/api/v1/plugins/registry/refresh', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  updatePluginRegistryConfig: (req: UpdatePluginRegistryConfigRequest) =>
    apiFetch<PluginBundleResponse & { registry: PluginRegistryStateDto }>('/api/v1/plugins/registry/config', {
      method: 'PUT',
      body: JSON.stringify(req),
    }),

  addTrustedPublisher: (req: AddTrustedPublisherRequest) =>
    apiFetch<PluginBundleResponse & { registry: PluginRegistryStateDto }>('/api/v1/plugins/registry/publishers', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  removeTrustedPublisher: (id: string) =>
    apiFetch<PluginBundleResponse & { registry: PluginRegistryStateDto }>(
      `/api/v1/plugins/registry/publishers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  // MCP Hub
  listMcpServers: (scope?: HarnessServiceScope) =>
    apiFetch<{
      servers: McpServerEntry[];
      presets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }>;
    }>(scopedHarnessUrl('/api/v1/mcp/servers', scope)),

  addMcpServer: (req: AddMcpServerRequest, scope?: HarnessServiceScope) =>
    apiFetch<{
      results: Array<{ harnessId: string; ok: boolean; message: string }>;
      servers: McpServerEntry[];
    }>(scopedHarnessUrl('/api/v1/mcp/servers', scope), {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  toggleMcpServer: (req: ToggleMcpServerRequest, scope?: HarnessServiceScope) =>
    apiFetch<{ result: { ok: boolean; message: string }; servers: McpServerEntry[] }>(
      scopedHarnessUrl('/api/v1/mcp/servers/toggle', scope),
      {
        method: 'PATCH',
        body: JSON.stringify(req),
      },
    ),

  removeMcpServer: (harnessId: string, name: string, scope?: HarnessServiceScope) =>
    apiFetch<{ result: { ok: boolean; message: string }; servers: McpServerEntry[] }>(
      scopedHarnessUrl(`/api/v1/mcp/servers/${encodeURIComponent(harnessId)}/${encodeURIComponent(name)}`, scope),
      { method: 'DELETE' },
    ),

  // Accounts & Usage
  getAccountUsage: (refresh = false, scope?: HarnessServiceScope) =>
    apiFetch<{ accounts: HarnessAccountUsage[]; collectedAt: number }>(
      scopedHarnessUrl('/api/v1/usage/accounts', scope, refresh),
    ),

  getFailoverPolicy: (scope?: HarnessServiceScope) =>
    apiFetch<{ policy: FailoverPolicy }>(scopedHarnessUrl('/api/v1/usage/failover-policy', scope)),

  updateFailoverPolicy: (policy: FailoverPolicy, scope?: HarnessServiceScope) =>
    apiFetch<{ policy: FailoverPolicy }>(scopedHarnessUrl('/api/v1/usage/failover-policy', scope), {
      method: 'PUT',
      body: JSON.stringify(policy),
    }),

  getModelCandidates: (sessionId: string, signal?: AbortSignal) =>
    apiFetch<Pick<HarnessInfo, 'models' | 'defaultModelId'> & {
      harnessInstanceId: string;
      resolution: ServiceResolutionV1;
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/model-candidates`, { signal }),

  getFailoverRecommendation: (sessionId: string, failedInstanceId?: string, failureClass?: string) => {
    const params = new URLSearchParams();
    if (failedInstanceId) params.set('failedInstanceId', failedInstanceId);
    if (failureClass) params.set('failureClass', failureClass);
    const qs = params.toString();
    return apiFetch<{ recommendation: FailoverRecommendation }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/failover-recommendation${qs ? `?${qs}` : ''}`,
    );
  },

  // Workspaces
  listWorkspaces: () => apiFetch<{ workspaces: Workspace[] }>('/api/v1/workspaces'),

  createWorkspace: (rootPath: string, name?: string) =>
    apiFetch<{ workspace: Workspace }>('/api/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ rootPath, name }),
    }),

  deleteWorkspace: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // Sessions
  listSessions: (filter?: { workspaceId?: string; harnessId?: string; includeArchived?: boolean }) => {
    const params = new URLSearchParams();
    if (filter?.workspaceId) params.set('workspaceId', filter.workspaceId);
    if (filter?.harnessId) params.set('harnessId', filter.harnessId);
    if (filter?.includeArchived) params.set('includeArchived', '1');
    const qs = params.toString();
    return apiFetch<{ sessions: Session[] }>(`/api/v1/sessions${qs ? `?${qs}` : ''}`);
  },

  createSession: (req: CreateSessionRequest) =>
    apiFetch<{ session: Session }>('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  getSession: (id: string) =>
    apiFetch<{ session: Session; pendingApprovals: ApprovalRequest[]; taskState?: SessionTaskState }>(
      `/api/v1/sessions/${encodeURIComponent(id)}`,
    ),

  updateSession: (id: string, patch: UpdateSessionRequest) =>
    apiFetch<{ session: Session }>(`/api/v1/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteSession: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/v1/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  getSessionEvents: (id: string, afterSeq = 0) =>
    apiFetch<{ events: CanonicalEvent[]; lastSeq: number }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/events?afterSeq=${afterSeq}`,
    ),

  getSessionTurnItems: (
    id: string,
    opts?: { afterSeq?: number; turnId?: string; limit?: number },
  ) => {
    const params = new URLSearchParams();
    if (opts?.afterSeq !== undefined) params.set('afterSeq', String(opts.afterSeq));
    if (opts?.turnId) params.set('turnId', opts.turnId);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return apiFetch<{ items: TurnBlockRecord[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/items${qs ? `?${qs}` : ''}`,
    );
  },

  getSessionTurnItem: (
    sessionId: string,
    itemId: string,
    opts?: { textOffset?: number; maxChars?: number },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (opts?.textOffset !== undefined) params.set('textOffset', String(opts.textOffset));
    if (opts?.maxChars !== undefined) params.set('maxChars', String(opts.maxChars));
    const qs = params.toString();
    return apiFetch<{
      item: TurnBlockRecord;
      text: string;
      totalChars: number;
      textOffset: number;
      nextTextOffset: number | null;
      hasMore: boolean;
    }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}${qs ? `?${qs}` : ''}`,
      { signal },
    );
  },

  getHarnessCommands: (id: string, signal?: AbortSignal) =>
    apiFetch<{ commands: HarnessCommandInfo[]; pluginActions: SessionPluginAction[]; pluginCommands?: SessionPluginCommand[]; modelTools: SessionModelPluginTools }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/commands`, { signal }),

  runHarnessCommand: (id: string, req: RunHarnessCommandRequest) =>
    apiFetch<HarnessCommandResult>(`/api/v1/sessions/${encodeURIComponent(id)}/commands`, {
      method: 'POST', body: JSON.stringify(req),
    }),

  sendTurn: (
    id: string,
    text: string,
    attachments?: Attachment[],
    opts?: {
      harnessId?: string;
      model?: string | null;
      turnOptions?: TurnOptionsMap;
      omitHandoff?: boolean;
      literalText?: boolean;
      mode?: 'plugin_development';
      terminalContexts?: TerminalContextChip[];
    },
  ) =>
    apiFetch<{ turnId: string }>(`/api/v1/sessions/${encodeURIComponent(id)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        attachments,
        ...(opts?.terminalContexts && opts.terminalContexts.length > 0
          ? { terminalContexts: opts.terminalContexts }
          : {}),
        ...(opts?.harnessId ? { harnessId: opts.harnessId } : {}),
        ...(opts?.model !== undefined ? { model: opts.model } : {}),
        ...(opts?.turnOptions && Object.keys(opts.turnOptions).length > 0
          ? { turnOptions: opts.turnOptions }
          : {}),
        omitHandoff: opts?.omitHandoff,
        literalText: opts?.literalText,
        mode: opts?.mode,
      }),
    }),

  switchHarness: (sessionId: string, req: SwitchHarnessRequest) =>
    apiFetch<{ session: Session; contextPreview: ContextPreview }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/switch-harness`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    ),

  getContextPreview: (sessionId: string, targetHarnessId?: string, syncMode?: ContextSyncMode) => {
    const params = new URLSearchParams();
    if (targetHarnessId) params.set('targetHarnessId', targetHarnessId);
    if (syncMode) params.set('syncMode', syncMode);
    const qs = params.toString();
    return apiFetch<{ preview: ContextPreview }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/context-preview${qs ? `?${qs}` : ''}`,
    );
  },

  getTaskState: (sessionId: string, options?: { instanceId?: string; signal?: AbortSignal }) =>
    apiFetch<{ taskState: SessionTaskState }>(
      sessionAssistanceUrl(sessionId, 'task-state', options?.instanceId),
      { signal: options?.signal },
    ),

  updateTaskState: (sessionId: string, patch: UpdateTaskStateRequest, options?: { instanceId?: string; signal?: AbortSignal }) =>
    apiFetch<{ taskState: SessionTaskState }>(
      sessionAssistanceUrl(sessionId, 'task-state', options?.instanceId),
      { method: 'PUT', body: JSON.stringify(patch), signal: options?.signal },
    ),

  summarizeTaskState: (sessionId: string, signal?: AbortSignal) =>
    apiFetch<{ taskState: SessionTaskState }>(
      sessionAssistanceUrl(sessionId, 'task-state/summarize'),
      { method: 'POST', body: JSON.stringify({}), signal },
    ),

  failoverSession: (sessionId: string, req: FailoverRequest) =>
    apiFetch<{ session: Session; retriedTurnId: string | null }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/failover`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    ),

  interruptSession: (id: string) =>
    apiFetch<{ interrupted: boolean }>(`/api/v1/sessions/${encodeURIComponent(id)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  uploadAttachment: (sessionId: string, req: UploadAttachmentRequest) =>
    apiFetch<{ attachment: Attachment }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/attachments`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    ),

  searchSessionFiles: (sessionId: string, q = '') =>
    apiFetch<{ files: WorkspaceFileEntry[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/files?q=${encodeURIComponent(q)}`,
    ),

  readSessionFile: (sessionId: string, relativePath: string, signal?: AbortSignal) =>
    apiFetch<{ relativePath: string; content: string; truncated: boolean; sizeBytes: number }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/file-content?path=${encodeURIComponent(relativePath)}`, { signal },
    ),

  renderSessionFile: (sessionId: string, path: string, line?: number, signal?: AbortSignal) => {
    const query = new URLSearchParams({ path });
    if (line !== undefined) query.set('line', String(line));
    return apiFetch<{ preview: RenderedFilePreview | null }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/file-preview?${query}`, { signal },
    );
  },

  getSessionFileView: (sessionId: string, path: string, line?: number, instanceId?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ path });
    if (line !== undefined) query.set('line', String(line));
    if (instanceId) query.set('instanceId', instanceId);
    return apiFetch<SessionFileViewResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/file-view?${query}`, { signal },
    );
  },

  getSessionRules: (sessionId: string) =>
    apiFetch<{ instructions: ProjectInstructionInfo[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/rules`,
    ),

  runSessionTerminal: (sessionId: string, command: string) =>
    apiFetch<{ result: TerminalExecResult }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal`,
      {
        method: 'POST',
        body: JSON.stringify({ command }),
      },
    ),

  listWorkspaceTerminals: (workspaceId: string, cwd?: string) => {
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    return apiFetch<{ enabled: boolean; ptyAvailable: boolean; terminals: ManagedTerminalTab[] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/terminals${qs}`,
    );
  },

  openWorkspaceTerminal: (workspaceId: string, req: OpenTerminalRequest = {}) =>
    apiFetch<{ terminal: ManagedTerminalTab; snapshot: string }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/terminals`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    ),

  sendTerminalInput: (terminalId: string, data: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/terminals/${encodeURIComponent(terminalId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  interruptTerminal: (terminalId: string) =>
    apiFetch<{ terminal: ManagedTerminalTab }>(
      `/api/v1/terminals/${encodeURIComponent(terminalId)}/interrupt`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    ),

  restartTerminal: (terminalId: string) =>
    apiFetch<{ terminal: ManagedTerminalTab }>(
      `/api/v1/terminals/${encodeURIComponent(terminalId)}/restart`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    ),

  createTerminalContextChip: (terminalId: string, req: CreateTerminalContextChipRequest = {}) =>
    apiFetch<{ chip: TerminalContextChip }>(
      `/api/v1/terminals/${encodeURIComponent(terminalId)}/context-chip`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    ),

  closeTerminal: (terminalId: string) =>
    apiFetch<{ closed: boolean }>(`/api/v1/terminals/${encodeURIComponent(terminalId)}`, {
      method: 'DELETE',
    }),

  releaseTerminalsUnderPath: (targetPath: string) =>
    apiFetch<{ releasedCount: number; terminalIds: string[] }>('/api/v1/terminals/release-path', {
      method: 'POST',
      body: JSON.stringify({ targetPath }),
    }),

  handoffSession: (sessionId: string, targetHarnessId: string, targetModel?: string | null) =>
    apiFetch<{ session: Session; handoffPrompt: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/handoff`,
      {
        method: 'POST',
        body: JSON.stringify({ targetHarnessId, targetModel }),
      },
    ),

  exportSessionMarkdown: (sessionId: string, redact = false) =>
    apiFetch<{ filename: string; markdown: string; redacted?: boolean; redactedCount?: number }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/export?format=markdown&redact=${redact ? '1' : '0'}`,
    ),

  getSessionGit: (id: string) =>
    apiFetch<{ git: GitStatusSummary }>(`/api/v1/sessions/${encodeURIComponent(id)}/git`),

  getGitFileDiff: (sessionId: string, filePath: string, staged = false) =>
    apiFetch<GitFileDiffResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/file-diff?path=${encodeURIComponent(filePath)}&staged=${staged ? '1' : '0'}`,
    ),

  getGitTruthDigest: (sessionId: string) =>
    apiFetch<{ truth: GitWorkspaceTruthDigest }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/truth`,
    ),

  initSessionGit: (sessionId: string) =>
    apiFetch<{ result: GitActionResult; git: GitStatusSummary }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/init`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  discardGitFile: (sessionId: string, filePath: string) =>
    apiFetch<{ result: GitActionResult; git: GitStatusSummary }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/discard`,
      { method: 'POST', body: JSON.stringify({ filePath }) },
    ),

  gitCommit: (sessionId: string, req: GitCommitRequest) =>
    apiFetch<{ result: GitActionResult; git: GitStatusSummary }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/commit`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  gitPush: (sessionId: string, req: GitPushRequest = {}) =>
    apiFetch<{ result: GitActionResult; git: GitStatusSummary }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/push`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  gitPull: (sessionId: string, req: GitPullRequest = {}) =>
    apiFetch<{ result: GitActionResult; git: GitStatusSummary }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/pull`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  gitCreatePr: (sessionId: string, req: GitCreatePrRequest) =>
    apiFetch<{ result: GitActionResult }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/git/pr`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  listCheckpoints: (sessionId: string) =>
    apiFetch<{ checkpoints: SessionCheckpointRecord[]; supportsNativeRollback: boolean }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
    ),

  captureCheckpoint: (sessionId: string) =>
    apiFetch<{ checkpoint: SessionCheckpointRecord }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  diffCheckpoints: (
    sessionId: string,
    opts: { fromCheckpointId?: string; toCheckpointId?: string; fromSeq?: number; toSeq?: number },
  ) => {
    const params = new URLSearchParams();
    if (opts.fromCheckpointId) params.set('fromCheckpointId', opts.fromCheckpointId);
    if (opts.toCheckpointId) params.set('toCheckpointId', opts.toCheckpointId);
    if (opts.fromSeq !== undefined) params.set('fromSeq', String(opts.fromSeq));
    if (opts.toSeq !== undefined) params.set('toSeq', String(opts.toSeq));
    const qs = params.toString();
    return apiFetch<{
      fromCheckpointId: string | null;
      toCheckpointId: string | null;
      fromTreeSha: string;
      toTreeSha: string;
      diff: string;
      filesChanged: number;
      insertions: number;
      deletions: number;
      files: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed';
        additions: number;
        deletions: number;
      }>;
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints/diff${qs ? `?${qs}` : ''}`);
  },

  revertCheckpoint: (sessionId: string, req: RevertCheckpointRequest) =>
    apiFetch<{
      result: CheckpointRevertResult;
      session: Session;
      checkpoints: SessionCheckpointRecord[];
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints/revert`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  gcCheckpoints: (sessionId: string, req: Partial<GcCheckpointsRequest> = {}) =>
    apiFetch<{
      deletedCount: number;
      deletedRefs: string[];
      checkpoints: SessionCheckpointRecord[];
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/checkpoints/gc`, {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  listWorktrees: (workspaceId: string) =>
    apiFetch<{
      worktrees: GitWorktreeEntry[];
      setupScript: WorkspaceSetupScriptInfo;
      blockingTerminalsByPath?: Record<string, ManagedTerminalTab[]>;
    }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees`),

  createWorktree: (workspaceId: string, req: CreateWorktreeRequest) =>
    apiFetch<{ created: { worktreePath: string; branch: string }; worktrees: GitWorktreeEntry[] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  removeWorktree: (workspaceId: string, worktreePath: string, force = false) =>
    apiFetch<{ result: GitActionResult; worktrees: GitWorktreeEntry[] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees`,
      { method: 'DELETE', body: JSON.stringify({ worktreePath, force }) },
    ),

  dryRunMerge: (workspaceId: string, req: DryRunMergeRequest) =>
    apiFetch<GitDryRunMergeResult>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees/dry-run-merge`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  getSetupScript: (workspaceId: string) =>
    apiFetch<{ setupScript: WorkspaceSetupScriptInfo }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/setup-script`,
    ),

  setSetupScriptTrust: (workspaceId: string, req: TrustSetupScriptRequest) =>
    apiFetch<{ setupScript: WorkspaceSetupScriptInfo }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/setup-script/trust`,
      { method: 'PUT', body: JSON.stringify(req) },
    ),

  runSetupScript: (workspaceId: string, worktreePath?: string) =>
    apiFetch<{ result: GitActionResult }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/setup-script/run`,
      { method: 'POST', body: JSON.stringify({ worktreePath }) },
    ),

  listPendingApprovals: (sessionId?: string) =>
    apiFetch<{ approvals: ApprovalRequest[] }>(
      `/api/v1/approvals${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    ),

  resolveApproval: (approvalId: string, decision: ApprovalDecision, comment?: string) =>
    apiFetch<{ approval: ApprovalRequest }>(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, comment, resolvedBy: 'desktop' }),
      },
    ),

  resolveRuntimeRequest: (approvalId: string, req: ResolveApprovalRequest) =>
    apiFetch<{ approval: ApprovalRequest }>(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ ...req, resolvedBy: req.resolvedBy ?? 'desktop' }),
      },
    ),

  listRiskRules: () => apiFetch<{ rules: CustomRiskRule[] }>('/api/v1/approval-center/rules'),

  addRiskRule: (req: CreateCustomRiskRuleRequest) =>
    apiFetch<{ rule: CustomRiskRule; rules: CustomRiskRule[] }>('/api/v1/approval-center/rules', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  deleteRiskRule: (ruleId: string) =>
    apiFetch<{ deleted: boolean; rules: CustomRiskRule[] }>(
      `/api/v1/approval-center/rules/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
    ),

  getRemoteStatus: () => apiFetch<RemoteAccessStatus>('/api/v1/remote/status'),

  updateRemoteConfig: (lanEnabled: boolean) =>
    apiFetch<RemoteAccessStatus & { restartRequired?: boolean }>('/api/v1/remote/config', {
      method: 'PATCH',
      body: JSON.stringify({ lanEnabled }),
    }),

  createPairingCode: () =>
    apiFetch<RemoteAccessStatus>('/api/v1/pair/create', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  revokePairedDevice: (id: string) =>
    apiFetch<{ revoked: boolean }>(`/api/v1/remote/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // ── Multi-Harness Parallel Orchestrator (Scenario D) ─────────────────

  listSubagents: (parentSessionId: string) =>
    apiFetch<OrchestratorBoardResponse>(
      `/api/v1/sessions/${encodeURIComponent(parentSessionId)}/subagents`,
    ),

  delegateSubagent: (parentSessionId: string, req: DelegateSubagentRequest) =>
    apiFetch<{ subagent: SubagentRunRecord }>(
      `/api/v1/sessions/${encodeURIComponent(parentSessionId)}/subagents`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  getSubagent: (subagentId: string) =>
    apiFetch<{
      subagent: SubagentRunRecord;
      pendingApprovals: ApprovalRequest[];
      recentOutput: string;
    }>(`/api/v1/subagents/${encodeURIComponent(subagentId)}`),

  sendToSubagent: (subagentId: string, text: string) =>
    apiFetch<{ subagent: SubagentRunRecord; turnId: string }>(
      `/api/v1/subagents/${encodeURIComponent(subagentId)}/send`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),

  stopSubagent: (subagentId: string, reason?: string) =>
    apiFetch<{ subagent: SubagentRunRecord }>(
      `/api/v1/subagents/${encodeURIComponent(subagentId)}/stop`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  dryRunMergeSubagent: (subagentId: string, req?: DryRunSubagentMergeRequest) =>
    apiFetch<{
      subagent: SubagentRunRecord;
      dryRun: GitDryRunMergeResult;
      diffStat: SubagentDiffStat;
    }>(`/api/v1/subagents/${encodeURIComponent(subagentId)}/dry-run-merge`, {
      method: 'POST',
      body: JSON.stringify(req ?? {}),
    }),

  mergeBackSubagent: (subagentId: string, req: MergeSubagentRequest) =>
    apiFetch<SubagentMergeBackResult>(
      `/api/v1/subagents/${encodeURIComponent(subagentId)}/merge-back`,
      { method: 'POST', body: JSON.stringify(req) },
    ),

  cleanupSubagentWorktree: (
    subagentId: string,
    opts?: { force?: boolean; deleteBranch?: boolean },
  ) =>
    apiFetch<{
      subagent: SubagentRunRecord;
      worktreeCleaned: boolean;
      branchDeleted: boolean;
    }>(`/api/v1/subagents/${encodeURIComponent(subagentId)}/worktree`, {
      method: 'DELETE',
      body: JSON.stringify(opts ?? {}),
    }),

  // ── AI Context Compression & Symbol Index ─────────────────────────────

  getSessionCompression: (sessionId: string) =>
    apiFetch<SessionCompressionStatus>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/compression`,
    ),

  compressSessionContext: (sessionId: string, req?: ManualCompressRequest) =>
    apiFetch<{
      result: {
        chunks: CompressedTurnChunk[];
        combinedMarkdown: string;
        totalOriginalChars: number;
        totalCompressedChars: number;
        compressionRatio: number;
        usedLlm: boolean;
        fallback: boolean;
        fallbackReason: string | null;
        llmCallsMade: number;
        cacheHits: number;
      };
      status: SessionCompressionStatus;
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/compression/compress`, {
      method: 'POST',
      body: JSON.stringify(req ?? {}),
    }),

  clearSessionCompressionCache: (sessionId: string) =>
    apiFetch<{ clearedCount: number; status: SessionCompressionStatus }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/compression/cache`,
      { method: 'DELETE' },
    ),

  getCompressionConfig: () =>
    apiFetch<{ enabled: boolean; config: ContextCompressionConfig }>('/api/v1/compression/config'),

  updateCompressionConfig: (patch: UpdateCompressionConfigRequest) =>
    apiFetch<{ enabled: boolean; config: ContextCompressionConfig }>('/api/v1/compression/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  // ── Phase AGY: Native Account Isolation, Auth, Subagents, Artifacts & Ecosystem ──

  listAgyInstances: () =>
    apiFetch<{ instances: AgyInstanceEntryDto[] }>('/api/v1/harnesses/agy/instances'),

  upsertAgyInstance: (req: Partial<UpsertAgyInstanceRequest> & { instanceId: string; displayName: string }) =>
    apiFetch<{ profile: AgyProfileConfig; authState: AgyAuthState; harnesses: HarnessInfo[] }>(
      '/api/v1/harnesses/agy/instances',
      { method: 'POST', body: JSON.stringify(req) },
    ),

  deleteAgyInstance: (id: string, purgeData = false) =>
    apiFetch<{ deleted: boolean; instanceId: string; harnesses: HarnessInfo[] }>(
      `/api/v1/harnesses/agy/instances/${encodeURIComponent(id)}${purgeData ? '?purgeData=1' : ''}`,
      { method: 'DELETE' },
    ),

  getAgyAuthState: (id: string) =>
    apiFetch<{ state: AgyAuthState }>(`/api/v1/harnesses/agy/instances/${encodeURIComponent(id)}/auth/state`),

  startAgyLogin: (id: string) =>
    apiFetch<{ state: AgyAuthState }>(`/api/v1/harnesses/agy/instances/${encodeURIComponent(id)}/auth/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  respondAgyLogin: (id: string, flowId: string, codeOrUrl: string) =>
    apiFetch<{ state: AgyAuthState; harnesses: HarnessInfo[] }>(
      `/api/v1/harnesses/agy/instances/${encodeURIComponent(id)}/auth/respond`,
      { method: 'POST', body: JSON.stringify({ flowId, codeOrUrl }) },
    ),

  cancelAgyLogin: (id: string, flowId?: string) =>
    apiFetch<{ state: AgyAuthState }>(
      `/api/v1/harnesses/agy/instances/${encodeURIComponent(id)}/auth/cancel`,
      { method: 'POST', body: JSON.stringify(flowId ? { flowId } : {}) },
    ),

  logoutAgy: (id: string, confirmSharedKeyring?: boolean) =>
    apiFetch<{ state: AgyAuthState; harnesses: HarnessInfo[] }>(
      `/api/v1/harnesses/agy/instances/${encodeURIComponent(id)}/auth/logout`,
      { method: 'POST', body: JSON.stringify(confirmSharedKeyring ? { confirmSharedKeyring } : {}) },
    ),

  listAgyArtifacts: (sessionId: string) =>
    apiFetch<{ artifacts: AgyArtifactSummaryDto[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/agy/artifacts`,
    ),

  readAgyArtifact: (sessionId: string, name: string) =>
    apiFetch<{ artifact: AgyArtifactContentDto }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/agy/artifacts/${encodeURIComponent(name)}`,
    ),

  getAgyEcosystem: (sessionId: string) =>
    apiFetch<{ ecosystem: AgyEcosystemSnapshotDto }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/agy/ecosystem`,
    ),

  listAgySubagents: (sessionId: string) =>
    apiFetch<{ subagents: AgySubagentRecordDto[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/agy/subagents`,
    ),

  readAgySubagent: (sessionId: string, subagentId: string) =>
    apiFetch<{ subagent: AgySubagentDetailDto }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/agy/subagents/${encodeURIComponent(subagentId)}`,
    ),
};

export interface AgyInstanceEntryDto {
  profile: AgyProfileConfig;
  authState: AgyAuthState;
}

export interface AgyArtifactSummaryDto {
  name: string;
  kind: 'markdown' | 'diff' | 'json' | 'text';
  sizeBytes: number;
  updatedAt: number;
}

export interface AgyArtifactContentDto extends AgyArtifactSummaryDto {
  content: string;
  truncated: boolean;
}

export interface AgySubagentRecordDto {
  id: string;
  role?: string;
  typeName?: string;
  status: string;
  summary?: string;
  updatedAt?: number;
}

export interface AgySubagentDetailDto extends AgySubagentRecordDto {
  transcriptLines: string[];
  rawText?: string;
  truncated: boolean;
}

export interface AgyEcosystemSnapshotDto {
  instanceId: string;
  isolationMode: 'official_default' | 'profile_isolated';
  geminiDir: string;
  projects: { workspaceRoot: string; additionalDirectories: string[] };
  rules: { profileFiles: string[]; workspaceRulesDirPresent: boolean };
  skills: { profileSkillsLinked: boolean; workspaceSkillsCount: number };
  mcp: {
    nativeGlobalConfigPresent: boolean;
    nativeGlobalConfigPath: string;
    nativeScope: 'global_shared';
    harnessMateSessionMcpScope: 'session_isolated';
    note: string;
  };
  hooks: {
    agyInternalHooksPresent: boolean;
    agyInternalHooksScope: 'agy_internal';
    harnessMateV5HooksCount: number;
  };
  plugins: {
    agyPluginCliNote: string;
    harnessMateActivePluginsCount: number;
  };
}

export type ServiceBatch = Extract<WsServerFrame, { op: 'service_batch' }>;
export let sharedDaemonWs: DaemonWsClient | undefined;
export function getSharedDaemonWs(): DaemonWsClient | undefined {
  return (
    sharedDaemonWs ??
    (typeof window !== 'undefined'
      ? (window as unknown as { __HM_SHARED_WS__?: DaemonWsClient }).__HM_SHARED_WS__
      : undefined)
  );
}

export class DaemonWsClient {
  private frameObservers = new Set<(frame: WsServerFrame) => void>();
  observeFrames(listener: (frame: WsServerFrame) => void): () => void {
    this.frameObservers.add(listener);
    return () => { this.frameObservers.delete(listener); };
  }
  private serviceSubscriptions = new Map<string, {
    frame: Extract<WsClientFrame, { op: 'subscribe_service' }>;
    listener: (batch: ServiceBatch) => void;
  }>();
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;
  private activeSubscription: { sessionId: string; afterSeq: number } | null = null;
  private commandOutputSubscriptions = new Map<string, { sessionId: string; toolCallId: string }>();
  private terminalSubscriptions = new Set<string>();

  constructor(
    private readonly handlers: {
      onConnected: (connected: boolean) => void;
      onFrame: (frame: WsServerFrame) => void;
    },
  ) {
    sharedDaemonWs = this;
    if (typeof window !== 'undefined') {
      (window as unknown as { __HM_SHARED_WS__?: DaemonWsClient }).__HM_SHARED_WS__ = this;
    }
  }

  subscribeService(params: { contract: string; instanceId: string; runId?: string }, listener: (batch: ServiceBatch) => void): () => void {
    const subscriptionId = crypto.randomUUID();
    const frame = { op: 'subscribe_service' as const, subscriptionId, ...params };
    this.serviceSubscriptions.set(subscriptionId, { frame, listener });
    this.send(frame);
    return () => {
      this.serviceSubscriptions.delete(subscriptionId);
      this.send({ op: 'unsubscribe_service', subscriptionId });
    };
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  subscribeSession(sessionId: string, afterSeq: number): void {
    if (this.activeSubscription && this.activeSubscription.sessionId !== sessionId) {
      this.send({ op: 'unsubscribe', sessionId: this.activeSubscription.sessionId });
    }
    this.activeSubscription = { sessionId, afterSeq };
    this.send({ op: 'subscribe', sessionId, afterSeq });
  }

  subscribeCommandOutput(sessionId: string, toolCallId: string): void {
    const key = `${sessionId}::${toolCallId}`;
    this.commandOutputSubscriptions.set(key, { sessionId, toolCallId });
    this.send({ op: 'subscribe_command_output', sessionId, toolCallId });
  }

  unsubscribeCommandOutput(sessionId: string, toolCallId: string): void {
    const key = `${sessionId}::${toolCallId}`;
    this.commandOutputSubscriptions.delete(key);
    this.send({ op: 'unsubscribe_command_output', sessionId, toolCallId });
  }

  subscribeTerminal(terminalId: string): void {
    this.terminalSubscriptions.add(terminalId);
    this.send({ op: 'subscribe_terminal', terminalId });
  }

  unsubscribeTerminal(terminalId: string): void {
    this.terminalSubscriptions.delete(terminalId);
    this.send({ op: 'unsubscribe_terminal', terminalId });
  }

  sendTerminalInput(terminalId: string, data: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.send({ op: 'terminal_input', terminalId, data });
    return true;
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.send({ op: 'terminal_resize', terminalId, cols, rows });
  }

  updateCursor(sessionId: string, seq: number): void {
    if (this.activeSubscription && this.activeSubscription.sessionId === sessionId) {
      this.activeSubscription.afterSeq = Math.max(this.activeSubscription.afterSeq, seq);
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private openSocket(): void {
    if (this.closed) return;
    try {
      const ws = new WebSocket(getDaemonWsUrl());
      this.ws = ws;

      ws.onopen = () => {
        for (const sub of this.serviceSubscriptions.values()) this.send(sub.frame);
        this.handlers.onConnected(true);
        this.send({ op: 'subscribe_attention' });
        if (this.activeSubscription) {
          this.send({
            op: 'subscribe',
            sessionId: this.activeSubscription.sessionId,
            afterSeq: this.activeSubscription.afterSeq,
          });
        }
        for (const sub of this.commandOutputSubscriptions.values()) {
          this.send({
            op: 'subscribe_command_output',
            sessionId: sub.sessionId,
            toolCallId: sub.toolCallId,
          });
        }
        for (const terminalId of this.terminalSubscriptions) {
          this.send({ op: 'subscribe_terminal', terminalId });
        }
      };

      ws.onmessage = (ev) => {
        try {
          const hostWsReceivedAt = Date.now();
          const frame = JSON.parse(String(ev.data)) as WsServerFrame;
          if (frame.op === 'plugins_changed') for (const sub of this.serviceSubscriptions.values()) this.send(sub.frame);
          for (const listener of this.frameObservers) listener(frame);
          if (frame.op === 'service_batch') {
            const firstEv = frame.events[0]?.payload as { trace?: { runtimeReceivedAt?: number; committedAt?: number } } | undefined;
            frontendPerfDiagnostics.recordHostWsBatch({
              subscriptionId: frame.subscriptionId,
              hostWsReceivedAt,
              serverFlushedAt: frame.serverFlushedAt,
              runtimeReceivedAt: firstEv?.trace?.runtimeReceivedAt,
              postCommitAt: firstEv?.trace?.committedAt,
              eventCount: frame.events.length,
              serverQueueDepth: frame.queueDepth,
              serverBacklogMs: frame.backlogMs,
            });
            this.serviceSubscriptions.get(frame.subscriptionId)?.listener(frame);
          }
          this.handlers.onFrame(frame);
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        this.handlers.onConnected(false);
        if (!this.closed) {
          this.reconnectTimer = window.setTimeout(() => this.openSocket(), 1800);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.handlers.onConnected(false);
      if (!this.closed) {
        this.reconnectTimer = window.setTimeout(() => this.openSocket(), 2000);
      }
    }
  }

  private send(frame: WsClientFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}
