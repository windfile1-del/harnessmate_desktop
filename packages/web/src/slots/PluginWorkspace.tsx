import { ArrowLeft, Globe, Puzzle } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
    plugins,
    sessionBindingsBySession,
    refreshSessionBindings,
    setSessionBinding,
  } = useAppStore(useShallow((state) => ({
    active: state.activePluginPage,
    open: state.setActivePluginPage,
    selectedSessionId: state.selectedSessionId,
    plugins: state.plugins,
    sessionBindingsBySession: state.sessionBindingsBySession,
    refreshSessionBindings: state.refreshSessionBindings,
    setSessionBinding: state.setSessionBinding,
  })));

  useEffect(() => {
    if (selectedSessionId) void refreshSessionBindings(selectedSessionId).catch(() => {});
  }, [selectedSessionId, plugins, refreshSessionBindings]);

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

  if (!pages.length && !(selectedSessionId && browserProviders.length > 0)) return null;

  return (
    <nav aria-label="插件工作页" className="max-h-48 space-y-1 overflow-y-auto px-3.5 pb-2">
      {pages.map((page) => (
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

function WorkspacePageContent({ page }: { page: RegisteredSlotItem<'workspace.pages'> }) {
  return page.render({});
}

export function PluginWorkspaceStage({ children }: { children: ReactNode }) {
  const registry = useSlotRegistry();
  const pages = useSlotItems('workspace.pages');
  const active = useAppStore((state) => state.activePluginPage);
  const open = useAppStore((state) => state.setActivePluginPage);
  const page = pages.find((item) => pageKey(item) === active);

  useEffect(() => {
    if (active && !page) open(null);
  }, [active, open, page]);

  if (!page) return children;

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
        <h1 className="truncate text-sm font-medium text-[var(--text-primary)]">{page.title}</h1>
      </header>
      <div className="min-h-0 flex-1">
        <SlotErrorBoundary key={pageKey(page)} registry={registry} item={page}>
          <WorkspacePageContent page={page} />
        </SlotErrorBoundary>
      </div>
    </main>
  );
}
