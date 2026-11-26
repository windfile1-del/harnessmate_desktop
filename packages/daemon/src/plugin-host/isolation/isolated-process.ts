import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HOST_SUPPORTED_FEATURES,
  PLUGIN_API_VERSION,
  PLUGIN_RPC_PROTOCOL_VERSION,
  PluginApiError,
  pluginErrorCodes,
  type PluginErrorCode,
  type PluginHandshakeRequest,
  type PluginHandshakeResponse,
  type PluginRpcMessage,
  type PluginRpcResponse,
} from '@harnessmate/plugin-api';
import { killProcessTree } from '../../harnesses/process.js';
import { ISOLATED_RUNNER_SOURCE } from './runner-bootstrap.js';

const MAX_RPC_LINE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_CALLS = 64;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASHES_IN_WINDOW = 5;

/**
 * Tiny bootstrap stub passed via `-e` so Windows CreateProcess 32KB command-line
 * limit (`ENAMETOOLONG`) is never exceeded regardless of `ISOLATED_RUNNER_SOURCE` size.
 * Reads the bootstrap source frame from the first newline-delimited JSON line on stdin,
 * pushes any subsequent bytes back onto stdin, and evaluates the runner in-memory.
 */
const ISOLATED_BOOTSTRAP_STUB =
  "'use strict';{const ks=[];const onD=c=>{const i=c.indexOf(10);if(i<0){ks.push(c);return;}ks.push(c.subarray(0,i));process.stdin.off('data',onD);process.stdin.pause();const rest=c.subarray(i+1);if(rest.length)process.stdin.unshift(rest);const code=JSON.parse(Buffer.concat(ks).toString('utf8'));new Function('require',code)(require);};process.stdin.on('data',onD);}";

export const ISOLATED_TIMEOUTS = {
  handshake: 5_000,
  command: 10_000,
  event: 2_000,
  waterfall: 2_000,
  bail: 2_000,
  tool: 30_000,
  service: 10_000,
  dispose: 1_000,
} as const;

const validErrorCodes = new Set<string>(pluginErrorCodes);

export type IsolatedHostRpcHandler = (
  method: string,
  params: Record<string, unknown>,
  meta: { pluginId: string; instanceId?: string; runId: string },
) => Promise<unknown> | unknown;

export interface IsolatedProcessOptions {
  pluginId: string;
  instanceId?: string;
  trustedLocal?: boolean;
  packageRoot: string;
  entryRelativePath: string;
  packageDigest: string;
  config: Readonly<Record<string, unknown>>;
  bindings?: Readonly<Record<string, string>>;
  declaredPermissions: readonly string[];
  services: readonly string[];
  onRpc: IsolatedHostRpcHandler;
  onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
}

export function buildIsolatedChildEnv(options?: {
  declaredPermissions?: readonly string[];
}): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  };
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  }
  if (options?.declaredPermissions?.includes('fs:cli_histories:read')) {
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'] as const) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }
  return env;
}

export class IsolatedPluginProcess {
  readonly runId = randomUUID();
  readonly pluginId: string;
  readonly instanceId: string;
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private sequence = 0;
  private retired = false;
  private exited = false;
  private resolveExited!: () => void;
  private readonly exitedPromise: Promise<void>;
  private buffer = '';
  private stderrTail = '';
  handshakeInfo?: PluginHandshakeResponse;

  constructor(private readonly opts: IsolatedProcessOptions) {
    this.pluginId = opts.pluginId;
    this.instanceId = opts.instanceId ?? opts.pluginId;
    this.exitedPromise = new Promise<void>((resolve) => { this.resolveExited = resolve; });
    const entryFile = path.join(opts.packageRoot, opts.entryRelativePath.replace(/\\/g, '/'));
    const entryUrl = pathToFileURL(entryFile).href;
    const args = [
      ...(opts.trustedLocal ? [] : ['--permission', `--allow-fs-read=${opts.packageRoot}`]),
      '--max-old-space-size=128',
      '-e',
      ISOLATED_BOOTSTRAP_STUB,
      '--',
      entryUrl,
    ];
    this.child = spawn(process.execPath, args, {
      cwd: opts.packageRoot,
      env: buildIsolatedChildEnv({ declaredPermissions: opts.declaredPermissions }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: opts.trustedLocal && process.platform !== 'win32',
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdin?.on('error', () => {
      // Ignore EPIPE during teardown/early exit
    });
    try {
      this.child.stdin?.write(JSON.stringify(ISOLATED_RUNNER_SOURCE) + '\n');
    } catch {
      // Handled by error/exit listeners
    }
    this.child.stdout?.on('data', (chunk: string) => this.onStdoutChunk(chunk));
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.child.on('error', (error) => {
      this.rejectAllPending(error);
    });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.resolveExited();
      this.rejectAllPending(new PluginApiError('E_STALE_RUN', `插件进程已退出 (${code ?? signal ?? 'unknown'})`));
      if (!this.retired) this.opts.onExit(code, signal, this.stderrTail.trim());
    });
  }

  get alive(): boolean {
    return !this.retired && !this.exited;
  }

  async handshake(): Promise<PluginHandshakeResponse> {
    const request: PluginHandshakeRequest = {
      protocolVersion: PLUGIN_RPC_PROTOCOL_VERSION,
      pluginApi: PLUGIN_API_VERSION,
      features: HOST_SUPPORTED_FEATURES,
      trustedLocal: this.opts.trustedLocal === true,
      pluginId: this.opts.pluginId,
      instanceId: this.instanceId,
      ...(this.opts.bindings ? { bindings: this.opts.bindings } : {}),
      packageDigest: this.opts.packageDigest,
      runId: this.runId,
      config: this.opts.config,
      declaredPermissions: this.opts.declaredPermissions,
      services: this.opts.services,
    };
    const response = await this.call<PluginHandshakeResponse>(
      'host.handshake',
      request as unknown as Record<string, unknown>,
      ISOLATED_TIMEOUTS.handshake,
      this.runId,
    );
    this.handshakeInfo = response;
    return response;
  }

  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = ISOLATED_TIMEOUTS.command,
    expectedRunId?: string,
  ): Promise<T> {
    if (expectedRunId && expectedRunId !== this.runId) {
      return Promise.reject(new PluginApiError('E_STALE_RUN', '插件实例标识已过期'));
    }
    if (!this.alive || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new PluginApiError('E_STALE_RUN', '插件隔离进程不可用'));
    }
    if (this.pending.size >= MAX_PENDING_CALLS) {
      return Promise.reject(new PluginApiError('E_LIMIT_EXCEEDED', '插件并发调用数已达上限'));
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginApiError('E_TIMEOUT', `插件调用 ${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        const frame: PluginRpcMessage = { jsonrpc: '2.0', id, runId: this.runId, method, params };
        this.child.stdin!.write(JSON.stringify(frame) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}, expectedRunId?: string): boolean {
    if (expectedRunId && expectedRunId !== this.runId) return false;
    if (!this.alive || !this.child.stdin || this.child.stdin.destroyed) return false;
    try {
      const frame: PluginRpcMessage = { jsonrpc: '2.0', runId: this.runId, method, params };
      this.child.stdin.write(JSON.stringify(frame) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.retired) {
      await Promise.race([this.exitedPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      return;
    }
    if (!this.exited && this.child.stdin && !this.child.stdin.destroyed) {
      try {
        await this.call('host.dispose', {}, ISOLATED_TIMEOUTS.dispose, this.runId);
      } catch {
        // Proceed to forced termination
      }
    }
    this.retired = true;
    this.rejectAllPending(new PluginApiError('E_STALE_RUN', '插件实例已卸载'));
    if (!this.exited) {
      if (this.opts.trustedLocal) await killProcessTree(this.child);
      else this.forceKill();
      await Promise.race([this.exitedPromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    try { this.child.stdin?.end(); } catch { /* ignore */ }
  }

  /**
   * Simulates/forces an unexpected process crash (useful for reliability tests and forced recovery).
   */
  forceKill(): void {
    if (!this.exited) {
      if (this.opts.trustedLocal) void killProcessTree(this.child);
      else try { this.child.kill(); } catch { /* ignore */ }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pending.clear();
  }

  private sendResponse(id: number, runId: string, result?: unknown, error?: { code: PluginErrorCode | 'E_INTERNAL'; message: string }) {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return;
    const response: PluginRpcResponse = error
      ? { jsonrpc: '2.0', id, runId, error }
      : { jsonrpc: '2.0', id, runId, result };
    try {
      this.child.stdin.write(JSON.stringify(response) + '\n');
    } catch {
      // Pipe already closed
    }
  }

  private onStdoutChunk(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_RPC_LINE_BYTES) {
      this.buffer = '';
      this.forceKill();
      return;
    }
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: PluginRpcMessage;
    try {
      message = JSON.parse(line) as PluginRpcMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;

    if (!('method' in message)) {
      const req = this.pending.get(message.id);
      if (!req) return;
      clearTimeout(req.timer);
      this.pending.delete(message.id);
      if (message.runId !== this.runId) {
        req.reject(new PluginApiError('E_STALE_RUN', '插件响应携带过期 runId'));
        return;
      }
      if (message.error) {
        const code = validErrorCodes.has(message.error.code) ? (message.error.code as PluginErrorCode) : null;
        req.reject(code ? new PluginApiError(code, message.error.message) : new Error(message.error.message));
      } else {
        req.resolve(message.result);
      }
      return;
    }

    const id = 'id' in message ? message.id : undefined;
    if (this.retired || message.runId !== this.runId) {
      if (id !== undefined) {
        this.sendResponse(id, message.runId, undefined, { code: 'E_STALE_RUN', message: '调用来自已失效的插件实例' });
      }
      return;
    }

    void Promise.resolve()
      .then(() => this.opts.onRpc(message.method, message.params ?? {}, {
        pluginId: this.pluginId,
        instanceId: this.instanceId,
        runId: message.runId,
      }))
      .then((result) => {
        if (id !== undefined) this.sendResponse(id, this.runId, result);
      })
      .catch((error: unknown) => {
        if (id !== undefined) {
          const code = error instanceof PluginApiError ? error.code : 'E_INTERNAL';
          const text = error instanceof Error ? error.message : String(error);
          this.sendResponse(id, this.runId, undefined, { code, message: text.slice(0, 1000) });
        }
      });
  }
}

export interface CrashPolicy {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  crashWindowMs?: number;
  maxCrashesInWindow?: number;
}

export class CrashBackoffTracker {
  private readonly timestamps: number[] = [];
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly crashWindowMs: number;
  private readonly maxCrashesInWindow: number;

  constructor(policy: CrashPolicy = {}) {
    this.baseBackoffMs = policy.baseBackoffMs ?? 250;
    this.maxBackoffMs = policy.maxBackoffMs ?? 30_000;
    this.crashWindowMs = policy.crashWindowMs ?? CRASH_WINDOW_MS;
    this.maxCrashesInWindow = policy.maxCrashesInWindow ?? MAX_CRASHES_IN_WINDOW;
  }

  recordCrash(now = Date.now()): { exhausted: boolean; delayMs: number; count: number } {
    const cutoff = now - this.crashWindowMs;
    while (this.timestamps.length && this.timestamps[0]! < cutoff) this.timestamps.shift();
    this.timestamps.push(now);
    const count = this.timestamps.length;
    if (count >= this.maxCrashesInWindow) {
      return { exhausted: true, delayMs: 0, count };
    }
    const delayMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, count - 1));
    return { exhausted: false, delayMs, count };
  }

  reset(): void {
    this.timestamps.length = 0;
  }
}
