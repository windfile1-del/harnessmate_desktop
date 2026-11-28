import type {
  ApplicationSwitchResult,
  Disposer,
  Session,
} from '@harnessmate/protocol';
import { AlertTriangle, X } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { daemonApi, getSharedDaemonWs } from '../../api/client';
import {
  APPLICATION_VIEW_CONTRACT,
  pluginProvidesContract,
} from '../../api/peer-contracts';
import { Sidebar } from '../../components/Sidebar';
import { TriageInboxLifecycle, openTriageSession } from '../../components/TriageInbox';
import type { DiagnosticEntry } from '../../lib/projector';
import { isTriageEnabled, nextAttentionSession } from '../../lib/triage';
import { createDefaultShellNavigationHandler, VALID_DEFAULT_INSPECTOR_TABS } from './navigation';
import { PluginSlotSync } from '../../slots/PluginSlotSync';
import { PluginWorkspaceStage } from '../../slots/PluginWorkspace';
import { Slot, SlotRegistryProvider, SlotSessionProvider, useSlotItems } from '../../slots';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import type { MountedSurfaceHandle } from '../../slots/surface-mounter';
import {
  useAppStore,
  type AppState,
  type InspectorTab,
} from '../../stores/app-store';
import { useKernelStore } from '../../stores/kernel-store';

const InspectorDrawer = lazy(() =>
  import('../../components/InspectorDrawer').then((m) => ({ default: m.InspectorDrawer })),
);
const ModalHost = lazy(() =>
  import('../../components/Modals').then((m) => ({ default: m.ModalHost })),
);

function StatusbarSlotStrip({ session }: { session: Session | null }) {
  const items = useSlotItems('statusbar.items');
  if (items.length === 0) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 px-3 py-1 text-[11px] text-[var(--text-secondary)]"
      style={{
        backgroundColor: 'var(--bg-rail)',
        borderTop: '1px solid var(--border-hairline)',
      }}
    >
      <Slot
        name="statusbar.items"
        slotProps={{ session }}
        compactErrors
        className="flex flex-wrap items-center gap-2"
      />
    </div>
  );
}

function HostBoundChatStage({
  bridge,
  selectedSession,
}: {
  bridge?: TrustedModulePageBridge;
  selectedSession: Session | null;
}) {
  const startItems = useSlotItems('workspace.start');
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MountedSurfaceHandle | null>(null);
  const plugins = useAppStore((s) => s.plugins);
  const hasChatProvider = useMemo(
    () =>
      plugins.some(
        (p) =>
          p.enabled &&
          (!p.runtimeState || p.runtimeState === 'ACTIVE') &&
          pluginProvidesContract(p, 'chat.view.v1'),
      ),
    [plugins],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !bridge?.surfaces || (!selectedSession && startItems.length > 0)) return;
    const handle = bridge.surfaces.mountBoundSurface(el, {
      contract: 'chat.view.v1',
      surface: 'chat',
      session: selectedSession,
    });
    handleRef.current = handle;
    return () => {
      handle.dispose();
      handleRef.current = null;
    };
  }, [bridge, Boolean(!selectedSession && startItems.length > 0)]);

  useEffect(() => {
    handleRef.current?.update({ session: selectedSession });
  }, [selectedSession]);

  if (!selectedSession && startItems.length > 0) {
    return (
      <Slot
        name="workspace.start"
        slotProps={{ session: null }}
        className="flex min-h-0 flex-1"
      />
    );
  }
  if (!hasChatProvider && plugins.length > 0) {
    return (
      <div
        role="status"
        className="flex flex-1 items-center justify-center p-8 text-[var(--text-secondary)]"
      >
        聊天插件不可用。可在插件中心启用实例或恢复组合。
      </div>
    );
  }
  return <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col" />;
}

const VALID_INSPECTOR_TABS = VALID_DEFAULT_INSPECTOR_TABS;

function extractLayoutSnapshot(state: AppState): Record<string, unknown> {
  return {
    sidebarCollapsed: state.sidebarCollapsed,
    inspectorOpen: state.inspectorOpen,
    inspectorTab: state.inspectorTab,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    sessions: state.sessions,
    harnesses: state.harnesses,
    workspaces: state.workspaces,
    slashCommands: state.slashCommands,
    focusedTurn: state.focusedTurn,
    accountUsage: state.accountUsage,
    failoverPolicy: state.failoverPolicy,
    agyNativeWorkbenchEnabled: state.agyNativeWorkbenchEnabled,
    agyAuthStates: state.agyAuthStates,
    nativeRuntimeBySession: state.nativeRuntimeBySession,
  };
}

export function ShellDefaultApp({ bridge }: { bridge?: TrustedModulePageBridge }) {
  const [presentation, setPresentation] = useState<{
    sessionId: string;
    diagnostics: DiagnosticEntry[];
  }>();
  const [restartBanner, setRestartBanner] = useState<{ required: boolean; reason?: string } | null>(null);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (Array.isArray(detail?.diagnostics)) {
        setPresentation({ sessionId: detail.sessionId, diagnostics: detail.diagnostics });
      }
    };
    window.addEventListener('hm:presentation', listener);
    return () => window.removeEventListener('hm:presentation', listener);
  }, []);

  const triageEnabled = useAppStore((state) => isTriageEnabled(state.plugins));
  const {
    sessions,
    selectedSessionId,
    sidebarCollapsed,
    inspectorOpen,
    activeModal,
    toasts,
    dismissToast,
  } = useAppStore(
    useShallow((state) => ({
      sessions: state.sessions,
      selectedSessionId: state.selectedSessionId,
      sidebarCollapsed: state.sidebarCollapsed,
      inspectorOpen: state.inspectorOpen,
      activeModal: state.activeModal,
      toasts: state.toasts,
      dismissToast: state.dismissToast,
    })),
  );

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  // 1. Sync kernel assembly state into layout store and forward kernel actions
  useEffect(() => {
    if (!bridge?.kernel) return;
    const syncFromKernel = () => {
      const snap = bridge.kernel.getSnapshot();
      useKernelStore.setState({
        theme: snap.theme,
        connected: snap.connected,
        loading: snap.loading,
        plugins: snap.plugins,
        emptyComposition: snap.emptyComposition,
        compositionBindings: snap.compositionBindings,
        compositionEntries: snap.compositionEntries,
        workspaceBindingsByWorkspace: snap.workspaceBindingsByWorkspace,
        sessionBindingsBySession: snap.sessionBindingsBySession,
        pluginPermissionRevision: snap.pluginPermissionRevision,
        restartStatus: snap.restartStatus,
      });
      useAppStore.setState({
        theme: snap.theme,
        connected: snap.connected,
        plugins: snap.plugins,
        emptyComposition: snap.emptyComposition,
        compositionBindings: snap.compositionBindings,
        compositionEntries: snap.compositionEntries,
        workspaceBindingsByWorkspace: snap.workspaceBindingsByWorkspace,
        sessionBindingsBySession: snap.sessionBindingsBySession,
        pluginPermissionRevision: snap.pluginPermissionRevision,
      });
      setRestartBanner(snap.restartStatus?.required ? snap.restartStatus : null);
    };

    // Route kernel-owned actions on layout store through bridge.kernel
    useAppStore.setState({
      toggleTheme: () => bridge.kernel.toggleTheme(),
      refreshPlugins: async () => {
        await bridge.kernel.refreshPlugins();
        syncFromKernel();
      },
      refreshCompositionBindings: async (wsId?: string) => {
        await bridge.kernel.refreshComposition(wsId);
        syncFromKernel();
      },
      refreshWorkspaceBindings: async (wsId: string) => {
        await bridge.kernel.refreshWorkspaceBindings(wsId);
        syncFromKernel();
      },
      setWorkspaceBinding: async (wsId: string, contract: string, instanceId: string | null) => {
        await bridge.kernel.setWorkspaceBinding(wsId, contract, instanceId);
        syncFromKernel();
        useAppStore.getState().pushToast({
          kind: 'success',
          title: instanceId ? '已更新工作区能力绑定' : '已恢复工作区默认能力绑定',
        });
      },
      refreshSessionBindings: async (sid: string) => {
        await bridge.kernel.refreshSessionBindings(sid);
        syncFromKernel();
      },
      setSessionBinding: async (sid: string, contract: string, instanceId: string | null) => {
        await bridge.kernel.setSessionBinding(sid, contract, instanceId);
        syncFromKernel();
        useAppStore.getState().pushToast({
          kind: 'success',
          title: instanceId ? '已更新会话能力绑定' : '已恢复会话默认能力绑定',
        });
      },
      togglePlugin: async (id: string, enabled: boolean) => {
        await bridge.kernel.togglePlugin(id, enabled);
        syncFromKernel();
        useAppStore.getState().pushToast({ kind: 'info', title: enabled ? '已启用插件' : '已停用插件' });
      },
      rollbackPlugin: async (id: string) => {
        await bridge.kernel.rollbackPlugin(id);
        syncFromKernel();
        useAppStore.getState().pushToast({ kind: 'success', title: '已切换到上一版插件' });
      },
      reloadPlugins: async () => {
        await bridge.kernel.reloadPlugins();
        syncFromKernel();
        useAppStore.getState().pushToast({ kind: 'success', title: '插件已热重载' });
      },
      restorePluginComposition: async (source: 'previous' | 'builtin' | 'empty') => {
        await bridge.kernel.restoreComposition(source);
        syncFromKernel();
        useAppStore.getState().pushToast({
          kind: 'success',
          title: source === 'empty' ? '已进入空业务组合恢复模式' : '组合配置已恢复',
        });
      },
      switchApplicationLayout: async (instanceId: string | null): Promise<ApplicationSwitchResult> => {
        const res = await bridge.kernel.switchApplicationEntry(instanceId);
        if (res.status === 'restart_required') {
          setRestartBanner({ required: true, reason: res.reason });
          useAppStore.getState().pushToast({
            kind: 'warning',
            title: '布局切换需要重启',
            body: res.reason,
          });
        } else if (res.status === 'failed') {
          useAppStore.getState().pushToast({
            kind: 'error',
            title: '切换应用布局失败',
            body: res.reason,
          });
        }
        return res;
      },
    });

    syncFromKernel();
    const unsubKernel = bridge.kernel.subscribe(syncFromKernel);
    return () => {
      unsubKernel();
    };
  }, [bridge]);

  // 2. Initialize layout data (reusing host shared WS) & persist presentation state via application.view.v1
  useEffect(() => {
    let disposed = false;
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const sourceId = `shell_default_${Date.now()}`;

    void useAppStore.getState().init();

    // Restore persisted layout presentation preferences from application.view.v1 storage
    if (bridge?.services) {
      void bridge.services
        .call<{ value?: { ok?: boolean; value?: { state?: Record<string, unknown> } } }>(
          APPLICATION_VIEW_CONTRACT,
          'readLayoutState',
          [{ scope: 'default' }],
          { instanceId: bridge.instanceId },
        )
        .then((res) => {
          if (disposed) return;
          const saved = res?.value?.value?.state;
          if (!saved || typeof saved !== 'object') return;
          const patch: Partial<AppState> = {};
          if (typeof saved.sidebarCollapsed === 'boolean') patch.sidebarCollapsed = saved.sidebarCollapsed;
          if (typeof saved.inspectorOpen === 'boolean') patch.inspectorOpen = saved.inspectorOpen;
          if (typeof saved.inspectorTab === 'string' && VALID_INSPECTOR_TABS.has(saved.inspectorTab as InspectorTab)) {
            patch.inspectorTab = saved.inspectorTab as InspectorTab;
          }
          if (typeof saved.selectedWorkspaceId === 'string' || saved.selectedWorkspaceId === null) {
            patch.selectedWorkspaceId = saved.selectedWorkspaceId;
          }
          if (Object.keys(patch).length > 0) useAppStore.setState(patch);
        })
        .catch(() => {});
    }

    // Publish initial & subsequent public layout state to host layoutBridge
    bridge?.application?.publishState(extractLayoutSnapshot(useAppStore.getState()));

    const unsubStore = useAppStore.subscribe((state, prev) => {
      if (disposed) return;
      bridge?.application?.publishState(extractLayoutSnapshot(state));

      if (
        bridge?.services &&
        (state.sidebarCollapsed !== prev.sidebarCollapsed ||
          state.inspectorOpen !== prev.inspectorOpen ||
          state.inspectorTab !== prev.inspectorTab ||
          state.selectedWorkspaceId !== prev.selectedWorkspaceId)
      ) {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
          if (disposed) return;
          void bridge.services
            .call(
              APPLICATION_VIEW_CONTRACT,
              'writeLayoutState',
              [
                {
                  scope: 'default',
                  sourceId,
                  patch: {
                    sidebarCollapsed: state.sidebarCollapsed,
                    inspectorOpen: state.inspectorOpen,
                    inspectorTab: state.inspectorTab,
                    selectedWorkspaceId: state.selectedWorkspaceId,
                  },
                },
              ],
              { instanceId: bridge.instanceId },
            )
            .catch(() => {});
        }, 300);
      }
    });

    return () => {
      disposed = true;
      if (persistTimer) clearTimeout(persistTimer);
      unsubStore();
      useAppStore.getState().disposeLayoutSubscriptions?.();
    };
  }, [bridge]);

  // 3. Register public Toast handler, Legacy W2/W3 action delegate, Navigation handler, and UI Contributions
  useEffect(() => {
    if (!bridge) return;
    const disposers: Disposer[] = [];

    disposers.push(
      bridge.application.registerToastHandler((toast) => {
        useAppStore.getState().pushToast(toast);
      }),
    );

    disposers.push(
      bridge.application.registerLegacyActionDelegate((name, args) => {
        const action = useAppStore.getState()[name as keyof AppState];
        if (typeof action !== 'function') {
          throw Object.assign(new Error(`布局未实现操作: ${name}`), { code: 'E_NOT_SUPPORTED' });
        }
        return (action as (...a: unknown[]) => unknown)(...args);
      }),
    );

    // Public Navigation Handler — layout interprets target & placement
    disposers.push(bridge.navigation.registerHandler(createDefaultShellNavigationHandler()));

    // Core layout commands
    disposers.push(
      bridge.contributions.register({
        id: 'layout.setSidebarCollapsed',
        kind: 'command',
        title: '设置左侧栏折叠状态',
        category: 'navigation',
        execute: ({ args }) => {
          useAppStore.getState().setSidebarCollapsed(Boolean(args?.collapsed));
        },
      }),
      bridge.contributions.register({
        id: 'layout.setInspectorOpen',
        kind: 'command',
        title: '设置检视抽屉开关',
        category: 'navigation',
        execute: ({ args }) => {
          useAppStore.getState().setInspectorOpen(Boolean(args?.open));
        },
      }),
      bridge.contributions.register({
        id: 'layout.syncSessions',
        kind: 'command',
        title: '同步会话列表',
        category: 'session',
        execute: async ({ args }) => {
          if (Array.isArray(args?.sessions)) {
            useAppStore.setState({ sessions: args.sessions as Session[] });
          } else if (typeof args?.sessionId === 'string') {
            await useAppStore.getState().syncImportedSession(args.sessionId);
          } else {
            const { sessions: next } = await daemonApi.listSessions();
            useAppStore.setState({ sessions: next });
          }
        },
      }),
      bridge.contributions.register({
        id: 'layout.syncWorkspaces',
        kind: 'command',
        title: '同步工作区列表',
        category: 'session',
        execute: async ({ args }) => {
          if (Array.isArray(args?.workspaces)) {
            useAppStore.setState({ workspaces: args.workspaces as AppState['workspaces'] });
          } else {
            const { workspaces: next } = await daemonApi.listWorkspaces();
            useAppStore.setState({ workspaces: next });
          }
        },
      }),
    );

    // Business keyboard shortcuts — registered in layout lifecycle & auto-revoked on unmount
    disposers.push(
      bridge.contributions.register({
        id: 'shortcut.new-session',
        kind: 'shortcut',
        title: '新建会话',
        shortcut: 'Mod+N',
        order: 10,
        execute: () => useAppStore.getState().openModal('new_session'),
      }),
      bridge.contributions.register({
        id: 'shortcut.toggle-sidebar',
        kind: 'shortcut',
        title: '切换侧栏',
        shortcut: 'Mod+B',
        order: 20,
        execute: () => {
          const s = useAppStore.getState();
          s.setSidebarCollapsed(!s.sidebarCollapsed);
        },
      }),
      bridge.contributions.register({
        id: 'shortcut.toggle-inspector',
        kind: 'shortcut',
        title: '切换检视抽屉',
        shortcut: 'Mod+I',
        order: 30,
        execute: () => {
          const s = useAppStore.getState();
          s.setInspectorOpen(!s.inspectorOpen);
        },
      }),
      bridge.contributions.register({
        id: 'shortcut.close-modal',
        kind: 'shortcut',
        title: '关闭弹窗',
        shortcut: 'Escape',
        order: 40,
        execute: () => {
          const s = useAppStore.getState();
          if (s.activeModal) s.openModal(null);
        },
      }),
    );

    // Desktop Tray / Menu business actions — auto-revoked when layout unmounts/switches
    disposers.push(
      bridge.contributions.register({
        id: 'tray.new-session',
        kind: 'tray',
        title: '新建会话',
        shortcut: 'Mod+N',
        order: 10,
        execute: () => useAppStore.getState().openModal('new_session'),
      }),
      bridge.contributions.register({
        id: 'tray.toggle-sidebar',
        kind: 'tray',
        title: '切换左侧栏',
        shortcut: 'Mod+B',
        order: 20,
        execute: () => {
          const s = useAppStore.getState();
          s.setSidebarCollapsed(!s.sidebarCollapsed);
        },
      }),
      bridge.contributions.register({
        id: 'tray.toggle-inspector',
        kind: 'tray',
        title: '切换检视抽屉',
        shortcut: 'Mod+I',
        order: 30,
        execute: () => {
          const s = useAppStore.getState();
          s.setInspectorOpen(!s.inspectorOpen);
        },
      }),
    );

    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [bridge]);

  // 4. Triage-specific shortcuts & tray item (active only when triage plugin is enabled)
  useEffect(() => {
    if (!bridge) return;
    if (!triageEnabled) {
      if (useAppStore.getState().activeModal === 'command_palette') {
        useAppStore.getState().openModal(null);
      }
      return;
    }
    const disposers: Disposer[] = [
      bridge.contributions.register({
        id: 'shortcut.command-palette',
        kind: 'shortcut',
        title: '打开命令面板',
        shortcut: 'Mod+K',
        order: 5,
        execute: () => {
          const s = useAppStore.getState();
          if (s.activeModal === 'command_palette') s.openModal(null);
          else s.openCommandPalette();
        },
      }),
      bridge.contributions.register({
        id: 'shortcut.switch-harness',
        kind: 'shortcut',
        title: '查找可切换的 Harness',
        shortcut: 'Mod+Shift+H',
        order: 6,
        execute: () => {
          const s = useAppStore.getState();
          if (s.selectedSessionId) s.openCommandPalette('switch ');
        },
      }),
      bridge.contributions.register({
        id: 'shortcut.next-attention',
        kind: 'shortcut',
        title: '下一个待处理会话',
        shortcut: 'Alt+ArrowDown',
        order: 7,
        execute: () => {
          const s = useAppStore.getState();
          if (s.activeModal) return;
          const next = nextAttentionSession(s.sessions, s.triageBySession, s.selectedSessionId, 1);
          if (next && next.id !== s.selectedSessionId) void openTriageSession(next);
        },
      }),
      bridge.contributions.register({
        id: 'shortcut.prev-attention',
        kind: 'shortcut',
        title: '上一个待处理会话',
        shortcut: 'Alt+ArrowUp',
        order: 8,
        execute: () => {
          const s = useAppStore.getState();
          if (s.activeModal) return;
          const next = nextAttentionSession(s.sessions, s.triageBySession, s.selectedSessionId, -1);
          if (next && next.id !== s.selectedSessionId) void openTriageSession(next);
        },
      }),
      bridge.contributions.register({
        id: 'tray.command-palette',
        kind: 'tray',
        title: '命令面板',
        shortcut: 'Mod+K',
        order: 15,
        execute: () => useAppStore.getState().openCommandPalette(),
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [bridge, triageEnabled]);

  // Keep shared WS alive check for diagnostics
  void getSharedDaemonWs;

  return (
    <SlotRegistryProvider>
      <SlotSessionProvider session={selectedSession}>
        <PluginSlotSync />
        {triageEnabled && <TriageInboxLifecycle />}
        <div
          data-shell-layout="hm.plugin.shell-default"
          className="flex h-screen w-screen flex-col overflow-hidden"
        >
          {restartBanner?.required && (
            <div
              role="status"
              data-testid="shell-restart-banner"
              className="flex shrink-0 items-center justify-between gap-2 px-4 py-1.5 text-[11.5px]"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                borderBottom: '1px solid color-mix(in srgb, var(--accent-star) 45%, transparent)',
                color: 'var(--text-primary)',
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle size={13} style={{ color: 'var(--accent-star)' }} />
                {restartBanner.reason || '当前布局变更需要重启窗口以完整生效。'}
              </span>
              <button
                type="button"
                onClick={() => void bridge?.kernel.requestRestart()}
                className="cursor-pointer rounded-md px-2.5 py-0.5 text-[11px] font-medium text-white"
                style={{ backgroundColor: 'var(--accent-indigo)' }}
              >
                重启生效
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 overflow-hidden">
            {!sidebarCollapsed && <Sidebar />}
            <PluginWorkspaceStage>
              <HostBoundChatStage bridge={bridge} selectedSession={selectedSession} />
            </PluginWorkspaceStage>
            {inspectorOpen && selectedSession && (
              <Suspense fallback={null}>
                <InspectorDrawer
                  session={selectedSession}
                  diagnostics={
                    presentation?.sessionId === selectedSession.id ? presentation.diagnostics : []
                  }
                />
              </Suspense>
            )}
            {activeModal && (
              <Suspense fallback={null}>
                <ModalHost />
              </Suspense>
            )}
          </div>
          <StatusbarSlotStrip session={selectedSession} />

          {/* Refined Floating Toast Stack */}
          {toasts.length > 0 && (
            <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[320px] flex-col gap-2">
              {toasts.map((t) => (
                <div
                  key={t.id}
                  className="animate-fade-up pointer-events-auto flex items-start justify-between gap-2.5 rounded-xl px-3.5 py-2.5"
                  style={{
                    backgroundColor: 'var(--bg-glass)',
                    backdropFilter: 'blur(16px)',
                    border: `1px solid ${
                      t.kind === 'error'
                        ? 'color-mix(in srgb, var(--accent-rose) 48%, transparent)'
                        : t.kind === 'warning'
                          ? 'color-mix(in srgb, var(--accent-star) 50%, transparent)'
                          : t.kind === 'success'
                            ? 'color-mix(in srgb, var(--accent-emerald) 45%, transparent)'
                            : 'var(--border-strong)'
                    }`,
                    boxShadow: 'var(--shadow-float)',
                  }}
                >
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t.title}</div>
                    {t.body && (
                      <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">
                        {t.body}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissToast(t.id)}
                    className="cursor-pointer rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SlotSessionProvider>
    </SlotRegistryProvider>
  );
}
