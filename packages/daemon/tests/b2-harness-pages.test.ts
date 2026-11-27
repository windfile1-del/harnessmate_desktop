import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { UsageService } from '../src/core/usage-service.js';
import { McpService } from '../src/core/mcp-service.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

let daemon: DaemonInstance | undefined;
let root: string | undefined;
afterEach(async () => {
  await daemon?.stop();
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

it('loads the default usage and MCP assets through their selected plugin instances and revokes their routes on disable', async () => {
  const tempRoot = process.env.HARNESSMATE_TEST_TMP ?? path.resolve(import.meta.dirname, '../../../data/test-tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  root = fs.mkdtempSync(path.join(tempRoot, 'hm-b2-pages-'));
  vi.spyOn(UsageService.prototype, 'collectAccountUsage').mockResolvedValue([]);
  vi.spyOn(McpService.prototype, 'listAllServers').mockResolvedValue([]);
  const add = vi.spyOn(McpService.prototype, 'addServer').mockResolvedValue({ results: [{ harnessId: 'codex', ok: true, message: 'added' }] });
  daemon = createDaemon({ dataDir: root, port: 0, hostOverride: '127.0.0.1' });
  await daemon.start();
  for (const [contract, slotId] of [['harness.usage.v1', 'account-usage'], ['harness.mcp-config.v1', 'mcp-config']]) {
    const selection = (await daemon.app.inject(`/api/v1/plugins/services/resolve?contract=${contract}`)).json();
    expect(selection.status).toBe('ready');
    const plugin = daemon.pluginManager.listInstalled().find((item) => item.instanceId === selection.instanceId);
    expect(plugin?.contributes.slots).toContainEqual(expect.objectContaining({ slot: 'workspace.pages', id: slotId, ui: 'ui/panel.html' }));
    const document = await daemon.app.inject(`/api/v1/plugins/${selection.instanceId}/ui-doc?path=ui/panel.html`);
    expect(document.statusCode).toBe(200);
    expect(document.json().html).toContain("bridge.call('plugin.route'");
  }
  const usage = (await daemon.app.inject('/api/v1/plugins/services/resolve?contract=harness.usage.v1')).json().instanceId;
  const mcp = (await daemon.app.inject('/api/v1/plugins/services/resolve?contract=harness.mcp-config.v1')).json().instanceId;
  const route = (instance: string, suffix: string) => `/api/v1/plugin-instances/${instance}/routes${suffix}`;
  expect((await daemon.app.inject(route(usage, '/accounts'))).json()).toEqual({ accounts: [] });
  expect((await daemon.app.inject(route(usage, '/policy'))).statusCode).toBe(200);
  expect((await daemon.app.inject({ method: 'PUT', url: route(usage, '/policy'), payload: { mode: 'invalid' } })).statusCode).toBe(400);
  expect((await daemon.app.inject(route(mcp, '/servers'))).statusCode).toBe(200);
  expect((await daemon.app.inject({ method: 'POST', url: route(mcp, '/servers'), payload: { name: 'test', transport: 'http', url: 'http://127.0.0.1:1', targetHarnesses: ['codex'] } })).statusCode).toBe(200);
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'test', targetHarnesses: ['codex'] }));
  for (const [instance, suffix] of [[usage, '/accounts'], [mcp, '/servers']]) {
    await daemon.pluginManager.togglePlugin(instance, false);
    expect((await daemon.app.inject(route(instance, suffix))).statusCode).toBe(503);
    await daemon.pluginManager.togglePlugin(instance, true);
    expect((await daemon.app.inject(route(instance, suffix))).statusCode).toBe(200);
  }
}, 60_000);
