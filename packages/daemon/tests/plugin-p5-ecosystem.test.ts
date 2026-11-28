import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { packageFromFilesRecord } from '../src/plugins/plugin-package.js';
import { generatePublisherKeyPair, signPluginRelease } from '../src/plugins/plugin-registry.js';
import { buildScaffoldFiles } from '../src/plugins/developer-tools/plugin-scaffold.js';
import { createDaemon } from '../src/server/app.js';

async function waitFor(condition: () => boolean, timeoutMs = 4_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

it('recovers a trusted browser workspace across edits, rollback, shutdown, safety mode and revocation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-browser-workspace-'));
  const id = 'user.browser-workspace';
  const route = `/api/v1/plugins/${id}`;
  let daemon = createDaemon({ dataDir, port: 0 });
  const installed = () => daemon.pluginManager.listInstalled().find((plugin) => plugin.id === id);
  const viewerUrl = async (runId = installed()?.runId) => {
    const reply = await daemon.app.inject({
      method: 'POST', url: `${route}/ui-message`,
      payload: { slot: 'workspace.pages', slotId: 'browser', runId, payload: { type: 'viewer.url' } },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json<{ result: { url: string } }>().result.url;
  };
  const view = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(1_500) })).text();

  try {
    await daemon.start();
    const generated = await daemon.app.inject({
      method: 'POST', url: '/api/v1/plugin-instances/hm.plugin.developer-tools/routes/scaffold',
      payload: { id, name: '浏览器工作页', template: 'browser-workspace', linkDevMode: true },
    });
    expect(generated.statusCode).toBe(201);
    expect(installed()).toBeUndefined();
    const { dirPath } = generated.json<{ dirPath: string }>();
    const entryPath = path.join(dirPath, 'index.mjs');
    const viewerPath = path.join(dirPath, 'viewer.html');
    const entry = fs.readFileSync(entryPath, 'utf8');
    const initial = fs.readFileSync(viewerPath, 'utf8');
    const link = (trustedId?: string) => daemon.app.inject({
      method: 'POST', url: '/api/v1/plugins/dev/link', payload: { dirPath, trustedId },
    });
    const preview = await daemon.app.inject({
      method: 'POST', url: '/api/v1/plugins/dev/preview', payload: { dirPath },
    });
    expect(preview.json()).toMatchObject({ dirPath, id, hasBackend: true });
    expect((await link('user.other')).statusCode).toBe(400);
    const untrusted = await link();
    expect(untrusted.statusCode).toBe(400);
    expect(untrusted.body).toContain('关联并信任');
    expect(installed()).toBeUndefined();
    const trusted = await link(id);
    expect(trusted.statusCode, trusted.body).toBe(200);
    expect(installed()).toMatchObject({ runtimeMode: 'trusted-local', runtimeState: 'ACTIVE',
      runtimeSlots: [{ slot: 'workspace.pages', id: 'browser' }] });
    const firstRun = installed()!.runId!;
    const firstUrl = await viewerUrl();
    expect(await view(firstUrl)).toContain('输入测试文字');

    const authorize = (runId: string) => daemon.app.inject({
      method: 'POST', url: `${route}/browser-authorize`, payload: { runId },
    });
    expect((await authorize(firstRun)).statusCode).toBe(403);
    const grant = await daemon.app.inject({
      method: 'PUT', url: `${route}/permissions`,
      payload: { workspaceId: '__global__', capability: 'browser:preview', granted: true,
        digest: installed()!.packageDigest, coverFuture: true },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const authorizedRun = installed()!.runId!;
    expect((await authorize(authorizedRun)).statusCode).toBe(200);

    const originalDigest = installed()!.packageDigest;
    fs.writeFileSync(viewerPath, initial.replace('输入测试文字', '新版中文输入'));
    await waitFor(() => installed()?.canRollback === true && installed()?.packageDigest !== originalDigest, 8_000);
    const second = installed()!;
    expect(second.runtimeState).toBe('ACTIVE');
    expect((await authorize(authorizedRun)).statusCode).toBe(409);
    expect((await authorize(second.runId!)).statusCode).toBe(200);
    const secondUrl = await viewerUrl();
    expect(await view(secondUrl)).toContain('新版中文输入');

    fs.writeFileSync(entryPath, entry.replace("ctx.logger.info('本地查看服务已就绪');", "throw new Error('候选启动失败');"));
    await waitFor(() => Boolean(installed()?.loadError?.includes('候选启动失败')), 8_000);
    expect(installed()).toMatchObject({ runtimeState: 'ACTIVE', packageDigest: second.packageDigest, canRollback: true });
    expect(await view(await viewerUrl())).toContain('新版中文输入');

    expect((await daemon.app.inject({ method: 'POST', url: `${route}/rollback` })).statusCode).toBe(200);
    const rolledBackUrl = await viewerUrl();
    expect(await view(rolledBackUrl)).toContain('输入测试文字');
    expect(fs.readFileSync(entryPath, 'utf8')).toContain('候选启动失败');
    expect(fs.readFileSync(viewerPath, 'utf8')).toContain('新版中文输入');
    await daemon.stop();
    await expect(view(rolledBackUrl)).rejects.toThrow();

    daemon = createDaemon({ dataDir, port: 0, pluginSafeMode: true });
    await daemon.start();
    expect(installed()).toMatchObject({ enabled: false, packageDigest: originalDigest, devTrustedLocal: true });
    expect(installed()?.runId).toBeUndefined();
    await daemon.stop();

    daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    const restartedUrl = await viewerUrl();
    expect(await view(restartedUrl)).toContain('输入测试文字');
    const toggle = (enabled: boolean) => daemon.app.inject({
      method: 'PATCH', url: route, payload: { enabled },
    });
    expect((await toggle(false)).statusCode).toBe(200);
    expect(installed()?.runtimeSlots).toBeUndefined();
    await expect(view(restartedUrl)).rejects.toThrow();
    expect((await toggle(true)).statusCode).toBe(200);
    const beforeRevocation = await viewerUrl();
    expect((await daemon.app.inject({ method: 'DELETE', url: `/api/v1/plugins/dev/${id}/trust` })).statusCode).toBe(200);
    expect(installed()).toMatchObject({ devTrustedLocal: false, runtimeMode: 'isolated', runtimeState: 'FAILED' });
    expect(installed()?.runtimeSlots).toBeUndefined();
    await expect(view(beforeRevocation)).rejects.toThrow();
    await daemon.stop();

    daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    expect(installed()).toMatchObject({ devTrustedLocal: false, runtimeMode: 'isolated' });
    expect(installed()?.runId).toBeUndefined();
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 40_000);

it('scaffolds V4 templates, hot-reloads linked dev-mode plugins with unified logs, and preserves source dir on unlink', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p5-dev-'));
  const targetDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p5-src-')), 'demo-plugin');
  const daemon = createDaemon({ dataDir, port: 0 });

  try {
    await daemon.start();

    // Verify all 4 scaffold templates produce valid packages
    for (const template of ['isolated', 'ui-slot', 'service', 'declarative'] as const) {
      const { files } = buildScaffoldFiles({
        id: `user.tpl-${template}`,
        name: `Template ${template}`,
        template,
      });
      const pack = packageFromFilesRecord(files);
      expect(pack.manifest.apiVersion).toBe(4);
      expect(pack.manifest.engines?.pluginApi).toBe('^4.0');
    }

    // 1. Scaffold an isolated + UI slot plugin and auto-link in dev mode
    const scaffoldRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/hm.plugin.developer-tools/routes/scaffold',
      payload: {
        id: 'user.dev-demo',
        name: 'Dev Demo',
        template: 'isolated',
        targetDir,
        linkDevMode: true,
      },
    });
    expect(scaffoldRes.statusCode).toBe(201);
    const created = scaffoldRes.json() as {
      dirPath: string;
      files: string[];
      plugins: Array<{ id: string; devMode?: boolean; devSourceDir?: string; runId?: string; runtimeState?: string }>;
    };
    expect(created.files).toContain('harnessmate-plugin.json');
    expect(created.files).toContain('index.mjs');
    expect(created.files).toContain('ui/panel.html');

    const browserScaffold = await daemon.app.inject({
      method: 'POST', url: '/api/v1/plugin-instances/hm.plugin.developer-tools/routes/scaffold', payload: {
        id: 'user.dev-browser', name: 'Preview', template: 'browser-preview', linkDevMode: false,
      },
    });
    expect(browserScaffold.statusCode).toBe(201);
    const browserScaffoldResult = browserScaffold.json() as { dirPath: string; files: string[] };
    expect(browserScaffoldResult.files).toContain('ui/panel.js');
    expect(browserScaffoldResult.files).not.toContain('index.mjs');
    expect(JSON.parse(fs.readFileSync(path.join(browserScaffoldResult.dirPath, 'harnessmate-plugin.json'), 'utf8')))
      .toMatchObject({ permissions: ['browser:preview'] });

    const initialPlugin = created.plugins.find(({ id }) => id === 'user.dev-demo');
    expect(initialPlugin?.devMode).toBe(true);
    expect(initialPlugin?.runtimeState).toBe('ACTIVE');
    expect(initialPlugin?.runId).toBeTruthy();
    const initialRunId = initialPlugin!.runId!;

    // Verify initial isolated plugin responds to UI message
    const msg1 = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/user.dev-demo/ui-message',
      payload: { slotId: 'dev-demo-view', runId: initialRunId, payload: { v: 1 } },
    });
    expect(msg1.statusCode).toBe(200);
    expect((msg1.json() as { result: { ok: boolean; runId: string } }).result.runId).toBe(initialRunId);

    // 2. Edit source file in place -> watcher auto-reloads with a fresh runId
    fs.writeFileSync(
      path.join(created.dirPath, 'index.mjs'),
      `export const name = 'user.dev-demo';
export function apply(ctx) {
  ctx.logger.info('hot-reloaded-v2', { runId: ctx.runId });
  ctx.slots.register({
    slot: 'inspector.tabs',
    id: 'dev-demo-view',
    title: 'Dev Demo v2',
    ui: 'ui/panel.html',
    onMessage(payload) {
      return { version: 2, echo: payload, runId: ctx.runId };
    },
  });
}
`,
    );

    await waitFor(() => {
      const current = daemon.pluginManager.listInstalled().find(({ id }) => id === 'user.dev-demo');
      return Boolean(current?.runId && current.runId !== initialRunId && current.runtimeState === 'ACTIVE');
    }, 5_000);

    const reloadedPlugin = daemon.pluginManager.listInstalled().find(({ id }) => id === 'user.dev-demo');
    const nextRunId = reloadedPlugin!.runId!;
    expect(nextRunId).not.toBe(initialRunId);

    // Old runId is rejected with E_STALE_RUN
    const staleRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/user.dev-demo/ui-message',
      payload: { slotId: 'dev-demo-view', runId: initialRunId, payload: { v: 1 } },
    });
    expect(staleRes.statusCode).toBe(409);
    expect((staleRes.json() as { code: string }).code).toBe('E_STALE_RUN');

    // New runId executes v2 handler
    const msg2 = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/user.dev-demo/ui-message',
      payload: { slotId: 'dev-demo-view', runId: nextRunId, payload: { v: 2 } },
    });
    expect(msg2.statusCode).toBe(200);
    expect((msg2.json() as { result: { version: number; runId: string } }).result).toMatchObject({
      version: 2,
      runId: nextRunId,
    });

    // 3. Unified logs contain both host lifecycle logs and plugin ctx.logger logs
    const logsRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/user.dev-demo/logs',
    });
    expect(logsRes.statusCode).toBe(200);
    const logs = (logsRes.json() as { logs: Array<{ source?: string; message: string }> }).logs;
    expect(logs.some((entry) => entry.source === 'host' && entry.message.includes('热重载'))).toBe(true);
    expect(logs.some((entry) => entry.source === 'plugin' && entry.message.includes('hot-reloaded-v2'))).toBe(true);

    const clearRes = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/v1/plugins/user.dev-demo/logs',
    });
    expect(clearRes.statusCode).toBe(200);
    const afterClear = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins/user.dev-demo/logs' });
    expect((afterClear.json() as { logs: unknown[] }).logs).toHaveLength(0);

    // 4. Unlink dev plugin removes it from host while preserving user's source code directory
    const unlinkRes = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/v1/plugins/dev/user.dev-demo',
    });
    expect(unlinkRes.statusCode).toBe(200);
    expect(daemon.pluginManager.listInstalled().some(({ id }) => id === 'user.dev-demo')).toBe(false);
    expect(fs.existsSync(path.join(created.dirPath, 'index.mjs'))).toBe(true);
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(targetDir), { recursive: true, force: true });
  }
}, 15_000);

it('verifies remote plugin index Ed25519 signatures, blocks tampered/untrusted/incompatible packages, and installs verified releases', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p5-reg-'));
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p5-idx-'));
  const daemon = createDaemon({ dataDir, port: 0 });

  try {
    await daemon.start();

    const trustedKeys = generatePublisherKeyPair();
    const untrustedKeys = generatePublisherKeyPair();

    // Entry 1: Verified declarative plugin from trusted publisher
    const verifiedFiles = buildScaffoldFiles({
      id: 'user.signed-workflow',
      name: '已签名工作流插件',
      template: 'declarative',
    }).files;
    const verifiedPack = packageFromFilesRecord(verifiedFiles);
    const verifiedSig = signPluginRelease(trustedKeys.privateKeyPem, {
      id: verifiedPack.manifest.id,
      version: verifiedPack.manifest.version,
      packageDigest: verifiedPack.digest,
      pluginApi: '^4.0',
    });

    // Entry 2: Tampered package (signature valid for original digest, but files altered afterwards)
    const tamperedFiles = {
      ...verifiedFiles,
      'README.md': '# TAMPERED CONTENT\n',
    };

    // Entry 3: Untrusted publisher plugin (valid keypair, but publisher not trusted by host)
    const untrustedFiles = buildScaffoldFiles({
      id: 'user.untrusted-plugin',
      name: '未信任发布者插件',
      template: 'declarative',
    }).files;
    const untrustedPack = packageFromFilesRecord(untrustedFiles);
    const untrustedSig = signPluginRelease(untrustedKeys.privateKeyPem, {
      id: untrustedPack.manifest.id,
      version: untrustedPack.manifest.version,
      packageDigest: untrustedPack.digest,
      pluginApi: '^4.0',
    });

    // Entry 4: Incompatible future API version (^5.0)
    const futureManifest = {
      id: 'user.future-v5',
      name: '未来 V5 插件',
      version: '2.0.0',
      description: 'Requires Plugin API ^5.0',
      category: 'workflow',
      apiVersion: 4,
      engines: { pluginApi: '^5.0' },
      contributes: {},
    };
    const futureFiles = { 'harnessmate-plugin.json': JSON.stringify(futureManifest, null, 2) };
    const futurePack = packageFromFilesRecord(futureFiles);
    const futureSig = signPluginRelease(trustedKeys.privateKeyPem, {
      id: futurePack.manifest.id,
      version: futurePack.manifest.version,
      packageDigest: futurePack.digest,
      pluginApi: '^5.0',
    });

    const indexPath = path.join(indexDir, 'index.json');
    fs.writeFileSync(
      indexPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          registryName: 'Test Official Registry',
          publishers: [
            { id: 'acme-trusted', name: 'Acme Official', publicKeyPem: trustedKeys.publicKeyPem },
            { id: 'stranger-pub', name: 'Stranger Pub', publicKeyPem: untrustedKeys.publicKeyPem },
          ],
          entries: [
            {
              id: verifiedPack.manifest.id,
              name: verifiedPack.manifest.name,
              version: verifiedPack.manifest.version,
              description: verifiedPack.manifest.description,
              category: 'workflow',
              tags: ['signed'],
              engines: { pluginApi: '^4.0' },
              publisherId: 'acme-trusted',
              packageDigest: verifiedPack.digest,
              signature: verifiedSig,
              files: verifiedFiles,
            },
            {
              id: 'user.tampered-plugin',
              name: '篡改测试插件',
              version: '0.1.0',
              description: 'Tampered bytes after signing',
              category: 'workflow',
              tags: [],
              engines: { pluginApi: '^4.0' },
              publisherId: 'acme-trusted',
              packageDigest: verifiedPack.digest,
              signature: signPluginRelease(trustedKeys.privateKeyPem, {
                id: 'user.tampered-plugin',
                version: '0.1.0',
                packageDigest: verifiedPack.digest,
                pluginApi: '^4.0',
              }),
              files: tamperedFiles,
            },
            {
              id: 'user.bad-sig',
              name: '伪造签名插件',
              version: '0.1.0',
              description: 'Invalid Ed25519 signature',
              category: 'workflow',
              tags: [],
              engines: { pluginApi: '^4.0' },
              publisherId: 'acme-trusted',
              packageDigest: verifiedPack.digest,
              signature: Buffer.from('not-a-valid-ed25519-signature').toString('base64'),
              files: verifiedFiles,
            },
            {
              id: untrustedPack.manifest.id,
              name: untrustedPack.manifest.name,
              version: untrustedPack.manifest.version,
              description: untrustedPack.manifest.description,
              category: 'workflow',
              tags: [],
              engines: { pluginApi: '^4.0' },
              publisherId: 'stranger-pub',
              packageDigest: untrustedPack.digest,
              signature: untrustedSig,
              files: untrustedFiles,
            },
            {
              id: futurePack.manifest.id,
              name: futurePack.manifest.name,
              version: futurePack.manifest.version,
              description: futurePack.manifest.description,
              category: 'workflow',
              tags: [],
              engines: { pluginApi: '^5.0' },
              publisherId: 'acme-trusted',
              packageDigest: futurePack.digest,
              signature: futureSig,
              files: futureFiles,
            },
          ],
        },
        null,
        2,
      ),
    );

    // Register trusted publisher key and configure remote index URL
    const addPubRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/registry/publishers',
      payload: {
        id: 'acme-trusted',
        name: 'Acme Official',
        publicKeyPem: trustedKeys.publicKeyPem,
      },
    });
    expect(addPubRes.statusCode).toBe(201);

    const cfgRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/registry/config',
      payload: {
        indexUrls: [pathToFileURL(indexPath).href],
        requireSigned: true,
      },
    });
    expect(cfgRes.statusCode).toBe(200);
    const catalog = (cfgRes.json() as {
      catalog: Array<{ id: string; source?: string; signatureStatus?: string; compatible?: boolean }>;
    }).catalog;

    expect(catalog.find((c) => c.id === 'user.signed-workflow')).toMatchObject({
      source: 'remote',
      signatureStatus: 'verified',
      compatible: true,
    });
    expect(catalog.find((c) => c.id === 'user.bad-sig')).toMatchObject({
      source: 'remote',
      signatureStatus: 'invalid',
      compatible: true,
    });
    expect(catalog.find((c) => c.id === 'user.untrusted-plugin')).toMatchObject({
      source: 'remote',
      signatureStatus: 'untrusted_publisher',
      compatible: true,
    });
    expect(catalog.find((c) => c.id === 'user.future-v5')).toMatchObject({
      source: 'remote',
      signatureStatus: 'verified',
      compatible: false,
    });

    // 1. Invalid signature is blocked
    const badSigInstall = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { mode: 'remote_index', pluginId: 'user.bad-sig' },
    });
    expect(badSigInstall.statusCode).toBe(400);
    expect((badSigInstall.json() as { code: string }).code).toBe('E_PERMISSION_DENIED');

    // 2. Tampered file contents after signing are blocked by digest/id verification
    const tamperedInstall = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { mode: 'remote_index', pluginId: 'user.tampered-plugin' },
    });
    expect(tamperedInstall.statusCode).toBe(400);

    // 3. Untrusted publisher is blocked when requireSigned=true
    const untrustedInstall = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { mode: 'remote_index', pluginId: 'user.untrusted-plugin' },
    });
    expect(untrustedInstall.statusCode).toBe(400);
    expect((untrustedInstall.json() as { code: string }).code).toBe('E_PERMISSION_DENIED');

    // 4. Incompatible API version (^5.0) is blocked with E_NOT_SUPPORTED
    const futureInstall = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { mode: 'remote_index', pluginId: 'user.future-v5' },
    });
    expect(futureInstall.statusCode).toBe(400);
    expect((futureInstall.json() as { code: string }).code).toBe('E_NOT_SUPPORTED');

    // 5. Verified + compatible plugin previews and installs cleanly!
    const previewRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/preview',
      payload: { mode: 'remote_index', pluginId: 'user.signed-workflow' },
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json() as { digest: string };
    expect(preview.digest).toBe(verifiedPack.digest);

    const okInstall = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: {
        mode: 'remote_index',
        pluginId: 'user.signed-workflow',
        expectedDigest: preview.digest,
      },
    });
    expect(okInstall.statusCode).toBe(201);
    const installed = daemon.pluginManager.listInstalled().find(({ id }) => id === 'user.signed-workflow');
    expect(installed?.runtimeState).toBe('ACTIVE');
    expect(installed?.packageDigest).toBe(verifiedPack.digest);
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}, 15_000);
