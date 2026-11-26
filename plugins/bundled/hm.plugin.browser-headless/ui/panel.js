const urlInput = document.getElementById('url');
const openBtn = document.getElementById('open-url');
const inputEl = document.getElementById('input-text');
const sendInputBtn = document.getElementById('send-input');
const statusEl = document.getElementById('status');
const instanceBadge = document.getElementById('instance-badge');
const workerBadge = document.getElementById('worker-badge');
const titleEl = document.getElementById('page-title');
const bodyEl = document.getElementById('page-body');
const echoEl = document.getElementById('input-echo');
const linksSection = document.getElementById('links-section');
const linksEl = document.getElementById('links');

if (instanceBadge) instanceBadge.textContent = window.harnessMate.instanceId || window.harnessMate.pluginId;

function applyResponse(res) {
  if (!res) return;
  if (workerBadge && res.pid) workerBadge.textContent = `PID ${res.pid}`;
  const state = res.state;
  if (!state) return;
  if (state.currentUrl && urlInput) urlInput.value = state.currentUrl;
  if (titleEl) titleEl.textContent = state.title || state.currentUrl || '无头浏览器就绪';
  if (bodyEl) bodyEl.textContent = state.textContent || '';
  if (echoEl) echoEl.textContent = state.inputValue ? `当前输入缓冲: ${state.inputValue}` : '';
  if (statusEl) {
    statusEl.textContent = state.error
      ? `错误: ${state.error}`
      : state.currentUrl
        ? `已加载 (${state.history?.length || 0} 条历史)`
        : '无头浏览器已就绪。';
  }
  if (linksEl && linksSection) {
    linksEl.replaceChildren();
    const links = state.links || [];
    linksSection.hidden = links.length === 0;
    for (const link of links.slice(0, 12)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn';
      btn.textContent = link.text || link.href;
      btn.title = link.href;
      btn.addEventListener('click', () => void runAction({ type: 'navigate', url: link.href }));
      linksEl.appendChild(btn);
    }
  }
}

async function runAction(payload) {
  try {
    const res = await window.harnessMate.sendToPlugin(payload);
    applyResponse(res);
  } catch (err) {
    if (statusEl) statusEl.textContent = err && err.message ? err.message : String(err);
  }
}

openBtn?.addEventListener('click', () => {
  if (!urlInput?.value.trim()) return;
  void runAction({ type: 'navigate', url: urlInput.value.trim() });
});
urlInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) openBtn?.click();
});
sendInputBtn?.addEventListener('click', () => {
  const val = inputEl?.value ?? '';
  void runAction({ type: 'input', text: val });
});
inputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) sendInputBtn?.click();
});
for (const op of ['back', 'forward', 'reload', 'close']) {
  document.getElementById(op)?.addEventListener('click', () => void runAction({ type: op }));
}

void runAction({ type: 'getState' });
