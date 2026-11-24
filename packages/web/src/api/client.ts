import type {
  AddMcpServerRequest,
  AddTrustedPublisherRequest,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  CheckpointRevertMode,
  CheckpointRevertResult,
  ContextPreview,
  ContextSyncMode,
  CreateCustomRiskRuleRequest,
  CreateSessionRequest,
  CreateWorktreeRequest,
  CustomAcpHarnessConfig,
  CustomRiskRule,
  DiscoveredCliSession,
  DryRunMergeRequest,
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
  PluginManifest,
  ImportNativeSessionRequest,
  ImportSessionBundleRequest,
  McpServerEntry,
  MergeBackRequest,
  MergeBackResult,
  PluginCatalogItem,
  PluginLogEntryDto,
  PluginMcpPreset,
  PluginPermission,
  PluginRegistryStateDto,
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
  SessionModelPluginTools,
  SessionPluginAction,
  SessionSearchResponse,
  SetPluginPermissionRequest,
  SessionTaskState,
  SideChatMessage,
  SideChatPromoteRequest,
  SideChatRequest,
  PluginPanelQuery,
  PluginPanelSnapshot,
  PluginUiMessageRequest,
  PluginBrowserFrame,
  PluginBrowserStatus,
  SwitchHarnessRequest,
  ToggleMcpServerRequest,
  TrustSetupScriptRequest,
  TurnBlockRecord,
  TurnOptionsMap,
  UpdatePluginRegistryConfigRequest,
  UpdateSessionRequest,
  UpdateTaskStateRequest,
  UploadAttachmentRequest,
  Workspace,
  WorkspaceFileEntry,
  WorkspaceSetupScriptInfo,
  WsClientFrame,
  WsServerFrame,
} from '@harnessmate/protocol';

declare global {
  interface Window {
    harnessMateBridge?: {
      daemonUrl?: string;
      pickDirectory: () => Promise<string | null>;
      openExternal: (url: string) => Promise<void>;
      notify: (title: string, body: string) => void;
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

export interface PluginBundleResponse {
  plugins: InstalledPluginInfo[];
  catalog: PluginCatalogItem[];
  slashCommands: Array<PluginSlashCommand & { pluginId: string; pluginName: string }>;
  mcpPresets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }>;
  pluginsDir: string;
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

export const daemonApi = {
  health: () =>
    apiFetch<{
      status: string;
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

  getPluginComposition: () => apiFetch<{ bundles: string[]; error?: string;
    entries: Array<{ id: string; name: string; disabled: boolean; config: Record<string, unknown>; sources: string[] }>;
  }>('/api/v1/plugins/composition'),

  previewTurnSuggestion: (id: string, text: string, attachments?: Attachment[]) =>
    apiFetch<{ suggestion: { text: string; pluginNames: string[] } | null }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/turn-suggestion`,
      { method: 'POST', body: JSON.stringify({ text, attachments }) },
    ),

  replayPluginDraft: (req: ReplayPluginDraftRequest, signal?: AbortSignal) =>
    apiFetch<PluginPanelSnapshot>('/api/v1/plugins/preview/replay', { method: 'POST', body: JSON.stringify(req), signal }),

  previewPluginProgram: (request: PreviewPluginProgramRequest) =>
    apiFetch<{ output: string }>('/api/v1/plugins/preview/program', { method: 'POST', body: JSON.stringify(request) }),

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

  generatePlugin: (req: GeneratePluginDraftRequest, signal: AbortSignal) =>
    apiFetch<{ manifest: PluginManifest }>('/api/v1/plugins/generate', { method: 'POST', body: JSON.stringify(req), signal }),

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

  linkDevPlugin: (dirPath: string) =>
    apiFetch<PluginBundleResponse>('/api/v1/plugins/dev/link', {
      method: 'POST',
      body: JSON.stringify({ dirPath }),
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

  scaffoldPlugin: (req: ScaffoldPluginRequest) =>
    apiFetch<PluginBundleResponse & { dirPath: string; files: string[] }>('/api/v1/plugins/scaffold', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

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
  listMcpServers: () =>
    apiFetch<{
      servers: McpServerEntry[];
      presets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }>;
    }>('/api/v1/mcp/servers'),

  addMcpServer: (req: AddMcpServerRequest) =>
    apiFetch<{
      results: Array<{ harnessId: string; ok: boolean; message: string }>;
      servers: McpServerEntry[];
    }>('/api/v1/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  toggleMcpServer: (req: ToggleMcpServerRequest) =>
    apiFetch<{ result: { ok: boolean; message: string }; servers: McpServerEntry[] }>(
      '/api/v1/mcp/servers/toggle',
      {
        method: 'PATCH',
        body: JSON.stringify(req),
      },
    ),

  removeMcpServer: (harnessId: 'codex' | 'agy' | 'claude', name: string) =>
    apiFetch<{ result: { ok: boolean; message: string }; servers: McpServerEntry[] }>(
      `/api/v1/mcp/servers/${encodeURIComponent(harnessId)}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  // Accounts & Usage
  getAccountUsage: (refresh = false) =>
    apiFetch<{ accounts: HarnessAccountUsage[]; collectedAt: number }>(
      `/api/v1/usage/accounts${refresh ? '?refresh=1' : ''}`,
    ),

  getFailoverPolicy: () =>
    apiFetch<{ policy: FailoverPolicy }>('/api/v1/usage/failover-policy'),

  updateFailoverPolicy: (policy: FailoverPolicy) =>
    apiFetch<{ policy: FailoverPolicy }>('/api/v1/usage/failover-policy', {
      method: 'PUT',
      body: JSON.stringify(policy),
    }),

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
    );
  },

  getHarnessCommands: (id: string) =>
    apiFetch<{ commands: HarnessCommandInfo[]; pluginActions: SessionPluginAction[]; modelTools: SessionModelPluginTools }>(
      `/api/v1/sessions/${encodeURIComponent(id)}/commands`),

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
    },
  ) =>
    apiFetch<{ turnId: string }>(`/api/v1/sessions/${encodeURIComponent(id)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        attachments,
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

  getTaskState: (sessionId: string) =>
    apiFetch<{ taskState: SessionTaskState }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/task-state`,
    ),

  updateTaskState: (sessionId: string, patch: UpdateTaskStateRequest) =>
    apiFetch<{ taskState: SessionTaskState }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/task-state`,
      {
        method: 'PUT',
        body: JSON.stringify(patch),
      },
    ),

  summarizeTaskState: (sessionId: string) =>
    apiFetch<{ taskState: SessionTaskState }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/task-state/summarize`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
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
    apiFetch<{ worktrees: GitWorktreeEntry[]; setupScript: WorkspaceSetupScriptInfo }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees`,
    ),

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
};

export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;
  private activeSubscription: { sessionId: string; afterSeq: number } | null = null;
  private commandOutputSubscriptions = new Map<string, { sessionId: string; toolCallId: string }>();

  constructor(
    private readonly handlers: {
      onConnected: (connected: boolean) => void;
      onFrame: (frame: WsServerFrame) => void;
    },
  ) {}

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
      };

      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(String(ev.data)) as WsServerFrame;
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
