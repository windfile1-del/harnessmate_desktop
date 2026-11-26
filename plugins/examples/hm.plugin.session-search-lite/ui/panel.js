const badgeEl = document.getElementById('instance-badge');
const statusEl = document.getElementById('status');
const queryInput = document.getElementById('query');
const workspaceSelect = document.getElementById('workspace-filter');
const driverSelect = document.getElementById('driver-filter');
const fromTsInput = document.getElementById('from-ts');
const toTsInput = document.getElementById('to-ts');
const limitSelect = document.getElementById('limit-select');
const scopeReindexCheckbox = document.getElementById('scope-reindex');
const searchBtn = document.getElementById('run-search');
const clearBtn = document.getElementById('clear-filters');
const syncBtn = document.getElementById('run-sync');
const reindexBtn = document.getElementById('run-reindex');
const cancelBtn = document.getElementById('cancel-reindex');
const resumeBtn = document.getElementById('resume-reindex');
const summaryBar = document.getElementById('summary-bar');
const queryMetaEl = document.getElementById('query-meta');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const pageInfoEl = document.getElementById('page-info');
const resultsEl = document.getElementById('results');

const uiState = {
  instanceId: window.harnessMate?.instanceId || window.harnessMate?.pluginId || 'session-search-lite',
  offset: 0,
  nextOffset: null,
  lastInitialQuery: '',
  workspaceInitialized: false,
  statusTimer: null,
};

function getBridge() {
  return window.harnessMate;
}

async function callPlugin(routeMethod, routePath, opts, legacyPayload) {
  const hm = getBridge();
  if (!hm) {
    return { ok: false, error: { code: 'unavailable', message: '插件桥接尚未初始化' } };
  }
  const instanceId = uiState.instanceId || hm.instanceId;
  if (typeof hm.requestPluginRoute === 'function') {
    try {
      return await hm.requestPluginRoute({
        instanceId,
        method: routeMethod,
        path: routePath,
        query: opts?.query,
        body: opts?.body,
      });
    } catch {
      // Fallback to sendToPlugin
    }
  }
  if (typeof hm.sendToPlugin === 'function') {
    return await hm.sendToPlugin(legacyPayload);
  }
  return { ok: false, error: { code: 'unavailable', message: '无可用的插件调用接口' } };
}

function populateSelectOptions(selectEl, defaultLabel, items, previousValue) {
  selectEl.replaceChildren();
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = defaultLabel;
  selectEl.appendChild(allOpt);
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    selectEl.appendChild(opt);
  }
  if (previousValue && items.some((i) => i.value === previousValue)) {
    selectEl.value = previousValue;
  }
}

function syncScopeCheckboxState() {
  const hasWs = Boolean(workspaceSelect.value);
  scopeReindexCheckbox.disabled = !hasWs;
  if (!hasWs) scopeReindexCheckbox.checked = false;
}

function applyContext(_session, props) {
  const hm = getBridge();
  const nextInstanceId = props?.instanceId || hm?.instanceId || props?.pluginId || hm?.pluginId;
  if (nextInstanceId) {
    uiState.instanceId = nextInstanceId;
    if (badgeEl) badgeEl.textContent = nextInstanceId;
  }

  const workspaces = Array.isArray(props?.workspaces) ? props.workspaces : [];
  const prevWs = uiState.workspaceInitialized
    ? workspaceSelect.value
    : (props?.workspaceId || hm?.workspaceId || '');
  populateSelectOptions(
    workspaceSelect,
    '全部工作区',
    workspaces.map((ws) => ({ value: ws.id, label: ws.name || ws.id })),
    prevWs,
  );
  if (!uiState.workspaceInitialized && prevWs && workspaces.some((ws) => ws.id === prevWs)) {
    workspaceSelect.value = prevWs;
  }
  uiState.workspaceInitialized = true;
  syncScopeCheckboxState();

  const harnesses = Array.isArray(props?.harnesses) ? props.harnesses : [];
  const driverMap = new Map();
  for (const h of harnesses) {
    const val = h.kind || h.id;
    if (val && !driverMap.has(val)) {
      driverMap.set(val, h.displayName ? `${h.displayName} (${val})` : val);
    }
  }
  for (const fallback of ['codex', 'claude', 'opencode', 'gemini']) {
    if (!driverMap.has(fallback)) driverMap.set(fallback, fallback);
  }
  populateSelectOptions(
    driverSelect,
    '全部驱动',
    [...driverMap.entries()].map(([value, label]) => ({ value, label })),
    driverSelect.value,
  );

  const initialQuery = typeof props?.initialQuery === 'string' ? props.initialQuery.trim() : '';
  if (initialQuery && initialQuery !== uiState.lastInitialQuery) {
    uiState.lastInitialQuery = initialQuery;
    queryInput.value = initialQuery;
    void executeSearch(0);
  }
}

function renderStatus(val) {
  if (!val) return;
  const seqText =
    typeof val.latestSourceSeq === 'number'
      ? `${val.cursorSeq}/${val.latestSourceSeq}`
      : String(val.cursorSeq);
  const jobInfo = val.activeJob
    ? ` · 重建中(${val.activeJob.indexedCount}条)`
    : val.lastError
      ? ` · 错误: ${val.lastError}`
      : '';
  statusEl.textContent = `引擎 ${val.engineKind} · 状态 ${val.state} · 已索引 ${val.indexedItems} 条/${val.indexedSessions} 会话 · 水位 ${seqText}${jobInfo}`;
  cancelBtn.hidden = !val.activeJob;
  resumeBtn.hidden = !val.resumeAvailable || Boolean(val.activeJob);

  if (val.activeJob && !uiState.statusTimer) {
    uiState.statusTimer = setInterval(() => {
      void refreshStatus();
    }, 800);
  } else if (!val.activeJob && uiState.statusTimer) {
    clearInterval(uiState.statusTimer);
    uiState.statusTimer = null;
  }
}

function renderHighlightedSnippet(container, hit) {
  const text = String(hit.snippetText || '');
  const spans = Array.isArray(hit.highlights) ? [...hit.highlights] : [];
  spans.sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Number(span.start || 0));
    const end = Math.min(text.length, Number(span.end || 0));
    if (end <= start) continue;
    if (start > cursor) {
      container.appendChild(document.createTextNode(text.slice(cursor, start)));
    }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    container.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) {
    container.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

async function jumpToHit(hit) {
  const hm = getBridge();
  const params = {
    sessionId: hit.sessionId,
    turnId: hit.turnId || undefined,
    itemId: hit.itemId || undefined,
    workspaceId: hit.workspaceId || undefined,
    closeWorkspace: true,
  };
  try {
    if (hm && typeof hm.navigateToSession === 'function') {
      await hm.navigateToSession(params);
    } else if (hm && typeof hm.call === 'function') {
      await hm.call('navigateToSession', params);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'hm:action', action: 'navigateToSession', params, slotId: hm?.slotId, runId: hm?.runId },
        '*',
      );
    }
  } catch (err) {
    if (hm && typeof hm.toast === 'function') {
      void hm.toast('跳转会话失败', err instanceof Error ? err.message : String(err), 'error');
    }
  }
}

function renderHits(hits) {
  resultsEl.replaceChildren();
  if (!hits || hits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Lite 索引暂无匹配结果。可调整筛选条件或点击“重建 Lite 索引 / 增量同步”。';
    resultsEl.appendChild(empty);
    return;
  }
  for (const hit of hits) {
    const card = document.createElement('article');
    card.className = 'hit';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const header = document.createElement('div');
    header.className = 'hit-header';
    const title = document.createElement('div');
    title.className = 'hit-title';
    title.textContent = hit.sessionTitle || hit.sessionId;
    const jump = document.createElement('span');
    jump.className = 'hit-jump';
    jump.textContent = '[Lite] 打开会话 →';
    header.append(title, jump);

    const meta = document.createElement('div');
    meta.className = 'hit-meta';
    const timeText = hit.createdAt ? new Date(hit.createdAt).toLocaleString('zh-CN') : '';
    meta.textContent = [
      hit.workspaceId ? `ws=${hit.workspaceId}` : null,
      hit.driverId,
      hit.blockType,
      `turn=${hit.turnId || '-'}#${hit.turnSeq ?? 0}`,
      `item=${hit.itemId}`,
      timeText,
    ]
      .filter(Boolean)
      .join(' · ');

    const snippet = document.createElement('div');
    snippet.className = 'hit-snippet';
    renderHighlightedSnippet(snippet, hit);

    card.append(header, meta, snippet);
    card.addEventListener('click', () => {
      void jumpToHit(hit);
    });
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        void jumpToHit(hit);
      }
    });
    resultsEl.appendChild(card);
  }
}

function buildQueryRequest(offset) {
  const limit = Number(limitSelect.value) || 25;
  const req = {
    q: queryInput.value,
    limit,
    offset,
  };
  if (workspaceSelect.value) req.workspaceId = workspaceSelect.value;
  if (driverSelect.value) req.driverId = driverSelect.value;
  if (fromTsInput.value) {
    const ms = Date.parse(fromTsInput.value);
    if (Number.isFinite(ms)) req.fromTs = ms;
  }
  if (toTsInput.value) {
    const ms = Date.parse(toTsInput.value);
    if (Number.isFinite(ms)) req.toTs = ms;
  }
  return req;
}

async function executeSearch(offset = 0) {
  const request = buildQueryRequest(offset);
  if (!String(request.q || '').trim()) {
    summaryBar.hidden = true;
    renderHits([]);
    return;
  }
  const res = await callPlugin('POST', '/query', { body: request }, { type: 'query', request });
  if (res && res.ok) {
    uiState.offset = offset;
    uiState.nextOffset = res.value.nextOffset ?? null;
    const hits = Array.isArray(res.value.hits) ? res.value.hits : [];
    renderHits(hits);
    summaryBar.hidden = false;
    queryMetaEl.textContent = `Lite 命中 ${hits.length} 条 (${res.value.tookMs}ms · 倒排检索)`;
    const pageNum = Math.floor(offset / request.limit) + 1;
    pageInfoEl.textContent = `第 ${pageNum} 页 (offset ${offset})`;
    prevPageBtn.disabled = offset <= 0;
    nextPageBtn.disabled = uiState.nextOffset === null;
    void refreshStatus();
  } else {
    statusEl.textContent = res?.error?.message || '搜索失败';
  }
}

async function refreshStatus() {
  const res = await callPlugin('GET', '/status', {}, { type: 'getStatus' });
  if (res && res.ok) renderStatus(res.value);
}

workspaceSelect.addEventListener('change', syncScopeCheckboxState);
searchBtn.addEventListener('click', () => {
  void executeSearch(0);
});
queryInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.isComposing) void executeSearch(0);
});
clearBtn.addEventListener('click', () => {
  queryInput.value = '';
  driverSelect.value = '';
  fromTsInput.value = '';
  toTsInput.value = '';
  summaryBar.hidden = true;
  resultsEl.replaceChildren();
});
prevPageBtn.addEventListener('click', () => {
  const limit = Number(limitSelect.value) || 25;
  void executeSearch(Math.max(0, uiState.offset - limit));
});
nextPageBtn.addEventListener('click', () => {
  if (typeof uiState.nextOffset === 'number') {
    void executeSearch(uiState.nextOffset);
  }
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  try {
    const res = await callPlugin('POST', '/sync', { body: {} }, { type: 'sync' });
    if (!res?.ok) statusEl.textContent = res?.error?.message || '增量同步失败';
    await refreshStatus();
    if (queryInput.value.trim()) await executeSearch(uiState.offset);
  } finally {
    syncBtn.disabled = false;
  }
});

reindexBtn.addEventListener('click', async () => {
  reindexBtn.disabled = true;
  try {
    const request = {
      mode: 'full',
      ...(scopeReindexCheckbox.checked && workspaceSelect.value ? { workspaceId: workspaceSelect.value } : {}),
    };
    const res = await callPlugin('POST', '/reindex', { body: request }, { type: 'reindex', request });
    if (!res?.ok) statusEl.textContent = res?.error?.message || '重建失败';
    await refreshStatus();
    if (queryInput.value.trim()) await executeSearch(0);
  } finally {
    reindexBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', async () => {
  await callPlugin('POST', '/reindex/cancel', { body: {} }, { type: 'cancelReindex' });
  await refreshStatus();
});

resumeBtn.addEventListener('click', async () => {
  await callPlugin('POST', '/reindex/resume', { body: {} }, { type: 'resumeReindex' });
  await refreshStatus();
  if (queryInput.value.trim()) await executeSearch(uiState.offset);
});

if (window.harnessMate) {
  if (badgeEl) badgeEl.textContent = uiState.instanceId;
  applyContext(window.harnessMate.session, window.harnessMate.props || {});
  if (typeof window.harnessMate.onContext === 'function') {
    window.harnessMate.onContext((session, props) => {
      applyContext(session, props || {});
    });
  }
  void refreshStatus().catch(() => {});
}
