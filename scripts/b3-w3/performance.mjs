// Run against a real, already-started portable EXE. No private stores are inspected.
// node scripts/b3-w3/performance.mjs <api-port> <cdp-port> <B2|B3> <output.json>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const WS = createRequire(new URL('../../packages/daemon/package.json', import.meta.url))('ws');
const [apiPort, debugPort, version, output] = process.argv.slice(2);
if (!output) throw new Error('Expected api-port cdp-port version output.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = `http://127.0.0.1:${apiPort}`;
async function api(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function targets() { return fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json()); }
async function connect(target) {
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let seq = 0; const pending = new Map(), listeners = new Set();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); } else for (const listener of listeners) listener(m); });
  return { ws, listeners, call: (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }),
    async eval(expression) { const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; } };
}
const fixtureDir = path.resolve('plugins/examples/hm.plugin.fixed-replay');
const preview = await api('/api/v1/plugins/preview', { mode: 'local_dir', dirPath: fixtureDir });
await api('/api/v1/plugins/install', { mode: 'local_dir', dirPath: fixtureDir, trustCode: true, expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest });
for (const capability of preview.manifest.permissions) await api(`/api/v1/plugins/${preview.manifest.id}/permissions`, { workspaceId: '__global__', digest: preview.digest, capability, granted: true }, 'PUT');
const harness = (await api('/api/v1/harnesses')).harnesses.find(h => h.id.includes('fixed-replay'));
if (!harness) throw new Error('Offline driver missing');
const workspace = (await api('/api/v1/workspaces')).workspaces.find(w => w.name === 'Replay W3');
if (!workspace) throw new Error('Create Replay W3 workspace first');
const history = [];
for (let i = 0; i < 2500; i++) {
  const turnId = `history-${i}`, time = 1700000000000 + i;
  for (const [type, payload] of [['turn.started', {}], ['message.user', { text: `历史问题 ${i}` }], ['message.assistant.completed', { text: `历史回答 ${i}\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`` }], ['turn.completed', {}]]) history.push({ seq: history.length + 1, type, turnId, createdAt: time, payload });
}
const title = `${version} performance ${Date.now()}`;
const imported = await api('/api/v1/sessions/import-bundle', { workspaceId: workspace.id, bundle: { bundleVersion: 2, exportedAt: Date.now(), redacted: false,
  session: { originalId: title, title, harnessId: harness.id, harnessKind: harness.kind, model: 'replay', permissionMode: 'manual', cwd: workspace.rootPath, createdAt: 1700000000000, updatedAt: Date.now(), participatingHarnesses: [harness.id] }, items: [], events: history } });
const session = imported.session;
const background = [];
for (let i = 0; i < 2; i++) background.push((await api('/api/v1/sessions', { workspaceId: workspace.id, harnessId: harness.id, title: `${title} background ${i}`, permissionMode: 'manual' })).session);
const shell = await connect((await targets()).find(t => t.type === 'page'));
await shell.call('Network.enable'); await shell.call('Performance.enable');
const received = [], sent = [], exceptions = [];
shell.listeners.add(m => {
  if (m.method === 'Network.webSocketFrameReceived') { try { const frame = JSON.parse(m.params.response.payloadData); if (['event', 'service_batch'].includes(frame.op)) received.push({ at: Date.now(), frame }); } catch {} }
  if (m.method === 'Network.webSocketFrameSent') { try { const frame = JSON.parse(m.params.response.payloadData); if (String(frame.op).includes('subscribe')) sent.push({ at: Date.now(), frame }); } catch {} }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params);
});
await shell.call('Runtime.enable');
await shell.call('Page.reload');
const loadStart = Date.now();
let clicked = false;
for (let n = 0; n < 120; n++) { clicked = await shell.eval(`(()=>{const e=[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent.includes(${JSON.stringify(title)})&&!e.textContent.includes(${JSON.stringify(title + ' background')}));if(e){e.click();return true}return false})()`); if (clicked) break; await sleep(250); }
if (!clicked) throw new Error('Session row unavailable');
let page = shell;
for (let n = 0; n < 160; n++) {
  if (version === 'B3') { const iframe = (await targets()).find(t => t.type === 'iframe'); if (iframe && page === shell) page = await connect(iframe); }
  try { if (await page.eval('!!document.querySelector("textarea") && document.body.textContent.includes("历史回答 2499")')) break; } catch {}
  if (n === 159) throw new Error('History projection did not become ready');
  await sleep(250);
}
const historyReadyMs = Date.now() - loadStart;
const heapBefore = await page.call('Runtime.getHeapUsage');
const shellHeapBefore = await shell.call('Runtime.getHeapUsage');
await shell.eval(`(()=>{window.__shellLongTasks=[];const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__shellLongTasks.push({start:entry.startTime,duration:entry.duration});});observer.observe({entryTypes:['longtask']});window.__stopShellTasks=()=>observer.disconnect();return true})()`);
await page.eval(`(()=>{
  const data=window.__replayMetrics={visible:[],received:[],longTasks:[],frames:[],started:Date.now()};
  const seen=new Set(); let scheduled=false;
  const capture=()=>{scheduled=false;const at=Date.now();const text=document.body.textContent;for(const m of text.matchAll(/HMREPLAY_([0-9]+)_([0-9]+)/g)){const key=m[0];if(!seen.has(key)){seen.add(key);data.visible.push({key,index:Number(m[1]),emitted:Number(m[2]),at});}}};
  const observer=new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>requestAnimationFrame(capture));}});observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  const message=e=>{if(e.data?.type==='hm:service:batch')data.received.push({at:Date.now(),batch:e.data.batch});};window.addEventListener('message',message);
  const tasks=new PerformanceObserver(list=>{for(const entry of list.getEntries())data.longTasks.push({start:entry.startTime,duration:entry.duration});});tasks.observe({entryTypes:['longtask']});
  data.stop=()=>{observer.disconnect();tasks.disconnect();window.removeEventListener('message',message);};
  return true;
})()`);
await api(`/api/v1/sessions/${session.id}/turns`, { text: 'performance fixed 60 seconds', requestId: `perf-${Date.now()}` });
for (const s of background) await api(`/api/v1/sessions/${s.id}/turns`, { text: 'performance background 60 seconds', requestId: `perf-${s.id}` });
// Typing remains active during the entire stream; recovered text is never sent.
for (let i = 0; i < 66; i++) {
  await page.eval(`(()=>{const e=document.querySelector('textarea');if(e){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(`性能输入 ${i}`)});e.dispatchEvent(new Event('input',{bubbles:true}));}return true})()`);
  await sleep(1000);
}
await sleep(1500);
const metrics = await page.eval('(()=>{window.__replayMetrics.stop();const {stop,...data}=window.__replayMetrics;return data})()');
const heapAfter = await page.call('Runtime.getHeapUsage');
const shellHeapAfter = await shell.call('Runtime.getHeapUsage');
const shellLongTasks = await shell.eval('(()=>{window.__stopShellTasks();return window.__shellLongTasks})()');
const stats = await shell.call('Performance.getMetrics');
const events = [];
let cursor = 10000;
for (;;) {
  const batch = (await api(`/api/v1/sessions/${session.id}/events?afterSeq=${cursor}&limit=500`)).events;
  if (!batch.length) break;
  events.push(...batch); cursor = batch.at(-1).seq;
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ version, title, session, fixture: { historyEvents: history.length, historyBytes: Buffer.byteLength(JSON.stringify(history)), durationSeconds: 60, batchesPerSecond: 25, backgroundSessions: background.map(s => s.id), digest: preview.digest }, historyReadyMs, heapBefore, heapAfter, shellHeapBefore, shellHeapAfter, shellLongTasks, shellMetrics: stats.metrics, metrics, received, sent, exceptions, events, telemetryLimits: ['Driver marker records emit boundary, not runtime receive.', 'Canonical createdAt is not a post-commit timestamp.', 'Visible time is DOM plus two animation frames, not OS compositor presentation.', 'Internal queue depth is not exposed by the B2 binary.'] }, null, 2));
console.log(JSON.stringify({ version, output, historyReadyMs, visible: metrics.visible.length, wsFrames: received.length, exceptions: exceptions.length }));
page.ws.close(); if (page !== shell) shell.ws.close();
