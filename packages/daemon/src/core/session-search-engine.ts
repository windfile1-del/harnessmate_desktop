import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionSearchHit, SessionSearchResponse } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';

export const SESSION_SEARCH_CONTRACT = 'session.search.v1';
export const SESSION_SEARCH_CONTRACT_VERSION = '1.0.0';

export interface SearchableSessionItem {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  turnId: string;
  turnSeq: number;
  itemId: string;
  blockType: string;
  driverId: string;
  harnessId?: string;
  textBody: string;
  createdAt: number;
  updatedAt: number;
  payload?: Record<string, unknown>;
}

export interface CommittedSessionMeta {
  id: string;
  workspaceId: string;
  title: string;
  harnessId: string;
  harnessKind: string;
  status?: string;
  updatedAt: number;
}

export type SessionSearchChange =
  | {
      changeSeq: number;
      kind: 'upsert_item';
      sessionId?: string;
      workspaceId?: string;
      itemId?: string | null;
      item?: SearchableSessionItem | null;
      committedAt: number;
    }
  | {
      changeSeq: number;
      kind: 'upsert_session';
      sessionId: string;
      workspaceId?: string;
      itemId?: string | null;
      session?: CommittedSessionMeta | null;
      sessionTitle?: string;
      driverId?: string;
      harnessId?: string;
      updatedAt?: number;
      committedAt: number;
    }
  | {
      changeSeq: number;
      kind: 'delete_session';
      sessionId: string;
      workspaceId?: string;
      itemId?: string | null;
      committedAt: number;
    }
  | {
      changeSeq: number;
      kind: 'delete_item';
      sessionId: string;
      workspaceId?: string;
      itemId: string;
      committedAt: number;
    };

export interface SessionSearchSnapshotPage {
  snapshotId: string;
  watermarkSeq: number;
  items: SearchableSessionItem[];
  nextCursor: string | null;
}

export interface SessionSearchCommittedChangesPage {
  changes: SessionSearchChange[];
  latestSeq: number;
  hasMore: boolean;
}

/**
 * Read-only committed session change & consistent snapshot interface consumed by B1-04 search engines.
 * B1-03's session data layer is the sole writer of session facts; search projections read committed
 * snapshots and sequential change logs through this contract.
 */
export interface SessionSearchReadModel {
  readSearchSnapshot(opts?: {
    snapshotId?: string;
    cursor?: string | null;
    limit?: number;
    workspaceId?: string;
  }): Promise<SessionSearchSnapshotPage> | SessionSearchSnapshotPage;

  readCommittedChanges(opts: {
    afterSeq: number;
    limit?: number;
    workspaceId?: string;
  }): Promise<SessionSearchCommittedChangesPage> | SessionSearchCommittedChangesPage;

  getLatestCommittedSeq?(): Promise<number> | number;
  subscribe?(listener: (latestSeq: number) => void): () => void;
}

export interface SessionSearchQueryRequest {
  q: string;
  workspaceId?: string;
  driverId?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
  offset?: number;
  forceLikeFallback?: boolean;
}

export interface SessionSearchQueryResult extends SessionSearchResponse {
  nextOffset: number | null;
}

export type ReindexJobState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface ReindexJobStatus {
  jobId: string;
  mode: 'full' | 'incremental' | 'resume';
  status: ReindexJobState;
  indexedCount: number;
  deletedCount: number;
  totalEstimate?: number;
  cursorSeq: number;
  snapshotId?: string | null;
  snapshotWatermark?: number | null;
  snapshotCursor?: string | null;
  resumeAvailable: boolean;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  error?: string | null;
}

export interface SearchEngineStatus {
  instanceId: string;
  engineKind: 'fts5' | 'lite';
  state: 'idle' | 'syncing' | 'reindexing' | 'paused' | 'error' | 'disposed';
  cursorSeq: number;
  latestSourceSeq: number | null;
  indexedItems: number;
  indexedSessions: number;
  activeJob: ReindexJobStatus | null;
  lastJob: ReindexJobStatus | null;
  resumeAvailable: boolean;
  lastError: string | null;
}

export type SearchContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/**
 * Normalizes and escapes arbitrary user search input for SQLite FTS5 MATCH queries.
 */
export function buildSafeFts5Query(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const tokens = trimmed
    .replace(/["*^():+~]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^-+/, '').trim())
    .filter((tok) => tok.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((tok) => `"${tok.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Extracts normalized search terms sorted longest-first for snippet windowing & highlighting.
 */
export function extractSearchTerms(raw: string): string[] {
  const stripped = raw
    .replace(/["*^():+~]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^-+/, '').trim())
    .filter((tok) => tok.length > 0);
  const unique = [...new Set(stripped.length > 0 ? stripped : [raw.trim()].filter(Boolean))];
  return unique.sort((a, b) => b.length - a.length);
}

export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds an XSS-safe snippet with `<mark>` tags and character highlight offsets.
 */
export function buildSafeHighlightedSnippet(
  body: string,
  terms: string[],
  windowChars = 160,
): { text: string; htmlSafe: string; highlights: Array<{ start: number; end: number }> } {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized) return { text: '', htmlSafe: '', highlights: [] };

  const lower = normalized.toLowerCase();
  let firstMatch = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (firstMatch < 0 || idx < firstMatch)) {
      firstMatch = idx;
    }
  }

  let start = 0;
  let end = Math.min(normalized.length, windowChars);
  if (firstMatch > 40) {
    start = Math.max(0, firstMatch - 40);
    end = Math.min(normalized.length, start + windowChars);
  }
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';
  const snippetText = `${prefix}${normalized.slice(start, end)}${suffix}`;

  const lowerSnippet = snippetText.toLowerCase();
  const spans: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let pos = 0;
    while (pos < lowerSnippet.length) {
      const idx = lowerSnippet.indexOf(needle, pos);
      if (idx < 0) break;
      const spanEnd = idx + needle.length;
      const overlaps = spans.some((s) => !(spanEnd <= s.start || idx >= s.end));
      if (!overlaps) {
        spans.push({ start: idx, end: spanEnd });
      }
      pos = spanEnd;
    }
  }
  spans.sort((a, b) => a.start - b.start);

  let cursor = 0;
  let html = '';
  for (const span of spans) {
    if (span.start > cursor) {
      html += escapeHtml(snippetText.slice(cursor, span.start));
    }
    html += `<mark>${escapeHtml(snippetText.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
  }
  if (cursor < snippetText.length) {
    html += escapeHtml(snippetText.slice(cursor));
  }
  return { text: snippetText, htmlSafe: html, highlights: spans };
}

export function isSearchableItem(item: {
  blockType?: string;
  textBody?: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (!item.textBody || !item.textBody.trim()) return false;
  if (item.blockType === 'secret_request') return false;
  if (item.blockType === 'runtime_request' && item.payload?.kind === 'secret_request') {
    return false;
  }
  return true;
}

export function sanitizeInstanceFileName(instanceId: string): string {
  return instanceId.replace(/[^a-z0-9._-]/gi, '_') || 'default';
}

/**
 * In-memory committed-change & consistent-snapshot fixture implementing `SessionSearchReadModel`.
 * Used for deterministic projection verification, concurrent-write during reindex, pause/resume,
 * delete replay, and crash recovery tests before/alongside B1-03's read model.
 */
export class FixtureSessionSearchReadModel implements SessionSearchReadModel {
  private seq = 0;
  private readonly sessions = new Map<
    string,
    { id: string; title: string; workspaceId: string; driverId: string; harnessId: string; updatedAt: number }
  >();
  private readonly items = new Map<string, SearchableSessionItem>();
  private readonly changelog: SessionSearchChange[] = [];
  private readonly snapshots = new Map<
    string,
    { watermarkSeq: number; items: SearchableSessionItem[]; workspaceId?: string }
  >();
  private readonly listeners = new Set<(latestSeq: number) => void>();

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.seq);
      } catch {
        // isolate listener error
      }
    }
  }

  commitSession(session: {
    id: string;
    title: string;
    workspaceId: string;
    driverId: string;
    harnessId?: string;
    updatedAt?: number;
  }): number {
    const now = session.updatedAt ?? Date.now();
    const record = {
      id: session.id,
      title: session.title,
      workspaceId: session.workspaceId,
      driverId: session.driverId,
      harnessId: session.harnessId ?? session.driverId,
      updatedAt: now,
    };
    this.sessions.set(session.id, record);
    for (const [itemId, item] of this.items) {
      if (item.sessionId === session.id) {
        this.items.set(itemId, { ...item, sessionTitle: record.title, updatedAt: now });
      }
    }
    this.seq += 1;
    this.changelog.push({
      changeSeq: this.seq,
      kind: 'upsert_session',
      sessionId: record.id,
      sessionTitle: record.title,
      workspaceId: record.workspaceId,
      driverId: record.driverId,
      harnessId: record.harnessId,
      updatedAt: now,
      committedAt: Date.now(),
    });
    this.notify();
    return this.seq;
  }

  commitItem(input: {
    sessionId: string;
    itemId: string;
    turnId: string;
    turnSeq: number;
    driverId?: string;
    harnessId?: string;
    blockType?: string;
    textBody: string;
    createdAt?: number;
    updatedAt?: number;
    payload?: Record<string, unknown>;
  }): number {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error(`Session not found in FixtureSessionSearchReadModel: ${input.sessionId}`);
    }
    const createdAt = input.createdAt ?? Date.now();
    const updatedAt = input.updatedAt ?? createdAt;
    const item: SearchableSessionItem = {
      sessionId: session.id,
      sessionTitle: session.title,
      workspaceId: session.workspaceId,
      turnId: input.turnId,
      turnSeq: input.turnSeq,
      itemId: input.itemId,
      blockType: input.blockType ?? 'assistant_text',
      driverId: input.driverId ?? session.driverId,
      harnessId: input.harnessId ?? session.harnessId,
      textBody: input.textBody,
      createdAt,
      updatedAt,
      ...(input.payload ? { payload: input.payload } : {}),
    };
    if (isSearchableItem(item)) {
      this.items.set(item.itemId, item);
    } else {
      this.items.delete(item.itemId);
    }
    this.seq += 1;
    this.changelog.push({
      changeSeq: this.seq,
      kind: 'upsert_item',
      item,
      committedAt: Date.now(),
    });
    this.notify();
    return this.seq;
  }

  deleteItem(sessionId: string, itemId: string): number {
    this.items.delete(itemId);
    this.seq += 1;
    this.changelog.push({
      changeSeq: this.seq,
      kind: 'delete_item',
      sessionId,
      itemId,
      committedAt: Date.now(),
    });
    this.notify();
    return this.seq;
  }

  deleteSession(sessionId: string): number {
    this.sessions.delete(sessionId);
    for (const [itemId, item] of this.items) {
      if (item.sessionId === sessionId) this.items.delete(itemId);
    }
    this.seq += 1;
    this.changelog.push({
      changeSeq: this.seq,
      kind: 'delete_session',
      sessionId,
      committedAt: Date.now(),
    });
    this.notify();
    return this.seq;
  }

  getLatestCommittedSeq(): number {
    return this.seq;
  }

  subscribe(listener: (latestSeq: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  readSearchSnapshot(opts?: {
    snapshotId?: string;
    cursor?: string | null;
    limit?: number;
    workspaceId?: string;
  }): SessionSearchSnapshotPage {
    const limit = Math.max(1, Math.min(500, opts?.limit ?? 50));
    let snapshot = opts?.snapshotId ? this.snapshots.get(opts.snapshotId) : undefined;
    let snapshotId = opts?.snapshotId;

    if (!snapshot) {
      snapshotId = `snap_${crypto.randomBytes(6).toString('hex')}`;
      const frozenItems = [...this.items.values()]
        .filter((it) => (!opts?.workspaceId || it.workspaceId === opts.workspaceId) && isSearchableItem(it))
        .sort((a, b) => a.createdAt - b.createdAt || a.itemId.localeCompare(b.itemId))
        .map((it) => ({ ...it }));
      snapshot = {
        watermarkSeq: this.seq,
        items: frozenItems,
        workspaceId: opts?.workspaceId,
      };
      this.snapshots.set(snapshotId, snapshot);
    }

    const offset = opts?.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
    const pageItems = snapshot.items.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    const nextCursor = nextOffset < snapshot.items.length ? String(nextOffset) : null;
    if (!nextCursor && snapshotId) {
      this.snapshots.delete(snapshotId);
    }

    return {
      snapshotId: snapshotId!,
      watermarkSeq: snapshot.watermarkSeq,
      items: pageItems,
      nextCursor,
    };
  }

  readCommittedChanges(opts: {
    afterSeq: number;
    limit?: number;
    workspaceId?: string;
  }): SessionSearchCommittedChangesPage {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const afterSeq = Math.max(0, opts.afterSeq);
    const matching: SessionSearchChange[] = [];
    for (const change of this.changelog) {
      if (change.changeSeq <= afterSeq) continue;
      if (opts.workspaceId) {
        if (change.kind === 'upsert_item' && (change.item?.workspaceId ?? change.workspaceId) !== opts.workspaceId) continue;
        if (change.kind === 'upsert_session' && (change.session?.workspaceId ?? change.workspaceId) !== opts.workspaceId) continue;
      }
      matching.push(change);
    }
    const sliced = matching.slice(0, limit);
    return {
      changes: sliced,
      latestSeq: this.seq,
      hasMore: matching.length > sliced.length,
    };
  }
}

type StoreWithCommittedFeed = HarnessMateStore & Partial<SessionSearchReadModel>;

/**
 * Adapts `HarnessMateStore` to `SessionSearchReadModel`.
 * When B1-03 exposes `readSearchSnapshot` and `readCommittedChanges` on `HarnessMateStore`,
 * this adapter delegates directly to B1-03's committed change log; otherwise it derives a
 * consistent snapshot from `sessions` and `session_turn_items`.
 */
export class StoreSessionSearchReadModel implements SessionSearchReadModel {
  private readonly snapshots = new Map<
    string,
    { watermarkSeq: number; items: SearchableSessionItem[] }
  >();

  constructor(private readonly store: HarnessMateStore) {}

  private get nativeFeed(): StoreWithCommittedFeed {
    return this.store as StoreWithCommittedFeed;
  }

  getLatestCommittedSeq(): number {
    if (typeof this.nativeFeed.getLatestCommittedSeq === 'function') {
      return Number(this.nativeFeed.getLatestCommittedSeq());
    }
    const sessions = this.store.listSessions({});
    let maxTs = 0;
    for (const s of sessions) {
      if (s.updatedAt > maxTs) maxTs = s.updatedAt;
    }
    return maxTs;
  }

  subscribe(listener: (latestSeq: number) => void): () => void {
    if (typeof this.nativeFeed.subscribe === 'function') {
      return this.nativeFeed.subscribe(listener);
    }
    return () => {};
  }

  readSearchSnapshot(opts?: {
    snapshotId?: string;
    cursor?: string | null;
    limit?: number;
    workspaceId?: string;
  }): SessionSearchSnapshotPage {
    if (typeof this.nativeFeed.readSearchSnapshot === 'function') {
      return this.nativeFeed.readSearchSnapshot(opts) as SessionSearchSnapshotPage;
    }

    const limit = Math.max(1, Math.min(500, opts?.limit ?? 50));
    let snapshot = opts?.snapshotId ? this.snapshots.get(opts.snapshotId) : undefined;
    let snapshotId = opts?.snapshotId;

    if (!snapshot) {
      snapshotId = `snap_${crypto.randomBytes(6).toString('hex')}`;
      const sessions = this.store
        .listSessions(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {})
        .sort((a, b) => a.id.localeCompare(b.id));
      const allItems: SearchableSessionItem[] = [];
      let watermarkSeq = 0;
      for (const session of sessions) {
        if (session.updatedAt > watermarkSeq) watermarkSeq = session.updatedAt;
        const items = this.store.listTurnItems(session.id, { limit: 10_000 });
        for (const item of items) {
          if (item.updatedAt > watermarkSeq) watermarkSeq = item.updatedAt;
          if (!isSearchableItem(item)) continue;
          allItems.push({
            sessionId: session.id,
            sessionTitle: session.title,
            workspaceId: session.workspaceId,
            turnId: item.turnId ?? '',
            turnSeq: item.seq,
            itemId: item.itemId,
            blockType: item.blockType,
            driverId: item.driverId,
            harnessId: session.harnessId,
            textBody: item.textBody,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            payload: item.payload,
          });
        }
      }
      snapshot = { watermarkSeq, items: allItems };
      this.snapshots.set(snapshotId, snapshot);
    }

    const offset = opts?.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
    const pageItems = snapshot.items.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    const nextCursor = nextOffset < snapshot.items.length ? String(nextOffset) : null;
    if (!nextCursor && snapshotId) {
      this.snapshots.delete(snapshotId);
    }

    return {
      snapshotId: snapshotId!,
      watermarkSeq: snapshot.watermarkSeq,
      items: pageItems,
      nextCursor,
    };
  }

  readCommittedChanges(opts: {
    afterSeq: number;
    limit?: number;
    workspaceId?: string;
  }): SessionSearchCommittedChangesPage {
    if (typeof this.nativeFeed.readCommittedChanges === 'function') {
      return this.nativeFeed.readCommittedChanges(opts) as SessionSearchCommittedChangesPage;
    }
    const sessions = this.store.listSessions(opts.workspaceId ? { workspaceId: opts.workspaceId } : {});
    const changes: SessionSearchChange[] = [];
    let latestSeq = opts.afterSeq;
    for (const session of sessions) {
      if (session.updatedAt > latestSeq) latestSeq = session.updatedAt;
      const items = this.store.listTurnItems(session.id, { limit: 10_000 });
      for (const item of items) {
        if (item.updatedAt > latestSeq) latestSeq = item.updatedAt;
        if (item.updatedAt > opts.afterSeq && isSearchableItem(item)) {
          changes.push({
            changeSeq: item.updatedAt,
            kind: 'upsert_item',
            item: {
              sessionId: session.id,
              sessionTitle: session.title,
              workspaceId: session.workspaceId,
              turnId: item.turnId ?? '',
              turnSeq: item.seq,
              itemId: item.itemId,
              blockType: item.blockType,
              driverId: item.driverId,
              harnessId: session.harnessId,
              textBody: item.textBody,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              payload: item.payload,
            },
            committedAt: item.updatedAt,
          });
        }
      }
    }
    changes.sort((a, b) => a.changeSeq - b.changeSeq);
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const sliced = changes.slice(0, limit);
    return {
      changes: sliced,
      latestSeq,
      hasMore: changes.length > sliced.length,
    };
  }
}

export interface SessionSearchEngineOptions {
  instanceId: string;
  dbPath: string;
  readModel: SessionSearchReadModel;
  batchSize?: number;
  yieldBetweenBatches?: boolean;
  onJobProgress?: (status: SearchEngineStatus) => void;
}

interface SyncStateRow {
  cursor_seq: number;
  snapshot_id: string | null;
  snapshot_watermark: number | null;
  snapshot_cursor: string | null;
  reindex_state: string;
  job_json: string | null;
  updated_at: number;
}

/**
 * Per-instance FTS5 search index & projection engine.
 * Each instance owns its own SQLite database file, sync watermark, and reindex job state.
 * Index updates and watermark commits execute atomically inside SQLite transactions.
 */
export class SessionSearchEngineInstance {
  readonly instanceId: string;
  readonly dbPath: string;
  private readonly readModel: SessionSearchReadModel;
  private readonly batchSize: number;
  private readonly yieldBetweenBatches: boolean;
  private readonly onJobProgress?: (status: SearchEngineStatus) => void;
  private db: DatabaseSync | null = null;
  private unsubscribeReadModel: (() => void) | null = null;
  private generation = 0;
  private paused = false;
  private disposed = false;
  private lastError: string | null = null;
  private activeReindexPromise: Promise<ReindexJobStatus> | null = null;
  private cancelRequested = false;

  constructor(opts: SessionSearchEngineOptions) {
    this.instanceId = opts.instanceId;
    this.dbPath = opts.dbPath;
    this.readModel = opts.readModel;
    this.batchSize = Math.max(1, Math.min(500, opts.batchSize ?? 20));
    this.yieldBetweenBatches = opts.yieldBetweenBatches ?? true;
    this.onJobProgress = opts.onJobProgress;
  }

  private ensureDb(): DatabaseSync {
    if (this.disposed) {
      throw new Error(`Search engine instance ${this.instanceId} has been disposed`);
    }
    if (this.db) return this.db;
    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    const db = new DatabaseSync(this.dbPath);
    if (this.dbPath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_items (
        item_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_title TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_seq INTEGER NOT NULL,
        driver_id TEXT NOT NULL,
        harness_id TEXT NOT NULL DEFAULT '',
        block_type TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_search_items_session ON search_items(session_id);
      CREATE INDEX IF NOT EXISTS idx_search_items_ws_created ON search_items(workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS search_sessions_meta (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        harness_id TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        session_id UNINDEXED,
        item_id UNINDEXED,
        turn_id UNINDEXED,
        driver_id UNINDEXED,
        title,
        body
      );

      CREATE TABLE IF NOT EXISTS search_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cursor_seq INTEGER NOT NULL DEFAULT 0,
        snapshot_id TEXT,
        snapshot_watermark INTEGER,
        snapshot_cursor TEXT,
        reindex_state TEXT NOT NULL DEFAULT 'idle',
        job_json TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT OR IGNORE INTO search_sync_state (id, cursor_seq, reindex_state, updated_at)
       VALUES (1, 0, 'idle', ?)`,
    ).run(Date.now());
    this.db = db;
    return db;
  }

  async start(): Promise<void> {
    this.disposed = false;
    this.paused = false;
    this.generation += 1;
    const db = this.ensureDb();

    // Mark any leftover 'running' job from an unexpected crash as interrupted/cancelled so resume is explicit & safe
    const row = this.readSyncStateRow(db);
    if (row.job_json) {
      const prevJob = this.parseJobJson(row.job_json);
      if (prevJob && (prevJob.status === 'running' || prevJob.status === 'queued')) {
        const interrupted: ReindexJobStatus = {
          ...prevJob,
          status: 'cancelled',
          resumeAvailable: Boolean(row.snapshot_id || row.snapshot_cursor !== null || row.snapshot_watermark !== null),
          updatedAt: Date.now(),
          error: prevJob.error ?? '进程中断，支持断点续跑',
        };
        db.prepare(
          `UPDATE search_sync_state
           SET reindex_state = 'cancelled', job_json = ?, updated_at = ?
           WHERE id = 1`,
        ).run(JSON.stringify(interrupted), Date.now());
      }
    }

    if (this.readModel.subscribe && !this.unsubscribeReadModel) {
      const startGen = this.generation;
      this.unsubscribeReadModel = this.readModel.subscribe(() => {
        if (this.disposed || this.paused || this.generation !== startGen) return;
        void this.syncIncremental().catch(() => {});
      });
    }

    // Catch up committed changes produced while offline/paused
    if (this.readSyncStateRow(db).cursor_seq > 0) {
      await this.syncIncremental();
    }
  }

  /**
   * Pauses incremental sync and cancels any active background task without closing the index DB.
   */
  async pause(): Promise<void> {
    this.paused = true;
    this.generation += 1;
    this.cancelRequested = true;
    if (this.unsubscribeReadModel) {
      this.unsubscribeReadModel();
      this.unsubscribeReadModel = null;
    }
    if (this.activeReindexPromise) {
      await this.activeReindexPromise.catch(() => {});
    }
  }

  /**
   * Resumes a paused engine instance and catches up all committed changes accumulated while paused.
   */
  async resume(): Promise<{ appliedChanges: number; cursorSeq: number }> {
    this.paused = false;
    this.cancelRequested = false;
    this.generation += 1;
    this.ensureDb();
    if (this.readModel.subscribe && !this.unsubscribeReadModel) {
      const gen = this.generation;
      this.unsubscribeReadModel = this.readModel.subscribe(() => {
        if (this.disposed || this.paused || this.generation !== gen) return;
        void this.syncIncremental().catch(() => {});
      });
    }
    return this.syncIncremental();
  }

  /**
   * Simulates an abrupt crash/dispose without normal cancellation cleanup so recovery tests can verify
   * persisted SQLite index & cursor state on restart.
   */
  simulateCrash(): void {
    this.generation += 1;
    this.disposed = true;
    if (this.unsubscribeReadModel) {
      this.unsubscribeReadModel();
      this.unsubscribeReadModel = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close error on simulated crash
      }
      this.db = null;
    }
    this.activeReindexPromise = null;
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.cancelRequested = true;
    this.paused = true;
    if (this.unsubscribeReadModel) {
      this.unsubscribeReadModel();
      this.unsubscribeReadModel = null;
    }
    if (this.activeReindexPromise) {
      await this.activeReindexPromise.catch(() => {});
    }
    this.disposed = true;
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }
  }

  private readSyncStateRow(db = this.ensureDb()): SyncStateRow {
    return db
      .prepare(
        `SELECT cursor_seq, snapshot_id, snapshot_watermark, snapshot_cursor, reindex_state, job_json, updated_at
         FROM search_sync_state WHERE id = 1`,
      )
      .get() as unknown as SyncStateRow;
  }

  private parseJobJson(raw: string | null): ReindexJobStatus | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReindexJobStatus;
    } catch {
      return null;
    }
  }

  private upsertItemInTx(db: DatabaseSync, item: SearchableSessionItem): boolean {
    db.prepare(
      `INSERT OR REPLACE INTO search_sessions_meta (session_id, title, workspace_id, driver_id, harness_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      item.sessionId,
      item.sessionTitle,
      item.workspaceId,
      item.driverId,
      item.harnessId ?? item.driverId,
      item.updatedAt,
    );

    if (!isSearchableItem(item)) {
      db.prepare('DELETE FROM search_items WHERE item_id = ?').run(item.itemId);
      db.prepare('DELETE FROM search_fts WHERE item_id = ?').run(item.itemId);
      return false;
    }

    db.prepare(
      `INSERT OR REPLACE INTO search_items
       (item_id, session_id, session_title, workspace_id, turn_id, turn_seq, driver_id, harness_id, block_type, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.itemId,
      item.sessionId,
      item.sessionTitle,
      item.workspaceId,
      item.turnId,
      item.turnSeq,
      item.driverId,
      item.harnessId ?? item.driverId,
      item.blockType,
      item.textBody,
      item.createdAt,
      item.updatedAt,
    );

    db.prepare('DELETE FROM search_fts WHERE item_id = ?').run(item.itemId);
    db.prepare(
      `INSERT INTO search_fts (session_id, item_id, turn_id, driver_id, title, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(item.sessionId, item.itemId, item.turnId, item.driverId, item.sessionTitle, item.textBody);
    return true;
  }

  private updateSessionInTx(
    db: DatabaseSync,
    change: Extract<SessionSearchChange, { kind: 'upsert_session' }>,
  ): void {
    const title = change.session?.title ?? change.sessionTitle ?? '';
    const workspaceId = change.session?.workspaceId ?? change.workspaceId ?? '';
    const driverId = change.session?.harnessKind ?? change.driverId ?? 'unknown';
    const harnessId = change.session?.harnessId ?? change.harnessId ?? driverId;
    const updatedAt = change.session?.updatedAt ?? change.updatedAt ?? change.committedAt ?? Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO search_sessions_meta (session_id, title, workspace_id, driver_id, harness_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      change.sessionId,
      title,
      workspaceId,
      driverId,
      harnessId,
      updatedAt,
    );
    db.prepare(
      `UPDATE search_items SET session_title = ?, workspace_id = ?, updated_at = MAX(updated_at, ?) WHERE session_id = ?`,
    ).run(title, workspaceId, updatedAt, change.sessionId);
    db.prepare('UPDATE search_fts SET title = ? WHERE session_id = ?').run(
      title,
      change.sessionId,
    );
  }

  private deleteSessionInTx(db: DatabaseSync, sessionId: string): number {
    db.prepare('DELETE FROM search_sessions_meta WHERE session_id = ?').run(sessionId);
    const res = db.prepare('DELETE FROM search_items WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM search_fts WHERE session_id = ?').run(sessionId);
    return Number(res.changes ?? 0);
  }

  private deleteItemInTx(db: DatabaseSync, itemId: string): number {
    const res = db.prepare('DELETE FROM search_items WHERE item_id = ?').run(itemId);
    db.prepare('DELETE FROM search_fts WHERE item_id = ?').run(itemId);
    return Number(res.changes ?? 0);
  }

  /**
   * Synchronizes committed changes strictly after the persisted `cursor_seq`.
   * Each batch commits indexed projections and the new `cursor_seq` atomically in one SQLite transaction.
   */
  async syncIncremental(): Promise<{ appliedChanges: number; cursorSeq: number }> {
    if (this.disposed || this.paused) {
      const state = this.readSyncStateRow();
      return { appliedChanges: 0, cursorSeq: state.cursor_seq };
    }
    const db = this.ensureDb();
    const startGen = this.generation;
    let totalApplied = 0;

    while (!this.disposed && !this.paused && this.generation === startGen) {
      const state = this.readSyncStateRow(db);
      const page = await this.readModel.readCommittedChanges({
        afterSeq: state.cursor_seq,
        limit: this.batchSize,
      });
      if (this.disposed || this.paused || this.generation !== startGen) break;
      if (page.changes.length === 0) {
        if (page.latestSeq > state.cursor_seq) {
          db.prepare('UPDATE search_sync_state SET cursor_seq = ?, updated_at = ? WHERE id = 1').run(
            page.latestSeq,
            Date.now(),
          );
        }
        break;
      }

      const maxBatchSeq = page.changes[page.changes.length - 1]!.changeSeq;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const change of page.changes) {
          if (change.kind === 'upsert_item' && change.item) {
            this.upsertItemInTx(db, change.item);
          } else if (change.kind === 'upsert_session') {
            this.updateSessionInTx(db, change);
          } else if (change.kind === 'delete_session') {
            this.deleteSessionInTx(db, change.sessionId);
          } else if (change.kind === 'delete_item' && change.itemId) {
            this.deleteItemInTx(db, change.itemId);
          }
          totalApplied += 1;
        }
        const nextCursorSeq = Math.max(state.cursor_seq, maxBatchSeq);
        db.prepare('UPDATE search_sync_state SET cursor_seq = ?, updated_at = ? WHERE id = 1').run(
          nextCursorSeq,
          Date.now(),
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }

      if (!page.hasMore) break;
      if (this.yieldBetweenBatches) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    return {
      appliedChanges: totalApplied,
      cursorSeq: this.readSyncStateRow(db).cursor_seq,
    };
  }

  /**
   * Starts a full snapshot rebuild (or resumes an interrupted/cancelled rebuild).
   * After all snapshot pages are committed, seamlessly catches up committed changes after `watermarkSeq`.
   */
  async reindex(opts?: {
    mode?: 'full' | 'incremental' | 'resume';
    jobId?: string;
    workspaceId?: string;
    /** Test-only hook invoked after each committed snapshot page (e.g. to inject concurrent writes or cancel). */
    onBatchCommitted?: (job: ReindexJobStatus) => Promise<void> | void;
  }): Promise<ReindexJobStatus> {
    if (this.disposed) {
      throw new Error(`Search engine instance ${this.instanceId} has been disposed`);
    }
    if (this.activeReindexPromise) {
      return this.activeReindexPromise;
    }

    const mode = opts?.mode ?? 'full';
    if (mode === 'incremental') {
      const now = Date.now();
      const jobId = opts?.jobId ?? `reindex_${crypto.randomBytes(5).toString('hex')}`;
      const syncRes = await this.syncIncremental();
      const completed: ReindexJobStatus = {
        jobId,
        mode: 'incremental',
        status: 'completed',
        indexedCount: syncRes.appliedChanges,
        deletedCount: 0,
        cursorSeq: syncRes.cursorSeq,
        resumeAvailable: false,
        startedAt: now,
        updatedAt: Date.now(),
        finishedAt: Date.now(),
      };
      this.persistJob(completed, {
        snapshotId: null,
        snapshotWatermark: null,
        snapshotCursor: null,
        reindexState: 'idle',
      });
      return completed;
    }

    this.paused = false;
    this.cancelRequested = false;
    const runGen = this.generation;
    const db = this.ensureDb();

    const task = (async (): Promise<ReindexJobStatus> => {
      const stateRow = this.readSyncStateRow(db);
      const prevJob = this.parseJobJson(stateRow.job_json);
      const canResume =
        mode === 'resume' &&
        Boolean(stateRow.snapshot_id || stateRow.snapshot_cursor !== null || stateRow.snapshot_watermark !== null);

      const now = Date.now();
      let job: ReindexJobStatus = canResume && prevJob
        ? {
            ...prevJob,
            mode: 'resume',
            status: 'running',
            updatedAt: now,
            finishedAt: null,
            error: null,
          }
        : {
            jobId: opts?.jobId ?? `reindex_${crypto.randomBytes(5).toString('hex')}`,
            mode: 'full',
            status: 'running',
            indexedCount: 0,
            deletedCount: 0,
            cursorSeq: stateRow.cursor_seq,
            snapshotId: null,
            snapshotWatermark: null,
            snapshotCursor: null,
            resumeAvailable: false,
            startedAt: now,
            updatedAt: now,
            finishedAt: null,
            error: null,
          };

      if (!canResume) {
        // Fresh full rebuild: reset index tables atomically before reading snapshot page 1
        db.exec('BEGIN IMMEDIATE');
        try {
          if (opts?.workspaceId) {
            const existingIds = db
              .prepare('SELECT item_id FROM search_items WHERE workspace_id = ?')
              .all(opts.workspaceId) as unknown as Array<{ item_id: string }>;
            for (const row of existingIds) {
              db.prepare('DELETE FROM search_fts WHERE item_id = ?').run(row.item_id);
            }
            db.prepare('DELETE FROM search_items WHERE workspace_id = ?').run(opts.workspaceId);
          } else {
            db.exec('DELETE FROM search_items; DELETE FROM search_fts; DELETE FROM search_sessions_meta;');
          }
          db.prepare(
            `UPDATE search_sync_state
             SET snapshot_id = NULL, snapshot_watermark = NULL, snapshot_cursor = NULL,
                 reindex_state = 'running', job_json = ?, updated_at = ?
             WHERE id = 1`,
          ).run(JSON.stringify(job), now);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } else {
        this.persistJob(job, {
          snapshotId: stateRow.snapshot_id,
          snapshotWatermark: stateRow.snapshot_watermark,
          snapshotCursor: stateRow.snapshot_cursor,
          reindexState: 'running',
        });
      }

      this.emitProgress();

      let snapshotId = canResume ? (stateRow.snapshot_id ?? undefined) : undefined;
      let cursor = canResume ? stateRow.snapshot_cursor : null;
      let watermarkSeq = canResume ? stateRow.snapshot_watermark : null;

      try {
        while (true) {
          if (this.disposed || this.cancelRequested || this.generation !== runGen) {
            job = {
              ...job,
              status: 'cancelled',
              resumeAvailable: Boolean(snapshotId || cursor !== null || watermarkSeq !== null),
              updatedAt: Date.now(),
            };
            this.persistJob(job, {
              snapshotId: snapshotId ?? null,
              snapshotWatermark: watermarkSeq ?? null,
              snapshotCursor: cursor ?? null,
              reindexState: 'cancelled',
            });
            this.emitProgress();
            return job;
          }

          let page: SessionSearchSnapshotPage;
          try {
            page = await this.readModel.readSearchSnapshot({
              snapshotId,
              cursor,
              limit: this.batchSize,
              workspaceId: opts?.workspaceId,
            });
          } catch {
            // If snapshot expired across process restart, re-open a consistent snapshot from start;
            // upsertItemInTx is idempotent by item_id.
            page = await this.readModel.readSearchSnapshot({
              limit: this.batchSize,
              workspaceId: opts?.workspaceId,
            });
          }

          if (this.disposed || this.cancelRequested || this.generation !== runGen) {
            job = {
              ...job,
              status: 'cancelled',
              snapshotId: page.snapshotId,
              snapshotWatermark: page.watermarkSeq,
              snapshotCursor: cursor,
              resumeAvailable: true,
              updatedAt: Date.now(),
            };
            this.persistJob(job, {
              snapshotId: page.snapshotId,
              snapshotWatermark: page.watermarkSeq,
              snapshotCursor: cursor,
              reindexState: 'cancelled',
            });
            this.emitProgress();
            return job;
          }

          snapshotId = page.snapshotId;
          watermarkSeq = page.watermarkSeq;
          const nextCursor = page.nextCursor;

          db.exec('BEGIN IMMEDIATE');
          try {
            for (const item of page.items) {
              if (this.upsertItemInTx(db, item)) {
                job.indexedCount += 1;
              }
            }
            job.snapshotId = nextCursor ? snapshotId : null;
            job.snapshotWatermark = watermarkSeq;
            job.snapshotCursor = nextCursor;
            job.resumeAvailable = Boolean(nextCursor);
            job.updatedAt = Date.now();

            if (!nextCursor) {
              // Final snapshot page: atomically advance cursor_seq to snapshot watermark!
              const currentCursor = this.readSyncStateRow(db).cursor_seq;
              const nextCursorSeq = Math.max(currentCursor, watermarkSeq);
              job.cursorSeq = nextCursorSeq;
              db.prepare(
                `UPDATE search_sync_state
                 SET cursor_seq = ?, snapshot_id = NULL, snapshot_watermark = NULL,
                     snapshot_cursor = NULL, reindex_state = 'running', job_json = ?, updated_at = ?
                 WHERE id = 1`,
              ).run(nextCursorSeq, JSON.stringify(job), job.updatedAt);
            } else {
              db.prepare(
                `UPDATE search_sync_state
                 SET snapshot_id = ?, snapshot_watermark = ?, snapshot_cursor = ?,
                     reindex_state = 'running', job_json = ?, updated_at = ?
                 WHERE id = 1`,
              ).run(snapshotId, watermarkSeq, nextCursor, JSON.stringify(job), job.updatedAt);
            }
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }

          this.emitProgress();
          if (opts?.onBatchCommitted) {
            await opts.onBatchCommitted({ ...job });
          }

          if (!nextCursor) break;
          cursor = nextCursor;
          if (this.yieldBetweenBatches) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }

        // Catch up any committed writes that happened concurrently during the snapshot scan!
        const catchup = await this.syncIncremental();
        job = {
          ...job,
          status: 'completed',
          indexedCount: job.indexedCount + catchup.appliedChanges,
          cursorSeq: catchup.cursorSeq,
          snapshotId: null,
          snapshotCursor: null,
          resumeAvailable: false,
          updatedAt: Date.now(),
          finishedAt: Date.now(),
        };
        this.persistJob(job, {
          snapshotId: null,
          snapshotWatermark: null,
          snapshotCursor: null,
          reindexState: 'idle',
        });
        this.emitProgress();
        return job;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        job = {
          ...job,
          status: 'failed',
          error: message,
          updatedAt: Date.now(),
          finishedAt: Date.now(),
        };
        if (!this.disposed) {
          this.persistJob(job, {
            snapshotId: snapshotId ?? null,
            snapshotWatermark: watermarkSeq ?? null,
            snapshotCursor: cursor ?? null,
            reindexState: 'error',
          });
          this.emitProgress();
        }
        throw err;
      }
    })();

    const promise = task.finally(() => {
      if (this.activeReindexPromise === promise) {
        this.activeReindexPromise = null;
      }
    });
    this.activeReindexPromise = promise;
    return promise;
  }

  async cancelReindex(): Promise<{
    jobId: string | null;
    status: ReindexJobState | 'idle';
    cancelled: boolean;
    cursorSeq: number;
    resumeAvailable: boolean;
  }> {
    this.cancelRequested = true;
    if (this.activeReindexPromise) {
      const result = await this.activeReindexPromise;
      return {
        jobId: result.jobId,
        status: result.status,
        cancelled: result.status === 'cancelled',
        cursorSeq: result.cursorSeq,
        resumeAvailable: result.resumeAvailable,
      };
    }
    const row = this.readSyncStateRow();
    const prevJob = this.parseJobJson(row.job_json);
    return {
      jobId: prevJob?.jobId ?? null,
      status: prevJob?.status ?? 'idle',
      cancelled: false,
      cursorSeq: row.cursor_seq,
      resumeAvailable: Boolean(row.snapshot_id || row.snapshot_cursor !== null || row.snapshot_watermark !== null),
    };
  }

  async resumeReindex(): Promise<ReindexJobStatus> {
    return this.reindex({ mode: 'resume' });
  }

  private persistJob(
    job: ReindexJobStatus,
    state: {
      snapshotId: string | null;
      snapshotWatermark: number | null;
      snapshotCursor: string | null;
      reindexState: string;
    },
  ): void {
    if (this.disposed) return;
    const db = this.ensureDb();
    db.prepare(
      `UPDATE search_sync_state
       SET snapshot_id = ?, snapshot_watermark = ?, snapshot_cursor = ?,
           reindex_state = ?, job_json = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      state.snapshotId,
      state.snapshotWatermark,
      state.snapshotCursor,
      state.reindexState,
      JSON.stringify(job),
      Date.now(),
    );
  }

  private emitProgress(): void {
    if (this.onJobProgress && !this.disposed) {
      try {
        this.onJobProgress(this.getStatus());
      } catch {
        // ignore listener failure
      }
    }
  }

  getStatus(): SearchEngineStatus {
    if (this.disposed) {
      return {
        instanceId: this.instanceId,
        engineKind: 'fts5',
        state: 'disposed',
        cursorSeq: 0,
        latestSourceSeq: null,
        indexedItems: 0,
        indexedSessions: 0,
        activeJob: null,
        lastJob: null,
        resumeAvailable: false,
        lastError: this.lastError,
      };
    }
    const db = this.ensureDb();
    const row = this.readSyncStateRow(db);
    const job = this.parseJobJson(row.job_json);
    const itemCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM search_items').get() as unknown as { cnt: number };
    const sessCountRow = db
      .prepare('SELECT COUNT(DISTINCT session_id) AS cnt FROM search_items')
      .get() as unknown as { cnt: number };
    const latestSourceSeq = this.readModel.getLatestCommittedSeq
      ? Number(this.readModel.getLatestCommittedSeq())
      : null;

    const activeJob = job && (job.status === 'running' || job.status === 'queued') ? job : null;
    const state: SearchEngineStatus['state'] = this.paused
      ? 'paused'
      : activeJob
        ? 'reindexing'
        : this.lastError
          ? 'error'
          : 'idle';

    return {
      instanceId: this.instanceId,
      engineKind: 'fts5',
      state,
      cursorSeq: row.cursor_seq,
      latestSourceSeq: Number.isFinite(latestSourceSeq) ? latestSourceSeq : null,
      indexedItems: Number(itemCountRow?.cnt ?? 0),
      indexedSessions: Number(sessCountRow?.cnt ?? 0),
      activeJob,
      lastJob: job,
      resumeAvailable: Boolean(row.snapshot_id || row.snapshot_cursor !== null || row.snapshot_watermark !== null),
      lastError: this.lastError,
    };
  }

  /**
   * Queries this instance's isolated FTS5 index with full workspace/driver/time/pagination parity
   * and CJK LIKE fallback.
   */
  query(opts: SessionSearchQueryRequest): SessionSearchQueryResult {
    const start = Date.now();
    const rawQuery = (opts.q ?? '').trim();
    if (!rawQuery) {
      return { hits: [], nextOffset: null, fallbackUsed: false, tookMs: 0 };
    }

    const db = this.ensureDb();
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const offset = Math.max(0, opts.offset ?? 0);
    const terms = extractSearchTerms(rawQuery);
    const ftsQuery = buildSafeFts5Query(rawQuery);

    const buildFilterClauses = (alias: { item: string; ftsDriverExpr: string }) => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (opts.workspaceId) {
        clauses.push(`${alias.item}.workspace_id = ?`);
        params.push(opts.workspaceId);
      }
      if (opts.driverId) {
        clauses.push(`(${alias.ftsDriverExpr} = ? OR ${alias.item}.driver_id = ? OR ${alias.item}.harness_id = ?)`);
        params.push(opts.driverId, opts.driverId, opts.driverId);
      }
      if (typeof opts.fromTs === 'number' && Number.isFinite(opts.fromTs)) {
        clauses.push(`${alias.item}.created_at >= ?`);
        params.push(opts.fromTs);
      }
      if (typeof opts.toTs === 'number' && Number.isFinite(opts.toTs)) {
        clauses.push(`${alias.item}.created_at <= ?`);
        params.push(opts.toTs);
      }
      return { clauses, params };
    };

    const mapRows = (
      rows: Array<{
        session_id: string;
        session_title: string;
        workspace_id: string;
        turn_id: string;
        turn_seq: number;
        item_id: string;
        block_type: string;
        body: string;
        driver_id: string;
        created_at: number;
      }>,
    ): { hits: SessionSearchHit[]; nextOffset: number | null } => {
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const hits: SessionSearchHit[] = sliced.map((row) => {
        const snippet = buildSafeHighlightedSnippet(row.body || row.session_title, terms);
        return {
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          workspaceId: row.workspace_id,
          turnId: row.turn_id,
          turnSeq: row.turn_seq ?? 0,
          itemId: row.item_id,
          blockType: row.block_type || 'assistant_text',
          snippetText: snippet.text,
          snippetHtmlSafe: snippet.htmlSafe,
          highlights: snippet.highlights,
          driverId: row.driver_id,
          createdAt: row.created_at,
        };
      });
      return {
        hits,
        nextOffset: hasMore ? offset + sliced.length : null,
      };
    };

    const runLikeFallback = (): { hits: SessionSearchHit[]; nextOffset: number | null } => {
      const escapedPattern = `%${escapeLikePattern(rawQuery)}%`;
      const filter = buildFilterClauses({ item: 'i', ftsDriverExpr: 'i.driver_id' });
      const whereParts = [
        "(i.body LIKE ? ESCAPE '\\' OR i.session_title LIKE ? ESCAPE '\\')",
        ...filter.clauses,
      ];
      const rows = db
        .prepare(
          `SELECT i.session_id, i.session_title, i.workspace_id, i.turn_id, i.turn_seq,
                  i.item_id, i.block_type, i.body, i.driver_id, i.created_at
           FROM search_items i
           WHERE ${whereParts.join(' AND ')}
           ORDER BY i.created_at DESC, i.item_id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(escapedPattern, escapedPattern, ...filter.params, limit + 1, offset) as unknown as Array<{
        session_id: string;
        session_title: string;
        workspace_id: string;
        turn_id: string;
        turn_seq: number;
        item_id: string;
        block_type: string;
        body: string;
        driver_id: string;
        created_at: number;
      }>;
      return mapRows(rows);
    };

    if (opts.forceLikeFallback || !ftsQuery) {
      const res = runLikeFallback();
      return {
        ...res,
        fallbackUsed: true,
        tookMs: Math.max(0, Date.now() - start),
      };
    }

    try {
      const filter = buildFilterClauses({ item: 'i', ftsDriverExpr: 'f.driver_id' });
      const whereParts = ['search_fts MATCH ?', ...filter.clauses];
      const rows = db
        .prepare(
          `SELECT f.session_id,
                  COALESCE(i.session_title, f.title) AS session_title,
                  COALESCE(i.workspace_id, '') AS workspace_id,
                  f.turn_id,
                  COALESCE(i.turn_seq, 0) AS turn_seq,
                  f.item_id,
                  COALESCE(i.block_type, 'assistant_text') AS block_type,
                  f.body,
                  f.driver_id,
                  COALESCE(i.created_at, 0) AS created_at
           FROM search_fts f
           JOIN search_items i ON i.item_id = f.item_id
           WHERE ${whereParts.join(' AND ')}
           ORDER BY bm25(search_fts) ASC, created_at DESC, f.item_id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(ftsQuery, ...filter.params, limit + 1, offset) as unknown as Array<{
        session_id: string;
        session_title: string;
        workspace_id: string;
        turn_id: string;
        turn_seq: number;
        item_id: string;
        block_type: string;
        body: string;
        driver_id: string;
        created_at: number;
      }>;

      if (rows.length === 0 && /[\u4e00-\u9fff]/.test(rawQuery)) {
        const likeRes = runLikeFallback();
        if (likeRes.hits.length > 0) {
          return {
            ...likeRes,
            fallbackUsed: true,
            tookMs: Math.max(0, Date.now() - start),
          };
        }
      }

      const mapped = mapRows(rows);
      return {
        ...mapped,
        fallbackUsed: false,
        tookMs: Math.max(0, Date.now() - start),
      };
    } catch {
      const res = runLikeFallback();
      return {
        ...res,
        fallbackUsed: true,
        tookMs: Math.max(0, Date.now() - start),
      };
    }
  }
}

/**
 * Manages isolated `SessionSearchEngineInstance` instances keyed by `instanceId`,
 * storing each instance's SQLite index and cursor separately under `indexRootDir`.
 */
export class SessionSearchEngineManager {
  private readonly instances = new Map<string, SessionSearchEngineInstance>();

  constructor(
    private readonly indexRootDir: string,
    private readonly defaultReadModel: SessionSearchReadModel,
  ) {}

  resolveDbPath(instanceId: string, customDbPath?: string): string {
    if (customDbPath) return customDbPath;
    return path.join(this.indexRootDir, `${sanitizeInstanceFileName(instanceId)}.fts.sqlite`);
  }

  getOrCreate(
    instanceId: string,
    opts?: {
      dbPath?: string;
      readModel?: SessionSearchReadModel;
      batchSize?: number;
      yieldBetweenBatches?: boolean;
      onJobProgress?: (status: SearchEngineStatus) => void;
    },
  ): SessionSearchEngineInstance {
    const existing = this.instances.get(instanceId);
    if (existing) return existing;
    const created = new SessionSearchEngineInstance({
      instanceId,
      dbPath: this.resolveDbPath(instanceId, opts?.dbPath),
      readModel: opts?.readModel ?? this.defaultReadModel,
      batchSize: opts?.batchSize,
      yieldBetweenBatches: opts?.yieldBetweenBatches,
      onJobProgress: opts?.onJobProgress,
    });
    this.instances.set(instanceId, created);
    return created;
  }

  get(instanceId: string): SessionSearchEngineInstance | undefined {
    return this.instances.get(instanceId);
  }

  async disposeInstance(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.instances.delete(instanceId);
    await inst.dispose();
  }

  async disposeAll(): Promise<void> {
    const list = [...this.instances.values()];
    this.instances.clear();
    await Promise.allSettled(list.map((inst) => inst.dispose()));
  }
}

/**
 * Exposes a `SessionSearchReadModel` as a `hm.session-data.v1` / `session.readModel.v1`
 * host service so isolated search plugins can consume snapshots & committed changes via RPC.
 */
export function createSessionSearchReadModelService(readModel: SessionSearchReadModel) {
  return {
    readSearchSnapshot: (opts?: {
      snapshotId?: string;
      cursor?: string | null;
      limit?: number;
      workspaceId?: string;
    }) => readModel.readSearchSnapshot(opts),
    readCommittedChanges: (opts: {
      afterSeq: number;
      limit?: number;
      workspaceId?: string;
    }) => readModel.readCommittedChanges(opts),
    getLatestCommittedSeq: () =>
      readModel.getLatestCommittedSeq ? readModel.getLatestCommittedSeq() : 0,
  };
}
