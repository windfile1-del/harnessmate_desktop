import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldPluginFiles } from '@harnessmate/plugin-sdk';
import { expect, it } from 'vitest';
import { createDaemon } from '../src/server/app.js';

it('binds a workspace-authorized file preview and keeps the original preview across recovery operations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-file-preview-'));
  const cwd = path.join(root, 'workspace');
  const otherCwd = path.join(root, 'other');
  const dataDir = path.join(root, 'data');
  const pluginDir = path.join(root, 'plugin');
  const id = 'user.markdown-preview';
  const content = '# Source heading\n\nSource line\n';
  fs.mkdirSync(cwd);
  fs.mkdirSync(otherCwd);
  fs.mkdirSync(pluginDir);
  for (const name of ['README.MD', 'plain.txt', 'error.md', 'timeout.md', 'invalid.md', 'late.md']) {
    fs.writeFileSync(path.join(cwd, name), content);
  }
  fs.writeFileSync(path.join(otherCwd, 'README.MD'), content);
  fs.writeFileSync(path.join(root, 'outside.md'), 'Outside workspace');
  const { files } = scaffoldPluginFiles({ id, name: 'Markdown Preview', template: 'markdown-preview' });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(pluginDir, name), text);

  let daemon = createDaemon({ dataDir, port: 0, pluginCrashPolicy: { maxCrashesInWindow: 1 } });
  try {
    await daemon.start();
    const workspace = await daemon.sessionManager.addWorkspace(cwd);
    const otherWorkspace = await daemon.sessionManager.addWorkspace(otherCwd);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'codex', permissionMode: 'manual' });
    const otherSession = await daemon.sessionManager.createSession({ workspaceId: otherWorkspace.id, harnessId: 'codex', permissionMode: 'manual' });
    const setProvider = (pluginId: string | null) => daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/file-preview',
      payload: { pluginId, workspaceId: workspace.id },
    });
    const render = (name = 'README.MD', sessionId = session.id) => daemon.app.inject(
      `/api/v1/sessions/${sessionId}/file-preview?path=${encodeURIComponent(name)}&line=3`,
    );
    const raw = () => daemon.app.inject(`/api/v1/sessions/${session.id}/file-content?path=README.MD`);
    const restore = () => daemon.app.inject({
      method: 'POST', url: '/api/v1/plugins/composition/restore', payload: { source: 'previous' },
    });
    const installed = () => daemon.pluginManager.listInstalled().find((item) => item.id === id);
    const install = async () => {
      const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: pluginDir });
      await daemon.pluginManager.installPlugin({
        mode: 'local_dir', dirPath: pluginDir, trustCode: true,
        expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest,
      });
      return preview.digest;
    };
    const grant = async (digest: string, granted: boolean) => {
      const response = await daemon.app.inject({
        method: 'PUT', url: `/api/v1/plugins/${id}/permissions`,
        payload: { workspaceId: workspace.id, digest, capability: 'file:preview', granted },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const expectFallback = async (name?: string) => {
      expect((await render(name)).json()).toEqual({ preview: null });
      expect((await raw()).json()).toEqual({ relativePath: 'README.MD', content, sizeBytes: Buffer.byteLength(content), truncated: false });
    };

    await expectFallback();
    const digest = await install();
    expect((await setProvider(id)).statusCode).toBe(400);
    await grant(digest, true);
    expect((await setProvider(id)).statusCode).toBe(200);
    expect((await render()).json().preview).toMatchObject({ pluginId: id, format: 'markdown', content, line: 3 });
    expect((await render('README.MD', otherSession.id)).json()).toEqual({ preview: null });
    expect((await render('../outside.md')).statusCode).toBe(400);
    await expectFallback('plain.txt');

    const runId = installed()?.runId;
    expect((await setProvider(null)).statusCode).toBe(200);
    await expectFallback();
    expect(installed()).toMatchObject({ runtimeState: 'ACTIVE', runId });
    expect((await restore()).statusCode).toBe(200);
    expect((await render()).json().preview.pluginId).toBe(id);
    await daemon.pluginManager.togglePlugin(id, false);
    await expectFallback();
    await daemon.pluginManager.togglePlugin(id, true);
    expect((await render()).json().preview.pluginId).toBe(id);

    fs.writeFileSync(path.join(pluginDir, 'index.mjs'), 'export function apply() {}\n');
    await expect(install()).rejects.toThrow('renderFilePreview');
    expect((await render()).json().preview.pluginId).toBe(id);

    fs.writeFileSync(path.join(pluginDir, 'index.mjs'), `
      export function apply(ctx) { logger = ctx.logger; }
      let logger;
      export async function renderFilePreview(file) {
        if (file.relativePath === 'error.md') throw new Error('render failed');
        if (file.relativePath === 'timeout.md') return new Promise(() => {});
        if (file.relativePath === 'invalid.md') return { version: 2, content: 'unsupported' };
        if (file.relativePath === 'late.md') {
          logger.info('delayed preview started');
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        return { version: 1, format: 'text', content: 'New revision' };
      }
    `);
    const nextDigest = await install();
    await expectFallback();
    await grant(nextDigest, true);
    expect((await render()).json().preview.format).toBe('text');
    await expectFallback('error.md');
    await expectFallback('timeout.md');
    await expectFallback('invalid.md');
    expect(installed()?.runtimeState).toBe('ACTIVE');
    const late = render('late.md');
    await expect.poll(() => daemon.pluginManager.getLogs(id).some(({ message }) => message === 'delayed preview started'),
      { interval: 20 }).toBe(true);
    await grant(nextDigest, false);
    await grant(nextDigest, true);
    expect((await late).json()).toEqual({ preview: null });
    await grant(nextDigest, false);
    await expectFallback();

    await grant(nextDigest, true);
    daemon.pluginManager.isolated!.getActive(id)!.process.forceKill();
    await expect.poll(() => installed()?.runtimeState).toBe('FAILED');
    await expectFallback();

    await daemon.pluginManager.rollbackPlugin(id);
    await expectFallback();
    await grant(digest, true);
    expect((await render()).json().preview).toMatchObject({ format: 'markdown', line: 3 });
    await daemon.stop();
    daemon = createDaemon({ dataDir, port: 0, pluginSafeMode: true });
    await daemon.start();
    await expectFallback();
    await daemon.stop();
    daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    expect((await render()).json().preview.pluginId).toBe(id);
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
