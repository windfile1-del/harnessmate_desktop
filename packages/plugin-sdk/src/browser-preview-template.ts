export const browserPreviewTemplate = {
  'ui/panel.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>浏览器预览</title>
  <link rel="stylesheet" href="./panel.css">
</head>
<body>
  <div id="navigation" class="row">
    <input id="url" type="url" placeholder="http://localhost:3000" aria-label="网页地址" required>
    <button id="open-url" type="button">打开</button>
  </div>
  <div class="row" aria-label="网页控制">
    <button id="back" type="button">后退</button>
    <button id="forward" type="button">前进</button>
    <button id="reload" type="button">刷新</button>
    <button id="close" type="button">关闭</button>
  </div>
  <p id="status" role="status">输入要预览的网页地址。</p>
  <img id="preview" alt="网页实时预览" draggable="false" tabindex="0" hidden>
  <div id="text-entry" class="row" hidden>
    <input id="text" type="text" placeholder="输入到已聚焦的网页控件" aria-label="网页文本输入">
    <button id="send-text" type="button">输入</button>
  </div>
  <script src="./panel.js"></script>
</body>
</html>
`,
  'ui/panel.css': `body { margin: 8px; color: var(--text-primary, #e5e7eb); font: 12px system-ui; }
.row { display: flex; gap: 5px; margin-bottom: 6px; }
[hidden] { display: none !important; }
input, button { color: inherit; padding: 5px; background: var(--bg-surface, #171923); border: 1px solid var(--border-hairline, #3d4352); border-radius: 5px; }
input { flex: 1; min-width: 0; }
button { cursor: pointer; }
#status { color: var(--text-secondary, #aeb7c8); overflow-wrap: anywhere; }
#preview { width: 100%; border-radius: 4px; margin-bottom: 6px; cursor: default; }
#preview:focus-visible { outline: 2px solid var(--accent-indigo, #889cf8); }
`,
  'ui/panel.js': `const browser = window.harnessMate.browser;
const image = document.getElementById('preview');
const status = document.getElementById('status');
const url = document.getElementById('url');
const openUrl = document.getElementById('open-url');
const text = document.getElementById('text');
const textEntry = document.getElementById('text-entry');
const controls = ['back', 'forward', 'reload', 'close'];
let size;

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
if (!browser.available) {
  openUrl.disabled = true;
  status.textContent = '在 HarnessMate Desktop 中打开此面板。';
}

openUrl.addEventListener('click', () => {
  if (!url.reportValidity()) return;
  void run(browser.open({ url: url.value, width: 1000, height: 700 }).then(() => setOpen(true)));
});
url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) openUrl.click();
});
for (const id of controls) {
  document.getElementById(id).addEventListener('click', () => {
    void run(browser[id]().then(() => {
      if (id === 'close') { setOpen(false); status.textContent = '浏览器已关闭。'; }
    }));
  });
}

browser.onFrame((frame) => {
  size = { width: frame.width, height: frame.height };
  image.src = frame.dataUrl;
  image.hidden = false;
  textEntry.hidden = false;
});
browser.onStatus((event) => {
  if (event.state === 'loading') status.textContent = '正在打开网页…';
  if (event.state === 'ready') { url.value = event.url; status.textContent = '点击画面可操作网页。'; }
  if (event.state === 'error') status.textContent = event.message || '网页载入失败。';
  if (event.state === 'closed') { setOpen(false); status.textContent = event.message || '浏览器已关闭。'; }
});

function point(event) {
  const bounds = image.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) * size.width / bounds.width,
    y: (event.clientY - bounds.top) * size.height / bounds.height };
}
image.addEventListener('click', (event) => {
  if (!size) return;
  image.focus();
  void run(browser.input({ type: 'click', ...point(event) }));
});
image.addEventListener('wheel', (event) => {
  if (!size) return;
  event.preventDefault();
  void run(browser.input({ type: 'wheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }));
}, { passive: false });
image.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (event.key.length === 1) {
    event.preventDefault();
    void run(browser.input({ type: 'text', text: event.key }));
    return;
  }
  const key = event.key.replace(/^Arrow/, '');
  if (!['Enter', 'Escape', 'Backspace', 'Delete', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) return;
  event.preventDefault();
  void run(browser.input({ type: 'key', key }));
});
const sendText = document.getElementById('send-text');
sendText.addEventListener('click', () => {
  const value = text.value;
  if (!value) return;
  void run(browser.input({ type: 'text', text: value }).then(() => {
    if (text.value === value) text.value = '';
  }));
});
text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) sendText.click();
});
`,
  'README.md': '# 浏览器预览\n\n在插件中心授权 `browser:preview`，然后从任意会话的右侧插件面板打开。修改 `ui/panel.*` 即可定制控件和预览内容。\n',
};
