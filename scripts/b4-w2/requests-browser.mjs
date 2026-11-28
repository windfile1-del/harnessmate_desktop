// Run after pnpm build. Uses a new data directory/profile, no production account or tool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const checkout = process.cwd();
const output = process.env.HARNESSMATE_TEST_TMP || 'D:/HarnessMate/b4-tmp/w2';
assert.match(path.resolve(output), /^D:[\\/]/i);
fs.mkdirSync(output, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = output;
process.env.HARNESSMATE_BUNDLES_DIR = path.join(checkout, 'packages/daemon/src/plugin-host/composition');
const run = fs.mkdtempSync(path.join(output, 'request-browser-'));
const { createDaemon } = await import(pathToFileURL(path.join(checkout, 'packages/daemon/dist/server/app.js')));
const options = { dataDir: path.join(run, 'data'), webDistDir: path.join(checkout, 'packages/web/dist'),
  bundledPluginsDir: path.join(checkout, 'plugins/bundled'), hostOverride: '127.0.0.1', port: 0,
  nativeFeatureFlags: { enabled: true, nativeLifecycle: true, nativePermissions: true, nativeCommands: true } };
let daemon = createDaemon(options), browser, cdp;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await wait(100); }
  throw new Error('Timed out: ' + label);
}
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(), contexts = new Map(); let seq = 0;
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.executionContextCreated') contexts.set(msg.params.context.id, msg.params.context);
    if (msg.method === 'Runtime.executionContextDestroyed') contexts.delete(msg.params.executionContextId);
    if (msg.method === 'Runtime.executionContextsCleared') contexts.clear();
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return { contexts, close: () => ws.close(), call: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  }) };
}
const evidence = { kind: 'real_headless_browser_and_agy_driver_with_synthetic_stdio_peer', liveAccountVerified: false, steps: [] };
try {
  let address = await daemon.start();
  const { AgyAdapter } = await import(pathToFileURL(path.join(checkout,'packages/daemon/dist/harnesses/agy/agy-driver.js')));
  const { mintAgyDispatchProvenance } = await import(pathToFileURL(path.join(checkout,'packages/daemon/dist/harnesses/agy/native/wiring/provenance.js')));
  class BrowserAgyAdapter extends AgyAdapter { buildLaunchArgs() { return [path.join(checkout,'scripts/b4-w2/agy-permission-peer.mjs'), run]; } }
  daemon.registry.register(new BrowserAgyAdapter({ profile: { instanceId:'agy-browser',displayName:'AGY browser replay',isolationMode:'profile_isolated',authMethod:'oauth-personal',appDataDirName:'.agy',
    defaults:{linkGlobalSkills:false,syncGlobalRules:false,additionalDirectories:[]},enabled:true },profilesRootDir:path.join(run,'profiles'),binaryOverride:process.execPath,applyWindowsAcl:false }));
  const ws = await daemon.sessionManager.addWorkspace(run, 'B4-W2 browser');
  const session = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'agy-browser', title: 'B4 W2 Request Browser', permissionMode: 'manual' });
  const profile = path.join(run, 'edge');
  browser = spawn(process.env.HARNESSMATE_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-breakpad', '--disable-site-isolation-trials',
    '--disable-features=IsolateOrigins,site-per-process', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=1400,1000', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const debugPort = await until(() => {
    const file = path.join(profile, 'DevToolsActivePort'); return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
  }, 'browser startup');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  cdp = await connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable'); await cdp.call('Page.enable');
  const evaluate = async (expression, contextId) => {
    try { const r = await cdp.call('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; } catch { return null; }
  };
  const click = (label, contextId, scoped = false) => evaluate(`(() => { const root = (${scoped} && document.querySelector('[data-testid="request-plugin-queue"]')) || document; const el = [...root.querySelectorAll('button,[role=button],a')].find(e => e.innerText.includes(${JSON.stringify(label)}) || e.title?.includes(${JSON.stringify(label)})); if (!el) return false; el.click(); return true; })()`, contextId);
  const frame = () => until(async () => { for (const [id] of cdp.contexts) if (await evaluate(`!!document.querySelector('[data-testid="request-plugin-queue"]')`, id)) return id; }, 'bound request view');
  const navigate = async () => {
    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${address.port}` });
    await until(() => click('B4 W2 Request Browser'), 'session selection'); return frame();
  };
  let context = await navigate();
  const register = (id, ms) => daemon.sessionManager.getRequestBroker(session.id).register({ workspaceId: ws.id,
    approval: { id, sessionId: session.id, nativeRequestId: id, kind: 'command_approval', toolName: 'write_fixture', toolKind: 'shell',
      summary: id, input: {}, riskLevel: 'low', status: 'pending', createdAt: Date.now(), supportedDecisions: ['allow_once','deny'] },
    origin: { providerInstanceId: 'browser-fixture', driverGeneration: 'g1', nativeRequestId: id, turnId: null, connectionId: 'original-only' },
    deadlineAtMs: Date.now() + ms, idempotencyKey: id }, {
    deliver: async input => { if (input.decision === 'allow_once') fs.writeFileSync(path.join(run, id + '.tool-result'), 'executed after UI approval'); return 'acknowledged'; },
  });
  register('browser-approve', 45000);
  await until(() => evaluate(`document.body.innerText.includes('browser-approve')`, context), 'pending card');
  await until(() => click('允许本次', context), 'approve button');
  await until(() => fs.existsSync(path.join(run, 'browser-approve.tool-result')), 'tool result');
  evidence.steps.push({ ui: 'clicked allow once in installed view', policy: 'manual / ask',
    driver: daemon.sessionManager.getRequestBroker(session.id).get('browser-approve'), tool: 'filesystem result exists' });
  assert.equal(fs.existsSync(path.join(run,'agy.tool-result')),false);
  await daemon.sessionManager.sendTurn(session.id,'Run isolated AGY permission fixture',undefined,{dispatchProvenance:mintAgyDispatchProvenance('human_direct','desktop','B4-W2 browser replay')});
  await until(() => evaluate(`document.body.innerText.includes('Allow fixture once')`,context),'native request view');
  const nativeFact = daemon.sessionManager.getRequestBroker(session.id).list(session.id).find(f=>f.origin.runtimeId);
  assert(nativeFact); assert.equal(nativeFact.status,'pending'); assert.equal(fs.existsSync(path.join(run,'agy.tool-result')),false);
  await until(() => click('Allow fixture once',context),'exact native option');
  await until(() => fs.existsSync(path.join(run,'agy.tool-result')),'real AGY driver stdio tool outcome');
  await until(() => daemon.store.getSession(session.id).status === 'idle','native turn completion');
  evidence.steps.push({ui:'clicked exact native allow_once in installed request view',policy:daemon.sessionManager.getRequestBroker(session.id).get(nativeFact.requestId),
    mode:await daemon.sessionManager.getRequestBroker(session.id).service.getMode({sessionId:session.id}),driverWire:path.join(run,'agy-wire.ndjson'),tool:fs.readFileSync(path.join(run,'agy.tool-result'),'utf8')});
  register('browser-expire', 2500);
  await until(() => evaluate(`document.body.innerText.includes('browser-expire')`, context), 'expiring card visible');
  await until(() => evaluate(`!document.querySelector('[data-request-id="browser-expire"]')`, context), 'expired card leaves pending');
  assert.equal(daemon.store.getSession(session.id).pendingApprovalCount, 0);
  assert.equal(daemon.store.getSession(session.id).status, 'idle');
  await click('历史', context, true);
  await until(() => evaluate(`!!document.querySelector('[aria-label="关闭 browser-expire"]')`, context), 'history close');
  await evaluate(`document.querySelector('[aria-label="关闭 browser-expire"]').click()`, context);
  await until(() => daemon.sessionManager.getRequestBroker(session.id).get('browser-expire').closed, 'close persisted');
  fs.writeFileSync(path.join(run, 'closed.png'), Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await daemon.stop(); daemon = createDaemon(options); address = await daemon.start();
  context = await navigate(); await click('历史', context, true);
  assert.equal(await evaluate(`!!document.querySelector('[data-request-id="browser-expire"]')`, context), false);
  assert.equal(daemon.sessionManager.getRequestBroker(session.id).get('browser-expire').closed, true);
  evidence.steps.push({ expired: 'removed from pending', closed: 'persisted by stable ID', restart: 'not resurrected', pending: daemon.store.getSession(session.id).pendingApprovalCount });
  fs.writeFileSync(path.join(run, 'restart.png'), Buffer.from((await cdp.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  fs.writeFileSync(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: path.join(run, 'evidence.json') }));
} finally { cdp?.close(); browser?.kill(); await daemon.stop(); }
