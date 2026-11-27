import { sessionDataStreamKey } from '@harnessmate/plugin-api';
import {
  SessionTriageMetaSchema,
  TriageSnoozeExpiredSchema,
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
import type { SessionChangeFeedService } from './session-change-feed.js';

const scope = GLOBAL_WORKSPACE_SCOPE;
const reminderScope = 'session-snooze-notifications';
const reminderRetentionMs = 24 * 60 * 60_000;
const triageEvents = new Set<CanonicalEventType>([
  'session.status', 'turn.completed', 'approval.requested', 'approval.resolved',
  'subagent.spawned', 'subagent.updated',
]);

export class TriageInboxService {
  constructor(
    private readonly store: HarnessMateStore,
    private readonly publish: (state: SessionTriageState, event?: TriageSnoozeExpired) => void,
    private readonly instanceId = TRIAGE_INBOX_PLUGIN_ID,
    private readonly owns: (session: Session) => boolean = () => true,
    private readonly canSnooze: (session: Session) => boolean = () => true,
  ) {}

  start(bus: DaemonEventBus, changes?: SessionChangeFeedService): () => void {
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
          if (session && this.owns(session)) this.publish(this.project(session));
        }
      });
    };
    const unsubscribeEvents = bus.subscribeEvents(({ type, sessionId }) => {
      if (triageEvents.has(type)) enqueue(sessionId);
    });
    const unsubscribeAttention = bus.subscribeAttention(({ kind, sessionId }) => {
      if (kind === 'session_updated') enqueue(sessionId);
    });
    let currentStreamKey = 'hm.plugin.session-data-default::sqlite-main';
    let cursor = changes?.getLatestSeq() ?? 0;
    const unsubscribeChanges = changes?.onCommitted((_latest, ev) => {
      if (ev?.stream) {
        const nextKey = sessionDataStreamKey(ev.stream);
        if (nextKey !== currentStreamKey) {
          currentStreamKey = nextKey;
          cursor = 0;
        }
        if (ev.sessionId) enqueue(ev.sessionId);
      }
      let more = true;
      while (more && active && changes) {
        const page = changes.readCommittedChanges({ afterSeq: cursor });
        for (const change of page.changes) {
          if (change.kind === 'delete_session') {
            this.store.deletePluginStorageValue(scope, this.instanceId, change.sessionId);
            this.store.deletePluginStorageValue(reminderScope, this.instanceId, change.sessionId);
          } else if (change.kind === 'upsert_session') {
            enqueue(change.sessionId);
          }
          cursor = change.changeSeq;
        }
        more = page.hasMore;
      }
    });
    return () => {
      active = false;
      unsubscribeEvents();
      unsubscribeAttention();
      unsubscribeChanges?.();
    };
  }

  list(): SessionTriageState[] {
    this.collectOrphans();
    return this.store.listSessions().filter(this.owns).map((session) => this.project(session));
  }

  update(sessionId: string, patch: UpdateSessionTriageRequest): SessionTriageState | undefined {
    const session = this.store.getSession(sessionId);
    if (!session || !this.owns(session)) return;
    if (patch.snoozedUntilMs != null && !this.canSnooze(session)) throw new Error('延后提醒已停用');
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
    if (!session || !this.owns(session)) return;
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
    for (const id of this.store.listPluginStorageKeys(scope, this.instanceId)) {
      const meta = this.readMeta(id);
      if (meta.snoozedUntilMs === null || meta.snoozedUntilMs > nowMs) continue;
      const session = this.store.getSession(id);
      if (!session) {
        this.store.deletePluginStorageValue(scope, this.instanceId, id);
        continue;
      }
      if (this.owns(session) && this.canSnooze(session)) {
        expired.push(this.expire(this.project(session, meta), meta.snoozedUntilMs, nowMs).event);
      }
    }
    return expired;
  }

  recentSnoozeReminders(nowMs = Date.now()): TriageSnoozeExpired[] {
    const reminders: TriageSnoozeExpired[] = [];
    for (const id of this.store.listPluginStorageKeys(reminderScope, this.instanceId)) {
      const result = TriageSnoozeExpiredSchema.safeParse(this.store.getPluginStorageValue(reminderScope, this.instanceId, id));
      const session = this.store.getSession(id);
      if (!session || !result.success || nowMs - result.data.createdAt > reminderRetentionMs) {
        this.store.deletePluginStorageValue(reminderScope, this.instanceId, id);
      } else if (this.owns(session) && this.canSnooze(session)) {
        reminders.push(result.data);
      }
    }
    return reminders;
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
    for (const id of this.store.listPluginStorageKeys(scope, this.instanceId)) {
      if (!ids.has(id)) this.store.deletePluginStorageValue(scope, this.instanceId, id);
    }
  }

  private readMeta(sessionId: string): SessionTriageMeta {
    const parsed = SessionTriageMetaSchema.safeParse(this.store.getPluginStorageValue(scope, this.instanceId, sessionId));
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
    this.store.runInImmediateTransaction(() => {
      this.store.setPluginStorageValue(scope, this.instanceId, state.sessionId, meta);
      if (event) this.store.setPluginStorageValue(reminderScope, this.instanceId, state.sessionId, event);
    });
    const updated = { ...state, meta };
    this.publish(updated, event);
    return updated;
  }
}
