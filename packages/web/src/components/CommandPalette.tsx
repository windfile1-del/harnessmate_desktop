import type { HarnessCommandResult, Session } from '@harnessmate/protocol';
import { Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { daemonApi } from '../api/client';
import {
  HISTORY_IMPORT_CONTRACT,
  SESSION_SEARCH_CONTRACT,
  getPluginInstanceId,
  pluginProvidesContract,
} from '../api/peer-contracts';
import {
  commandKey,
  commandPaletteRegistry,
  delegatedSearchQuery,
  executePaletteEntry,
  indexCommands,
  loadCommandMru,
  parsePaletteSlash,
  rankCommands,
  recordCommandUse,
  type CommandPaletteEntry,
} from '../lib/command-palette';
import { handlePaletteKey } from '../lib/palette-keyboard';
import { isActivePlugin, sortTriage } from '../lib/triage';
import { useSlotItems } from '../slots/hooks';
import { useAppStore, type ActiveModal, type InspectorTab } from '../stores/app-store';
import { openTriageSession } from './TriageInbox';

const explorerId = 'hm.plugin.session-explorer';
const categoryLabel: Record<CommandPaletteEntry['category'], string> = {
  session: '会话 / 工作区', harness: '切换引擎', plugin_action: '插件动作', navigation: '导航', theme: '外观',
};

const shortcuts = [
  ['Ctrl / ⌘ + K', '打开命令面板'],
  ['Alt + ↑ / ↓', '切换需要处理的会话'],
  ['Ctrl / ⌘ + Shift + H', '查找可切换的 Harness'],
  ['Ctrl / ⌘ + N', '新建会话'],
  ['Ctrl / ⌘ + B', '切换侧栏'],
  ['Ctrl / ⌘ + I', '切换检视抽屉'],
  ['↑ / ↓ · Enter · Esc', '选择命令、执行、关闭'],
];

export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  return (
    <section className="p-5 text-[var(--text-primary)]">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">快捷键速查</h2>
        <button type="button" aria-label="关闭快捷键速查" onClick={onClose}><X size={16} /></button>
      </header>
      <dl className="space-y-2 text-xs">
        {shortcuts.map(([key, title]) => (
          <div key={key} className="flex items-center justify-between gap-2">
            <dt>{title}</dt>
            <dd><kbd className="rounded bg-[var(--bg-elevated)] px-2 py-1">{key}</kbd></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function fillSlashDraft(sessionId: string, command: string, args = ''): void {
  const store = useAppStore.getState();
  if (store.draftTextBySession[sessionId]?.trim()) throw new Error('请先处理当前输入草稿。');
  store.setDraftText(sessionId, `/${command} ${args}`);
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-session-composer]')?.focus());
}

export function createFullTextCommand(query: string, enabled: boolean, openSearch: (query: string) => void): CommandPaletteEntry {
  return {
    id: 'full-text-search', sourcePluginId: explorerId, category: 'navigation',
    title: `全文搜索「${query}」`, keywords: [],
    execute: () => {
      if (!enabled) throw new Error('请在插件中心启用 Session Explorer。');
      openSearch(query);
    },
  };
}

export function CommandPaletteModal({ initialQuery, onClose }: { initialQuery: string; onClose: () => void }) {
  const { sessions, triage, workspaces, harnesses, selectedId, plugins, theme, permissionRevision } =
    useAppStore(useShallow((state) => ({
      sessions: state.sessions,
      triage: state.triageBySession,
      workspaces: state.workspaces,
      harnesses: state.harnesses,
      selectedId: state.selectedSessionId,
      plugins: state.plugins,
      theme: state.theme,
      permissionRevision: state.pluginPermissionRevision,
    })));
  const currentSession = sessions.find(({ id }) => id === selectedId);
  const inspectorItems = useSlotItems('inspector.tabs');
  const registered = useSyncExternalStore(commandPaletteRegistry.subscribe, commandPaletteRegistry.getSnapshot,
    commandPaletteRegistry.getSnapshot);
  const activePlugins = useMemo(() => new Set(plugins.filter(isActivePlugin).map(({ id }) => id)), [plugins]);
  const [query, setQuery] = useState(initialQuery);
  const queryRef = useRef(initialQuery);
  const [mru, setMru] = useState(loadCommandMru);
  const [activeIndex, setActiveIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ title: string; text: string }>();
  const [catalog, setCatalog] = useState<{ scope: string; data: Awaited<ReturnType<typeof daemonApi.getHarnessCommands>> }>();
  const listId = useId();
  const composing = useRef(false);
  const executing = useRef(false);
  const showingOutput = useRef(false);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const selectedRow = useRef<HTMLButtonElement>(null);
  const scope = currentSession ? `${currentSession.id}:${currentSession.harnessId}:${permissionRevision}` : '';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!selectedId || !scope) return;
    const controller = new AbortController();
    void daemonApi.getHarnessCommands(selectedId, controller.signal).then((data) => {
      if (!controller.signal.aborted) setCatalog({ scope, data });
    }).catch(() => {});
    return () => controller.abort();
  }, [selectedId, scope, plugins]);

  const entries = useMemo(() => {
    const get = useAppStore.getState;
    const commands: CommandPaletteEntry[] = [];
    const add = (id: string, sourcePluginId: string, category: CommandPaletteEntry['category'], title: string,
      execute: CommandPaletteEntry['execute'], keywords: string[] = []) => {
      commands.push({ id, sourcePluginId, category, title, execute, keywords });
    };
    const modal = (name: ActiveModal, title: string, pluginId?: string, keywords: string[] = []) => {
      if (pluginId && !activePlugins.has(pluginId)) return;
      add(String(name), pluginId ?? 'core', pluginId ? 'plugin_action' : 'navigation',
        title, () => get().openModal(name), keywords);
    };
    const inspector = (tab: InspectorTab, title: string, pluginId: string) => {
      if (!selectedId || !activePlugins.has(pluginId)) return;
      add(tab, pluginId, 'plugin_action', title, () => {
        get().setInspectorTab(tab);
        get().setInspectorOpen(true);
      });
    };
    const slashArgs = (name: string) => {
      const parsed = parsePaletteSlash(queryRef.current);
      return parsed?.command === name ? parsed.args : '';
    };

    const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
    const harnessById = new Map(harnesses.map((harness) => [harness.id, harness.displayName]));
    for (const { session, group } of sortTriage(sessions, triage)) {
      const workspace = workspacesById.get(session.workspaceId) ?? '';
      const harness = harnessById.get(session.harnessId) ?? session.harnessId;
      commands.push({
        id: `session:${session.id}`, sourcePluginId: 'core', category: 'session', title: session.title,
        subtitle: [workspace, harness].filter(Boolean).join(' · '),
        keywords: [session.harnessId, ...session.participatingHarnesses],
        priority: group === 'needs_attention' ? 48 : group === 'unread' ? 26 : 0,
        execute: () => openTriageSession(session),
      });
    }
    for (const workspace of workspaces) {
      commands.push({
        id: `workspace:${workspace.id}`, sourcePluginId: 'core', category: 'session', title: workspace.name,
        subtitle: workspace.rootPath, keywords: ['workspace', '工作区'],
        execute: async () => {
          const store = get();
          store.setSelectedWorkspaceId(workspace.id);
          store.setSearchQuery('');
          if (!store.sessions.some((session) => session.id === store.selectedSessionId && session.workspaceId === workspace.id)) {
            await store.selectSession(store.sessions.find(({ workspaceId }) => workspaceId === workspace.id)?.id ?? null);
          }
        },
      });
    }
    if (selectedId) {
      for (const harness of harnesses) {
        if (harness.id === currentSession?.harnessId || harness.health === 'unavailable' || harness.health === 'unauthenticated') continue;
        add(`switch:${harness.id}`, 'core', 'harness', `切换至 ${harness.displayName}`, async () => {
          await get().switchHarness(selectedId, { targetHarnessId: harness.id });
        }, ['switch', harness.id, harness.kind, harness.displayName]);
      }
      modal('handoff', '会话交接与引擎切换', 'core.context-bridge', ['handoff']);
      modal('context_preview', '预览交接包', 'core.context-bridge', ['context bridge', 'handoff']);
      inspector('git', '打开 Git Diff', 'core.git-inspector');
      inspector('terminal', '工作区终端', 'core.terminal-runner');
      inspector('files', '工作区文件', 'core.terminal-runner');
      for (const item of inspectorItems) {
        if (!activePlugins.has(item.pluginId)) continue;
        add(`panel:${item.id}`, item.pluginId, 'plugin_action', item.title ?? item.pluginName,
          () => get().openPluginPanel(item.registrationKey), [item.id, item.pluginName]);
      }
      for (const plugin of plugins) {
        if (!activePlugins.has(plugin.id)) continue;
        for (const slash of plugin.contributes.slashCommands ?? []) {
          commands.push({
            id: `workflow:${slash.command}`, sourcePluginId: plugin.id, category: 'plugin_action',
            title: `/${slash.command}`, subtitle: slash.description, keywords: [plugin.name, 'workflow'],
            slashCommand: slash.command, execute: () => fillSlashDraft(selectedId, slash.command, slashArgs(slash.command)),
          });
        }
        for (const panel of plugin.contributes.panels ?? []) {
          for (const [actionIndex, action] of panel.actions.entries()) {
            add(`panel:${panel.id}:${actionIndex}:${action.command}`, plugin.id, 'plugin_action', action.label,
              () => fillSlashDraft(selectedId, action.command, action.args), [`/${action.command}`, panel.title]);
          }
        }
      }
      const sessionCatalog = catalog?.scope === scope ? catalog.data : undefined;
      const showResult = (title: string, result: HarnessCommandResult) => {
        if (result.turnId && !result.output) return;
        showingOutput.current = true;
        if (mounted.current) setOutput({ title, text: result.output || '（空结果）' });
      };
      for (const action of [...(sessionCatalog?.pluginActions ?? []), ...(sessionCatalog?.pluginCommands ?? [])]) {
        if (!activePlugins.has(action.pluginId)) continue;
        const name = `/${action.command}`;
        const execute = async () => {
          if ('reason' in action && action.reason) throw new Error(action.reason);
          const session = get().sessions.find(({ id }) => id === selectedId);
          if (!session) throw new Error('会话已关闭。');
          const result = await get().runPluginAction(session.id, {
            pluginId: action.pluginId, command: action.command, args: slashArgs(action.command), harnessId: session.harnessId,
          });
          showResult(name, result);
        };
        commands.push({ id: `action:${action.command}`, sourcePluginId: action.pluginId, category: 'plugin_action',
          title: name, subtitle: action.description, keywords: [action.pluginName], slashCommand: action.command, execute });
      }
      for (const command of sessionCatalog?.commands ?? []) {
        commands.push({
          id: `native:${command.command}`, sourcePluginId: 'core.harness-commands', category: 'plugin_action',
          title: `/${command.command}`, subtitle: command.description, keywords: ['Harness'],
          slashCommand: command.command, execute: () => fillSlashDraft(selectedId, command.command, slashArgs(command.command)),
        });
      }
    }
    modal('new_session', '新建会话', undefined, ['new session']);
    modal('add_workspace', '添加工作区', undefined, ['workspace']);
    modal('plugins', '打开插件中心', undefined, ['plugin studio']);
    modal('keyboard_shortcuts', '快捷键速查', undefined, ['shortcuts', 'keyboard']);
    modal('harnesses', '管理本机 CLI 引擎', undefined, ['harness']);
    modal('worktrees', '打开 Worktree 管理', 'core.git-inspector', ['Git 分支']);
    modal('mcp', '打开 MCP 管理中心', 'core.mcp-hub');
    modal('usage', '打开用量看板', 'core.account-usage', ['usage', 'quota']);
    modal('remote_pairing', '移动端扫码联动', 'core.remote-mobile');
    modal('session_explorer', '打开会话检索与导入', explorerId, ['Session Explorer', '全文搜索', 'FTS']);
    for (const plugin of plugins) {
      const instId = getPluginInstanceId(plugin);
      if (!activePlugins.has(plugin.id) && !activePlugins.has(instId)) continue;
      if (pluginProvidesContract(plugin, SESSION_SEARCH_CONTRACT)) {
        add(
          `search-page:${instId}`,
          plugin.id,
          'navigation',
          `打开会话搜索工作页 · ${plugin.name} (${instId})`,
          () => get().openSessionSearchPage({ instanceId: instId }),
          ['search', 'fts', '全文搜索', instId],
        );
      }
      if (pluginProvidesContract(plugin, HISTORY_IMPORT_CONTRACT)) {
        add(
          `import-page:${instId}`,
          plugin.id,
          'navigation',
          `打开历史导入工作页 · ${plugin.name} (${instId})`,
          () => get().openHistoryImportPage({ instanceId: instId }),
          ['import', 'history', '历史导入', instId],
        );
      }
    }
    modal('risk_rules', '打开审批规则', 'hm.plugin.approval-center');
    add('theme', 'core', 'theme', theme === 'dark' ? '切换浅色主题' : '切换深色主题',
      () => get().toggleTheme(), ['theme', 'dark', 'light']);
    return [...new Map([...commands, ...registered.filter(({ sourcePluginId }) => activePlugins.has(sourcePluginId))]
      .map((entry) => [commandKey(entry), entry])).values()];
  }, [activePlugins, catalog, currentSession, harnesses, inspectorItems, plugins, registered, scope, selectedId, sessions, theme, triage, workspaces]);
  const index = useMemo(() => indexCommands(entries), [entries]);
  const delegated = delegatedSearchQuery(query);
  const fullTextAvailable = useMemo(
    () =>
      activePlugins.has(explorerId) ||
      plugins.some(
        (plugin) =>
          (activePlugins.has(plugin.id) || activePlugins.has(getPluginInstanceId(plugin))) &&
          pluginProvidesContract(plugin, SESSION_SEARCH_CONTRACT),
      ),
    [activePlugins, plugins],
  );
  const results = useMemo(() => {
    if (delegated !== undefined) {
      return delegated ? [createFullTextCommand(delegated, fullTextAvailable, useAppStore.getState().openSessionSearch)] : [];
    }
    const slash = parsePaletteSlash(query);
    if (slash) {
      const exact = index.filter(({ entry }) => entry.slashCommand === slash.command);
      if (exact.length) return rankCommands(exact, '', mru);
    }
    return rankCommands(index, query, mru).slice(0, 80);
  }, [delegated, fullTextAvailable, index, mru, query]);
  const row = Math.min(activeIndex, Math.max(0, results.length - 1));
  const active = results[row];

  useEffect(() => { selectedRow.current?.scrollIntoView({ block: 'nearest' }); }, [row, active]);

  const run = async (entry?: CommandPaletteEntry) => {
    if (!entry || executing.current) return;
    executing.current = true;
    showingOutput.current = false;
    setRunning(true);
    try {
      const ok = await executePaletteEntry(entry, (title, body) =>
        useAppStore.getState().pushToast({ kind: 'warning', title, body }));
      if (!ok) return;
      const nextMru = recordCommandUse(mru, entry);
      if (!mounted.current) return;
      setMru(nextMru);
      if (!showingOutput.current && useAppStore.getState().activeModal === 'command_palette') onClose();
    } finally {
      executing.current = false;
      if (mounted.current) setRunning(false);
    }
  };
  const closeOrBack = () => {
    if (!output) onClose();
    else {
      setOutput(undefined);
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  return (
    <section aria-label="命令面板" role="dialog" aria-modal="true" className="text-[var(--text-primary)]"
      onKeyDown={(event) => handlePaletteKey(event, composing.current, {
        move: (step) => { if (!output && results.length) setActiveIndex((row + step + results.length) % results.length); },
        execute: () => { if (!output) void run(active); },
        close: closeOrBack,
      })}>
      {output ? (
        <div className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">{output.title}</h2>
            <button type="button" autoFocus onClick={closeOrBack} className="text-xs">返回命令</button>
          </div>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-elevated)] p-3 text-xs">{output.text}</pre>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-[var(--border-strong)] px-4 py-3.5">
            <Search size={17} aria-hidden="true" className="shrink-0 text-[var(--accent-indigo)]" />
            <input ref={input} type="text" role="combobox" aria-label="搜索命令" aria-expanded="true"
              aria-autocomplete="list" aria-controls={listId} aria-activedescendant={active ? `${listId}-${row}` : undefined}
              value={query} autoFocus maxLength={12_042} placeholder="搜索会话、命令或输入 ? 关键词全文搜索"
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              onChange={(event) => {
                queryRef.current = event.target.value;
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              className="w-full bg-transparent text-sm placeholder:text-[var(--text-secondary)] focus:outline-none" />
            <button tabIndex={-1} type="button" onClick={onClose} aria-label="关闭命令面板"
              className="rounded border border-[var(--border-strong)] px-1.5 py-0.5 text-[10px]">Esc</button>
          </div>
          <div role="listbox" aria-label="命令结果" aria-busy={running} id={listId}
            className="max-h-[min(420px,60vh)] min-h-16 space-y-0.5 overflow-y-auto p-2">
            {results.length === 0 && (
              <p className="px-3 py-4 text-xs text-[var(--text-secondary)]">{delegated === '' ? '输入全文搜索关键词' : '没有匹配的命令'}</p>
            )}
            {results.map((entry, i) => (
              <button key={commandKey(entry)} id={`${listId}-${i}`} ref={i === row ? selectedRow : undefined}
                type="button" role="option" aria-selected={i === row} tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()} onClick={() => void run(entry)}
                onMouseMove={() => setActiveIndex(i)}
                className="flex w-full items-center justify-between gap-4 rounded-lg border border-transparent px-3 py-2 text-left aria-selected:border-[var(--border-focus)] aria-selected:bg-[var(--bg-active)]">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{entry.title}</span>
                  {entry.subtitle && <span className="block truncate text-[11px] text-[var(--text-secondary)]">{entry.subtitle}</span>}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">{entry.shortcutHint ?? categoryLabel[entry.category]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
