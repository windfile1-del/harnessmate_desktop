import {
  SessionTriageMetaSchema,
  TRIAGE_INBOX_PLUGIN_ID,
  type CanonicalEventType,
  type MarkSessionViewedRequest,
  type Session,
  type SessionTriageMeta,
  type SessionTriageState,
  type TriageSnoozeExpired,
  type UpdateSessionTriageRequest,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { GLOBAL_WORKSPACE_SCOPE } from '../plugin-host/permissions/permissions.js';
import type { DaemonEventBus } from './event-bus.js';

const scope = GLOBAL_WORKSPACE_SCOPE;
const pluginId = TRIAGE_INBOX_PLUGIN_ID;
const triageEvents = new Set<CanonicalEventType>([
  'session.status', 'turn.completed', 'approval.requested', 'approval.resolved',
  'subagent.spawned', 'subagent.updated',
]);

export class TriageInboxService {
  constructor(
    private readonly store: HarnessMateStore,
    private readonly publish: (state: SessionTriageState, event?: TriageSnoozeExpired) => void,
  ) {}

  start(bus: DaemonEventBus): () => void {
    this.collectOrphans();
    const dirty = new Set<string>();
    let active = true;
    const enqueue = (sessionId: string) => {
      if (dirty.has(sessionId)) return;
      dirty.add(sessionId);
      if (dirty.size !== 1) return;
      queueMicrotask(() => {
        if (!active) return;
        const sessions = [...dirty];
        dirty.clear();
        for (const id of sessions) {
          const session = this.store.getSession(id);
          if (session) this.publish(this.project(session));
        }
      });
    };
    const unsubscribeEvents = bus.subscribeEvents(({ type, sessionId }) => {
      if (triageEvents.has(type)) enqueue(sessionId);
    });
    const unsubscribeAttention = bus.subscribeAttention(({ kind, sessionId }) => {
      if (kind === 'session_updated') enqueue(sessionId);
    });
    queueMicrotask(() => { if (active) this.checkExpiredSnoozes(); });
    const timer = setInterval(() => this.checkExpiredSnoozes(), 30_000);
    timer.unref();
    return () => {
      active = false;
      unsubscribeEvents();
      unsubscribeAttention();
      clearInterval(timer);
    };
  }

  list(): SessionTriageState[] {
    this.collectOrphans();
    return this.store.listSessions().map((session) => this.project(session));
  }

  update(sessionId: string, patch: UpdateSessionTriageRequest): SessionTriageState | undefined {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const state = this.project(session);
    const { meta } = state;
    const acknowledge = patch.settled === true || patch.snoozedUntilMs != null;
    const snoozedUntilMs = patch.snoozedUntilMs !== undefined
      ? patch.snoozedUntilMs
      : patch.settled === true ? null : meta.snoozedUntilMs;
    const updated: SessionTriageMeta = {
      ...meta,
      pinned: patch.pinned ?? meta.pinned,
      settled: patch.settled ?? (patch.snoozedUntilMs != null ? false : meta.settled),
      forceUnread: patch.forceUnread ?? (acknowledge ? false : meta.forceUnread),
      lastViewedTurnSeq: acknowledge ? state.latestTurnSeq : meta.lastViewedTurnSeq,
      snoozedUntilMs,
    };
    const nowMs = Date.now();
    if (snoozedUntilMs !== null && snoozedUntilMs <= nowMs) {
      return this.expire({ ...state, meta: updated }, snoozedUntilMs, nowMs).state;
    }
    return this.save(state, updated);
  }

  markViewed(sessionId: string, request: MarkSessionViewedRequest = {}): SessionTriageState | undefined {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const state = this.project(session);
    const { meta, latestTurnSeq } = state;
    const through = Math.min(latestTurnSeq, request.throughTurnSeq ?? latestTurnSeq);
    const forceUnread = meta.forceUnread && request.observedUpdatedAt !== undefined &&
      meta.updatedAt > request.observedUpdatedAt;
    if (forceUnread === meta.forceUnread && through <= meta.lastViewedTurnSeq) return state;
    return this.save(state, {
      ...meta,
      forceUnread,
      lastViewedTurnSeq: Math.max(meta.lastViewedTurnSeq, through),
    });
  }

  checkExpiredSnoozes(nowMs = Date.now()): TriageSnoozeExpired[] {
    const expired: TriageSnoozeExpired[] = [];
    for (const id of this.store.listPluginStorageKeys(scope, pluginId)) {
      const meta = this.readMeta(id);
      if (meta.snoozedUntilMs === null || meta.snoozedUntilMs > nowMs) continue;
      const session = this.store.getSession(id);
      if (!session) {
        this.store.deletePluginStorageValue(scope, pluginId, id);
        continue;
      }
      expired.push(this.expire(this.project(session, meta), meta.snoozedUntilMs, nowMs).event);
    }
    return expired;
  }

  private expire(state: SessionTriageState, snoozedUntilMs: number, nowMs: number) {
    const event: TriageSnoozeExpired = {
      type: 'triage.snooze_expired',
      sessionId: state.sessionId,
      snoozedUntilMs,
      createdAt: nowMs,
    };
    const updated = this.save(state, {
      ...state.meta, snoozedUntilMs: null, forceUnread: true, settled: false,
    }, event);
    return { state: updated, event };
  }

  private collectOrphans(): void {
    const ids = new Set(this.store.listSessionIds());
    for (const id of this.store.listPluginStorageKeys(scope, pluginId)) {
      if (!ids.has(id)) this.store.deletePluginStorageValue(scope, pluginId, id);
    }
  }

  private readMeta(sessionId: string): SessionTriageMeta {
    const parsed = SessionTriageMetaSchema.safeParse(this.store.getPluginStorageValue(scope, pluginId, sessionId));
    if (parsed.success && parsed.data.sessionId === sessionId) return parsed.data;
    return {
      sessionId, pinned: false, settled: false, forceUnread: false,
      lastViewedTurnSeq: 0, snoozedUntilMs: null, updatedAt: 0,
    };
  }

  private project(session: Session, meta = this.readMeta(session.id)): SessionTriageState {
    return {
      sessionId: session.id,
      sessionSeq: session.lastSeq,
      status: session.status,
      pendingApprovalCount: session.pendingApprovalCount,
      latestTurnSeq: this.store.getLatestCompletedTurnSeq(session.id),
      hasRunningSubagents: this.store.hasRunningSubagents(session.id),
      meta,
    };
  }

  private save(state: SessionTriageState, meta: SessionTriageMeta, event?: TriageSnoozeExpired): SessionTriageState {
    meta = { ...meta, updatedAt: Math.max(event?.createdAt ?? Date.now(), state.meta.updatedAt + 1) };
    this.store.setPluginStorageValue(scope, pluginId, state.sessionId, meta);
    const updated = { ...state, meta };
    this.publish(updated, event);
    return updated;
  }
}
