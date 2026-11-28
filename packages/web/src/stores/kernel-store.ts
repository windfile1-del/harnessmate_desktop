import type {
  ApplicationSwitchResult,
  InstalledPluginInfo,
} from '@harnessmate/protocol';
import { create } from 'zustand';
import { DaemonWsClient, daemonApi } from '../api/client';
import {
  APPLICATION_VIEW_CONTRACT,
  getPluginInstanceId,
  pluginProvidesContract,
  resolveServiceSelectionClientSide,
  type ServiceResolutionV1,
} from '../api/peer-contracts';
import { defaultPeerWorkspaceTransport } from '../api/peer-workspace-client';
import { kernelRecoveryClient } from '../kernel/recovery-client';

export type KernelRecoveryKind =
  | 'empty_composition'
  | 'entry_unbound'
  | 'entry_disabled'
  | 'entry_unavailable'
  | 'load_failed'
  | 'runtime_error';

export interface KernelRecoveryState {
  kind: KernelRecoveryKind;
  instanceId?: string;
  pluginId?: string;
  message?: string;
  restartRequired?: boolean;
}

export interface KernelRestartStatus {
  required: boolean;
  reason?: string;
}

export interface KernelStoreState {
  theme: 'dark' | 'light';
  connected: boolean;
  loading: boolean;
  initialized: boolean;
  plugins: InstalledPluginInfo[];
  emptyComposition: boolean;
  compositionBindings: Record<string, string>;
  compositionEntries: Array<{ id: string; name: string; disabled: boolean }>;
  compositionCanRestore: boolean;
  compositionSafeMode: boolean;
  compositionError: string | null;
  workspaceBindingsByWorkspace: Record<string, Record<string, string | null>>;
  sessionBindingsBySession: Record<string, Record<string, string | null>>;
  pluginPermissionRevision: number;
  applicationFailure: KernelRecoveryState | null;
  restartStatus: KernelRestartStatus | null;

  initKernel: () => Promise<void>;
  setTheme: (theme: 'dark' | 'light') => void;
  toggleTheme: () => void;
  refreshPlugins: () => Promise<void>;
  refreshComposition: (workspaceId?: string) => Promise<void>;
  refreshWorkspaceBindings: (workspaceId: string) => Promise<void>;
  setWorkspaceBinding: (workspaceId: string, contract: string, instanceId: string | null) => Promise<void>;
  refreshSessionBindings: (sessionId: string) => Promise<void>;
  setSessionBinding: (sessionId: string, contract: string, instanceId: string | null) => Promise<void>;
  setCompositionBinding: (contract: string, instanceId: string | null) => Promise<void>;
  switchApplicationEntry: (
    instanceId: string | null,
    options?: { requiresRestart?: boolean; restartReason?: string },
  ) => Promise<ApplicationSwitchResult>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  rollbackPlugin: (id: string) => Promise<void>;
  restoreComposition: (source: 'builtin' | 'previous' | 'empty') => Promise<void>;
  reloadPlugins: () => Promise<void>;
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
  resolveApplicationEntry: () => ServiceResolutionV1;
  invalidatePluginPermissions: () => void;
  reportApplicationFailure: (failure: KernelRecoveryState) => void;
  clearApplicationFailure: () => void;
  setRestartStatus: (status: KernelRestartStatus | null) => void;
  subscribeCommandOutput: (sessionId: string, toolCallId: string) => () => void;
}

let kernelWsClient: DaemonWsClient | null = null;
const commandOutputRefCounts = new Map<string, number>();

export function applyKernelThemeToDocument(theme: 'dark' | 'light'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    localStorage.setItem('hm_desktop_theme', theme);
  } catch {
    // ignore storage errors
  }
}

export function getInitialKernelTheme(): 'dark' | 'light' {
  try {
    const saved = localStorage.getItem('hm_desktop_theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore storage errors
  }
  return 'dark';
}

export const useKernelStore = create<KernelStoreState>((set, get) => {
  const initialTheme = getInitialKernelTheme();
  applyKernelThemeToDocument(initialTheme);

  return {
    theme: initialTheme,
    connected: false,
    loading: true,
    initialized: false,
    plugins: [],
    emptyComposition: false,
    compositionBindings: {},
    compositionEntries: [],
    compositionCanRestore: false,
    compositionSafeMode: false,
    compositionError: null,
    workspaceBindingsByWorkspace: {},
    sessionBindingsBySession: {},
    pluginPermissionRevision: 0,
    applicationFailure: null,
    restartStatus: null,

    initKernel: async () => {
      if (!kernelWsClient) {
        kernelWsClient = new DaemonWsClient({
          onConnected: (connected) => {
            set({ connected });
            if (connected && get().initialized) {
              void get().refreshPlugins().catch(() => {});
            }
          },
          onFrame: (frame) => {
            if (frame.op === 'plugins_changed') {
              void get().refreshPlugins().catch(() => {});
            }
          },
        });
        kernelWsClient.connect();
      }
      set({ loading: true });
      try {
        await get().refreshPlugins();
        set({ loading: false, initialized: true });
      } catch (err) {
        set({
          loading: false,
          initialized: true,
          compositionError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    setTheme: (theme) => {
      applyKernelThemeToDocument(theme);
      set({ theme });
    },

    toggleTheme: () => {
      const next = get().theme === 'dark' ? 'light' : 'dark';
      applyKernelThemeToDocument(next);
      set({ theme: next });
    },

    refreshPlugins: async () => {
      const [pluginsRes, compRes] = await Promise.all([
        kernelRecoveryClient.listPlugins(),
        kernelRecoveryClient.getComposition().catch(() => null),
      ]);
      set((state) => ({
        plugins: pluginsRes.plugins,
        emptyComposition: Boolean(pluginsRes.emptyComposition ?? compRes?.emptyComposition),
        ...(compRes
          ? {
              compositionBindings: compRes.bindings ?? {},
              compositionEntries: (compRes.entries ?? []).map((e) => ({
                id: e.id,
                name: e.name,
                disabled: Boolean(e.disabled),
              })),
              compositionCanRestore: Boolean(compRes.canRestore),
              compositionSafeMode: Boolean(compRes.safeMode),
              compositionError: compRes.error ?? null,
            }
          : {}),
        // Clear stale load failure when the previously failed instance changes or is no longer selected
        applicationFailure:
          state.applicationFailure &&
          compRes?.bindings?.[APPLICATION_VIEW_CONTRACT] !== state.applicationFailure.instanceId
            ? null
            : state.applicationFailure,
      }));
    },

    refreshComposition: async (workspaceId) => {
      const comp = workspaceId && typeof daemonApi.getPluginComposition === 'function'
        ? await daemonApi.getPluginComposition(workspaceId)
        : await kernelRecoveryClient.getComposition();
      set({
        compositionBindings: comp.bindings ?? {},
        compositionEntries: (comp.entries ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          disabled: Boolean(e.disabled),
        })),
        emptyComposition: Boolean(comp.emptyComposition),
        compositionCanRestore: Boolean(comp.canRestore),
        compositionSafeMode: Boolean(comp.safeMode),
        compositionError: comp.error ?? null,
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
      }));
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
    },

    setCompositionBinding: async (contract, instanceId) => {
      const res = await kernelRecoveryClient.setCompositionBinding(contract, instanceId);
      set({
        compositionBindings: res.composition.bindings ?? {},
        compositionEntries: (res.composition.entries ?? []).map((e) => ({
          id: e.id,
          name: e.name,
          disabled: Boolean(e.disabled),
        })),
        emptyComposition: Boolean(res.composition.emptyComposition),
        applicationFailure: contract === APPLICATION_VIEW_CONTRACT ? null : get().applicationFailure,
      });
    },

    switchApplicationEntry: async (instanceId, options) => {
      const previousInstanceId = get().compositionBindings[APPLICATION_VIEW_CONTRACT] ?? null;
      if (instanceId !== null) {
        const target = get().plugins.find(
          (plugin) =>
            (getPluginInstanceId(plugin) === instanceId || plugin.id === instanceId) &&
            pluginProvidesContract(plugin, APPLICATION_VIEW_CONTRACT),
        );
        if (!target) {
          return {
            status: 'failed',
            instanceId,
            previousInstanceId,
            code: 'E_SERVICE_UNAVAILABLE',
            reason: `应用布局实例 ${instanceId} 不存在或未提供 ${APPLICATION_VIEW_CONTRACT}`,
          };
        }
        if (!target.enabled || (target.runtimeState && target.runtimeState !== 'ACTIVE')) {
          return {
            status: 'failed',
            instanceId,
            previousInstanceId,
            code: 'E_PLUGIN_DISABLED',
            reason: `应用布局实例 ${instanceId} 当前未启用或未就绪`,
          };
        }
      }
      try {
        await get().setCompositionBinding(APPLICATION_VIEW_CONTRACT, instanceId);
        if (options?.requiresRestart) {
          const reason = options.restartReason ?? '新布局声明需要重启应用窗口以完整生效。';
          set({ restartStatus: { required: true, reason } });
          return {
            status: 'restart_required',
            instanceId,
            previousInstanceId,
            restartRequired: true,
            reason,
          };
        }
        set({ applicationFailure: null, restartStatus: null });
        return {
          status: 'applied',
          instanceId,
          previousInstanceId,
          restartRequired: false,
        };
      } catch (err) {
        return {
          status: 'failed',
          instanceId,
          previousInstanceId,
          code: 'E_SWITCH_FAILED',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    togglePlugin: async (id, enabled) => {
      await kernelRecoveryClient.togglePlugin(id, enabled);
      set({ applicationFailure: null });
      await get().refreshPlugins();
    },

    rollbackPlugin: async (id) => {
      await kernelRecoveryClient.rollbackPlugin(id);
      set({ applicationFailure: null });
      await get().refreshPlugins();
    },

    restoreComposition: async (source) => {
      await kernelRecoveryClient.restoreComposition(source);
      set({ applicationFailure: null, restartStatus: null });
      await get().refreshPlugins();
    },

    reloadPlugins: async () => {
      await kernelRecoveryClient.reloadPlugins();
      set({ applicationFailure: null });
      await get().refreshPlugins();
    },

    resolveService: (contract, opts) => {
      const state = get();
      return defaultPeerWorkspaceTransport.resolveServiceSelection(contract, {
        workspaceId: opts?.workspaceId,
        sessionId: opts?.sessionId,
        explicitInstanceId: opts?.explicitInstanceId,
        allowSingleCandidate: opts?.allowSingleCandidate ?? true,
        plugins: state.plugins,
        sessionBindings: opts?.sessionId ? state.sessionBindingsBySession[opts.sessionId] : undefined,
        workspaceBindings: opts?.workspaceId ? state.workspaceBindingsByWorkspace[opts.workspaceId] : undefined,
        compositionBindings: state.compositionBindings,
        compositionEntries: state.compositionEntries,
        signal: opts?.signal,
      });
    },

    resolveApplicationEntry: () => {
      const state = get();
      return resolveServiceSelectionClientSide({
        contract: APPLICATION_VIEW_CONTRACT,
        allowSingleCandidate: false,
        plugins: state.plugins,
        compositionBindings: state.compositionBindings,
        compositionEntries: state.compositionEntries,
      });
    },

    invalidatePluginPermissions: () =>
      set((state) => ({ pluginPermissionRevision: state.pluginPermissionRevision + 1 })),

    reportApplicationFailure: (failure) =>
      set({
        applicationFailure: failure,
        ...(failure.restartRequired
          ? { restartStatus: { required: true, reason: failure.message ?? '需要重启以完成恢复。' } }
          : {}),
      }),

    clearApplicationFailure: () => set({ applicationFailure: null }),

    setRestartStatus: (restartStatus) => set({ restartStatus }),

    subscribeCommandOutput: (sessionId, toolCallId) => {
      const key = `${sessionId}::${toolCallId}`;
      const prev = commandOutputRefCounts.get(key) ?? 0;
      commandOutputRefCounts.set(key, prev + 1);
      if (prev === 0) {
        kernelWsClient?.subscribeCommandOutput(sessionId, toolCallId);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (commandOutputRefCounts.get(key) ?? 1) - 1;
        if (count <= 0) {
          commandOutputRefCounts.delete(key);
          kernelWsClient?.unsubscribeCommandOutput(sessionId, toolCallId);
        } else {
          commandOutputRefCounts.set(key, count);
        }
      };
    },
  };
});
