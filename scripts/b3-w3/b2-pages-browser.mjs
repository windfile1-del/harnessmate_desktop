import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const checkout = process.cwd().replaceAll(String.fromCharCode(92), '/');
const output = 'D:/HarnessMate/b3-tmp/w3/b2-pages-browser';
fs.mkdirSync(output, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = output;
process.env.HARNESSMATE_BUNDLES_DIR = checkout + '/packages/daemon/src/plugin-host/composition';
const load = (file) => import(pathToFileURL(checkout + '/packages/daemon/dist/' + file));
const { createDaemon } = await load('server/app.js');
const { UsageService } = await load('core/usage-service.js');
const { McpService } = await load('core/mcp-service.js');
UsageService.prototype.collectAccountUsage = async () => [{
  harnessId: 'agy', instanceId: 'agy', harnessKind: 'agy', driverId: 'agy', displayName: 'AGY Fixture',
  loggedIn: true, accountLabel: 'fixture@example.com', billingTier: 'subscription', planType: 'Pro',
  rateLimits: [{ label: 'Daily Quota', usedPercent: 42 }], dailyBuckets: [{ date: '2026-11-27', tokens: 1500 }],
  localSessionCount: 1, localInputTokens: 1200, localOutputTokens: 300, localCachedTokens: 400, localCostUsd: 0,
}];
const servers = [];
McpService.prototype.listAllServers = async () => servers;
McpService.prototype.addServer = async (input) => {
  servers.push({ id: 'fixture', name: input.name, harnessId: input.targetHarnesses[0], transport: input.transport, command: input.command, args: input.args, url: input.url, status: 'enabled' });
  return { results: input.targetHarnesses.map((harnessId) => ({ harnessId, ok: true, message: 'added' })) };
};
McpService.prototype.toggleServer = async (input) => { servers[0].status = input.enabled ? 'enabled' : 'disabled'; return { ok: true }; };
McpService.prototype.removeServer = async () => { servers.splice(0); return { ok: true }; };

const dataDir = fs.mkdtempSync(path.join(output, 'runtime-'));
const daemon = createDaemon({ dataDir, webDistDir: checkout + '/packages/web/dist',
  bundledPluginsDir: checkout + '/plugins/bundled', hostOverride: '127.0.0.1', port: 0 });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 65000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(150); }
  throw new Error('Timed out waiting for ' + label);
}
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const contexts = new Map();
  let id = 0;
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.executionContextCreated') contexts.set(msg.params.context.id, msg.params.context);
    if (msg.method === 'Runtime.executionContextDestroyed') contexts.delete(msg.params.executionContextId);
    if (msg.method === 'Runtime.executionContextsCleared') contexts.clear();
    if (!msg.id) return;
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({ contexts, close: () => ws.close(), call(method, params = {}) {
      return new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    } }));
  });
}
let browser, cdp;
const results = {};
try {
  const { port } = await daemon.start();
  const workspace = await daemon.sessionManager.addWorkspace(dataDir);
  const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', title: 'B2 page acceptance', permissionMode: 'manual' });
  const profile = path.join(dataDir, 'edge');
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-site-isolation-trials',
    '--disable-features=IsolateOrigins,site-per-process', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--window-size=1400,1050', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const debugPort = await until(() => { const file = path.join(profile, 'DevToolsActivePort'); return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]; }, 'browser');
  const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
  cdp = await connect(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  const evaluate = async (expression, contextId) => {
    try { const value = await cdp.call('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
      return value.result.value;
    } catch { return null; }
  };
  async function frameContaining(text) {
    for (const [id] of cdp.contexts) if (await evaluate(`!!window.harnessMate && document.body.innerText.includes(${JSON.stringify(text)})`, id)) return id;
    return null;
  }
  const click = (text, contextId) => evaluate(`(() => { const button = [...document.querySelectorAll('button,[role=button],a')].find(node => node.innerText.includes(${JSON.stringify(text)}) || node.title?.includes(${JSON.stringify(text)})); if (!button) return false; button.click(); return true; })()`, contextId);
  const navigate = async () => {
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + port });
    await until(() => click('B2 page acceptance'), 'session');
  };
  const screenshot = async (name) => {
    const image = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, name), Buffer.from(image.data, 'base64'));
  };
  await navigate();
  await until(() => click('账号用量'), 'usage entry');
  let frame = await until(() => frameContaining('fixture@example.com'), 'usage plugin');
  assert(await evaluate("document.body.innerText.includes('Prompt Cache 33%') && document.body.innerText.includes('手动切换至该账号')", frame));
  await click('保存策略', frame);
  await until(() => evaluate("document.body.innerText.includes('策略已保存')", frame), 'policy save');
  await screenshot('usage.png');
  results.usage = { rendered: true, policySaved: true, instance: await evaluate('window.harnessMate.instanceId', frame) };

  await navigate();
  await until(() => click('MCP 中心'), 'MCP entry');
  frame = await until(() => frameContaining('检查并安装'), 'MCP plugin');
  await evaluate(`(() => { const inputs = [...document.querySelectorAll('input[type=text]')]; inputs[0].value = 'fixture-mcp'; inputs[1].value = 'node'; inputs[2].value = 'fixture.js'; })()`, frame);
  await click('检查并安装', frame);
  await until(() => click('确认安装', frame), 'MCP confirmation');
  await until(() => servers.length === 1, 'MCP installed');
  await until(() => click('停用', frame), 'MCP toggle');
  await until(() => servers[0].status === 'disabled', 'MCP disabled');
  await screenshot('mcp.png');
  await click('移除', frame);
  await until(() => click('确认移除', frame), 'MCP removal');
  await until(() => servers.length === 0, 'MCP removed');
  results.mcp = { installed: true, toggled: true, removed: true };

  results.external = {};
  for (const [contract, slotId, entry, kind] of [
    ['harness.usage.v1', 'account-usage', '账号用量', 'usage'],
    ['harness.mcp-config.v1', 'mcp-config', 'MCP 中心', 'mcp'],
  ]) {
    const external = path.join(dataDir, `external-${kind}`);
    fs.mkdirSync(external);
    const instanceId = `user.b3-${kind}`;
    fs.writeFileSync(path.join(external, 'harnessmate-plugin.json'), JSON.stringify({
      id: instanceId, name: `External ${kind}`, description: 'Offline B2 page regression fixture', version: '1.0.0',
      apiVersion: 4, engines: { pluginApi: '^4.0' }, category: 'telemetry', main: 'index.mjs', provides: [contract],
      permissions: [`service:provide:${contract}`],
      contributes: { slots: [{ slot: 'workspace.pages', id: slotId, title: `External ${kind}`, ui: 'panel.html' }] },
    }));
    fs.writeFileSync(path.join(external, 'index.mjs'), `export function apply(ctx) {
      ctx.provide(${JSON.stringify(contract)}, {listAccounts:async()=>[],listServers:async()=>[]});
      ctx.routes.register('/value',()=>({status:200,body:{instanceId:ctx.instanceId,kind:${JSON.stringify(kind)},count:3}}));
    }`);
    fs.writeFileSync(path.join(external, 'panel.html'), '<!doctype html><html><head><script src="page.js" defer></script></head><body><main id="result">Loading fixture</main></body></html>');
    fs.writeFileSync(path.join(external, 'page.js'), `window.harnessMate.requestPluginRoute({path:'/value',method:'GET'}).then(value=>{
      document.querySelector('#result').textContent='External '+value.kind+' data '+value.count+' from '+value.instanceId;
    });`);
    const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: external });
    await daemon.pluginManager.installPlugin({ mode: 'local_dir', dirPath: external, trustCode: true, expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest });
    for (const capability of preview.manifest.permissions) assert.equal((await daemon.app.inject({
      method: 'PUT', url: `/api/v1/plugins/${instanceId}/permissions`,
      payload: { workspaceId: '__global__', digest: preview.digest, capability, granted: true },
    })).statusCode, 200);
    const defaultInstance = daemon.pluginManager.resolveServiceSelection(contract).instanceId;
    assert.equal((await daemon.app.inject({ method: 'PUT', url: `/api/v1/workspaces/${workspace.id}/bindings`, payload: { contract, instanceId } })).statusCode, 200);
    await daemon.pluginManager.togglePlugin(defaultInstance, false);
    await navigate();
    await until(() => click(entry), 'external entry with default disabled');
    frame = await until(() => frameContaining(`External ${kind} data 3 from ${instanceId}`), 'external route data rendered');
    results.external[kind] = { defaultDisabled: true, dataRendered: true, instance: await evaluate('window.harnessMate.instanceId', frame) };
    assert.equal(results.external[kind].instance, instanceId);
    await screenshot(`external-${kind}.png`);
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} catch (error) {
  if (cdp) {
    const snapshot = await cdp.call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    fs.writeFileSync(path.join(output, 'error-page.txt'), snapshot.result.value ?? '');
  }
  throw error;
} finally { cdp?.close(); browser?.kill(); await daemon.stop(); }
