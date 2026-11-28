import { createContext, useContext } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { HarnessInfo, Workspace, Session, InstallPluginRequest, CustomAcpHarnessConfig } from '@harnessmate/protocol';
import { daemonApi, type PluginBundleResponse } from '../../api/client';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { openContractPage } from '../../api/plugin-navigation';
export interface ManagementState {
  developerInstanceId?: string;
  previewPage(instanceId: string, pageId: string): Promise<unknown>;
  plugins: PluginBundleResponse['plugins']; pluginCatalog: PluginBundleResponse['catalog']; pluginsDir: string;
  workspaces: Workspace[]; harnesses: HarnessInfo[]; sessions: Session[];
  selectedWorkspaceId: string | null; selectedSessionId: string | null; pluginPermissionRevision: number;
  sessionBindingsBySession: Record<string, Record<string, string | null>>;
  refreshPlugins(): Promise<void>; refreshHarnesses(): Promise<void>;
  installPlugin(req: InstallPluginRequest): Promise<void>; togglePlugin(id: string, enabled: boolean): Promise<void>;
  uninstallPlugin(id: string): Promise<void>; reloadPlugins(): Promise<void>; rollbackPlugin(id: string): Promise<void>;
  restorePluginComposition(source: 'builtin' | 'previous' | 'empty'): Promise<void>;
  refreshSessionBindings(id: string): Promise<void>; setSessionBinding(id: string, contract: string, instanceId: string | null): Promise<void>;
  invalidatePluginPermissions(): void;
  registerCustomHarness(config: CustomAcpHarnessConfig): Promise<void>; deleteCustomHarness(id: string): Promise<void>;
  pushToast(notice: { title: string; body?: string; kind: 'info' | 'success' | 'warning' | 'error' }): void;
  openDeveloperTools(context?: Record<string, unknown>): Promise<unknown>;
}
export const ManagementStoreContext = createContext<StoreApi<ManagementState> | null>(null);
export function useManagementStore() {
  const store = useContext(ManagementStoreContext);
  if (!store) throw new Error('Management view is not mounted');
  return useStore(store);
}
export function createManagementStore(bridge: TrustedModulePageBridge, developerInstanceId?: string) {
  let alive = true;
  const store = createStore<ManagementState>((set, get) => {
    const update = async (fn: () => Promise<PluginBundleResponse>) => {
      const result = await fn(); if (!alive) return;
      set({ plugins: result.plugins, pluginCatalog: result.catalog ?? [], pluginsDir: result.pluginsDir ?? '' });
      await bridge.kernel.refreshPlugins();
    };
    return {
      developerInstanceId,
      previewPage: (instanceId, pageId) => bridge.navigate({ target: { kind: 'page', instanceId, pageId }, placement: 'primary' }),
      plugins: [], pluginCatalog: [], pluginsDir: '', workspaces: [], sessions: [], harnesses: [],
      selectedWorkspaceId: bridge.workspaceId ?? bridge.session?.workspaceId ?? null, selectedSessionId: bridge.session?.id ?? null,
      pluginPermissionRevision: 0, sessionBindingsBySession: {},
      refreshPlugins: () => update(daemonApi.listPlugins),
      refreshHarnesses: async () => { const result = await daemonApi.listHarnesses(true); if (alive) set({ harnesses: result.harnesses }); },
      installPlugin: req => update(() => daemonApi.installPlugin(req)),
      togglePlugin: (id, enabled) => update(() => daemonApi.togglePlugin(id, enabled)),
      uninstallPlugin: id => update(() => daemonApi.uninstallPlugin(id)),
      rollbackPlugin: id => update(() => daemonApi.rollbackPlugin(id)),
      reloadPlugins: () => update(daemonApi.reloadPlugins),
      restorePluginComposition: source => update(() => daemonApi.restorePluginComposition(source)),
      refreshSessionBindings: async id => { const result = await daemonApi.getSessionBindings(id); if (alive) set(state => ({ sessionBindingsBySession: { ...state.sessionBindingsBySession, [id]: Object.fromEntries(result.bindings.map(b => [b.contract, b.instanceId])) } })); },
      setSessionBinding: async (id, contract, instanceId) => { await daemonApi.setSessionBinding(id, contract, instanceId); await get().refreshSessionBindings(id); },
      invalidatePluginPermissions: () => { if (alive) set(s => ({ pluginPermissionRevision: s.pluginPermissionRevision + 1 })); bridge.kernel.invalidatePluginPermissions(); },
      registerCustomHarness: async config => { await daemonApi.registerCustomHarness(config); await get().refreshHarnesses(); },
      deleteCustomHarness: async id => { await daemonApi.deleteCustomHarness(id); await get().refreshHarnesses(); },
      pushToast: notice => { if (alive) void bridge.toast(notice.title, notice.body, notice.kind); },
      openDeveloperTools: context => openContractPage('developer.tools.v1', undefined, { workspaceId: get().selectedWorkspaceId, sessionId: get().selectedSessionId, ...context }, req => bridge.navigate(req)),
    };
  });
  const controller = new AbortController();
  void Promise.allSettled([daemonApi.listWorkspaces(), daemonApi.listSessions(), daemonApi.listHarnesses()]).then(results => {
    if (!alive) return;
    if (results[0].status === 'fulfilled') store.setState({ workspaces: results[0].value.workspaces });
    if (results[1].status === 'fulfilled') store.setState({ sessions: results[1].value.sessions });
    if (results[2].status === 'fulfilled') store.setState({ harnesses: results[2].value.harnesses });
  });
  const off = bridge.onContext((session, props) => { if (alive) store.setState({ selectedSessionId: session?.id ?? null, selectedWorkspaceId: session?.workspaceId ?? (typeof props.workspaceId === 'string' ? props.workspaceId : null) }); });
  void store.getState().refreshPlugins();
  return { store, dispose() { alive = false; controller.abort(); off(); } };
}
