import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

export async function runWorkspaceCommand(
  cwd: string,
  command: string,
  timeoutMs = 30_000,
): Promise<TerminalExecResult> {
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

    child.stdout?.on('data', (c: Buffer) => {
      stdout = appendLimited(stdout, c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = appendLimited(stderr, c);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: trimmed,
        cwd,
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: trimmed,
        cwd,
        exitCode: code ?? (timedOut ? 124 : 0),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}
