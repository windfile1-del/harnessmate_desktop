import type { Session, SessionTaskState } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { GLOBAL_WORKSPACE_SCOPE } from '../plugin-host/permissions/permissions.js';
import type { DaemonEventBus } from './event-bus.js';
import type { SessionChangeFeedService } from './session-change-feed.js';
import type { TaskLedgerService } from './task-ledger-service.js';

const cursorKey = (id: string) => `projection:${id}`;
const terminalEvents = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);
const syncEvents = new Set(['checkpoint.reverted', 'session.harness_switched']);

export function startTaskLedgerProjection(options: {
  store: HarnessMateStore;
  changes: SessionChangeFeedService;
  events: DaemonEventBus;
  instanceId: string;
  ledger: TaskLedgerService;
  owns(session: Session): boolean;
  publish(state: SessionTaskState): void;
  report(error: unknown): void;
}): () => void {
  const { store, changes, events, instanceId, ledger, owns, publish, report } = options;
  const scope = GLOBAL_WORKSPACE_SCOPE;
  const pending = new Set(store.listSessionIds());
  const startupMirrors = new Set(pending);
  const deleted = new Set<string>();
  let changeSeq = changes.getLatestSeq();
  let active = true;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function project(id: string) {
    const session = store.getSession(id);
    if (!session || !owns(session)) return;
    const value = store.getPluginStorageValue(scope, instanceId, cursorKey(id));
    let cursor = typeof value === 'number' ? value : 0;
    if (cursor > session.lastSeq) cursor = 0;
    const records = store.readCommittedLedgerEvents(id, { afterSeq: cursor, throughSeq: session.lastSeq })
      .filter((event) => event.payload.maintenance !== true);
    if (records.length === 0) {
      if (value === undefined) {
        ledger.syncSession(session);
        store.setPluginStorageValue(scope, instanceId, cursorKey(id), 0);
      } else if (startupMirrors.has(id) && cursor > 0) {
        ledger.syncSession(session);
      }
      startupMirrors.delete(id);
      return;
    }
    for (const event of records) {
      const git = event.turnId && terminalEvents.has(event.type) ? await ledger.readGitChanges(session) : [];
      if (!active || !store.isOpen()) return;
      const current = store.getSession(id);
      if (!current || !owns(current) || current.lastSeq < event.seq) return;
      const state = store.runInImmediateTransaction(() => {
        let updated: SessionTaskState | undefined;
        if (event.turnId && terminalEvents.has(event.type)) {
          const turn = store.readCommittedLedgerEvents(id, { afterSeq: 0, throughSeq: event.seq }, event.turnId);
          const harnessId = typeof event.payload.harnessId === 'string' ? event.payload.harnessId : current.harnessId;
          updated = ledger.applyTurnEvents(current, event.turnId, harnessId, turn, git, false);
        } else {
          ledger.syncSession(current);
        }
        store.setPluginStorageValue(scope, instanceId, cursorKey(id), event.seq);
        return updated;
      });
      if (state) {
        ledger.syncSession(current);
        publish(ledger.getOrCreate(current));
      }
    }
    startupMirrors.delete(id);
  }

  function schedule(delay = 0) {
    if (!active || running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, delay);
    timer.unref();
  }

  async function drain() {
    running = true;
    const retry = new Set<string>();
    try {
      let more = true;
      while (active && more) {
        const page = changes.readCommittedChanges({ afterSeq: changeSeq });
        for (const change of page.changes) {
          if (change.kind === 'delete_session') deleted.add(change.sessionId);
          if (change.kind === 'upsert_session') pending.add(change.sessionId);
          changeSeq = change.changeSeq;
        }
        more = page.hasMore;
      }
      for (const id of deleted) {
        store.runInImmediateTransaction(() => {
          store.deletePluginStorageValue(scope, instanceId, cursorKey(id));
          if (instanceId !== 'core.task-ledger') store.deletePluginStorageValue(id, instanceId, 'task-state');
        });
        deleted.delete(id);
      }
      for (const id of pending) {
        if (!active) break;
        pending.delete(id);
        try {
          await project(id);
        } catch (error) {
          retry.add(id);
          report(error);
        }
      }
    } catch (error) {
      report(error);
    } finally {
      running = false;
      for (const id of retry) pending.add(id);
      if (active && (pending.size || deleted.size || changes.getLatestSeq() > changeSeq)) schedule(1_000);
    }
  }

  const unsubChanges = changes.onCommitted(() => schedule());
  const unsubEvents = events.subscribeEvents((event) => {
    if (!terminalEvents.has(event.type) && !syncEvents.has(event.type)) return;
    pending.add(event.sessionId);
    schedule();
  });
  schedule();
  return () => {
    active = false;
    clearTimeout(timer);
    unsubChanges();
    unsubEvents();
  };
}
