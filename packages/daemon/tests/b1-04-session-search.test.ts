import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FixtureSessionSearchReadModel,
  SessionSearchEngineInstance,
  SessionSearchEngineManager,
  StoreSessionSearchReadModel,
  buildSafeFts5Query,
} from '../src/core/session-search-engine.js';
import type { HarnessAdapter } from '../src/harnesses/types.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';
import {
  LEGACY_DIRECT_SEARCH_INDEX_CALL_SITES,
  registerSessionSearchCompatRoutes,
  resolveSessionSearchInstance,
} from '../src/server/routes/session-search-compat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ftsBundledDir = path.join(repoRoot, 'plugins', 'bundled', 'hm.plugin.session-search-fts');
const liteExampleDir = path.join(repoRoot, 'plugins', 'examples', 'hm.plugin.session-search-lite');

const tempDirs: string[] = [];
const activeDaemons: DaemonInstance[] = [];
const activeEngines: SessionSearchEngineManager[] = [];
const activeServers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort cleanup on Windows transient file locks
  }
}

async function createTestDaemon(dataDir: string, adapters: HarnessAdapter[] = []): Promise<DaemonInstance> {
  const daemon = createDaemon({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    customAdapters: adapters,
    bundledPluginsDir: path.join(repoRoot, 'plugins', 'bundled'),
    webDistDir: null,
  });
  await daemon.pluginManager.reloadAll();
  await daemon.app.ready();
  activeDaemons.push(daemon);
  return daemon;
}

async function installTrustedDir(daemon: DaemonInstance, dirPath: string) {
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
  daemon: DaemonInstance,
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

afterEach(async () => {
  while (activeEngines.length > 0) {
    await activeEngines.pop()!.disposeAll().catch(() => {});
  }
  while (activeDaemons.length > 0) {
    await activeDaemons.pop()!.stop().catch(() => {});
  }
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    safeRmSync(tempDirs.pop()!);
  }
});

describe('B1-04 · Session Search Engine & Peer Plugins', () => {
  it('matches legacy FTS5/CJK/XSS/filter/pagination parity on the same fixture', async () => {
    const dataDir = makeTempDir('hm-b104-parity-');
    const indexDir = makeTempDir('hm-b104-parity-idx-');
    const wsDir1 = makeTempDir('hm-b104-ws1-');
    const wsDir2 = makeTempDir('hm-b104-ws2-');
    const daemon = await createTestDaemon(dataDir);

    const ws1 = await daemon.sessionManager.addWorkspace(wsDir1, 'Alpha');
    const ws2 = await daemon.sessionManager.addWorkspace(wsDir2, 'Beta');

    const s1 = await daemon.sessionManager.createSession({
      workspaceId: ws1.id,
      harnessId: 'codex',
      title: 'Fix oauth token refresh',
      permissionMode: 'manual',
    });
    const s2 = await daemon.sessionManager.createSession({
      workspaceId: ws2.id,
      harnessId: 'claude',
      title: '部署脚本排查',
      permissionMode: 'manual',
    });

    const baseTs = Date.now() - 10_000;
    daemon.store.upsertTurnItem({
      itemId: 'item_en_1',
      schemaVersion: 2,
      sessionId: s1.id,
      turnId: 'turn_1',
      seq: 1,
      instanceId: 'codex',
      driverId: 'codex',
      blockType: 'assistant_text',
      status: 'completed',
      title: 'Assistant',
      textBody: 'Investigated <script>alert(1)</script> NEAR oauth-refresh* bug with "quotes" in token handler.',
      payload: {},
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: baseTs + 1000,
      updatedAt: baseTs + 1000,
    });
    daemon.store.upsertTurnItem({
      itemId: 'item_en_2',
      schemaVersion: 2,
      sessionId: s1.id,
      turnId: 'turn_2',
      seq: 2,
      instanceId: 'codex',
      driverId: 'codex',
      blockType: 'user_message',
      status: 'completed',
      title: 'User',
      textBody: 'Please verify oauth token handler pagination behavior.',
      payload: {},
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: baseTs + 2000,
      updatedAt: baseTs + 2000,
    });
    daemon.store.upsertTurnItem({
      itemId: 'item_zh_1',
      schemaVersion: 2,
      sessionId: s2.id,
      turnId: 'turn_3',
      seq: 1,
      instanceId: 'claude',
      driverId: 'claude',
      blockType: 'assistant_text',
      status: 'completed',
      title: 'Assistant',
      textBody: '已完成数据库连接池与令牌刷新逻辑的回归验证。',
      payload: {},
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: baseTs + 3000,
      updatedAt: baseTs + 3000,
    });
    daemon.store.upsertTurnItem({
      itemId: 'item_secret_1',
      schemaVersion: 2,
      sessionId: s1.id,
      turnId: 'turn_4',
      seq: 3,
      instanceId: 'codex',
      driverId: 'codex',
      blockType: 'secret_request',
      status: 'completed',
      title: 'Secret',
      textBody: 'top-secret-token-never-indexed',
      payload: {},
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: baseTs + 4000,
      updatedAt: baseTs + 4000,
    });

    await daemon.sessionManager.rebuildSearchIndex();

    const engineManager = new SessionSearchEngineManager(indexDir, new StoreSessionSearchReadModel(daemon.store));
    activeEngines.push(engineManager);
    const engine = engineManager.getOrCreate('search.fts.default', { batchSize: 2, yieldBetweenBatches: false });
    await engine.start();
    const job = await engine.reindex({ mode: 'full' });
    expect(job.status).toBe('completed');
    expect(job.indexedCount).toBe(3);

    // 1. FTS5 special operators & escaping
    expect(buildSafeFts5Query('-NEAR "oauth-refresh*"')).toContain('"NEAR"');
    const legacySpecial = daemon.sessionManager.searchSessions({ q: 'NEAR "oauth-refresh*" -nonexistent_op' });
    const pluginSpecial = engine.query({ q: 'NEAR "oauth-refresh*" -nonexistent_op' });
    expect(pluginSpecial.hits.map((h) => h.itemId)).toEqual(legacySpecial.hits.map((h) => h.itemId));

    // 2. XSS escaping, jump IDs, and workspace/driver filters
    const legacyEn = daemon.sessionManager.searchSessions({ q: 'oauth-refresh', workspaceId: ws1.id, driverId: 'codex' });
    const pluginEn = engine.query({ q: 'oauth-refresh', workspaceId: ws1.id, driverId: 'codex' });
    expect(pluginEn.hits).toEqual(legacyEn.hits);
    expect(pluginEn.hits[0]!.sessionId).toBe(s1.id);
    expect(pluginEn.hits[0]!.turnId).toBe('turn_1');
    expect(pluginEn.hits[0]!.turnSeq).toBe(1);
    expect(pluginEn.hits[0]!.itemId).toBe('item_en_1');
    expect(pluginEn.hits[0]!.snippetHtmlSafe).not.toContain('<script>');
    expect(pluginEn.hits[0]!.snippetHtmlSafe).toContain('&lt;script&gt;');

    // 3. Chinese substring search + LIKE fallback
    const legacyZh = daemon.sessionManager.searchSessions({ q: '连接池', workspaceId: ws2.id, driverId: 'claude' });
    const pluginZh = engine.query({ q: '连接池', workspaceId: ws2.id, driverId: 'claude' });
    expect(pluginZh.fallbackUsed).toBe(true);
    expect(pluginZh.hits).toEqual(legacyZh.hits);
    expect(pluginZh.hits[0]!.snippetHtmlSafe).toContain('<mark>连接池</mark>');

    // 4. Time range filter & pagination nextOffset
    const page1 = engine.query({ q: 'token', fromTs: baseTs, toTs: baseTs + 2500, limit: 1, offset: 0 });
    expect(page1.hits.length).toBe(1);
    expect(page1.nextOffset).toBe(1);
    const page2 = engine.query({ q: 'token', fromTs: baseTs, toTs: baseTs + 2500, limit: 1, offset: page1.nextOffset! });
    expect(page2.hits.length).toBe(1);
    expect(page2.nextOffset).toBeNull();
    expect(page2.hits[0]!.itemId).not.toBe(page1.hits[0]!.itemId);

    // 5. Secret items are never indexed
    expect(engine.query({ q: 'top-secret-token-never-indexed' }).hits).toHaveLength(0);
  });

  it('handles concurrent writes during snapshot rebuild, pause/resume CRUD, crash recovery, cancel/resume, and delete replay', async () => {
    const indexDir = makeTempDir('hm-b104-recovery-idx-');
    const readModel = new FixtureSessionSearchReadModel();
    const manager = new SessionSearchEngineManager(indexDir, readModel);
    activeEngines.push(manager);

    const t0 = 1_795_651_200_000;
    readModel.commitSession({ id: 's1', title: '初始会话一', workspaceId: 'ws-a', driverId: 'codex', updatedAt: t0 });
    readModel.commitSession({ id: 's2', title: '初始会话二', workspaceId: 'ws-b', driverId: 'claude', updatedAt: t0 + 1 });
    readModel.commitItem({ sessionId: 's1', itemId: 'i1', turnId: 't1', turnSeq: 1, textBody: 'alpha keyword first', createdAt: t0 + 10 });
    readModel.commitItem({ sessionId: 's1', itemId: 'i2', turnId: 't2', turnSeq: 2, textBody: 'alpha keyword second', createdAt: t0 + 20 });
    readModel.commitItem({ sessionId: 's2', itemId: 'i3', turnId: 't1', turnSeq: 1, textBody: 'beta 删除目标', createdAt: t0 + 30 });

    const dbPath = manager.resolveDbPath('search.recovery.a');
    const engine = manager.getOrCreate('search.recovery.a', { batchSize: 1, yieldBetweenBatches: true });
    await engine.start();

    // 1. Concurrent writes committed mid-rebuild (after first snapshot page)
    let injected = false;
    const rebuildJob = await engine.reindex({
      mode: 'full',
      onBatchCommitted: async () => {
        if (!injected) {
          injected = true;
          readModel.commitItem({
            sessionId: 's1',
            itemId: 'i_concurrent',
            turnId: 't3',
            turnSeq: 3,
            textBody: 'concurrent write during rebuild 连接词',
            createdAt: t0 + 40,
          });
          readModel.commitSession({ id: 's1', title: '并发改名后的会话一', workspaceId: 'ws-a', driverId: 'codex', updatedAt: t0 + 45 });
        }
      },
    });
    expect(rebuildJob.status).toBe('completed');
    const concurrentHits = engine.query({ q: 'concurrent' });
    expect(concurrentHits.hits).toHaveLength(1);
    expect(concurrentHits.hits[0]!.sessionTitle).toBe('并发改名后的会话一');

    // 2. Pause -> create, update, delete -> Resume -> compare results
    await engine.pause();
    readModel.commitSession({ id: 's3', title: '暂停期间新建会话', workspaceId: 'ws-a', driverId: 'codex', updatedAt: t0 + 50 });
    readModel.commitItem({ sessionId: 's3', itemId: 'i4', turnId: 't1', turnSeq: 1, textBody: '暂停期新增中文内容', createdAt: t0 + 55 });
    readModel.commitItem({ sessionId: 's1', itemId: 'i2', turnId: 't2', turnSeq: 2, textBody: 'alpha updated while paused', createdAt: t0 + 20, updatedAt: t0 + 60 });
    readModel.deleteSession('s2');

    // While paused, stale data hasn't been synced yet
    expect(engine.query({ q: '暂停期新增' }).hits).toHaveLength(0);

    const resumeSync = await engine.resume();
    expect(resumeSync.appliedChanges).toBeGreaterThanOrEqual(4);
    expect(engine.query({ q: '暂停期新增' }).hits.map((h) => h.itemId)).toEqual(['i4']);
    expect(engine.query({ q: 'updated while paused' }).hits.map((h) => h.itemId)).toEqual(['i2']);
    expect(engine.query({ q: '删除目标' }).hits).toHaveLength(0);

    // 3. Cancel mid-rebuild -> resumeReindex() completes idempotently
    let cancelledOnce = false;
    let cancelCallPromise: Promise<unknown> | null = null;
    const cancelPromise = engine.reindex({
      mode: 'full',
      onBatchCommitted: () => {
        if (!cancelledOnce) {
          cancelledOnce = true;
          cancelCallPromise = engine.cancelReindex();
        }
      },
    });
    const cancelledJob = await cancelPromise;
    await cancelCallPromise;
    expect(cancelledJob.status).toBe('cancelled');
    expect(cancelledJob.resumeAvailable).toBe(true);

    const resumedJob = await engine.resumeReindex();
    expect(resumedJob.status).toBe('completed');
    expect(engine.getStatus().indexedItems).toBe(4);

    // 4. Simulated crash mid-rebuild -> reopen new engine instance on same D-drive DB -> resume
    let crashed = false;
    await engine
      .reindex({
        mode: 'full',
        onBatchCommitted: async () => {
          if (!crashed) {
            crashed = true;
            engine.simulateCrash();
          }
        },
      })
      .catch(() => {});

    const recovered = new SessionSearchEngineInstance({
      instanceId: 'search.recovery.a',
      dbPath,
      readModel,
      batchSize: 1,
      yieldBetweenBatches: false,
    });
    await recovered.start();
    const statusAfterCrash = recovered.getStatus();
    expect(statusAfterCrash.resumeAvailable).toBe(true);
    expect(statusAfterCrash.lastJob?.status).toBe('cancelled');

    const afterCrashResume = await recovered.resumeReindex();
    expect(afterCrashResume.status).toBe('completed');
    expect(recovered.getStatus().indexedItems).toBe(4);
    expect(recovered.query({ q: '暂停期新增' }).hits).toHaveLength(1);

    // 5. Delete replay idempotency (delete_session / delete_item replayed multiple times)
    readModel.deleteItem('s1', 'i2');
    readModel.deleteItem('s1', 'i2');
    readModel.deleteSession('s2');
    await recovered.syncIncremental();
    expect(recovered.query({ q: 'updated while paused' }).hits).toHaveLength(0);
    expect(recovered.getStatus().indexedItems).toBe(3);

    await recovered.dispose();
  });

  it('coexists FTS & Lite peer plugins across two workspaces, isolates disable/reindex, and adapts legacy routes', async () => {
    const dataDir = makeTempDir('hm-b104-peer-data-');
    const wsDirA = makeTempDir('hm-b104-peer-wsA-');
    const wsDirB = makeTempDir('hm-b104-peer-wsB-');
    const daemon = await createTestDaemon(dataDir);

    const readModel = new FixtureSessionSearchReadModel();
    const now = 1_795_651_200_000;
    readModel.commitSession({ id: 'sess-wsA', title: '工作区A会话', workspaceId: 'ws-A', driverId: 'codex', updatedAt: now });
    readModel.commitSession({ id: 'sess-wsB', title: '工作区B会话', workspaceId: 'ws-B', driverId: 'claude', updatedAt: now + 1 });
    readModel.commitItem({
      sessionId: 'sess-wsA',
      itemId: 'sess-wsA:t1:user',
      turnId: 't1',
      turnSeq: 1,
      textBody: '工作区A 中文检索 样本一',
      createdAt: now + 10,
    });
    readModel.commitItem({
      sessionId: 'sess-wsB',
      itemId: 'sess-wsB:t1:user',
      turnId: 't1',
      turnSeq: 1,
      textBody: '工作区B 轻量检索 样本二',
      createdAt: now + 20,
    });

    // Expose committed change read model service (matching B1-03 hm.session-data.v1) via local test bridge plugin
    const bridgeServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/readSearchSnapshot') {
        res.end(JSON.stringify(readModel.readSearchSnapshot(body)));
      } else if (req.url === '/readCommittedChanges') {
        res.end(JSON.stringify(readModel.readCommittedChanges(body)));
      } else {
        res.end(JSON.stringify({ latestSeq: readModel.getLatestCommittedSeq() }));
      }
    });
    activeServers.push(bridgeServer);
    await new Promise<void>((resolve) => bridgeServer.listen(0, '127.0.0.1', () => resolve()));
    const bridgeAddr = bridgeServer.address();
    const bridgeBaseUrl = `http://127.0.0.1:${typeof bridgeAddr === 'object' && bridgeAddr ? bridgeAddr.port : 0}`;

    const bridgePluginDir = makeTempDir('hm-b104-bridge-pkg-');
    fs.writeFileSync(
      path.join(bridgePluginDir, 'harnessmate-plugin.json'),
      JSON.stringify(
        {
          id: 'user.session-data-bridge',
          name: 'Test Session Data Bridge',
          version: '1.0.0',
          description: 'Test bridge for hm.session-data.v1',
          author: 'HarnessMate Test',
          category: 'workflow',
          apiVersion: 4,
          engines: { pluginApi: '^4.0' },
          main: 'index.mjs',
          provides: ['hm.session-data.v1'],
          permissions: ['net:127.0.0.1'],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(bridgePluginDir, 'index.mjs'),
      `export function apply(ctx) {
  const post = async (p, payload) => {
    const res = await ctx.net.fetch('${bridgeBaseUrl}' + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return JSON.parse(res.body);
  };
  ctx.provide('hm.session-data.v1', {
    readSearchSnapshot: (opts) => post('/readSearchSnapshot', opts),
    readCommittedChanges: (opts) => post('/readCommittedChanges', opts),
  }, { version: '1.0.0' });
}
`,
    );
    const bridgePreview = await installTrustedDir(daemon, bridgePluginDir);
    await grantPermission(daemon, 'user.session-data-bridge', bridgePreview.digest!, 'net:127.0.0.1');
    await daemon.pluginManager.setCompositionBinding('hm.session-data.v1', 'user.session-data-bridge');

    // Verify bundled FTS plugin was discovered in plugins/bundled
    expect(fs.existsSync(path.join(ftsBundledDir, 'harnessmate-plugin.json'))).toBe(true);

    // Install alternative Lite search plugin via local_dir
    const litePreview = await installTrustedDir(daemon, liteExampleDir);
    expect(litePreview.manifest.id).toBe('hm.plugin.session-search-lite');
    for (const cap of ['session:read', 'events:turn', 'events:message', 'storage:plugin']) {
      await grantPermission(daemon, 'hm.plugin.session-search-lite', litePreview.digest!, cap);
    }

    // Activate one FTS instance and one Lite instance concurrently
    const addFtsRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: { id: 'search.fts.a', name: 'hm.plugin.session-search-fts' },
    });
    expect(addFtsRes.statusCode).toBe(200);

    const addLiteRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: { id: 'search.lite.b', name: 'hm.plugin.session-search-lite' },
    });
    expect(addLiteRes.statusCode).toBe(200);

    const servicesRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/services?contract=session.search.v1',
    });
    expect(servicesRes.statusCode).toBe(200);
    const providerIds = (servicesRes.json().providers as Array<{ instanceId: string }>).map((p) => p.instanceId);
    expect(providerIds).toContain('search.fts.a');
    expect(providerIds).toContain('search.lite.b');

    // Bind ws-A -> search.fts.a and ws-B -> search.lite.b
    const wsA = await daemon.sessionManager.addWorkspace(wsDirA, 'Workspace A');
    const wsB = await daemon.sessionManager.addWorkspace(wsDirB, 'Workspace B');
    await daemon.pluginManager.setWorkspaceBinding(wsA.id, 'session.search.v1', 'search.fts.a');
    await daemon.pluginManager.setWorkspaceBinding(wsB.id, 'session.search.v1', 'search.lite.b');

    expect(resolveSessionSearchInstance(daemon.pluginManager, { workspaceId: wsA.id }).instanceId).toBe('search.fts.a');
    expect(resolveSessionSearchInstance(daemon.pluginManager, { workspaceId: wsB.id }).instanceId).toBe('search.lite.b');

    // Trigger reindex on both instances via instance HTTP routes
    const reindexA = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/search.fts.a/routes/reindex',
      payload: {},
    });
    expect(reindexA.statusCode).toBe(200);
    expect(reindexA.json().ok).toBe(true);
    expect(reindexA.json().value.status).toBe('completed');

    const reindexB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/search.lite.b/routes/reindex',
      payload: {},
    });
    expect(reindexB.statusCode).toBe(200);
    expect(reindexB.json().ok).toBe(true);
    expect(reindexB.json().value.status).toBe('completed');

    // Query Chinese keywords via both instance routes
    const queryA = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/search.fts.a/routes/query',
      payload: { q: '中文检索', workspaceId: 'ws-A' },
    });
    expect(queryA.statusCode).toBe(200);
    expect(queryA.json().value.hits).toHaveLength(1);
    expect(queryA.json().value.hits[0].sessionId).toBe('sess-wsA');

    const queryB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/search.lite.b/routes/query',
      payload: { q: '轻量检索', workspaceId: 'ws-B' },
    });
    expect(queryB.statusCode).toBe(200);
    expect(queryB.json().value.hits).toHaveLength(1);
    expect(queryB.json().value.hits[0].sessionId).toBe('sess-wsB');

    // Verify slot registration on workspace.pages (slot id 'session-search')
    const slotMsg = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/search.lite.b/ui-message',
      payload: { slotId: 'session-search', slot: 'workspace.pages', payload: { type: 'getStatus' } },
    });
    expect(slotMsg.statusCode).toBe(200);
    expect(slotMsg.json().result.value.engineKind).toBe('lite');

    // Mount compat routes on a Fastify app and test legacy /api/v1/search/* routing
    const compatApp = Fastify();
    registerSessionSearchCompatRoutes(compatApp, {
      pluginManager: daemon.pluginManager,
      sessionManager: daemon.sessionManager,
    });
    await compatApp.ready();

    const compatResA = await compatApp.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('中文检索')}&workspaceId=${encodeURIComponent(wsA.id)}`,
    });
    // Note: query passed workspaceId=wsA.id to resolve search.fts.a, while fixture items have workspaceId='ws-A'
    // Verify explicit instanceId + fixture workspaceId='ws-A' returns exact hit
    expect(compatResA.statusCode).toBe(200);
    const compatExplicitA = await compatApp.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('中文检索')}&workspaceId=ws-A&instanceId=search.fts.a`,
    });
    expect(compatExplicitA.statusCode).toBe(200);
    expect(compatExplicitA.json().hits).toHaveLength(1);
    expect(compatExplicitA.json().instanceId).toBe('search.fts.a');

    // Pause/create/update/delete while search.fts.a is disabled -> search.lite.b keeps working -> re-enable search.fts.a
    await daemon.pluginManager.togglePlugin('search.fts.a', false);

    readModel.commitSession({ id: 'sess-wsA-2', title: '停用期间新增会话', workspaceId: 'ws-A', driverId: 'codex', updatedAt: now + 100 });
    readModel.commitItem({
      sessionId: 'sess-wsA-2',
      itemId: 'sess-wsA-2:t1:user',
      turnId: 't1',
      turnSeq: 1,
      textBody: '停用期间新增的中文记录',
      createdAt: now + 110,
    });

    // Disabled search.fts.a returns 503 via compat, while search.lite.b remains completely unaffected!
    const disabledCompat = await compatApp.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('中文检索')}&instanceId=search.fts.a`,
    });
    expect(disabledCompat.statusCode).toBe(503);

    const liteWhileFtsDisabled = await compatApp.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('轻量检索')}&workspaceId=ws-B&instanceId=search.lite.b`,
    });
    expect(liteWhileFtsDisabled.statusCode).toBe(200);
    expect(liteWhileFtsDisabled.json().hits).toHaveLength(1);

    // Re-enable search.fts.a -> automatic catch-up / sync reflects changes created while disabled
    await daemon.pluginManager.togglePlugin('search.fts.a', true);
    const syncAfterEnable = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/search.fts.a/routes/sync',
      payload: {},
    });
    expect(syncAfterEnable.statusCode).toBe(200);

    const afterEnableHits = await compatApp.inject({
      method: 'GET',
      url: `/api/v1/search/sessions?q=${encodeURIComponent('停用期间新增')}&workspaceId=ws-A&instanceId=search.fts.a`,
    });
    expect(afterEnableHits.statusCode).toBe(200);
    expect(afterEnableHits.json().hits).toHaveLength(1);
    expect(afterEnableHits.json().hits[0].sessionId).toBe('sess-wsA-2');

    // Verify legacy call-site manifest is non-empty for B1-06 handoff
    expect(LEGACY_DIRECT_SEARCH_INDEX_CALL_SITES.length).toBeGreaterThanOrEqual(5);

    await compatApp.close();
  }, 60_000);
});

describe('B1-04 direct plugin entrypoint guarantees (FTS & Lite)', () => {
  function createPluginHarness(
    readModel: FixtureSessionSearchReadModel,
    options: {
      instanceId: string;
      pluginId: string;
      backingMap?: Map<string, unknown>;
      onStorageSet?: (key: string, value: unknown, rawMap: Map<string, unknown>) => void;
    },
  ) {
    const rawMap = options.backingMap ?? new Map<string, unknown>();
    const provided = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
    const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
    const cleanups: Array<() => void | Promise<void>> = [];

    const ctx = {
      instanceId: options.instanceId,
      pluginId: options.pluginId,
      storage: {
        plugin: {
          async get(key: string) {
            return rawMap.has(key) ? structuredClone(rawMap.get(key)) : undefined;
          },
          async set(key: string, value: unknown) {
            options.onStorageSet?.(key, value, rawMap);
            rawMap.set(key, structuredClone(value));
          },
          async delete(key: string) {
            rawMap.delete(key);
          },
          async keys() {
            return [...rawMap.keys()];
          },
        },
      },
      services: {
        async list() {
          return [{ contract: 'hm.session-data.v1', version: '1.0.0' }];
        },
        async call(contract: string, method: string, args: unknown[] = []) {
          if (contract !== 'hm.session-data.v1') {
            throw new Error(`Unknown contract: ${contract}`);
          }
          if (method === 'readSearchSnapshot') {
            return readModel.readSearchSnapshot((args[0] ?? {}) as Parameters<FixtureSessionSearchReadModel['readSearchSnapshot']>[0]);
          }
          if (method === 'readCommittedChanges') {
            return readModel.readCommittedChanges((args[0] ?? { afterSeq: 0 }) as Parameters<FixtureSessionSearchReadModel['readCommittedChanges']>[0]);
          }
          throw new Error(`Unknown method: ${method}`);
        },
      },
      events: {
        on(eventName: string, handler: (payload: unknown) => void) {
          const list = eventHandlers.get(eventName) ?? [];
          list.push(handler);
          eventHandlers.set(eventName, list);
          return () => {
            const idx = list.indexOf(handler);
            if (idx >= 0) list.splice(idx, 1);
          };
        },
      },
      routes: {
        register() {},
      },
      slots: {
        register() {},
      },
      sessions: {
        async list() {
          return [];
        },
        async listItems() {
          return { items: [] };
        },
      },
      provide(contract: string, impl: Record<string, (...args: unknown[]) => unknown>) {
        provided.set(contract, impl);
      },
      effect(factory: () => void | (() => void | Promise<void>)) {
        const dispose = factory();
        if (typeof dispose === 'function') cleanups.push(dispose);
      },
    };

    return {
      ctx,
      rawMap,
      emit(eventName: string, payload?: unknown) {
        for (const fn of eventHandlers.get(eventName) ?? []) fn(payload);
      },
      service() {
        const svc = provided.get('session.search.v1');
        if (!svc) throw new Error('session.search.v1 not provided');
        return svc as {
          query: (req: Record<string, unknown>) => Promise<{ ok: boolean; value: { hits: Array<Record<string, unknown>>; nextOffset: number | null; fallbackUsed: boolean } }>;
          reindex: (req?: Record<string, unknown>) => Promise<{ ok: boolean; value: Record<string, unknown>; error?: { code: string; message: string } }>;
          getStatus: () => Promise<{ ok: boolean; value: Record<string, unknown> }>;
          cancelReindex: () => Promise<{ ok: boolean; value: Record<string, unknown> }>;
          resumeReindex: (req?: Record<string, unknown>) => Promise<{ ok: boolean; value: Record<string, unknown> }>;
          sync: () => Promise<{ ok: boolean; value?: { appliedChanges: number; cursorSeq: number }; error?: { code: string; message: string } }>;
        };
      },
      async dispose() {
        for (const fn of cleanups.splice(0)) await fn();
      },
    };
  }

  it.each([
    { label: 'FTS bundled entrypoint', pluginId: 'hm.plugin.session-search-fts', dir: ftsBundledDir, prefix: 'fts' },
    { label: 'Lite example entrypoint', pluginId: 'hm.plugin.session-search-lite', dir: liteExampleDir, prefix: 'lite' },
  ])('$label: enabled-time native/bundle import, update & delete sync without manual reindex', async ({ pluginId, dir }) => {
    const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    const readModel = new FixtureSessionSearchReadModel();
    const h = createPluginHarness(readModel, { instanceId: `${pluginId}.live`, pluginId });
    await mod.apply(h.ctx, { batchSize: 10 });
    const svc = h.service();

    try {
      const t0 = Date.now();
      // Native session & bundled import committed while plugin is enabled (NO manual reindex!)
      readModel.commitSession({ id: 'sess-native-1', title: '初始原生会话', workspaceId: 'ws-live', driverId: 'codex', updatedAt: t0 });
      readModel.commitItem({
        sessionId: 'sess-native-1',
        itemId: 'sess-native-1:t1:msg',
        turnId: 't1',
        turnSeq: 1,
        textBody: '启用态导入 量子校验令牌 alpha',
        createdAt: t0 + 1,
      });

      const hitBeforeReindex = await svc.query({ q: '量子校验令牌', workspaceId: 'ws-live' });
      expect(hitBeforeReindex.ok).toBe(true);
      expect(hitBeforeReindex.value.hits).toHaveLength(1);
      expect(hitBeforeReindex.value.hits[0].itemId).toBe('sess-native-1:t1:msg');

      // Bundle import of second session + title update -> immediately reflected in query()
      readModel.commitSession({ id: 'sess-bundle-2', title: 'Bundle 导入归档', workspaceId: 'ws-live', driverId: 'claude', updatedAt: t0 + 2 });
      readModel.commitItem({
        sessionId: 'sess-bundle-2',
        itemId: 'sess-bundle-2:t1:msg',
        turnId: 't1',
        turnSeq: 1,
        textBody: 'bundle归档 矢量检索结果 beta',
        createdAt: t0 + 3,
      });
      readModel.commitSession({ id: 'sess-native-1', title: '改名后的原生会话', workspaceId: 'ws-live', driverId: 'codex', updatedAt: t0 + 4 });

      const bundleHit = await svc.query({ q: '矢量检索结果', workspaceId: 'ws-live' });
      expect(bundleHit.ok).toBe(true);
      expect(bundleHit.value.hits).toHaveLength(1);
      expect(bundleHit.value.hits[0].sessionId).toBe('sess-bundle-2');

      const renamedHit = await svc.query({ q: '量子校验令牌', workspaceId: 'ws-live' });
      expect(renamedHit.value.hits[0].sessionTitle).toBe('改名后的原生会话');

      // Delete session while enabled -> immediately disappears on next query()
      readModel.deleteSession('sess-native-1');
      const afterDelete = await svc.query({ q: '量子校验令牌', workspaceId: 'ws-live' });
      expect(afterDelete.ok).toBe(true);
      expect(afterDelete.value.hits).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });

  it.each([
    { label: 'FTS', pluginId: 'hm.plugin.session-search-fts', dir: ftsBundledDir, prefix: 'fts' },
    { label: 'Lite', pluginId: 'hm.plugin.session-search-lite', dir: liteExampleDir, prefix: 'lite' },
  ])('$label: two-phase generation commit keeps meta/cursor intact on chunk write failure & verifies integrity on restart', async ({ pluginId, dir, prefix }) => {
    const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    const readModel = new FixtureSessionSearchReadModel();
    const sharedStorage = new Map<string, unknown>();

    // Generation 1: commit baseline session cleanly
    const t0 = Date.now();
    readModel.commitSession({ id: 'sess-p2-1', title: '第一代基线会话', workspaceId: 'ws-p2', driverId: 'codex', updatedAt: t0 });
    readModel.commitItem({
      sessionId: 'sess-p2-1',
      itemId: 'sess-p2-1:t1:1',
      turnId: 't1',
      turnSeq: 1,
      textBody: '基线保留内容 keep-gen-one',
      createdAt: t0 + 1,
    });

    const h1 = createPluginHarness(readModel, { instanceId: `${pluginId}.p2`, pluginId, backingMap: sharedStorage });
    await mod.apply(h1.ctx, { batchSize: 10 });
    const s1 = await h1.service().sync();
    expect(s1.ok).toBe(true);
    const gen1Cursor = s1.value!.cursorSeq;
    const metaGen1 = sharedStorage.get(`${prefix}:meta`) as Record<string, unknown>;
    expect(metaGen1.schemaVersion).toBe(2);
    expect(metaGen1.generation).toBeGreaterThanOrEqual(1);
    expect(metaGen1.cursorSeq).toBe(gen1Cursor);
    const prevGen = Number(metaGen1.generation);
    await h1.dispose();

    // Add large multi-chunk payload (> 180 KiB so next generation produces >= 2 chunks) and inject failure on chunk:1
    const bigPayload = 'Z'.repeat(120 * 1024);
    readModel.commitSession({ id: 'sess-p2-2', title: '第二代大文本会话', workspaceId: 'ws-p2', driverId: 'codex', updatedAt: t0 + 10 });
    readModel.commitItem({
      sessionId: 'sess-p2-2',
      itemId: 'sess-p2-2:t1:1',
      turnId: 't1',
      turnSeq: 1,
      textBody: `gen2-part1 ${bigPayload}`,
      createdAt: t0 + 11,
    });
    readModel.commitItem({
      sessionId: 'sess-p2-2',
      itemId: 'sess-p2-2:t1:2',
      turnId: 't1',
      turnSeq: 2,
      textBody: `gen2-part2-after-fail ${bigPayload}`,
      createdAt: t0 + 12,
    });

    const nextGenKey = `${prefix}:gen:${prevGen + 1}:chunk:1`;
    const hFail = createPluginHarness(readModel, {
      instanceId: `${pluginId}.p2`,
      pluginId,
      backingMap: sharedStorage,
      onStorageSet(key) {
        if (key === nextGenKey) {
          throw new Error('E_INJECTED_DISK_FULL');
        }
      },
    });
    await mod.apply(hFail.ctx, { batchSize: 10, autoSyncOnStart: false });
    const failSync = await hFail.service().sync();
    expect(failSync.ok).toBe(false);
    expect(failSync.error?.message).toContain('E_INJECTED_DISK_FULL');

    // Meta MUST remain on old generation & old cursorSeq, and failed chunk:0 must be rolled back
    const metaAfterFail = sharedStorage.get(`${prefix}:meta`) as Record<string, unknown>;
    expect(metaAfterFail.generation).toBe(prevGen);
    expect(metaAfterFail.cursorSeq).toBe(gen1Cursor);
    expect(sharedStorage.has(`${prefix}:gen:${prevGen + 1}:chunk:0`)).toBe(false);
    await hFail.dispose();

    // Restart cleanly -> restores intact gen1 and catches up gen2 without data loss
    const hRecover = createPluginHarness(readModel, { instanceId: `${pluginId}.p2`, pluginId, backingMap: sharedStorage });
    await mod.apply(hRecover.ctx, { batchSize: 10 });
    const recoveredQuery = await hRecover.service().query({ q: 'gen2-part2-after-fail' });
    expect(recoveredQuery.ok).toBe(true);
    expect(recoveredQuery.value.hits).toHaveLength(1);
    const baseQuery = await hRecover.service().query({ q: 'keep-gen-one' });
    expect(baseQuery.value.hits).toHaveLength(1);
    await hRecover.dispose();

    // Tamper / corrupt a persisted chunk -> restart safely resets cursorSeq to 0 and re-syncs cleanly
    const metaIntact = sharedStorage.get(`${prefix}:meta`) as Record<string, unknown>;
    sharedStorage.delete(`${prefix}:gen:${metaIntact.generation}:chunk:0`);
    const hCorrupt = createPluginHarness(readModel, { instanceId: `${pluginId}.p2`, pluginId, backingMap: sharedStorage });
    await mod.apply(hCorrupt.ctx, { batchSize: 10, autoSyncOnStart: false });
    const corruptStatus = await hCorrupt.service().getStatus();
    expect(corruptStatus.value.cursorSeq).toBe(0);
    expect(String(corruptStatus.value.lastError || '')).toContain('缺失分块');
    const healed = await hCorrupt.service().query({ q: 'keep-gen-one' });
    expect(healed.value.hits).toHaveLength(1);
    await hCorrupt.dispose();
  });

  it.each([
    { label: 'FTS', pluginId: 'hm.plugin.session-search-fts', dir: ftsBundledDir },
    { label: 'Lite', pluginId: 'hm.plugin.session-search-lite', dir: liteExampleDir },
  ])('$label: scoped workspace rebuild updates only target workspace without skipping other workspace changes', async ({ pluginId, dir }) => {
    const mod = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    const readModel = new FixtureSessionSearchReadModel();
    const h = createPluginHarness(readModel, { instanceId: `${pluginId}.scoped`, pluginId });

    const t0 = Date.now();
    // Baseline in ws-A and ws-B -> sync once
    readModel.commitSession({ id: 'sess-A-old', title: 'A 旧会话', workspaceId: 'ws-A', driverId: 'codex', updatedAt: t0 });
    readModel.commitItem({ sessionId: 'sess-A-old', itemId: 'sess-A-old:1', turnId: 't1', turnSeq: 1, textBody: 'alpha-baseline-A', createdAt: t0 + 1 });
    readModel.commitSession({ id: 'sess-B-old', title: 'B 将被删除的会话', workspaceId: 'ws-B', driverId: 'codex', updatedAt: t0 + 2 });
    readModel.commitItem({ sessionId: 'sess-B-old', itemId: 'sess-B-old:1', turnId: 't1', turnSeq: 1, textBody: 'beta-obsolete-B', createdAt: t0 + 3 });

    await mod.apply(h.ctx, { batchSize: 10, autoSyncOnStart: false });
    const svc = h.service();
    try {
      const baseSync = await svc.sync();
      const baseSeq = baseSync.value!.cursorSeq;

      // Commit interleaved unconsumed changes across ws-B and ws-A:
      // #1 ws-B new session, #2 ws-A new session, #3 ws-B delete old session
      readModel.commitSession({ id: 'sess-B-new', title: 'B 未消费新会话', workspaceId: 'ws-B', driverId: 'claude', updatedAt: t0 + 10 });
      readModel.commitItem({ sessionId: 'sess-B-new', itemId: 'sess-B-new:1', turnId: 't1', turnSeq: 1, textBody: 'beta-unconsumed-B', createdAt: t0 + 11 });
      readModel.commitSession({ id: 'sess-A-new', title: 'A 重建新会话', workspaceId: 'ws-A', driverId: 'codex', updatedAt: t0 + 12 });
      readModel.commitItem({ sessionId: 'sess-A-new', itemId: 'sess-A-new:1', turnId: 't1', turnSeq: 1, textBody: 'alpha-rebuilt-A', createdAt: t0 + 13 });
      readModel.deleteSession('sess-B-old');

      // Reindex ONLY ws-A while ws-B has unconsumed changes!
      const scopedReindex = await svc.reindex({ mode: 'full', workspaceId: 'ws-A' });
      expect(scopedReindex.ok).toBe(true);
      expect(scopedReindex.value.status).toBe('completed');

      // Verify ws-A rebuilt, ws-B unconsumed upsert WAS applied, ws-B delete WAS applied, and global cursorSeq converged!
      const hitA = await svc.query({ q: 'alpha-rebuilt-A', workspaceId: 'ws-A' });
      expect(hitA.value.hits).toHaveLength(1);

      const hitBNew = await svc.query({ q: 'beta-unconsumed-B', workspaceId: 'ws-B' });
      expect(hitBNew.value.hits).toHaveLength(1);
      expect(hitBNew.value.hits[0].sessionId).toBe('sess-B-new');

      const hitBOld = await svc.query({ q: 'beta-obsolete-B', workspaceId: 'ws-B' });
      expect(hitBOld.value.hits).toHaveLength(0);

      const status = await svc.getStatus();
      expect(Number(status.value.cursorSeq)).toBeGreaterThan(baseSeq);
      expect(status.value.cursorSeq).toBe(status.value.latestSourceSeq);
    } finally {
      await h.dispose();
    }
  });

  it('FTS & Lite UI assets satisfy SandboxedPluginFrame bridge and CSP constraints', () => {
    for (const dir of [ftsBundledDir, liteExampleDir]) {
      const html = fs.readFileSync(path.join(dir, 'ui', 'panel.html'), 'utf8');
      const js = fs.readFileSync(path.join(dir, 'ui', 'panel.js'), 'utf8');
      const css = fs.readFileSync(path.join(dir, 'ui', 'panel.css'), 'utf8');

      expect(html).not.toMatch(/<script\b[^>]*>[\s\S]+<\/script>/i);
      expect(html).toContain('workspace-filter');
      expect(html).toContain('driver-filter');
      expect(html).toContain('prev-page');
      expect(html).toContain('next-page');

      expect(js).not.toContain('innerHTML');
      expect(js).not.toContain('fetch(');
      expect(js).toContain('requestPluginRoute');
      expect(js).toContain('onContext');
      expect(js).toContain('navigateToSession');
      expect(js).toContain("document.createElement('mark')");
      expect(css).toContain('mark');
    }
  });
});
