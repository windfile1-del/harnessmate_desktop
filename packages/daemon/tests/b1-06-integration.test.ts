import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortableSessionBundleV2 } from '@harnessmate/protocol';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const customSourceExampleDir = path.join(repoRoot, 'plugins', 'examples', 'hm.plugin.history-source-custom');
const liteSearchExampleDir = path.join(repoRoot, 'plugins', 'examples', 'hm.plugin.session-search-lite');

const tempDirs: string[] = [];
const activeDaemons: DaemonInstance[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort cleanup on Windows transient handles
  }
}

async function installTrustedPlugin(daemon: DaemonInstance, dirPath: string, capabilities: string[]) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  for (const capability of capabilities) {
    const res = await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/plugins/${preview.manifest.id}/permissions`,
      payload: {
        workspaceId: '__global__',
        digest: preview.digest,
        capability,
        granted: true,
      },
    });
    expect(res.statusCode).toBe(200);
  }
  return preview;
}

function buildChineseBundle(
  sessionId: string,
  cwd: string,
  title: string,
  userText: string,
  assistantText: string,
): PortableSessionBundleV2 {
  const now = Date.now();
  return {
    bundleVersion: 2,
    exportedAt: now,
    redacted: true,
    redactionCategories: [],
    redactedCount: 0,
    session: {
      originalId: sessionId,
      title,
      harnessId: 'codex',
      harnessKind: 'codex',
      permissionMode: 'manual',
      cwd,
      participatingHarnesses: ['codex'],
      createdAt: now,
      updatedAt: now,
    },
    items: [
      {
        itemId: `${sessionId}-item-1`,
        schemaVersion: 2,
        sessionId,
        turnId: `${sessionId}-turn-1`,
        seq: 1,
        instanceId: 'codex',
        driverId: 'codex',
        blockType: 'user_message',
        status: 'completed',
        title: '',
        textBody: userText,
        payload: {},
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        itemId: `${sessionId}-item-2`,
        schemaVersion: 2,
        sessionId,
        turnId: `${sessionId}-turn-1`,
        seq: 2,
        instanceId: 'codex',
        driverId: 'codex',
        blockType: 'assistant_text',
        status: 'completed',
        title: '',
        textBody: assistantText,
        payload: {},
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: now + 10,
        updatedAt: now + 10,
      },
    ],
    events: [
      {
        seq: 1,
        type: 'message.user',
        turnId: `${sessionId}-turn-1`,
        createdAt: now,
        payload: { text: userText },
      },
      {
        seq: 2,
        type: 'message.assistant.completed',
        turnId: `${sessionId}-turn-1`,
        createdAt: now + 10,
        payload: { text: assistantText },
      },
    ],
  };
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    await activeDaemons.pop()!.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    safeRmSync(tempDirs.pop()!);
  }
});

describe('B1-06 · Batch 1 Integrated Distribution, Compat Routes & Recovery', () => {
  it('loads default Batch 1 distribution composition, runs peer history/import/search end-to-end, isolates disable & offline catch-up, and recovers empty composition', async () => {
    const dataDir = makeTempDir('hm-b1-06-data-');
    const wsDirA = makeTempDir('hm-b1-06-ws-a-');
    const wsDirB = makeTempDir('hm-b1-06-ws-b-');

    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      bundledPluginsDir: path.join(repoRoot, 'plugins', 'bundled'),
      webDistDir: null,
    });
    activeDaemons.push(daemon);
    await daemon.start();

    // 1. Default distribution composition exposes all Batch 1 bundled plugins & service bindings
    const pluginsRes = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins' });
    expect(pluginsRes.statusCode).toBe(200);
    const pluginsPayload = pluginsRes.json() as {
      emptyComposition: boolean;
      plugins: Array<{ id: string; enabled: boolean; runtimeState: string }>;
    };
    expect(pluginsPayload.emptyComposition).toBe(false);

    for (const bundledId of [
      'hm.plugin.history-source-codex',
      'hm.plugin.history-source-claude',
      'hm.plugin.history-source-agy-cli',
      'hm.plugin.history-source-agy-desktop',
      'hm.plugin.history-import',
      'hm.plugin.session-search-fts',
      'hm.plugin.browser-desktop',
      'hm.plugin.file-preview-text',
      'hm.plugin.approval-policy-default',
    ]) {
      expect(pluginsPayload.plugins.find((p) => p.id === bundledId)).toMatchObject({
        enabled: true,
        runtimeState: 'ACTIVE',
      });
    }

    for (const [contract, expectedInstanceId] of [
      ['history.import.v1', 'hm.plugin.history-import'],
      ['session.search.v1', 'hm.plugin.session-search-fts'],
      ['hm.session-data.v1', 'core.history-session-data'],
      ['browser.v1', 'hm.plugin.browser-desktop'],
      ['filePreview.v1', 'hm.plugin.file-preview-text'],
      ['approval.policy.v1', 'hm.plugin.approval-policy-default'],
    ] as const) {
      const resolveRes = await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/plugins/services/resolve?contract=${encodeURIComponent(contract)}`,
      });
      expect(resolveRes.statusCode).toBe(200);
      expect(resolveRes.json()).toMatchObject({
        contract,
        instanceId: expectedInstanceId,
        source: 'composition',
        status: 'ready',
      });
    }

    const wsA = await daemon.sessionManager.addWorkspace(wsDirA, 'Batch 1 WS A');
    const wsB = await daemon.sessionManager.addWorkspace(wsDirB, 'Batch 1 WS B');
    const bindingsRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsA.id}/bindings`,
    });
    expect(bindingsRes.statusCode).toBe(200);
    expect(bindingsRes.json().resolved).toMatchObject({
      'browser.v1': { instanceId: 'hm.plugin.browser-desktop' },
      'filePreview.v1': { instanceId: 'hm.plugin.file-preview-text' },
      'approval.policy.v1': { instanceId: 'hm.plugin.approval-policy-default' },
      'history.import.v1': { instanceId: 'hm.plugin.history-import' },
      'session.search.v1': { instanceId: 'hm.plugin.session-search-fts' },
    });

    // 2. Install 3rd-party custom source & alternative Lite search plugin; bind wsB -> lite search
    await installTrustedPlugin(daemon, customSourceExampleDir, ['fs:cli_histories:read']);
    await installTrustedPlugin(daemon, liteSearchExampleDir, [
      'session:read',
      'events:turn',
      'events:message',
      'storage:plugin',
    ]);
    await daemon.pluginManager.setWorkspaceBinding(wsB.id, 'session.search.v1', 'hm.plugin.session-search-lite');

    // Discover & import via 3rd-party custom source + bundled history-import plugin
    const customDiscoverRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/user.history-source-custom/routes/discover',
      payload: { limit: 10 },
    });
    expect(customDiscoverRes.statusCode).toBe(200);
    const customSessions = customDiscoverRes.json().value.sessions as Array<{
      ref: { sourceInstanceId: string; sourceId: string; nativeSessionId: string };
    }>;
    expect(customSessions.length).toBeGreaterThan(0);

    const nativeImportRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/hm.plugin.history-import/routes/import',
      payload: {
        input: { kind: 'native', ref: customSessions[0]!.ref, mode: 'attach' },
        workspaceId: wsA.id,
        requestId: 'b1-06-custom-import-1',
      },
    });
    expect(nativeImportRes.statusCode).toBe(200);
    expect(nativeImportRes.json().ok).toBe(true);
    const customImportedSessionId = nativeImportRes.json().value.sessionId as string;

    // Import Chinese bundles through /api/v1/sessions/import-bundle (routed via hm.plugin.history-import -> core.history-session-data)
    const bundleARes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: {
        bundle: buildChineseBundle('bundle-src-a', wsDirA, '集成测试会话 A', '请确认集成中文检索定位', '已完成中文检索索引入库'),
        workspaceId: wsA.id,
      },
    });
    expect(bundleARes.statusCode).toBe(201);
    const sessionAId = bundleARes.json().session.id as string;

    const bundleBRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: {
        bundle: buildChineseBundle('bundle-src-b', wsDirB, '集成测试会话 B', '轻量引擎独立索引词', '工作区 B 使用 轻量搜索 提供方'),
        workspaceId: wsB.id,
      },
    });
    expect(bundleBRes.statusCode).toBe(201);

    // Trigger reindex on both search engines and verify per-workspace search + Chinese turnId anchor
    const reindexARes = await daemon.app.inject({ method: 'POST', url: '/api/v1/search/reindex', payload: { workspaceId: wsA.id } });
    expect(reindexARes.statusCode).toBe(200);
    const reindexBRes = await daemon.app.inject({ method: 'POST', url: '/api/v1/search/reindex', payload: { workspaceId: wsB.id } });
    expect(reindexBRes.statusCode).toBe(200);

    const searchARes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('中文检索')}&workspaceId=${encodeURIComponent(wsA.id)}`,
    });
    expect(searchARes.statusCode).toBe(200);
    const hitsA = searchARes.json().hits as Array<{ sessionId: string; turnId: string; snippetHtmlSafe: string }>;
    expect(hitsA.length).toBeGreaterThan(0);
    expect(hitsA[0]!.sessionId).toBe(sessionAId);
    expect(hitsA[0]!.turnId).toBeTruthy();
    expect(hitsA[0]!.snippetHtmlSafe).toContain('<mark>');

    // 3. Disable hm.plugin.session-search-fts: wsA fails closed while wsB (lite) stays operational; offline mutation catches up on re-enable
    const disableFts = await daemon.app.inject({
      method: 'PATCH',
      url: '/api/v1/plugins/hm.plugin.session-search-fts',
      payload: { enabled: false },
    });
    expect(disableFts.statusCode).toBe(200);

    const disabledSearchA = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('中文检索')}&workspaceId=${encodeURIComponent(wsA.id)}`,
    });
    expect(disabledSearchA.statusCode).toBe(503);
    expect(disabledSearchA.json().code).toBe('E_SERVICE_UNAVAILABLE');

    const healthySearchB = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('轻量搜索')}&workspaceId=${encodeURIComponent(wsB.id)}`,
    });
    expect(healthySearchB.statusCode).toBe(200);
    expect(healthySearchB.json().hits.length).toBeGreaterThan(0);

    const offlineBundleRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: {
        bundle: buildChineseBundle('bundle-src-offline', wsDirA, '离线增量会话', '停用期间新增离线增量词条', '恢复启用后应增量追平'),
        workspaceId: wsA.id,
      },
    });
    expect(offlineBundleRes.statusCode).toBe(201);
    const offlineSessionId = offlineBundleRes.json().session.id as string;

    const enableFts = await daemon.app.inject({
      method: 'PATCH',
      url: '/api/v1/plugins/hm.plugin.session-search-fts',
      payload: { enabled: true },
    });
    expect(enableFts.statusCode).toBe(200);

    const catchupReindex = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/search/reindex?workspaceId=${encodeURIComponent(wsA.id)}`,
      payload: { mode: 'incremental', workspaceId: wsA.id },
    });
    expect(catchupReindex.statusCode).toBe(200);

    const catchupSearch = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('离线增量词条')}&workspaceId=${encodeURIComponent(wsA.id)}`,
    });
    expect(catchupSearch.statusCode).toBe(200);
    expect(catchupSearch.json().hits.some((h: { sessionId: string }) => h.sessionId === offlineSessionId)).toBe(true);

    // 4. Disable hm.plugin.history-import: compat routes fail closed (503) while existing imported sessions stay readable & exportable
    const disableImport = await daemon.app.inject({
      method: 'PATCH',
      url: '/api/v1/plugins/hm.plugin.history-import',
      payload: { enabled: false },
    });
    expect(disableImport.statusCode).toBe(200);

    const disabledImportRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/import-session',
      remoteAddress: '127.0.0.1',
      payload: { source: 'codex_cli', nativeSessionId: 'any-sid', mode: 'attach' },
    });
    expect(disabledImportRes.statusCode).toBe(503);
    expect(disabledImportRes.json().code).toBe('E_SERVICE_UNAVAILABLE');
    expect(disabledImportRes.json().resolution.status).toBe('disabled');

    const disabledBundleImportRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: { bundle: buildChineseBundle('bundle-blocked', wsDirA, 'Blocked', 'blocked', 'blocked'), workspaceId: wsA.id },
    });
    expect(disabledBundleImportRes.statusCode).toBe(503);

    const readEventsRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${customImportedSessionId}/events`,
    });
    expect(readEventsRes.statusCode).toBe(200);
    const exportRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionAId}/export?format=markdown`,
    });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.body).toContain('集成中文检索定位');

    // 5. Empty composition & recovery restores distribution defaults cleanly
    const emptyRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/composition/restore',
      payload: { source: 'empty' },
    });
    expect(emptyRes.statusCode).toBe(200);
    expect((await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins' })).json().emptyComposition).toBe(true);

    const restoreBuiltinRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/composition/restore',
      payload: { source: 'builtin' },
    });
    expect(restoreBuiltinRes.statusCode).toBe(200);
    expect((await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins' })).json().emptyComposition).toBe(false);
    expect(
      (await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins/services/resolve?contract=history.import.v1' })).json(),
    ).toMatchObject({ instanceId: 'hm.plugin.history-import', status: 'ready' });
  }, 60_000);

  it('supports enabled-state instant search/delete without manual reindex and preserves peer workspace changes during scoped reindex', async () => {
    const dataDir = makeTempDir('hm-b1-06-live-sync-');
    const wsDir1 = makeTempDir('hm-b1-06-live-ws1-');
    const wsDir2 = makeTempDir('hm-b1-06-live-ws2-');

    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      bundledPluginsDir: path.join(repoRoot, 'plugins', 'bundled'),
      webDistDir: null,
    });
    activeDaemons.push(daemon);
    await daemon.start();

    const ws1 = await daemon.sessionManager.addWorkspace(wsDir1, 'Live WS 1');
    const ws2 = await daemon.sessionManager.addWorkspace(wsDir2, 'Live WS 2');

    // 1. Enabled-state bundle import is immediately searchable WITHOUT manual reindex
    const imp1 = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: {
        bundle: buildChineseBundle('live-1', wsDir1, '即时索引会话 1', '唯一即时关键词 AlphaLiveTerm', '无需手动重建即可命中'),
        workspaceId: ws1.id,
      },
    });
    expect(imp1.statusCode).toBe(201);
    const sid1 = imp1.json().session.id as string;

    const instantHit = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('AlphaLiveTerm')}&workspaceId=${encodeURIComponent(ws1.id)}`,
    });
    expect(instantHit.statusCode).toBe(200);
    expect(instantHit.json().hits.some((h: { sessionId: string }) => h.sessionId === sid1)).toBe(true);

    // 2. Deleting the session removes it from enabled-state search WITHOUT manual reindex
    const del1 = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sid1}`,
    });
    expect(del1.statusCode).toBe(200);

    const afterDeleteHit = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('AlphaLiveTerm')}&workspaceId=${encodeURIComponent(ws1.id)}`,
    });
    expect(afterDeleteHit.statusCode).toBe(200);
    expect(afterDeleteHit.json().hits).toHaveLength(0);

    // 3. Scoped workspace 1 reindex while workspace 2 has unconsumed create & delete changes
    const ws2Initial = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: {
        bundle: buildChineseBundle('live-ws2-init', wsDir2, '工作区 2 初始会话', 'Ws2OldToken 删除前词条', '初始文本'),
        workspaceId: ws2.id,
      },
    });
    expect(ws2Initial.statusCode).toBe(201);
    const ws2OldId = ws2Initial.json().session.id as string;

    const ws2InitialSearch = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('Ws2OldToken')}`,
    });
    expect(ws2InitialSearch.statusCode).toBe(200);
    expect(ws2InitialSearch.json().hits.some((h: { sessionId: string }) => h.sessionId === ws2OldId)).toBe(true);

    // Pause search engine, mutate ws1 & ws2, re-enable and run scoped reindex on ws1 ONLY
    expect((await daemon.app.inject({
      method: 'PATCH',
      url: '/api/v1/plugins/hm.plugin.session-search-fts',
      payload: { enabled: false },
    })).statusCode).toBe(200);

    const ws1New = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: {
        bundle: buildChineseBundle('live-ws1-new', wsDir1, '工作区 1 新增', 'Ws1ScopedToken 局部重建目标', '目标回复'),
        workspaceId: ws1.id,
      },
    });
    expect(ws1New.statusCode).toBe(201);
    const ws1NewId = ws1New.json().session.id as string;

    const ws2New = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: {
        bundle: buildChineseBundle('live-ws2-new', wsDir2, '工作区 2 未消费新增', 'Ws2SurvivingToken 不应被跳过', '保留文本'),
        workspaceId: ws2.id,
      },
    });
    expect(ws2New.statusCode).toBe(201);
    const ws2NewId = ws2New.json().session.id as string;
    expect((await daemon.app.inject({ method: 'DELETE', url: `/api/v1/sessions/${ws2OldId}` })).statusCode).toBe(200);

    expect((await daemon.app.inject({
      method: 'PATCH',
      url: '/api/v1/plugins/hm.plugin.session-search-fts',
      payload: { enabled: true },
    })).statusCode).toBe(200);

    const scopedReindex = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/search/reindex',
      payload: { workspaceId: ws1.id },
    });
    expect(scopedReindex.statusCode).toBe(200);

    const ws1Res = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('Ws1ScopedToken')}`,
    });
    expect(ws1Res.statusCode).toBe(200);
    expect(ws1Res.json().hits.some((h: { sessionId: string }) => h.sessionId === ws1NewId)).toBe(true);

    const ws2NewRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('Ws2SurvivingToken')}`,
    });
    expect(ws2NewRes.statusCode).toBe(200);
    expect(ws2NewRes.json().hits.some((h: { sessionId: string }) => h.sessionId === ws2NewId)).toBe(true);

    const ws2OldRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('Ws2OldToken')}`,
    });
    expect(ws2OldRes.statusCode).toBe(200);
    expect(ws2OldRes.json().hits).toHaveLength(0);
  }, 60_000);
});
