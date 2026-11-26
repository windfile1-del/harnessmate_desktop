import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearScannerCache,
  findLocalSession,
  readAgyIndexedHistoryDetailedFromRoot,
  readJsonlHistoryDetailed,
  scanLocalCliSessions,
} from '../src/harnesses/history-scanner.js';
import {
  createAgyCliHistorySource,
  createAgyDesktopHistorySource,
  createClaudeHistorySource,
  createCodexHistorySource,
  createCustomHistorySource,
  decodeOffsetCursor,
  encodeOffsetCursor,
  HistorySourceInstance,
  legacySourcesForSourceId,
  registerHistorySourceScannerBridge,
  resolveHistorySourceIdentity,
} from '../src/harnesses/history-sources/index.js';
import { createDaemon } from '../src/server/app.js';
import { buildB102Fixtures } from './fixtures/b1-02/build-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const tempDirs: string[] = [];
const daemons: Array<ReturnType<typeof createDaemon>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function safeRm(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows handle release tolerance
  }
}

function snapshotTree(rootDir: string): Array<{ rel: string; size: number; mtimeMs: number }> {
  const out: Array<{ rel: string; size: number; mtimeMs: number }> = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const st = fs.statSync(full);
        out.push({ rel: path.relative(rootDir, full), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(rootDir);
  return out;
}

afterEach(async () => {
  clearScannerCache();
  while (daemons.length > 0) {
    const d = daemons.pop()!;
    await d.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    safeRm(tempDirs.pop()!);
  }
});

describe('B1-02 history.source.v1 sources & plugins', () => {
  it('keeps identical runtime across all 5 history-source plugin packages and valid V4 manifests', () => {
    const dirs = [
      path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-codex'),
      path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-claude'),
      path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-agy-cli'),
      path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-agy-desktop'),
      path.join(repoRoot, 'plugins/examples/hm.plugin.history-source-custom'),
    ];
    const runtimes = dirs.map((d) => fs.readFileSync(path.join(d, 'history-source-runtime.mjs'), 'utf8'));
    for (const content of runtimes) {
      expect(content).toBe(runtimes[0]);
    }
    for (const d of dirs) {
      const manifest = JSON.parse(fs.readFileSync(path.join(d, 'harnessmate-plugin.json'), 'utf8'));
      expect(manifest.apiVersion).toBe(4);
      expect(manifest.provides).toEqual(['history.source.v1']);
      expect(manifest.permissions).toContain('fs:cli_histories:read');
    }
  });

  it('derives stable sourceId and legacy mappings for default vs independent accounts', () => {
    const codexDefault = resolveHistorySourceIdentity('codex', {});
    expect(codexDefault.isDefault).toBe(true);
    expect(codexDefault.sourceId).toBe('codex:default');
    expect(codexDefault.compatLegacySources).toEqual(['codex_cli', 'codex_desktop']);

    const claudeDefault = resolveHistorySourceIdentity('claude', {});
    expect(claudeDefault.sourceId).toBe('claude:default');
    expect(claudeDefault.compatLegacySources).toEqual(['claude_cli']);

    const agyCliDefault = resolveHistorySourceIdentity('agy_cli', {});
    expect(agyCliDefault.sourceId).toBe('agy_cli:default');
    expect(agyCliDefault.compatLegacySources).toEqual(['agy_cli']);

    const agyDeskDefault = resolveHistorySourceIdentity('agy_desktop', {});
    expect(agyDeskDefault.sourceId).toBe('agy_desktop:default');
    expect(agyDeskDefault.compatLegacySources).toEqual(['agy_desktop']);

    expect(legacySourcesForSourceId('codex:default')).toEqual(['codex_cli', 'codex_desktop']);
    expect(legacySourcesForSourceId('codex:acct:deadbeef1234')).toEqual([]);
    expect(legacySourcesForSourceId('codex_desktop')).toEqual(['codex_desktop']);

    const customA = resolveHistorySourceIdentity('codex', { rootDir: 'D:\\Fixtures\\acct-a' });
    const customB = resolveHistorySourceIdentity('codex', { rootDir: 'D:\\Fixtures\\acct-b' });
    expect(customA.isDefault).toBe(false);
    expect(customA.sourceId).toMatch(/^codex:acct:[a-f0-9]{12}$/);
    expect(customA.sourceId).not.toBe(customB.sourceId);
    expect(customA.compatLegacySources).toEqual([]);
  });

  it('discovers and reads all 5 source types strictly read-only with deduplication, isolation, pagination, and diagnostics', async () => {
    const fixtureBase = makeTempDir('hm-b102-fix-');
    const fx = buildB102Fixtures(fixtureBase);

    const beforeCodex = snapshotTree(fx.codexHome);
    const beforeClaude = snapshotTree(fx.claudeHome);
    const beforeAgyCli = snapshotTree(fx.agyCliRoot);
    const beforeAgyDesk = snapshotTree(fx.agyDesktopRoot);

    // 1. Codex CLI + Desktop sharing the same home -> shared sourceId!
    const codexCliView = createCodexHistorySource('codex.cli.view', {
      rootDir: fx.codexHome,
      origins: ['codex_cli'],
    });
    const codexDesktopView = createCodexHistorySource('codex.desktop.view', {
      rootDir: fx.codexHome,
      origins: ['codex_desktop'],
    });
    expect(codexCliView.identity.sourceId).toBe(codexDesktopView.identity.sourceId);

    const codexUnified = createCodexHistorySource('hm.plugin.history-source-codex', {
      rootDir: fx.codexHome,
    });
    // Independent account B with colliding nativeSessionId
    const codexAcctB = createCodexHistorySource('codex.acct.b', {
      rootDir: fx.codexAccountB,
    });
    expect(codexAcctB.identity.sourceId).not.toBe(codexUnified.identity.sourceId);

    const cliDisc = await codexCliView.discover({ limit: 10 });
    expect(cliDisc.ok).toBe(true);
    if (!cliDisc.ok) throw new Error(cliDisc.error.message);
    expect(cliDisc.value.sessions.map((s) => s.ref.nativeSessionId)).toContain(fx.ids.codexCliId);
    expect(cliDisc.value.sessions.map((s) => s.ref.nativeSessionId)).not.toContain(fx.ids.codexDesktopId);

    const deskDisc = await codexDesktopView.discover({ limit: 10 });
    expect(deskDisc.ok).toBe(true);
    if (!deskDisc.ok) throw new Error(deskDisc.error.message);
    expect(deskDisc.value.sessions.map((s) => s.ref.nativeSessionId)).toEqual(
      expect.arrayContaining([fx.ids.codexDesktopId, fx.ids.codexZstId]),
    );

    // Query + pagination on unified Codex source
    const page1 = await codexUnified.discover({ limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error(page1.error.message);
    expect(page1.value.sessions).toHaveLength(2);
    expect(page1.value.nextCursor).toBeTruthy();

    const page2 = await codexUnified.discover({ limit: 2, cursor: page1.value.nextCursor });
    expect(page2.ok).toBe(true);
    if (!page2.ok) throw new Error(page2.error.message);
    expect(page2.value.sessions.length).toBeGreaterThanOrEqual(2);
    expect(page2.value.nextCursor).toBeNull();

    // Chinese query + workspaceId filter
    const filtered = await codexUnified.discover({ query: '中文检索', workspaceId: 'repo-codex-cli' });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) throw new Error(filtered.error.message);
    expect(filtered.value.sessions).toHaveLength(1);
    expect(filtered.value.sessions[0]?.title).toContain('Codex CLI');

    // Read zstd-compressed archived Codex Desktop session & paginated read
    const zstRef = deskDisc.value.sessions.find((s) => s.ref.nativeSessionId === fx.ids.codexZstId)!.ref;
    const zstRead1 = await codexDesktopView.read({ ref: zstRef, limit: 1 });
    expect(zstRead1.ok).toBe(true);
    if (!zstRead1.ok) throw new Error(zstRead1.error.message);
    expect(zstRead1.value.readStatus).toBe('complete');
    expect(zstRead1.value.items).toEqual([
      expect.objectContaining({ itemId: 'message-1', role: 'user', text: '压缩归档问题' }),
    ]);
    expect(zstRead1.value.nextCursor).toBeTruthy();

    const zstRead2 = await codexDesktopView.read({ ref: zstRef, limit: 1, cursor: zstRead1.value.nextCursor });
    expect(zstRead2.ok).toBe(true);
    if (!zstRead2.ok) throw new Error(zstRead2.error.message);
    expect(zstRead2.value.items).toEqual([
      expect.objectContaining({ itemId: 'message-2', role: 'assistant', text: '压缩归档回答' }),
    ]);
    expect(zstRead2.value.nextCursor).toBeNull();

    // Read partial trailing corrupted line cleanly
    const partialRead = await codexUnified.read({
      ref: {
        sourceInstanceId: codexUnified.instanceId,
        sourceId: codexUnified.identity.sourceId,
        nativeSessionId: fx.ids.codexPartialId,
      },
    });
    expect(partialRead.ok).toBe(true);
    if (!partialRead.ok) throw new Error(partialRead.error.message);
    expect(partialRead.value.readStatus).toBe('partial');
    expect(partialRead.value.items).toHaveLength(1);
    expect(partialRead.value.warnings.some((w) => w.includes('半截尾行') || w.includes('损坏行'))).toBe(true);

    // Independent account B reads its own content despite same nativeSessionId
    const acctBDisc = await codexAcctB.discover({ limit: 5 });
    expect(acctBDisc.ok).toBe(true);
    if (!acctBDisc.ok) throw new Error(acctBDisc.error.message);
    const acctBRead = await codexAcctB.read({ ref: acctBDisc.value.sessions[0]!.ref });
    expect(acctBRead.ok).toBe(true);
    if (!acctBRead.ok) throw new Error(acctBRead.error.message);
    expect(acctBRead.value.items[0]?.text).toBe('独立账户 B 同名 ID 记录');

    // 2. Claude CLI
    const claude = createClaudeHistorySource('hm.plugin.history-source-claude', { rootDir: fx.claudeHome });
    const claudeDisc = await claude.discover({ limit: 10 });
    expect(claudeDisc.ok).toBe(true);
    if (!claudeDisc.ok) throw new Error(claudeDisc.error.message);
    expect(claudeDisc.value.sessions).toHaveLength(1);
    expect(claudeDisc.value.sessions[0]?.title).toBe('Claude Code 样本会话');
    const claudeRead = await claude.read({ ref: claudeDisc.value.sessions[0]!.ref });
    expect(claudeRead.ok).toBe(true);
    if (!claudeRead.ok) throw new Error(claudeRead.error.message);
    expect(claudeRead.value.items.map((i) => i.text)).toEqual(['Claude 你好', 'Claude 历史回复内容']);

    // 3. AGY CLI & AGY Desktop separate discovery/reading + unindexed .pb diagnostic
    const agyCli = createAgyCliHistorySource('hm.plugin.history-source-agy-cli', { rootDir: fx.agyCliRoot });
    const agyDesk = createAgyDesktopHistorySource('hm.plugin.history-source-agy-desktop', { rootDir: fx.agyDesktopRoot });
    expect(agyCli.identity.sourceId).not.toBe(agyDesk.identity.sourceId);

    const agyCliDisc = await agyCli.discover({ limit: 10 });
    expect(agyCliDisc.ok).toBe(true);
    if (!agyCliDisc.ok) throw new Error(agyCliDisc.error.message);
    expect(agyCliDisc.value.sessions.map((s) => s.ref.nativeSessionId)).toEqual(
      expect.arrayContaining([fx.ids.agyCliId, fx.ids.agyCliNoFtsId]),
    );

    const agyCliReadOk = await agyCli.read({
      ref: { sourceInstanceId: agyCli.instanceId, sourceId: agyCli.identity.sourceId, nativeSessionId: fx.ids.agyCliId },
    });
    expect(agyCliReadOk.ok).toBe(true);
    if (!agyCliReadOk.ok) throw new Error(agyCliReadOk.error.message);
    expect(agyCliReadOk.value.items.map((i) => i.text)).toEqual(['AGY CLI 问题', 'AGY CLI 回答']);

    const agyCliReadMissingBody = await agyCli.read({
      ref: { sourceInstanceId: agyCli.instanceId, sourceId: agyCli.identity.sourceId, nativeSessionId: fx.ids.agyCliNoFtsId },
    });
    expect(agyCliReadMissingBody.ok).toBe(false);
    if (agyCliReadMissingBody.ok) throw new Error('expected source_unreadable');
    expect(agyCliReadMissingBody.error.code).toBe('source_unreadable');
    expect(agyCliReadMissingBody.error.message).toContain('conversations_fts');

    const agyDeskDisc = await agyDesk.discover({ limit: 10 });
    expect(agyDeskDisc.ok).toBe(true);
    if (!agyDeskDisc.ok) throw new Error(agyDeskDisc.error.message);
    const agyDeskReadOk = await agyDesk.read({
      ref: { sourceInstanceId: agyDesk.instanceId, sourceId: agyDesk.identity.sourceId, nativeSessionId: fx.ids.agyDesktopId },
    });
    expect(agyDeskReadOk.ok).toBe(true);
    if (!agyDeskReadOk.ok) throw new Error(agyDeskReadOk.error.message);
    expect(agyDeskReadOk.value.items.map((i) => i.text)).toEqual(['AGY Desktop 问题', 'AGY Desktop 回答']);

    // Tampered cursor -> invalid_request
    const badCursor = await codexUnified.discover({ cursor: 'not-valid-base64-json' });
    expect(badCursor.ok).toBe(false);
    if (!badCursor.ok) expect(badCursor.error.code).toBe('invalid_request');
    expect(encodeOffsetCursor(2)).toBeTruthy();
    expect(decodeOffsetCursor(encodeOffsetCursor(2))).toEqual({ ok: true, offset: 2 });

    // Strict zero-write assertion across all source directories (zero -wal/-shm side-effects!)
    expect(snapshotTree(fx.codexHome)).toEqual(beforeCodex);
    expect(snapshotTree(fx.claudeHome)).toEqual(beforeClaude);
    expect(snapshotTree(fx.agyCliRoot)).toEqual(beforeAgyCli);
    expect(snapshotTree(fx.agyDesktopRoot)).toEqual(beforeAgyDesk);
  });

  it('supports cancellation during read, instance dispose fencing, and legacy scanner bridge compatibility', async () => {
    const fixtureBase = makeTempDir('hm-b102-cancel-');
    const bigRoot = path.join(fixtureBase, 'codex-big');
    const sessDir = path.join(bigRoot, 'sessions', '2026', '11', '26');
    fs.mkdirSync(sessDir, { recursive: true });
    const sid = '99999999-9999-4999-8999-999999999999';
    const rows = [
      JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd: 'D:\\Fixtures\\big', originator: 'codex_cli_rs' } }),
      ...Array.from({ length: 4000 }, (_, i) =>
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-11-26T10:00:00Z',
          payload: { type: 'message', role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'input_text', text: `Line ${i} ${'X'.repeat(256)}` }] },
        }),
      ),
    ];
    fs.writeFileSync(path.join(sessDir, `rollout-${sid}.jsonl`), rows.join('\n') + '\n', 'utf8');

    const src = createCodexHistorySource('codex.cancel.test', { rootDir: bigRoot });
    const disc = await src.discover({ limit: 5 });
    expect(disc.ok).toBe(true);
    if (!disc.ok) throw new Error(disc.error.message);

    // Explicit operationId cancellation
    const readPromise = src.read({ ref: disc.value.sessions[0]!.ref, operationId: 'op-cancel-1', limit: 100 });
    const cancelRes = await src.cancel({ operationId: 'op-cancel-1' });
    expect(cancelRes.ok).toBe(true);
    if (cancelRes.ok) expect(cancelRes.value.cancelled).toBe(true);
    const readOutcome = await readPromise;
    expect(readOutcome.ok).toBe(false);
    if (!readOutcome.ok) expect(readOutcome.error.code).toBe('cancelled');

    // Legacy scanner bridge compatibility
    const unregisterBridge = registerHistorySourceScannerBridge(src);
    try {
      const legacyFound = await findLocalSession('codex', sid, 'codex_cli', src.instanceId);
      expect(legacyFound?.nativeSessionId).toBe(sid);
      const legacyRead = await readJsonlHistoryDetailed(legacyFound!);
      expect(legacyRead.messages.length).toBe(4000);
      const all = await scanLocalCliSessions(5);
      expect(all.some((s) => s.scannerId === src.instanceId && s.nativeSessionId === sid)).toBe(true);
    } finally {
      unregisterBridge();
    }

    // Dispose cancels in-flight & blocks subsequent tasks
    const inFlightRead = src.read({ ref: disc.value.sessions[0]!.ref, operationId: 'op-dispose-1', limit: 100 });
    const abortedCount = src.dispose();
    expect(abortedCount).toBe(1);
    const disposedOutcome = await inFlightRead;
    expect(disposedOutcome.ok).toBe(false);
    if (!disposedOutcome.ok) expect(disposedOutcome.error.code).toBe('cancelled');

    const afterDispose = await src.discover({ limit: 5 });
    expect(afterDispose.ok).toBe(false);
    if (!afterDispose.ok) expect(afterDispose.error.code).toBe('cancelled');

    // Verify existing history-scanner.ts AGY export still works untouched
    const fx = buildB102Fixtures(makeTempDir('hm-b102-agy-compat-'));
    const agyDetailed = readAgyIndexedHistoryDetailedFromRoot(fx.agyCliRoot, fx.ids.agyCliId);
    expect(agyDetailed.messages.map((m) => m.text)).toEqual(['AGY CLI 问题', 'AGY CLI 回答']);
  });

  it('runs bundled plugins + 3rd-party custom source concurrently through IsolatedPluginManager, isolates failures, and handles reversed load order & toggle', async () => {
    const dataDir = makeTempDir('hm-b102-daemon-');
    const fixtureBase = makeTempDir('hm-b102-daemon-fx-');
    const fx = buildB102Fixtures(fixtureBase);
    const daemon = createDaemon({ dataDir, port: 0, host: '127.0.0.1' });
    daemons.push(daemon);
    await daemon.start();

    // 1. Install third-party custom source via normal local_dir install (untrusted sandbox, reads package-local samples/)
    const customDir = path.join(repoRoot, 'plugins/examples/hm.plugin.history-source-custom');
    const customPreview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: customDir });
    await daemon.pluginManager.installPlugin({
      mode: 'local_dir',
      dirPath: customDir,
      trustCode: true,
      expectedDigest: customPreview.digest,
      expectedInstalledDigest: customPreview.installedDigest,
    });

    // 2. Link bundled plugins in trusted-local dev mode for end-to-end isolated process verification
    // (until B1-06 adds them to BUNDLED_PLUGIN_IDS / BUNDLED_TRUSTED_LOCAL_IDS)
    const codexDir = path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-codex');
    const claudeDir = path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-claude');
    const agyCliDir = path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-agy-cli');
    const agyDeskDir = path.join(repoRoot, 'plugins/bundled/hm.plugin.history-source-agy-desktop');

    await daemon.pluginManager.linkDevPlugin(codexDir, 'hm.plugin.history-source-codex');
    await daemon.pluginManager.linkDevPlugin(claudeDir, 'hm.plugin.history-source-claude');
    await daemon.pluginManager.linkDevPlugin(agyCliDir, 'hm.plugin.history-source-agy-cli');
    await daemon.pluginManager.linkDevPlugin(agyDeskDir, 'hm.plugin.history-source-agy-desktop');

    // Create two concurrent Codex instances + corrupt AGY instance + Claude + AGY Desktop
    for (const payload of [
      { id: 'codex.primary', name: 'hm.plugin.history-source-codex', config: { rootDir: fx.codexHome } },
      { id: 'codex.secondary', name: 'hm.plugin.history-source-codex', config: { rootDir: fx.codexAccountB } },
      { id: 'claude.primary', name: 'hm.plugin.history-source-claude', config: { rootDir: fx.claudeHome } },
      { id: 'agy.cli.corrupt', name: 'hm.plugin.history-source-agy-cli', config: { rootDir: fx.agyCorruptRoot } },
      { id: 'agy.desktop.primary', name: 'hm.plugin.history-source-agy-desktop', config: { rootDir: fx.agyDesktopRoot } },
    ]) {
      const res = await daemon.app.inject({
        method: 'PUT',
        url: '/api/v1/plugins/composition/instances',
        payload,
      });
      expect(res.statusCode).toBe(200);
    }

    const providersRes = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins/services?contract=history.source.v1' });
    expect(providersRes.statusCode).toBe(200);
    const providerIds = (providersRes.json().providers as Array<{ instanceId: string; state: string }>)
      .filter((p) => p.state === 'ACTIVE')
      .map((p) => p.instanceId);
    expect(providerIds).toEqual(
      expect.arrayContaining([
        'user.history-source-custom',
        'codex.primary',
        'codex.secondary',
        'claude.primary',
        'agy.cli.corrupt',
        'agy.desktop.primary',
      ]),
    );

    // Verify third-party custom source route discover + read inside isolated --permission sandbox
    const customDisc = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/user.history-source-custom/routes/discover',
      payload: { query: '构建诊断', limit: 5 },
    });
    expect(customDisc.statusCode).toBe(200);
    expect(customDisc.json().ok).toBe(true);
    expect(customDisc.json().value.sessions).toHaveLength(1);
    const customRef = customDisc.json().value.sessions[0].ref;
    expect(customRef.sourceId).toBe('custom:default');

    const customRead = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/user.history-source-custom/routes/read',
      payload: { ref: customRef, limit: 2 },
    });
    expect(customRead.statusCode).toBe(200);
    expect(customRead.json().ok).toBe(true);
    expect(customRead.json().value.items).toHaveLength(2);
    expect(customRead.json().value.nextCursor).toBeTruthy();

    // Verify corrupt AGY CLI source fails cleanly with source_unreadable without affecting Codex/Claude/AGY Desktop/Custom
    const corruptDisc = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/agy.cli.corrupt/routes/discover',
      payload: { limit: 5 },
    });
    expect(corruptDisc.statusCode).toBe(200);
    expect(corruptDisc.json().ok).toBe(false);
    expect(corruptDisc.json().error.code).toBe('source_unreadable');

    const codexA = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/codex.primary/routes/discover',
      payload: { limit: 10 },
    });
    const codexB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/codex.secondary/routes/discover',
      payload: { limit: 10 },
    });
    expect(codexA.json().ok).toBe(true);
    expect(codexB.json().ok).toBe(true);
    const refA = codexA.json().value.sessions.find((s: { ref: { nativeSessionId: string } }) => s.ref.nativeSessionId === fx.ids.codexCliId).ref;
    const refB = codexB.json().value.sessions.find((s: { ref: { nativeSessionId: string } }) => s.ref.nativeSessionId === fx.ids.codexCliId).ref;
    expect(refA.sourceId).not.toBe(refB.sourceId);

    // Verify disabling codex.primary isolates only codex.primary, then re-enabling restores it
    await daemon.pluginManager.togglePlugin('codex.primary', false);
    const disabledRoute = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/codex.primary/routes/discover',
      payload: { limit: 5 },
    });
    expect(disabledRoute.statusCode).toBe(503);

    const stillActiveB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/codex.secondary/routes/discover',
      payload: { limit: 5 },
    });
    expect(stillActiveB.statusCode).toBe(200);
    expect(stillActiveB.json().ok).toBe(true);

    await daemon.pluginManager.togglePlugin('codex.primary', true);
    const restoredA = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/codex.primary/routes/discover',
      payload: { limit: 5 },
    });
    expect(restoredA.statusCode).toBe(200);
    expect(restoredA.json().ok).toBe(true);

    // Reversed registration/instance order produces identical sourceId & content
    const daemonRev = createDaemon({ dataDir: makeTempDir('hm-b102-daemon-rev-'), port: 0, host: '127.0.0.1' });
    daemons.push(daemonRev);
    await daemonRev.start();
    await daemonRev.pluginManager.linkDevPlugin(codexDir, 'hm.plugin.history-source-codex');
    await daemonRev.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: { id: 'codex.secondary', name: 'hm.plugin.history-source-codex', config: { rootDir: fx.codexAccountB } },
    });
    await daemonRev.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: { id: 'codex.primary', name: 'hm.plugin.history-source-codex', config: { rootDir: fx.codexHome } },
    });
    const revA = await daemonRev.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/codex.primary/routes/discover',
      payload: { limit: 10 },
    });
    const revRefA = revA.json().value.sessions.find((s: { ref: { nativeSessionId: string } }) => s.ref.nativeSessionId === fx.ids.codexCliId).ref;
    expect(revRefA).toEqual(refA);

    // Avoid unused helper warning
    expect(HistorySourceInstance).toBeDefined();
    expect(createCustomHistorySource).toBeDefined();
  }, 35_000);
});
