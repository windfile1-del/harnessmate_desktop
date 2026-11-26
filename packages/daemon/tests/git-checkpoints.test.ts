import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointError, CheckpointService } from '../src/core/checkpoint-service.js';
import {
  createGitWorktree,
  discardFile,
  dryRunMerge,
  executeTrustedSetupScript,
  getFileDiff,
  GitOperationError,
  gitCommit,
  gitPush,
  initGitRepo,
  inspectSetupScript,
  listGitWorktrees,
  removeGitWorktree,
  setSetupScriptTrust,
  workspaceTruthDigest,
} from '../src/core/git-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initTempGitRepo(): string {
  const dir = createTempDir('hm-git-ckpt-');
  gitSync(dir, ['init', '-b', 'main']);
  gitSync(dir, ['config', 'core.autocrlf', 'false']);
  gitSync(dir, ['config', 'user.email', 'test@harnessmate.local']);
  gitSync(dir, ['config', 'user.name', 'HarnessMate Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\nline1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const version = 1;\n', 'utf8');
  gitSync(dir, ['add', '.']);
  gitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

function createTempStore(): HarnessMateStore {
  const dir = createTempDir('hm-ckpt-db-');
  return new HarnessMateStore(path.join(dir, 'test.sqlite'));
}

function seedSession(store: HarnessMateStore, sessionId: string, cwd: string): void {
  const wsId = `ws_${sessionId}`;
  store.createWorkspace({
    id: wsId,
    name: 'test-repo',
    rootPath: cwd,
    isGitRepo: true,
    gitBranch: 'main',
    createdAt: Date.now(),
  });
  store.createSession({
    id: sessionId,
    workspaceId: wsId,
    harnessId: 'claude',
    harnessKind: 'claude',
    title: 'Test Session',
    cwd,
    worktreeBranch: null,
    nativeSessionId: null,
    model: null,
    reasoningEffort: null,
    permissionMode: 'manual',
    status: 'idle',
    lastSeq: 0,
    pendingApprovalCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore transient Windows lock on cleanup
    }
  }
});

describe('Phase 2.2 · Hidden Git Ref Checkpoints & Zero-Pollution Guarantee', { timeout: 45_000 }, () => {
  it('captures multiple checkpoints across staged, unstaged, and untracked changes without polluting git status or git log --all', async () => {
    const repo = initTempGitRepo();
    const store = createTempStore();
    const svc = new CheckpointService(store);
    const sessionId = 'sess_zero_pollution';
    seedSession(store, sessionId, repo);

    // Prepare mixed dirty workspace: staged + unstaged + untracked
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 2;\n', 'utf8');
    gitSync(repo, ['add', 'app.ts']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\nline1\nunstaged edit\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked content\n', 'utf8');

    const statusBefore = gitSync(repo, ['status', '--porcelain']);
    const logBefore = gitSync(repo, ['log', '--all', '--oneline']);

    const pre1 = await svc.capture({ sessionId, cwd: repo, turnSeq: 1, phase: 'turn_pre' });
    expect(pre1).not.toBeNull();
    expect(pre1!.gitRef).toContain(`refs/harnessmate/checkpoints/${sessionId}/`);

    // Simulate AI turn modifying existing file + creating a new file
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 3;\nexport const ok = true;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'feature.ts'), 'export const feat = "hello";\n', 'utf8');

    const post1 = await svc.capture({
      sessionId,
      cwd: repo,
      turnSeq: 1,
      phase: 'turn_post',
      skipIfUnchangedFromTreeSha: pre1!.treeSha,
      compareAgainstTreeSha: pre1!.treeSha,
    });
    expect(post1).not.toBeNull();
    expect(post1!.filesChanged).toBe(2);
    expect(post1!.insertions).toBeGreaterThanOrEqual(2);

    // Capturing again with no changes returns null when skipIfUnchangedFromTreeSha matches
    const noop = await svc.capture({
      sessionId,
      cwd: repo,
      turnSeq: 2,
      phase: 'turn_post',
      skipIfUnchangedFromTreeSha: post1!.treeSha,
    });
    expect(noop).toBeNull();

    // Verify ZERO pollution on git log --all (tree refs never appear in git log --all)
    const logAfter = gitSync(repo, ['log', '--all', '--oneline']);
    expect(logAfter).toBe(logBefore);

    // Verify primary .git/index was NEVER mutated by comparing staged status of app.ts
    const stagedFiles = gitSync(repo, ['diff', '--cached', '--name-only']);
    expect(stagedFiles).toBe('app.ts');
    expect(statusBefore).toContain('M  app.ts');

    // Verify precise checkpoint-to-checkpoint diff
    const diffRes = await svc.diff({
      sessionId,
      cwd: repo,
      fromCheckpointId: pre1!.checkpointId,
      toCheckpointId: post1!.checkpointId,
    });
    expect(diffRes.filesChanged).toBe(2);
    expect(diffRes.diff).toContain('export const feat = "hello";');
    expect(diffRes.files.map((f) => f.path).sort()).toEqual(['app.ts', 'feature.ts']);

    // Verify manual GC deletes refs and SQLite rows
    const gcRes = await svc.gcCheckpoints({ sessionId, cwd: repo, keepLast: 1 });
    expect(gcRes.deletedCount).toBe(1);
    expect(svc.list(sessionId)).toHaveLength(1);
    store.close();
  });

  it('skips oversized untracked files and records them in skippedLargeFiles while gracefully skipping non-Git directories', async () => {
    const nonGit = createTempDir('hm-non-git-');
    const store = createTempStore();
    const svc = new CheckpointService(store, {
      maxSingleFileBytes: 1024, // 1 KB test threshold
      maxTotalUntrackedBytes: 4096,
    });

    // Non-git gracefully returns null without throwing
    expect(await svc.capture({ sessionId: 's_ng', cwd: nonGit, turnSeq: 1, phase: 'turn_pre' })).toBeNull();

    // Oversized untracked file is skipped and recorded
    const repo = initTempGitRepo();
    seedSession(store, 's_big', repo);
    fs.writeFileSync(path.join(repo, 'huge.bin'), Buffer.alloc(2048, 0x41));
    fs.writeFileSync(path.join(repo, 'small.txt'), 'ok\n', 'utf8');

    const ckpt = await svc.capture({ sessionId: 's_big', cwd: repo, turnSeq: 1, phase: 'turn_pre' });
    expect(ckpt).not.toBeNull();
    expect(ckpt!.skippedLargeFiles).toEqual(['huge.bin']);
    store.close();
  });
});

describe('Phase 2.2 · Atomic Revert Guard (Conversation First, Files Second) & Undo Revert', { timeout: 45_000 }, () => {
  it('saves pre_revert backup, restores target files & removes post-target untracked files, and supports byte-for-byte Undo Revert', async () => {
    const repo = initTempGitRepo();
    const store = createTempStore();
    const svc = new CheckpointService(store);
    const sessionId = 'sess_undo_revert';
    seedSession(store, sessionId, repo);

    const pre = await svc.capture({ sessionId, cwd: repo, turnSeq: 10, phase: 'turn_pre' });
    expect(pre).not.toBeNull();

    // Mutate tracked file + add new file in nested dir
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 999;\n// binary-exact\n', 'utf8');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'added.ts'), 'export const added = 42;\n', 'utf8');

    const snapshotBeforeRevert = {
      app: fs.readFileSync(path.join(repo, 'app.ts')),
      added: fs.readFileSync(path.join(repo, 'src', 'added.ts')),
    };

    const revertRes = await svc.revert({
      sessionId,
      cwd: repo,
      targetTurnSeq: 10,
      mode: 'files_only',
      hooks: { supportsNativeRollback: false },
    });

    expect(revertRes.modeUsed).toBe('files_only');
    expect(revertRes.nativeRolledBack).toBe(false);
    expect(revertRes.untrackedRemoved).toBe(1);
    expect(revertRes.preRevertCheckpointId).toBeTruthy();

    // Target files restored & post-target file cleaned
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');
    expect(fs.existsSync(path.join(repo, 'src', 'added.ts'))).toBe(false);

    // Undo Revert targeting preRevertCheckpointId -> byte-for-byte restoration!
    await svc.revert({
      sessionId,
      cwd: repo,
      checkpointId: revertRes.preRevertCheckpointId,
      mode: 'files_only',
      hooks: { supportsNativeRollback: false },
    });

    expect(fs.readFileSync(path.join(repo, 'app.ts')).equals(snapshotBeforeRevert.app)).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'src', 'added.ts')).equals(snapshotBeforeRevert.added)).toBe(true);
    store.close();
  });

  it('enforces conversation-first order: aborts without touching disk when native rollback fails, and forbids silent fake rollback on non-native drivers', async () => {
    const repo = initTempGitRepo();
    const store = createTempStore();
    const svc = new CheckpointService(store);
    const sessionId = 'sess_guard';
    seedSession(store, sessionId, repo);

    const pre = await svc.capture({ sessionId, cwd: repo, turnSeq: 5, phase: 'turn_pre' });
    expect(pre).not.toBeNull();
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 2;\n', 'utf8');

    // 1. Non-native driver attempting native_and_files MUST be rejected
    await expect(
      svc.revert({
        sessionId,
        cwd: repo,
        targetTurnSeq: 5,
        mode: 'native_and_files',
        hooks: { supportsNativeRollback: false },
      }),
    ).rejects.toMatchObject({ code: 'E_NATIVE_ROLLBACK_UNSUPPORTED' });
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const version = 2;\n');

    // 2. Native driver where performNativeRollback throws MUST abort before touching disk
    await expect(
      svc.revert({
        sessionId,
        cwd: repo,
        targetTurnSeq: 5,
        mode: 'native_and_files',
        hooks: {
          supportsNativeRollback: true,
          performNativeRollback: async () => {
            throw new CheckpointError('E_NATIVE_ROLLBACK_FAILED', 'RPC timeout');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'E_NATIVE_ROLLBACK_FAILED' });
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const version = 2;\n');

    // 3. Native driver succeeding: verify native rollback runs BEFORE file is reverted
    const order: string[] = [];
    const okRes = await svc.revert({
      sessionId,
      cwd: repo,
      targetTurnSeq: 5,
      mode: 'native_and_files',
      hooks: {
        supportsNativeRollback: true,
        turnsToRollback: 2,
        performNativeRollback: async (n) => {
          order.push(`native:${n}:disk=${fs.readFileSync(path.join(repo, 'app.ts'), 'utf8').trim()}`);
        },
        onReverted: () => {
          order.push(`after:disk=${fs.readFileSync(path.join(repo, 'app.ts'), 'utf8').trim()}`);
        },
      },
    });
    expect(okRes.nativeRolledBack).toBe(true);
    expect(order).toEqual([
      'native:2:disk=export const version = 2;',
      'after:disk=export const version = 1;',
    ]);

    // 4. fork_new_branch resets native binding before restoring files
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 77;\n', 'utf8');
    let bindingReset = false;
    const forkRes = await svc.revert({
      sessionId,
      cwd: repo,
      targetTurnSeq: 5,
      mode: 'fork_new_branch',
      hooks: {
        supportsNativeRollback: false,
        resetNativeBinding: async () => {
          bindingReset = true;
          expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const version = 77;\n');
        },
      },
    });
    expect(bindingReset).toBe(true);
    expect(forkRes.newNativeBindingReset).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');

    // 5. Corrupted/pruned tree object returns E_CHECKPOINT_MISSING without touching disk
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 88;\n', 'utf8');
    store.createCheckpointRecord({
      checkpointId: 'ckpt_corrupt',
      sessionId,
      turnSeq: 99,
      phase: 'turn_pre',
      gitRef: 'refs/harnessmate/checkpoints/sess_guard/ckpt_corrupt',
      treeSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      baseHeadSha: null,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      skippedLargeFiles: [],
      createdAt: Date.now(),
    });
    await expect(
      svc.revert({
        sessionId,
        cwd: repo,
        checkpointId: 'ckpt_corrupt',
        mode: 'files_only',
        hooks: { supportsNativeRollback: false },
      }),
    ).rejects.toMatchObject({ code: 'E_CHECKPOINT_MISSING' });
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const version = 88;\n');

    store.close();
  });
});

describe('Phase 2.2 · Git Diff On-Demand, Worktree Lifecycle, Dry-Run Merge & Setup Script Trust', { timeout: 45_000 }, () => {
  it('supports per-file diff, discardFile, initGitRepo, workspaceTruthDigest, and commit without force push', async () => {
    const freshDir = createTempDir('hm-init-git-');
    const initRes = await initGitRepo(freshDir);
    expect(initRes.ok).toBe(true);
    expect(fs.existsSync(path.join(freshDir, '.git'))).toBe(true);

    const repo = initTempGitRepo();
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 2;\nexport const extra = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'new.ts'), 'export const n = 1;\n', 'utf8');

    const diffTracked = await getFileDiff(repo, 'app.ts', false);
    expect(diffTracked.totalBytes).toBeGreaterThan(0);
    expect(diffTracked.binary).toBe(false);
    expect(diffTracked.diff).toContain('export const extra = 1;');

    const diffUntracked = await getFileDiff(repo, 'new.ts', false);
    expect(diffUntracked.diff).toContain('export const n = 1;');

    const t0 = Date.now();
    const digest = await workspaceTruthDigest(repo);
    expect(digest.isGitRepo).toBe(true);
    expect(digest.branch).toBe('main');
    expect(digest.headSha).toBeTruthy();
    expect(digest.dirtyFiles.length).toBe(2);
    expect(Date.now() - t0).toBeLessThan(2000);

    // Discard untracked and modified files
    await discardFile(repo, 'new.ts');
    expect(fs.existsSync(path.join(repo, 'new.ts'))).toBe(false);
    await discardFile(repo, 'app.ts');
    expect(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8')).toBe('export const version = 1;\n');

    // Commit test
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = 3;\n', 'utf8');
    const commitRes = await gitCommit(repo, { message: 'bump version', stageAll: true });
    expect(commitRes.ok).toBe(true);
    expect(gitSync(repo, ['log', '-1', '--pretty=%s'])).toBe('bump version');

    // Push without remote fails cleanly (and never uses --force)
    await expect(gitPush(repo, {})).rejects.toBeInstanceOf(GitOperationError);
  });

  it('creates, lists, dry-run merges (clean & conflicted), and safely removes worktrees', async () => {
    const repo = initTempGitRepo();
    const wtClean = await createGitWorktree(repo, 'feat/clean', { baseBranch: 'main' });
    const wtConflict = await createGitWorktree(repo, 'feat/conflict', { baseBranch: 'main' });

    const listed = await listGitWorktrees(repo, [{ sessionId: 's1', cwd: wtClean.worktreePath }]);
    expect(listed.length).toBeGreaterThanOrEqual(3);
    const cleanEntry = listed.find((w) => w.branch === 'feat/clean');
    expect(cleanEntry?.linkedSessionIds).toEqual(['s1']);

    // Commit non-conflicting change on feat/clean
    fs.writeFileSync(path.join(wtClean.worktreePath, 'clean.ts'), 'export const clean = true;\n', 'utf8');
    gitSync(wtClean.worktreePath, ['add', '.']);
    gitSync(wtClean.worktreePath, ['commit', '-m', 'add clean.ts']);

    // Commit conflicting changes on main AND feat/conflict to app.ts
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const version = "main-edit";\n', 'utf8');
    gitSync(repo, ['add', 'app.ts']);
    gitSync(repo, ['commit', '-m', 'main edit']);

    fs.writeFileSync(path.join(wtConflict.worktreePath, 'app.ts'), 'export const version = "branch-edit";\n', 'utf8');
    gitSync(wtConflict.worktreePath, ['add', 'app.ts']);
    gitSync(wtConflict.worktreePath, ['commit', '-m', 'conflict edit']);

    // Dry-run merge: clean branch
    const cleanMerge = await dryRunMerge(repo, 'main', 'feat/clean');
    if (cleanMerge.supported) {
      expect(cleanMerge.hasConflicts).toBe(false);
      expect(cleanMerge.conflictFiles).toEqual([]);
      expect(cleanMerge.treeSha).toBeTruthy();
    }

    // Dry-run merge: conflicting branch
    const conflictMerge = await dryRunMerge(repo, 'main', 'feat/conflict');
    if (conflictMerge.supported) {
      expect(conflictMerge.hasConflicts).toBe(true);
      expect(conflictMerge.conflictFiles).toContain('app.ts');
    }

    // Verify dryRunMerge left working tree untouched
    expect(gitSync(repo, ['status', '--porcelain'])).toBe('');

    // Safe remove both worktrees
    const rm1 = await removeGitWorktree(repo, wtClean.worktreePath);
    const rm2 = await removeGitWorktree(repo, wtConflict.worktreePath);
    expect(rm1.ok).toBe(true);
    expect(rm2.ok).toBe(true);
    const afterList = await listGitWorktrees(repo);
    expect(afterList.some((w) => w.branch === 'feat/clean')).toBe(false);
    expect(afterList.some((w) => w.branch === 'feat/conflict')).toBe(false);
  });

  it('enforces strict SHA-256 trust boundary on .harnessmate/setup scripts (0% untrusted execution, invalidates on tamper)', async () => {
    const repo = initTempGitRepo();
    const store = createTempStore();
    const hmDir = path.join(repo, '.harnessmate');
    fs.mkdirSync(hmDir, { recursive: true });
    const scriptName = process.platform === 'win32' ? 'setup.ps1' : 'setup.sh';
    const scriptPath = path.join(hmDir, scriptName);
    const markerFile = path.join(repo, 'setup-ran.txt');
    const contentV1 =
      process.platform === 'win32'
        ? `Set-Content -Path "${markerFile}" -Value "v1"\n`
        : `#!/usr/bin/env sh\necho "v1" > "${markerFile}"\n`;
    fs.writeFileSync(scriptPath, contentV1, 'utf8');

    // 1. Initially untrusted -> execution MUST be blocked with E_SETUP_SCRIPT_UNTRUSTED
    const info1 = inspectSetupScript(repo, store);
    expect(info1.exists).toBe(true);
    expect(info1.trusted).toBe(false);
    expect(info1.sha256).toHaveLength(64);

    await expect(executeTrustedSetupScript(repo, repo, store)).rejects.toMatchObject({
      code: 'E_SETUP_SCRIPT_UNTRUSTED',
    });
    expect(fs.existsSync(markerFile)).toBe(false);

    // 2. Explicitly trust exact SHA-256 -> execution succeeds
    const trustedInfo = setSetupScriptTrust(repo, store, info1.sha256!, true);
    expect(trustedInfo.trusted).toBe(true);

    const execRes = await executeTrustedSetupScript(repo, repo, store);
    expect(execRes.ok).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(true);

    // 3. Tamper with script content -> SHA-256 changes -> trust automatically invalidated -> execution blocked again!
    fs.writeFileSync(scriptPath, `${contentV1}# tampered\n`, 'utf8');
    const infoTampered = inspectSetupScript(repo, store);
    expect(infoTampered.trusted).toBe(false);
    expect(infoTampered.sha256).not.toBe(info1.sha256);

    await expect(executeTrustedSetupScript(repo, repo, store)).rejects.toMatchObject({
      code: 'E_SETUP_SCRIPT_UNTRUSTED',
    });

    store.close();
  });
});
