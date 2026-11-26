import { TRIAGE_INBOX_PLUGIN_ID, type InstalledPluginInfo, type Session, type SessionTriageState } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createFullTextCommand } from '../src/components/CommandPalette';
import { Sidebar } from '../src/components/Sidebar';
import {
  commandKey,
  CommandPaletteRegistry,
  delegatedSearchQuery,
  executePaletteEntry,
  indexCommands,
  rankCommands,
  type CommandPaletteEntry,
} from '../src/lib/command-palette';
import { isImeComposing, trackComposition } from '../src/lib/ime';
import { handlePaletteKey } from '../src/lib/palette-keyboard';
import { classifyTriage, filterTriage, mergeTriageState, sortTriage } from '../src/lib/triage';
import { handleTriageShortcut } from '../src/lib/triage-shortcuts';
import { SlotRegistry, SlotRegistryProvider } from '../src/slots';
import { registerTriageBadge } from '../src/slots/PluginSlotSync';
import { useAppStore } from '../src/stores/app-store';

vi.mock('../src/stores/app-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/stores/app-store')>();
  const bound = original.useAppStore;
  return { ...original, useAppStore: Object.assign(
    (selector?: (state: ReturnType<typeof bound.getState>) => unknown) =>
      selector ? selector(bound.getState()) : bound.getState(),
    bound,
  ) };
});

const now = 1_700_000_100_000;
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, workspaceId: 'workspace', harnessId: 'testing', harnessKind: 'codex', nativeSessionId: null,
  participatingHarnesses: ['testing'], contextSyncMode: 'auto', cwd: '/workspace', title: `Session ${id}`,
  status: 'idle', model: null, reasoningEffort: null, permissionMode: 'manual', lastSeq: 0,
  usage: null, pendingApprovalCount: 0, createdAt: now, updatedAt: now, ...patch,
});
const state = (id: string, meta: Partial<SessionTriageState['meta']> = {},
  patch: Partial<Omit<SessionTriageState, 'meta'>> = {}): SessionTriageState => ({
  sessionId: id, sessionSeq: 0, status: 'idle', pendingApprovalCount: 0, latestTurnSeq: 0,
  hasRunningSubagents: false, ...patch,
  meta: { sessionId: id, pinned: false, settled: false, forceUnread: false, lastViewedTurnSeq: 0,
    snoozedUntilMs: null, updatedAt: now, ...meta },
});
const enabled: InstalledPluginInfo = {
  id: TRIAGE_INBOX_PLUGIN_ID, name: 'Triage Inbox', version: '1.0.0', category: 'ui', contributes: {},
  enabled: true, builtin: true, source: 'builtin', runtimeState: 'ACTIVE', provides: ['session.inbox.v1'],
};
const snoozePlugin: InstalledPluginInfo = {
  ...enabled, id: 'hm.plugin.session-snooze', name: 'Session Snooze', provides: ['session.snooze.v1'],
};
const command = (id: string, title: string, patch: Partial<CommandPaletteEntry> = {}): CommandPaletteEntry => ({
  id, title, sourcePluginId: 'test.plugin', category: 'plugin_action', keywords: [], execute: vi.fn(), ...patch,
});

afterEach(() => useAppStore.setState(useAppStore.getInitialState(), true));

it('sorts attention, unread, running, pinned, normal and deferred sessions in strict priority order', () => {
  const sessions = ['snoozed', 'settled', 'normal', 'pinned', 'running', 'unread', 'attention']
    .map((id, i) => session(id, { updatedAt: now - i }));
  const triage = {
    attention: state('attention', { forceUnread: true, settled: true }, { pendingApprovalCount: 1 }),
    unread: state('unread', { pinned: true, lastViewedTurnSeq: 5 }, { latestTurnSeq: 10, status: 'running' }),
    running: state('running', { pinned: true }, { hasRunningSubagents: true }),
    pinned: state('pinned', { pinned: true }),
    snoozed: state('snoozed', { pinned: true, snoozedUntilMs: now + 60_000 }),
    settled: state('settled', { settled: true }),
  };
  const rows = sortTriage(sessions, triage);
  expect(rows.map(({ group }) => group)).toEqual(['needs_attention', 'unread', 'running', 'pinned', 'normal', 'snoozed', 'settled']);
  expect(filterTriage(rows, 'all').map(({ id }) => id)).toEqual(['attention', 'unread', 'running', 'pinned', 'normal', 'snoozed', 'settled']);
  expect(filterTriage(rows, 'pending').map(({ id }) => id)).toEqual(['attention', 'unread']);
  expect(filterTriage(rows, 'deferred').map(({ id }) => id)).toEqual(['snoozed', 'settled']);
  expect(classifyTriage(session('failure', { status: 'error' }))).toBe('needs_attention');
  expect(classifyTriage(session('manual'), state('manual', { forceUnread: true }))).toBe('unread');
  expect(classifyTriage(session('viewed'), state('viewed', { lastViewedTurnSeq: 10 }, { latestTurnSeq: 10 }))).toBe('normal');
});

it('merges a late REST snapshot with newer websocket runtime and metadata independently', () => {
  const fresh = state('a', { pinned: true, updatedAt: now + 2 }, { sessionSeq: 10, latestTurnSeq: 7 });
  const late = state('a', { updatedAt: now + 1 }, { sessionSeq: 11, latestTurnSeq: 8 });
  expect(mergeTriageState(fresh, late)).toMatchObject({
    sessionSeq: 11, latestTurnSeq: 8, meta: { pinned: true, updatedAt: now + 2 },
  });
  expect(mergeTriageState(late, fresh)).toEqual(mergeTriageState(fresh, late));
});

it('renders real sidebar slots before selection, clears the selected red badge, and restores input order after disable', () => {
  const registry = new SlotRegistry();
  const unscoped = registry.getItems('inspector.tabs', { hasSession: false });
  expect(registry.getItems('inspector.tabs', { hasSession: false })).toBe(unscoped);
  const sessions = [session('normal'), session('approval'), session('unread'), session('deferred')];
  useAppStore.setState({
    sessions, plugins: [enabled, snoozePlugin], selectedSessionId: null,
    triageBySession: {
      approval: state('approval', {}, { pendingApprovalCount: 1 }),
      unread: state('unread', { forceUnread: true }),
      deferred: state('deferred', { settled: true }),
    },
  });
  const dispose = registerTriageBadge(registry, [enabled])!;
  const render = () => renderToStaticMarkup(<SlotRegistryProvider registry={registry}><Sidebar /></SlotRegistryProvider>);
  const dashboard = render();
  expect(dashboard).toContain('待处理 (2)');
  expect(dashboard).toContain('已延后');
  expect(dashboard).toContain('aria-label="需要处理"');
  expect(dashboard).toContain('aria-label="未读结果"');
  expect(dashboard).toContain('aria-label="延后提醒"');
  expect(dashboard.indexOf('Session approval')).toBeLessThan(dashboard.indexOf('Session normal'));
  expect(dashboard).not.toContain('Session deferred');
  useAppStore.setState({ plugins: [enabled, { ...snoozePlugin, enabled: false }] });
  expect(render()).not.toContain('aria-label="延后提醒"');
  expect(render()).toContain('aria-label="需要处理"');
  useAppStore.setState({ selectedSessionId: 'approval' });
  expect(render()).not.toContain('aria-label="需要处理"');
  expect(render()).toContain('待处理 (2)');

  dispose();
  const disabled = { ...enabled, enabled: false } as const;
  useAppStore.setState({ plugins: [disabled] });
  expect(registerTriageBadge(registry, [disabled])).toBeUndefined();
  expect(registry.getItems('session.sidebar.badge', { hasSession: true })).toHaveLength(0);
  const flat = render();
  expect(flat).not.toContain('待处理 (2)');
  expect(flat).not.toContain('aria-label="未读结果"');
  expect(flat).toContain('Session deferred');
  expect(flat.indexOf('Session normal')).toBeLessThan(flat.indexOf('Session approval'));
});

it('matches titles, keywords and subsequences and adds recent and frequent usage weight', () => {
  const first = command('first', 'Review build');
  const second = command('second', 'Review bridge');
  const harness = command('claude', '切换至 Claude Code', { category: 'harness', keywords: ['switch', 'claude-code'] });
  const index = indexCommands([first, second, harness]);
  expect(rankCommands(index, 'rview bld', {}, now)[0]).toBe(first);
  expect(rankCommands(index, 'ＳＷＩＴＣＨ cld', {}, now)).toEqual([harness]);
  expect(rankCommands(index, 'review', { [commandKey(second)]: { count: 7, lastUsedAt: now } }, now)[0]).toBe(second);
  expect(rankCommands(index, 'switch absent', {}, now)).toEqual([]);
});

it('filters 200 sessions and 50 actions in under 16 ms per query', () => {
  const index = indexCommands([
    ...Array.from({ length: 200 }, (_, i) => command(`session-${i}`, `Session ${i} build 审查`, {
      category: 'session', subtitle: 'HarnessMate · Main workspace', keywords: ['codex', 'workspace', 'review'],
    })),
    ...Array.from({ length: 50 }, (_, i) => command(`action-${i}`, `Run tool ${i}`, {
      keywords: ['plugin', 'review', 'engine'],
    })),
  ]);
  rankCommands(index, 'review', {}, now);
  for (const query of ['', 'review', 'session 42', 'rn tl 7', '审查 Main', 'workspace codex', 'nothing matches']) {
    const start = performance.now();
    rankCommands(index, query, {}, now);
    expect(performance.now() - start, query).toBeLessThan(16);
  }
});

it('guards Enter and Escape through a complete IME composition and accepts Enter after compositionend', () => {
  const target = new EventTarget();
  const composing = { current: false };
  const cleanup = trackComposition(target, composing);
  const actions = { move: vi.fn(), execute: vi.fn(), close: vi.fn() };
  const key = (name: string, flags = {}) => ({
    key: name, keyCode: 0, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...flags,
  });
  target.dispatchEvent(new Event('compositionstart'));
  const enter = key('Enter');
  const escape = key('Escape');
  handlePaletteKey(enter, composing.current, actions);
  handlePaletteKey(escape, composing.current, actions);
  expect(actions.execute).not.toHaveBeenCalled();
  expect(actions.close).not.toHaveBeenCalled();
  expect(enter.preventDefault).not.toHaveBeenCalled();
  expect(escape.preventDefault).not.toHaveBeenCalled();
  target.dispatchEvent(new Event('compositionend'));
  for (const properties of [{ isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }]) {
    handlePaletteKey(key('Enter', properties), composing.current, actions);
    handlePaletteKey(key('Escape', properties), composing.current, actions);
    expect(isImeComposing(key('Escape', properties), composing.current)).toBe(true);
  }
  expect(actions.execute).not.toHaveBeenCalled();
  expect(actions.close).not.toHaveBeenCalled();
  handlePaletteKey(key('ArrowDown'), composing.current, actions);
  handlePaletteKey(key('ArrowUp'), composing.current, actions);
  handlePaletteKey(key('Enter'), composing.current, actions);
  expect(actions.move.mock.calls).toEqual([[1], [-1]]);
  expect(actions.execute).toHaveBeenCalledOnce();
  handlePaletteKey(key('Escape'), composing.current, actions);
  expect(actions.close).toHaveBeenCalledOnce();
  cleanup();
  target.dispatchEvent(new Event('compositionstart'));
  expect(composing.current).toBe(false);
});

it('isolates synchronous and asynchronous third-party errors and removes disposed commands', async () => {
  const registry = new CommandPaletteRegistry();
  const toast = vi.fn();
  const bad = command('bad', 'Faulty command', { execute: () => { throw new Error('plugin failed'); } });
  const dispose = registry.register(bad);
  expect(registry.getSnapshot()).toEqual([bad]);
  expect(await executePaletteEntry(registry.getSnapshot()[0]!, toast)).toBe(false);
  expect(toast).toHaveBeenCalledWith('命令执行失败，可以重试', 'plugin failed');
  expect(await executePaletteEntry(command('async', 'Async command', { execute: () => Promise.reject(new Error('rejected')) }), toast)).toBe(false);
  dispose();
  expect(registry.getSnapshot()).toEqual([]);
});

it('hands a ? query to Session Explorer and respects its enablement', async () => {
  const query = delegatedSearchQuery('?  并行审批  ')!;
  const toast = vi.fn();
  expect(query).toBe('并行审批');
  expect(delegatedSearchQuery('normal search')).toBeUndefined();
  const openSearch = useAppStore.getState().openSessionSearch;
  expect(await executePaletteEntry(createFullTextCommand(query, false, openSearch), toast)).toBe(false);
  expect(await executePaletteEntry(createFullTextCommand(query, true, openSearch), toast)).toBe(true);
  expect(useAppStore.getState()).toMatchObject({ activeModal: 'session_explorer', explorerInitialQuery: query });
});

it('cycles attention sessions with Alt+Down and suppresses global shortcuts during composition', () => {
  const sessions = [session('first', { status: 'error' }), session('normal'), session('next', { pendingApprovalCount: 1 })];
  const context = {
    modal: null, sessions, triage: {}, selectedSessionId: 'first',
    openPalette: vi.fn(), closePalette: vi.fn(), selectSession: vi.fn(),
  };
  const press = (key: string, flags: Partial<KeyboardEvent> = {}, composing = false) => handleTriageShortcut({
    key, keyCode: 0, defaultPrevented: false, preventDefault: vi.fn(), ...flags,
  } as unknown as KeyboardEvent, composing, context);
  press('ArrowDown', { altKey: true }, true);
  press('k', { metaKey: true, keyCode: 229 });
  expect(context.selectSession).not.toHaveBeenCalled();
  expect(context.openPalette).not.toHaveBeenCalled();
  press('ArrowDown', { altKey: true });
  expect(context.selectSession).toHaveBeenCalledWith(sessions[2]);
  press('h', { ctrlKey: true, shiftKey: true });
  expect(context.openPalette).toHaveBeenCalledWith('switch ');
});
