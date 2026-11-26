import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PEER_CONTRACTS } from '@harnessmate/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AdapterSessionConfig, HarnessAdapter, NormalizedAdapterEvent, TurnInput } from '../src/harnesses/types.js';
import { sharedGitRepoCoordinator } from '../src/core/git-repo-lock.js';
import { auditPluginPackage } from '../src/plugins/plugin-static-audit.js';
import { createDaemon } from '../src/server/app.js';

function readPackageFiles(rootDir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ent of fs.readdirSync(path.join(rootDir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      Object.assign(out, readPackageFiles(rootDir, rel));
    } else if (ent.isFile()) {
      out[rel] = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    }
  }
  return out;
}

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const tempDirs: string[] = [];
const daemons: Array<ReturnType<typeof createDaemon>> = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function initGitWorkspace(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 'w1-test@example.com']);
  await runGit(dir, ['config', 'user.name', 'W1 Tester']);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Project Rules\n- Keep W1 clean.\n');
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'demo-skill', 'SKILL.md'), '# Demo Skill\n');
  fs.mkdirSync(path.join(dir, 'docs 文件夹'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs 文件夹', '说明 文件.md'), '# 标题\n第2行内容\n第3行重点\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'line 1\nline 2\nline 3\n');
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-m', 'init workspace']);
}

function createFakeAdapter(id = 'fake-w1'): HarnessAdapter {
  return {
    id,
    kind: 'codex',
    displayName: 'Fake W1 Harness',
    description: 'Fake harness for W1 tests',
    protocolLabel: 'fake',
    capabilities: {
      supportsModelSelect: false,
      supportsReasoningEffort: false,
      supportsPermissionModes: false,
      supportsInterrupt: true,
      supportsResume: false,
      supportsAttachments: true,
      supportsContextSync: false,
    },
    capabilitiesV2: {
      harnessId: id,
      kind: 'codex',
      displayName: 'Fake W1 Harness',
      supportsAttachments: true,
      supportsNativeCommands: false,
      supportsModelTools: false,
      supportsNativeRollback: false,
      traitDescriptors: [],
    },
    probe: async () => ({
      binaryPath: process.execPath,
      version: '1.0.0',
      health: 'ready',
      models: [],
    }),
    createSession: async (_cfg: AdapterSessionConfig) => {
      const listeners = new Set<(ev: NormalizedAdapterEvent) => void>();
      return {
        nativeSessionId: `native_${id}`,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async sendTurn(input: TurnInput) {
          for (const l of listeners) l({ type: 'turn.started', turnId: input.turnId });
          for (const l of listeners) l({ type: 'text.delta', turnId: input.turnId, text: `echo:${input.text}` });
          for (const l of listeners) l({ type: 'turn.completed', turnId: input.turnId });
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
      };
    },
  };
}

function connectWs(daemon: ReturnType<typeof createDaemon>): Promise<WebSocket> {
  const addr = daemon.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const wsUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

afterEach(async () => {
  while (daemons.length > 0) {
    const d = daemons.pop()!;
    await d.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // best effort cleanup
    }
  }
});

describe('Batch 2 W1 · Workspace Tools Backend Integration & Decoupling', () => {
  it(
    'runs worktree -> terminal -> files/rules/preview/attachment -> busy reject -> explicit release -> re-check -> safe remove chain',
    async () => {
      const root = createTempDir('hm-b2-w1-chain-');
      const repoDir = path.join(root, 'repo');
      const dataDir = path.join(root, 'data');
      await initGitWorkspace(repoDir);

      const daemon = createDaemon({
        dataDir,
        port: 0,
        hostOverride: '127.0.0.1',
        customAdapters: [createFakeAdapter()],
      });
      daemons.push(daemon);
      await daemon.start();

      // hm.plugin.terminal-workspace remains disabled by default in harnessmate-core
      const initialTermPlugin = daemon.pluginManager
        .listInstalled()
        .find((p) => p.id === 'hm.plugin.terminal-workspace');
      expect(initialTermPlugin?.enabled).toBe(false);

      const ws = await daemon.sessionManager.addWorkspace(repoDir, 'W1 Chain');
      const session = await daemon.sessionManager.createSession({
        workspaceId: ws.id,
        harnessId: 'fake-w1',
        permissionMode: 'manual',
      });

      // Enable interactive terminal plugin
      const enableRes = await daemon.app.inject({
        method: 'PATCH',
        url: '/api/v1/plugins/hm.plugin.terminal-workspace',
        payload: { enabled: true },
      });
      expect(enableRes.statusCode).toBe(200);

      // 1. Create worktree via compat API
      const createWtRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${ws.id}/worktrees`,
        payload: { branchName: 'feat/w1-e2e', baseBranch: 'main' },
      });
      expect(createWtRes.statusCode).toBe(201);
      const wtPath = createWtRes.json().created.worktreePath as string;
      expect(fs.existsSync(wtPath)).toBe(true);

      // 2. Open interactive terminal inside the worktree
      const openTermRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${ws.id}/terminals`,
        payload: { cwd: wtPath, sessionId: session.id, title: 'WT Shell' },
      });
      expect(openTermRes.statusCode).toBe(201);
      const term = openTermRes.json().terminal as { terminalId: string; cwd: string };
      expect(term.terminalId).toBeTruthy();

      // 3. One-shot command, files search, line preview, rules discovery, and attachments
      const oneShotRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/terminal`,
        payload: { command: 'node -e "console.log(123)"' },
      });
      expect(oneShotRes.statusCode).toBe(200);
      expect(oneShotRes.json().result.stdout).toContain('123');

      const filesRes = await daemon.app.inject(`/api/v1/sessions/${session.id}/files?q=${encodeURIComponent('说明')}`);
      expect(filesRes.statusCode).toBe(200);
      expect(filesRes.json().files.some((f: { relativePath: string }) => f.relativePath.includes('说明 文件.md'))).toBe(
        true,
      );

      const viewTextRes = await daemon.app.inject(
        `/api/v1/sessions/${session.id}/file-view?path=${encodeURIComponent('docs 文件夹/说明 文件.md')}&line=3`,
      );
      expect(viewTextRes.statusCode).toBe(200);
      expect(viewTextRes.json().availableViewers.length).toBeGreaterThanOrEqual(1);
      expect(viewTextRes.json().file).toEqual({
        relativePath: 'docs 文件夹/说明 文件.md',
        content: '# 标题\n第2行内容\n第3行重点\n',
        sizeBytes: Buffer.byteLength('# 标题\n第2行内容\n第3行重点\n', 'utf8'),
        truncated: false,
      });

      const rulesRes = await daemon.app.inject(`/api/v1/sessions/${session.id}/rules`);
      expect(rulesRes.statusCode).toBe(200);
      const rules = rulesRes.json().instructions as Array<{ relativePath: string; kind: string }>;
      expect(rules.some((r) => r.relativePath === 'AGENTS.md' && r.kind === 'rules')).toBe(true);
      expect(rules.some((r) => r.relativePath.includes('SKILL.md') && r.kind === 'skill')).toBe(true);

      const chipRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/terminals/${term.terminalId}/context-chip`,
        payload: { recentLines: 5 },
      });
      expect(chipRes.statusCode).toBe(200);
      expect(chipRes.json().chip.terminalId).toBe(term.terminalId);

      const attPayload = Buffer.from('hello w1 attachment', 'utf8').toString('base64');
      const uploadRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/attachments`,
        payload: { name: 'notes.txt', kind: 'file_ref', mimeType: 'text/plain', dataBase64: attPayload },
      });
      expect(uploadRes.statusCode).toBe(201);
      const previewUrl = uploadRes.json().attachment.previewUrl as string;
      const streamRes = await daemon.app.inject(previewUrl);
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.body).toBe('hello w1 attachment');

      // 4. Deleting busy worktree rejects 409 E_WORKTREE_BUSY without silently closing terminal
      const busyDeleteRes = await daemon.app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${ws.id}/worktrees`,
        payload: { worktreePath: wtPath },
      });
      expect(busyDeleteRes.statusCode).toBe(409);
      expect(busyDeleteRes.json().code).toBe('E_WORKTREE_BUSY');
      expect(busyDeleteRes.json().blockingTerminals).toHaveLength(1);
      expect(fs.existsSync(wtPath)).toBe(true);

      // 5. Explicit releaseTerminals releases blocking terminal, re-checks pathUsage, and deletes cleanly
      const safeDeleteRes = await daemon.app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${ws.id}/worktrees`,
        payload: { worktreePath: wtPath, releaseTerminals: true },
      });
      expect(safeDeleteRes.statusCode).toBe(200);
      expect(safeDeleteRes.json().releasedTerminals.closedCount).toBe(1);
      expect(fs.existsSync(wtPath)).toBe(false);

      // Disabling terminal-workspace closes active terminals and keeps bindings intact
      const openAgainRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${ws.id}/terminals`,
        payload: { cwd: repoDir, title: 'To Be Stopped' },
      });
      expect(openAgainRes.statusCode).toBe(201);
      const disableTermRes = await daemon.app.inject({
        method: 'PATCH',
        url: '/api/v1/plugins/hm.plugin.terminal-workspace',
        payload: { enabled: false },
      });
      expect(disableTermRes.statusCode).toBe(200);
      const listAfterDisable = await daemon.app.inject(`/api/v1/workspaces/${ws.id}/terminals`);
      expect(listAfterDisable.json().enabled).toBe(false);
    },
    30_000,
  );

  it(
    'serializes concurrent Git writes per common dir, exposes non-throwing W2 Git status DTO, and preserves historical data & core chat when W1 plugins are disabled',
    async () => {
      const root = createTempDir('hm-b2-w1-locks-');
      const repo1 = path.join(root, 'repo1');
      const repo2 = path.join(root, 'repo2');
      const nonGitDir = path.join(root, 'fresh-dir');
      const dataDir = path.join(root, 'data');
      await initGitWorkspace(repo1);
      await initGitWorkspace(repo2);
      fs.mkdirSync(nonGitDir, { recursive: true });
      fs.writeFileSync(path.join(nonGitDir, 'hello.txt'), 'init lock test\n');

      const daemon = createDaemon({
        dataDir,
        port: 0,
        hostOverride: '127.0.0.1',
        customAdapters: [createFakeAdapter()],
      });
      daemons.push(daemon);
      await daemon.start();

      const ws1 = await daemon.sessionManager.addWorkspace(repo1, 'Repo1');
      const wtRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${ws1.id}/worktrees`,
        payload: { branchName: 'feat/shared-lock', baseBranch: 'main' },
      });
      expect(wtRes.statusCode).toBe(201);
      const wt1Path = wtRes.json().created.worktreePath as string;

      // Second workspace pointing at a linked worktree of the SAME repo1
      const ws1Worktree = await daemon.sessionManager.addWorkspace(wt1Path, 'Repo1 Worktree');
      const ws2 = await daemon.sessionManager.addWorkspace(repo2, 'Repo2');
      const wsNonGit = await daemon.sessionManager.addWorkspace(nonGitDir, 'Fresh NonGit');

      const sessMain = await daemon.sessionManager.createSession({
        workspaceId: ws1.id,
        harnessId: 'fake-w1',
        permissionMode: 'manual',
      });
      const sessWt = await daemon.sessionManager.createSession({
        workspaceId: ws1Worktree.id,
        harnessId: 'fake-w1',
        permissionMode: 'manual',
      });

      const nonGitSession = await daemon.sessionManager.createSession({
        workspaceId: wsNonGit.id,
        harnessId: 'fake-w1',
        permissionMode: 'manual',
      });

      // Concurrent writes/checkpoints sharing the exact same git-common-dir + concurrent init on nonGitDir
      fs.writeFileSync(path.join(repo1, 'a.txt'), 'change a');
      fs.writeFileSync(path.join(wt1Path, 'b.txt'), 'change b');
      const [ckpt1, ckpt2, initRes, statusDtoRes] = await Promise.all([
        daemon.sessionManager.captureManualCheckpoint(sessMain.id),
        daemon.sessionManager.captureManualCheckpoint(sessWt.id),
        daemon.app.inject({ method: 'POST', url: `/api/v1/sessions/${nonGitSession.id}/git/init` }),
        daemon.app.inject(`/api/v1/workspaces/${ws2.id}/git/status`),
      ]);
      expect(ckpt1?.checkpointId).toBeTruthy();
      expect(ckpt2?.checkpointId).toBeTruthy();
      expect(initRes.statusCode).toBe(200);

      // Validate W2-consumable GitStatusLookup DTO when Git plugin active
      expect(statusDtoRes.statusCode).toBe(200);
      expect(statusDtoRes.json()).toMatchObject({
        available: true,
        instanceId: 'git',
        status: {
          isGitRepo: true,
          branch: 'main',
        },
      });

      // Upload an attachment before disabling core.attachments
      const attRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessMain.id}/attachments`,
        payload: {
          name: 'legacy-note.txt',
          kind: 'file_ref',
          mimeType: 'text/plain',
          dataBase64: Buffer.from('kept after disable', 'utf8').toString('base64'),
        },
      });
      expect(attRes.statusCode).toBe(201);
      const savedAttachmentUrl = attRes.json().attachment.previewUrl as string;

      // Verify independent repos execute concurrently while same-common-dir ops serialize
      let releaseFirst!: () => void;
      const firstEntered = new Promise<void>((res) => {
        const task1 = sharedGitRepoCoordinator.runExclusive(repo1, async () => {
          res();
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
          return 'repo1-done';
        });
        const task2 = sharedGitRepoCoordinator.runExclusive(repo2, async () => {
          releaseFirst();
          return 'repo2-done';
        });
        void Promise.all([task1, task2]);
      });
      await firstEntered;

      // Trust .harnessmate/setup script and verify trust persists across git plugin disable -> re-enable
      fs.mkdirSync(path.join(repo1, '.harnessmate'), { recursive: true });
      fs.writeFileSync(path.join(repo1, '.harnessmate', 'setup.sh'), 'echo ok\n');
      const setupInfoBefore = (await daemon.app.inject(`/api/v1/workspaces/${ws1.id}/setup-script`)).json().setupScript;
      expect(setupInfoBefore.exists).toBe(true);
      const trustRes = await daemon.app.inject({
        method: 'PUT',
        url: `/api/v1/workspaces/${ws1.id}/setup-script/trust`,
        payload: { sha256: setupInfoBefore.sha256, trusted: true },
      });
      expect(trustRes.statusCode).toBe(200);
      expect(trustRes.json().setupScript.trusted).toBe(true);

      // Disable core.workspace-rules -> terminal, files & historical/new attachments STILL work
      expect((await daemon.app.inject({ method: 'PATCH', url: '/api/v1/plugins/core.workspace-rules', payload: { enabled: false } })).statusCode).toBe(200);
      expect((await daemon.app.inject(`/api/v1/sessions/${sessMain.id}/rules`)).statusCode).toBe(409);
      expect((await daemon.app.inject(`/api/v1/sessions/${sessMain.id}/files`)).statusCode).toBe(200);
      expect((await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessMain.id}/terminal`,
        payload: { command: 'node -e "console.log(456)"' },
      })).statusCode).toBe(200);

      // Disable core.git-inspector & core.attachments -> W2 DTO never throws, historical checkpoint & attachment remain readable, core chat still works!
      expect((await daemon.app.inject({ method: 'PATCH', url: '/api/v1/plugins/core.git-inspector', payload: { enabled: false } })).statusCode).toBe(200);
      expect((await daemon.app.inject({ method: 'PATCH', url: '/api/v1/plugins/core.attachments', payload: { enabled: false } })).statusCode).toBe(200);

      const disabledStatusDto = await daemon.app.inject(`/api/v1/workspaces/${ws1.id}/git/status`);
      expect(disabledStatusDto.statusCode).toBe(200);
      expect(disabledStatusDto.json()).toEqual({
        available: false,
        reason: 'disabled',
        instanceId: null,
        status: null,
      });

      const histCheckpointsRes = await daemon.app.inject(`/api/v1/sessions/${sessMain.id}/checkpoints`);
      expect(histCheckpointsRes.statusCode).toBe(200);
      expect(histCheckpointsRes.json().checkpoints.length).toBeGreaterThanOrEqual(1);

      const histAttachmentRes = await daemon.app.inject(savedAttachmentUrl);
      expect(histAttachmentRes.statusCode).toBe(200);
      expect(histAttachmentRes.body).toBe('kept after disable');

      // Core chat turn succeeds cleanly even when W1 plugins are disabled (non-git workspace too)
      const turnRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${nonGitSession.id}/turns`,
        payload: { text: 'chat continues safely' },
      });
      expect(turnRes.statusCode, turnRes.body).toBe(202);

      // Re-enabling core.git-inspector preserves historical .harnessmate/setup trust hash
      expect((await daemon.app.inject({ method: 'PATCH', url: '/api/v1/plugins/core.git-inspector', payload: { enabled: true } })).statusCode).toBe(200);
      const setupInfoAfter = (await daemon.app.inject(`/api/v1/workspaces/${ws1.id}/setup-script`)).json().setupScript;
      expect(setupInfoAfter.trusted).toBe(true);
      expect(setupInfoAfter.sha256).toBe(setupInfoBefore.sha256);
    },
    30_000,
  );

  it(
    'installs external W1 alternative plugins (workspace-tools-lite & terminal-lite), routes WS/routes/bindings to selected instance, reaps processes on disable, and restores composition',
    async () => {
      const root = createTempDir('hm-b2-w1-alt-');
      const repoDir = path.join(root, 'repo');
      const dataDir = path.join(root, 'data');
      await initGitWorkspace(repoDir);

      const daemon = createDaemon({
        dataDir,
        port: 0,
        hostOverride: '127.0.0.1',
        customAdapters: [createFakeAdapter()],
      });
      daemons.push(daemon);
      await daemon.start();

      const ws = await daemon.sessionManager.addWorkspace(repoDir, 'Alt Repo');
      const session = await daemon.sessionManager.createSession({
        workspaceId: ws.id,
        harnessId: 'fake-w1',
        permissionMode: 'manual',
      });

      const liteToolsDir = path.join(repoRoot, 'plugins/examples/hm.plugin.workspace-tools-lite');
      const liteTermDir = path.join(repoRoot, 'plugins/examples/hm.plugin.terminal-lite');

      const toolsAudit = auditPluginPackage(readPackageFiles(liteToolsDir));
      expect(toolsAudit.blockingIssues).toEqual([]);
      expect(toolsAudit.passed).toBe(true);
      const previewTools = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: liteToolsDir });
      await daemon.pluginManager.installPlugin({
        mode: 'local_dir',
        dirPath: liteToolsDir,
        trustCode: true,
        expectedDigest: previewTools.digest,
        expectedInstalledDigest: previewTools.installedDigest,
      });

      const termAudit = auditPluginPackage(readPackageFiles(liteTermDir));
      expect(termAudit.blockingIssues).toEqual([]);
      expect(termAudit.passed).toBe(true);
      const previewTerm = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: liteTermDir });
      await daemon.pluginManager.installPlugin({
        mode: 'local_dir',
        dirPath: liteTermDir,
        trustCode: true,
        expectedDigest: previewTerm.digest,
        expectedInstalledDigest: previewTerm.installedDigest,
      });

      for (const cap of [
        'fs:workspace:read',
        'workspace:git:read',
        'workspace:git:write',
        'process:spawn:git',
        'process:spawn:node',
        'storage:workspace',
      ]) {
        await daemon.app.inject({
          method: 'PUT',
          url: '/api/v1/plugins/user.workspace-tools-lite/permissions',
          payload: { workspaceId: ws.id, digest: previewTools.digest, capability: cap, granted: true },
        });
        await daemon.app.inject({
          method: 'PUT',
          url: '/api/v1/plugins/user.workspace-tools-lite/permissions',
          payload: { workspaceId: '__global__', digest: previewTools.digest, capability: cap, granted: true },
        });
      }
      await daemon.app.inject({
        method: 'PUT',
        url: '/api/v1/plugins/user.terminal-lite/permissions',
        payload: { workspaceId: ws.id, digest: previewTerm.digest, capability: 'process:spawn:node', granted: true },
      });

      // Bind workspace to alternative external instances
      for (const [contract, instId] of [
        [PEER_CONTRACTS.gitWorkspace, 'user.workspace-tools-lite'],
        [PEER_CONTRACTS.workspaceFiles, 'user.workspace-tools-lite'],
        [PEER_CONTRACTS.workspaceRules, 'user.workspace-tools-lite'],
        [PEER_CONTRACTS.terminalRunner, 'user.workspace-tools-lite'],
        [PEER_CONTRACTS.terminalWorkspace, 'user.terminal-lite'],
      ]) {
        const bindRes = await daemon.app.inject({
          method: 'PUT',
          url: `/api/v1/workspaces/${ws.id}/bindings`,
          payload: { contract, instanceId: instId },
        });
        expect(bindRes.statusCode).toBe(200);
      }

      // Routes check on host + isolated instances
      expect((await daemon.app.inject('/api/v1/plugin-instances/core.workspace-rules/routes/status')).json().instanceId).toBe(
        'core.workspace-rules',
      );
      const liteRouteStatus = await daemon.app.inject(
        '/api/v1/plugin-instances/user.workspace-tools-lite/routes/status',
      );
      expect(liteRouteStatus.statusCode).toBe(200);
      expect(liteRouteStatus.json().provider).toBe('user.workspace-tools-lite');

      // Compat HTTP API routes execute against selected external instances
      const gitRes = await daemon.app.inject(`/api/v1/sessions/${session.id}/git`);
      expect(gitRes.statusCode).toBe(200);
      expect(gitRes.json().instanceId).toBe('user.workspace-tools-lite');
      expect(gitRes.json().git.isGitRepo).toBe(true);

      const filesRes = await daemon.app.inject(`/api/v1/sessions/${session.id}/files`);
      expect(filesRes.statusCode).toBe(200);
      expect(filesRes.json().instanceId).toBe('user.workspace-tools-lite');

      const rulesRes = await daemon.app.inject(`/api/v1/sessions/${session.id}/rules`);
      expect(rulesRes.statusCode).toBe(200);
      expect(rulesRes.json().instanceId).toBe('user.workspace-tools-lite');
      expect(rulesRes.json().instructions.some((r: { relativePath: string }) => r.relativePath === 'AGENTS.md')).toBe(
        true,
      );

      // Isolated terminal open + input + WS output + pathUsage blocking
      const openLiteTerm = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${ws.id}/terminals`,
        payload: { cwd: repoDir, sessionId: session.id, title: 'Alt Shell' },
      });
      expect(openLiteTerm.statusCode).toBe(201);
      expect(openLiteTerm.json().instanceId).toBe('user.terminal-lite');
      const liteTermId = openLiteTerm.json().terminal.terminalId as string;

      const socket = await connectWs(daemon);
      const frames: Array<Record<string, unknown>> = [];
      socket.on('message', (data) => {
        try {
          frames.push(JSON.parse(data.toString('utf8')));
        } catch {
          // ignore
        }
      });
      socket.send(JSON.stringify({ op: 'subscribe_terminal', terminalId: liteTermId }));
      socket.send(JSON.stringify({ op: 'terminal_input', terminalId: liteTermId, data: 'hello-isolated\n' }));
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          if (
            frames.some(
              (f) => f.op === 'terminal_output' && String(f.chunk ?? '').includes('lite-echo:hello-isolated'),
            )
          ) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error(`Timed out waiting for isolated WS terminal output. Got: ${JSON.stringify(frames)}`));
          }
        }, 50);
      });
      socket.close();

      // Disabling user.terminal-lite tears down its active terminals and rejects input cleanly
      expect((await daemon.app.inject({
        method: 'PATCH',
        url: '/api/v1/plugins/user.terminal-lite',
        payload: { enabled: false },
      })).statusCode).toBe(200);
      expect((await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/terminals/${liteTermId}/input`,
        payload: { data: 'after-disable\n' },
      })).statusCode).toBe(409);

      // Switch to empty composition and restore builtin -> clean recovery
      const emptyRes = await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/plugins/composition/restore',
        payload: { source: 'empty' },
      });
      expect(emptyRes.statusCode).toBe(200);
      const restoreBuiltinRes = await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/plugins/composition/restore',
        payload: { source: 'builtin' },
      });
      expect(restoreBuiltinRes.statusCode).toBe(200);
      expect(
        (await daemon.app.inject(`/api/v1/plugins/services/resolve?contract=${PEER_CONTRACTS.gitWorkspace}`)).json().instanceId,
      ).toBe('git');
    },
    45_000,
  );
});
