import { ArrowLeft, Puzzle } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useAppStore } from '../stores/app-store';
import { useSlotItems, useSlotRegistry } from './hooks';
import { SlotErrorBoundary } from './SlotRenderer';
import type { RegisteredSlotItem } from './slot-registry';

function pageKey(page: RegisteredSlotItem<'workspace.pages'>) {
  return `${page.pluginId}:${page.id}`;
}

export function PluginWorkspaceLinks() {
  const pages = useSlotItems('workspace.pages');
  const active = useAppStore((state) => state.activePluginPage);
  const open = useAppStore((state) => state.setActivePluginPage);
  if (!pages.length) return null;

  return (
    <nav aria-label="插件工作页" className="max-h-36 space-y-1 overflow-y-auto px-3.5 pb-2">
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
