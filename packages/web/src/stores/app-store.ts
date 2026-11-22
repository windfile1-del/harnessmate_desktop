import type {
  AddMcpServerRequest,
  ApprovalDecision,
  Attachment,
  AttentionItem,
  CanonicalEvent,
  ContextPreview,
  ContextSyncMode,
  CreateSessionRequest,
  CustomAcpHarnessConfig,
  DiscoveredCliSession,
  FailoverRequest,
  GitStatusSummary,
  HarnessAccountUsage,
  HarnessCommandResult,
  HarnessInfo,
  HarnessKind,
  InstalledPluginInfo,
  ImportNativeSessionRequest,
  InstallPluginRequest,
  McpServerEntry,
  PluginCatalogItem,
  PluginMcpPreset,
  PluginSlashCommand,
  RemoteAccessStatus,
  RunHarnessCommandRequest,
  Session,
  SessionTaskState,
  SwitchHarnessRequest,
  ToggleMcpServerRequest,
  UpdateSessionRequest,
  UpdateTaskStateRequest,
  Workspace,
} from '@harnessmate/protocol';
import { create } from 'zustand';
import { DaemonWsClient, daemonApi } from '../api/client';

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
  activeModal: ActiveModal;
  newSessionPresetHarnessId: string | null;

  harnesses: HarnessInfo[];
  workspaces: Workspace[];
  sessions: Session[];
  discoveredSessions: DiscoveredCliSession[];
  remoteStatus: RemoteAccessStatus | null;

  // Modular Plugin System
  plugins: InstalledPluginInfo[];
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

  selectedWorkspaceId: string | null;
  harnessFilter: string | null;
  searchQuery: string;
  selectedSessionId: string | null;

  eventsBySession: Record<string, CanonicalEvent[]>;
  gitBySession: Record<string, GitStatusSummary | null>;
  taskStateBySession: Record<string, SessionTaskState | null>;
  contextPreviewBySession: Record<string, ContextPreview | null>;
  draftTextBySession: Record<string, string>;
  draftAttachmentsBySession: Record<string, Attachment[]>;
  toasts: ToastNotice[];

  // Actions
  init: () => Promise<void>;
  toggleTheme: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  openModal: (modal: ActiveModal, presetHarnessId?: string | null) => void;
  setSelectedWorkspaceId: (id: string | null) => void;
  setHarnessFilter: (id: string | null) => void;
  setSearchQuery: (q: string) => void;

  setDraftText: (sessionId: string, text: string) => void;
  addDraftAttachment: (sessionId: string, att: Attachment) => void;
  removeDraftAttachment: (sessionId: string, attId: string) => void;
  clearDraft: (sessionId: string) => void;

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

  refreshAccountUsage: () => Promise<void>;
  refreshRemoteStatus: () => Promise<void>;
  loadDiscoveredSessions: (limit?: number) => Promise<boolean>;

  addWorkspace: (rootPath: string, name?: string) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createSession: (req: CreateSessionRequest) => Promise<Session>;
  importNativeSession: (req: ImportNativeSessionRequest) => Promise<Session>;
  runHarnessCommand: (id: string, req: RunHarnessCommandRequest) => Promise<HarnessCommandResult>;
  updateSession: (id: string, patch: UpdateSessionRequest) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  switchHarness: (sessionId: string, req: SwitchHarnessRequest) => Promise<void>;
  failoverSession: (sessionId: string, req: FailoverRequest) => Promise<void>;
  refreshContextPreview: (sessionId: string, targetHarnessId?: string, syncMode?: ContextSyncMode) => Promise<ContextPreview | null>;
  refreshTaskState: (sessionId: string) => Promise<void>;
  updateTaskState: (sessionId: string, patch: UpdateTaskStateRequest) => Promise<void>;
  summarizeTaskState: (sessionId: string) => Promise<void>;
  handoffSession: (sourceId: string, targetHarnessId: string, targetModel?: string | null) => Promise<void>;
  sendTurn: (sessionId: string, text: string, attachments?: Attachment[]) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  resolveApproval: (approvalId: string, decision: ApprovalDecision, comment?: string) => Promise<void>;
  refreshGitStatus: (sessionId: string) => Promise<void>;

  registerCustomHarness: (cfg: CustomAcpHarnessConfig) => Promise<void>;
  deleteCustomHarness: (id: string) => Promise<void>;

  toggleLanAccess: (enabled: boolean) => Promise<void>;
  generatePairingCode: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;

  pushToast: (toast: Omit<ToastNotice, 'id'>) => void;
  dismissToast: (id: string) => void;
}

let wsClient: DaemonWsClient | null = null;

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

  const ingestEvent = (event: CanonicalEvent) => {
    set((state) => {
      const list = state.eventsBySession[event.sessionId] ?? [];
      if (list.some((e) => e.seq === event.seq)) {
        return state;
      }
      const nextList = [...list, event].sort((a, b) => a.seq - b.seq);
      wsClient?.updateCursor(event.sessionId, event.seq);

      const sessions = state.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
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
      });

      return {
        eventsBySession: {
          ...state.eventsBySession,
          [event.sessionId]: nextList,
        },
        sessions,
      };
    });

    const currentSelected = get().selectedSessionId;
    if (event.type === 'turn.completed' || event.type === 'tool.call.completed') {
      if (currentSelected === event.sessionId && get().inspectorOpen) {
        void get().refreshGitStatus(event.sessionId);
      }
      if (event.type === 'turn.completed' && currentSelected === event.sessionId) {
        void get().refreshContextPreview(event.sessionId);
        void daemonApi
          .getSession(event.sessionId)
          .then(({ session, taskState }) =>
            set((state) => ({
              sessions: state.sessions.map((s) => (s.id === session.id ? session : s)),
              ...(taskState
                ? { taskStateBySession: { ...state.taskStateBySession, [session.id]: taskState } }
                : {}),
            })),
          )
          .catch(() => {});
      }
    } else if (event.type === 'task.state_updated' && currentSelected === event.sessionId) {
      void get().refreshTaskState(event.sessionId);
    }
  };

  const handleAttention = (item: AttentionItem) => {
    if (item.kind === 'approval_needed') {
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

  return {
    theme: initialTheme,
    connected: false,
    loading: true,
    sidebarCollapsed: false,
    inspectorOpen: false,
    inspectorTab: 'task',
    activeModal: null,
    newSessionPresetHarnessId: null,

    harnesses: [],
    workspaces: [],
    sessions: [],
    discoveredSessions: [],
    remoteStatus: null,

    plugins: [],
    pluginCatalog: [],
    slashCommands: [],
    mcpPresets: [],
    pluginsDir: '',

    mcpServers: [],
    mcpLoading: false,
    accountUsage: [],
    usageLoading: false,
    usageCollectedAt: null,

    selectedWorkspaceId: null,
    harnessFilter: null,
    searchQuery: '',
    selectedSessionId: null,

    eventsBySession: {},
    gitBySession: {},
    taskStateBySession: {},
    contextPreviewBySession: {},
    draftTextBySession: {},
    draftAttachmentsBySession: {},
    toasts: [],

    init: async () => {
      if (!wsClient) {
        wsClient = new DaemonWsClient({
          onConnected: (connected) => set({ connected }),
          onFrame: (frame) => {
            if (frame.op === 'event') {
              ingestEvent(frame.event);
            } else if (frame.op === 'attention') {
              handleAttention(frame.item);
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
    setInspectorTab: (tab) => set({ inspectorTab: tab }),
    openModal: (modal, presetHarnessId = null) =>
      set({ activeModal: modal, newSessionPresetHarnessId: presetHarnessId }),
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
      })),

    isPluginEnabled: (pluginId) => {
      const found = get().plugins.find((p) => p.id === pluginId);
      return found ? found.enabled : true;
    },

    refreshAll: async () => {
      set({ loading: true });
      try {
        const [hRes, wRes, sRes, rRes, pRes] = await Promise.all([
          daemonApi.listHarnesses(false),
          daemonApi.listWorkspaces(),
          daemonApi.listSessions(),
          daemonApi.getRemoteStatus(),
          daemonApi.listPlugins(),
        ]);
        set({
          harnesses: hRes.harnesses,
          workspaces: wRes.workspaces,
          sessions: sRes.sessions,
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

    refreshAccountUsage: async () => {
      set({ usageLoading: true });
      try {
        const res = await daemonApi.getAccountUsage();
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
      set({ selectedSessionId: sessionId });
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
          sessions: state.sessions.map((s) => (s.id === sessionId && s.lastSeq <= detail.session.lastSeq ? detail.session : s)),
          ...(detail.taskState
            ? { taskStateBySession: { ...state.taskStateBySession, [sessionId]: detail.taskState } }
            : {}),
        }));

        const latestList = get().eventsBySession[sessionId] ?? [];
        wsClient?.subscribeSession(sessionId, contiguousCursor(latestList));

        void get().refreshContextPreview(sessionId);
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

    updateSession: async (id, patch) => {
      const { session } = await daemonApi.updateSession(id, patch);
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? session : s)),
      }));
    },

    deleteSession: async (id) => {
      await daemonApi.deleteSession(id);
      set((state) => {
        const nextSessions = state.sessions.filter((s) => s.id !== id);
        return {
          sessions: nextSessions,
          selectedSessionId:
            state.selectedSessionId === id ? (nextSessions[0]?.id ?? null) : state.selectedSessionId,
        };
      });
    },

    switchHarness: async (sessionId, req) => {
      try {
        const res = await daemonApi.switchHarness(sessionId, req);
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? res.session : s)),
          contextPreviewBySession: {
            ...state.contextPreviewBySession,
            [sessionId]: res.contextPreview,
          },
        }));
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

    sendTurn: async (sessionId, text, attachments) => {
      try {
        await daemonApi.sendTurn(sessionId, text, attachments);
        const { session } = await daemonApi.getSession(sessionId);
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? session : s)),
        }));
      } catch (err) {
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

    resolveApproval: async (approvalId, decision, comment) => {
      try {
        await daemonApi.resolveApproval(approvalId, decision, comment);
      } catch (err) {
        get().pushToast({
          kind: 'error',
          title: '审批提交失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
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
  };
});
