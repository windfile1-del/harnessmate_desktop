import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const instanceId = process.env.HM_INSTANCE_ID || 'hm.plugin.browser-headless';
const storageDir = process.env.HM_HEADLESS_STORAGE_DIR || '';
if (storageDir) fs.mkdirSync(storageDir, { recursive: true });
const stateFile = storageDir ? path.join(storageDir, 'headless-state.json') : '';

let state = {
  currentUrl: '',
  title: '无头浏览器就绪',
  textContent: '请输入网址或加载页面内容。',
  inputValue: '',
  links: [],
  history: [],
  cursor: -1,
  lastSessionId: null,
  status: 'idle',
  error: null,
  updatedAt: Date.now(),
};

if (stateFile && fs.existsSync(stateFile)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (loaded && typeof loaded === 'object') {
      state = { ...state, ...loaded };
    }
  } catch {
    // Ignore corrupt cache
  }
}

function saveState() {
  state.updatedAt = Date.now();
  if (!stateFile) return;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Best-effort persistence
  }
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
}

function parseHtml(html, baseUrl) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : baseUrl;
  const links = [];
  const linkRegex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(html)) && links.length < 30) {
    try {
      const resolved = new URL(m[1], baseUrl).toString();
      const label = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) || resolved;
      links.push({ href: resolved, text: label });
    } catch {
      // Ignore malformed link
    }
  }
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  const textContent = decodeEntities(stripped)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 32_000);
  return { title, textContent, links };
}

async function loadUrl(rawUrl, pushHistory = true, sessionId = null) {
  const target = String(rawUrl || '').trim();
  if (!target) throw new Error('请输入有效网址');
  if (sessionId) state.lastSessionId = sessionId;
  state.error = null;

  if (target.startsWith('data:text/html')) {
    const comma = target.indexOf(',');
    const body = comma >= 0 ? decodeURIComponent(target.slice(comma + 1)) : '';
    const parsed = parseHtml(body, 'data:text/html');
    applySnapshot(target, parsed, pushHistory);
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(target);
  } catch {
    throw new Error(`无效的网址: ${target}`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('无头浏览器仅支持 http:// 或 https://');
  }

  const res = await fetch(parsedUrl.toString(), { signal: AbortSignal.timeout(8000) });
  const contentType = res.headers.get('content-type') || '';
  const rawBody = await res.text();
  const parsed = contentType.includes('html') || /^\s*</.test(rawBody)
    ? parseHtml(rawBody, res.url || parsedUrl.toString())
    : { title: res.url || parsedUrl.toString(), textContent: rawBody.slice(0, 32_000), links: [] };
  applySnapshot(res.url || parsedUrl.toString(), parsed, pushHistory);
}

function applySnapshot(url, parsed, pushHistory) {
  state.currentUrl = url;
  state.title = parsed.title || url;
  state.textContent = parsed.textContent || '(空页面)';
  state.links = parsed.links || [];
  state.status = 'ready';
  if (pushHistory) {
    const head = state.history.slice(0, state.cursor + 1);
    if (head[head.length - 1] !== url) {
      head.push(url);
      if (head.length > 20) head.shift();
    }
    state.history = head;
    state.cursor = head.length - 1;
  }
  saveState();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const sendJson = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && urlPath === '/health') {
      return sendJson(200, { ok: true, instanceId, pid: process.pid });
    }
    if (req.method === 'GET' && urlPath === '/state') {
      return sendJson(200, { ok: true, instanceId, pid: process.pid, state });
    }
    if (req.method === 'POST' && urlPath === '/navigate') {
      const body = await readJson(req);
      await loadUrl(body.url, true, body.sessionId ?? null);
      return sendJson(200, { ok: true, instanceId, pid: process.pid, state });
    }
    if (req.method === 'POST' && urlPath === '/input') {
      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text : '';
      state.inputValue = text;
      saveState();
      return sendJson(200, { ok: true, instanceId, pid: process.pid, state });
    }
    if (req.method === 'POST' && urlPath === '/back') {
      if (state.cursor > 0) {
        state.cursor -= 1;
        await loadUrl(state.history[state.cursor], false);
      }
      return sendJson(200, { ok: true, instanceId, pid: process.pid, state });
    }
    if (req.method === 'POST' && urlPath === '/forward') {
      if (state.cursor + 1 < state.history.length) {
        state.cursor += 1;
        await loadUrl(state.history[state.cursor], false);
      }
      return sendJson(200, { ok: true, instanceId, pid: process.pid, state });
    }
    if (req.method === 'POST' && urlPath === '/reload') {
      if (state.currentUrl) await loadUrl(state.currentUrl, false);
      return sendJson(200, { ok: true, instanceId, pid: process.pid, state });
    }
    if (req.method === 'POST' && urlPath === '/close') {
      state.currentUrl = '';
      state.title = '无头浏览器就绪';
      state.textContent = '已关闭当前无头会话页面。';
      state.links = [];
      state.status = 'idle';
      saveState();
      return sendJson(200, { ok: true, instanceId, pid: process.pid, state });
    }
    return sendJson(404, { error: 'Not found' });
  } catch (err) {
    state.status = 'error';
    state.error = err instanceof Error ? err.message : String(err);
    saveState();
    return sendJson(400, { error: state.error, instanceId, pid: process.pid, state });
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(JSON.stringify({ port: addr.port, pid: process.pid }) + '\n');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
