import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ResolvedBinary {
  command: string;
  useShell: boolean;
}

/**
 * Resolves a CLI binary on Windows/macOS/Linux cleanly using native PATH traversal.
 * On Windows, prefers .exe > .cmd > .bat over .ps1 shims so stdio piping works reliably,
 * and does not depend on external where.exe availability.
 */
export async function resolveBinary(
  nameOrPath: string,
  overridePath?: string,
): Promise<string | null> {
  const candidate = overridePath?.trim() || nameOrPath.trim();
  if (!candidate) return null;

  if (path.isAbsolute(candidate) || candidate.includes(path.sep) || candidate.includes('/')) {
    if (fs.existsSync(candidate)) {
      return preferWindowsRunnable(candidate);
    }
    return null;
  }

  const rawPath = process.env.PATH || process.env.Path || '';
  const pathDirs = rawPath
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  if (process.platform === 'win32') {
    // Supplement common user CLI bin directories in case a GUI host launched with minimal PATH
    const home = process.env.USERPROFILE || '';
    const extraDirs = [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin') : '',
      home ? path.join(home, '.local', 'bin') : '',
    ].filter(Boolean);
    for (const d of extraDirs) {
      if (!pathDirs.some((p) => p.toLowerCase() === d.toLowerCase())) {
        pathDirs.push(d);
      }
    }

    const exts = ['.exe', '.cmd', '.bat', '.com', ''];
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const full = path.join(dir, candidate.toLowerCase().endsWith(ext) ? candidate : `${candidate}${ext}`);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            return preferWindowsRunnable(full);
          }
        } catch {
          // ignore inaccessible dirs
        }
      }
    }
    return null;
  }

  for (const dir of pathDirs) {
    const full = path.join(dir, candidate);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return full;
      }
    } catch {
      // ignore
    }
  }

  try {
    const { stdout } = await execFileAsync('which', [candidate], { timeout: 4000 });
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

function preferWindowsRunnable(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (/\.ps1$/i.test(filePath)) {
    const cmdPath = filePath.replace(/\.ps1$/i, '.cmd');
    if (fs.existsSync(cmdPath)) return cmdPath;
  }
  if (!/\.(exe|cmd|bat|com)$/i.test(filePath)) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      if (fs.existsSync(`${filePath}${ext}`)) return `${filePath}${ext}`;
    }
  }
  return filePath;
}

export const DEFAULT_STRIP_ENV_KEYS = [
  'HARNESSMATE_LOCAL_TOKEN',
  'HARNESSMATE_DATA_DIR',
  'HARNESSMATE_SESSION_MCP_TOKEN',
] as const;

function buildChildEnv(
  envOverrides?: Record<string, string | undefined>,
  unsetEnv?: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const deleteCaseInsensitive = (targetKey: string) => {
    if (!targetKey) return;
    delete env[targetKey];
    if (process.platform === 'win32') {
      const lower = targetKey.toLowerCase();
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === lower) {
          delete env[existing];
        }
      }
    }
  };

  for (const key of DEFAULT_STRIP_ENV_KEYS) {
    deleteCaseInsensitive(key);
  }
  if (unsetEnv) {
    for (const key of unsetEnv) {
      deleteCaseInsensitive(key);
    }
  }
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (!key) continue;
      if (value === undefined) {
        deleteCaseInsensitive(key);
      } else {
        deleteCaseInsensitive(key);
        env[key] = value;
      }
    }
  }
  return env;
}

export interface SpawnCliProcessOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  unsetEnv?: readonly string[];
  detached?: boolean;
}

export function spawnCliProcess(
  binaryPath: string,
  args: string[],
  opts: SpawnCliProcessOptions,
): ChildProcess {
  const runnable = preferWindowsRunnable(binaryPath);
  const env = buildChildEnv(opts.env, opts.unsetEnv);
  const detached = opts.detached ?? process.platform !== 'win32';

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(runnable)) {
    // Use cmd.exe /d /s /c with properly quoted arguments to avoid broken piping
    const quotedBin = quoteCmdArg(runnable);
    const quotedArgs = args.map(quoteCmdArg).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${quotedBin} ${quotedArgs}`], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(runnable, args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached,
    windowsHide: true,
  });
}

function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface ExecCliQuickOptions {
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  unsetEnv?: readonly string[];
}

export async function execCliQuick(
  binaryPath: string,
  args: string[],
  timeoutMs = 8000,
  opts: ExecCliQuickOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ stdout: '', stderr: 'Cancelled', exitCode: -1 });
      return;
    }
    const child = spawnCliProcess(binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env,
      unsetEnv: opts.unsetEnv,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const abort = () => { void killProcessTree(child); };
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.input, 'utf8');
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        opts.signal?.removeEventListener('abort', abort);
        void killProcessTree(child);
        resolve({ stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`.trim(), exitCode: -1 });
      }
    }, timeoutMs);

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', abort);
        resolve({ stdout, stderr: err.message, exitCode: -1 });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', abort);
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      }
    });
  });
}

export async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 4000,
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      const deadline = Date.now() + 400;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }
  } catch {
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited
      }
    }
  }
}

/**
 * Line-delimited JSON parser resilient to non-JSON preamble/noise lines
 * (such as opencodex wrapper notices on stdout).
 */
export class ResilientJsonLineParser {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly onJson: (obj: Record<string, unknown>) => void,
    private readonly onNoise: (line: string) => void,
  ) {}

  feed(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.processLine(rawLine);
      newlineIdx = this.buffer.indexOf('\n');
    }
  }

  flush(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) {
      this.processLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('{')) {
      this.onNoise(trimmed);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.onJson(parsed as Record<string, unknown>);
      } else {
        this.onNoise(trimmed);
      }
    } catch {
      this.onNoise(trimmed);
    }
  }
}
