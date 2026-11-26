const view = window.harnessMate.desktopView;
const image = document.getElementById('preview');
const status = document.getElementById('status');
const url = document.getElementById('url');
const openUrl = document.getElementById('open-url');
const text = document.getElementById('text');
const textEntry = document.getElementById('text-entry');
const badge = document.getElementById('instance-badge');
const historyEl = document.getElementById('history');
const controls = ['back', 'forward', 'reload', 'close'];
let size;

if (badge) badge.textContent = window.harnessMate.instanceId || window.harnessMate.pluginId;

function renderHistory(items) {
  if (!historyEl) return;
  historyEl.replaceChildren();
  for (const item of (items || []).slice(-6).reverse()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    btn.textContent = item;
    btn.addEventListener('click', () => {
      url.value = item;
      openUrl.click();
    });
    historyEl.appendChild(btn);
  }
}

function setOpen(open) {
  for (const id of controls) document.getElementById(id).disabled = !open;
  if (open) return;
  size = undefined;
  image.hidden = true;
  image.removeAttribute('src');
  textEntry.hidden = true;
}

function run(promise) {
  return promise.catch((error) => { status.textContent = error.message; });
}

setOpen(false);
if (!view || !view.available) {
  openUrl.disabled = true;
  status.textContent = '在 HarnessMate Desktop 中使用通用桌面视图。';
}

async function openTargetUrl(targetUrl) {
  await view.mount({ url: targetUrl, width: 1000, height: 640 });
  setOpen(true);
  const res = await window.harnessMate.sendToPlugin({ type: 'recordUrl', url: targetUrl }).catch(() => null);
  if (res && res.state) renderHistory(res.state.history);
}

openUrl.addEventListener('click', () => {
  if (!url.reportValidity()) return;
  void run(openTargetUrl(url.value));
});
url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) openUrl.click();
});
for (const id of controls) {
  document.getElementById(id).addEventListener('click', () => {
    const action = id === 'close' ? view.destroy() : view[id]();
    void run(action.then(() => {
      if (id === 'close') { setOpen(false); status.textContent = '桌面视图已关闭。'; }
    }));
  });
}

view.onFrame((frame) => {
  size = { width: frame.width, height: frame.height };
  image.src = frame.dataUrl;
  image.hidden = false;
  textEntry.hidden = false;
});
view.onStatus((event) => {
  if (event.state === 'loading') status.textContent = '正在加载网页…';
  if (event.state === 'ready') { url.value = event.url || url.value; status.textContent = '点击画面可定位并交互。'; }
  if (event.state === 'error') status.textContent = event.message || '网页载入失败。';
  if (event.state === 'closed') { setOpen(false); status.textContent = event.message || '桌面视图已关闭。'; }
});

function point(event) {
  const bounds = image.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * size.width / bounds.width,
    y: (event.clientY - bounds.top) * size.height / bounds.height,
  };
}
image.addEventListener('click', (event) => {
  if (!size) return;
  image.focus();
  void run(view.focus(true).then(() => view.input({ type: 'click', ...point(event) })));
});
image.addEventListener('wheel', (event) => {
  if (!size) return;
  event.preventDefault();
  void run(view.input({ type: 'wheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }));
}, { passive: false });
image.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (event.key.length === 1) {
    event.preventDefault();
    void run(view.input({ type: 'text', text: event.key }));
    return;
  }
  const key = event.key.replace(/^Arrow/, '');
  if (!['Enter', 'Escape', 'Backspace', 'Delete', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) return;
  event.preventDefault();
  void run(view.input({ type: 'key', key }));
});
const sendText = document.getElementById('send-text');
sendText.addEventListener('click', () => {
  const value = text.value;
  if (!value) return;
  void run(view.input({ type: 'text', text: value }).then(() => {
    if (text.value === value) text.value = '';
  }));
});
text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) sendText.click();
});

void window.harnessMate.sendToPlugin({ type: 'getState' }).then((res) => {
  if (!res || !res.state) return;
  renderHistory(res.state.history);
  if (res.state.currentUrl) {
    url.value = res.state.currentUrl;
    if (view && view.available) void run(openTargetUrl(res.state.currentUrl));
  }
}).catch(() => {});
