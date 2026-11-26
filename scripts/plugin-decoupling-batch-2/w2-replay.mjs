import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [output, baselineWeb, browserPath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] = process.argv.slice(2);
if (!output || !baselineWeb) throw new Error('Usage: node w2-replay.mjs D:/isolated-run D:/b1/web-dist [browser.exe]');
const outDir = path.resolve(output);
if (path.parse(path.resolve(outDir)).root[0]?.toLowerCase() !== 'd') throw new Error('Use a D drive output directory');
const root = process.cwd();
process.env.HARNESSMATE_BUNDLES_DIR = path.join(root, 'packages/daemon/src/plugin-host/composition');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'packages/daemon/dist/server/app.js')));
const candidateWeb = path.join(root, 'packages/web/dist');
const bundledPluginsDir = path.join(root, 'plugins/bundled');
const result = {};
const linkedFile = '工作记录.md';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(outDir, { recursive: true });

async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('error', reject, { once: true });
    ws.addEventListener('open', () => resolve({
      close: () => ws.close(),
      call(method, params = {}) {
        return new Promise((resolve, reject) => {
          pending.set(++id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
    }), { once: true });
  });
}

function seed(daemon, session) {
  for (let i = 1; i <= 100; i += 1) {
    const turnId = 'w2-replay-' + i;
    const recording = i === 100;
    const toolCallId = 'command-' + i;
    const assistantText = 'W2 replay response ' + i;
    daemon.store.appendEvent(session.id, 'turn.started', {}, turnId);
    for (const [tag, eventType, blockType, text, payload, status] of [
      ['user', 'message.user', 'user_message', 'W2 replay prompt ' + i, {}, 'completed'],
      ['tool', 'tool.call.started', 'command_execution', 'echo replay ' + i, {
        toolCallId, command: 'echo replay ' + i, toolName: 'shell', toolKind: 'shell',
        summary: 'echo replay ' + i, outputPreview: recording ? 'preview' : 'complete',
      }, recording ? 'running' : 'completed'],
      ['assistant', 'message.assistant.completed', 'assistant_text', assistantText, {}, 'completed'],
    ]) {
      const event = daemon.store.appendEvent(session.id, eventType, { ...payload, text }, turnId);
      daemon.store.upsertTurnItem({
        itemId: 'w2-' + tag + '-' + i, schemaVersion: 2, sessionId: session.id, turnId, seq: event.seq,
        instanceId: 'agy', driverId: 'agy', blockType, status, title: text, textBody: text, payload,
        outputOmitted: false, omittedBytes: 0, createdAt: event.createdAt, updatedAt: event.createdAt,
      });
    }
    if (recording) {
      const item = daemon.store.appendEvent(session.id, 'checkpoint.captured', {}, turnId);
      daemon.store.upsertTurnItem({
        itemId: 'w2-file-link', schemaVersion: 2, sessionId: session.id, turnId, seq: item.seq,
        instanceId: 'agy', driverId: 'agy', blockType: 'file_change', status: 'completed',
        title: 'W2 linked file', textBody: '', payload: { files: [{ path: linkedFile, line: 2, changeKind: 'update' }] },
        outputOmitted: false, omittedBytes: 0, createdAt: item.createdAt, updatedAt: item.createdAt,
      });
    }
    if (!recording) {
      daemon.store.appendEvent(session.id, 'tool.call.completed', { toolCallId, toolName: 'shell', status: 'success', output: 'complete' }, turnId);
      daemon.store.appendEvent(session.id, 'turn.completed', {}, turnId);
    }
  }
}

const instrumentation = String.raw`
window.w2Replay = { first: null, selectedAt: null, long: [], subscriptions: [] };
const fetchFromDaemon = window.fetch;
window.w2Requests = [];
window.w2FileReads = [];
window.fetch = async function (...args) {
  const response = await fetchFromDaemon.apply(this, args);
  const url = new URL(response.url, location.href);
  if (url.pathname.startsWith('/api/v1/') && !response.ok) {
    window.w2Requests.push({ path: url.pathname, status: response.status });
  }
  if (url.pathname.endsWith('/file-view')) {
    window.w2FileReads.push({ status: response.status, path: url.searchParams.get('path'), line: url.searchParams.get('line') });
  }
  return response;
};
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) window.w2Replay.long.push({ start: entry.startTime, duration: entry.duration });
}).observe({ type: 'longtask', buffered: true });
new MutationObserver((_mutations, observer) => {
  if (document.body?.textContent.includes('W2 replay response')) {
    requestAnimationFrame(() => { window.w2Replay.first ??= performance.now(); });
    observer.disconnect();
  }
}).observe(document, { subtree: true, childList: true, characterData: true });
const send = WebSocket.prototype.send;
WebSocket.prototype.send = function (message) {
  try {
    const data = JSON.parse(message);
    if (typeof data.op === 'string' && data.op.includes('command_output')) {
      window.w2Replay.subscriptions.push(data);
    }
  } catch {}
  return send.call(this, message);
};
`;

for (const [name, webDistDir] of [['b1', baselineWeb], ['w2', candidateWeb]]) {
  const run = fs.mkdtempSync(path.join(outDir, name + '-'));
  const dir = path.join(run, 'data');
  const project = path.join(run, 'workspace');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, linkedFile), 'First line\nW2 linked line\n');
  const daemon = createDaemon({ dataDir: dir, webDistDir, port: 0, hostOverride: '127.0.0.1', bundledPluginsDir });
  let browser;
  let cdp;
  try {
    const { port } = await daemon.start();
    await daemon.pluginManager.togglePlugin('core.task-ledger', false);
    const workspace = await daemon.sessionManager.addWorkspace(project);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual', title: 'W2 replay fixture' });
    seed(daemon, session);
    const listed = await daemon.app.inject('/api/v1/sessions');
    if (!listed.json().sessions?.some(({ id }) => id === session.id)) {
      throw new Error('Replay session missing from the default session list');
    }
    const profile = path.join(run, 'browser');
    fs.mkdirSync(profile);
    browser = spawn(browserPath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', '--disable-breakpad',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1600,1000', 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let browserError = '';
    browser.stderr.on('data', (data) => {
      browserError += data.toString();
      fs.writeFileSync(path.join(run, 'browser.log'), browserError);
    });
    browser.on('error', (error) => { browserError += error.message; });
    const debugPort = await until(() => {
      const file = path.join(profile, 'DevToolsActivePort');
      if (browser.exitCode !== null) throw new Error('Browser exited with ' + browser.exitCode + ': ' + browserError);
      return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
    }, 'browser debugging port');
    const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
    cdp = await connect(targets.find(({ type }) => type === 'page').webSocketDebuggerUrl);
    const evaluate = async (expression) => {
      const value = await cdp.call('Runtime.evaluate', { expression, returnByValue: true });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
      return value.result.value;
    };
    await cdp.call('Page.enable');
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + port });
    await until(async () => evaluate(`(() => {
      if (document.body?.innerText.includes('W2 replay response')) return true;
      const button = [...document.querySelectorAll('button,[role="button"],a')].find((node) =>
        node.innerText?.includes('W2 replay fixture') || node.title?.includes('W2 replay fixture'));
      if (button && window.w2Replay.selectedAt === null) { window.w2Replay.selectedAt = performance.now(); button.click(); }
      return false;
    })()`), 'first replay response');
    await wait(750);
    const firstPaint = await evaluate('window.w2Replay');
    result[name] = {
      ...firstPaint,
      firstAfterSelectionMs: firstPaint.first - firstPaint.selectedAt,
      studioFrames: await evaluate('document.querySelectorAll(\'iframe[title*="Message Studio"]\').length'),
    };
    const opened = name === 'w2' && await until(() => evaluate(`(() => {
      const details = [...document.querySelectorAll('details[data-item-id]')].find((node) =>
        node.querySelector('summary')?.textContent.trim() === 'echo replay 100');
      if (details) { details.scrollIntoView({ block: 'center' }); details.open = true; return details.dataset.itemId; }
      const lastGroup = [...document.querySelectorAll('[data-testid="work-group-row"]')].at(-1);
      const button = lastGroup?.querySelector('button[aria-expanded="false"]');
      if (button) button.click();
      return false;
    })()`), 'running command block');
    if (opened) {
      await until(() => evaluate('window.w2Replay.subscriptions.some((value) => value.toolCallId === "command-100")'), 'tool subscription');
      daemon.sessionManager.commandOutputHub.append(session.id, 'command-100', 'W2 replay streamed output', 'stdout');
      await wait(350);
      const toolScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(run, 'tool-output.png'), Buffer.from(toolScreenshot.data, 'base64'));
      const priorUnsubscribes = await evaluate('window.w2Replay.subscriptions.filter(({ op }) => op === "unsubscribe_command_output").length');
      await evaluate(`document.querySelector('details[data-item-id="' + CSS.escape(${JSON.stringify(opened)}) + '"]').open = false`);
      await until(() => evaluate(`window.w2Replay.subscriptions.filter(({ op, toolCallId }) => op === "unsubscribe_command_output" && toolCallId === "command-100").length > ${priorUnsubscribes}`), 'tool unsubscription');
      result[name].subscriptions = await evaluate('window.w2Replay.subscriptions');
      const outputOps = result[name].subscriptions.filter(({ sessionId, toolCallId }) => sessionId === session.id && toolCallId === 'command-100');
      if (outputOps.map(({ op }) => op).join(',') !== 'subscribe_command_output,unsubscribe_command_output') {
        throw new Error('Expected one subscribe and one unsubscribe for the opened tool');
      }

      await until(() => evaluate(`(() => {
        const details = document.querySelector('details[data-item-id="w2-file-link"]');
        if (!details) {
          const groups = [...document.querySelectorAll('[data-testid="work-group-row"]')];
          const group = groups.findLast((node) => node.firstElementChild?.textContent.includes('改 1 文件'));
          group?.querySelector('button[aria-expanded="false"]')?.click();
          return false;
        }
        details.scrollIntoView({ block: 'center' });
        details.open = true;
        return true;
      })()`), 'Studio file change block');
      const { x, y } = await until(() => evaluate(`(() => {
        const frame = document.querySelector('details[data-item-id="w2-file-link"] iframe');
        if (!frame) return false;
        frame.scrollIntoView({ block: 'center' });
        const bounds = frame.getBoundingClientRect();
        if (bounds.height < 45) return false;
        return { x: bounds.left + 30, y: bounds.top + 39 };
      })()`), 'file link in the sandboxed Studio tool');
      const linkScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(run, 'file-link.png'), Buffer.from(linkScreenshot.data, 'base64'));
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
      result[name].fileNavigation = await until(() => evaluate(`window.w2FileReads.find(({ path, line, status }) =>
        path === ${JSON.stringify(linkedFile)} && line === '2' && status === 200)`), 'W1 file preview at line 2');
      const fileScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(run, 'file-navigation.png'), Buffer.from(fileScreenshot.data, 'base64'));
    }
    result[name].openedLastTool = opened;
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(run, 'replay.png'), Buffer.from(screenshot.data, 'base64'));
  } catch (error) {
    if (cdp) {
      const snapshot = await cdp.call('Runtime.evaluate', {
        expression: '({ url: location.href, page: document.body?.innerText?.slice(-4500), failedRequests: window.w2Requests, tools: [...document.querySelectorAll("details[data-item-id]")].slice(-8).map((node) => [node.dataset.itemId, node.querySelector("summary")?.textContent]) })',
        returnByValue: true,
      });
      fs.writeFileSync(path.join(run, 'page-state.json'), JSON.stringify(snapshot.result.value, null, 2));
    }
    throw error;
  } finally {
    cdp?.close();
    browser?.kill();
    await daemon.stop();
    fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(result, null, 2));
  }
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
