import crypto from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DevServerHint,
  ManagedTerminalTab,
  TerminalBackendKind,
  TerminalContextChip,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { DEFAULT_STRIP_ENV_KEYS, killProcessTree } from '../harnesses/process.js';
import type { GitService } from '../plugin-host/builtin/services.js';

const execFileAsync = promisify(execFile);

export const TERMINAL_WORKSPACE_PLUGIN_ID = 'hm.plugin.terminal-workspace';
export const DEFAULT_RING_BUFFER_BYTES = 512 * 1024;
export const DEFAULT_BATCH_FLUSH_MS = 16;
export const MAX_CONTEXT_CHIP_BYTES = 16_384;

export class TerminalWorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly blockingTerminals?: ManagedTerminalTab[],
  ) {
    super(message);
    this.name = 'TerminalWorkspaceError';
  }
}

export interface StripAndClipOptions {
  lineStart?: number;
  lineEnd?: number;
  recentLines?: number;
  maxBytes?: number;
}

export interface StripAndClipResult {
  cleanText: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  truncated: boolean;
}

// eslint-disable-next-line no-control-regex
const ANSI_OSC_DCS_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_CHARSET_AND_TWO_BYTE = /\x1b[()][0-2AB]|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const STRAY_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strips all ANSI CSI/OSC/DCS escape sequences and stray terminal control bytes,
 * normalizing CRLF/CR line endings to LF while preserving printable text and indentation.
 */
export function stripAnsi(raw: string): string {
  return raw
    .replace(ANSI_OSC_DCS_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_CHARSET_AND_TWO_BYTE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(STRAY_CONTROL_CHARS, '')
    .replace(/\x1b/g, '');
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function sliceHeadWithinLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes && text.length <= maxBytes) {
    return text;
  }
  let lo = 0;
  let hi = Math.min(text.length, maxBytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid);
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes && candidate.length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let end = lo;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
}

function sliceTailWithinLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes && text.length <= maxBytes) {
    return text;
  }
  let lo = Math.max(0, text.length - maxBytes);
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(mid);
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes && candidate.length <= maxBytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  let start = lo;
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  return text.slice(start);
}

/**
 * Cleans ANSI escape noise, slices exact 1-based line ranges (or recent N lines),
 * and enforces a strict 16KB UTF-8 byte & char cap with clean surrogate-safe truncation.
 */
export function stripAnsiAndClip(
  rawText: string,
  opts: StripAndClipOptions = {},
): StripAndClipResult {
  const clean = stripAnsi(rawText);
  let lines = clean.length === 0 ? [''] : clean.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  const totalLines = lines.length;

  const hasExplicitRange = opts.lineStart !== undefined || opts.lineEnd !== undefined;
  let lineStart: number;
  let lineEnd: number;

  if (hasExplicitRange) {
    const rawStart = opts.lineStart !== undefined ? Math.trunc(opts.lineStart) : 1;
    const rawEnd = opts.lineEnd !== undefined ? Math.trunc(opts.lineEnd) : totalLines;
    lineStart = Math.min(totalLines, Math.max(1, rawStart));
    lineEnd = Math.min(totalLines, Math.max(lineStart, rawEnd));
  } else {
    const recentCount = Math.max(1, Math.trunc(opts.recentLines ?? 50));
    lineEnd = totalLines;
    lineStart = Math.max(1, lineEnd - recentCount + 1);
  }

  let selected = lines.slice(lineStart - 1, lineEnd).join('\n');
  const maxBytes = Math.max(128, Math.min(MAX_CONTEXT_CHIP_BYTES, opts.maxBytes ?? MAX_CONTEXT_CHIP_BYTES));

  if (Buffer.byteLength(selected, 'utf8') <= maxBytes && selected.length <= maxBytes) {
    return {
      cleanText: selected,
      lineStart,
      lineEnd,
      totalLines,
      truncated: false,
    };
  }

  if (hasExplicitRange) {
    const suffix = '\n... [truncated]';
    const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
    selected = `${sliceHeadWithinLimit(selected, budget)}${suffix}`;
  } else {
    const prefix = '... [truncated earlier output]\n';
    const budget = Math.max(0, maxBytes - Buffer.byteLength(prefix, 'utf8'));
    selected = `${prefix}${sliceTailWithinLimit(selected, budget)}`;
  }

  // Final safety clamp in case tiny maxBytes leaves marker over limit
  if (Buffer.byteLength(selected, 'utf8') > maxBytes || selected.length > maxBytes) {
    selected = sliceHeadWithinLimit(selected, maxBytes);
  }

  return {
    cleanText: selected,
    lineStart,
    lineEnd,
    totalLines,
    truncated: true,
  };
}

/**
 * Amortized O(1) bounded memory ring buffer for terminal streams.
 * Evicts oldest bytes once the configured cap (default 512 KiB) is exceeded.
 */
export class TerminalRingBuffer {
  private readonly chunks: Buffer[] = [];
  private _byteLength = 0;
  private _totalWrittenBytes = 0;
  private _truncated = false;

  constructor(readonly maxBytes: number = DEFAULT_RING_BUFFER_BYTES) {
    if (!Number.isFinite(maxBytes) || maxBytes < 1024) {
      throw new Error(`Invalid ring buffer capacity: ${maxBytes}`);
    }
  }

  get byteLength(): number {
    return this._byteLength;
  }

  get totalWrittenBytes(): number {
    return this._totalWrittenBytes;
  }

  get truncated(): boolean {
    return this._truncated;
  }

  push(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (buf.length === 0) return;
    this._totalWrittenBytes += buf.length;

    if (buf.length >= this.maxBytes) {
      this.chunks.length = 0;
      const tail = Buffer.from(buf.subarray(buf.length - this.maxBytes));
      this.chunks.push(tail);
      this._byteLength = tail.length;
      this._truncated = true;
      return;
    }

    this.chunks.push(Buffer.from(buf));
    this._byteLength += buf.length;

    while (this._byteLength > this.maxBytes && this.chunks.length > 0) {
      this._truncated = true;
      const excess = this._byteLength - this.maxBytes;
      const head = this.chunks[0]!;
      if (head.length <= excess) {
        this.chunks.shift();
        this._byteLength -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this._byteLength -= excess;
      }
    }
  }

  toString(): string {
    if (this._byteLength === 0) return '';
    const merged = Buffer.concat(this.chunks, this._byteLength);
    let offset = 0;
    if (this._truncated) {
      // Skip any orphaned UTF-8 continuation bytes left over after head eviction
      while (offset < merged.length && offset < 3 && (merged[offset]! & 0xc0) === 0x80) {
        offset += 1;
      }
    }
    return merged.subarray(offset).toString('utf8');
  }

  clear(): void {
    this.chunks.length = 0;
    this._byteLength = 0;
    this._truncated = false;
  }
}

const DEV_SERVER_PATTERNS: Array<{ pattern: RegExp; framework: string }> = [
  { pattern: /(?:^|\s)(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx?\s+)?vite(?:\s|$)/i, framework: 'Vite' },
  { pattern: /(?:^|\s)(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx?\s+)?next\s+dev(?:\s|$)/i, framework: 'Next.js' },
  { pattern: /(?:^|\s)(?:npx\s+|pnpm\s+|yarn\s+|bunx?\s+)?nuxt\s+dev(?:\s|$)/i, framework: 'Nuxt' },
  { pattern: /(?:^|\s)(?:npx\s+|pnpm\s+|yarn\s+|bunx?\s+)?astro\s+dev(?:\s|$)/i, framework: 'Astro' },
  { pattern: /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev(?::[a-z0-9_-]+)?(?:\s|$)/i, framework: 'Dev Server' },
  { pattern: /(?:^|\s)pytest\b.*--watch|\bptw\b/i, framework: 'Pytest Watch' },
  { pattern: /(?:^|\s)(?:npx\s+|pnpm\s+)?tsc\b.*(?:\s--watch|\s-w)(?:\s|$)/i, framework: 'TypeScript Watch' },
  { pattern: /(?:^|\s)(?:npx\s+|pnpm\s+)?vitest(?:\s+(?!run\b)|\s*$)/i, framework: 'Vitest Watch' },
  { pattern: /(?:^|\s)(?:npx\s+|pnpm\s+)?jest\b.*--watch/i, framework: 'Jest Watch' },
  { pattern: /(?:^|\s)cargo\s+watch\b/i, framework: 'Cargo Watch' },
  { pattern: /(?:^|\s)(?:nodemon|tsx\s+watch|webpack\s+serve)\b/i, framework: 'Watch Runner' },
];

export function detectDevServerHint(commandLine: string, now = Date.now()): DevServerHint | null {
  const trimmed = commandLine.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  for (const { pattern, framework } of DEV_SERVER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        command: trimmed.slice(0, 240),
        framework,
        detectedAt: now,
      };
    }
  }
  return null;
}

export interface TerminalBackendSpawnParams {
  cwd: string;
  cols: number;
  rows: number;
  shellOverride?: string;
}

export interface TerminalBackend {
  readonly kind: TerminalBackendKind;
  readonly pid: number;
  readonly shell: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  kill(): Promise<void>;
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (exitCode: number | null) => void): () => void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (ev: { exitCode: number; signal?: number }) => void): { dispose(): void };
  };
}

let cachedPtyProbe: { checked: boolean; mod: NodePtyModule | null } = {
  checked: false,
  mod: null,
};

/**
 * Dynamically probes optional `node-pty` at runtime without any native build requirement
 * or static module dependency.
 */
export function tryLoadNodePty(): NodePtyModule | null {
  if (cachedPtyProbe.checked) return cachedPtyProbe.mod;
  cachedPtyProbe.checked = true;
  try {
    const requireAnchor =
      typeof import.meta?.url === 'string' && import.meta.url
        ? import.meta.url
        : typeof __filename === 'string'
          ? __filename
          : null;
    if (!requireAnchor) {
      cachedPtyProbe.mod = null;
      return null;
    }
    const req = createRequire(requireAnchor);
    const dynamicSpecifier = ['node', 'pty'].join('-');
    const loaded = req(dynamicSpecifier) as Partial<NodePtyModule> | undefined;
    if (loaded && typeof loaded.spawn === 'function') {
      cachedPtyProbe.mod = loaded as NodePtyModule;
    } else {
      cachedPtyProbe.mod = null;
    }
  } catch {
    cachedPtyProbe.mod = null;
  }
  return cachedPtyProbe.mod;
}

export function isPtyAvailable(): boolean {
  return tryLoadNodePty() !== null;
}

function buildSanitizedTerminalEnv(cols: number, rows: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const key of DEFAULT_STRIP_ENV_KEYS) {
    delete env[key];
    if (process.platform === 'win32') {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === lower) {
          delete env[existing];
        }
      }
    }
  }
  env.TERM = env.TERM || 'xterm-256color';
  env.COLUMNS = String(cols);
  env.LINES = String(rows);
  return env;
}

function resolveWindowsPowerShell(): string {
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidate = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(candidate)) return candidate;
  return 'powershell.exe';
}

function resolveDefaultShell(override?: string): string {
  if (override?.trim()) return override.trim();
  if (process.platform === 'win32') {
    return resolveWindowsPowerShell();
  }
  const envShell = process.env.SHELL?.trim();
  if (envShell && fs.existsSync(envShell)) return envShell;
  if (fs.existsSync('/bin/bash')) return '/bin/bash';
  return '/bin/sh';
}

// Windows PowerShell 5.1 buffers `-Command -` stdin until EOF; this UTF-8 REPL loop streams immediately per line.
const PS_PIPE_REPL_SCRIPT = [
  '$utf8 = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::InputEncoding = $utf8',
  '[Console]::OutputEncoding = $utf8',
  '$OutputEncoding = $utf8',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $trimmed = $line.Trim()',
  '  if ($trimmed -eq "") { continue }',
  '  if ($trimmed -eq "exit") { break }',
  '  try {',
  '    Invoke-Expression $line | ForEach-Object {',
  '      if ($_ -is [string]) {',
  '        [Console]::Out.WriteLine($_)',
  '      } else {',
  '        [Console]::Out.WriteLine(($_ | Out-String).TrimEnd())',
  '      }',
  '    }',
  '    [Console]::Out.Flush()',
  '  } catch {',
  '    [Console]::Error.WriteLine($_.Exception.Message)',
  '    [Console]::Error.Flush()',
  '  }',
  '}',
].join('\n');
const PS_PIPE_REPL_ENCODED = Buffer.from(PS_PIPE_REPL_SCRIPT, 'utf16le').toString('base64');

class PtyTerminalBackend implements TerminalBackend {
  readonly kind: TerminalBackendKind = 'pty';
  readonly pid: number;
  readonly shell: string;
  private readonly pty: ReturnType<NodePtyModule['spawn']>;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private exited = false;

  constructor(mod: NodePtyModule, params: TerminalBackendSpawnParams) {
    this.shell = resolveDefaultShell(params.shellOverride);
    const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [];
    this.pty = mod.spawn(this.shell, args, {
      name: 'xterm-256color',
      cols: params.cols,
      rows: params.rows,
      cwd: params.cwd,
      env: buildSanitizedTerminalEnv(params.cols, params.rows),
    });
    this.pid = this.pty.pid;
    this.pty.onData((chunk) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      for (const listener of this.exitListeners) listener(exitCode ?? null);
    });
  }

  write(data: string): void {
    if (this.exited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.pty.resize(Math.max(10, cols), Math.max(4, rows));
  }

  interrupt(): void {
    if (this.exited) return;
    this.pty.write('\x03');
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    try {
      if (process.platform === 'win32' && this.pid > 0) {
        await execFileAsync('taskkill', ['/PID', String(this.pid), '/T', '/F'], {
          timeout: 4000,
          windowsHide: true,
        }).catch(() => {});
      }
    } finally {
      try {
        this.pty.kill();
      } catch {
        // already exited
      }
    }
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

export class PipeShellBackend implements TerminalBackend {
  readonly kind: TerminalBackendKind = 'pipe';
  readonly pid: number;
  readonly shell: string;
  private readonly child: ChildProcess;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private exited = false;
  private readonly exitPromise: Promise<void>;

  constructor(params: TerminalBackendSpawnParams) {
    this.shell = resolveDefaultShell(params.shellOverride);
    const isWin = process.platform === 'win32';
    const args = isWin ? ['-NoLogo', '-NoProfile', '-EncodedCommand', PS_PIPE_REPL_ENCODED] : [];

    this.child = spawn(this.shell, args, {
      cwd: params.cwd,
      env: buildSanitizedTerminalEnv(params.cols, params.rows),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin,
      windowsHide: true,
    });
    this.pid = this.child.pid ?? 0;

    this.child.stdin?.on('error', () => {
      // Prevent unhandled EPIPE when closing while writing
    });

    const emitData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (!text) return;
      for (const listener of this.dataListeners) {
        try {
          listener(text);
        } catch {
          // isolate subscriber error
        }
      }
    };

    this.child.stdout?.on('data', emitData);
    this.child.stderr?.on('data', emitData);

    this.exitPromise = new Promise<void>((resolve) => {
      const settle = (code: number | null) => {
        if (this.exited) return;
        this.exited = true;
        for (const listener of this.exitListeners) {
          try {
            listener(code);
          } catch {
            // isolate listener error
          }
        }
        resolve();
      };
      this.child.on('error', (err) => {
        emitData(`\r\n[terminal spawn error] ${err.message}\r\n`);
        settle(-1);
      });
      this.child.on('close', (code) => {
        settle(code ?? 0);
      });
    });
  }

  write(data: string): void {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return;
    let normalized = data;
    if (process.platform === 'win32' && normalized.endsWith('\r') && !normalized.endsWith('\r\n')) {
      normalized = `${normalized.slice(0, -1)}\r\n`;
    }
    try {
      this.child.stdin.write(normalized, 'utf8');
    } catch {
      // ignore closed pipe
    }
  }

  resize(_cols: number, _rows: number): void {
    // Pipe backend has no OS PTY ioctl; no-op keeps API uniform
  }

  interrupt(): void {
    if (this.exited) return;
    if (process.platform !== 'win32' && this.child.pid) {
      try {
        process.kill(-this.child.pid, 'SIGINT');
      } catch {
        try {
          this.child.kill('SIGINT');
        } catch {
          // ignore
        }
      }
    } else {
      try {
        this.child.stdin?.write('\x03\r\n', 'utf8');
      } catch {
        // ignore
      }
    }
    for (const listener of this.dataListeners) {
      try {
        listener('\r\n^C\r\n');
      } catch {
        // ignore
      }
    }
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    await killProcessTree(this.child);
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

export type TerminalOutputEvent = {
  terminalId: string;
  chunk: string;
  snapshot?: boolean;
  truncated?: boolean;
  ringBufferBytes?: number;
  timestamp: number;
};

export type TerminalStatusEvent = {
  terminal: ManagedTerminalTab;
  event: 'opened' | 'updated' | 'exited' | 'restarted' | 'closed';
};

type TerminalOutputListener = (event: TerminalOutputEvent) => void;
type TerminalStatusListener = (event: TerminalStatusEvent) => void;

interface ManagedTerminalEntry {
  tab: ManagedTerminalTab;
  cols: number;
  rows: number;
  backend: TerminalBackend;
  ringBuffer: TerminalRingBuffer;
  unsubData: () => void;
  unsubExit: () => void;
  outputListeners: Set<TerminalOutputListener>;
  pendingChunks: string[];
  pendingChars: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  inputLineBuffer: string;
  lastCommandLine: string | null;
  closing: boolean;
}

export interface TerminalWorkspaceServiceOptions {
  maxRingBytes?: number;
  batchFlushMs?: number;
  initialActive?: boolean;
  getGitService?: () => GitService | undefined;
  backendFactory?: (params: TerminalBackendSpawnParams) => TerminalBackend;
}

function normalizePathForCompare(target: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native?.(target) ?? fs.realpathSync(target);
  } catch {
    resolved = path.resolve(target);
  }
  const clean = path.resolve(resolved).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

function isSameOrChildPath(parentPath: string, candidatePath: string): boolean {
  const normParent = normalizePathForCompare(parentPath);
  const normCandidate = normalizePathForCompare(candidatePath);
  const rel = path.relative(normParent, normCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class TerminalWorkspaceService {
  private readonly terminals = new Map<string, ManagedTerminalEntry>();
  private readonly statusListeners = new Set<TerminalStatusListener>();
  private readonly maxRingBytes: number;
  private readonly batchFlushMs: number;
  private pluginActive: boolean;
  private getGitService?: () => GitService | undefined;
  private readonly backendFactory: (params: TerminalBackendSpawnParams) => TerminalBackend;
  private titleCounter = 0;

  constructor(
    private readonly store: HarnessMateStore,
    opts: TerminalWorkspaceServiceOptions = {},
  ) {
    this.maxRingBytes = Math.max(4_096, opts.maxRingBytes ?? DEFAULT_RING_BUFFER_BYTES);
    this.batchFlushMs = Math.max(4, opts.batchFlushMs ?? DEFAULT_BATCH_FLUSH_MS);
    this.pluginActive = opts.initialActive ?? true;
    this.getGitService = opts.getGitService;
    this.backendFactory =
      opts.backendFactory ??
      ((params) => {
        const ptyMod = tryLoadNodePty();
        if (ptyMod) {
          try {
            return new PtyTerminalBackend(ptyMod, params);
          } catch {
            // Seamlessly fall back to piped shell when native PTY initialization fails at runtime
          }
        }
        return new PipeShellBackend(params);
      });
  }

  attachGitService(getGitService: () => GitService | undefined): void {
    this.getGitService = getGitService;
  }

  setPluginActive(active: boolean): void {
    this.pluginActive = active;
  }

  isPluginActive(): boolean {
    return this.pluginActive;
  }

  isPtyAvailable(): boolean {
    return isPtyAvailable();
  }

  private assertActive(): void {
    if (!this.pluginActive) {
      throw new TerminalWorkspaceError(
        'E_PLUGIN_DISABLED',
        '集成终端与上下文插件当前未启用，请先在插件管理中启用。',
      );
    }
  }

  /**
   * Validates that requested CWD exists and resides inside either the workspace root,
   * one of its session directories, or an active Git worktree for that workspace.
   */
  async validateAuthorizedCwd(workspaceId: string, requestedCwd?: string): Promise<string> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      throw new TerminalWorkspaceError('E_WORKSPACE_NOT_FOUND', `工作区不存在: ${workspaceId}`);
    }

    const candidate = path.resolve(requestedCwd?.trim() || workspace.rootPath);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      throw new TerminalWorkspaceError(
        'E_INVALID_CWD',
        `终端工作目录不存在或不是有效文件夹: ${candidate}`,
      );
    }

    const allowedRoots = new Set<string>([path.resolve(workspace.rootPath)]);
    for (const s of this.store.listSessions({ workspaceId, includeArchived: true })) {
      if (s.cwd) allowedRoots.add(path.resolve(s.cwd));
    }
    const git = this.getGitService?.();
    if (workspace.isGitRepo && git) {
      try {
        const worktrees = await git.listWorktrees(workspace.rootPath);
        for (const wt of worktrees) {
          if (wt.path) allowedRoots.add(path.resolve(wt.path));
        }
      } catch {
        // Fallback cleanly to workspace root and session CWDs if git inspection fails
      }
    }

    const authorized = [...allowedRoots].some((root) => isSameOrChildPath(root, candidate));
    if (!authorized) {
      throw new TerminalWorkspaceError(
        'E_INVALID_CWD',
        `拒绝启动越界目录终端：${candidate} 不属于已授权工作区或其托管 Worktree`,
      );
    }

    try {
      return fs.realpathSync.native?.(candidate) ?? fs.realpathSync(candidate);
    } catch {
      return candidate;
    }
  }

  listTerminals(workspaceId?: string, cwdFilter?: string): ManagedTerminalTab[] {
    const results: ManagedTerminalTab[] = [];
    for (const entry of this.terminals.values()) {
      if (workspaceId && entry.tab.workspaceId !== workspaceId) continue;
      if (cwdFilter && normalizePathForCompare(entry.tab.cwd) !== normalizePathForCompare(cwdFilter)) {
        continue;
      }
      results.push(this.snapshotTab(entry));
    }
    return results.sort((a, b) => a.createdAt - b.createdAt);
  }

  getTerminal(terminalId: string): ManagedTerminalTab | null {
    const entry = this.terminals.get(terminalId);
    return entry ? this.snapshotTab(entry) : null;
  }

  getSnapshot(
    terminalId: string,
  ): { text: string; truncated: boolean; ringBufferBytes: number } | null {
    const entry = this.terminals.get(terminalId);
    if (!entry) return null;
    return {
      text: entry.ringBuffer.toString(),
      truncated: entry.ringBuffer.truncated,
      ringBufferBytes: entry.ringBuffer.byteLength,
    };
  }

  async openTerminal(
    workspaceId: string,
    opts?: {
      cwd?: string;
      title?: string;
      cols?: number;
      rows?: number;
      initialCommand?: string;
    },
  ): Promise<{ terminal: ManagedTerminalTab; snapshot: string }> {
    this.assertActive();
    const cwd = await this.validateAuthorizedCwd(workspaceId, opts?.cwd);
    const cols = Math.min(500, Math.max(10, Math.trunc(opts?.cols ?? 120)));
    const rows = Math.min(200, Math.max(4, Math.trunc(opts?.rows ?? 32)));
    const terminalId = `term_${crypto.randomBytes(6).toString('hex')}`;
    const title = opts?.title?.trim() || `Terminal #${++this.titleCounter}`;
    const createdAt = Date.now();

    const backend = this.backendFactory({ cwd, cols, rows });
    const ringBuffer = new TerminalRingBuffer(this.maxRingBytes);

    const tab: ManagedTerminalTab = {
      terminalId,
      workspaceId,
      cwd,
      title,
      shell: backend.shell,
      pid: backend.pid,
      backend: backend.kind,
      status: 'running',
      exitCode: null,
      ringBufferBytes: 0,
      devServerHint: null,
      createdAt,
    };

    const entry: ManagedTerminalEntry = {
      tab,
      cols,
      rows,
      backend,
      ringBuffer,
      unsubData: () => {},
      unsubExit: () => {},
      outputListeners: new Set(),
      pendingChunks: [],
      pendingChars: 0,
      flushTimer: null,
      inputLineBuffer: '',
      lastCommandLine: null,
      closing: false,
    };

    this.terminals.set(terminalId, entry);
    this.wireBackend(entry, backend);
    this.emitStatus(entry, 'opened');

    if (opts?.initialCommand?.trim()) {
      const cmd = opts.initialCommand.trim();
      const hint = detectDevServerHint(cmd);
      if (hint) {
        entry.tab.devServerHint = hint;
        entry.lastCommandLine = hint.command;
        this.emitStatus(entry, 'updated');
      }
      backend.write(`${cmd}${process.platform === 'win32' ? '\r\n' : '\n'}`);
    }

    return {
      terminal: this.snapshotTab(entry),
      snapshot: entry.ringBuffer.toString(),
    };
  }

  writeInput(terminalId: string, data: string): void {
    this.assertActive();
    const entry = this.requireEntry(terminalId);
    if (entry.tab.status !== 'running') {
      throw new TerminalWorkspaceError('E_TERMINAL_EXITED', '终端已退出，请先重启终端');
    }
    this.trackCommandLineInput(entry, data);
    entry.backend.write(data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    const entry = this.requireEntry(terminalId);
    entry.cols = Math.min(500, Math.max(10, Math.trunc(cols)));
    entry.rows = Math.min(200, Math.max(4, Math.trunc(rows)));
    if (entry.tab.status === 'running') {
      entry.backend.resize(entry.cols, entry.rows);
    }
  }

  async interruptTerminal(terminalId: string): Promise<ManagedTerminalTab> {
    const entry = this.requireEntry(terminalId);
    if (entry.tab.status === 'running') {
      entry.inputLineBuffer = '';
      if (entry.tab.devServerHint) {
        entry.tab.devServerHint = null;
        this.emitStatus(entry, 'updated');
      }
      entry.backend.interrupt();
    }
    return this.snapshotTab(entry);
  }

  async restartTerminal(terminalId: string): Promise<ManagedTerminalTab> {
    this.assertActive();
    const entry = this.requireEntry(terminalId);
    const replayCommand = entry.tab.devServerHint?.command ?? entry.lastCommandLine;

    entry.closing = true;
    this.flushBatchNow(entry);
    entry.unsubData();
    entry.unsubExit();
    await entry.backend.kill();
    entry.closing = false;

    const nextBackend = this.backendFactory({
      cwd: entry.tab.cwd,
      cols: entry.cols,
      rows: entry.rows,
    });
    entry.backend = nextBackend;
    entry.tab.backend = nextBackend.kind;
    entry.tab.shell = nextBackend.shell;
    entry.tab.pid = nextBackend.pid;
    entry.tab.status = 'running';
    entry.tab.exitCode = null;
    entry.inputLineBuffer = '';
    if (replayCommand) {
      const hint = detectDevServerHint(replayCommand);
      entry.tab.devServerHint = hint;
    } else {
      entry.tab.devServerHint = null;
    }

    this.wireBackend(entry, nextBackend);
    this.pushOutputChunk(entry, '\r\n[terminal restarted]\r\n');
    this.emitStatus(entry, 'restarted');

    if (replayCommand && entry.tab.devServerHint) {
      nextBackend.write(`${replayCommand}${process.platform === 'win32' ? '\r\n' : '\n'}`);
    }

    return this.snapshotTab(entry);
  }

  async closeTerminal(terminalId: string): Promise<boolean> {
    const entry = this.terminals.get(terminalId);
    if (!entry) return false;
    entry.closing = true;
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    entry.pendingChunks.length = 0;
    entry.pendingChars = 0;
    entry.unsubData();
    entry.unsubExit();
    await entry.backend.kill();
    entry.outputListeners.clear();
    this.terminals.delete(terminalId);
    this.emitStatus(entry, 'closed');
    return true;
  }

  /**
   * Builds a sanitized, line-range-annotated <= 16KB TerminalContextChip from either
   * selected text or recent/range lines in the terminal's in-memory ring buffer.
   */
  createContextChip(
    terminalId: string,
    opts: {
      lineStart?: number;
      lineEnd?: number;
      recentLines?: number;
      selectedText?: string;
    } = {},
  ): TerminalContextChip {
    const entry = this.requireEntry(terminalId);
    this.flushBatchNow(entry);

    const hasSelection = typeof opts.selectedText === 'string' && opts.selectedText.length > 0;
    const rawSource = hasSelection ? opts.selectedText! : entry.ringBuffer.toString();
    const clipped = stripAnsiAndClip(rawSource, {
      lineStart: opts.lineStart,
      lineEnd: opts.lineEnd,
      recentLines: hasSelection && opts.lineStart === undefined ? undefined : opts.recentLines ?? 50,
      maxBytes: MAX_CONTEXT_CHIP_BYTES,
    });

    return {
      id: `tchip_${crypto.randomBytes(5).toString('hex')}`,
      terminalId: entry.tab.terminalId,
      terminalTitle: entry.tab.title,
      cwd: entry.tab.cwd,
      lineStart: clipped.lineStart,
      lineEnd: clipped.lineEnd,
      cleanText: clipped.cleanText,
      truncated: clipped.truncated,
      exitCode: entry.tab.exitCode ?? null,
    };
  }

  subscribeOutput(terminalId: string, listener: TerminalOutputListener): () => void {
    const entry = this.terminals.get(terminalId);
    if (!entry) {
      return () => {};
    }

    this.flushBatchNow(entry);
    const snapshotText = entry.ringBuffer.toString();
    try {
      listener({
        terminalId,
        chunk: snapshotText,
        snapshot: true,
        truncated: entry.ringBuffer.truncated,
        ringBufferBytes: entry.ringBuffer.byteLength,
        timestamp: Date.now(),
      });
    } catch {
      // Isolate subscriber errors
    }

    entry.outputListeners.add(listener);
    return () => {
      entry.outputListeners.delete(listener);
    };
  }

  subscribeStatus(listener: TerminalStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  listTerminalsUsingPath(targetPath: string): ManagedTerminalTab[] {
    if (!targetPath.trim()) return [];
    const matches: ManagedTerminalTab[] = [];
    for (const entry of this.terminals.values()) {
      if (entry.tab.status === 'running' && isSameOrChildPath(targetPath, entry.tab.cwd)) {
        matches.push(this.snapshotTab(entry));
      }
    }
    return matches;
  }

  async releaseTerminalsUnderPath(
    targetPath: string,
  ): Promise<{ releasedCount: number; terminalIds: string[] }> {
    const matchingIds: string[] = [];
    for (const entry of this.terminals.values()) {
      if (isSameOrChildPath(targetPath, entry.tab.cwd)) {
        matchingIds.push(entry.tab.terminalId);
      }
    }
    for (const id of matchingIds) {
      await this.closeTerminal(id);
    }
    return {
      releasedCount: matchingIds.length,
      terminalIds: matchingIds,
    };
  }

  async closeWorkspaceTerminals(workspaceId: string): Promise<void> {
    const ids = [...this.terminals.values()]
      .filter((entry) => entry.tab.workspaceId === workspaceId)
      .map((entry) => entry.tab.terminalId);
    await Promise.all(ids.map((id) => this.closeTerminal(id)));
  }

  async onPluginDisabled(): Promise<void> {
    this.pluginActive = false;
    await this.disposeAll();
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.terminals.keys()];
    await Promise.all(ids.map((id) => this.closeTerminal(id)));
  }

  private requireEntry(terminalId: string): ManagedTerminalEntry {
    const entry = this.terminals.get(terminalId);
    if (!entry) {
      throw new TerminalWorkspaceError('E_TERMINAL_NOT_FOUND', `终端不存在或已关闭: ${terminalId}`);
    }
    return entry;
  }

  private snapshotTab(entry: ManagedTerminalEntry): ManagedTerminalTab {
    return {
      ...entry.tab,
      ringBufferBytes: entry.ringBuffer.byteLength,
      devServerHint: entry.tab.devServerHint ? { ...entry.tab.devServerHint } : null,
    };
  }

  private wireBackend(entry: ManagedTerminalEntry, backend: TerminalBackend): void {
    entry.unsubData = backend.onData((chunk) => {
      if (entry.closing) return;
      this.pushOutputChunk(entry, chunk);
    });
    entry.unsubExit = backend.onExit((exitCode) => {
      if (entry.closing || entry.backend !== backend) return;
      this.flushBatchNow(entry);
      entry.tab.status = 'exited';
      entry.tab.exitCode = exitCode;
      entry.tab.devServerHint = null;
      this.emitStatus(entry, 'exited');
    });
  }

  private pushOutputChunk(entry: ManagedTerminalEntry, chunk: string): void {
    if (!chunk) return;
    entry.ringBuffer.push(chunk);
    entry.tab.ringBufferBytes = entry.ringBuffer.byteLength;

    if (entry.outputListeners.size === 0) return;

    entry.pendingChunks.push(chunk);
    entry.pendingChars += chunk.length;

    // Under high-volume storms, cap queued coalesced chars to ring capacity so WS frames stay bounded
    while (entry.pendingChars > this.maxRingBytes && entry.pendingChunks.length > 1) {
      const dropped = entry.pendingChunks.shift()!;
      entry.pendingChars -= dropped.length;
    }

    if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        this.flushBatchNow(entry);
      }, this.batchFlushMs);
      entry.flushTimer.unref?.();
    }
  }

  private flushBatchNow(entry: ManagedTerminalEntry): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (entry.pendingChunks.length === 0) return;

    let merged = entry.pendingChunks.join('');
    entry.pendingChunks.length = 0;
    entry.pendingChars = 0;
    if (Buffer.byteLength(merged, 'utf8') > this.maxRingBytes) {
      merged = sliceTailWithinLimit(merged, this.maxRingBytes);
    }

    const frame: TerminalOutputEvent = {
      terminalId: entry.tab.terminalId,
      chunk: merged,
      truncated: entry.ringBuffer.truncated,
      ringBufferBytes: entry.ringBuffer.byteLength,
      timestamp: Date.now(),
    };
    for (const listener of entry.outputListeners) {
      try {
        listener(frame);
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  private trackCommandLineInput(entry: ManagedTerminalEntry, data: string): void {
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i]!;
      if (ch === '\x03') {
        entry.inputLineBuffer = '';
        continue;
      }
      if (ch === '\b' || ch === '\x7f') {
        entry.inputLineBuffer = entry.inputLineBuffer.slice(0, -1);
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const line = entry.inputLineBuffer.trim();
        entry.inputLineBuffer = '';
        if (line) {
          entry.lastCommandLine = line;
          const hint = detectDevServerHint(line);
          if (hint) {
            entry.tab.devServerHint = hint;
            this.emitStatus(entry, 'updated');
          }
        }
        continue;
      }
      if (entry.inputLineBuffer.length < 1024) {
        entry.inputLineBuffer += ch;
      }
    }
  }

  private emitStatus(
    entry: ManagedTerminalEntry,
    event: TerminalStatusEvent['event'],
  ): void {
    const payload: TerminalStatusEvent = {
      terminal: this.snapshotTab(entry),
      event,
    };
    for (const listener of this.statusListeners) {
      try {
        listener(payload);
      } catch {
        // Isolate listener errors
      }
    }
  }
}
