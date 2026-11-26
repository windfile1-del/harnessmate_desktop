const badgeEl = document.getElementById('instance-badge');
const statusEl = document.getElementById('status');
const queryInput = document.getElementById('query');
const searchBtn = document.getElementById('run-search');
const reindexBtn = document.getElementById('run-reindex');
const cancelBtn = document.getElementById('cancel-reindex');
const resumeBtn = document.getElementById('resume-reindex');
const resultsEl = document.getElementById('results');

if (badgeEl && window.harnessMate) {
  badgeEl.textContent = window.harnessMate.instanceId || window.harnessMate.pluginId;
}

function renderStatus(val) {
  if (!val) return;
  statusEl.textContent = `引擎 ${val.engineKind} · 状态 ${val.state} · 已索引 ${val.indexedItems} 条 · 水位 ${val.cursorSeq}`;
  cancelBtn.hidden = !val.activeJob;
  resumeBtn.hidden = !val.resumeAvailable || Boolean(val.activeJob);
}

function renderHits(hits) {
  resultsEl.replaceChildren();
  if (!hits || hits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hit-meta';
    empty.textContent = '暂无匹配结果。';
    resultsEl.appendChild(empty);
    return;
  }
  for (const hit of hits) {
    const card = document.createElement('div');
    card.className = 'hit';
    const title = document.createElement('div');
    title.className = 'hit-title';
    title.textContent = hit.sessionTitle || hit.sessionId;
    const meta = document.createElement('div');
    meta.className = 'hit-meta';
    meta.textContent = `${hit.driverId} · session=${hit.sessionId} · turn=${hit.turnId}#${hit.turnSeq} · item=${hit.itemId}`;
    const snippet = document.createElement('div');
    snippet.className = 'hit-snippet';
    snippet.textContent = hit.snippetText || '';
    card.append(title, meta, snippet);
    resultsEl.appendChild(card);
  }
}

async function refreshStatus() {
  const res = await window.harnessMate.sendToPlugin({ type: 'getStatus' });
  if (res && res.ok) renderStatus(res.value);
}

searchBtn.addEventListener('click', async () => {
  const res = await window.harnessMate.sendToPlugin({ type: 'query', request: { q: queryInput.value, limit: 25, offset: 0 } });
  if (res && res.ok) {
    renderHits(res.value.hits);
    statusEl.textContent = `命中 ${res.value.hits.length} 条 (${res.value.tookMs}ms · Lite)`;
  } else {
    statusEl.textContent = res?.error?.message || '搜索失败';
  }
});

queryInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.isComposing) searchBtn.click();
});

reindexBtn.addEventListener('click', async () => {
  reindexBtn.disabled = true;
  try {
    const res = await window.harnessMate.sendToPlugin({ type: 'reindex', request: { mode: 'full' } });
    if (!res?.ok) statusEl.textContent = res?.error?.message || '重建失败';
    await refreshStatus();
  } finally {
    reindexBtn.disabled = false;
  }
});

cancelBtn.addEventListener('click', async () => {
  await window.harnessMate.sendToPlugin({ type: 'cancelReindex' });
  await refreshStatus();
});

resumeBtn.addEventListener('click', async () => {
  await window.harnessMate.sendToPlugin({ type: 'resumeReindex' });
  await refreshStatus();
});

if (window.harnessMate) {
  void refreshStatus().catch(() => {});
}
