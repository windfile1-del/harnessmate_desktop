import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDaemon } from '../src/server/app.js';

function writePluginPackage(
  parent: string,
  folderName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): string {
  const dir = path.join(parent, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'harnessmate-plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

it('validates V4 contributes.slots, serves strict-CSP sandboxed UI docs with safe local inlining, and blocks traversal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p4-ui-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p4-src-'));
  fs.writeFileSync(path.join(staging, 'secret.txt'), 'OUTSIDE_SECRET');
  const daemon = createDaemon({ dataDir, port: 0 });

  try {
    await daemon.start();

    // 1. Missing HTML entry fails preview/install
    const missingUiDir = writePluginPackage(
      staging,
      'missing-ui',
      {
        id: 'user.missing-ui',
        name: 'Missing UI',
        version: '1.0.0',
        description: 'Points to non-existent HTML',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        contributes: {
          slots: [{ slot: 'inspector.tabs', id: 'main', title: 'Main', ui: 'ui/missing.html' }],
        },
      },
      {},
    );
    expect(() => daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: missingUiDir })).toThrow('不存在');

    // 2. Path traversal in slot ui fails schema validation
    const traversalDir = writePluginPackage(
      staging,
      'traversal-ui',
      {
        id: 'user.traversal-ui',
        name: 'Traversal UI',
        version: '1.0.0',
        description: 'Attempts path escape',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        contributes: {
          slots: [{ slot: 'inspector.tabs', id: 'evil', title: 'Evil', ui: '../secret.html' }],
        },
      },
      {},
    );
    expect(() => daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: traversalDir })).toThrow();

    // 3. Valid declarative V4 plugin using `inspector.tab` alias + local CSS/JS + external script blocked
    const validUiDir = writePluginPackage(
      staging,
      'pr-guard-ui',
      {
        id: 'user.pr-guard-ui',
        name: 'PR Guard UI',
        version: '1.0.0',
        description: 'Sandboxed iframe slot plugin',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        permissions: ['browser:preview'],
        contributes: {
          slots: [
            { slot: 'inspector.tab', id: 'pr-panel', title: 'PR 检查单', ui: 'ui/panel.html', order: 100 },
          ],
        },
      },
      {
        'ui/panel.html': `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="./panel.css">
  <link rel="stylesheet" href="https://evil.example/remote.css">
</head>
<body>
  <div id="app">PR Checklist</div>
  <script src="./panel.js"></script>
  <script src="https://evil.example/evil.js"></script>
</body>
</html>`,
        'ui/panel.css': `.card { color: var(--text-primary); }`,
        'ui/panel.js': `console.log('panel loaded');`,
      },
    );

    const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: validUiDir });
    await daemon.pluginManager.installPlugin({
      mode: 'local_dir',
      dirPath: validUiDir,
      expectedDigest: preview.digest,
      expectedInstalledDigest: preview.installedDigest,
    });

    // Fetch prepared sandboxed HTML document via authenticated daemon API
    const docRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/user.pr-guard-ui/ui-doc?path=ui/panel.html',
    });
    expect(docRes.statusCode).toBe(200);
    const doc = docRes.json() as { html: string; csp: string; pluginId: string; path: string; runId: string };
    expect(doc.pluginId).toBe('user.pr-guard-ui');
    expect(doc.path).toBe('ui/panel.html');
    expect(doc.csp).toContain("default-src 'none'");
    expect(doc.csp).toContain("connect-src 'none'");
    // Local CSS/JS safely inlined
    expect(doc.html).toContain('color: var(--text-primary);');
    expect(doc.html).toContain("console.log('panel loaded');");
    // External stylesheet and script stripped
    expect(doc.html).not.toContain('evil.example');

    // Direct asset route enforces CSP & nosniff headers
    const rawRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/user.pr-guard-ui/ui/ui/panel.css',
    });
    expect(rawRes.statusCode).toBe(200);
    expect(rawRes.headers['content-type']).toContain('text/css');
    expect(rawRes.headers['x-content-type-options']).toBe('nosniff');
    expect(rawRes.headers['content-security-policy']).toContain("default-src 'none'");
    expect(rawRes.headers['content-security-policy']).toContain('sandbox allow-scripts');

    const authorize = (runId: string) => daemon.app.inject({
      method: 'POST', url: '/api/v1/plugins/user.pr-guard-ui/browser-authorize', payload: { runId },
    });
    const setPermission = (granted: boolean) => daemon.app.inject({
      method: 'PUT', url: '/api/v1/plugins/user.pr-guard-ui/permissions', payload: {
        workspaceId: '__global__', digest: preview.digest, capability: 'browser:preview', granted,
      },
    });
    expect((await authorize(doc.runId)).statusCode).toBe(403);
    expect((await setPermission(true)).statusCode).toBe(200);
    expect((await authorize(doc.runId)).statusCode).toBe(200);
    expect((await authorize('stale-run')).statusCode).toBe(409);
    expect((await setPermission(false)).statusCode).toBe(200);
    expect((await authorize(doc.runId)).statusCode).toBe(403);

    // Path traversal blocked with 403
    const escapeRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/user.pr-guard-ui/ui-doc?path=../../secret.txt',
    });
    expect(escapeRes.statusCode).toBe(403);

    // Disabling plugin immediately revokes UI doc serving
    await daemon.pluginManager.togglePlugin('user.pr-guard-ui', false);
    const disabledRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/user.pr-guard-ui/ui-doc?path=ui/panel.html',
    });
    expect(disabledRes.statusCode).toBe(404);
    expect((await authorize(doc.runId)).statusCode).toBe(409);
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

it('supports isolated V4 plugin ctx.slots.register and runId-verified iframe postMessage bridge', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p4-rpc-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p4-rpc-src-'));
  const daemon = createDaemon({ dataDir, port: 0 });

  try {
    await daemon.start();
    const workspace = await daemon.sessionManager.addWorkspace(staging);
    const session = await daemon.sessionManager.createSession({
      workspaceId: workspace.id,
      harnessId: 'codex',
      permissionMode: 'manual',
    });

    const pluginDir = writePluginPackage(
      staging,
      'dynamic-slot-plugin',
      {
        id: 'user.dynamic-slot',
        name: 'Dynamic Slot Plugin',
        version: '1.0.0',
        description: 'Registers UI slot at runtime and handles iframe messages',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
      },
      {
        'ui/widget.html': '<!doctype html><html><body><p>Dynamic Widget</p></body></html>',
        'index.mjs': `
          export function apply(ctx) {
            ctx.slots.register({
              slot: 'inspector.tabs',
              id: 'live-widget',
              title: '实时看板',
              ui: 'ui/widget.html',
              order: 50,
              onMessage(payload, meta) {
                return {
                  echo: payload,
                  sessionId: meta.sessionId,
                  slotId: meta.slotId,
                  runId: ctx.runId,
                };
              },
            });
          }
        `,
      },
    );

    const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: pluginDir });
    await daemon.pluginManager.installPlugin({
      mode: 'local_dir',
      dirPath: pluginDir,
      trustCode: true,
      expectedDigest: preview.digest,
      expectedInstalledDigest: preview.installedDigest,
    });

    const installed = daemon.pluginManager.listInstalled().find(({ id }) => id === 'user.dynamic-slot');
    expect(installed?.runtimeState).toBe('ACTIVE');
    expect(installed?.runId).toBeTruthy();
    expect(installed?.runtimeSlots).toEqual([
      expect.objectContaining({
        slot: 'inspector.tabs',
        id: 'live-widget',
        title: '实时看板',
        ui: 'ui/widget.html',
        order: 50,
      }),
    ]);

    // 1. Valid runId message reaches isolated plugin's onMessage handler
    const msgRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/user.dynamic-slot/ui-message',
      payload: {
        slotId: 'live-widget',
        slot: 'inspector.tabs',
        runId: installed!.runId,
        sessionId: session.id,
        payload: { action: 'ping', count: 42 },
      },
    });
    expect(msgRes.statusCode).toBe(200);
    expect(msgRes.json()).toEqual({
      result: {
        echo: { action: 'ping', count: 42 },
        sessionId: session.id,
        slotId: 'live-widget',
        runId: installed!.runId,
      },
    });

    // 2. Stale runId is rejected with 409 E_STALE_RUN
    const staleRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/user.dynamic-slot/ui-message',
      payload: {
        slotId: 'live-widget',
        slot: 'inspector.tabs',
        runId: 'stale-run-id-000',
        sessionId: session.id,
        payload: { action: 'ping' },
      },
    });
    expect(staleRes.statusCode).toBe(409);
    expect((staleRes.json() as { code: string }).code).toBe('E_STALE_RUN');

    // 3. Uninstall cleanly disposes slot and rejects further messages
    await daemon.pluginManager.uninstallPlugin('user.dynamic-slot');
    const afterUninstall = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/user.dynamic-slot/ui-message',
      payload: {
        slotId: 'live-widget',
        runId: installed!.runId,
        payload: { action: 'ping' },
      },
    });
    expect(afterUninstall.statusCode).toBe(400);
    expect((afterUninstall.json() as { code: string }).code).toBe('E_SERVICE_UNAVAILABLE');
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
});
