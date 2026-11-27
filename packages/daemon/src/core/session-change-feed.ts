import { randomUUID } from 'node:crypto';
import {
  PluginApiError,
  SESSION_DATA_CONTRACT,
  sessionDataStreamKey,
  type SessionCanonicalEventDto,
  type SessionDataChannelEvent,
  type SessionDataCursor,
  type SessionDataStreamIdentity,
} from '@harnessmate/plugin-api';
import type {
  CommittedChangeRawRow,
  HarnessMateStore,
  SessionChangeKind,
  SnapshotTurnItemRow,
} from '../db/sqlite.js';
import type { PluginHost } from '../plugin-host/runtime/lifecycle.js';

export type SearchSnapshotItem = SnapshotTurnItemRow;

export interface ReadSearchSnapshotRequest {
  snapshotId?: string;
  cursor?: string | null;
  limit?: number;
  workspaceId?: string;
}

export interface ReadSearchSnapshotResponse {
  snapshotId: string;
  watermarkSeq: number;
  items: SearchSnapshotItem[];
  nextCursor: string | null;
}

export interface CommittedSessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  harnessId: string;
  harnessKind: string;
  status: string;
  updatedAt: number;
}

export interface CommittedSessionChange {
  changeSeq: number;
  kind: SessionChangeKind;
  sessionId: string;
  workspaceId: string;
  itemId: string | null;
  committedAt: number;
  item?: SearchSnapshotItem | null;
  session?: CommittedSessionSummary | null;
}

export interface ReadCommittedChangesRequest {
  afterSeq?: number;
  limit?: number;
  workspaceId?: string;
}

export interface ReadCommittedChangesResponse {
  changes: CommittedSessionChange[];
  latestSeq: number;
  hasMore: boolean;
}

interface SnapshotEntry {
  watermarkSeq: number;
  workspaceId?: string;
  items: SearchSnapshotItem[];
  expiresAt: number;
}

const SNAPSHOT_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_SNAPSHOTS = 16;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function normalizeLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

function isSecretRawItem(blockType: string | null, payloadJson: string | null): boolean {
  if (blockType === 'secret_request') return true;
  if (blockType !== 'runtime_request' || !payloadJson) return false;
  try {
    const parsed = JSON.parse(payloadJson) as { kind?: unknown };
    return parsed?.kind === 'secret_request';
  } catch {
    return false;
  }
}

function mapChangeRow(row: CommittedChangeRawRow): CommittedSessionChange {
  const base: CommittedSessionChange = {
    changeSeq: row.changeSeq,
    kind: row.kind,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    itemId: row.itemId,
    committedAt: row.committedAt,
  };

  if (row.kind === 'upsert_item') {
    if (
      row.itemId &&
      row.textBody &&
      row.textBody.trim() &&
      row.sessionTitle !== null &&
      row.driverId !== null &&
      row.blockType !== null &&
      !isSecretRawItem(row.blockType, row.itemPayloadJson)
    ) {
      base.item = {
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle,
        workspaceId: row.workspaceId,
        itemId: row.itemId,
        turnId: row.turnId ?? '',
        turnSeq: row.turnSeq ?? 0,
        driverId: row.driverId,
        blockType: row.blockType,
        textBody: row.textBody,
        createdAt: row.itemCreatedAt ?? row.committedAt,
        updatedAt: row.itemUpdatedAt ?? row.committedAt,
      };
    } else {
      base.item = null;
    }
  } else if (row.kind === 'upsert_session') {
    if (
      row.sessionTitle !== null &&
      row.harnessId !== null &&
      row.harnessKind !== null &&
      row.sessionStatus !== null
    ) {
      base.session = {
        id: row.sessionId,
        workspaceId: row.workspaceId,
        title: row.sessionTitle,
        harnessId: row.harnessId,
        harnessKind: row.harnessKind,
        status: row.sessionStatus,
        updatedAt: row.sessionUpdatedAt ?? row.committedAt,
      };
    } else {
      base.session = null;
    }
  }

  return base;
}

/**
 * Provides consistent paginated search snapshots and monotonically ordered committed change cursors
 * backed by SQLite `session_change_log` without mutating or coupling to search plugin state.
 */
export class SessionChangeFeedService {
  private readonly snapshots = new Map<string, SnapshotEntry>();
  private readonly streamCursors = new Map<string, SessionDataCursor>();
  private readonly channelListeners = new Set<(latestSeq: number, event?: SessionDataChannelEvent) => void>();
  private hostChannelUnsub?: () => void;

  constructor(private readonly store: HarnessMateStore) {}

  attachPluginHost(host: PluginHost): () => void {
    this.hostChannelUnsub?.();
    const unsub = host.subscribeServiceChannel(SESSION_DATA_CONTRACT, (rawEvent) => {
      const ev = rawEvent.payload as unknown as SessionDataChannelEvent | undefined;
      if (!ev || !ev.stream) return;
      const key = sessionDataStreamKey(ev.stream);
      const prev = this.streamCursors.get(key);
      const nextSeq = Math.max(prev?.seq ?? 0, typeof ev.changeSeq === 'number' ? ev.changeSeq : 0);
      this.streamCursors.set(key, {
        providerInstanceId: ev.stream.providerInstanceId,
        streamId: ev.stream.streamId,
        seq: nextSeq,
      });
      for (const listener of [...this.channelListeners]) {
        try {
          listener(nextSeq, ev);
        } catch {
          // Isolate subscriber errors from committed channel notifications
        }
      }
    });
    this.hostChannelUnsub = unsub;
    return unsub;
  }

  getStreamCursors(): SessionDataCursor[] {
    return [...this.streamCursors.values()];
  }

  getStreamCursor(stream: SessionDataStreamIdentity): SessionDataCursor | undefined {
    return this.streamCursors.get(sessionDataStreamKey(stream));
  }

  onCommitted(listener: (latestSeq: number, event?: SessionDataChannelEvent) => void): () => void {
    this.channelListeners.add(listener);
    const storeUnsub = this.store.onSessionChangeCommitted((seq) => {
      try {
        listener(seq);
      } catch {
        // Isolate subscriber errors
      }
    });
    return () => {
      this.channelListeners.delete(listener);
      storeUnsub();
    };
  }

  getLatestSeq(): number {
    return this.store.getLatestSessionChangeSeq();
  }

  readSearchSnapshot(req: ReadSearchSnapshotRequest = {}): ReadSearchSnapshotResponse {
    this.pruneExpiredSnapshots();
    const limit = normalizeLimit(req.limit);

    let snapshotId = req.snapshotId?.trim() || undefined;
    let entry: SnapshotEntry | undefined;

    if (snapshotId) {
      entry = this.snapshots.get(snapshotId);
      if (!entry || entry.expiresAt <= Date.now()) {
        this.snapshots.delete(snapshotId);
        throw new PluginApiError('E_INVALID_INPUT', `搜索快照 ${snapshotId} 不存在或已过期`);
      }
      entry.expiresAt = Date.now() + SNAPSHOT_TTL_MS;
    } else {
      const captured = this.store.listSnapshotTurnItems(req.workspaceId);
      snapshotId = `snap_${randomUUID()}`;
      entry = {
        watermarkSeq: captured.watermarkSeq,
        workspaceId: req.workspaceId,
        items: captured.items,
        expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      };
      this.snapshots.set(snapshotId, entry);
      if (this.snapshots.size > MAX_ACTIVE_SNAPSHOTS) {
        const oldestKey = this.snapshots.keys().next().value;
        if (oldestKey) this.snapshots.delete(oldestKey);
      }
    }

    const offset = req.cursor ? Number.parseInt(req.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new PluginApiError('E_INVALID_INPUT', '无效的快照分页游标 cursor');
    }

    const items = entry.items.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < entry.items.length ? String(nextOffset) : null;

    return {
      snapshotId,
      watermarkSeq: entry.watermarkSeq,
      items,
      nextCursor,
    };
  }

  readCommittedChanges(req: ReadCommittedChangesRequest = {}): ReadCommittedChangesResponse {
    const afterSeq =
      typeof req.afterSeq === 'number' && Number.isFinite(req.afterSeq)
        ? Math.max(0, Math.floor(req.afterSeq))
        : 0;
    const limit = normalizeLimit(req.limit);

    const { latestSeq, rows, hasMore } = this.store.listCommittedSessionChanges({
      afterSeq,
      limit,
      workspaceId: req.workspaceId,
    });

    return {
      changes: rows.map(mapChangeRow),
      latestSeq,
      hasMore,
    };
  }

  private pruneExpiredSnapshots(): void {
    const now = Date.now();
    for (const [id, entry] of this.snapshots) {
      if (entry.expiresAt <= now) {
        this.snapshots.delete(id);
      }
    }
  }
}
