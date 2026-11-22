import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitFileChange, GitStatusSummary } from '@harnessmate/protocol';

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 120_000;

async function runGit(cwd: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
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

  const [porcelain, diffUnstaged, diffStaged, revCounts] = await Promise.all([
    runGit(cwd, ['status', '--porcelain=v1']),
    runGit(cwd, ['diff', '--no-color']),
    runGit(cwd, ['diff', '--cached', '--no-color']),
    runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
  ]);

  let ahead = 0;
  let behind = 0;
  if (revCounts) {
    const parts = revCounts.trim().split(/\s+/);
    behind = Number(parts[0] ?? 0) || 0;
    ahead = Number(parts[1] ?? 0) || 0;
  }

  const changes: GitFileChange[] = [];
  if (porcelain) {
    for (const rawLine of porcelain.split(/\r?\n/)) {
      if (rawLine.length < 4) continue;
      const x = rawLine[0]!;
      const y = rawLine[1]!;
      const filePath = rawLine.slice(3).trim();
      if (!filePath) continue;

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

export async function createGitWorktree(
  repoRoot: string,
  branchName: string,
): Promise<{ worktreePath: string; branch: string }> {
  const sanitized = branchName.replace(/[^a-zA-Z0-9._/-]/g, '-').slice(0, 60);
  const worktreesDir = path.join(path.dirname(repoRoot), '.harnessmate-worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });
  const folderName = `${path.basename(repoRoot)}-${sanitized.replace(/\//g, '-')}-${Date.now().toString(36)}`;
  const worktreePath = path.join(worktreesDir, folderName);

  const res = await runGit(repoRoot, ['worktree', 'add', '-b', sanitized, worktreePath], 15_000);
  if (res === null) {
    throw new Error(`Failed to create git worktree for branch "${sanitized}"`);
  }

  return { worktreePath, branch: sanitized };
}
