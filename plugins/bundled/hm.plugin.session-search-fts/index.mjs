import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const requires = ['ui.workspace.pages'];

const READ_MODEL_CONTRACTS = ['hm.session-data.v1', 'session.readModel.v1', 'session.changes.v1'];
const MAX_STORAGE_CHUNK_BYTES = 180 * 1024;
const DEFAULT_BATCH_SIZE = 20;

function sanitizeInstanceId(id) {
  return String(id || 'default').replace(/[^a-z0-9._-]/gi, '_') || 'default';
}

function buildSafeFts5Query(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const tokens = trimmed
    .replace(/["*^():+~]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^-+/, '').trim())
    .filter((tok) => tok.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((tok) => `"${tok.replace(/"/g, '""')}"`).join(' ');
}

function extractSearchTerms(raw) {
  const stripped = String(raw ?? '')
    .replace(/["*^():+~]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^-+/, '').trim())
    .filter((tok) => tok.length > 0);
  const unique = [...new Set(stripped.length > 0 ? stripped : [String(raw ?? '').trim()].filter(Boolean))];
  return unique.sort((a, b) => b.length - a.length);
}

function escapeLikePattern(raw) {
  return String(raw ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSafeHighlightedSnippet(body, terms, windowChars = 160) {
  const normalized = String(body ?? '').replace(/\s+/g, ' ').trim();
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
  const spans = [];
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

function isSearchableItem(item) {
  if (!item || typeof item.textBody !== 'string' || !item.textBody.trim()) return false;
  if (item.blockType === 'secret_request') return false;
  if (item.blockType === 'runtime_request' && item.payload && item.payload.kind === 'secret_request') {
    return false;
  }
  return true;
}

function initDatabase(db, isFileBacked) {
  if (isFileBacked) {
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
      scoped_skips_json TEXT NOT NULL DEFAULT '[]',
      reindex_state TEXT NOT NULL DEFAULT 'idle',
      job_json TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  const cols = db.prepare('PRAGMA table_info(search_sync_state)').all();
  if (!cols.some((c) => c.name === 'scoped_skips_json')) {
    db.exec("ALTER TABLE search_sync_state ADD COLUMN scoped_skips_json TEXT NOT NULL DEFAULT '[]';");
  }
  db.prepare(
    `INSERT OR IGNORE INTO search_sync_state (id, cursor_seq, scoped_skips_json, reindex_state, updated_at)
     VALUES (1, 0, '[]', 'idle', ?)`,
  ).run(Date.now());
}

function parseScopedSkips(raw) {
  if (!raw) return [];
  try {
    const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) => s && typeof s === 'object' && typeof s.workspaceId === 'string' && typeof s.upToSeq === 'number',
    );
  } catch {
    return [];
  }
}

function mergeScopedSkip(skips, workspaceId, upToSeq) {
  const map = new Map();
  for (const s of skips) map.set(s.workspaceId, s.upToSeq);
  map.set(workspaceId, Math.max(map.get(workspaceId) ?? 0, upToSeq));
  return [...map.entries()].map(([ws, seq]) => ({ workspaceId: ws, upToSeq: seq }));
}

function pruneScopedSkips(skips, cursorSeq) {
  return skips.filter((s) => s.upToSeq > cursorSeq);
}

function resolveChangeWorkspaceId(change) {
  if (!change || typeof change !== 'object') return null;
  if (change.kind === 'upsert_item') {
    return change.item?.workspaceId ?? change.workspaceId ?? null;
  }
  if (change.kind === 'upsert_session') {
    return change.session?.workspaceId ?? change.workspaceId ?? null;
  }
  return change.workspaceId ?? null;
}

function shouldSkipScopedChange(change, skips) {
  if (!skips.length) return false;
  const wsId = resolveChangeWorkspaceId(change);
  if (!wsId) return false;
  const entry = skips.find((s) => s.workspaceId === wsId);
  return Boolean(entry && change.changeSeq <= entry.upToSeq);
}

export async function apply(ctx, config = {}) {
  const safeId = sanitizeInstanceId(ctx.instanceId);
  const batchSize = Math.max(1, Math.min(200, Number(config.batchSize) || DEFAULT_BATCH_SIZE));
  const readModelContractOverride =
    typeof config.readModelContract === 'string' && config.readModelContract.trim()
      ? config.readModelContract.trim()
      : null;

  let disposed = false;
  let generation = 1;
  let persistedGeneration = 0;
  let cancelRequested = false;
  let activeReindexPromise = null;
  let lastError = null;
  let isFileBacked = false;
  let dbPath = ':memory:';
  let db;

  const explicitDbPath =
    typeof config.indexPath === 'string' && config.indexPath.trim()
      ? config.indexPath.trim()
      : typeof config.storageDir === 'string' && config.storageDir.trim()
        ? path.join(config.storageDir.trim(), `${safeId}.fts.sqlite`)
        : null;

  if (explicitDbPath && explicitDbPath !== ':memory:') {
    try {
      fs.mkdirSync(path.dirname(explicitDbPath), { recursive: true });
      db = new DatabaseSync(explicitDbPath);
      isFileBacked = true;
      dbPath = explicitDbPath;
    } catch {
      db = new DatabaseSync(':memory:');
      isFileBacked = false;
      dbPath = ':memory:';
    }
  } else {
    db = new DatabaseSync(':memory:');
  }
  initDatabase(db, isFileBacked);

  function readSyncRow() {
    return db
      .prepare(
        `SELECT cursor_seq, snapshot_id, snapshot_watermark, snapshot_cursor, scoped_skips_json, reindex_state, job_json, updated_at
         FROM search_sync_state WHERE id = 1`,
      )
      .get();
  }

  function parseJob(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function upsertItemInTx(item) {
    const updatedAt = Number(item.updatedAt ?? item.createdAt ?? Date.now());
    const createdAt = Number(item.createdAt ?? updatedAt);
    const driverId = String(item.driverId || 'unknown');
    const harnessId = String(item.harnessId || driverId);
    const sessionTitle = String(item.sessionTitle || '');
    const workspaceId = String(item.workspaceId || '');
    const turnId = String(item.turnId || '');
    const turnSeq = Number(item.turnSeq || 0);
    const blockType = String(item.blockType || 'assistant_text');

    db.prepare(
      `INSERT OR REPLACE INTO search_sessions_meta (session_id, title, workspace_id, driver_id, harness_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(item.sessionId, sessionTitle, workspaceId, driverId, harnessId, updatedAt);

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
      sessionTitle,
      workspaceId,
      turnId,
      turnSeq,
      driverId,
      harnessId,
      blockType,
      item.textBody,
      createdAt,
      updatedAt,
    );
    db.prepare('DELETE FROM search_fts WHERE item_id = ?').run(item.itemId);
    db.prepare(
      `INSERT INTO search_fts (session_id, item_id, turn_id, driver_id, title, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(item.sessionId, item.itemId, turnId, driverId, sessionTitle, item.textBody);
    return true;
  }

  function applyChangeInTx(change) {
    if (!change || typeof change !== 'object') return;
    if (change.kind === 'upsert_item' && change.item) {
      upsertItemInTx(change.item);
    } else if (change.kind === 'upsert_session') {
      const title = change.session?.title ?? change.sessionTitle ?? '';
      const workspaceId = change.session?.workspaceId ?? change.workspaceId ?? '';
      const driverId = change.session?.harnessKind ?? change.driverId ?? 'unknown';
      const harnessId = change.session?.harnessId ?? change.harnessId ?? driverId;
      const updatedAt = Number(change.session?.updatedAt ?? change.updatedAt ?? change.committedAt ?? Date.now());
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
      db.prepare('UPDATE search_fts SET title = ? WHERE session_id = ?').run(title, change.sessionId);
    } else if (change.kind === 'delete_session') {
      db.prepare('DELETE FROM search_sessions_meta WHERE session_id = ?').run(change.sessionId);
      db.prepare('DELETE FROM search_items WHERE session_id = ?').run(change.sessionId);
      db.prepare('DELETE FROM search_fts WHERE session_id = ?').run(change.sessionId);
    } else if (change.kind === 'delete_item') {
      const targetItemId = change.itemId ?? change.item?.itemId;
      if (targetItemId) {
        db.prepare('DELETE FROM search_items WHERE item_id = ?').run(targetItemId);
        db.prepare('DELETE FROM search_fts WHERE item_id = ?').run(targetItemId);
      }
    }
  }

  function serializeChunksWithHash(items) {
    const chunks = [];
    let current = [];
    for (const item of items) {
      current.push(item);
      if (Buffer.byteLength(JSON.stringify(current), 'utf8') > MAX_STORAGE_CHUNK_BYTES && current.length > 1) {
        current.pop();
        chunks.push(current);
        current = [item];
      }
    }
    if (current.length > 0) chunks.push(current);

    const hash = crypto.createHash('sha256');
    let totalBytes = 0;
    for (const chunk of chunks) {
      const encoded = JSON.stringify(chunk);
      totalBytes += Buffer.byteLength(encoded, 'utf8');
      hash.update(encoded, 'utf8');
    }
    return {
      chunks,
      totalBytes,
      sha256: hash.digest('hex'),
    };
  }

  /**
   * Two-phase generation commit to ctx.storage.plugin:
   * Phase 1 writes all `fts:gen:<nextGen>:chunk:<i>` entries first.
   * Phase 2 commits `fts:meta` (cursorSeq, generation, sha256) only after every chunk succeeds.
   * Phase 3 removes previous-generation chunk keys.
   * Write errors are NEVER swallowed so persisted cursorSeq never leads persisted chunks.
   */
  async function persistMemoryState() {
    if (isFileBacked || disposed) return;
    const syncRow = readSyncRow();
    const items = db
      .prepare(
        `SELECT item_id, session_id, session_title, workspace_id, turn_id, turn_seq,
                driver_id, harness_id, block_type, body, created_at, updated_at
         FROM search_items ORDER BY created_at ASC, item_id ASC`,
      )
      .all()
      .map((r) => ({
        itemId: r.item_id,
        sessionId: r.session_id,
        sessionTitle: r.session_title,
        workspaceId: r.workspace_id,
        turnId: r.turn_id,
        turnSeq: r.turn_seq,
        driverId: r.driver_id,
        harnessId: r.harness_id,
        blockType: r.block_type,
        textBody: r.body,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

    const nextGen = persistedGeneration + 1;
    const { chunks, totalBytes, sha256 } = serializeChunksWithHash(items);
    const writtenChunkKeys = [];

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const key = `fts:gen:${nextGen}:chunk:${i}`;
        await ctx.storage.plugin.set(key, chunks[i]);
        writtenChunkKeys.push(key);
      }

      const meta = {
        schemaVersion: 2,
        generation: nextGen,
        cursorSeq: syncRow.cursor_seq,
        scopedSkips: parseScopedSkips(syncRow.scoped_skips_json),
        snapshotId: syncRow.snapshot_id,
        snapshotWatermark: syncRow.snapshot_watermark,
        snapshotCursor: syncRow.snapshot_cursor,
        reindexState: syncRow.reindex_state,
        job: parseJob(syncRow.job_json),
        chunkCount: chunks.length,
        totalBytes,
        sha256,
        committedAt: Date.now(),
      };
      await ctx.storage.plugin.set('fts:meta', meta);
      persistedGeneration = nextGen;
    } catch (err) {
      // Abort commit: roll back newly written partial chunks and keep old fts:meta untouched
      for (const key of writtenChunkKeys) {
        await ctx.storage.plugin.delete(key).catch(() => {});
      }
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }

    // Best-effort cleanup of older generation chunks after atomic meta commit
    try {
      const allKeys = await ctx.storage.plugin.keys();
      const prefix = `fts:gen:${nextGen}:chunk:`;
      for (const key of allKeys) {
        if ((key.startsWith('fts:gen:') && !key.startsWith(prefix)) || key.startsWith('fts:chunk:')) {
          await ctx.storage.plugin.delete(key).catch(() => {});
        }
      }
    } catch {
      // Ignore non-critical old chunk cleanup error
    }
  }

  async function restoreMemoryState() {
    if (isFileBacked || disposed) return;
    let meta;
    try {
      meta = await ctx.storage.plugin.get('fts:meta');
    } catch (err) {
      if (err && err.code === 'E_PERMISSION_DENIED') return;
      lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    if (!meta || typeof meta !== 'object') return;

    const chunkCount = Number(meta.chunkCount || 0);
    const hasGeneration = meta.schemaVersion === 2 && typeof meta.generation === 'number';
    const restoredItems = [];
    let corruptReason = null;

    if (hasGeneration) {
      persistedGeneration = meta.generation;
      const hash = crypto.createHash('sha256');
      let actualBytes = 0;
      for (let i = 0; i < chunkCount; i += 1) {
        const chunk = await ctx.storage.plugin.get(`fts:gen:${meta.generation}:chunk:${i}`).catch(() => undefined);
        if (!Array.isArray(chunk)) {
          corruptReason = `缺失分块 fts:gen:${meta.generation}:chunk:${i}`;
          break;
        }
        const encoded = JSON.stringify(chunk);
        actualBytes += Buffer.byteLength(encoded, 'utf8');
        hash.update(encoded, 'utf8');
        restoredItems.push(...chunk);
      }
      if (!corruptReason && (actualBytes !== meta.totalBytes || hash.digest('hex') !== meta.sha256)) {
        corruptReason = '持久化分块哈希校验失败';
      }
    } else {
      for (let i = 0; i < chunkCount; i += 1) {
        const chunk = await ctx.storage.plugin.get(`fts:chunk:${i}`).catch(() => undefined);
        if (!Array.isArray(chunk)) {
          corruptReason = `缺失旧分块 fts:chunk:${i}`;
          break;
        }
        restoredItems.push(...chunk);
      }
    }

    if (corruptReason) {
      // Reset cursor safely so next sync catches up cleanly from 0 instead of running with partial data
      lastError = `${corruptReason}，已重置游标以重新同步`;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM search_items; DELETE FROM search_fts; DELETE FROM search_sessions_meta;');
        db.prepare(
          `UPDATE search_sync_state
           SET cursor_seq = 0, scoped_skips_json = '[]', snapshot_id = NULL, snapshot_watermark = NULL,
               snapshot_cursor = NULL, reindex_state = 'idle', job_json = NULL, updated_at = ?
           WHERE id = 1`,
        ).run(Date.now());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of restoredItems) {
        upsertItemInTx(item);
      }
      let job = meta.job ?? null;
      let reindexState = typeof meta.reindexState === 'string' ? meta.reindexState : 'idle';
      if (job && (job.status === 'running' || job.status === 'queued')) {
        job = {
          ...job,
          status: 'cancelled',
          resumeAvailable: Boolean(meta.snapshotId || meta.snapshotCursor !== null || meta.snapshotWatermark !== null),
          updatedAt: Date.now(),
          error: job.error ?? '实例重载或中断，支持断点续跑',
        };
        reindexState = 'cancelled';
      }
      db.prepare(
        `UPDATE search_sync_state
         SET cursor_seq = ?, scoped_skips_json = ?, snapshot_id = ?, snapshot_watermark = ?, snapshot_cursor = ?,
             reindex_state = ?, job_json = ?, updated_at = ?
         WHERE id = 1`,
      ).run(
        Number(meta.cursorSeq || 0),
        JSON.stringify(parseScopedSkips(meta.scopedSkips)),
        meta.snapshotId ?? null,
        meta.snapshotWatermark ?? null,
        meta.snapshotCursor ?? null,
        reindexState,
        job ? JSON.stringify(job) : null,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  await restoreMemoryState();

  // If file-backed DB restarted mid-run, mark stale running job as interrupted/resumable
  {
    const row = readSyncRow();
    const prevJob = parseJob(row.job_json);
    if (prevJob && (prevJob.status === 'running' || prevJob.status === 'queued')) {
      const interrupted = {
        ...prevJob,
        status: 'cancelled',
        resumeAvailable: Boolean(row.snapshot_id || row.snapshot_cursor !== null || row.snapshot_watermark !== null),
        updatedAt: Date.now(),
        error: prevJob.error ?? '进程中断，支持断点续跑',
      };
      db.prepare(
        `UPDATE search_sync_state SET reindex_state = 'cancelled', job_json = ?, updated_at = ? WHERE id = 1`,
      ).run(JSON.stringify(interrupted), Date.now());
    }
  }

  async function resolveReadModelContract() {
    const providers = await ctx.services.list().catch(() => []);
    if (readModelContractOverride && providers.some((p) => p.contract === readModelContractOverride)) {
      return readModelContractOverride;
    }
    for (const contract of READ_MODEL_CONTRACTS) {
      if (providers.some((p) => p.contract === contract)) return contract;
    }
    return null;
  }

  async function readSnapshotViaHost(opts) {
    const contract = await resolveReadModelContract();
    if (contract) {
      return await ctx.services.call(contract, 'readSearchSnapshot', [opts]);
    }
    // Fallback to public ctx.sessions API when no read-model service is mounted
    const sessions = await ctx.sessions.list(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {});
    sessions.sort((a, b) => a.id.localeCompare(b.id));
    const allItems = [];
    let watermarkSeq = 0;
    for (const session of sessions) {
      if (session.updatedAt > watermarkSeq) watermarkSeq = session.updatedAt;
      const res = await ctx.sessions.listItems(session.id, { limit: 200, includeOmittedBodies: true });
      for (const item of res?.items ?? []) {
        if (item.updatedAt > watermarkSeq) watermarkSeq = item.updatedAt;
        if (!isSearchableItem(item)) continue;
        allItems.push({
          sessionId: session.id,
          sessionTitle: session.title,
          workspaceId: session.workspaceId,
          turnId: item.turnId ?? '',
          turnSeq: item.seq ?? 0,
          itemId: item.itemId,
          blockType: item.blockType,
          driverId: item.driverId || session.harnessKind,
          harnessId: session.harnessId,
          textBody: item.textBody,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          payload: item.payload,
        });
      }
    }
    const offset = opts?.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
    const limit = Math.max(1, Math.min(200, opts?.limit ?? batchSize));
    const pageItems = allItems.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    return {
      snapshotId: opts?.snapshotId ?? `sessions_snap_${Date.now()}`,
      watermarkSeq,
      items: pageItems,
      nextCursor: nextOffset < allItems.length ? String(nextOffset) : null,
    };
  }

  async function readChangesViaHost(afterSeq, workspaceId) {
    const contract = await resolveReadModelContract();
    if (contract) {
      return await ctx.services.call(contract, 'readCommittedChanges', [
        { afterSeq, limit: batchSize, ...(workspaceId ? { workspaceId } : {}) },
      ]);
    }
    const sessions = await ctx.sessions.list(workspaceId ? { workspaceId } : {});
    const changes = [];
    let latestSeq = afterSeq;
    for (const session of sessions) {
      if (session.updatedAt > latestSeq) latestSeq = session.updatedAt;
      const res = await ctx.sessions.listItems(session.id, { limit: 200, includeOmittedBodies: true });
      for (const item of res?.items ?? []) {
        if (item.updatedAt > latestSeq) latestSeq = item.updatedAt;
        if (item.updatedAt > afterSeq && isSearchableItem(item)) {
          changes.push({
            changeSeq: item.updatedAt,
            kind: 'upsert_item',
            item: {
              sessionId: session.id,
              sessionTitle: session.title,
              workspaceId: session.workspaceId,
              turnId: item.turnId ?? '',
              turnSeq: item.seq ?? 0,
              itemId: item.itemId,
              blockType: item.blockType,
              driverId: item.driverId || session.harnessKind,
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
    const sliced = changes.slice(0, batchSize);
    return { changes: sliced, latestSeq, hasMore: changes.length > sliced.length };
  }

  let syncQueue = Promise.resolve();
  function enqueueSync() {
    if (disposed) return Promise.resolve({ appliedChanges: 0, cursorSeq: 0 });
    const g = generation;
    const next = syncQueue.then(async () => {
      if (disposed || generation !== g) return { appliedChanges: 0, cursorSeq: 0 };
      return await syncIncremental();
    });
    syncQueue = next.catch(() => {});
    return next;
  }

  async function syncIncremental() {
    if (disposed) return { appliedChanges: 0, cursorSeq: 0 };
    const startGen = generation;
    let appliedChanges = 0;

    while (!disposed && generation === startGen) {
      const state = readSyncRow();
      const page = await readChangesViaHost(state.cursor_seq);
      if (disposed || generation !== startGen) break;
      const list = Array.isArray(page?.changes) ? page.changes : [];
      if (list.length === 0) {
        if (typeof page?.latestSeq === 'number' && page.latestSeq > state.cursor_seq) {
          const pruned = pruneScopedSkips(parseScopedSkips(state.scoped_skips_json), page.latestSeq);
          db.prepare('UPDATE search_sync_state SET cursor_seq = ?, scoped_skips_json = ?, updated_at = ? WHERE id = 1').run(
            page.latestSeq,
            JSON.stringify(pruned),
            Date.now(),
          );
          try {
            await persistMemoryState();
          } catch (err) {
            db.prepare('UPDATE search_sync_state SET cursor_seq = ?, scoped_skips_json = ?, updated_at = ? WHERE id = 1').run(
              state.cursor_seq,
              state.scoped_skips_json ?? '[]',
              Date.now(),
            );
            throw err;
          }
        }
        break;
      }

      const maxBatchSeq = list[list.length - 1].changeSeq;
      const skips = parseScopedSkips(state.scoped_skips_json);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const change of list) {
          if (shouldSkipScopedChange(change, skips)) continue;
          applyChangeInTx(change);
          appliedChanges += 1;
        }
        const nextCursor = Math.max(state.cursor_seq, Number(maxBatchSeq || 0));
        const prunedSkips = pruneScopedSkips(skips, nextCursor);
        db.prepare('UPDATE search_sync_state SET cursor_seq = ?, scoped_skips_json = ?, updated_at = ? WHERE id = 1').run(
          nextCursor,
          JSON.stringify(prunedSkips),
          Date.now(),
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }
      try {
        await persistMemoryState();
      } catch (err) {
        // Revert in-memory cursor_seq so memory state does not outrun failed chunk persistence
        db.prepare('UPDATE search_sync_state SET cursor_seq = ?, scoped_skips_json = ?, updated_at = ? WHERE id = 1').run(
          state.cursor_seq,
          state.scoped_skips_json ?? '[]',
          Date.now(),
        );
        throw err;
      }
      if (!page.hasMore) break;
    }

    return { appliedChanges, cursorSeq: readSyncRow().cursor_seq };
  }

  function persistJob(job, state) {
    if (disposed) return;
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

  async function runReindex(req = {}) {
    if (disposed) {
      return { ok: false, error: { code: 'cancelled', message: '搜索插件实例已停止' } };
    }
    if (activeReindexPromise) {
      const current = await activeReindexPromise;
      return { ok: true, value: current };
    }

    const mode = req.mode === 'incremental' || req.mode === 'resume' ? req.mode : 'full';
    if (mode === 'incremental') {
      const now = Date.now();
      const jobId = typeof req.jobId === 'string' && req.jobId.trim()
        ? req.jobId.trim()
        : `reindex_${crypto.randomBytes(5).toString('hex')}`;
      try {
        const syncRes = await enqueueSync();
        const doneJob = {
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
        persistJob(doneJob, { snapshotId: null, snapshotWatermark: null, snapshotCursor: null, reindexState: 'idle' });
        await persistMemoryState();
        return { ok: true, value: doneJob };
      } catch (err) {
        return { ok: false, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } };
      }
    }

    cancelRequested = false;
    const runGen = generation;

    const task = (async () => {
      const row = readSyncRow();
      const prevJob = parseJob(row.job_json);
      const canResume =
        mode === 'resume' &&
        Boolean(row.snapshot_id || row.snapshot_cursor !== null || row.snapshot_watermark !== null);
      const targetWorkspaceId = canResume
        ? (prevJob?.workspaceId ?? (typeof req.workspaceId === 'string' && req.workspaceId ? req.workspaceId : null))
        : (typeof req.workspaceId === 'string' && req.workspaceId ? req.workspaceId : null);
      const now = Date.now();
      let job = canResume && prevJob
        ? {
            ...prevJob,
            mode: 'resume',
            status: 'running',
            workspaceId: targetWorkspaceId,
            updatedAt: now,
            finishedAt: null,
            error: null,
          }
        : {
            jobId:
              typeof req.jobId === 'string' && req.jobId.trim()
                ? req.jobId.trim()
                : `reindex_${crypto.randomBytes(5).toString('hex')}`,
            mode: 'full',
            status: 'running',
            workspaceId: targetWorkspaceId,
            indexedCount: 0,
            deletedCount: 0,
            cursorSeq: row.cursor_seq,
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
        db.exec('BEGIN IMMEDIATE');
        try {
          if (targetWorkspaceId) {
            const existingIds = db
              .prepare('SELECT item_id FROM search_items WHERE workspace_id = ?')
              .all(targetWorkspaceId);
            for (const itemRow of existingIds) {
              db.prepare('DELETE FROM search_fts WHERE item_id = ?').run(itemRow.item_id);
            }
            db.prepare('DELETE FROM search_items WHERE workspace_id = ?').run(targetWorkspaceId);
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
        persistJob(job, {
          snapshotId: row.snapshot_id,
          snapshotWatermark: row.snapshot_watermark,
          snapshotCursor: row.snapshot_cursor,
          reindexState: 'running',
        });
      }
      await persistMemoryState();

      let snapshotId = canResume ? (row.snapshot_id ?? undefined) : undefined;
      let cursor = canResume ? row.snapshot_cursor : null;
      let watermarkSeq = canResume ? row.snapshot_watermark : null;

      try {
        while (true) {
          if (disposed || cancelRequested || generation !== runGen) {
            job = {
              ...job,
              status: 'cancelled',
              resumeAvailable: Boolean(snapshotId || cursor !== null || watermarkSeq !== null),
              updatedAt: Date.now(),
            };
            persistJob(job, {
              snapshotId: snapshotId ?? null,
              snapshotWatermark: watermarkSeq ?? null,
              snapshotCursor: cursor ?? null,
              reindexState: 'cancelled',
            });
            await persistMemoryState();
            return job;
          }

          let page;
          try {
            page = await readSnapshotViaHost({
              snapshotId,
              cursor,
              limit: batchSize,
              ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
            });
          } catch {
            page = await readSnapshotViaHost({
              limit: batchSize,
              ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
            });
          }

          if (disposed || cancelRequested || generation !== runGen) {
            job = {
              ...job,
              status: 'cancelled',
              snapshotId: page?.snapshotId ?? snapshotId ?? null,
              snapshotWatermark: page?.watermarkSeq ?? watermarkSeq ?? null,
              snapshotCursor: cursor,
              resumeAvailable: true,
              updatedAt: Date.now(),
            };
            persistJob(job, {
              snapshotId: job.snapshotId,
              snapshotWatermark: job.snapshotWatermark,
              snapshotCursor: cursor ?? null,
              reindexState: 'cancelled',
            });
            await persistMemoryState();
            return job;
          }

          snapshotId = page.snapshotId;
          watermarkSeq = page.watermarkSeq;
          const nextCursor = page.nextCursor ?? null;
          const prevSyncRow = readSyncRow();

          db.exec('BEGIN IMMEDIATE');
          try {
            for (const item of page.items ?? []) {
              if (upsertItemInTx(item)) job.indexedCount += 1;
            }
            job.snapshotId = nextCursor ? snapshotId : null;
            job.snapshotWatermark = watermarkSeq;
            job.snapshotCursor = nextCursor;
            job.resumeAvailable = Boolean(nextCursor);
            job.updatedAt = Date.now();

            if (!nextCursor) {
              const currSeq = prevSyncRow.cursor_seq;
              const snapSeq = Number(watermarkSeq || 0);
              if (targetWorkspaceId) {
                // Scoped workspace rebuild: keep global cursor_seq intact so other workspaces' unconsumed changes are NOT skipped
                const nextSkips = snapSeq > currSeq
                  ? mergeScopedSkip(parseScopedSkips(prevSyncRow.scoped_skips_json), targetWorkspaceId, snapSeq)
                  : parseScopedSkips(prevSyncRow.scoped_skips_json);
                job.cursorSeq = currSeq;
                db.prepare(
                  `UPDATE search_sync_state
                   SET scoped_skips_json = ?, snapshot_id = NULL, snapshot_watermark = NULL,
                       snapshot_cursor = NULL, reindex_state = 'running', job_json = ?, updated_at = ?
                   WHERE id = 1`,
                ).run(JSON.stringify(nextSkips), JSON.stringify(job), job.updatedAt);
              } else {
                const nextCursorSeq = Math.max(currSeq, snapSeq);
                job.cursorSeq = nextCursorSeq;
                db.prepare(
                  `UPDATE search_sync_state
                   SET cursor_seq = ?, scoped_skips_json = '[]', snapshot_id = NULL, snapshot_watermark = NULL,
                       snapshot_cursor = NULL, reindex_state = 'running', job_json = ?, updated_at = ?
                   WHERE id = 1`,
                ).run(nextCursorSeq, JSON.stringify(job), job.updatedAt);
              }
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
          try {
            await persistMemoryState();
          } catch (err) {
            db.prepare(
              `UPDATE search_sync_state
               SET cursor_seq = ?, scoped_skips_json = ?, snapshot_id = ?, snapshot_watermark = ?, snapshot_cursor = ?,
                   reindex_state = ?, job_json = ?, updated_at = ?
               WHERE id = 1`,
            ).run(
              prevSyncRow.cursor_seq,
              prevSyncRow.scoped_skips_json ?? '[]',
              prevSyncRow.snapshot_id,
              prevSyncRow.snapshot_watermark,
              prevSyncRow.snapshot_cursor,
              prevSyncRow.reindex_state,
              prevSyncRow.job_json,
              Date.now(),
            );
            throw err;
          }

          if (!nextCursor) break;
          cursor = nextCursor;
          await new Promise((resolve) => setImmediate(resolve));
        }

        const catchup = await enqueueSync();
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
        persistJob(job, { snapshotId: null, snapshotWatermark: null, snapshotCursor: null, reindexState: 'idle' });
        await persistMemoryState();
        return job;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        job = {
          ...job,
          status: 'failed',
          error: message,
          updatedAt: Date.now(),
          finishedAt: Date.now(),
        };
        if (!disposed) {
          persistJob(job, {
            snapshotId: snapshotId ?? null,
            snapshotWatermark: watermarkSeq ?? null,
            snapshotCursor: cursor ?? null,
            reindexState: 'error',
          });
          await persistMemoryState();
        }
        throw err;
      }
    })();

    const promise = task.finally(() => {
      if (activeReindexPromise === promise) activeReindexPromise = null;
    });
    activeReindexPromise = promise;
    try {
      const done = await activeReindexPromise;
      return { ok: true, value: done };
    } catch (err) {
      return { ok: false, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  async function runQuery(req = {}) {
    const start = Date.now();
    const rawQuery = typeof req.q === 'string' ? req.q.trim() : '';
    if (!rawQuery) {
      return { ok: true, value: { hits: [], nextOffset: null, fallbackUsed: false, tookMs: 0 } };
    }
    if (!req.skipSync) {
      await enqueueSync().catch(() => {});
    }
    const limit = Math.min(100, Math.max(1, Number(req.limit ?? 25) || 25));
    const offset = Math.max(0, Number(req.offset ?? 0) || 0);
    const terms = extractSearchTerms(rawQuery);
    const ftsQuery = buildSafeFts5Query(rawQuery);

    const buildFilterClauses = (alias) => {
      const clauses = [];
      const params = [];
      if (typeof req.workspaceId === 'string' && req.workspaceId) {
        clauses.push(`${alias.item}.workspace_id = ?`);
        params.push(req.workspaceId);
      }
      if (typeof req.driverId === 'string' && req.driverId) {
        clauses.push(`(${alias.ftsDriverExpr} = ? OR ${alias.item}.driver_id = ? OR ${alias.item}.harness_id = ?)`);
        params.push(req.driverId, req.driverId, req.driverId);
      }
      if (typeof req.fromTs === 'number' && Number.isFinite(req.fromTs)) {
        clauses.push(`${alias.item}.created_at >= ?`);
        params.push(req.fromTs);
      }
      if (typeof req.toTs === 'number' && Number.isFinite(req.toTs)) {
        clauses.push(`${alias.item}.created_at <= ?`);
        params.push(req.toTs);
      }
      return { clauses, params };
    };

    const mapRows = (rows) => {
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const hits = sliced.map((row) => {
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
      return { hits, nextOffset: hasMore ? offset + sliced.length : null };
    };

    const runLikeFallback = () => {
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
        .all(escapedPattern, escapedPattern, ...filter.params, limit + 1, offset);
      return mapRows(rows);
    };

    if (req.forceLikeFallback || !ftsQuery) {
      const res = runLikeFallback();
      return {
        ok: true,
        value: { ...res, fallbackUsed: true, tookMs: Math.max(0, Date.now() - start) },
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
        .all(ftsQuery, ...filter.params, limit + 1, offset);

      if (rows.length === 0 && /[\u4e00-\u9fff]/.test(rawQuery)) {
        const likeRes = runLikeFallback();
        if (likeRes.hits.length > 0) {
          return {
            ok: true,
            value: { ...likeRes, fallbackUsed: true, tookMs: Math.max(0, Date.now() - start) },
          };
        }
      }
      const mapped = mapRows(rows);
      return {
        ok: true,
        value: { ...mapped, fallbackUsed: false, tookMs: Math.max(0, Date.now() - start) },
      };
    } catch {
      const res = runLikeFallback();
      return {
        ok: true,
        value: { ...res, fallbackUsed: true, tookMs: Math.max(0, Date.now() - start) },
      };
    }
  }

  async function getStatus() {
    const row = readSyncRow();
    const job = parseJob(row.job_json);
    const itemCnt = db.prepare('SELECT COUNT(*) AS cnt FROM search_items').get();
    const sessCnt = db.prepare('SELECT COUNT(DISTINCT session_id) AS cnt FROM search_items').get();
    let latestSourceSeq = null;
    try {
      const contract = await resolveReadModelContract();
      if (contract) {
        const page = await ctx.services.call(contract, 'readCommittedChanges', [
          { afterSeq: row.cursor_seq, limit: 1 },
        ]);
        if (typeof page?.latestSeq === 'number' && Number.isFinite(page.latestSeq)) {
          latestSourceSeq = page.latestSeq;
        }
      }
    } catch {
      latestSourceSeq = null;
    }
    const activeJob = job && (job.status === 'running' || job.status === 'queued') ? job : null;
    return {
      ok: true,
      value: {
        instanceId: ctx.instanceId,
        pluginId: ctx.pluginId,
        engineKind: 'fts5',
        dbPath,
        isFileBacked,
        state: activeJob ? 'reindexing' : lastError ? 'error' : 'idle',
        cursorSeq: row.cursor_seq,
        latestSourceSeq,
        indexedItems: Number(itemCnt?.cnt ?? 0),
        indexedSessions: Number(sessCnt?.cnt ?? 0),
        activeJob,
        lastJob: job,
        resumeAvailable: Boolean(row.snapshot_id || row.snapshot_cursor !== null || row.snapshot_watermark !== null),
        lastError,
      },
    };
  }

  async function cancelReindex() {
    cancelRequested = true;
    if (activeReindexPromise) {
      const result = await activeReindexPromise;
      return {
        ok: true,
        value: {
          jobId: result.jobId,
          status: result.status,
          cancelled: result.status === 'cancelled',
          cursorSeq: result.cursorSeq,
          resumeAvailable: result.resumeAvailable,
        },
      };
    }
    const row = readSyncRow();
    const prevJob = parseJob(row.job_json);
    return {
      ok: true,
      value: {
        jobId: prevJob?.jobId ?? null,
        status: prevJob?.status ?? 'idle',
        cancelled: false,
        cursorSeq: row.cursor_seq,
        resumeAvailable: Boolean(row.snapshot_id || row.snapshot_cursor !== null || row.snapshot_watermark !== null),
      },
    };
  }

  // Subscribe to live committed turn/message events while enabled
  const scheduleCatchup = () => {
    if (disposed) return;
    void enqueueSync().catch(() => {});
  };

  for (const eventName of ['turn.completed', 'message.user', 'message.assistant.completed', 'session.created']) {
    ctx.events.on(eventName, () => {
      scheduleCatchup();
    });
  }

  // Initial non-blocking catch-up on activation (covers enabled-time or offline-time committed changes)
  if (readSyncRow().cursor_seq > 0 || config.autoSyncOnStart !== false) {
    scheduleCatchup();
  }

  ctx.effect(() => () => {
    disposed = true;
    generation += 1;
    cancelRequested = true;
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  const serviceImpl = {
    async query(req = {}) {
      return runQuery(req);
    },
    async reindex(req = {}) {
      return runReindex(req);
    },
    async getStatus() {
      return getStatus();
    },
    async cancelReindex() {
      return cancelReindex();
    },
    async resumeReindex(req = {}) {
      return runReindex({ ...req, mode: 'resume' });
    },
    async sync() {
      try {
        const res = await enqueueSync();
        return { ok: true, value: res };
      } catch (err) {
        return { ok: false, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } };
      }
    },
  };

  ctx.provide('session.search.v1', serviceImpl, {
    version: '1.0.0',
    metadata: {
      engineKind: 'fts5',
      title: 'FTS5 会话全文检索',
      supportsResume: true,
      supportsCancel: true,
    },
  });

  const wrapRoute = (resultPromise) =>
    Promise.resolve(resultPromise).then((res) => ({
      status: res?.ok ? 200 : res?.error?.code === 'invalid_request' ? 400 : 500,
      body: res,
    }));

  ctx.routes.register('/status', () => wrapRoute(getStatus()));
  ctx.routes.register('/query', (req) => {
    const input = req.method === 'GET' ? req.query : req.body;
    const normalized = input && typeof input === 'object' ? { ...input } : {};
    if (typeof normalized.limit === 'string') normalized.limit = Number(normalized.limit);
    if (typeof normalized.offset === 'string') normalized.offset = Number(normalized.offset);
    if (typeof normalized.fromTs === 'string') normalized.fromTs = Number(normalized.fromTs);
    if (typeof normalized.toTs === 'string') normalized.toTs = Number(normalized.toTs);
    return wrapRoute(runQuery(normalized));
  });
  ctx.routes.register('/reindex', (req) => wrapRoute(runReindex(req.body || {})));
  ctx.routes.register('/reindex/cancel', () => wrapRoute(cancelReindex()));
  ctx.routes.register('/reindex/resume', (req) => wrapRoute(runReindex({ ...(req.body || {}), mode: 'resume' })));
  ctx.routes.register('/sync', () => wrapRoute(serviceImpl.sync()));

  ctx.slots.register({
    slot: 'workspace.pages',
    id: 'session-search',
    title: '会话搜索 (FTS5)',
    ui: 'ui/panel.html',
    order: 30,
    async onMessage(payload) {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: { code: 'invalid_request', message: '无效请求' } };
      }
      switch (payload.type) {
        case 'query':
          return runQuery(payload.request || payload);
        case 'reindex':
          return runReindex(payload.request || payload);
        case 'getStatus':
          return getStatus();
        case 'cancelReindex':
          return cancelReindex();
        case 'resumeReindex':
          return runReindex({ ...(payload.request || {}), mode: 'resume' });
        case 'sync':
          return serviceImpl.sync();
        default:
          return { ok: false, error: { code: 'invalid_request', message: `未知搜索操作: ${String(payload.type)}` } };
      }
    },
  });
}
