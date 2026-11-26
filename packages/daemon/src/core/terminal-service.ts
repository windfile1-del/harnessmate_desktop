import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { PluginApiError } from '@harnessmate/plugin-api';
import { killProcessTree } from '../harnesses/process.js';

export interface TerminalExecResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_OUTPUT_CHARS = 64_000;

export class WorkspaceTerminalRunner {
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly activeTimers = new Set<NodeJS.Timeout>();
  private disposed = false;

  isDisposed(): boolean {
    return this.disposed;
  }

  activeCount(): number {
    return this.activeChildren.size;
  }

  run(
    cwd: string,
    command: string,
    timeoutMs = 30_000,
  ): Promise<TerminalExecResult> {
    if (this.disposed) {
      throw new PluginApiError('E_PLUGIN_DISABLED', '工作区终端命令执行器已停用或已销毁');
    }
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error('Command cannot be empty');
    }

    const startedAt = Date.now();
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-Command', trimmed], {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn(process.env.SHELL || '/bin/sh', ['-lc', trimmed], {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      this.activeChildren.add(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const appendLimited = (current: string, chunk: Buffer): string => {
        if (current.length >= MAX_OUTPUT_CHARS) return current;
        const next = current + chunk.toString('utf8');
        return next.length > MAX_OUTPUT_CHARS
          ? `${next.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated]`
          : next;
      };

      const timer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          void killProcessTree(child);
        }
      }, timeoutMs);
      this.activeTimers.add(timer);

      const finalize = (code: number | null, errMessage?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeTimers.delete(timer);
        this.activeChildren.delete(child);
        resolve({
          command: trimmed,
          cwd,
          exitCode: errMessage ? -1 : (code ?? (timedOut ? 124 : 0)),
          stdout,
          stderr: errMessage ? `${stderr}\n${errMessage}`.trim() : stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      };

      child.stdout?.on('data', (c: Buffer) => {
        stdout = appendLimited(stdout, c);
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderr = appendLimited(stderr, c);
      });

      child.on('error', (err) => {
        finalize(-1, err.message);
      });

      child.on('close', (code) => {
        finalize(code);
      });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    const children = [...this.activeChildren];
    this.activeChildren.clear();
    await Promise.all(children.map((child) => killProcessTree(child)));
  }
}

export async function runWorkspaceCommand(
  cwd: string,
  command: string,
  timeoutMs = 30_000,
): Promise<TerminalExecResult> {
  const runner = new WorkspaceTerminalRunner();
  try {
    return await runner.run(cwd, command, timeoutMs);
  } finally {
    await runner.dispose();
  }
}
