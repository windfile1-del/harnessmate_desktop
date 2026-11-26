import crypto from 'node:crypto';

export const requires = ['ui.workspace.pages'];

const READ_MODEL_CONTRACTS = ['hm.session-data.v1', 'session.readModel.v1', 'session.changes.v1'];
const MAX_STORAGE_CHUNK_BYTES = 180 * 1024;
const DEFAULT_BATCH_SIZE = 20;

function extractSearchTerms(raw) {
  const stripped = String(raw ?? '')
    .replace(/["*^():+~]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^-+/, '').trim())
    .filter((tok) => tok.length > 0);
  const unique = [...new Set(stripped.length > 0 ? stripped : [String(raw ?? '').trim()].filter(Boolean))];
  return unique.sort((a, b) => b.length - a.length);
}

function tokenizeForLiteIndex(text) {
  const lower = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const word of lower.split(/[^a-z0-9_\u4e00-\u9fff-]+/)) {
    if (!word) continue;
    tokens.add(word);
    // Add CJK unigrams & bigrams for substring lookup without SQLite FTS5
    const cjk = word.match(/[\u4e00-\u9fff]+/g);
    if (cjk) {
      for (const run of cjk) {
        for (let i = 0; i < run.length; i += 1) {
          tokens.add(run[i]);
          if (i + 1 < run.length) tokens.add(run.slice(i, i + 2));
        }
      }
    }
  }
  return tokens;
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

export async function apply(ctx, config = {}) {
  const batchSize = Math.max(1, Math.min(200, Number(config.batchSize) || DEFAULT_BATCH_SIZE));
  const readModelContractOverride =
    typeof config.readModelContract === 'string' && config.readModelContract.trim()
      ? config.readModelContract.trim()
      : null;

  let disposed = false;
  let generation = 1;
  let cancelRequested = false;
  let activeReindexPromise = null;
  let lastError = null;

  // Per-instance in-memory lite inverted index backed by ctx.storage.plugin
  const itemsById = new Map();
  const itemTokens = new Map();
  const invertedIndex = new Map();
  let syncState = {
    cursorSeq: 0,
    snapshotId: null,
    snapshotWatermark: null,
    snapshotCursor: null,
    reindexState: 'idle',
    job: null,
  };

  function unindexItem(itemId) {
    const oldTokens = itemTokens.get(itemId);
    if (oldTokens) {
      for (const tok of oldTokens) {
        const bucket = invertedIndex.get(tok);
        if (bucket) {
          bucket.delete(itemId);
          if (bucket.size === 0) invertedIndex.delete(tok);
        }
      }
      itemTokens.delete(itemId);
    }
    itemsById.delete(itemId);
  }

  function indexItem(raw) {
    if (!raw || !raw.itemId) return false;
    if (!isSearchableItem(raw)) {
      unindexItem(raw.itemId);
      return false;
    }
    unindexItem(raw.itemId);
    const normalized = {
      itemId: String(raw.itemId),
      sessionId: String(raw.sessionId),
      sessionTitle: String(raw.sessionTitle || ''),
      workspaceId: String(raw.workspaceId || ''),
      turnId: String(raw.turnId || ''),
      turnSeq: Number(raw.turnSeq || 0),
      driverId: String(raw.driverId || 'unknown'),
      harnessId: String(raw.harnessId || raw.driverId || 'unknown'),
      blockType: String(raw.blockType || 'assistant_text'),
      textBody: String(raw.textBody),
      createdAt: Number(raw.createdAt ?? raw.updatedAt ?? Date.now()),
      updatedAt: Number(raw.updatedAt ?? raw.createdAt ?? Date.now()),
    };
    itemsById.set(normalized.itemId, normalized);
    const tokens = tokenizeForLiteIndex(`${normalized.sessionTitle} ${normalized.textBody}`);
    itemTokens.set(normalized.itemId, tokens);
    for (const tok of tokens) {
      let bucket = invertedIndex.get(tok);
      if (!bucket) {
        bucket = new Set();
        invertedIndex.set(tok, bucket);
      }
      bucket.add(normalized.itemId);
    }
    return true;
  }

  function applyChange(change) {
    if (!change || typeof change !== 'object') return;
    if (change.kind === 'upsert_item' && change.item) {
      indexItem(change.item);
    } else if (change.kind === 'upsert_session') {
      const title = change.session?.title ?? change.sessionTitle ?? '';
      const workspaceId = change.session?.workspaceId ?? change.workspaceId ?? '';
      const updatedAt = Number(change.session?.updatedAt ?? change.updatedAt ?? change.committedAt ?? Date.now());
      for (const [id, item] of [...itemsById.entries()]) {
        if (item.sessionId === change.sessionId) {
          indexItem({
            ...item,
            sessionTitle: title,
            workspaceId: workspaceId || item.workspaceId,
            updatedAt: Math.max(item.updatedAt, updatedAt),
          });
        }
      }
    } else if (change.kind === 'delete_session') {
      for (const [id, item] of [...itemsById.entries()]) {
        if (item.sessionId === change.sessionId) unindexItem(id);
      }
    } else if (change.kind === 'delete_item') {
      const targetItemId = change.itemId ?? change.item?.itemId;
      if (targetItemId) unindexItem(targetItemId);
    }
  }

  async function persistState() {
    if (disposed) return;
    try {
      const allItems = [...itemsById.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.itemId.localeCompare(b.itemId),
      );
      const chunks = [];
      let current = [];
      for (const item of allItems) {
        current.push(item);
        if (Buffer.byteLength(JSON.stringify(current), 'utf8') > MAX_STORAGE_CHUNK_BYTES && current.length > 1) {
          current.pop();
          chunks.push(current);
          current = [item];
        }
      }
      if (current.length > 0) chunks.push(current);

      const oldKeys = await ctx.storage.plugin.keys();
      await ctx.storage.plugin.set('lite:meta', { ...syncState, chunkCount: chunks.length });
      for (let i = 0; i < chunks.length; i += 1) {
        await ctx.storage.plugin.set(`lite:chunk:${i}`, chunks[i]);
      }
      for (const key of oldKeys) {
        if (key.startsWith('lite:chunk:')) {
          const idx = Number.parseInt(key.slice('lite:chunk:'.length), 10);
          if (!Number.isFinite(idx) || idx >= chunks.length) {
            await ctx.storage.plugin.delete(key);
          }
        }
      }
    } catch {
      // Storage is optional if not granted
    }
  }

  async function restoreState() {
    if (disposed) return;
    try {
      const meta = await ctx.storage.plugin.get('lite:meta');
      if (!meta || typeof meta !== 'object') return;
      const chunkCount = Number(meta.chunkCount || 0);
      for (let i = 0; i < chunkCount; i += 1) {
        const chunk = await ctx.storage.plugin.get(`lite:chunk:${i}`);
        if (Array.isArray(chunk)) {
          for (const item of chunk) indexItem(item);
        }
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
      syncState = {
        cursorSeq: Number(meta.cursorSeq || 0),
        snapshotId: meta.snapshotId ?? null,
        snapshotWatermark: meta.snapshotWatermark ?? null,
        snapshotCursor: meta.snapshotCursor ?? null,
        reindexState,
        job,
      };
    } catch {
      // Ignore if storage empty or denied
    }
  }

  await restoreState();

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
      snapshotId: opts?.snapshotId ?? `lite_snap_${Date.now()}`,
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

  async function syncIncremental() {
    if (disposed) return { appliedChanges: 0, cursorSeq: syncState.cursorSeq };
    const startGen = generation;
    let appliedChanges = 0;

    while (!disposed && generation === startGen) {
      const page = await readChangesViaHost(syncState.cursorSeq);
      if (disposed || generation !== startGen) break;
      const list = Array.isArray(page?.changes) ? page.changes : [];
      if (list.length === 0) {
        if (typeof page?.latestSeq === 'number' && page.latestSeq > syncState.cursorSeq) {
          syncState.cursorSeq = page.latestSeq;
          await persistState();
        }
        break;
      }

      const maxBatchSeq = list[list.length - 1].changeSeq;
      for (const change of list) {
        applyChange(change);
        appliedChanges += 1;
      }
      syncState.cursorSeq = Math.max(syncState.cursorSeq, Number(maxBatchSeq || 0));
      await persistState();
      if (!page.hasMore) break;
    }

    return { appliedChanges, cursorSeq: syncState.cursorSeq };
  }

  async function runReindex(req = {}) {
    if (disposed) {
      return { ok: false, error: { code: 'cancelled', message: '搜索插件实例已停止' } };
    }
    if (activeReindexPromise) {
      return { ok: true, value: await activeReindexPromise };
    }

    const mode = req.mode === 'incremental' || req.mode === 'resume' ? req.mode : 'full';
    if (mode === 'incremental') {
      const now = Date.now();
      const jobId = typeof req.jobId === 'string' && req.jobId.trim()
        ? req.jobId.trim()
        : `reindex_lite_${crypto.randomBytes(5).toString('hex')}`;
      const syncRes = await syncIncremental();
      const done = {
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
      syncState = { ...syncState, snapshotId: null, snapshotWatermark: null, snapshotCursor: null, reindexState: 'idle', job: done };
      await persistState();
      return { ok: true, value: done };
    }

    cancelRequested = false;
    const runGen = generation;

    const task = (async () => {
      const canResume =
        mode === 'resume' &&
        Boolean(syncState.snapshotId || syncState.snapshotCursor !== null || syncState.snapshotWatermark !== null);
      const now = Date.now();
      let job = canResume && syncState.job
        ? { ...syncState.job, mode: 'resume', status: 'running', updatedAt: now, finishedAt: null, error: null }
        : {
            jobId:
              typeof req.jobId === 'string' && req.jobId.trim()
                ? req.jobId.trim()
                : `reindex_lite_${crypto.randomBytes(5).toString('hex')}`,
            mode: 'full',
            status: 'running',
            indexedCount: 0,
            deletedCount: 0,
            cursorSeq: syncState.cursorSeq,
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
        if (req.workspaceId) {
          for (const [id, item] of [...itemsById.entries()]) {
            if (item.workspaceId === req.workspaceId) unindexItem(id);
          }
        } else {
          itemsById.clear();
          itemTokens.clear();
          invertedIndex.clear();
        }
        syncState.snapshotId = null;
        syncState.snapshotWatermark = null;
        syncState.snapshotCursor = null;
      }
      syncState.reindexState = 'running';
      syncState.job = job;
      await persistState();

      let snapshotId = canResume ? (syncState.snapshotId ?? undefined) : undefined;
      let cursor = canResume ? syncState.snapshotCursor : null;
      let watermarkSeq = canResume ? syncState.snapshotWatermark : null;

      try {
        while (true) {
          if (disposed || cancelRequested || generation !== runGen) {
            job = {
              ...job,
              status: 'cancelled',
              resumeAvailable: Boolean(snapshotId || cursor !== null || watermarkSeq !== null),
              updatedAt: Date.now(),
            };
            syncState = { ...syncState, snapshotId: snapshotId ?? null, snapshotWatermark: watermarkSeq ?? null, snapshotCursor: cursor ?? null, reindexState: 'cancelled', job };
            await persistState();
            return job;
          }

          let page;
          try {
            page = await readSnapshotViaHost({
              snapshotId,
              cursor,
              limit: batchSize,
              ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
            });
          } catch {
            page = await readSnapshotViaHost({
              limit: batchSize,
              ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
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
            syncState = { ...syncState, snapshotId: job.snapshotId, snapshotWatermark: job.snapshotWatermark, snapshotCursor: cursor ?? null, reindexState: 'cancelled', job };
            await persistState();
            return job;
          }

          snapshotId = page.snapshotId;
          watermarkSeq = page.watermarkSeq;
          const nextCursor = page.nextCursor ?? null;

          for (const item of page.items ?? []) {
            if (indexItem(item)) job.indexedCount += 1;
          }
          job.snapshotId = nextCursor ? snapshotId : null;
          job.snapshotWatermark = watermarkSeq;
          job.snapshotCursor = nextCursor;
          job.resumeAvailable = Boolean(nextCursor);
          job.updatedAt = Date.now();

          if (!nextCursor) {
            syncState.cursorSeq = Math.max(syncState.cursorSeq, Number(watermarkSeq || 0));
            job.cursorSeq = syncState.cursorSeq;
            syncState.snapshotId = null;
            syncState.snapshotWatermark = null;
            syncState.snapshotCursor = null;
          } else {
            syncState.snapshotId = snapshotId;
            syncState.snapshotWatermark = watermarkSeq;
            syncState.snapshotCursor = nextCursor;
          }
          syncState.reindexState = 'running';
          syncState.job = job;
          await persistState();

          if (!nextCursor) break;
          cursor = nextCursor;
          await new Promise((resolve) => setImmediate(resolve));
        }

        const catchup = await syncIncremental();
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
        syncState = { ...syncState, snapshotId: null, snapshotWatermark: null, snapshotCursor: null, reindexState: 'idle', job };
        await persistState();
        return job;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        job = { ...job, status: 'failed', error: message, updatedAt: Date.now(), finishedAt: Date.now() };
        if (!disposed) {
          syncState = { ...syncState, snapshotId: snapshotId ?? null, snapshotWatermark: watermarkSeq ?? null, snapshotCursor: cursor ?? null, reindexState: 'error', job };
          await persistState();
        }
        throw err;
      }
    })();

    const promise = task.finally(() => {
      if (activeReindexPromise === promise) activeReindexPromise = null;
    });
    activeReindexPromise = promise;
    try {
      return { ok: true, value: await activeReindexPromise };
    } catch (err) {
      return { ok: false, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } };
    }
  }

  function runQuery(req = {}) {
    const start = Date.now();
    const rawQuery = typeof req.q === 'string' ? req.q.trim() : '';
    if (!rawQuery) {
      return { ok: true, value: { hits: [], nextOffset: null, fallbackUsed: false, tookMs: 0 } };
    }
    const limit = Math.min(100, Math.max(1, Number(req.limit ?? 25) || 25));
    const offset = Math.max(0, Number(req.offset ?? 0) || 0);
    const terms = extractSearchTerms(rawQuery);
    const queryTokens = [...tokenizeForLiteIndex(rawQuery)];

    // Candidate intersection from inverted index; falls back to full scan if needed
    let candidateIds = null;
    if (!req.forceLikeFallback && queryTokens.length > 0) {
      for (const tok of queryTokens) {
        const bucket = invertedIndex.get(tok);
        if (!bucket || bucket.size === 0) {
          candidateIds = new Set();
          break;
        }
        if (candidateIds === null) {
          candidateIds = new Set(bucket);
        } else {
          for (const id of candidateIds) {
            if (!bucket.has(id)) candidateIds.delete(id);
          }
        }
      }
    }

    const candidates = candidateIds === null
      ? [...itemsById.values()]
      : [...candidateIds].map((id) => itemsById.get(id)).filter(Boolean);

    const matched = [];
    for (const item of candidates) {
      if (typeof req.workspaceId === 'string' && req.workspaceId && item.workspaceId !== req.workspaceId) continue;
      if (
        typeof req.driverId === 'string' &&
        req.driverId &&
        item.driverId !== req.driverId &&
        item.harnessId !== req.driverId
      ) {
        continue;
      }
      if (typeof req.fromTs === 'number' && Number.isFinite(req.fromTs) && item.createdAt < req.fromTs) continue;
      if (typeof req.toTs === 'number' && Number.isFinite(req.toTs) && item.createdAt > req.toTs) continue;

      const haystack = `${item.sessionTitle}\n${item.textBody}`.toLowerCase();
      let score = 0;
      let allTermsHit = true;
      for (const term of terms) {
        const needle = term.toLowerCase();
        if (!needle) continue;
        const idx = haystack.indexOf(needle);
        if (idx < 0) {
          allTermsHit = false;
          break;
        }
        score += 10 + (item.sessionTitle.toLowerCase().includes(needle) ? 5 : 0);
      }
      if (!allTermsHit) continue;
      matched.push({ item, score });
    }

    matched.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt || a.item.itemId.localeCompare(b.item.itemId));
    const slice = matched.slice(offset, offset + limit);
    const nextOffset = offset + slice.length < matched.length ? offset + slice.length : null;

    const hits = slice.map(({ item }) => {
      const snippet = buildSafeHighlightedSnippet(item.textBody || item.sessionTitle, terms);
      return {
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle,
        workspaceId: item.workspaceId,
        turnId: item.turnId,
        turnSeq: item.turnSeq,
        itemId: item.itemId,
        blockType: item.blockType,
        snippetText: snippet.text,
        snippetHtmlSafe: snippet.htmlSafe,
        highlights: snippet.highlights,
        driverId: item.driverId,
        createdAt: item.createdAt,
      };
    });

    return {
      ok: true,
      value: {
        hits,
        nextOffset,
        fallbackUsed: Boolean(req.forceLikeFallback),
        tookMs: Math.max(0, Date.now() - start),
      },
    };
  }

  async function getStatus() {
    let latestSourceSeq = null;
    try {
      const contract = await resolveReadModelContract();
      if (contract) {
        const page = await ctx.services.call(contract, 'readCommittedChanges', [
          { afterSeq: syncState.cursorSeq, limit: 1 },
        ]);
        if (typeof page?.latestSeq === 'number' && Number.isFinite(page.latestSeq)) {
          latestSourceSeq = page.latestSeq;
        }
      }
    } catch {
      latestSourceSeq = null;
    }
    const sessions = new Set();
    for (const item of itemsById.values()) sessions.add(item.sessionId);
    const job = syncState.job;
    const activeJob = job && (job.status === 'running' || job.status === 'queued') ? job : null;
    return {
      ok: true,
      value: {
        instanceId: ctx.instanceId,
        pluginId: ctx.pluginId,
        engineKind: 'lite',
        state: activeJob ? 'reindexing' : lastError ? 'error' : 'idle',
        cursorSeq: syncState.cursorSeq,
        latestSourceSeq,
        indexedItems: itemsById.size,
        indexedSessions: sessions.size,
        activeJob,
        lastJob: job,
        resumeAvailable: Boolean(syncState.snapshotId || syncState.snapshotCursor !== null || syncState.snapshotWatermark !== null),
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
    return {
      ok: true,
      value: {
        jobId: syncState.job?.jobId ?? null,
        status: syncState.job?.status ?? 'idle',
        cancelled: false,
        cursorSeq: syncState.cursorSeq,
        resumeAvailable: Boolean(syncState.snapshotId || syncState.snapshotCursor !== null || syncState.snapshotWatermark !== null),
      },
    };
  }

  let syncQueue = Promise.resolve();
  const scheduleCatchup = () => {
    if (disposed) return;
    const g = generation;
    syncQueue = syncQueue
      .then(async () => {
        if (disposed || generation !== g) return;
        await syncIncremental().catch(() => {});
      })
      .catch(() => {});
  };

  for (const eventName of ['turn.completed', 'message.user', 'message.assistant.completed']) {
    ctx.events.on(eventName, () => {
      scheduleCatchup();
    });
  }

  if (syncState.cursorSeq > 0 || config.autoSyncOnStart === true) {
    scheduleCatchup();
  }

  ctx.effect(() => () => {
    disposed = true;
    generation += 1;
    cancelRequested = true;
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
      return { ok: true, value: await syncIncremental() };
    },
  };

  ctx.provide('session.search.v1', serviceImpl, {
    version: '1.0.0',
    metadata: {
      engineKind: 'lite',
      title: '轻量会话检索 (Lite)',
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
    title: '会话搜索 (Lite)',
    ui: 'ui/panel.html',
    order: 35,
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
