// Formal Batch 4 B4-W3 performance runner against a real, already-started portable EXE.
// Reuses the exact fixed fixture from scripts/b3-w3/performance.mjs (digest 0c6e535cb7511c17c53503a45ded4ca031c4c275938187f996f51f540e110d29).
// Usage: node scripts/b4-w3/performance.mjs <api-port> <cdp-port> <B4> <output.json>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const WS = createRequire(new URL('../../packages/daemon/package.json', import.meta.url))('ws');
const [apiPort, debugPort, version, output] = process.argv.slice(2);
if (!output) throw new Error('Expected: <api-port> <cdp-port> <B4> <output.json>');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const listeners = new Set();
  ws.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP socket closed'));
    pending.clear();
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result);
    } else {
      for (const listener of listeners) listener(m);
    }
  });
  return {
    target,
    ws,
    listeners,
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
      const r = await this.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
  };
}

const fixtureDir = path.resolve('plugins/examples/hm.plugin.fixed-replay');
const preview = await api('/api/v1/plugins/preview', { mode: 'local_dir', dirPath: fixtureDir });
await api('/api/v1/plugins/install', {
  mode: 'local_dir',
  dirPath: fixtureDir,
  trustCode: true,
  expectedDigest: preview.digest,
  expectedInstalledDigest: preview.installedDigest,
});
for (const capability of preview.manifest.permissions) {
  await api(
    `/api/v1/plugins/${preview.manifest.id}/permissions`,
    { workspaceId: '__global__', digest: preview.digest, capability, granted: true },
    'PUT',
  );
}
await api(`/api/v1/plugins/${preview.manifest.id}`, { enabled: true }, 'PATCH');
const harness = (await api('/api/v1/harnesses')).harnesses.find((h) => h.id.includes('fixed-replay'));
if (!harness) throw new Error('Offline driver missing');
const workspace = (await api('/api/v1/workspaces')).workspaces.find((w) => w.name === 'Replay W3');
if (!workspace) throw new Error('Create Replay W3 workspace first');

const history = [];
for (let i = 0; i < 2500; i++) {
  const turnId = `history-${i}`;
  const time = 1700000000000 + i;
  for (const [type, payload] of [
    ['turn.started', {}],
    ['message.user', { text: `历史问题 ${i}` }],
    ['message.assistant.completed', { text: `历史回答 ${i}\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`` }],
    ['turn.completed', {}],
  ]) {
    history.push({ seq: history.length + 1, type, turnId, createdAt: time, payload });
  }
}

const title = `${version} performance ${Date.now()}`;
const imported = await api('/api/v1/sessions/import-bundle', {
  workspaceId: workspace.id,
  bundle: {
    bundleVersion: 2,
    exportedAt: Date.now(),
    redacted: false,
    session: {
      originalId: title,
      title,
      harnessId: harness.id,
      harnessKind: harness.kind,
      model: 'replay',
      permissionMode: 'manual',
      cwd: workspace.rootPath,
      createdAt: 1700000000000,
      updatedAt: Date.now(),
      participatingHarnesses: [harness.id],
    },
    items: [],
    events: history,
  },
});
const session = imported.session;

const background = [];
for (let i = 0; i < 2; i++) {
  background.push(
    (
      await api('/api/v1/sessions', {
        workspaceId: workspace.id,
        harnessId: harness.id,
        title: `${title} background ${i}`,
        permissionMode: 'manual',
      })
    ).session,
  );
}

const shell = await connect((await targets()).find((t) => t.type === 'page'));
await shell.call('Network.enable');
await shell.call('Performance.enable');
await shell.call('Runtime.enable');

const received = [];
const sent = [];
const exceptions = [];
shell.listeners.add((m) => {
  if (m.method === 'Network.webSocketFrameReceived') {
    try {
      const frame = JSON.parse(m.params.response.payloadData);
      if (['event', 'service_batch'].includes(frame.op)) {
        received.push({ at: Date.now(), frame });
      }
    } catch {}
  }
  if (m.method === 'Network.webSocketFrameSent') {
    try {
      const frame = JSON.parse(m.params.response.payloadData);
      if (String(frame.op).includes('subscribe')) {
        sent.push({ at: Date.now(), frame });
      }
    } catch {}
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
});

// Enable on-demand perf diagnostics before reload/stream
await api('/api/v1/diagnostics/perf', { enabled: true, reset: true });

await shell.call('Page.reload');
const loadStart = Date.now();
let clicked = false;
for (let n = 0; n < 120; n++) {
  clicked = await shell.eval(
    `(()=>{const e=[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent.includes(${JSON.stringify(title)})&&!e.textContent.includes(${JSON.stringify(title + ' background')}));if(e){e.click();return true}return false})()`,
  );
  if (clicked) break;
  await sleep(100);
}
if (!clicked) throw new Error('Session row unavailable');

let page = null;
let mountMode = 'iframe';
for (let n = 0; n < 240; n++) {
  if (!page) {
    const shellHasComposer = await shell
      .eval('!!document.querySelector("textarea[data-session-composer]")')
      .catch(() => false);
    if (shellHasComposer) {
      page = shell;
      mountMode = 'trusted-module';
    } else {
      const tList = await targets();
      const iframes = tList.filter((t) => t.type === 'iframe');
      for (const ifr of iframes) {
        try {
          const c = await connect(ifr);
          const hasComposer = await c
            .eval('!!document.querySelector("textarea[data-session-composer]")')
            .catch(() => false);
          if (hasComposer) {
            page = c;
            mountMode = 'iframe';
            break;
          } else {
            c.ws.close();
          }
        } catch {}
      }
    }
  }
  if (page) {
    const ready = await page.eval('document.body.textContent.includes("历史回答 2499")').catch(() => false);
    if (ready) break;
  }
  if (n === 239) throw new Error('History projection did not become ready');
  await sleep(100);
}
const historyReadyMs = Date.now() - loadStart;

// Enable frontend diagnostics and calibrate cross-process daemon↔renderer clock
await shell.eval('(() => { window.__HM_PERF_DIAG__?.setEnabled(true, true); return true; })()');
const clockCalibration = await shell.eval(`window.__HM_PERF_DIAG__?.calibrateClock(${JSON.stringify(base)})`);

async function collectAllTargetHeaps(runGc = false) {
  const list = (await targets()).filter((t) => t.type === 'page' || t.type === 'iframe');
  const heaps = [];
  for (const t of list) {
    const c = t.id === shell.target.id ? shell : t.id === page.target.id ? page : await connect(t);
    if (runGc) {
      await c.call('HeapProfiler.enable').catch(() => {});
      await c.call('HeapProfiler.collectGarbage').catch(() => {});
    }
    const usage = await c.call('Runtime.getHeapUsage');
    heaps.push({
      type: t.type,
      id: t.id,
      usedSize: usage.usedSize,
      totalSize: usage.totalSize,
    });
    if (c !== shell && c !== page) c.ws.close();
  }
  return heaps;
}

const targetHeapsBefore = await collectAllTargetHeaps(false);
const heapBefore = await page.call('Runtime.getHeapUsage');
const shellHeapBefore = await shell.call('Runtime.getHeapUsage');

await shell.eval(
  `(()=>{window.__shellLongTasks=[];const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__shellLongTasks.push({start:entry.startTime,duration:entry.duration});});observer.observe({entryTypes:['longtask']});window.__stopShellTasks=()=>observer.disconnect();return true})()`,
);

await page.eval(`(()=>{
  const data = window.__replayMetrics = { visible: [], received: [], longTasks: [], started: Date.now() };
  const seen = new Set();
  let scheduled = false;
  const capture = () => {
    scheduled = false;
    const at = Date.now();
    const text = document.body.textContent;
    for (const m of text.matchAll(/HMREPLAY_([0-9]+)_([0-9]+)/g)) {
      const key = m[0];
      if (!seen.has(key)) {
        seen.add(key);
        data.visible.push({ key, index: Number(m[1]), emitted: Number(m[2]), at });
      }
    }
  };
  const observer = new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => requestAnimationFrame(capture));
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  const message = (e) => {
    if (e.data?.type === 'hm:service:batch') {
      data.received.push({ at: Date.now(), batch: e.data.batch });
    }
  };
  window.addEventListener('message', message);
  window.__HM_REPLAY_BATCH_HOOK__ = (batch, at) => {
    data.received.push({ at: typeof at === 'number' ? at : Date.now(), batch });
  };
  const tasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) data.longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  tasks.observe({ entryTypes: ['longtask'] });
  data.stop = () => {
    observer.disconnect();
    tasks.disconnect();
    window.removeEventListener('message', message);
    delete window.__HM_REPLAY_BATCH_HOOK__;
  };
  return true;
})()`);

// Start foreground + 2 background replay streams
await api(`/api/v1/sessions/${session.id}/turns`, {
  text: 'performance fixed 60 seconds',
  requestId: `perf-${Date.now()}`,
});
for (const s of background) {
  await api(`/api/v1/sessions/${s.id}/turns`, {
    text: 'performance background 60 seconds',
    requestId: `perf-${s.id}`,
  });
}

// Continuous draft typing; draft is never auto-sent
for (let i = 0; i < 66; i++) {
  await page.eval(
    `(()=>{const e=document.querySelector('textarea[data-session-composer]')||document.querySelector('textarea');if(e){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(`性能输入 ${i}`)});e.dispatchEvent(new Event('input',{bubbles:true}));}return true})()`,
  );
  await sleep(1000);
}
await sleep(1500);

const finalDraftValue = await page.eval(
  `(() => { const e = document.querySelector('textarea[data-session-composer]') || document.querySelector('textarea'); return e ? e.value : ''; })()`,
);
const metrics = await page.eval('(()=>{window.__replayMetrics.stop();const {stop,...data}=window.__replayMetrics;return data})()');

// Original end-of-run pre-GC heap snapshot across ALL targets (unchanged口径)
const targetHeapsAfter = await collectAllTargetHeaps(false);
const heapAfter = await page.call('Runtime.getHeapUsage');
const shellHeapAfter = await shell.call('Runtime.getHeapUsage');

// Supplemental post-GC retained heap snapshot (does NOT replace original pre-GC budget)
const targetHeapsAfterGc = await collectAllTargetHeaps(true);

const shellLongTasks = await shell.eval('(()=>{window.__stopShellTasks();return window.__shellLongTasks})()');
const stats = await shell.call('Performance.getMetrics');
const daemonDiagnostics = await api('/api/v1/diagnostics/perf?traces=1');
const frontendDiagnostics = await shell.eval('window.__HM_PERF_DIAG__?.snapshot()');
await api('/api/v1/diagnostics/perf', { enabled: false });

const events = [];
let cursor = 10000;
for (;;) {
  const batch = (await api(`/api/v1/sessions/${session.id}/events?afterSeq=${cursor}&limit=500`)).events;
  if (!batch.length) break;
  events.push(...batch);
  cursor = batch.at(-1).seq;
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      version,
      mountMode,
      title,
      session,
      fixture: {
        historyEvents: history.length,
        historyBytes: Buffer.byteLength(JSON.stringify(history)),
        durationSeconds: 60,
        batchesPerSecond: 25,
        backgroundSessions: background.map((s) => s.id),
        digest: preview.digest,
      },
      clockCalibration,
      historyReadyMs,
      finalDraftValue,
      heapBefore,
      heapAfter,
      shellHeapBefore,
      shellHeapAfter,
      targetHeapsBefore,
      targetHeapsAfter,
      targetHeapsAfterGc,
      shellLongTasks,
      shellMetrics: stats.metrics,
      daemonDiagnostics,
      frontendDiagnostics,
      metrics,
      received,
      sent,
      exceptions,
      events,
      telemetryLimits: [
        'B4 records exact daemon runtimeReceivedAt, postCommitAt (after SQLite commit), serverFlushedAt, hostWsReceivedAt, pluginReceivedAt, and DOM+2rAF visible timestamps.',
        'Cross-process timestamps (daemon vs renderer) are calibrated via /api/v1/diagnostics/perf RTT/2 midpoint offset.',
        'Canonical event.createdAt is NOT a post-commit timestamp; B4 uses explicit trace.committedAt.',
        'Visible time is DOM mutation plus two requestAnimationFrame callbacks, not OS compositor frame presentation.',
        'Post-GC retained heap is supplemental only and never replaces the pre-GC end-of-run V8 heap budget.',
      ],
    },
    null,
    2,
  ),
);

const totalHeapAfterBytes = targetHeapsAfter.reduce((sum, item) => sum + item.usedSize, 0);
const totalHeapAfterGcBytes = targetHeapsAfterGc.reduce((sum, item) => sum + item.usedSize, 0);
console.log(
  JSON.stringify({
    version,
    mountMode,
    output,
    historyReadyMs,
    visible: metrics.visible.length,
    pluginBatches: metrics.received.length,
    wsFrames: received.length,
    totalHeapAfterMB: Number((totalHeapAfterBytes / 1e6).toFixed(2)),
    totalHeapAfterGcMB: Number((totalHeapAfterGcBytes / 1e6).toFixed(2)),
    finalDraftPreserved: finalDraftValue === '性能输入 65',
    exceptions: exceptions.length,
  }),
);

page.ws.close();
if (page !== shell) shell.ws.close();
