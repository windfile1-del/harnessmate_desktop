import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AdapterSessionConfig, NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

const cleanupDirs: string[] = [];
const daemons: Array<ReturnType<typeof createDaemon>> = [];
const httpServers: http.Server[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort cleanup on Windows transient locks
  }
}

function writePluginPackage(
  parent: string,
  folderName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): string {
  const dir = path.join(parent, folderName);
  fs.mkdirSync(dir, { recursive: true });
  const normalizedManifest = {
    description: 'Peer test plugin package',
    author: 'HarnessMate Test',
    ...manifest,
  };
  fs.writeFileSync(path.join(dir, 'harnessmate-plugin.json'), JSON.stringify(normalizedManifest, null, 2));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

async function createTestDaemon(dataDir: string) {
  const daemon = createDaemon({ dataDir, port: 0, host: '127.0.0.1' });
  daemons.push(daemon);
  await daemon.start();
  return daemon;
}

async function installTrustedDir(daemon: ReturnType<typeof createDaemon>, dirPath: string) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  return preview;
}

async function grantPermission(
  daemon: ReturnType<typeof createDaemon>,
  pluginId: string,
  digest: string,
  capability: string,
  workspaceId = '__global__',
) {
  const res = await daemon.app.inject({
    method: 'PUT',
    url: `/api/v1/plugins/${pluginId}/permissions`,
    payload: { workspaceId, digest, capability, granted: true },
  });
  expect(res.statusCode).toBe(200);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(async () => {
  while (daemons.length > 0) {
    const d = daemons.pop()!;
    await d.stop().catch(() => {});
  }
  while (httpServers.length > 0) {
    const srv = httpServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (cleanupDirs.length > 0) {
    safeRmSync(cleanupDirs.pop()!);
  }
});

it('supports multi-instance same plugin with independent config, storage, routes, and selective PENDING waiting', async () => {
  const dataDir = createTempDir('hm-peer-multi-');
  const pkgRoot = createTempDir('hm-peer-multi-pkg-');
  const daemon = await createTestDaemon(dataDir);

  const echoDir = writePluginPackage(
    pkgRoot,
    'echo-provider',
    {
      id: 'user.echo-provider',
      name: 'Echo Provider',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'workflow',
      main: 'index.mjs',
      provides: ['user.echo.v1'],
      permissions: ['storage:plugin'],
    },
    {
      'index.mjs': `
export async function apply(ctx, config) {
  const defaultLabel = typeof config.label === 'string' ? config.label : ctx.instanceId;
  ctx.provide('user.echo.v1', {
    async writeLabel(val) {
      await ctx.storage.plugin.set('label', val);
      return val;
    },
    async readLabel() {
      const saved = await ctx.storage.plugin.get('label');
      return saved ?? defaultLabel;
    },
  }, { version: '1.0.0', metadata: { label: defaultLabel } });
  ctx.routes.register('/info', async (req) => {
    if (req.method === 'POST' && req.body && typeof req.body === 'object' && 'value' in req.body) {
      await ctx.storage.plugin.set('stored', req.body.value);
    }
    return {
      status: 200,
      body: {
        instanceId: ctx.instanceId,
        label: defaultLabel,
        stored: await ctx.storage.plugin.get('stored'),
      },
    };
  });
}
`,
    },
  );

  const consumerDir = writePluginPackage(
    pkgRoot,
    'echo-consumer',
    {
      id: 'user.echo-consumer',
      name: 'Echo Consumer',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'workflow',
      main: 'index.mjs',
      dependencies: { 'user.echo.v1': { contract: 'user.echo.v1' } },
      permissions: [],
    },
    {
      'index.mjs': `
export function apply(ctx) {
  ctx.routes.register('/upstream', async () => {
    const label = await ctx.services.call('user.echo.v1', 'readLabel', []);
    return { status: 200, body: { instanceId: ctx.instanceId, label } };
  });
}
`,
    },
  );

  const echoPreview = await installTrustedDir(daemon, echoDir);
  await grantPermission(daemon, 'user.echo-provider', echoPreview.digest!, 'storage:plugin');
  await installTrustedDir(daemon, consumerDir);

  // Create two instances of Echo Provider with different configs + two bound consumers
  await daemon.app.inject({
    method: 'PUT',
    url: '/api/v1/plugins/composition/instances',
    payload: { id: 'echo.a', name: 'user.echo-provider', config: { label: 'AlphaInstance' } },
  });
  await daemon.app.inject({
    method: 'PUT',
    url: '/api/v1/plugins/composition/instances',
    payload: { id: 'echo.b', name: 'user.echo-provider', config: { label: 'BetaInstance' } },
  });
  await daemon.app.inject({
    method: 'PUT',
    url: '/api/v1/plugins/composition/instances',
    payload: {
      id: 'consumer.a',
      name: 'user.echo-consumer',
      bindings: { 'user.echo.v1': 'echo.a' },
    },
  });
  const bindB = await daemon.app.inject({
    method: 'PUT',
    url: '/api/v1/plugins/composition/instances',
    payload: {
      id: 'consumer.b',
      name: 'user.echo-consumer',
      bindings: { 'user.echo.v1': 'echo.b' },
    },
  });
  expect(bindB.statusCode).toBe(200);

  await daemon.app.inject({ method: 'POST', url: '/api/v1/plugin-instances/echo.a/routes/info', payload: { value: 'storeA' } });
  await daemon.app.inject({ method: 'POST', url: '/api/v1/plugin-instances/echo.b/routes/info', payload: { value: 'storeB' } });
  const infoA = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugin-instances/echo.a/routes/info' });
  const infoB = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugin-instances/echo.b/routes/info' });
  expect(infoA.json()).toEqual({ instanceId: 'echo.a', label: 'AlphaInstance', stored: 'storeA' });
  expect(infoB.json()).toEqual({ instanceId: 'echo.b', label: 'BetaInstance', stored: 'storeB' });

  const upA = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugin-instances/consumer.a/routes/upstream' });
  const upB = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugin-instances/consumer.b/routes/upstream' });
  expect(upA.json()).toEqual({ instanceId: 'consumer.a', label: 'AlphaInstance' });
  expect(upB.json()).toEqual({ instanceId: 'consumer.b', label: 'BetaInstance' });

  // Selective PENDING waiting: disabling echo.a moves consumer.a to PENDING while consumer.b stays ACTIVE
  await daemon.app.inject({
    method: 'PUT',
    url: '/api/v1/plugins/composition/instances',
    payload: { id: 'echo.a', name: 'user.echo-provider', disabled: true, config: { label: 'AlphaInstance' } },
  });
  const afterDisable = daemon.pluginManager.listInstalled();
  expect(afterDisable.find((p) => (p.instanceId ?? p.id) === 'consumer.a')?.runtimeState).toBe('PENDING');
  expect(afterDisable.find((p) => (p.instanceId ?? p.id) === 'consumer.b')?.runtimeState).toBe('ACTIVE');

  // Re-enabling echo.a wakes consumer.a back to ACTIVE
  await daemon.app.inject({
    method: 'PUT',
    url: '/api/v1/plugins/composition/instances',
    payload: { id: 'echo.a', name: 'user.echo-provider', disabled: false, config: { label: 'AlphaInstance' } },
  });
  const afterEnable = daemon.pluginManager.listInstalled();
  expect(afterEnable.find((p) => (p.instanceId ?? p.id) === 'consumer.a')?.runtimeState).toBe('ACTIVE');
}, 25_000);

it('runs bundled desktop and headless browsers concurrently, supports Chinese input, session binding, and clean disable', async () => {
  const dataDir = createTempDir('hm-peer-browsers-');
  const wsDir = createTempDir('hm-peer-browsers-ws-');
  const daemon = await createTestDaemon(dataDir);

  const targetServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>平级测试页面</title></head><body><h1>欢迎使用平级浏览器</h1></body></html>');
  });
  httpServers.push(targetServer);
  await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = targetServer.address();
  const testUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;

  const servicesRes = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins/services?contract=browser.v1' });
  expect(servicesRes.statusCode).toBe(200);
  const browserProviders = servicesRes.json().providers as Array<{ instanceId: string; state: string; metadata?: Record<string, unknown> }>;
  expect(browserProviders.some((p) => p.instanceId === 'hm.plugin.browser-desktop' && p.state === 'ACTIVE')).toBe(true);
  const headlessMeta = browserProviders.find((p) => p.instanceId === 'hm.plugin.browser-headless' && p.state === 'ACTIVE');
  expect(headlessMeta).toBeTruthy();
  const workerPid = Number(headlessMeta?.metadata?.workerPid);
  expect(Number.isInteger(workerPid) && workerPid > 0).toBe(true);
  expect(isPidAlive(workerPid)).toBe(true);

  const ws = await daemon.sessionManager.addWorkspace(wsDir, 'Browser WS');
  const sDesktop = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'codex', permissionMode: 'manual' });
  const sHeadless = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'codex', permissionMode: 'manual' });

  await daemon.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sDesktop.id}/bindings`,
    payload: { contract: 'browser.v1', instanceId: 'hm.plugin.browser-desktop' },
  });
  await daemon.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${sHeadless.id}/bindings`,
    payload: { contract: 'browser.v1', instanceId: 'hm.plugin.browser-headless' },
  });

  const openA = await daemon.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sDesktop.id}/browser/open`,
    payload: { url: testUrl },
  });
  expect(openA.statusCode).toBe(200);
  expect(openA.json().instanceId).toBe('hm.plugin.browser-desktop');

  const openB = await daemon.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sHeadless.id}/browser/open`,
    payload: { url: testUrl },
  });
  expect(openB.statusCode).toBe(200);
  expect(openB.json().instanceId).toBe('hm.plugin.browser-headless');

  const headlessSvc = daemon.pluginManager.host.getServiceByInstance<Record<string, (...args: unknown[]) => Promise<unknown>>>(
    'hm.plugin.browser-headless',
    'browser.v1',
  );
  await headlessSvc?.input('你好，平级浏览器');

  const routeState = await daemon.app.inject({
    method: 'GET',
    url: '/api/v1/plugin-instances/hm.plugin.browser-headless/routes/state',
  });
  expect(routeState.statusCode).toBe(200);
  expect(routeState.json().state.inputValue).toBe('你好，平级浏览器');
  expect(routeState.json().state.title).toBe('平级测试页面');

  // Verify stale vs current runId authorization on view-authorize
  const desktopRunId = daemon.pluginManager.isolated?.getRunId('hm.plugin.browser-desktop');
  expect(desktopRunId).toBeTruthy();
  const authOk = await daemon.app.inject({
    method: 'POST',
    url: '/api/v1/plugin-instances/hm.plugin.browser-desktop/view-authorize',
    payload: { runId: desktopRunId, permission: 'browser:preview' },
  });
  expect(authOk.statusCode).toBe(200);
  const authStale = await daemon.app.inject({
    method: 'POST',
    url: '/api/v1/plugin-instances/hm.plugin.browser-desktop/view-authorize',
    payload: { runId: 'stale-run-id', permission: 'browser:preview' },
  });
  expect(authStale.statusCode).toBe(409);

  // Disabling headless browser terminates its worker PID and isolates only session B
  await daemon.pluginManager.togglePlugin('hm.plugin.browser-headless', false);
  await waitFor(() => !isPidAlive(workerPid));

  const openBAfter = await daemon.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sHeadless.id}/browser/open`,
    payload: { url: testUrl },
  });
  expect(openBAfter.json().ok).toBe(false);
  expect(openBAfter.json().dependencyStatus).toBe('unavailable');

  const openAAfter = await daemon.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${sDesktop.id}/browser/open`,
    payload: { url: testUrl },
  });
  expect(openAAfter.json().ok).toBe(true);
}, 25_000);

it('runs bundled text and markdown file viewers concurrently, preserves line numbers, recovers on disable, and supports runtime 3rd-party viewer install', async () => {
  const dataDir = createTempDir('hm-peer-viewers-');
  const wsDir = createTempDir('hm-peer-viewers-ws-');
  const pkgRoot = createTempDir('hm-peer-viewers-pkg-');

  const lines = Array.from({ length: 50 }, (_, idx) => (idx === 41 ? 'Target **Line 42** marker' : `Line ${idx + 1}`));
  fs.writeFileSync(path.join(wsDir, 'notes.md'), `# Title\n\n${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(wsDir, 'app.log'), 'l1\nl2\nLINE_THREE\nl4\n');

  const daemon = await createTestDaemon(dataDir);
  const ws = await daemon.sessionManager.addWorkspace(wsDir, 'Viewer WS');
  const session = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'codex', permissionMode: 'manual' });

  const viewersRes = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins/services?contract=filePreview.v1' });
  const viewerIds = (viewersRes.json().providers as Array<{ instanceId: string }>).map((p) => p.instanceId);
  expect(viewerIds).toContain('hm.plugin.file-preview-text');
  expect(viewerIds).toContain('hm.plugin.file-preview-markdown');

  // Render same file & line 42 via both viewers concurrently
  const mdView = await daemon.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${session.id}/file-view?path=notes.md&line=42&instanceId=hm.plugin.file-preview-markdown`,
  });
  expect(mdView.statusCode).toBe(200);
  expect(mdView.json().preview.format).toBe('markdown');
  expect(mdView.json().preview.line).toBe(42);
  expect(mdView.json().resolvedInstanceId).toBe('hm.plugin.file-preview-markdown');

  const textView = await daemon.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${session.id}/file-view?path=notes.md&line=42&instanceId=hm.plugin.file-preview-text`,
  });
  expect(textView.statusCode).toBe(200);
  expect(textView.json().preview.format).toBe('text');
  expect(textView.json().preview.line).toBe(42);
  expect(textView.json().resolvedInstanceId).toBe('hm.plugin.file-preview-text');

  // Bind session to markdown viewer, disable it, confirm explicit recovery to text viewer preserves line 42
  await daemon.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${session.id}/bindings`,
    payload: { contract: 'filePreview.v1', instanceId: 'hm.plugin.file-preview-markdown' },
  });
  await daemon.pluginManager.togglePlugin('hm.plugin.file-preview-markdown', false);

  const disabledView = await daemon.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${session.id}/file-view?path=notes.md&line=42`,
  });
  expect(disabledView.statusCode).toBe(200);
  expect(disabledView.json().dependencyStatus).toBe('unavailable');
  expect(disabledView.json().preview).toBeNull();
  expect(disabledView.json().availableViewers.some((v: { instanceId: string; ready: boolean }) =>
    v.instanceId === 'hm.plugin.file-preview-text' && v.ready)).toBe(true);

  const fallbackView = await daemon.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${session.id}/file-view?path=notes.md&line=42&instanceId=hm.plugin.file-preview-text`,
  });
  expect(fallbackView.json().dependencyStatus).toBe('ready');
  expect(fallbackView.json().preview.line).toBe(42);

  // Runtime install of a third-party filePreview.v1 plugin without kernel code changes
  const customDir = writePluginPackage(
    pkgRoot,
    'custom-log-viewer',
    {
      id: 'user.log-viewer',
      name: '日志查看器',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'ui',
      main: 'index.mjs',
      provides: ['filePreview.v1'],
      permissions: ['file:preview'],
      contributes: { filePreview: { extensions: ['.log'], viewerKind: 'custom' } },
    },
    {
      'index.mjs': `
export function renderFilePreview(file) {
  return { version: 1, format: 'text', content: '[LOG] ' + file.content, line: file.line };
}
export function apply(ctx) {
  ctx.provide('filePreview.v1', {
    getCapabilities() { return { viewerKind: 'custom', extensions: ['.log'], title: '日志查看器' }; },
    renderFilePreview,
  }, { version: '1.0.0', metadata: { viewerKind: 'custom', extensions: ['.log'] } });
}
`,
    },
  );
  const customPreview = await installTrustedDir(daemon, customDir);
  await grantPermission(daemon, 'user.log-viewer', customPreview.digest!, 'file:preview', ws.id);
  await daemon.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${session.id}/bindings`,
    payload: { contract: 'filePreview.v1', instanceId: 'user.log-viewer' },
  });

  const logView = await daemon.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${session.id}/file-view?path=app.log&line=3`,
  });
  expect(logView.statusCode).toBe(200);
  expect(logView.json().preview.pluginId).toBe('user.log-viewer');
  expect(logView.json().preview.content.startsWith('[LOG] ')).toBe(true);
  expect(logView.json().preview.line).toBe(3);
}, 25_000);

it('supports trusted-local dev inheritance, approval.policy.v1 enforcement, candidate-ready upgrade, and empty business composition recovery', async () => {
  const dataDir = createTempDir('hm-peer-kernel-');
  const wsDir = createTempDir('hm-peer-kernel-ws-');
  const pkgRoot = createTempDir('hm-peer-kernel-pkg-');
  const devRoot = createTempDir('hm-peer-kernel-dev-');

  const daemon = await createTestDaemon(dataDir);
  const adapter = daemon.registry.get('codex')!;
  const sessions: Array<{ config: AdapterSessionConfig; emit?: (event: NormalizedAdapterEvent) => void }> = [];
  adapter.createSession = async (config) => {
    const entry: (typeof sessions)[number] = { config };
    sessions.push(entry);
    return {
      nativeSessionId: 'peer-thread',
      pluginMcpAvailable: Boolean(config.pluginMcp),
      onEvent(listener) { entry.emit = listener; return () => { entry.emit = undefined; }; },
      async sendTurn({ turnId }) { entry.emit?.({ type: 'turn.started', turnId }); },
      async interrupt() {},
      async resolveApproval() {},
      async dispose() {},
    };
  };

  const ws = await daemon.sessionManager.addWorkspace(wsDir, 'Kernel WS');
  const session = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'codex', permissionMode: 'auto' });

  // 1. Trusted-local dev directory inheritance
  const devDir = writePluginPackage(
    devRoot,
    'dev-peer-service',
    {
      id: 'user.dev-peer',
      name: 'Dev Peer Service',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'workflow',
      main: 'index.mjs',
      provides: ['user.dev.v1'],
      permissions: [],
    },
    {
      'panel.html': '<!doctype html><html><body><h1>Dev</h1></body></html>',
      'index.mjs': `
export const requires = ['ui.workspace.pages'];
export function apply(ctx) {
  ctx.provide('user.dev.v1', { ping: () => 'pong' });
  ctx.routes.register('/healthz', () => ({ status: 200, body: { trustedLocal: ctx.runtime.trustedLocal } }));
  ctx.slots.register({ slot: 'workspace.pages', id: 'dev-page', title: 'Dev Page', ui: 'panel.html' });
}
`,
    },
  );
  const linkRes = await daemon.app.inject({
    method: 'POST',
    url: '/api/v1/plugins/dev/link',
    payload: { dirPath: devDir, trustedId: 'user.dev-peer' },
  });
  expect(linkRes.statusCode).toBe(200);
  const devRoute = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugin-instances/user.dev-peer/routes/healthz' });
  expect(devRoute.statusCode).toBe(200);
  expect(devRoute.json()).toEqual({ trustedLocal: true });

  await daemon.app.inject({ method: 'DELETE', url: '/api/v1/plugins/dev/user.dev-peer/trust' });
  const devInstalled = daemon.pluginManager.listInstalled().find((p) => p.id === 'user.dev-peer');
  expect(devInstalled?.runtimeState).toBe('ACTIVE');
  const devRouteUntrusted = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugin-instances/user.dev-peer/routes/healthz' });
  expect(devRouteUntrusted.json()).toEqual({ trustedLocal: false });

  // 2. Session-bound approval.policy.v1 enforcement on MCP plugin tool call
  const toolDir = writePluginPackage(
    pkgRoot,
    'tool-plugin',
    {
      id: 'user.sample-tools',
      name: 'Sample Tools',
      version: '1.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'tool',
      main: 'index.mjs',
      permissions: ['tools:model'],
    },
    {
      'index.mjs': `
export function apply(ctx) {
  ctx.tools.register({
    name: 'danger_tool',
    description: 'Dangerous tool',
    inputSchema: { type: 'object', properties: {} },
    handler: () => 'EXECUTED_DANGER',
  });
  ctx.tools.register({
    name: 'safe_tool',
    description: 'Safe tool',
    inputSchema: { type: 'object', properties: {} },
    handler: () => 'EXECUTED_SAFE',
  });
}
`,
    },
  );
  const toolPreview = await installTrustedDir(daemon, toolDir);
  await grantPermission(daemon, 'user.sample-tools', toolPreview.digest!, 'tools:model', ws.id);

  // Create configured instance of bundled approval policy denying 'danger_tool'
  await daemon.app.inject({
    method: 'PUT',
    url: '/api/v1/plugins/composition/instances',
    payload: {
      id: 'policy.strict',
      name: 'hm.plugin.approval-policy-default',
      config: { deniedTools: ['danger_tool'] },
    },
  });
  await daemon.app.inject({
    method: 'PUT',
    url: `/api/v1/sessions/${session.id}/bindings`,
    payload: { contract: 'approval.policy.v1', instanceId: 'policy.strict' },
  });

  const turn = await daemon.sessionManager.sendTurn(session.id, 'Run policy turn');
  const token = sessions[0]?.config.pluginMcp?.token;
  expect(token).toBeTruthy();

  const mcp = (method: string, params?: object) => daemon.app.inject({
    method: 'POST',
    url: '/api/v1/plugin-tools',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  const mcpTools = (await mcp('tools/list')).json().result.tools as Array<{ name: string }>;
  const safeName = mcpTools.find((t) => t.name.includes('safe_tool'))!.name;
  const dangerName = mcpTools.find((t) => t.name.includes('danger_tool'))!.name;

  const safeRes = (await mcp('tools/call', { name: safeName, arguments: {} })).json().result;
  expect(safeRes.isError).not.toBe(true);
  expect(safeRes.content[0].text).toBe('EXECUTED_SAFE');

  const dangerRes = (await mcp('tools/call', { name: dangerName, arguments: {} })).json().result;
  expect(dangerRes.isError).toBe(true);
  expect(String(dangerRes.content[0].text)).toContain('审批策略');

  sessions[0]?.emit?.({ type: 'turn.cancelled', turnId: turn.turnId });

  // 3. Candidate-ready-first upgrade: failing v2 leaves active v1 untouched
  const brokenUpgradeDir = writePluginPackage(
    pkgRoot,
    'upgrade-broken',
    {
      id: 'user.sample-tools',
      name: 'Sample Tools',
      version: '2.0.0',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      category: 'tool',
      main: 'index.mjs',
      permissions: ['tools:model'],
    },
    { 'index.mjs': `export function apply() { throw new Error('broken v2 candidate'); }` },
  );
  const v2Digest = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: brokenUpgradeDir }).digest!;
  await expect(daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath: brokenUpgradeDir,
    trustCode: true,
    expectedDigest: v2Digest,
    expectedInstalledDigest: toolPreview.digest!,
  })).rejects.toThrow();
  const stillV1 = daemon.pluginManager.listInstalled().find((p) => p.id === 'user.sample-tools');
  expect(stillV1?.version).toBe('1.0.0');
  expect(stillV1?.runtimeState).toBe('ACTIVE');

  // 4. Empty business composition recovery
  const emptyRes = await daemon.app.inject({
    method: 'POST',
    url: '/api/v1/plugins/composition/restore',
    payload: { source: 'empty' },
  });
  expect(emptyRes.statusCode).toBe(200);
  expect(emptyRes.json().emptyComposition).toBe(true);
  const healthEmpty = await daemon.app.inject({ method: 'GET', url: '/api/v1/health' });
  expect(healthEmpty.json().emptyComposition).toBe(true);
  const activeProvidersInEmpty = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins/services' });
  expect(activeProvidersInEmpty.json().providers).toHaveLength(0);

  const restoreBuiltin = await daemon.app.inject({
    method: 'POST',
    url: '/api/v1/plugins/composition/restore',
    payload: { source: 'builtin' },
  });
  expect(restoreBuiltin.statusCode).toBe(200);
  expect(restoreBuiltin.json().emptyComposition).toBe(false);
  const activeAfterRestore = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins/services?contract=browser.v1' });
  expect(activeAfterRestore.json().providers.some((p: { instanceId: string }) => p.instanceId === 'hm.plugin.browser-desktop')).toBe(true);
}, 25_000);
