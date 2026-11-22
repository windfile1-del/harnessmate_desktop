import type {
  AddMcpServerRequest,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  ContextPreview,
  ContextSyncMode,
  CreateSessionRequest,
  CustomAcpHarnessConfig,
  DiscoveredCliSession,
  FailoverRequest,
  GitStatusSummary,
  HarnessAccountUsage,
  HarnessCommandInfo,
  HarnessCommandResult,
  HarnessInfo,
  InstalledPluginInfo,
  InstallPluginRequest,
  GeneratePluginDraftRequest,
  PluginManifest,
  ImportNativeSessionRequest,
  McpServerEntry,
  PluginCatalogItem,
  PluginMcpPreset,
  PluginSlashCommand,
  RemoteAccessStatus,
  RunHarnessCommandRequest,
  Session,
  SessionTaskState,
  PluginPanelQuery,
  PluginPanelSnapshot,
  SwitchHarnessRequest,
  ToggleMcpServerRequest,
  UpdateSessionRequest,
  UpdateTaskStateRequest,
  UploadAttachmentRequest,
  Workspace,
  WorkspaceFileEntry,
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
  digest?: string;
  fileCount?: number;
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

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getDaemonBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
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
    const errMsg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
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

  discoverLocalCliSessions: (limit = 20) =>
    apiFetch<{ sessions: DiscoveredCliSession[]; hasMore: boolean }>(`/api/v1/harnesses/discovered-sessions?limit=${limit}`),

  importNativeSession: (req: ImportNativeSessionRequest) =>
    apiFetch<{ session: Session }>('/api/v1/harnesses/import-session', {
      method: 'POST', body: JSON.stringify(req),
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
  getAccountUsage: () =>
    apiFetch<{ accounts: HarnessAccountUsage[]; collectedAt: number }>('/api/v1/usage/accounts'),

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

  getHarnessCommands: (id: string) =>
    apiFetch<{ commands: HarnessCommandInfo[] }>(`/api/v1/sessions/${encodeURIComponent(id)}/commands`),

  runHarnessCommand: (id: string, req: RunHarnessCommandRequest) =>
    apiFetch<HarnessCommandResult>(`/api/v1/sessions/${encodeURIComponent(id)}/commands`, {
      method: 'POST', body: JSON.stringify(req),
    }),

  sendTurn: (
    id: string,
    text: string,
    attachments?: Attachment[],
    opts?: { harnessId?: string; model?: string | null },
  ) =>
    apiFetch<{ turnId: string }>(`/api/v1/sessions/${encodeURIComponent(id)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        attachments,
        ...(opts?.harnessId ? { harnessId: opts.harnessId } : {}),
        ...(opts?.model !== undefined ? { model: opts.model } : {}),
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

  readSessionFile: (sessionId: string, relativePath: string) =>
    apiFetch<{ relativePath: string; content: string; truncated: boolean; sizeBytes: number }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/file-content?path=${encodeURIComponent(relativePath)}`,
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

  exportSessionMarkdown: (sessionId: string) =>
    apiFetch<{ filename: string; markdown: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/export`,
    ),

  getSessionGit: (id: string) =>
    apiFetch<{ git: GitStatusSummary }>(`/api/v1/sessions/${encodeURIComponent(id)}/git`),

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
