// Measures B4-W3 short interaction latencies (switch session, open file, stop output)
// against an already-started portable EXE (supports both --disable-gpu and default GPU paths).
// Usage: node scripts/b4-w3/interactions.mjs <api-port> <cdp-port> <gpu-mode> <output.json>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const WS = createRequire(new URL('../../packages/daemon/package.json', import.meta.url))('ws');
const [apiPort, debugPort, gpuMode, output] = process.argv.slice(2);
if (!output) throw new Error('Expected: <api-port> <cdp-port> <gpu-mode> <output.json>');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${apiPort}`;

async function api(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function targets() {
  return fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
}

async function connect(target) {
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result);
    }
  });
  return {
    ws,
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 15000);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    async eval(expression) {
      const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
  };
}

const fixtureDir = path.resolve('plugins/examples/hm.plugin.fixed-replay');
const preview = await api('/api/v1/plugins/preview', { mode: 'local_dir', dirPath: fixtureDir });
try {
  await api('/api/v1/plugins/install', {
    mode: 'local_dir',
    dirPath: fixtureDir,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
} catch {}
for (const cap of preview.manifest.permissions) {
  await api(
    `/api/v1/plugins/${preview.manifest.id}/permissions`,
    { workspaceId: '__global__', digest: preview.digest, capability: cap, granted: true },
    'PUT',
  );
}
await api(`/api/v1/plugins/${preview.manifest.id}`, { enabled: true }, 'PATCH');
const harness = (await api('/api/v1/harnesses')).harnesses.find((h) => h.id.includes('fixed-replay'));
const workspace = (await api('/api/v1/workspaces')).workspaces.find((w) => w.name === 'Replay W3');
if (!harness || !workspace) throw new Error('Replay W3 workspace or fixed-replay harness missing');

// Create two sessions: Session A with a README.md file link, Session B for switching + stop-output
const sA = (
  await api('/api/v1/sessions/import-bundle', {
    workspaceId: workspace.id,
    bundle: {
      bundleVersion: 2,
      exportedAt: Date.now(),
      redacted: false,
      session: {
        originalId: `interact-a-${Date.now()}`,
        title: 'Interact Session A',
        harnessId: harness.id,
        harnessKind: harness.kind,
        model: 'replay',
        permissionMode: 'manual',
        cwd: workspace.rootPath,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now(),
        participatingHarnesses: [harness.id],
      },
      items: [],
      events: [
        { seq: 1, type: 'turn.started', turnId: 'ia-1', createdAt: Date.now() - 4000, payload: {} },
        { seq: 2, type: 'message.user', turnId: 'ia-1', createdAt: Date.now() - 3900, payload: { text: '打开文件检查' } },
        {
          seq: 3,
          type: 'message.assistant.completed',
          turnId: 'ia-1',
          createdAt: Date.now() - 3800,
          payload: { text: '请查看 [README.md](README.md#L1) 并验证内容 INTERACT_A_READY。' },
        },
        { seq: 4, type: 'turn.completed', turnId: 'ia-1', createdAt: Date.now() - 3700, payload: {} },
      ],
    },
  })
).session;

const sB = (
  await api('/api/v1/sessions/import-bundle', {
    workspaceId: workspace.id,
    bundle: {
      bundleVersion: 2,
      exportedAt: Date.now(),
      redacted: false,
      session: {
        originalId: `interact-b-${Date.now()}`,
        title: 'Interact Session B',
        harnessId: harness.id,
        harnessKind: harness.kind,
        model: 'replay',
        permissionMode: 'manual',
        cwd: workspace.rootPath,
        createdAt: Date.now() - 3000,
        updatedAt: Date.now(),
        participatingHarnesses: [harness.id],
      },
      items: [],
      events: [
        { seq: 1, type: 'turn.started', turnId: 'ib-1', createdAt: Date.now() - 2000, payload: {} },
        { seq: 2, type: 'message.user', turnId: 'ib-1', createdAt: Date.now() - 1900, payload: { text: '会话 B 测试' } },
        { seq: 3, type: 'message.assistant.completed', turnId: 'ib-1', createdAt: Date.now() - 1800, payload: { text: 'INTERACT_B_READY' } },
        { seq: 4, type: 'turn.completed', turnId: 'ib-1', createdAt: Date.now() - 1700, payload: {} },
      ],
    },
  })
).session;

const shell = await connect((await targets()).find((t) => t.type === 'page'));
await shell.call('Runtime.enable');

// Measure cold reload -> first interactive shell
const reloadStart = Date.now();
await shell.call('Page.reload');
for (let i = 0; i < 120; i++) {
  const ready = await shell
    .eval('document.body.textContent.includes("Interact Session A") && document.body.textContent.includes("Interact Session B")')
    .catch(() => false);
  if (ready) break;
  await sleep(50);
}
const reloadInteractiveMs = Date.now() - reloadStart;

async function clickSession(label) {
  return shell.eval(
    `(()=>{const e=[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent.includes(${JSON.stringify(label)}));if(e){e.click();return true}return false})()`,
  );
}

async function waitForText(marker, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await shell.eval(`document.body.textContent.includes(${JSON.stringify(marker)})`).catch(() => false);
    if (ok) return Date.now() - start;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for marker: ${marker}`);
}

// 1. Open Session A first (warm module)
await clickSession('Interact Session A');
const firstOpenSessionAMs = await waitForText('INTERACT_A_READY');

// 2. Switch Session A -> B and B -> A (3 samples)
const switchLatenciesMs = [];
for (let i = 0; i < 3; i++) {
  const tB = Date.now();
  await clickSession('Interact Session B');
  await waitForText('INTERACT_B_READY');
  switchLatenciesMs.push({ direction: 'A->B', ms: Date.now() - tB });

  const tA = Date.now();
  await clickSession('Interact Session A');
  await waitForText('INTERACT_A_READY');
  switchLatenciesMs.push({ direction: 'B->A', ms: Date.now() - tA });
}

// 3. Open file (click README.md link in Session A -> wait for file content in inspector)
const openFileStart = Date.now();
const clickedLink = await shell.eval(`(() => {
  const links = [...document.querySelectorAll('a, button')].filter(el => el.textContent && el.textContent.includes('README.md'));
  if (!links.length) return false;
  links[links.length - 1].click();
  return true;
})()`);
let openFileMs = null;
if (clickedLink) {
  for (let i = 0; i < 200; i++) {
    const visible = await shell
      .eval('document.body.textContent.includes("Replay navigation") || document.body.textContent.includes("第二行")')
      .catch(() => false);
    if (visible) {
      openFileMs = Date.now() - openFileStart;
      break;
    }
    await sleep(25);
  }
}

// 4. Stop active streaming output latency
await clickSession('Interact Session B');
await waitForText('INTERACT_B_READY');
await api(`/api/v1/sessions/${sB.id}/turns`, {
  text: 'performance fixed 60 seconds',
  requestId: `stop-test-${Date.now()}`,
});
// Wait until streaming output starts appearing and stop button is present
await waitForText('HMREPLAY_0_', 10000);
await sleep(300);
const stopStart = Date.now();
const stopBtnClicked = await shell.eval(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const stopBtn = btns.find(b => (b.textContent || '').trim() === '停止');
  if (!stopBtn) return false;
  stopBtn.click();
  return true;
})()`);
let stopOutputMs = null;
if (!stopBtnClicked) {
  await api(`/api/v1/sessions/${sB.id}/interrupt`, {});
}
for (let i = 0; i < 200; i++) {
  const detail = await api(`/api/v1/sessions/${sB.id}`);
  if (detail.session.status !== 'running' && detail.session.status !== 'awaiting_approval') {
    stopOutputMs = Date.now() - stopStart;
    break;
  }
  await sleep(25);
}

const heap = await shell.call('Runtime.getHeapUsage');
const report = {
  gpuMode,
  reloadInteractiveMs,
  firstOpenSessionAMs,
  switchLatenciesMs,
  switchMedianMs: switchLatenciesMs.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(switchLatenciesMs.length / 2)],
  openFileClicked: clickedLink,
  openFileMs,
  stopBtnClicked,
  stopOutputMs,
  heapUsedMB: Number((heap.usedSize / 1e6).toFixed(2)),
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
shell.ws.close();
