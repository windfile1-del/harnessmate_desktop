import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PortableSessionBundleV2 } from '@harnessmate/protocol';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type { HarnessAdapter } from '../src/harnesses/types.js';
import { BUILTIN_PLUGINS } from '../src/plugin-host/builtin/manifests.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { SessionExplorerService } from '../src/core/session-explorer-service.js';
import { SessionChangeFeedService } from '../src/core/session-change-feed.js';
import { HistoryImportAdapter } from '../src/core/history-import-adapter.js';
import {
  createHistorySessionDataHostPlugin,
  HISTORY_SESSION_DATA_MANIFEST,
  HISTORY_SESSION_DATA_PLUGIN_ID,
  registerHistoryImportCompatRoutes,
} from '../src/server/routes/history-import-compat.js';

const TEMP_ROOT = 'D:\\HarnessMate\\b1-tmp\\b1-03';
const cleanupDirs: string[] = [];
const managers: PluginManager[] = [];
const stores: HarnessMateStore[] = [];
const fastifyApps: Array<ReturnType<typeof Fastify>> = [];

function ensureTempDir(prefix: string): string {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
  cleanupDirs.push(dir);
  return dir;
}

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort cleanup on Windows transient handles
  }
}

function createMockCodexAdapter(): HarnessAdapter {
  return {
    id: 'codex',
    kind: 'codex',
    displayName: 'Mock Codex',
    description: 'Mock Codex adapter',
    protocolLabel: 'Mock',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium'],
      permissionModes: ['manual'],
      sessionResume: true,
      sessionFork: false,
      imageInput: false,
      subagents: false,
    },
    probe: async () => ({
      id: 'codex',
      kind: 'codex',
      displayName: 'Mock Codex',
      description: 'Mock Codex adapter',
      protocolLabel: 'Mock',
      binaryPath: null,
      version: '1.0.0',
      health: 'ready',
      capabilities: {
        streaming: true,
        interactiveApproval: true,
        reasoningEfforts: ['medium'],
        permissionModes: ['manual'],
        sessionResume: true,
        sessionFork: false,
        imageInput: false,
        subagents: false,
      },
      models: [],
    }),
    createSession: async () => {
      throw new Error('Not used in import test');
    },
  };
}

function writePluginPackage(
  parent: string,
  folderName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): string {
  const dir = path.join(parent, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'harnessmate-plugin.json'),
    JSON.stringify(
      {
        description: 'B1-03 test fixture plugin',
        author: 'HarnessMate Test',
        ...manifest,
      },
      null,
      2,
    ),
  );
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

async function setupImportHarness(opts?: {
  sourcePluginFiles?: Record<string, Record<string, string>>;
}) {
  const dataDir = ensureTempDir('hm-b1-03-data-');
  const pluginsDir = path.join(dataDir, 'plugins');
  const pkgRoot = ensureTempDir('hm-b1-03-pkgs-');
  const bundledDir = path.resolve(process.cwd(), 'plugins', 'bundled');
  const bundledFallback = fs.existsSync(bundledDir)
    ? bundledDir
    : path.resolve(process.cwd(), '..', '..', 'plugins', 'bundled');

  const store = new HarnessMateStore(path.join(dataDir, 'harnessmate.db'));
  stores.push(store);
  const registry = new HarnessRegistry();
  registry.register(createMockCodexAdapter());

  const changeFeed = new SessionChangeFeedService(store);
  const importAdapter = new HistoryImportAdapter(store, registry, changeFeed);

  const firstParty = new Map();
  firstParty.set(HISTORY_SESSION_DATA_PLUGIN_ID, createHistorySessionDataHostPlugin(importAdapter));

  const pluginManager = new PluginManager(
    pluginsDir,
    registry,
    () => [
      'hm.plugin.history-source-codex',
      'hm.plugin.history-source-claude',
      'hm.plugin.history-source-agy-cli',
      'hm.plugin.history-source-agy-desktop',
      'hm.plugin.session-search-fts',
    ],
    firstParty,
    {
      store,
      bundledPluginsDir: bundledFallback,
    },
  );
  managers.push(pluginManager);
  await pluginManager.reloadAll();

  // Enable bundled hm.plugin.history-import via composition (core.history-session-data is auto-enabled as builtin)
  await pluginManager.upsertCompositionInstance({
    id: 'hm.plugin.history-import',
    name: 'hm.plugin.history-import',
  });

  // Install test source fixture plugin(s)
  const installSource = async (
    pluginId: string,
    instanceId: string,
    code: string,
  ) => {
    const dir = writePluginPackage(
      pkgRoot,
      instanceId,
      {
        id: pluginId,
        name: `Test Source ${instanceId}`,
        version: '1.0.0',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        category: 'workflow',
        main: 'index.mjs',
        provides: ['history.source.v1'],
        permissions: [],
      },
      { 'index.mjs': code },
    );
    const preview = pluginManager.previewInstall({ mode: 'local_dir', dirPath: dir });
    await pluginManager.installPlugin({
      mode: 'local_dir',
      dirPath: dir,
      trustCode: true,
      expectedDigest: preview.digest,
      expectedInstalledDigest: preview.installedDigest,
    });
    await pluginManager.upsertCompositionInstance({ id: instanceId, name: pluginId });
  };

  if (opts?.sourcePluginFiles) {
    for (const [id, spec] of Object.entries(opts.sourcePluginFiles)) {
      await installSource(spec.pluginId ?? id, id, spec.code ?? '');
    }
  }

  return { dataDir, store, registry, changeFeed, importAdapter, pluginManager, installSource };
}

let pushedHistoryManifest = false;

beforeAll(() => {
  if (!BUILTIN_PLUGINS.some((p) => p.id === HISTORY_SESSION_DATA_PLUGIN_ID)) {
    BUILTIN_PLUGINS.push(HISTORY_SESSION_DATA_MANIFEST);
    pushedHistoryManifest = true;
  }
});

afterAll(() => {
  if (pushedHistoryManifest) {
    const idx = BUILTIN_PLUGINS.findIndex((p) => p.id === HISTORY_SESSION_DATA_PLUGIN_ID);
    if (idx >= 0) BUILTIN_PLUGINS.splice(idx, 1);
    pushedHistoryManifest = false;
  }
});

afterEach(async () => {
  while (fastifyApps.length > 0) {
    await fastifyApps.pop()!.close().catch(() => {});
  }
  while (managers.length > 0) {
    await managers.pop()!.close().catch(() => {});
  }
  while (stores.length > 0) {
    stores.pop()!.close();
  }
  while (cleanupDirs.length > 0) {
    safeRmSync(cleanupDirs.pop()!);
  }
});

describe('B1-03 · History Import Plugin, Session Transaction & Change Feed', () => {
  it('supports fixed-source preview/import, multi-source isolation, attach dedup, mirror mode, and requestId idempotency/conflict', async () => {
    const wsDirA = ensureTempDir('hm-b1-03-ws-a-');
    const wsDirB = ensureTempDir('hm-b1-03-ws-b-');

    const { store, pluginManager, installSource } = await setupImportHarness();

    await installSource(
      'user.history.source.a',
      'history.sample.a',
      `
let readCalls = 0;
export function apply(ctx) {
  ctx.provide('history.source.v1', {
    discover(req) {
      return {
        ok: true,
        value: {
          sessions: [{
            ref: { sourceInstanceId: 'history.sample.a', sourceId: 'codex:acct:acct_aaa111', nativeSessionId: 'shared-native-1' },
            title: 'Source A 会话',
            harnessKind: 'codex',
            updatedAt: 1795651200000,
            workspaceHint: { cwd: ${JSON.stringify(wsDirA)}, label: 'WS-A' },
          }],
          nextCursor: null,
        },
      };
    },
    read(req) {
      readCalls += 1;
      return {
        ok: true,
        value: {
          ref: req.ref,
          items: [
            { itemId: 'm1', role: 'user', text: '来自来源A的问题', timestamp: 1795651200000 },
            { itemId: 'm2', role: 'assistant', text: '来自来源A的回答', timestamp: 1795651201000 },
          ],
          nextCursor: null,
          readStatus: 'complete',
          warnings: [],
        },
      };
    },
    cancel() { return { ok: true, value: { cancelled: false } }; },
  }, { version: '1.0.0', metadata: { sourceNamespace: 'codex', harnessKind: 'codex', readCalls: () => readCalls } });
}
`,
    );

    await installSource(
      'user.history.source.b',
      'history.sample.b',
      `
export function apply(ctx) {
  ctx.provide('history.source.v1', {
    discover() {
      return {
        ok: true,
        value: {
          sessions: [{
            ref: { sourceInstanceId: 'history.sample.b', sourceId: 'codex:acct:acct_bbb222', nativeSessionId: 'shared-native-1' },
            title: 'Source B 同名会话',
            harnessKind: 'codex',
            updatedAt: 1795651300000,
            workspaceHint: { cwd: ${JSON.stringify(wsDirB)}, label: 'WS-B' },
          }],
          nextCursor: null,
        },
      };
    },
    read(req) {
      return {
        ok: true,
        value: {
          ref: req.ref,
          items: [
            { itemId: 'm1', role: 'user', text: '来自来源B的问题', timestamp: 1795651300000 },
            { itemId: 'm2', role: 'assistant', text: '来自来源B的回答', timestamp: 1795651301000 },
          ],
          nextCursor: null,
          readStatus: 'complete',
          warnings: ['近5秒外部写入锁提示'],
          lockWarning: '近5秒外部写入锁提示',
        },
      };
    },
    cancel() { return { ok: true, value: { cancelled: false } }; },
  }, { version: '1.0.0', metadata: { sourceNamespace: 'codex', harnessKind: 'codex' } });
}
`,
    );

    const importSvc = pluginManager.host.getServiceByInstance<Record<string, (...args: unknown[]) => Promise<any>>>(
      'hm.plugin.history-import',
      'history.import.v1',
    )!;
    expect(importSvc).toBeTruthy();

    const refA = { sourceInstanceId: 'history.sample.a', sourceId: 'codex:acct:acct_aaa111', nativeSessionId: 'shared-native-1' };
    const refB = { sourceInstanceId: 'history.sample.b', sourceId: 'codex:acct:acct_bbb222', nativeSessionId: 'shared-native-1' };

    // 1. Preview A before import
    const previewA = await importSvc.preview({ input: { kind: 'native', ref: refA, mode: 'attach' } });
    expect(previewA.ok).toBe(true);
    expect(previewA.value.existingSessionId).toBeNull();
    expect(previewA.value.importable).toBe(true);
    expect(previewA.value.items.map((i: any) => i.text)).toEqual(['来自来源A的问题', '来自来源A的回答']);

    // 2. Import A
    const impA = await importSvc.import({
      input: { kind: 'native', ref: refA, mode: 'attach' },
      requestId: 'req-a-1',
    });
    expect(impA.ok).toBe(true);
    expect(impA.value.disposition).toBe('created');
    const sessIdA = impA.value.sessionId as string;

    // 3. Retry with same requestId (simulating response lost after commit) -> reused
    const retryA = await importSvc.import({
      input: { kind: 'native', ref: refA, mode: 'attach' },
      requestId: 'req-a-1',
    });
    expect(retryA).toEqual({
      ok: true,
      value: {
        sessionId: sessIdA,
        disposition: 'reused',
        partial: false,
        warnings: [],
        mode: 'attach',
      },
    });

    // 4. Same requestId with different request body -> conflict
    const conflictA = await importSvc.import({
      input: { kind: 'native', ref: refB, mode: 'attach' },
      requestId: 'req-a-1',
    });
    expect(conflictA.ok).toBe(false);
    expect(conflictA.error.code).toBe('conflict');

    // 5. Import B with SAME nativeSessionId from independent sourceId -> separate session!
    const impB = await importSvc.import({
      input: { kind: 'native', ref: refB, mode: 'attach' },
      requestId: 'req-b-1',
    });
    expect(impB.ok).toBe(true);
    expect(impB.value.disposition).toBe('created');
    expect(impB.value.sessionId).not.toBe(sessIdA);
    expect(impB.value.warnings).toContain('近5秒外部写入锁提示');

    // Verify both sessions have complete replay events and turn items
    expect(store.getEventsAfter(sessIdA, 0, 100)).toHaveLength(3);
    expect(store.getEventsAfter(impB.value.sessionId, 0, 100)).toHaveLength(3);
    expect(store.listTurnItems(sessIdA, { limit: 100 })).toHaveLength(2);
    expect(store.listTurnItems(impB.value.sessionId, { limit: 100 })).toHaveLength(3); // 2 msgs + 1 lockWarning notice

    // 6. Preview A now shows existingSessionId in attach, null in mirror
    const previewA2 = await importSvc.preview({ input: { kind: 'native', ref: refA, mode: 'attach' } });
    expect(previewA2.value.existingSessionId).toBe(sessIdA);
    const previewAMirror = await importSvc.preview({ input: { kind: 'native', ref: refA, mode: 'mirror' } });
    expect(previewAMirror.value.existingSessionId).toBeNull();

    // 7. Mirror import creates a distinct mirror session
    const mirrorImp = await importSvc.import({
      input: { kind: 'native', ref: refA, mode: 'mirror' },
      requestId: 'req-a-mirror',
    });
    expect(mirrorImp.ok).toBe(true);
    expect(mirrorImp.value.disposition).toBe('created');
    expect(mirrorImp.value.sessionId).not.toBe(sessIdA);
    const mirrorSession = store.getSession(mirrorImp.value.sessionId)!;
    expect(mirrorSession.nativeSessionId).toBeNull();
    expect(mirrorSession.title).toContain('[镜像]');
  }, 25_000);

  it('deduplicates concurrent async imports, supports pre-commit cancellation, and isolates unreadable sources', async () => {
    const wsDir = ensureTempDir('hm-b1-03-ws-conc-');
    const { store, pluginManager, installSource } = await setupImportHarness();

    await installSource(
      'user.history.paged',
      'history.paged',
      `
const cancelledOps = new Set();
export function apply(ctx) {
  ctx.provide('history.source.v1', {
    discover() {
      return {
        ok: true,
        value: {
          sessions: [
            {
              ref: { sourceInstanceId: 'history.paged', sourceId: 'codex:default', nativeSessionId: 'conc-1' },
              title: '并发测试会话',
              harnessKind: 'codex',
              updatedAt: 1795651200000,
              workspaceHint: { cwd: ${JSON.stringify(wsDir)} },
            },
            {
              ref: { sourceInstanceId: 'history.paged', sourceId: 'codex:default', nativeSessionId: 'paged-cancel-1' },
              title: '分页取消会话',
              harnessKind: 'codex',
              updatedAt: 1795651200000,
              workspaceHint: { cwd: ${JSON.stringify(wsDir)} },
            },
          ],
          nextCursor: null,
        },
      };
    },
    async read(req) {
      if (req.ref.nativeSessionId === 'unreadable-1') {
        return { ok: false, error: { code: 'source_unreadable', message: '源文件损坏或已移动' } };
      }
      if (req.ref.nativeSessionId === 'paged-cancel-1') {
        if (!req.cursor) {
          await new Promise((r) => setTimeout(r, 80));
          if (req.operationId && cancelledOps.has(req.operationId)) {
            return { ok: false, error: { code: 'cancelled', message: '来源读取已取消' } };
          }
          return {
            ok: true,
            value: {
              ref: req.ref,
              items: [{ itemId: 'p1', role: 'user', text: '第一页消息', timestamp: 1795651200000 }],
              nextCursor: 'page-2',
              readStatus: 'complete',
              warnings: [],
            },
          };
        }
        return {
          ok: true,
          value: {
            ref: req.ref,
            items: [{ itemId: 'p2', role: 'assistant', text: '第二页消息', timestamp: 1795651201000 }],
            nextCursor: null,
            readStatus: 'complete',
            warnings: [],
          },
        };
      }
      await new Promise((r) => setTimeout(r, 30));
      return {
        ok: true,
        value: {
          ref: req.ref,
          items: [
            { itemId: 'c1', role: 'user', text: '并发问题', timestamp: 1795651200000 },
            { itemId: 'c2', role: 'assistant', text: '并发回复', timestamp: 1795651201000 },
          ],
          nextCursor: null,
          readStatus: 'complete',
          warnings: [],
        },
      };
    },
    cancel(req) {
      if (req?.operationId) cancelledOps.add(req.operationId);
      return { ok: true, value: { cancelled: true } };
    },
  }, { version: '1.0.0' });
}
`,
    );

    const importSvc = pluginManager.host.getServiceByInstance<Record<string, (...args: unknown[]) => Promise<any>>>(
      'hm.plugin.history-import',
      'history.import.v1',
    )!;

    // 1. 5 concurrent imports with DIFFERENT requestIds for the SAME (sourceId, nativeSessionId)
    const refConc = { sourceInstanceId: 'history.paged', sourceId: 'codex:default', nativeSessionId: 'conc-1' };
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        importSvc.import({
          input: { kind: 'native', ref: refConc, mode: 'attach' },
          requestId: `conc-req-${i}`,
        }),
      ),
    );
    expect(results.every((r) => r.ok === true)).toBe(true);
    const sessionIds = new Set(results.map((r) => r.value.sessionId));
    expect(sessionIds.size).toBe(1);
    expect(results.filter((r) => r.value.disposition === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.value.disposition === 'reused')).toHaveLength(4);
    expect(store.listSessions()).toHaveLength(1);

    // 2. Cancellation during read stage leaves zero residual sessions
    const refCancel = { sourceInstanceId: 'history.paged', sourceId: 'codex:default', nativeSessionId: 'paged-cancel-1' };
    const importPromise = importSvc.import({
      input: { kind: 'native', ref: refCancel, mode: 'attach' },
      requestId: 'cancel-req-1',
      operationId: 'op-cancel-1',
    });
    await new Promise((r) => setTimeout(r, 20));
    const cancelRes = await importSvc.cancel({ operationId: 'op-cancel-1' });
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.value.cancelled).toBe(true);
    const cancelledImport = await importPromise;
    expect(cancelledImport.ok).toBe(false);
    expect(cancelledImport.error.code).toBe('cancelled');
    expect(store.listSessions()).toHaveLength(1); // still only conc-1

    // 3. Unreadable source returns source_unreadable with zero DB writes
    const unreadable = await importSvc.import({
      input: {
        kind: 'native',
        ref: { sourceInstanceId: 'history.paged', sourceId: 'codex:default', nativeSessionId: 'unreadable-1' },
        mode: 'attach',
      },
      requestId: 'unreadable-req-1',
    });
    expect(unreadable).toEqual({
      ok: false,
      error: { code: 'source_unreadable', message: '源文件损坏或已移动' },
    });
    expect(store.listSessions()).toHaveLength(1);
  }, 25_000);

  it('migrates legacy SQLite DBs preserving native_history_imports dedup and backward rollback readability', async () => {
    const dataDir = ensureTempDir('hm-b1-03-legacy-');
    const wsDir = ensureTempDir('hm-b1-03-legacy-ws-');
    const dbPath = path.join(dataDir, 'legacy.db');

    // Create a minimal legacy pre-B1-03 SQLite database without the 3 new additive tables
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        is_git_repo INTEGER NOT NULL DEFAULT 0,
        git_branch TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        harness_id TEXT NOT NULL,
        harness_kind TEXT NOT NULL,
        native_session_id TEXT,
        cwd TEXT NOT NULL,
        worktree_branch TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        permission_mode TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE native_history_imports (
        source TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_path TEXT,
        PRIMARY KEY (source, native_session_id)
      );
      CREATE TABLE session_events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        turn_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE session_turn_items (
        item_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        seq INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        block_type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        text_body TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        output_omitted INTEGER NOT NULL DEFAULT 0,
        omitted_bytes INTEGER NOT NULL DEFAULT 0,
        raw_ref_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare('INSERT INTO workspaces VALUES (?, ?, ?, 0, NULL, ?)').run('ws-leg', 'Legacy WS', wsDir, 1000);
    raw.prepare(
      'INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 2, NULL, ?, ?)',
    ).run('sess-leg', 'ws-leg', 'codex', 'codex', 'leg-native-1', wsDir, 'Legacy Imported', 'idle', 'manual', 1000, 2000);
    raw.prepare('INSERT INTO native_history_imports VALUES (?, ?, ?, ?)').run(
      'codex_cli',
      'leg-native-1',
      'sess-leg',
      '/tmp/leg.jsonl',
    );
    raw.prepare('INSERT INTO session_events VALUES (?, 1, ?, ?, ?, ?)').run(
      'sess-leg',
      'message.user',
      'import_1',
      JSON.stringify({ text: 'Legacy question' }),
      1000,
    );
    raw.prepare('INSERT INTO session_turn_items VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)').run(
      'sess-leg:import_1:user',
      'sess-leg',
      'import_1',
      'codex',
      'codex',
      'user_message',
      'completed',
      'User',
      'Legacy question',
      '{}',
      1000,
      1000,
    );
    raw.close();

    // Open with HarnessMateStore -> additive migration runs
    const store = new HarnessMateStore(dbPath);
    stores.push(store);
    const registry = new HarnessRegistry();
    registry.register(createMockCodexAdapter());
    const changeFeed = new SessionChangeFeedService(store);
    const adapter = new HistoryImportAdapter(store, registry, changeFeed);

    // 1. Legacy workspace & session identity preserved
    expect(store.getWorkspace('ws-leg')?.rootPath).toBe(wsDir);
    expect(store.getSession('sess-leg')?.title).toBe('Legacy Imported');

    // 2. Default codex:default sourceId matches legacy native_history_imports ('codex_cli')
    const lookupDefault = adapter.lookupNativeMapping({
      sourceId: 'codex:default',
      nativeSessionId: 'leg-native-1',
    });
    expect(lookupDefault.existingSessionId).toBe('sess-leg');
    expect(lookupDefault.matchedVia).toBe('legacy');

    const reused = await adapter.commitNativeImport({
      requestId: 'leg-reuse-1',
      requestHash: 'h1',
      ref: { sourceInstanceId: 'hm.plugin.history-source-codex', sourceId: 'codex:default', nativeSessionId: 'leg-native-1' },
      mode: 'attach',
      cwd: wsDir,
      items: [{ role: 'user', text: 'Legacy question' }],
    });
    expect(reused).toEqual({
      ok: true,
      value: {
        sessionId: 'sess-leg',
        disposition: 'reused',
        partial: false,
        warnings: [],
        mode: 'attach',
      },
    });

    // 3. Independent account sourceId with same nativeSessionId does NOT collide with legacy single-account record
    const independent = await adapter.commitNativeImport({
      requestId: 'leg-indep-1',
      requestHash: 'h2',
      ref: { sourceInstanceId: 'codex.acct2', sourceId: 'codex:acct:deadbeef1234', nativeSessionId: 'leg-native-1' },
      mode: 'attach',
      cwd: wsDir,
      title: 'Second Account Session',
      items: [{ role: 'user', text: 'Second account msg' }],
    });
    expect(independent.ok).toBe(true);
    if (!independent.ok) throw new Error('expected ok');
    expect(independent.value.disposition).toBe('created');
    expect(independent.value.sessionId).not.toBe('sess-leg');

    // 4. Snapshot reads both legacy item and newly imported item cleanly
    const snap = changeFeed.readSearchSnapshot({ workspaceId: 'ws-leg' });
    expect(snap.items.map((i) => i.textBody)).toContain('Legacy question');
    expect(snap.items.map((i) => i.textBody)).toContain('Second account msg');

    // 5. Rollback readability: legacy tables remain intact for an older binary reading only legacy tables
    store.close();
    const rollbackView = new DatabaseSync(dbPath, { readOnly: true });
    const legacySessions = rollbackView.prepare('SELECT id, title FROM sessions ORDER BY created_at ASC').all() as Array<{ id: string; title: string }>;
    expect(legacySessions.some((s) => s.id === 'sess-leg' && s.title === 'Legacy Imported')).toBe(true);
    const legacyEvents = rollbackView.prepare('SELECT seq, type FROM session_events WHERE session_id = ?').all('sess-leg');
    expect(legacyEvents).toHaveLength(1);
    rollbackView.close();
  });

  it('delivers atomic rollback on DB failure and consistent snapshot + committed change feed across upsert/update/delete', async () => {
    const dataDir = ensureTempDir('hm-b1-03-feed-');
    const wsDir = ensureTempDir('hm-b1-03-feed-ws-');
    const store = new HarnessMateStore(path.join(dataDir, 'feed.db'));
    stores.push(store);
    const registry = new HarnessRegistry();
    registry.register(createMockCodexAdapter());
    const changeFeed = new SessionChangeFeedService(store);
    const adapter = new HistoryImportAdapter(store, registry, changeFeed);

    const ws = store.createWorkspace({
      id: 'ws-1',
      name: 'Feed WS',
      rootPath: wsDir,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });

    // 1. Atomic rollback test: simulate failure inside transaction via foreign key / trigger
    store.getDatabaseSync().exec(`
      CREATE TRIGGER fail_event_insert BEFORE INSERT ON session_events
      WHEN NEW.type = 'message.assistant.completed'
      BEGIN
        SELECT RAISE(ABORT, 'simulated_disk_error');
      END;
    `);
    await expect(
      adapter.commitNativeImport({
        requestId: 'rollback-req-2',
        requestHash: 'rh2',
        ref: { sourceInstanceId: 's1', sourceId: 'codex:default', nativeSessionId: 'fail-sid' },
        mode: 'attach',
        workspaceId: ws.id,
        cwd: wsDir,
        items: [
          { role: 'user', text: 'u1' },
          { role: 'assistant', text: 'a1' },
        ],
      }),
    ).rejects.toThrow(/simulated_disk_error/);
    expect(store.listSessions()).toHaveLength(0);
    expect(changeFeed.getLatestSeq()).toBe(0);
    store.getDatabaseSync().exec('DROP TRIGGER fail_event_insert;');

    // 2. Normal import + secret item skipped in feed + paginated snapshot consistency
    const imp = await adapter.commitNativeImport({
      requestId: 'ok-req-1',
      requestHash: 'ok-h-1',
      ref: { sourceInstanceId: 's1', sourceId: 'codex:default', nativeSessionId: 'ok-sid-1' },
      mode: 'attach',
      workspaceId: ws.id,
      cwd: wsDir,
      title: '初始标题',
      items: [
        { role: 'user', text: '第一条用户消息' },
        { role: 'assistant', text: '第一条助手消息' },
      ],
    });
    expect(imp.ok).toBe(true);
    if (!imp.ok) throw new Error('expected ok');
    const sid = imp.value.sessionId;

    // Insert a secret_request block -> must NOT appear in snapshot or change feed
    store.upsertTurnItem({
      itemId: `${sid}:secret-1`,
      schemaVersion: 2,
      sessionId: sid,
      turnId: 't_sec',
      seq: 99,
      instanceId: 'codex',
      driverId: 'codex',
      blockType: 'secret_request',
      status: 'completed',
      title: 'Secret',
      textBody: 'TOP_SECRET_VALUE',
      payload: {},
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Start paginated snapshot (page 1 of 2 items)
    const page1 = changeFeed.readSearchSnapshot({ limit: 1, workspaceId: ws.id });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe('1');

    // Concurrent write BETWEEN page 1 and page 2 of snapshot!
    store.upsertTurnItem({
      itemId: `${sid}:turn_post:user`,
      schemaVersion: 2,
      sessionId: sid,
      turnId: 'turn_post',
      seq: 3,
      instanceId: 'codex',
      driverId: 'codex',
      blockType: 'user_message',
      status: 'completed',
      title: 'User',
      textBody: '快照后新增消息',
      payload: {},
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Page 2 still sees consistent snapshot as of watermarkSeq (total 2 items, not 3)
    const page2 = changeFeed.readSearchSnapshot({
      snapshotId: page1.snapshotId,
      cursor: page1.nextCursor,
      limit: 10,
      workspaceId: ws.id,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect([...page1.items, ...page2.items].some((i) => i.textBody.includes('TOP_SECRET_VALUE'))).toBe(false);

    // Update session title, update item, delete item, delete session
    store.updateSession(sid, { title: '更新后标题' });
    store.deleteTurnItem(sid, `${sid}:turn_post:user`);
    store.deleteSession(sid);

    // Cursor read from watermarkSeq gets every committed change in exact order
    const feed = changeFeed.readCommittedChanges({
      afterSeq: page1.watermarkSeq,
      limit: 50,
      workspaceId: ws.id,
    });
    expect(feed.hasMore).toBe(false);
    expect(feed.changes.map((c) => c.kind)).toEqual([
      'upsert_item',
      'upsert_session',
      'delete_item',
      'delete_session',
    ]);
    expect(feed.changes.every((c, idx, arr) => idx === 0 || c.changeSeq > arr[idx - 1]!.changeSeq)).toBe(true);
    expect(feed.latestSeq).toBe(feed.changes.at(-1)!.changeSeq);
  });

  it('serves legacy compat HTTP routes, preserves bundle duplicate semantics, and keeps archived sessions readable when disabled', async () => {
    const wsDir = ensureTempDir('hm-b1-03-compat-ws-');
    const { store, registry, importAdapter, pluginManager, installSource } = await setupImportHarness();
    const ws = store.createWorkspace({
      id: 'ws-compat',
      name: 'Compat WS',
      rootPath: wsDir,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });

    await installSource(
      'user.history.compat',
      'history.compat',
      `
export function apply(ctx) {
  ctx.provide('history.source.v1', {
    discover(req) {
      return {
        ok: true,
        value: {
          sessions: [{
            ref: { sourceInstanceId: 'history.compat', sourceId: 'codex:default', nativeSessionId: 'compat-sid-1' },
            title: 'Compat 原生会话',
            harnessKind: 'codex',
            updatedAt: 1795651200000,
            workspaceHint: { cwd: ${JSON.stringify(wsDir)}, label: 'Compat WS' },
            legacySource: 'codex_cli',
          }],
          nextCursor: null,
        },
      };
    },
    read(req) {
      return {
        ok: true,
        value: {
          ref: req.ref,
          items: [
            { itemId: 'u1', role: 'user', text: '你好兼容路由', timestamp: 1795651200000 },
            { itemId: 'a1', role: 'assistant', text: '兼容路由回复', timestamp: 1795651201000 },
          ],
          nextCursor: null,
          readStatus: 'complete',
          warnings: [],
        },
      };
    },
  }, { version: '1.0.0', metadata: { sourceNamespace: 'codex', defaultSourceId: 'codex:default', harnessKind: 'codex' } });
}
`,
    );

    const app = Fastify({ logger: false });
    fastifyApps.push(app);
    registerHistoryImportCompatRoutes(app, {
      store,
      pluginManager,
      adapter: importAdapter,
    });

    // 1. Discovered sessions compat endpoint
    const discRes = await app.inject({
      method: 'GET',
      url: '/api/v1/harnesses/discovered-sessions?limit=20&refresh=1',
    });
    expect(discRes.statusCode).toBe(200);
    expect(discRes.json().sessions).toHaveLength(1);
    expect(discRes.json().sessions[0].nativeSessionId).toBe('compat-sid-1');
    expect(discRes.json().sessions[0].alreadyImportedSessionId).toBeNull();

    // 2. Non-loopback rejected with 403
    const remoteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/import-session',
      remoteAddress: '192.168.1.50',
      payload: { source: 'codex_cli', nativeSessionId: 'compat-sid-1', mode: 'attach' },
    });
    expect(remoteRes.statusCode).toBe(403);

    // 3. Loopback native import compat endpoint
    const impRes = await app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/import-session',
      remoteAddress: '127.0.0.1',
      payload: { source: 'codex_cli', nativeSessionId: 'compat-sid-1', workspaceId: ws.id, mode: 'attach' },
    });
    expect(impRes.statusCode).toBe(200);
    const importedSessionId = impRes.json().session.id as string;
    expect(impRes.json().mode).toBe('attach');

    // 4. Discovered sessions now reflects alreadyImportedSessionId
    const discAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/harnesses/discovered-sessions?limit=20',
    });
    expect(discAfter.json().sessions[0].alreadyImportedSessionId).toBe(importedSessionId);

    // 5. Bundle import compat endpoint + duplicate bundle semantics
    const explorer = new SessionExplorerService(store, registry);
    const exported = explorer.exportSession(importedSessionId, 'json_bundle');
    if (exported.format !== 'json_bundle') throw new Error('expected bundle');
    const bundle: PortableSessionBundleV2 = exported.bundle;

    const bundleRes1 = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: { bundle, workspaceId: ws.id, titleOverride: '归档导入副本 1' },
    });
    expect(bundleRes1.statusCode).toBe(201);
    const bundleSid1 = bundleRes1.json().session.id as string;

    const bundleRes2 = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: { bundle, workspaceId: ws.id, titleOverride: '归档导入副本 2' },
    });
    expect(bundleRes2.statusCode).toBe(201);
    expect(bundleRes2.json().session.id).not.toBe(bundleSid1);

    // 6. Disable hm.plugin.history-import -> compat import endpoints fail closed (503) preserving composition binding (`disabled`) while archived sessions stay readable & exportable!
    await pluginManager.togglePlugin('hm.plugin.history-import', false);

    // When bound via distribution/composition binding, disabled instance preserves binding and reports status='disabled'
    const disabledImp = await app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/import-session',
      remoteAddress: '127.0.0.1',
      payload: { source: 'codex_cli', nativeSessionId: 'compat-sid-1', mode: 'attach' },
    });
    expect(disabledImp.statusCode).toBe(503);
    expect(disabledImp.json().code).toBe('E_SERVICE_UNAVAILABLE');
    expect(disabledImp.json().resolution.status).toBe('disabled');

    const disabledBundle = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/import-bundle',
      payload: { bundle, workspaceId: ws.id },
    });
    expect(disabledBundle.statusCode).toBe(503);

    // Archived sessions remain fully openable, replayable, and exportable!
    expect(store.getSession(importedSessionId)?.title).toBe('Compat 原生会话');
    expect(store.getEventsAfter(importedSessionId, 0, 100)).toHaveLength(3);
    expect(store.listTurnItems(importedSessionId, { limit: 100 })).toHaveLength(2);
    const exportedAfterDisable = explorer.exportSession(bundleSid1, 'markdown');
    expect(exportedAfterDisable.format).toBe('markdown');
    if (exportedAfterDisable.format === 'markdown') {
      expect(exportedAfterDisable.markdown).toContain('你好兼容路由');
    }

    // 7. Re-enable hm.plugin.history-import -> route & plugin resume cleanly, and plugin routes match compat results
    await pluginManager.togglePlugin('hm.plugin.history-import', true);
    const reenabledImp = await app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/import-session',
      remoteAddress: '127.0.0.1',
      payload: { source: 'codex_cli', nativeSessionId: 'compat-sid-1', mode: 'attach' },
    });
    expect(reenabledImp.statusCode).toBe(200);
    expect(reenabledImp.json().session.id).toBe(importedSessionId);
    expect(reenabledImp.json().disposition).toBe('reused');

    const routePreview = await pluginManager.isolated!.dispatchRoute('hm.plugin.history-import', {
      method: 'POST',
      path: '/preview',
      query: {},
      headers: {},
      body: {
        input: {
          kind: 'native',
          ref: { sourceInstanceId: 'history.compat', sourceId: 'codex:default', nativeSessionId: 'compat-sid-1' },
          mode: 'attach',
        },
        workspaceId: ws.id,
      },
    });
    expect(routePreview.status).toBe(200);
    expect((routePreview.body as any).ok).toBe(true);
    expect((routePreview.body as any).value.existingSessionId).toBe(importedSessionId);

    const routeImport = await pluginManager.isolated!.dispatchRoute('hm.plugin.history-import', {
      method: 'POST',
      path: '/import',
      query: {},
      headers: {},
      body: {
        input: {
          kind: 'native',
          ref: { sourceInstanceId: 'history.compat', sourceId: 'codex:default', nativeSessionId: 'compat-sid-1' },
          mode: 'attach',
        },
        workspaceId: ws.id,
        requestId: 'route-import-parity-1',
      },
    });
    expect(routeImport.status).toBe(200);
    expect((routeImport.body as any).ok).toBe(true);
    expect((routeImport.body as any).value.sessionId).toBe(importedSessionId);
    expect((routeImport.body as any).value.disposition).toBe('reused');
  }, 30_000);
});
