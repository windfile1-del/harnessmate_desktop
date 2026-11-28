import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APPLICATION_VIEW_CONTRACT } from '@harnessmate/plugin-api';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';

const TEMP_ROOT = 'D:/HarnessMate/b5-tmp/w1/daemon-tests';
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BUNDLED_DIR = path.join(REPO_ROOT, 'plugins', 'bundled');
const SHELL_LITE_DIR = path.join(REPO_ROOT, 'plugins', 'examples', 'hm.plugin.shell-lite');

function makeTempEnv(tag: string) {
  const dir = path.join(TEMP_ROOT, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const pluginsDir = path.join(dir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const dbPath = path.join(dir, 'harnessmate.sqlite');
  const store = new HarnessMateStore(dbPath);
  const registry = new HarnessRegistry();
  const manager = new PluginManager(pluginsDir, registry, () => [], new Map(), {
    store,
    bundledPluginsDir: BUNDLED_DIR,
  });
  return { dir, pluginsDir, store, registry, manager };
}

describe('B5-W1: Daemon Application Entry, Layout Switching, Draft Preservation & Rollback', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('loads default layout plugin, switches to external shell-lite without losing chat drafts or active sessions, and rolls back bad layout revision', async () => {
    const env = makeTempEnv('layout-switch');
    cleanups.push(async () => {
      await env.manager.close();
      env.store.close();
      fs.rmSync(env.dir, { recursive: true, force: true });
    });

    await env.manager.reloadAll();

    // 1. Default bundled layout is active and explicitly bound to application.view.v1
    const defaultRes = env.manager.resolveServiceSelection(APPLICATION_VIEW_CONTRACT);
    expect(defaultRes.status).toBe('ready');
    expect(defaultRes.instanceId).toBe('hm.plugin.shell-default');
    expect(defaultRes.source).toBe('composition');

    // Default layout exposes application.view.v1 service
    const defaultSvc = env.manager.host.getServiceByInstance<{
      getInfo: () => Promise<{ ok: boolean; value: { info: { layoutId: string } } }>;
      writeLayoutState: (req: { scope: string; patch: Record<string, unknown> }) => Promise<{ ok: boolean; value: { state: Record<string, unknown> } }>;
      readLayoutState: (req: { scope: string }) => Promise<{ ok: boolean; value: { state: Record<string, unknown> } }>;
    }>('hm.plugin.shell-default', APPLICATION_VIEW_CONTRACT);
    expect(defaultSvc).toBeTruthy();
    const infoRes = await defaultSvc!.getInfo();
    expect(infoRes.ok).toBe(true);
    expect(infoRes.value.info.layoutId).toBe('hm.plugin.shell-default');

    // Persist layout preference in default layout's own storage
    await defaultSvc!.writeLayoutState({ scope: 'default', patch: { sidebarCollapsed: true } });
    const persisted = await defaultSvc!.readLayoutState({ scope: 'default' });
    expect(persisted.value.state.sidebarCollapsed).toBe(true);

    // 2. Create a real workspace + active running session + unsent draft in chat.view.v1
    const now = Date.now();
    const ws = env.store.createWorkspace({
      id: 'ws_b5_w1',
      name: 'Test WS',
      rootPath: env.dir,
      isGitRepo: false,
      gitBranch: null,
      createdAt: now,
    });
    const session = env.store.createSession({
      id: 'sess_b5_w1',
      workspaceId: ws.id,
      harnessId: 'codex',
      harnessKind: 'codex',
      nativeSessionId: null,
      participatingHarnesses: ['codex'],
      contextSyncMode: 'auto',
      cwd: env.dir,
      title: 'Background Running Session',
      status: 'running',
      model: null,
      reasoningEffort: null,
      permissionMode: 'accept_edits',
      lastSeq: 0,
      usage: null,
      pendingApprovalCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const chatSvc = env.manager.host.getServiceByInstance<{
      editViewState: (req: { sessionId: string; operation: { type: string; text?: string } }) => Promise<{ ok: boolean; value: { state: { text?: string } } }>;
      readViewState: (req: { sessionId: string }) => Promise<{ ok: boolean; value: { state: { text?: string } } }>;
    }>('hm.plugin.chat-default', 'chat.view.v1');
    expect(chatSvc).toBeTruthy();
    await chatSvc!.editViewState({
      sessionId: session.id,
      operation: { type: 'setText', text: '未发送草稿：切换布局不应清空或自动发送' },
    });

    // 3. Install external hm.plugin.shell-lite via standard local preview + trust install path (v1.0.0)
    const previewV1 = await env.manager.previewInstallAsync({
      mode: 'local_dir',
      dirPath: SHELL_LITE_DIR,
    });
    await env.manager.installPlugin({
      mode: 'local_dir',
      dirPath: SHELL_LITE_DIR,
      trustCode: true,
      expectedDigest: previewV1.digest,
    });

    // Both default and external layouts are peer candidates for application.view.v1
    const afterInstall = env.manager.resolveServiceSelection(APPLICATION_VIEW_CONTRACT);
    expect(afterInstall.candidates.map((c) => c.instanceId).sort()).toEqual([
      'hm.plugin.shell-default',
      'hm.plugin.shell-lite',
    ]);

    // 4. Switch application.view.v1 binding to external hm.plugin.shell-lite
    await env.manager.setCompositionBinding(APPLICATION_VIEW_CONTRACT, 'hm.plugin.shell-lite');
    const switchedRes = env.manager.resolveServiceSelection(APPLICATION_VIEW_CONTRACT);
    expect(switchedRes.status).toBe('ready');
    expect(switchedRes.instanceId).toBe('hm.plugin.shell-lite');

    // Verify background session stays running and chat draft is untouched (never auto-sent)
    expect(env.store.getSession(session.id)?.status).toBe('running');
    const draftAfterSwitch = await chatSvc!.readViewState({ sessionId: session.id });
    expect(draftAfterSwitch.value.state.text).toBe('未发送草稿：切换布局不应清空或自动发送');

    // 5. Install a v2 revision of hm.plugin.shell-lite and verify rollback restores v1 cleanly
    const v2StageDir = path.join(env.dir, 'shell-lite-v2');
    fs.cpSync(SHELL_LITE_DIR, v2StageDir, { recursive: true });
    const manifestPath = path.join(v2StageDir, 'harnessmate-plugin.json');
    const manifestV2 = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifestV2.version = '2.0.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifestV2, null, 2));

    const previewV2 = await env.manager.previewInstallAsync({
      mode: 'local_dir',
      dirPath: v2StageDir,
    });
    await env.manager.installPlugin({
      mode: 'local_dir',
      dirPath: v2StageDir,
      trustCode: true,
      expectedDigest: previewV2.digest,
      expectedInstalledDigest: previewV1.digest,
    });

    expect(env.manager.listInstalled().find((p) => p.id === 'hm.plugin.shell-lite')?.version).toBe('2.0.0');

    // Rollback restores v1.0.0 cleanly while keeping application.view.v1 ready
    await env.manager.rollbackPlugin('hm.plugin.shell-lite');
    expect(env.manager.listInstalled().find((p) => p.id === 'hm.plugin.shell-lite')?.version).toBe('1.0.0');
    const rolledBackRes = env.manager.resolveServiceSelection(APPLICATION_VIEW_CONTRACT);
    expect(rolledBackRes.status).toBe('ready');
    expect(rolledBackRes.instanceId).toBe('hm.plugin.shell-lite');

    // 6. Disabling active layout leaves application.view.v1 disabled (no implicit host fallback)
    await env.manager.togglePlugin('hm.plugin.shell-lite', false);
    const disabledRes = env.manager.resolveServiceSelection(APPLICATION_VIEW_CONTRACT);
    expect(disabledRes.status).toBe('disabled');
    expect(disabledRes.instanceId).toBe('hm.plugin.shell-lite');

    // 7. Empty composition -> restore builtin restores hm.plugin.shell-default cleanly
    await env.manager.restoreComposition('empty');
    expect(env.manager.isEmptyComposition()).toBe(true);
    expect(env.manager.resolveServiceSelection(APPLICATION_VIEW_CONTRACT).status).toBe('unconfigured');

    await env.manager.restoreComposition('builtin');
    expect(env.manager.isEmptyComposition()).toBe(false);
    const restoredRes = env.manager.resolveServiceSelection(APPLICATION_VIEW_CONTRACT);
    expect(restoredRes.status).toBe('ready');
    expect(restoredRes.instanceId).toBe('hm.plugin.shell-default');
  });
});
