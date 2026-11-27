import { InboxWorkspaceSurface } from './InboxWorkspaceSurface';
import { ArrowLeft, Globe, History, Puzzle, Search } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  HISTORY_IMPORT_CONTRACT,
  HISTORY_IMPORT_PAGE_SLOT_ID,
  HISTORY_SOURCE_CONTRACT,
  SESSION_SEARCH_CONTRACT,
  SESSION_SEARCH_PAGE_SLOT_ID,
  getPluginInstanceId,
  makeWorkspacePageKey,
  parseWorkspacePageKey,
  pluginProvidesContract,
  resolveServiceSelectionClientSide,
  type ServiceResolutionV1,
} from '../api/peer-contracts';
import { formatResolutionSummary } from '../api/peer-workspace-client';
import { HistoryImportWorkspacePage } from '../components/HistoryImportWorkspacePage';
import { ServiceResolutionBanner } from '../components/ServiceResolutionBanner';
import { SessionSearchWorkspacePage } from '../components/SessionSearchWorkspacePage';
import { useAppStore } from '../stores/app-store';
import { useSlotItems, useSlotRegistry } from './hooks';
import { SlotErrorBoundary } from './SlotRenderer';
import type { RegisteredSlotItem } from './slot-registry';

function pageKey(page: RegisteredSlotItem<'workspace.pages'>) {
  return `${page.pluginId}:${page.id}`;
}

export function PluginWorkspaceLinks() {
  const pages = useSlotItems('workspace.pages');
  const {
    active,
    open,
    selectedSessionId,
    selectedWorkspaceId,
    plugins,
    sessionBindingsBySession,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
    refreshSessionBindings,
    refreshWorkspaceBindings,
    setSessionBinding,
    setWorkspaceBinding,
    resolveService,
    openSessionSearchPage,
    openHistoryImportPage,
  } = useAppStore(useShallow((state) => ({
    active: state.activePluginPage,
    open: state.setActivePluginPage,
    selectedSessionId: state.selectedSessionId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    plugins: state.plugins,
    sessionBindingsBySession: state.sessionBindingsBySession,
    workspaceBindingsByWorkspace: state.workspaceBindingsByWorkspace ?? {},
    compositionBindings: state.compositionBindings ?? {},
    compositionEntries: state.compositionEntries ?? [],
    refreshSessionBindings: state.refreshSessionBindings,
    refreshWorkspaceBindings: state.refreshWorkspaceBindings,
    setSessionBinding: state.setSessionBinding,
    setWorkspaceBinding: state.setWorkspaceBinding,
    resolveService: state.resolveService,
    openSessionSearchPage: state.openSessionSearchPage,
    openHistoryImportPage: state.openHistoryImportPage,
  })));

  const hasSearchOrImport = useMemo(
    () =>
      plugins.some(
        (p) =>
          pluginProvidesContract(p, SESSION_SEARCH_CONTRACT) ||
          pluginProvidesContract(p, HISTORY_IMPORT_CONTRACT),
      ) ||
      Boolean(compositionBindings[SESSION_SEARCH_CONTRACT] || compositionBindings[HISTORY_IMPORT_CONTRACT]) ||
      Boolean(
        selectedWorkspaceId &&
          (workspaceBindingsByWorkspace[selectedWorkspaceId]?.[SESSION_SEARCH_CONTRACT] ||
            workspaceBindingsByWorkspace[selectedWorkspaceId]?.[HISTORY_IMPORT_CONTRACT]),
      ),
    [plugins, compositionBindings, selectedWorkspaceId, workspaceBindingsByWorkspace],
  );

  const [backendSearchRes, setBackendSearchRes] = useState<ServiceResolutionV1 | null>(null);
  const [backendImportRes, setBackendImportRes] = useState<ServiceResolutionV1 | null>(null);

  useEffect(() => {
    if (selectedSessionId) void refreshSessionBindings(selectedSessionId).catch(() => {});
  }, [selectedSessionId, plugins, refreshSessionBindings]);

  useEffect(() => {
    if (selectedWorkspaceId && typeof refreshWorkspaceBindings === 'function') {
      void refreshWorkspaceBindings(selectedWorkspaceId).catch(() => {});
    }
  }, [selectedWorkspaceId, plugins, refreshWorkspaceBindings]);

  useEffect(() => {
    if (!hasSearchOrImport || typeof resolveService !== 'function') {
      setBackendSearchRes(null);
      setBackendImportRes(null);
      return;
    }
    const controller = new AbortController();
    void resolveService(SESSION_SEARCH_CONTRACT, {
      workspaceId: selectedWorkspaceId ?? undefined,
      sessionId: selectedSessionId ?? undefined,
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted) setBackendSearchRes(res);
      })
      .catch(() => {});
    void resolveService(HISTORY_IMPORT_CONTRACT, {
      workspaceId: selectedWorkspaceId ?? undefined,
      sessionId: selectedSessionId ?? undefined,
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted) setBackendImportRes(res);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [
    hasSearchOrImport,
    resolveService,
    selectedWorkspaceId,
    selectedSessionId,
    plugins,
    workspaceBindingsByWorkspace,
    compositionBindings,
  ]);

  const fallbackSearchRes = useMemo(
    () =>
      hasSearchOrImport
        ? resolveServiceSelectionClientSide({
            contract: SESSION_SEARCH_CONTRACT,
            plugins,
            sessionBindings: selectedSessionId ? sessionBindingsBySession[selectedSessionId] : undefined,
            workspaceBindings: selectedWorkspaceId ? workspaceBindingsByWorkspace[selectedWorkspaceId] : undefined,
            compositionBindings,
            compositionEntries,
          })
        : null,
    [
      hasSearchOrImport,
      plugins,
      selectedSessionId,
      sessionBindingsBySession,
      selectedWorkspaceId,
      workspaceBindingsByWorkspace,
      compositionBindings,
      compositionEntries,
    ],
  );

  const fallbackImportRes = useMemo(
    () =>
      hasSearchOrImport
        ? resolveServiceSelectionClientSide({
            contract: HISTORY_IMPORT_CONTRACT,
            plugins,
            sessionBindings: selectedSessionId ? sessionBindingsBySession[selectedSessionId] : undefined,
            workspaceBindings: selectedWorkspaceId ? workspaceBindingsByWorkspace[selectedWorkspaceId] : undefined,
            compositionBindings,
            compositionEntries,
          })
        : null,
    [
      hasSearchOrImport,
      plugins,
      selectedSessionId,
      sessionBindingsBySession,
      selectedWorkspaceId,
      workspaceBindingsByWorkspace,
      compositionBindings,
      compositionEntries,
    ],
  );

  const searchResolution = backendSearchRes ?? fallbackSearchRes;
  const importResolution = backendImportRes ?? fallbackImportRes;

  const browserProviders = plugins.filter(
    (plugin) =>
      plugin.enabled &&
      (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE') &&
      (plugin.providedContracts?.some((entry) => entry.contract === 'browser.v1') ||
        plugin.provides?.includes('browser.v1')),
  );
  const currentBrowserId = selectedSessionId
    ? sessionBindingsBySession[selectedSessionId]?.['browser.v1'] ?? browserProviders[0]?.instanceId ?? browserProviders[0]?.id ?? ''
    : '';
  const boundPage = pages.find((page) => page.pluginId === currentBrowserId);

  if (!pages.length && !(selectedSessionId && browserProviders.length > 0) && !hasSearchOrImport) return null;

  const searchSummary = searchResolution ? formatResolutionSummary(searchResolution) : null;
  const importSummary = importResolution ? formatResolutionSummary(importResolution) : null;

  return (
    <nav aria-label="插件工作页" className="max-h-56 space-y-1 overflow-y-auto px-3.5 pb-2">
      {pages.filter(page => page.id !== 'chat' || !plugins.some(plugin => getPluginInstanceId(plugin) === page.pluginId && pluginProvidesContract(plugin, 'chat.view.v1'))).map((page) => (
        <button
          type="button"
          key={pageKey(page)}
          title={`${page.pluginName} · ${page.title}`}
          aria-current={active === pageKey(page) ? 'page' : undefined}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] aria-[current=page]:bg-[var(--bg-hover)] aria-[current=page]:text-[var(--text-primary)]"
          onClick={() => open(pageKey(page))}
        >
          <Puzzle size={13} className="shrink-0 text-[var(--accent-indigo)]" />
          <span className="truncate">{page.title}</span>
        </button>
      ))}
      {hasSearchOrImport && searchResolution && searchSummary && (
        <div
          data-testid="sidebar-search-resolution"
          className="mt-1 space-y-1 rounded-lg px-2 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center justify-between gap-1 text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1">
              <Search size={11} />
              会话搜索 · {searchSummary.label}
            </span>
            <button
              type="button"
              onClick={() => openSessionSearchPage({ instanceId: searchResolution.instanceId })}
              className="cursor-pointer text-[10.5px] text-[var(--accent-indigo)] hover:underline"
            >
              {searchResolution.status === 'ready' ? '打开工作页' : '查看状态'}
            </button>
          </div>
          {(searchResolution.candidates.length > 0 || searchResolution.instanceId) && (
            <select
              aria-label="当前会话搜索实例"
              value={searchResolution.instanceId ?? ''}
              onChange={(event) => {
                const nextId = event.target.value || null;
                if (selectedWorkspaceId && typeof setWorkspaceBinding === 'function') {
                  void setWorkspaceBinding(selectedWorkspaceId, SESSION_SEARCH_CONTRACT, nextId);
                } else if (nextId) {
                  open(makeWorkspacePageKey(nextId, SESSION_SEARCH_PAGE_SLOT_ID));
                }
              }}
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-1 text-[11px] text-[var(--text-primary)]"
            >
              {!searchResolution.instanceId && <option value="">选择搜索实例...</option>}
              {searchResolution.instanceId &&
                !searchResolution.candidates.some((c) => c.instanceId === searchResolution.instanceId) && (
                  <option value={searchResolution.instanceId}>
                    {searchResolution.instanceId} ({searchSummary.label})
                  </option>
                )}
              {searchResolution.candidates.map((cand) => (
                <option key={cand.instanceId} value={cand.instanceId}>
                  {cand.instanceId} ({cand.version})
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {hasSearchOrImport && importResolution && importSummary && (
        <div
          data-testid="sidebar-import-resolution"
          className="mt-1 space-y-1 rounded-lg px-2 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center justify-between gap-1 text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1">
              <History size={11} />
              历史导入 · {importSummary.label}
            </span>
            <button
              type="button"
              onClick={() => openHistoryImportPage({ instanceId: importResolution.instanceId })}
              className="cursor-pointer text-[10.5px] text-[var(--accent-indigo)] hover:underline"
            >
              {importResolution.status === 'ready' ? '打开工作页' : '查看状态'}
            </button>
          </div>
          {(importResolution.candidates.length > 0 || importResolution.instanceId) && (
            <select
              aria-label="当前历史导入实例"
              value={importResolution.instanceId ?? ''}
              onChange={(event) => {
                const nextId = event.target.value || null;
                if (selectedWorkspaceId && typeof setWorkspaceBinding === 'function') {
                  void setWorkspaceBinding(selectedWorkspaceId, HISTORY_IMPORT_CONTRACT, nextId);
                } else if (nextId) {
                  open(makeWorkspacePageKey(nextId, HISTORY_IMPORT_PAGE_SLOT_ID));
                }
              }}
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-1 text-[11px] text-[var(--text-primary)]"
            >
              {!importResolution.instanceId && <option value="">选择导入实例...</option>}
              {importResolution.instanceId &&
                !importResolution.candidates.some((c) => c.instanceId === importResolution.instanceId) && (
                  <option value={importResolution.instanceId}>
                    {importResolution.instanceId} ({importSummary.label})
                  </option>
                )}
              {importResolution.candidates.map((cand) => (
                <option key={cand.instanceId} value={cand.instanceId}>
                  {cand.instanceId} ({cand.version})
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {selectedSessionId && browserProviders.length > 0 && (
        <div
          className="mt-1 space-y-1 rounded-lg px-2 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center justify-between gap-1 text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1">
              <Globe size={11} />
              会话浏览器
            </span>
            {boundPage && (
              <button
                type="button"
                onClick={() => open(pageKey(boundPage))}
                className="cursor-pointer text-[10.5px] text-[var(--accent-indigo)] hover:underline"
              >
                打开工作页
              </button>
            )}
          </div>
          <select
            aria-label="当前会话浏览器实例"
            value={currentBrowserId}
            onChange={(event) => {
              const nextId = event.target.value || null;
              void setSessionBinding(selectedSessionId, 'browser.v1', nextId);
            }}
            className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-1 text-[11px] text-[var(--text-primary)]"
          >
            {browserProviders.map((provider) => {
              const id = provider.instanceId ?? provider.id;
              return (
                <option key={id} value={id}>
                  {provider.name} ({id})
                </option>
              );
            })}
          </select>
        </div>
      )}
    </nav>
  );
}

function WorkspacePageContent({
  page,
  hostProps,
}: {
  page: RegisteredSlotItem<'workspace.pages'>;
  hostProps: Record<string, unknown>;
}) {
  return (page.render as (props: Record<string, unknown>) => ReactNode)(hostProps);
}

export function PluginWorkspaceStage({ children }: { children: ReactNode }) {
  const registry = useSlotRegistry();
  const pages = useSlotItems('workspace.pages');
  const {
    active,
    open,
    plugins,
    workspaces,
    harnesses,
    sessions,
    selectedWorkspaceId,
    selectedSessionId,
    sessionBindingsBySession,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
    searchPageInitialQuery,
    importPageInitialTab,
    resolveService,
    setWorkspaceBinding,
  } = useAppStore(
    useShallow((state) => ({
      active: state.activePluginPage,
      open: state.setActivePluginPage,
      plugins: state.plugins,
      workspaces: state.workspaces,
      harnesses: state.harnesses,
      sessions: state.sessions,
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      sessionBindingsBySession: state.sessionBindingsBySession,
      workspaceBindingsByWorkspace: state.workspaceBindingsByWorkspace ?? {},
      compositionBindings: state.compositionBindings ?? {},
      compositionEntries: state.compositionEntries ?? [],
      searchPageInitialQuery: state.searchPageInitialQuery,
      importPageInitialTab: state.importPageInitialTab,
      resolveService: state.resolveService,
      setWorkspaceBinding: state.setWorkspaceBinding,
    })),
  );

  const page = pages.find((item) => pageKey(item) === active);
  const parsedActive = parseWorkspacePageKey(active);
  const activeSlotId = page?.id ?? parsedActive?.slotId ?? null;
  const activeInstanceId = page?.pluginId ?? parsedActive?.instanceId ?? null;
  const peerContract =
    activeSlotId === SESSION_SEARCH_PAGE_SLOT_ID
      ? SESSION_SEARCH_CONTRACT
      : activeSlotId === HISTORY_IMPORT_PAGE_SLOT_ID
        ? HISTORY_IMPORT_CONTRACT
        : null;

  const [backendResolution, setBackendResolution] = useState<ServiceResolutionV1 | null>(null);
  useEffect(() => {
    if (!peerContract || typeof resolveService !== 'function') {
      setBackendResolution(null);
      return;
    }
    const controller = new AbortController();
    void resolveService(peerContract, {
      workspaceId: selectedWorkspaceId ?? undefined,
      sessionId: selectedSessionId ?? undefined,
      explicitInstanceId: activeInstanceId ?? undefined,
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted) setBackendResolution(res);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [
    peerContract,
    activeInstanceId,
    selectedWorkspaceId,
    selectedSessionId,
    plugins,
    workspaceBindingsByWorkspace,
    compositionBindings,
    resolveService,
  ]);

  const fallbackResolution = useMemo(() => {
    if (!peerContract) return null;
    return resolveServiceSelectionClientSide({
      contract: peerContract,
      plugins,
      explicitInstanceId: activeInstanceId ?? undefined,
      sessionBindings: selectedSessionId ? sessionBindingsBySession[selectedSessionId] : undefined,
      workspaceBindings: selectedWorkspaceId ? workspaceBindingsByWorkspace[selectedWorkspaceId] : undefined,
      compositionBindings,
      compositionEntries,
    });
  }, [
    peerContract,
    plugins,
    activeInstanceId,
    selectedSessionId,
    sessionBindingsBySession,
    selectedWorkspaceId,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
  ]);

  const activeResolution = backendResolution ?? fallbackResolution;
  const sourceResolution = useMemo(() => {
    if (peerContract !== HISTORY_IMPORT_CONTRACT) return null;
    return resolveServiceSelectionClientSide({
      contract: HISTORY_SOURCE_CONTRACT,
      plugins,
      workspaceBindings: selectedWorkspaceId ? workspaceBindingsByWorkspace[selectedWorkspaceId] : undefined,
      compositionBindings,
      compositionEntries,
    });
  }, [peerContract, plugins, selectedWorkspaceId, workspaceBindingsByWorkspace, compositionBindings, compositionEntries]);

  const hostProps = useMemo<Record<string, unknown>>(
    () => ({
      apiBase:
        typeof window !== 'undefined'
          ? window.harnessMateBridge?.daemonUrl || window.location?.origin || ''
          : '',
      workspaceId: selectedWorkspaceId,
      workspaces: workspaces.map((ws) => ({ id: ws.id, name: ws.name, rootPath: ws.rootPath })),
      harnesses: harnesses.map((h) => ({ id: h.id, kind: h.kind, displayName: h.displayName })),
      sessions: sessions.slice(0, 200).map((s) => ({
        id: s.id,
        workspaceId: s.workspaceId,
        title: s.title,
        harnessId: s.harnessId,
        harnessKind: s.harnessKind,
        nativeSessionId: s.nativeSessionId ?? null,
        updatedAt: s.updatedAt,
      })),
      plugins: plugins.map((p) => ({
        id: p.id,
        instanceId: getPluginInstanceId(p),
        name: p.name,
        version: p.version,
        enabled: p.enabled,
        runtimeState: p.runtimeState,
        provides: p.provides ?? [],
        providedContracts: p.providedContracts ?? [],
      })),
      serviceResolution: activeResolution,
      sourceResolution,
      initialQuery: activeSlotId === SESSION_SEARCH_PAGE_SLOT_ID ? searchPageInitialQuery : '',
      initialTab: activeSlotId === HISTORY_IMPORT_PAGE_SLOT_ID ? importPageInitialTab : 'native',
    }),
    [
      selectedWorkspaceId,
      workspaces,
      harnesses,
      sessions,
      plugins,
      activeResolution,
      sourceResolution,
      activeSlotId,
      searchPageInitialQuery,
      importPageInitialTab,
    ],
  );

  const knownOfflinePeerPage =
    !page &&
    parsedActive &&
    (parsedActive.slotId === SESSION_SEARCH_PAGE_SLOT_ID ||
      parsedActive.slotId === HISTORY_IMPORT_PAGE_SLOT_ID) &&
    plugins.some(
      (p) => getPluginInstanceId(p) === parsedActive.instanceId || p.id === parsedActive.instanceId,
    )
      ? parsedActive
      : null;

  useEffect(() => {
    if (active && !page && !knownOfflinePeerPage) open(null);
  }, [active, open, page, knownOfflinePeerPage]);

  if (!page && !knownOfflinePeerPage) return children;

  const handleShellSelectInstance = (nextInstanceId: string | null) => {
    if (!peerContract || !activeSlotId) return;
    if (selectedWorkspaceId && typeof setWorkspaceBinding === 'function') {
      void setWorkspaceBinding(selectedWorkspaceId, peerContract, nextInstanceId || null);
    }
    if (nextInstanceId) {
      open(makeWorkspacePageKey(nextInstanceId, activeSlotId));
    }
  };

  if (knownOfflinePeerPage) {
    const title =
      knownOfflinePeerPage.slotId === SESSION_SEARCH_PAGE_SLOT_ID
        ? `会话搜索 (${knownOfflinePeerPage.instanceId})`
        : `历史导入 (${knownOfflinePeerPage.instanceId})`;
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-surface)]">
        <header className="flex items-center gap-3 border-b border-[var(--border-hairline)] px-4 py-3">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            onClick={() => open(null)}
          >
            <ArrowLeft size={14} />
            返回会话
          </button>
          <h1 className="truncate text-sm font-medium text-[var(--text-primary)]">{title}</h1>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {knownOfflinePeerPage.slotId === SESSION_SEARCH_PAGE_SLOT_ID ? (
            <SessionSearchWorkspacePage instanceId={knownOfflinePeerPage.instanceId} />
          ) : (
            <HistoryImportWorkspacePage instanceId={knownOfflinePeerPage.instanceId} />
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-surface)]">
      <header className="flex items-center gap-3 border-b border-[var(--border-hairline)] px-4 py-3">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          onClick={() => open(null)}
        >
          <ArrowLeft size={14} />
          返回会话
        </button>
        <h1 className="truncate text-sm font-medium text-[var(--text-primary)]">{page!.title}</h1>
      </header>
      {page!.sourceKind === 'iframe' && peerContract && activeResolution && (
        <div
          data-testid="workspace-shell-resolution"
          className="border-b border-[var(--border-hairline)] px-4 py-2"
        >
          <ServiceResolutionBanner
            title={peerContract === SESSION_SEARCH_CONTRACT ? '检索服务实例' : '导入服务实例'}
            resolution={activeResolution}
            plugins={plugins}
            onSelectInstance={handleShellSelectInstance}
          />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <SlotErrorBoundary key={pageKey(page!)} registry={registry} item={page!}>
          {activeSlotId === 'session-inbox' && activeInstanceId
            ? <InboxWorkspaceSurface instanceId={activeInstanceId} />
            : <WorkspacePageContent page={page!} hostProps={hostProps} />}
        </SlotErrorBoundary>
      </div>
    </main>
  );
}
