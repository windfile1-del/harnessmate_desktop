import { TRIAGE_INBOX_PLUGIN_ID, type InstalledPluginInfo, type Session, type SessionTriageState } from '@harnessmate/protocol';

export type TriageGroup = 'needs_attention' | 'unread' | 'running' | 'pinned' | 'normal' | 'snoozed' | 'settled';
export type TriageFilter = 'all' | 'pending' | 'deferred';
export type TriageStateBySession = Record<string, SessionTriageState>;

const priority: Record<TriageGroup, number> = {
  needs_attention: 0, unread: 1, running: 2, pinned: 3, normal: 4, snoozed: 5, settled: 5,
};

export function isActivePlugin(plugin: InstalledPluginInfo): boolean {
  return plugin.enabled && (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE');
}

export function isTriageEnabled(plugins: readonly InstalledPluginInfo[]): boolean {
  return plugins.some((plugin) => plugin.id === TRIAGE_INBOX_PLUGIN_ID && isActivePlugin(plugin));
}

export function classifyTriage(session: Session, state?: SessionTriageState): TriageGroup {
  const runtime = state && state.sessionSeq >= session.lastSeq ? state : session;
  if (runtime.pendingApprovalCount > 0 || runtime.status === 'awaiting_approval' || runtime.status === 'error') {
    return 'needs_attention';
  }
  const meta = state?.meta;
  if (meta && (meta.forceUnread || state.latestTurnSeq > meta.lastViewedTurnSeq)) return 'unread';
  if (runtime.status === 'running' || state?.hasRunningSubagents) return 'running';
  if (meta?.snoozedUntilMs != null) return 'snoozed';
  if (meta?.settled) return 'settled';
  return meta?.pinned ? 'pinned' : 'normal';
}

export function sortTriage(sessions: readonly Session[], states: TriageStateBySession) {
  return sessions
    .map((session) => {
      const state = states[session.id];
      const group = classifyTriage(session, state);
      const updatedAt = group === 'unread' && state?.meta.forceUnread
        ? Math.max(session.updatedAt, state.meta.updatedAt) : session.updatedAt;
      return { session, group, updatedAt };
    })
    .sort((a, b) => priority[a.group] - priority[b.group] || b.updatedAt - a.updatedAt);
}

export function isTriagePending(group: TriageGroup): boolean {
  return group === 'needs_attention' || group === 'unread';
}

export function filterTriage(rows: ReturnType<typeof sortTriage>, filter: TriageFilter): Session[] {
  if (filter === 'all') return rows.map(({ session }) => session);
  return rows.filter(({ group }) => {
    if (filter === 'pending') return isTriagePending(group);
    return group === 'snoozed' || group === 'settled';
  }).map(({ session }) => session);
}

export function nextAttentionSession(
  sessions: readonly Session[],
  states: TriageStateBySession,
  selectedSessionId: string | null,
  direction: -1 | 1,
): Session | undefined {
  const attention = sortTriage(sessions, states).filter(({ group }) => group === 'needs_attention');
  const index = attention.findIndex(({ session }) => session.id === selectedSessionId);
  const start = index < 0 ? (direction === 1 ? -1 : 0) : index;
  return attention[(start + direction + attention.length) % attention.length]?.session;
}

export function mergeTriageState(previous: SessionTriageState | undefined, incoming: SessionTriageState): SessionTriageState {
  if (!previous) return incoming;
  const runtime = incoming.sessionSeq >= previous.sessionSeq ? incoming : previous;
  const meta = incoming.meta.updatedAt >= previous.meta.updatedAt ? incoming.meta : previous.meta;
  return runtime.meta === meta ? runtime : { ...runtime, meta };
}
