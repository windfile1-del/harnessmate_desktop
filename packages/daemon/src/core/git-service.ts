import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  GitActionResult,
  GitDryRunMergeResult,
  GitFileChange,
  GitFileDiffResult,
  GitStatusSummary,
  GitWorkspaceTruthDigest,
  GitWorktreeEntry,
  SubagentDiffStat,
  WorkspaceSetupScriptInfo,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 120_000;
const MAX_SINGLE_FILE_DIFF_BYTES = 512 * 1024;
const SETUP_TRUST_PLUGIN_ID = 'hm.plugin.git-checkpoints';
const SETUP_TRUST_SCOPE = 'global';
const SETUP_CANDIDATE_RELPATHS = [
  '.harnessmate/setup',
  '.harnessmate/setup.ps1',
  '.harnessmate/setup.sh',
  '.harnessmate/setup.cmd',
  '.harnessmate/setup.mjs',
] as const;

export class GitOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export async function runGitFull(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: opts?.timeoutMs ?? 8000,
      maxBuffer: opts?.maxBuffer ?? 12 * 1024 * 1024,
      windowsHide: true,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
    return { ok: true, exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
    };
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    return {
      ok: false,
      exitCode,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : e.message || String(err),
      errorCode: typeof e.code === 'string' ? e.code : undefined,
    };
  }
}

async function runGit(cwd: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  const res = await runGitFull(cwd, args, { timeoutMs });
  return res.ok ? res.stdout : null;
}

function normalizeSafeRelPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\0') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new GitOperationError('E_INVALID_PATH', `Invalid repository relative path: ${filePath}`);
  }
  const resolved = path.resolve(cwd, trimmed);
  const rel = path.relative(path.resolve(cwd), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new GitOperationError('E_INVALID_PATH', `Path escapes repository root: ${filePath}`);
  }
  return rel.replace(/\\/g, '/');
}

export async function getGitVersion(cwd?: string): Promise<{ raw: string | null; major: number; minor: number }> {
  const res = await runGitFull(cwd && fs.existsSync(cwd) ? cwd : process.cwd(), ['--version'], {
    timeoutMs: 3000,
  });
  if (!res.ok) return { raw: null, major: 0, minor: 0 };
  const match = res.stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return { raw: res.stdout.trim(), major: 0, minor: 0 };
  return {
    raw: match[0],
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
  };
}

export async function inspectGitRepo(cwd: string): Promise<{ isGitRepo: boolean; branch: string | null }> {
  if (!fs.existsSync(cwd)) {
    return { isGitRepo: false, branch: null };
  }
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') {
    return { isGitRepo: false, branch: null };
  }
  const branch = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    isGitRepo: true,
    branch: branch ? branch.trim() : null,
  };
}

export async function initGitRepo(cwd: string): Promise<GitActionResult> {
  if (!fs.existsSync(cwd)) {
    throw new GitOperationError('E_NOT_FOUND', `Directory does not exist: ${cwd}`);
  }
  const res = await runGitFull(cwd, ['init'], { timeoutMs: 8000 });
  if (!res.ok) {
    throw new GitOperationError('E_GIT_INIT_FAILED', res.stderr.trim() || 'git init failed');
  }
  return {
    ok: true,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    message: '已成功初始化 Git 仓库',
  };
}

export async function getGitStatusSummary(cwd: string): Promise<GitStatusSummary> {
  const repoInfo = await inspectGitRepo(cwd);
  if (!repoInfo.isGitRepo) {
    return {
      isGitRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      changes: [],
      diff: '',
    };
  }

  const [porcelain, diffUnstaged, diffStaged, revCounts, numstatUnstaged, numstatStaged] = await Promise.all([
    runGit(cwd, ['status', '--porcelain=v1']),
    runGit(cwd, ['diff', '--no-color']),
    runGit(cwd, ['diff', '--cached', '--no-color']),
    runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    runGit(cwd, ['diff', '--numstat']),
    runGit(cwd, ['diff', '--cached', '--numstat']),
  ]);

  let ahead = 0;
  let behind = 0;
  if (revCounts) {
    const parts = revCounts.trim().split(/\s+/);
    behind = Number(parts[0] ?? 0) || 0;
    ahead = Number(parts[1] ?? 0) || 0;
  }

  const statsMap = new Map<string, { additions: number; deletions: number }>();
  for (const raw of [numstatStaged, numstatUnstaged]) {
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const key = m[3]!.trim();
      const prev = statsMap.get(key) ?? { additions: 0, deletions: 0 };
      prev.additions += m[1] === '-' ? 0 : Number(m[1]) || 0;
      prev.deletions += m[2] === '-' ? 0 : Number(m[2]) || 0;
      statsMap.set(key, prev);
    }
  }

  const changes: GitFileChange[] = [];
  if (porcelain) {
    for (const rawLine of porcelain.split(/\r?\n/)) {
      if (rawLine.length < 4) continue;
      const x = rawLine[0]!;
      const y = rawLine[1]!;
      const filePath = rawLine.slice(3).trim();
      if (!filePath) continue;
      const stat = statsMap.get(filePath);

      if (x === '?' && y === '?') {
        changes.push({ path: filePath, status: 'untracked', staged: false });
      } else if (x === 'U' || y === 'U') {
        changes.push({ path: filePath, status: 'conflicted', staged: false });
      } else {
        const code = x !== ' ' ? x : y;
        const status =
          code === 'A'
            ? 'added'
            : code === 'D'
              ? 'deleted'
              : code === 'R'
                ? 'renamed'
                : 'modified';
        changes.push({
          path: filePath,
          status,
          staged: x !== ' ' && x !== '?',
          ...(stat ? { additions: stat.additions, deletions: stat.deletions } : {}),
        });
      }
    }
  }

  let diff = [diffStaged?.trim(), diffUnstaged?.trim()].filter(Boolean).join('\n');
  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated at ${MAX_DIFF_CHARS} chars]`;
  }

  return {
    isGitRepo: true,
    branch: repoInfo.branch,
    ahead,
    behind,
    changes,
    diff,
  };
}

/**
 * On-demand per-file diff loader (avoids global 120KB truncation dropping files).
 * Supports staged, unstaged, and untracked files cleanly.
 */
export async function getFileDiff(
  cwd: string,
  filePath: string,
  staged = false,
): Promise<GitFileDiffResult> {
  const safePath = normalizeSafeRelPath(cwd, filePath);
  const repo = await inspectGitRepo(cwd);
  if (!repo.isGitRepo) {
    throw new GitOperationError('E_NOT_GIT_REPO', 'Current directory is not a Git repository');
  }

  const args = staged
    ? ['diff', '--cached', '--no-color', '--', safePath]
    : ['diff', '--no-color', '--', safePath];
  const res = await runGitFull(cwd, args, { timeoutMs: 8000 });
  let diffText = res.stdout;

  // Handle untracked file (not in git index yet) by generating a unified creation diff
  if (!diffText && !staged) {
    const fullPath = path.join(cwd, safePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const tracked = await runGitFull(cwd, ['ls-files', '--error-unmatch', '--', safePath], {
        timeoutMs: 3000,
      });
      if (!tracked.ok) {
        const buf = fs.readFileSync(fullPath);
        const totalBytes = buf.byteLength;
        const sample = buf.subarray(0, Math.min(buf.length, 4096));
        const isBinary = sample.includes(0);
        if (isBinary) {
          return {
            path: safePath,
            staged: false,
            diff: `Binary file ${safePath} (${totalBytes} bytes)`,
            binary: true,
            truncated: false,
            totalBytes,
          };
        }
        const truncated = totalBytes > MAX_SINGLE_FILE_DIFF_BYTES;
        const text = buf.subarray(0, MAX_SINGLE_FILE_DIFF_BYTES).toString('utf8');
        const lines = text.split(/\r?\n/);
        const formatted = [
          `diff --git a/${safePath} b/${safePath}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${safePath}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((l) => `+${l}`),
        ].join('\n');
        return {
          path: safePath,
          staged: false,
          diff: formatted,
          binary: false,
          truncated,
          totalBytes,
        };
      }
    }
  }

  const totalBytes = Buffer.byteLength(diffText, 'utf8');
  const binary = /^Binary files .* differ$/m.test(diffText);
  const truncated = totalBytes > MAX_SINGLE_FILE_DIFF_BYTES;
  if (truncated) {
    diffText = `${diffText.slice(0, MAX_SINGLE_FILE_DIFF_BYTES)}\n\n... [file diff truncated at ${MAX_SINGLE_FILE_DIFF_BYTES} bytes]`;
  }
  return {
    path: safePath,
    staged,
    diff: diffText,
    binary,
    truncated,
    totalBytes,
  };
}

/**
 * Discards working-tree (and staged) changes for a single file safely.
 */
export async function discardFile(cwd: string, filePath: string): Promise<GitActionResult> {
  const safePath = normalizeSafeRelPath(cwd, filePath);
  const repo = await inspectGitRepo(cwd);
  if (!repo.isGitRepo) {
    throw new GitOperationError('E_NOT_GIT_REPO', 'Current directory is not a Git repository');
  }

  const inHead = await runGitFull(cwd, ['cat-file', '-e', `HEAD:${safePath}`], { timeoutMs: 3000 });
  if (inHead.ok) {
    // Restore both index and working tree from HEAD for this single path
    await runGitFull(cwd, ['reset', 'HEAD', '--', safePath], { timeoutMs: 5000 });
    const checkout = await runGitFull(cwd, ['checkout', '--', safePath], { timeoutMs: 5000 });
    if (!checkout.ok) {
      throw new GitOperationError('E_DISCARD_FAILED', checkout.stderr.trim() || `Failed to discard ${safePath}`);
    }
    return {
      ok: true,
      stdout: checkout.stdout,
      stderr: checkout.stderr,
      message: `已还原文件 ${safePath}`,
    };
  }

  // Untracked or newly staged file not present in HEAD: unstage (if staged) and remove from disk
  await runGitFull(cwd, ['rm', '--cached', '--ignore-unmatch', '-f', '--', safePath], { timeoutMs: 5000 });
  const fullPath = path.join(cwd, safePath);
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath, { force: true });
  }
  return {
    ok: true,
    stdout: '',
    stderr: '',
    message: `已移除未追踪文件 ${safePath}`,
  };
}

/**
 * Lightweight read-only workspace truth digest (< 80ms target) for Context Handoff v2.
 */
export async function workspaceTruthDigest(cwd: string): Promise<GitWorkspaceTruthDigest> {
  const started = Date.now();
  const repo = await inspectGitRepo(cwd);
  if (!repo.isGitRepo) {
    return {
      isGitRepo: false,
      branch: null,
      headSha: null,
      dirtyFilesCount: 0,
      dirtyFiles: [],
      diffStat: '',
      capturedAt: Date.now(),
      durationMs: Date.now() - started,
    };
  }

  const [headRes, porcelainRes, diffStatRes] = await Promise.all([
    runGit(cwd, ['rev-parse', '--short', 'HEAD'], 2500),
    runGit(cwd, ['status', '--porcelain=v1'], 2500),
    runGit(cwd, ['diff', '--stat'], 2500),
  ]);

  const dirtyFiles: string[] = [];
  if (porcelainRes) {
    for (const line of porcelainRes.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const p = line.slice(3).trim();
      if (p) dirtyFiles.push(p);
    }
  }

  return {
    isGitRepo: true,
    branch: repo.branch,
    headSha: headRes ? headRes.trim() : null,
    dirtyFilesCount: dirtyFiles.length,
    dirtyFiles: dirtyFiles.slice(0, 60),
    diffStat: (diffStatRes ?? '').trim().slice(0, 2000),
    capturedAt: Date.now(),
    durationMs: Date.now() - started,
  };
}

// ── Worktree Full Lifecycle & Merge Conflict Pre-Check ─────────────────

export async function createGitWorktree(
  repoRoot: string,
  branchName: string,
  opts?: { baseBranch?: string },
): Promise<{ worktreePath: string; branch: string }> {
  const sanitized = branchName.replace(/[^a-zA-Z0-9._/-]/g, '-').slice(0, 60);
  const worktreesDir = path.join(path.dirname(repoRoot), '.harnessmate-worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });
  const folderName = `${path.basename(repoRoot)}-${sanitized.replace(/\//g, '-')}-${Date.now().toString(36)}`;
  const worktreePath = path.join(worktreesDir, folderName);

  const args = ['worktree', 'add', '-b', sanitized, worktreePath];
  if (opts?.baseBranch?.trim()) {
    args.push(opts.baseBranch.trim());
  }

  const res = await runGitFull(repoRoot, args, { timeoutMs: 15_000 });
  if (!res.ok) {
    throw new GitOperationError(
      'E_WORKTREE_CREATE_FAILED',
      res.stderr.trim() || `Failed to create git worktree for branch "${sanitized}"`,
    );
  }

  return { worktreePath, branch: sanitized };
}

export async function listGitWorktrees(
  repoRoot: string,
  sessionCwds?: Array<{ sessionId: string; cwd: string }>,
): Promise<GitWorktreeEntry[]> {
  const repo = await inspectGitRepo(repoRoot);
  if (!repo.isGitRepo) return [];

  const res = await runGitFull(repoRoot, ['worktree', 'list', '--porcelain'], { timeoutMs: 6000 });
  if (!res.ok) return [];

  const entries: GitWorktreeEntry[] = [];
  let current: Partial<GitWorktreeEntry> | null = null;

  const commitEntry = () => {
    if (!current?.path) return;
    entries.push({
      path: current.path,
      headSha: current.headSha ?? null,
      branch: current.branch ?? null,
      isMain: entries.length === 0,
      isBare: Boolean(current.isBare),
      locked: Boolean(current.locked),
      prunable: Boolean(current.prunable),
      dirtyCount: 0,
      linkedSessionIds: [],
    });
    current = null;
  };

  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      commitEntry();
      continue;
    }
    if (line.startsWith('worktree ')) {
      commitEntry();
      current = { path: path.resolve(line.slice('worktree '.length).trim()) };
    } else if (current) {
      if (line.startsWith('HEAD ')) {
        current.headSha = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        current.branch = ref.replace(/^refs\/heads\//, '');
      } else if (line === 'bare') {
        current.isBare = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        current.locked = true;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        current.prunable = true;
      }
    }
  }
  commitEntry();

  // Populate dirtyCount and linkedSessionIds in parallel
  const norm = (p: string) => path.resolve(p).toLowerCase();
  await Promise.all(
    entries.map(async (entry) => {
      if (sessionCwds) {
        const target = norm(entry.path);
        entry.linkedSessionIds = sessionCwds
          .filter((s) => norm(s.cwd) === target)
          .map((s) => s.sessionId);
      }
      if (!entry.isBare && fs.existsSync(entry.path)) {
        const porcelain = await runGit(entry.path, ['status', '--porcelain=v1'], 3000);
        entry.dirtyCount = porcelain
          ? porcelain.split(/\r?\n/).filter((l) => l.trim().length > 0).length
          : 0;
      }
    }),
  );

  return entries;
}

export async function removeGitWorktree(
  repoRoot: string,
  worktreePath: string,
  opts?: { force?: boolean },
): Promise<GitActionResult> {
  const resolvedTarget = path.resolve(worktreePath);
  const resolvedMain = path.resolve(repoRoot);
  if (resolvedTarget.toLowerCase() === resolvedMain.toLowerCase()) {
    throw new GitOperationError('E_WORKTREE_MAIN', '不能删除主仓库工作区，仅支持删除隔离 Worktree');
  }

  const args = ['worktree', 'remove'];
  if (opts?.force) args.push('--force');
  args.push(resolvedTarget);

  const res = await runGitFull(repoRoot, args, { timeoutMs: 12_000 });
  if (!res.ok) {
    const combined = `${res.stderr}\n${res.stdout}`;
    // Always run safe metadata prune without destructive rm -rf
    await runGitFull(repoRoot, ['worktree', 'prune'], { timeoutMs: 5000 });

    if (
      res.errorCode === 'EBUSY' ||
      res.errorCode === 'EPERM' ||
      /EBUSY|EPERM|Permission denied|Directory not empty|cannot remove|Device or resource busy|failed to delete/i.test(
        combined,
      )
    ) {
      throw new GitOperationError(
        'E_WORKTREE_BUSY',
        `Worktree 目录正被终端或 Agent 进程占用，无法安全移除 (${resolvedTarget})。请先关闭占用该目录的会话或终端后重试；已执行安全 git worktree prune 且未破坏 .git/worktrees。`,
      );
    }
    throw new GitOperationError(
      'E_WORKTREE_REMOVE_FAILED',
      res.stderr.trim() || `移除 Worktree 失败: ${resolvedTarget}`,
    );
  }

  await runGitFull(repoRoot, ['worktree', 'prune'], { timeoutMs: 5000 });
  return {
    ok: true,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    message: `已安全移除 Worktree 并清理元数据 (${path.basename(resolvedTarget)})`,
  };
}

/**
 * Zero-side-effect merge conflict pre-check using `git merge-tree --write-tree` (Git >= 2.38).
 */
export async function dryRunMerge(
  repoRoot: string,
  baseBranch: string,
  headBranch: string,
): Promise<GitDryRunMergeResult> {
  const ver = await getGitVersion(repoRoot);
  const supported = ver.major > 2 || (ver.major === 2 && ver.minor >= 38);
  if (!supported) {
    return {
      supported: false,
      gitVersion: ver.raw,
      baseBranch,
      headBranch,
      hasConflicts: false,
      conflictFiles: [],
      treeSha: null,
      message: `当前 Git 版本 (${ver.raw ?? 'unknown'}) 低于 2.38，不支持无副作用 git merge-tree --write-tree 冲突预检`,
    };
  }

  const res = await runGitFull(
    repoRoot,
    ['merge-tree', '--write-tree', '--name-only', baseBranch, headBranch],
    { timeoutMs: 10_000 },
  );

  const lines = res.stdout.split(/\r?\n/).map((l) => l.trim());
  const firstLine = lines[0] ?? '';
  const treeSha = /^[a-f0-9]{40}$/i.test(firstLine) ? firstLine : null;

  if (res.ok) {
    return {
      supported: true,
      gitVersion: ver.raw,
      baseBranch,
      headBranch,
      hasConflicts: false,
      conflictFiles: [],
      treeSha,
      message: `${headBranch} 可无冲突合并至 ${baseBranch}`,
    };
  }

  if (treeSha) {
    // Exit code 1 with treeSha indicates merge conflicts; lines between treeSha and blank line are conflicted filenames
    const conflicts = new Set<string>();
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!line) break;
      if (!line.startsWith('CONFLICT') && !line.startsWith('Auto-merging')) {
        conflicts.add(line);
      }
    }
    // Also parse CONFLICT (...): Merge conflict in <file> lines as fallback
    for (const line of lines) {
      const m = line.match(/Merge conflict in (.+)$/i) ?? line.match(/conflict.*?:\s+(.+?)\s+deleted/i);
      if (m?.[1]) conflicts.add(m[1].trim());
    }
    const conflictFiles = [...conflicts];
    return {
      supported: true,
      gitVersion: ver.raw,
      baseBranch,
      headBranch,
      hasConflicts: true,
      conflictFiles,
      treeSha,
      message: `检测到 ${conflictFiles.length} 个合并冲突文件`,
    };
  }

  throw new GitOperationError(
    'E_MERGE_PRECHECK_FAILED',
    res.stderr.trim() || `merge-tree 执行失败 (${baseBranch} vs ${headBranch})`,
  );
}

// ── .harnessmate/setup Script Trust Boundary ───────────────────────────

function setupTrustKvKey(repoRoot: string): string {
  const norm = path.resolve(repoRoot).replace(/\\/g, '/').toLowerCase();
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 24);
  return `setup_trust:${hash}`;
}

export function inspectSetupScript(
  repoRoot: string,
  store?: HarnessMateStore,
): WorkspaceSetupScriptInfo {
  const resolvedRoot = path.resolve(repoRoot);
  let foundRel: string | null = null;
  let foundFull: string | null = null;
  for (const rel of SETUP_CANDIDATE_RELPATHS) {
    const candidate = path.join(resolvedRoot, rel);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      foundRel = rel;
      foundFull = candidate;
      break;
    }
  }
  if (!foundFull || !foundRel) {
    return {
      exists: false,
      scriptPath: null,
      relativePath: null,
      content: null,
      sha256: null,
      trusted: false,
      trustedAt: null,
    };
  }

  const content = fs.readFileSync(foundFull, 'utf8');
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const stored = store?.getPluginStorageValue(
    SETUP_TRUST_SCOPE,
    SETUP_TRUST_PLUGIN_ID,
    setupTrustKvKey(resolvedRoot),
  ) as { sha256?: string; trustedAt?: number } | undefined;

  const trusted = Boolean(stored && stored.sha256 === sha256);
  return {
    exists: true,
    scriptPath: foundFull,
    relativePath: foundRel,
    content,
    sha256,
    trusted,
    trustedAt: trusted ? (stored?.trustedAt ?? null) : null,
  };
}

export function setSetupScriptTrust(
  repoRoot: string,
  store: HarnessMateStore,
  sha256: string,
  trusted: boolean,
): WorkspaceSetupScriptInfo {
  const info = inspectSetupScript(repoRoot, store);
  const key = setupTrustKvKey(repoRoot);
  if (!trusted) {
    store.deletePluginStorageValue(SETUP_TRUST_SCOPE, SETUP_TRUST_PLUGIN_ID, key);
    return inspectSetupScript(repoRoot, store);
  }
  if (!info.exists || !info.sha256) {
    throw new GitOperationError('E_SETUP_NOT_FOUND', '仓库中不存在 .harnessmate/setup 初始化脚本');
  }
  if (info.sha256 !== sha256) {
    throw new GitOperationError(
      'E_SETUP_HASH_MISMATCH',
      '脚本内容在审阅后发生了变更（SHA-256 不匹配），请重新审阅后再信任',
    );
  }
  store.setPluginStorageValue(SETUP_TRUST_SCOPE, SETUP_TRUST_PLUGIN_ID, key, {
    repoRoot: path.resolve(repoRoot),
    sha256,
    trustedAt: Date.now(),
  });
  return inspectSetupScript(repoRoot, store);
}

/**
 * Executes `.harnessmate/setup` inside `worktreePath` ONLY when exact `repoRoot + sha256`
 * has been explicitly signed/trusted by the user. Untrusted execution rate is strictly 0.
 */
export async function executeTrustedSetupScript(
  repoRoot: string,
  worktreePath: string,
  store: HarnessMateStore,
): Promise<GitActionResult> {
  const info = inspectSetupScript(repoRoot, store);
  if (!info.exists || !info.scriptPath || !info.sha256) {
    throw new GitOperationError('E_SETUP_NOT_FOUND', '仓库中未找到 .harnessmate/setup 脚本');
  }
  if (!info.trusted) {
    throw new GitOperationError(
      'E_SETUP_SCRIPT_UNTRUSTED',
      `已拦截未受信任的初始化脚本 (${info.relativePath} · sha256:${info.sha256.slice(0, 12)})。请先在界面审阅脚本全文并显式信任后再执行。`,
    );
  }

  const ext = path.extname(info.scriptPath).toLowerCase();
  let cmd: string;
  let args: string[];
  if (ext === '.mjs' || ext === '.js') {
    cmd = process.execPath;
    args = [info.scriptPath];
  } else if (ext === '.ps1') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', info.scriptPath];
  } else if (ext === '.cmd' || ext === '.bat') {
    cmd = 'cmd.exe';
    args = ['/c', info.scriptPath];
  } else if (process.platform === 'win32') {
    cmd = 'sh';
    args = [info.scriptPath];
  } else {
    cmd = '/bin/sh';
    args = [info.scriptPath];
  }

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: worktreePath,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      message: `已执行受信任初始化脚本 ${info.relativePath}`,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new GitOperationError(
      'E_SETUP_EXEC_FAILED',
      String(e.stderr || e.message || '初始化脚本执行失败').trim(),
    );
  }
}

// ── Explicit User-Triggered Delivery Workflows (Commit / Push / Pull / PR) ─

export async function gitCommit(
  cwd: string,
  opts: { message: string; files?: string[]; stageAll?: boolean },
): Promise<GitActionResult> {
  const repo = await inspectGitRepo(cwd);
  if (!repo.isGitRepo) {
    throw new GitOperationError('E_NOT_GIT_REPO', '当前目录不是 Git 仓库');
  }
  const msg = opts.message.trim();
  if (!msg) {
    throw new GitOperationError('E_INVALID_INPUT', '提交信息不能为空');
  }

  if (opts.files && opts.files.length > 0) {
    const safeFiles = opts.files.map((f) => normalizeSafeRelPath(cwd, f));
    const addRes = await runGitFull(cwd, ['add', '--', ...safeFiles], { timeoutMs: 10_000 });
    if (!addRes.ok) {
      throw new GitOperationError('E_GIT_ADD_FAILED', addRes.stderr.trim() || '暂存文件失败');
    }
  } else if (opts.stageAll !== false) {
    const addRes = await runGitFull(cwd, ['add', '-A'], { timeoutMs: 10_000 });
    if (!addRes.ok) {
      throw new GitOperationError('E_GIT_ADD_FAILED', addRes.stderr.trim() || '暂存工作区变更失败');
    }
  }

  const commitRes = await runGitFull(cwd, ['commit', '-m', msg], { timeoutMs: 15_000 });
  if (!commitRes.ok) {
    throw new GitOperationError(
      'E_GIT_COMMIT_FAILED',
      commitRes.stderr.trim() || commitRes.stdout.trim() || 'Git commit 失败',
    );
  }
  return {
    ok: true,
    stdout: commitRes.stdout.trim(),
    stderr: commitRes.stderr.trim(),
    message: '提交成功',
  };
}

/**
 * Explicit user push. Strictly forbids `--force` / `--force-with-lease`.
 */
export async function gitPush(
  cwd: string,
  opts?: { remote?: string; branch?: string; setUpstream?: boolean },
): Promise<GitActionResult> {
  const repo = await inspectGitRepo(cwd);
  if (!repo.isGitRepo) {
    throw new GitOperationError('E_NOT_GIT_REPO', '当前目录不是 Git 仓库');
  }
  const args = ['push'];
  if (opts?.setUpstream) args.push('-u');
  if (opts?.remote) args.push(opts.remote);
  if (opts?.branch) args.push(opts.branch);

  // Defense-in-depth: never allow force flags
  if (args.some((a) => a === '--force' || a === '-f' || a.startsWith('--force'))) {
    throw new GitOperationError('E_FORBIDDEN_FORCE_PUSH', '禁止执行强制推送 (--force)');
  }

  const res = await runGitFull(cwd, args, { timeoutMs: 30_000 });
  if (!res.ok) {
    throw new GitOperationError('E_GIT_PUSH_FAILED', res.stderr.trim() || res.stdout.trim() || 'Git push 失败');
  }
  return {
    ok: true,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    message: '推送成功',
  };
}

export async function gitPull(
  cwd: string,
  opts?: { remote?: string; branch?: string },
): Promise<GitActionResult> {
  const repo = await inspectGitRepo(cwd);
  if (!repo.isGitRepo) {
    throw new GitOperationError('E_NOT_GIT_REPO', '当前目录不是 Git 仓库');
  }
  const args = ['pull'];
  if (opts?.remote) args.push(opts.remote);
  if (opts?.branch) args.push(opts.branch);

  const res = await runGitFull(cwd, args, { timeoutMs: 30_000 });
  if (!res.ok) {
    throw new GitOperationError('E_GIT_PULL_FAILED', res.stderr.trim() || res.stdout.trim() || 'Git pull 失败');
  }
  return {
    ok: true,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    message: '拉取成功',
  };
}

export async function gitCreatePr(
  cwd: string,
  opts: { title: string; body?: string; base?: string; draft?: boolean },
): Promise<GitActionResult> {
  const repo = await inspectGitRepo(cwd);
  if (!repo.isGitRepo) {
    throw new GitOperationError('E_NOT_GIT_REPO', '当前目录不是 Git 仓库');
  }

  const args = ['pr', 'create', '--title', opts.title, '--body', opts.body ?? ''];
  if (opts.base) args.push('--base', opts.base);
  if (opts.draft) args.push('--draft');

  try {
    const { stdout, stderr } = await execFileAsync('gh', args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const outStr = String(stdout ?? '').trim();
    const urlMatch = outStr.match(/https?:\/\/\S+/);
    return {
      ok: true,
      stdout: outStr,
      stderr: String(stderr ?? '').trim(),
      message: '已创建 Pull Request',
      prUrl: urlMatch?.[0] ?? null,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      throw new GitOperationError(
        'E_GH_NOT_INSTALLED',
        '未检测到 GitHub CLI (`gh`)。请先安装 `gh`（https://cli.github.com/）并运行 `gh auth login` 后重试创建 PR。',
      );
    }
    throw new GitOperationError(
      'E_PR_CREATE_FAILED',
      String(e.stderr || e.stdout || e.message || '创建 PR 失败').trim(),
    );
  }
}

// ── Subagent Worktree Commit, DiffStat & Explicit Human-Confirmed Merge ─

/**
 * Stages and commits any uncommitted/untracked changes inside an isolated subagent
 * worktree onto its isolated branch so dry-run merge and diffstat accurately reflect
 * all edits made by the subagent. Never touches the main repository working tree.
 */
export async function commitWorktreeChangesIfDirty(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean; commitSha: string | null }> {
  if (!fs.existsSync(worktreePath)) {
    return { committed: false, commitSha: null };
  }
  // Exclude HarnessMate's own internal runtime metadata (.harnessmate/) so parallel subagents
  // never pollute feature branches or spuriously conflict on task-ledger files.
  const pathspec = ['--', '.', ':!.harnessmate', ':!.harnessmate/'];
  const porcelain = await runGit(worktreePath, ['status', '--porcelain=v1', ...pathspec], 5000);
  if (porcelain && porcelain.trim().length > 0) {
    const addRes = await runGitFull(worktreePath, ['add', '-A', ...pathspec], { timeoutMs: 10_000 });
    if (!addRes.ok) {
      throw new GitOperationError(
        'E_GIT_ADD_FAILED',
        addRes.stderr.trim() || `暂存子任务 Worktree 变更失败: ${worktreePath}`,
      );
    }
    const commitRes = await runGitFull(
      worktreePath,
      [
        '-c',
        'user.name=HarnessMate Orchestrator',
        '-c',
        'user.email=orchestrator@harnessmate.local',
        'commit',
        '-m',
        message.trim() || 'chore(subagent): snapshot isolated worktree edits',
      ],
      { timeoutMs: 15_000 },
    );
    if (!commitRes.ok && !/nothing to commit/i.test(`${commitRes.stdout}\n${commitRes.stderr}`)) {
      throw new GitOperationError(
        'E_GIT_COMMIT_FAILED',
        commitRes.stderr.trim() || commitRes.stdout.trim() || '子任务 Worktree 自动提交失败',
      );
    }
    const sha = (await runGit(worktreePath, ['rev-parse', 'HEAD'], 3000))?.trim();
    return { committed: true, commitSha: sha || null };
  }
  const sha = (await runGit(worktreePath, ['rev-parse', 'HEAD'], 3000))?.trim();
  return { committed: false, commitSha: sha || null };
}

/**
 * Computes branch diffstat (`baseBranch...headBranch`) without modifying any working tree.
 */
export async function computeBranchDiffStat(
  repoRoot: string,
  baseBranch: string,
  headBranch: string,
): Promise<SubagentDiffStat> {
  const res = await runGitFull(repoRoot, ['diff', '--numstat', `${baseBranch}...${headBranch}`], {
    timeoutMs: 8000,
  });
  if (!res.ok) {
    return { filesChanged: 0, insertions: 0, deletions: 0, changedFiles: [] };
  }
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const changedFiles: string[] = [];
  for (const raw of res.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const add = Number.parseInt(parts[0]!, 10);
    const del = Number.parseInt(parts[1]!, 10);
    const filePath = parts.slice(2).join('\t').trim();
    if (!filePath) continue;
    filesChanged += 1;
    if (Number.isFinite(add)) insertions += add;
    if (Number.isFinite(del)) deletions += del;
    changedFiles.push(filePath);
  }
  return { filesChanged, insertions, deletions, changedFiles };
}

/**
 * Explicit human-confirmed merge of a child branch into the main repository's baseBranch.
 * Always executes `dryRunMerge` first and aborts before touching the working tree if any
 * conflict is detected.
 */
export async function mergeBranchExplicit(
  repoRoot: string,
  baseBranch: string,
  headBranch: string,
  opts?: { commitMessage?: string },
): Promise<{ commitSha: string | null; dryRun: GitDryRunMergeResult }> {
  const dryRun = await dryRunMerge(repoRoot, baseBranch, headBranch);
  if (dryRun.hasConflicts) {
    throw new GitOperationError(
      'E_MERGE_CONFLICT',
      `检测到 ${dryRun.conflictFiles.length} 个合并冲突文件，已阻止合并以保护主工作区: ${dryRun.conflictFiles.join(', ')}`,
    );
  }

  const currentBranch = (await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], 3000))?.trim();
  if (currentBranch && currentBranch !== baseBranch) {
    throw new GitOperationError(
      'E_BASE_BRANCH_MISMATCH',
      `主工作区当前分支为 ${currentBranch}，与目标合回分支 ${baseBranch} 不一致，请先切换分支后重试`,
    );
  }

  const msg = opts?.commitMessage?.trim() || `Merge subagent branch '${headBranch}' into ${baseBranch}`;
  const mergeRes = await runGitFull(
    repoRoot,
    [
      '-c',
      'user.name=HarnessMate Orchestrator',
      '-c',
      'user.email=orchestrator@harnessmate.local',
      'merge',
      '--no-ff',
      '-m',
      msg,
      headBranch,
    ],
    { timeoutMs: 15_000 },
  );

  if (!mergeRes.ok) {
    // Guarantee main working tree is never left in a conflicted/half-merged state
    await runGitFull(repoRoot, ['merge', '--abort'], { timeoutMs: 5000 });
    throw new GitOperationError(
      'E_MERGE_FAILED',
      mergeRes.stderr.trim() || mergeRes.stdout.trim() || `合并分支 ${headBranch} 失败，已自动回滚合并状态`,
    );
  }

  const commitSha = (await runGit(repoRoot, ['rev-parse', 'HEAD'], 3000))?.trim();
  return { commitSha: commitSha || null, dryRun };
}

export async function deleteLocalBranch(repoRoot: string, branchName: string): Promise<boolean> {
  const res = await runGitFull(repoRoot, ['branch', '-d', branchName], { timeoutMs: 5000 });
  return res.ok;
}
