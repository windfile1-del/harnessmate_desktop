import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const tailSegments: string[] = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tailSegments.unshift(path.basename(cursor));
    cursor = parent;
  }
  let base = cursor;
  try {
    base = fs.realpathSync.native(cursor);
  } catch {
    try {
      base = fs.realpathSync(cursor);
    } catch {
      base = cursor;
    }
  }
  const combined = tailSegments.length > 0 ? path.join(base, ...tailSegments) : base;
  const normalized = path.normalize(combined);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function findNearestExistingDir(targetPath: string): string {
  let cursor = path.resolve(targetPath);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  try {
    if (fs.statSync(cursor).isFile()) {
      return path.dirname(cursor);
    }
  } catch {
    // ignore stat race
  }
  return cursor;
}

/**
 * Resolves the canonical lock key for a target directory/file path.
 * All worktrees of the same repository share the same `git-common-dir` lock key.
 * Directories not yet initialized as a Git repo use the normalized `<target>/.git`
 * path so concurrent `init` and immediate post-init writes share the exact same key.
 */
export async function resolveGitRepoLockKey(targetPath: string): Promise<string> {
  const resolvedTarget = path.resolve(targetPath);
  const existingDir = findNearestExistingDir(resolvedTarget);
  if (fs.existsSync(existingDir)) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', existingDir, 'rev-parse', '--git-common-dir'],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 8_000,
        },
      );
      const rawCommonDir = stdout.trim();
      if (rawCommonDir) {
        const absCommonDir = path.isAbsolute(rawCommonDir)
          ? rawCommonDir
          : path.resolve(existingDir, rawCommonDir);
        return `git:${canonicalizePath(absCommonDir)}`;
      }
    } catch {
      // Not yet a Git repo or git binary missing; fall back to normalized target dir/.git
    }
  }
  return `git:${canonicalizePath(path.join(resolvedTarget, '.git'))}`;
}

export class GitRepoWriteCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly activeDepth = new Map<string, number>();

  async runExclusive<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
    const key = await resolveGitRepoLockKey(targetPath);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = prev.then(() => gate, () => gate);
    this.tails.set(key, nextTail);

    await prev;
    this.activeDepth.set(key, (this.activeDepth.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const nextDepth = (this.activeDepth.get(key) ?? 1) - 1;
      if (nextDepth <= 0) this.activeDepth.delete(key);
      else this.activeDepth.set(key, nextDepth);

      release();
      if (this.tails.get(key) === nextTail) {
        this.tails.delete(key);
      }
    }
  }

  getActiveKeys(): string[] {
    return [...this.activeDepth.keys()];
  }
}

export const sharedGitRepoCoordinator = new GitRepoWriteCoordinator();
