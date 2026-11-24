import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CheckpointRevertMode,
  CheckpointRevertResult,
  SessionCheckpointRecord,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { inspectGitRepo, runGitFull } from './git-service.js';

export const CHECKPOINT_REF_PREFIX = 'refs/harnessmate/checkpoints';
export const DEFAULT_MAX_SINGLE_UNTRACKED_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_TOTAL_UNTRACKED_BYTES = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_CAPTURE_TIMEOUT_MS = 4_000;
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class CheckpointError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}

export interface CheckpointServiceOptions {
  maxSingleFileBytes?: number;
  maxTotalUntrackedBytes?: number;
  captureTimeoutMs?: number;
}

export interface CheckpointDiffResult {
  fromCheckpointId: string | null;
  toCheckpointId: string | null;
  fromTreeSha: string;
  toTreeSha: string;
  diff: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
  }>;
}

export interface CheckpointRevertHooks {
  /** Whether the session's active harness driver declares `supportsNativeRollback: true`. */
  supportsNativeRollback: boolean;
  /** Number of recent turns to roll back natively when `mode === 'native_and_files'`. */
  turnsToRollback?: number;
  /** Invoked BEFORE modifying any files when `mode === 'native_and_files'`. If this throws, revert aborts cleanly. */
  performNativeRollback?: (numTurns: number) => Promise<void>;
  /** Invoked BEFORE modifying any files when `mode === 'fork_new_branch'` to clear/reset native session binding. */
  resetNativeBinding?: () => Promise<void>;
  /** Optional post-revert hook to publish `checkpoint.reverted` and refresh ledger/UI. */
  onReverted?: (result: CheckpointRevertResult, target: SessionCheckpointRecord) => Promise<void> | void;
}

function runGitWithStdin(
  cwd: string,
  args: string[],
  stdinData: Buffer,
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve({ ok: false, stdout: '', stderr: `git ${args[0]} timed out after ${opts?.timeoutMs}ms` });
    }, opts?.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });

    child.stdin.on('error', () => {
      // ignore EPIPE if git exits early
    });
    child.stdin.end(stdinData);
  });
}

function sanitizeRefSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
}

function parseNullTerminatedPaths(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean);
}

function parseNumstat(raw: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
  byPath: Map<string, { additions: number; deletions: number }>;
} {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const byPath = new Map<string, { additions: number; deletions: number }>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    filesChanged += 1;
    const add = m[1] === '-' ? 0 : Number(m[1]) || 0;
    const del = m[2] === '-' ? 0 : Number(m[2]) || 0;
    insertions += add;
    deletions += del;
    byPath.set(m[3]!.trim(), { additions: add, deletions: del });
  }
  return { filesChanged, insertions, deletions, byPath };
}

function makeTempIndexPath(): string {
  return path.join(os.tmpdir(), `hm-ckpt-idx-${crypto.randomUUID()}`);
}

function cleanupTempIndex(indexPath: string): void {
  try {
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    if (fs.existsSync(`${indexPath}.lock`)) fs.unlinkSync(`${indexPath}.lock`);
  } catch {
    // best-effort cleanup
  }
}

function pruneEmptyParentDirs(rootDir: string, filePath: string): void {
  const normalizedRoot = path.resolve(rootDir);
  let dir = path.dirname(path.resolve(filePath));
  while (dir.length > normalizedRoot.length && dir.startsWith(normalizedRoot)) {
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length > 0) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}

function hasDotGitAncestor(cwd: string): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
    } catch {
      return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Zero-pollution Hidden Git Ref Checkpoint Engine (`hm.plugin.git-checkpoints`).
 *
 * Uses an isolated temporary `GIT_INDEX_FILE` and stores tree snapshots under
 * `refs/harnessmate/checkpoints/<sessionId>/<checkpointId>` (tree refs), so:
 * - User `.git/index` (staging area) is NEVER touched or locked;
 * - User `HEAD` and `git log --all --oneline` stay 100% clean;
 * - Objects remain rooted against `git gc` until explicitly pruned by `gcCheckpoints`.
 */
export class CheckpointService {
  private readonly maxSingleFileBytes: number;
  private readonly maxTotalUntrackedBytes: number;
  private readonly captureTimeoutMs: number;

  constructor(
    private readonly store: HarnessMateStore,
    opts?: CheckpointServiceOptions,
  ) {
    this.maxSingleFileBytes = opts?.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_UNTRACKED_BYTES;
    this.maxTotalUntrackedBytes = opts?.maxTotalUntrackedBytes ?? DEFAULT_MAX_TOTAL_UNTRACKED_BYTES;
    this.captureTimeoutMs = opts?.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  }

  /**
   * Captures a hidden Git Ref tree snapshot of the working tree into
   * `refs/harnessmate/checkpoints/<sessionId>/<checkpointId>` without mutating
   * `.git/index`, `HEAD`, or `git log`.
   *
   * Returns `null` gracefully if `cwd` is not a Git repository, or when `skipIfUnchangedFromTreeSha`
   * matches the newly captured tree SHA.
   */
  async capture(params: {
    sessionId: string;
    cwd: string;
    turnSeq: number;
    phase: SessionCheckpointRecord['phase'];
    skipIfUnchangedFromTreeSha?: string | null;
    compareAgainstTreeSha?: string | null;
  }): Promise<SessionCheckpointRecord | null> {
    if (!hasDotGitAncestor(params.cwd)) return null;
    const repo = await inspectGitRepo(params.cwd);
    if (!repo.isGitRepo) return null;

    const startedAt = Date.now();
    const remainingBudget = () => Math.max(500, this.captureTimeoutMs - (Date.now() - startedAt));
    const tempIndex = makeTempIndexPath();

    try {
      const headRes = await runGitFull(params.cwd, ['rev-parse', '--verify', 'HEAD'], {
        timeoutMs: remainingBudget(),
      });
      const baseHeadSha = headRes.ok ? headRes.stdout.trim() : null;

      // Read-only enumeration of tracked files (including newly staged files in user index)
      // and untracked non-ignored files (.gitignore honored via --exclude-standard).
      const [trackedRes, untrackedRes] = await Promise.all([
        runGitFull(params.cwd, ['ls-files', '-z'], { timeoutMs: remainingBudget() }),
        runGitFull(params.cwd, ['ls-files', '--others', '--exclude-standard', '-z'], {
          timeoutMs: remainingBudget(),
        }),
      ]);
      if (!trackedRes.ok || !untrackedRes.ok) {
        return null;
      }

      const trackedPaths = parseNullTerminatedPaths(trackedRes.stdout);
      const untrackedPaths = parseNullTerminatedPaths(untrackedRes.stdout);

      const skippedLargeFiles: string[] = [];
      const filesToSnapshot: string[] = [];
      const seen = new Set<string>();

      for (const rel of trackedPaths) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs = path.join(params.cwd, rel);
        try {
          const stat = fs.lstatSync(abs);
          if (stat.isFile() || stat.isSymbolicLink()) {
            filesToSnapshot.push(rel);
          }
        } catch {
          // Deleted in working tree -> omitted from snapshot tree
        }
      }

      let totalUntrackedBytes = 0;
      for (const rel of untrackedPaths) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs = path.join(params.cwd, rel);
        try {
          const stat = fs.lstatSync(abs);
          if (!stat.isFile() && !stat.isSymbolicLink()) continue;
          const size = stat.isFile() ? stat.size : 0;
          if (size > this.maxSingleFileBytes || totalUntrackedBytes + size > this.maxTotalUntrackedBytes) {
            skippedLargeFiles.push(rel);
            continue;
          }
          totalUntrackedBytes += size;
          filesToSnapshot.push(rel);
        } catch {
          // ignore transient vanished file
        }
      }

      let treeSha = EMPTY_TREE_SHA;
      if (filesToSnapshot.length > 0) {
        // Populate isolated temporary index strictly via GIT_INDEX_FILE (zero touch on .git/index)
        const payload = Buffer.from(`${filesToSnapshot.join('\0')}\0`, 'utf8');
        const updateRes = await runGitWithStdin(
          params.cwd,
          ['update-index', '--add', '--replace', '-z', '--stdin'],
          payload,
          { timeoutMs: remainingBudget(), env: { GIT_INDEX_FILE: tempIndex } },
        );
        if (!updateRes.ok) {
          return null;
        }
        const writeTreeRes = await runGitFull(params.cwd, ['write-tree'], {
          timeoutMs: remainingBudget(),
          env: { GIT_INDEX_FILE: tempIndex },
        });
        if (!writeTreeRes.ok) {
          return null;
        }
        treeSha = writeTreeRes.stdout.trim();
      }

      if (params.skipIfUnchangedFromTreeSha && treeSha === params.skipIfUnchangedFromTreeSha) {
        return null;
      }

      // Compute diff stats against baseline tree (turn_pre or HEAD)
      const baselineTree = params.compareAgainstTreeSha ?? baseHeadSha ?? EMPTY_TREE_SHA;
      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;
      if (baselineTree && baselineTree !== treeSha) {
        const statRes = await runGitFull(
          params.cwd,
          ['diff', '--numstat', baselineTree, treeSha],
          { timeoutMs: remainingBudget() },
        );
        if (statRes.ok) {
          const parsed = parseNumstat(statRes.stdout);
          filesChanged = parsed.filesChanged;
          insertions = parsed.insertions;
          deletions = parsed.deletions;
        }
      }

      const checkpointId = `ckpt_${params.phase}_${params.turnSeq}_${crypto.randomBytes(4).toString('hex')}`;
      const gitRef = `${CHECKPOINT_REF_PREFIX}/${sanitizeRefSegment(params.sessionId)}/${sanitizeRefSegment(checkpointId)}`;

      // Point hidden ref directly to the tree object: roots tree + blobs against git gc while keeping `git log --all` 100% clean!
      const refRes = await runGitFull(params.cwd, ['update-ref', gitRef, treeSha], {
        timeoutMs: remainingBudget(),
      });
      if (!refRes.ok) {
        return null;
      }

      const record: SessionCheckpointRecord = {
        checkpointId,
        sessionId: params.sessionId,
        turnSeq: params.turnSeq,
        phase: params.phase,
        gitRef,
        treeSha,
        baseHeadSha,
        filesChanged,
        insertions,
        deletions,
        skippedLargeFiles,
        createdAt: Date.now(),
      };
      this.store.createCheckpointRecord(record);
      return record;
    } finally {
      cleanupTempIndex(tempIndex);
    }
  }

  list(sessionId: string, limit = 100): SessionCheckpointRecord[] {
    return this.store.listCheckpointRecords(sessionId, limit);
  }

  get(checkpointId: string): SessionCheckpointRecord | null {
    return this.store.getCheckpointRecord(checkpointId);
  }

  /**
   * Verifies that a checkpoint's Git tree object is still alive (not pruned by external `git gc`).
   */
  async verifyTreeAlive(cwd: string, treeSha: string): Promise<boolean> {
    if (treeSha === EMPTY_TREE_SHA) return true;
    const res = await runGitFull(cwd, ['cat-file', '-t', treeSha], { timeoutMs: 3000 });
    return res.ok && res.stdout.trim() === 'tree';
  }

  /**
   * Computes a precise Git diff between any two checkpoints (by ID or turnSeq)
   * or between a checkpoint and the current working tree.
   */
  async diff(params: {
    sessionId: string;
    cwd: string;
    fromCheckpointId?: string;
    toCheckpointId?: string;
    fromSeq?: number;
    toSeq?: number;
  }): Promise<CheckpointDiffResult> {
    const records = this.list(params.sessionId, 500);

    const pickBySeq = (seq: number, preferPost: boolean): SessionCheckpointRecord | undefined => {
      const matching = records.filter((r) => r.turnSeq === seq);
      if (matching.length === 0) return undefined;
      if (preferPost) {
        return matching.find((r) => r.phase === 'turn_post') ?? matching[0];
      }
      return matching.find((r) => r.phase === 'turn_pre') ?? matching[0];
    };

    const fromRec = params.fromCheckpointId
      ? this.get(params.fromCheckpointId) ?? undefined
      : params.fromSeq !== undefined
        ? pickBySeq(params.fromSeq, false)
        : records[records.length - 1];

    const toRec = params.toCheckpointId
      ? this.get(params.toCheckpointId) ?? undefined
      : params.toSeq !== undefined
        ? pickBySeq(params.toSeq, true)
        : undefined;

    if (!fromRec) {
      throw new CheckpointError('E_CHECKPOINT_NOT_FOUND', '未找到对比起始检查点');
    }
    if (!(await this.verifyTreeAlive(params.cwd, fromRec.treeSha))) {
      throw new CheckpointError(
        'E_CHECKPOINT_MISSING',
        `检查点对象已丢失 (${fromRec.treeSha.slice(0, 10)})，可能已被外部 git gc 回收`,
      );
    }

    let toTreeSha: string;
    if (toRec) {
      if (!(await this.verifyTreeAlive(params.cwd, toRec.treeSha))) {
        throw new CheckpointError(
          'E_CHECKPOINT_MISSING',
          `目标检查点对象已丢失 (${toRec.treeSha.slice(0, 10)})，可能已被外部 git gc 回收`,
        );
      }
      toTreeSha = toRec.treeSha;
    } else {
      // Snapshot current working tree ephemerally (without persisting a ref) to diff against fromRec
      toTreeSha = await this.buildEphemeralTree(params.cwd);
    }

    const [diffRes, numstatRes, nameStatusRes] = await Promise.all([
      runGitFull(params.cwd, ['diff', '--no-color', fromRec.treeSha, toTreeSha], {
        timeoutMs: 8000,
      }),
      runGitFull(params.cwd, ['diff', '--numstat', fromRec.treeSha, toTreeSha], {
        timeoutMs: 8000,
      }),
      runGitFull(params.cwd, ['diff', '--name-status', fromRec.treeSha, toTreeSha], {
        timeoutMs: 8000,
      }),
    ]);

    const parsedStats = parseNumstat(numstatRes.stdout);
    const files: CheckpointDiffResult['files'] = [];
    for (const line of nameStatusRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const code = parts[0]?.[0] ?? 'M';
      const filePath = (parts[2] ?? parts[1] ?? '').trim();
      if (!filePath) continue;
      const stat = parsedStats.byPath.get(filePath);
      files.push({
        path: filePath,
        status:
          code === 'A'
            ? 'added'
            : code === 'D'
              ? 'deleted'
              : code === 'R'
                ? 'renamed'
                : 'modified',
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      });
    }

    return {
      fromCheckpointId: fromRec.checkpointId,
      toCheckpointId: toRec?.checkpointId ?? null,
      fromTreeSha: fromRec.treeSha,
      toTreeSha,
      diff: diffRes.stdout,
      filesChanged: parsedStats.filesChanged,
      insertions: parsedStats.insertions,
      deletions: parsedStats.deletions,
      files,
    };
  }

  /**
   * Atomic "Conversation Rollback First, File Restore Second" Revert Guard.
   *
   * Execution order:
   * 1. Verify target checkpoint exists & Git tree object is alive (`git cat-file -t <treeSha>`).
   *    Throws `E_CHECKPOINT_MISSING` without touching disk if missing.
   * 2. Enforce `supportsNativeRollback` honesty guard:
   *    - `native_and_files`: requires `supportsNativeRollback === true` and invokes `performNativeRollback()` FIRST;
   *      if native rollback fails, aborts immediately without modifying disk files.
   *    - `files_only`: never silently fakes conversation rollback; restores files only.
   *    - `fork_new_branch`: resets/clears native session binding via `resetNativeBinding()` so subsequent turns start cleanly.
   * 3. Capture a mandatory `pre_revert` protective checkpoint BEFORE modifying any file (enabling byte-for-byte Undo Revert).
   * 4. Restore files from target tree via isolated temporary `GIT_INDEX_FILE` and remove newly added post-target files.
   * 5. Invoke `onReverted` hook to emit `checkpoint.reverted` and refresh Task Ledger / UI.
   */
  async revert(params: {
    sessionId: string;
    cwd: string;
    targetTurnSeq?: number;
    checkpointId?: string;
    mode: CheckpointRevertMode;
    hooks: CheckpointRevertHooks;
  }): Promise<CheckpointRevertResult> {
    const records = this.list(params.sessionId, 500);
    let target: SessionCheckpointRecord | null = null;
    if (params.checkpointId) {
      target = this.get(params.checkpointId);
      if (target && target.sessionId !== params.sessionId) target = null;
    } else if (params.targetTurnSeq !== undefined) {
      const matching = records.filter((r) => r.turnSeq === params.targetTurnSeq);
      // Reverting to a turn restores the state BEFORE that turn ran (`turn_pre`), falling back to any record for that seq
      target =
        matching.find((r) => r.phase === 'turn_pre') ??
        matching.find((r) => r.phase === 'pre_revert') ??
        matching[0] ??
        null;
    }

    if (!target) {
      throw new CheckpointError('E_CHECKPOINT_NOT_FOUND', '未找到目标检查点记录');
    }

    // Step 1: Verify Git object health BEFORE touching anything
    const alive = await this.verifyTreeAlive(params.cwd, target.treeSha);
    if (!alive) {
      throw new CheckpointError(
        'E_CHECKPOINT_MISSING',
        `检查点 Git 对象已丢失 (${target.treeSha.slice(0, 10)})，无法安全回滚（可能已被外部 git gc 清理），未修改任何工作区文件。`,
      );
    }

    // Step 2: Conversation Rollback First Guard (strictly before any disk write)
    let nativeRolledBack = false;
    let newNativeBindingReset = false;

    if (params.mode === 'native_and_files') {
      if (!params.hooks.supportsNativeRollback) {
        throw new CheckpointError(
          'E_NATIVE_ROLLBACK_UNSUPPORTED',
          '当前 Harness 驱动不支持原生对话回滚，严禁静默伪造。请明确选择“仅还原文件 (files_only)”或“还原文件并开启新原生分支 (fork_new_branch)”。',
        );
      }
      if (!params.hooks.performNativeRollback) {
        throw new CheckpointError(
          'E_NATIVE_ROLLBACK_FAILED',
          '当前会话未绑定可回滚的原生对话句柄',
        );
      }
      // If this throws, we abort BEFORE modifying any files on disk
      await params.hooks.performNativeRollback(Math.max(1, params.hooks.turnsToRollback ?? 1));
      nativeRolledBack = true;
    } else if (params.mode === 'fork_new_branch') {
      if (params.hooks.resetNativeBinding) {
        await params.hooks.resetNativeBinding();
        newNativeBindingReset = true;
      }
    }

    // Step 3: Mandatory `pre_revert` protective checkpoint for byte-for-byte Undo Revert
    const preRevert = await this.capture({
      sessionId: params.sessionId,
      cwd: params.cwd,
      turnSeq: target.turnSeq,
      phase: 'pre_revert',
      compareAgainstTreeSha: target.treeSha,
    });
    if (!preRevert) {
      throw new CheckpointError('E_PRE_REVERT_FAILED', '无法在回滚前保存 pre_revert 保护性快照，已中止回滚');
    }

    // Step 4: Restore working tree from target.treeSha using isolated temp GIT_INDEX_FILE
    const { filesRestored, untrackedRemoved } = await this.restoreTreeToWorkingDir(
      params.cwd,
      target.treeSha,
      new Set([...(preRevert.skippedLargeFiles ?? []), ...(target.skippedLargeFiles ?? [])]),
    );

    const result: CheckpointRevertResult = {
      revertedToCheckpointId: target.checkpointId,
      targetTurnSeq: target.turnSeq,
      preRevertCheckpointId: preRevert.checkpointId,
      modeUsed: params.mode,
      nativeRolledBack,
      newNativeBindingReset,
      filesRestored,
      untrackedRemoved,
      skippedLargeFiles: target.skippedLargeFiles ?? [],
    };

    // Step 5: Emit checkpoint.reverted & notify downstream
    await params.hooks.onReverted?.(result, target);

    return result;
  }

  /**
   * Manual garbage collection for hidden checkpoint refs & SQLite rows.
   * Never invoked automatically when disabling/uninstalling a plugin.
   */
  async gcCheckpoints(params: {
    sessionId: string;
    cwd: string;
    keepLast?: number;
    olderThanDays?: number;
  }): Promise<{ deletedCount: number; deletedRefs: string[] }> {
    const keepLast = Math.max(0, params.keepLast ?? 20);
    const cutoffTs =
      params.olderThanDays !== undefined
        ? Date.now() - params.olderThanDays * 86_400_000
        : null;

    const all = this.list(params.sessionId, 2000);
    const toDelete: SessionCheckpointRecord[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const rec = all[i]!;
      const beyondKeep = i >= keepLast;
      const tooOld = cutoffTs !== null && rec.createdAt < cutoffTs;
      if (beyondKeep || tooOld) {
        toDelete.push(rec);
      }
    }

    if (toDelete.length === 0) {
      return { deletedCount: 0, deletedRefs: [] };
    }

    const deletedRefs: string[] = [];
    for (const rec of toDelete) {
      await runGitFull(params.cwd, ['update-ref', '-d', rec.gitRef], { timeoutMs: 4000 });
      deletedRefs.push(rec.gitRef);
    }

    const deletedCount = this.store.deleteCheckpointRecords(
      params.sessionId,
      toDelete.map((r) => r.checkpointId),
    );
    return { deletedCount, deletedRefs };
  }

  private async buildEphemeralTree(cwd: string): Promise<string> {
    const tempIndex = makeTempIndexPath();
    try {
      const [trackedRes, untrackedRes] = await Promise.all([
        runGitFull(cwd, ['ls-files', '-z'], { timeoutMs: this.captureTimeoutMs }),
        runGitFull(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], {
          timeoutMs: this.captureTimeoutMs,
        }),
      ]);
      const paths: string[] = [];
      const seen = new Set<string>();
      for (const rel of [
        ...parseNullTerminatedPaths(trackedRes.stdout),
        ...parseNullTerminatedPaths(untrackedRes.stdout),
      ]) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs = path.join(cwd, rel);
        try {
          const stat = fs.lstatSync(abs);
          if ((stat.isFile() && stat.size <= this.maxSingleFileBytes) || stat.isSymbolicLink()) {
            paths.push(rel);
          }
        } catch {
          // deleted on disk
        }
      }
      if (paths.length === 0) return EMPTY_TREE_SHA;
      const updateRes = await runGitWithStdin(
        cwd,
        ['update-index', '--add', '--replace', '-z', '--stdin'],
        Buffer.from(`${paths.join('\0')}\0`, 'utf8'),
        { timeoutMs: this.captureTimeoutMs, env: { GIT_INDEX_FILE: tempIndex } },
      );
      if (!updateRes.ok) return EMPTY_TREE_SHA;
      const writeRes = await runGitFull(cwd, ['write-tree'], {
        timeoutMs: this.captureTimeoutMs,
        env: { GIT_INDEX_FILE: tempIndex },
      });
      return writeRes.ok ? writeRes.stdout.trim() : EMPTY_TREE_SHA;
    } finally {
      cleanupTempIndex(tempIndex);
    }
  }

  private async restoreTreeToWorkingDir(
    cwd: string,
    targetTreeSha: string,
    protectedUntracked: Set<string>,
  ): Promise<{ filesRestored: number; untrackedRemoved: number }> {
    const tempIndex = makeTempIndexPath();
    try {
      // 1. Enumerate all file paths contained in targetTreeSha
      const targetFiles = new Set<string>();
      if (targetTreeSha !== EMPTY_TREE_SHA) {
        const lsTree = await runGitFull(cwd, ['ls-tree', '-r', '--name-only', '-z', targetTreeSha], {
          timeoutMs: 8000,
        });
        if (!lsTree.ok) {
          throw new CheckpointError('E_CHECKPOINT_MISSING', `无法读取目标检查点树 ${targetTreeSha}`);
        }
        for (const p of parseNullTerminatedPaths(lsTree.stdout)) {
          targetFiles.add(p);
        }
      }

      // 2. Enumerate current tracked + untracked (non-ignored) files on disk and delete those absent from target tree
      const [trackedRes, untrackedRes] = await Promise.all([
        runGitFull(cwd, ['ls-files', '-z'], { timeoutMs: 8000 }),
        runGitFull(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: 8000 }),
      ]);
      const currentFiles = new Set<string>([
        ...parseNullTerminatedPaths(trackedRes.stdout),
        ...parseNullTerminatedPaths(untrackedRes.stdout),
      ]);

      let untrackedRemoved = 0;
      for (const rel of currentFiles) {
        if (targetFiles.has(rel) || protectedUntracked.has(rel)) continue;
        const abs = path.join(cwd, rel);
        try {
          if (fs.existsSync(abs)) {
            fs.rmSync(abs, { force: true });
            pruneEmptyParentDirs(cwd, abs);
            untrackedRemoved += 1;
          }
        } catch {
          // ignore individual unlink failure
        }
      }

      // 3. Checkout target tree into working dir using isolated temp GIT_INDEX_FILE (never touches .git/index)
      let filesRestored = 0;
      if (targetTreeSha !== EMPTY_TREE_SHA && targetFiles.size > 0) {
        const readRes = await runGitFull(cwd, ['read-tree', targetTreeSha], {
          timeoutMs: 8000,
          env: { GIT_INDEX_FILE: tempIndex },
        });
        if (!readRes.ok) {
          throw new CheckpointError('E_REVERT_FAILED', readRes.stderr.trim() || 'read-tree 失败');
        }
        const checkoutRes = await runGitFull(
          cwd,
          ['-c', 'core.autocrlf=false', 'checkout-index', '-a', '-f'],
          {
            timeoutMs: 12_000,
            env: { GIT_INDEX_FILE: tempIndex },
          },
        );
        if (!checkoutRes.ok) {
          throw new CheckpointError(
            'E_REVERT_FAILED',
            checkoutRes.stderr.trim() || 'checkout-index 还原文件失败',
          );
        }
        filesRestored = targetFiles.size;
      }

      return { filesRestored, untrackedRemoved };
    } finally {
      cleanupTempIndex(tempIndex);
    }
  }
}
