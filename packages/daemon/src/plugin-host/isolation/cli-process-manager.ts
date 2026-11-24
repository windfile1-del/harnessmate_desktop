import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PluginApiError, type SpawnCliSpec } from '@harnessmate/plugin-api';
import type { InstalledPluginInfo } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../../db/sqlite.js';
import { resolveBinary } from '../../harnesses/process.js';
import { GLOBAL_WORKSPACE_SCOPE, type PluginPermissionService } from '../permissions/permissions.js';

const execFileAsync = promisify(execFile);

const MAX_SPAWNED_CLI_PER_PLUGIN = 8;
const MAX_ARGS = 64;
const MAX_EXTRA_ENV_KEYS = 64;
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'OS',
] as const;

const BLOCKED_EXTRA_ENV_KEYS = new Set([
  'HARNESSMATE_LOCAL_TOKEN',
  'HARNESSMATE_SESSION_MCP_TOKEN',
  'HARNESSMATE_DATA_DIR',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
]);

function isBlockedExtraEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (BLOCKED_EXTRA_ENV_KEYS.has(upper)) return true;
  if (upper.startsWith('HARNESSMATE_')) return true;
  if (upper.startsWith('DYLD_')) return true;
  return false;
}

export function buildSanitizedCliEnv(
  extraEnv?: Record<string, string>,
  unsetEnv?: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const val = process.env[key];
    if (typeof val === 'string') {
      env[key] = val;
    }
  }
  if (extraEnv && typeof extraEnv === 'object') {
    let count = 0;
    for (const [key, value] of Object.entries(extraEnv)) {
      if (!key || typeof value !== 'string') continue;
      if (isBlockedExtraEnvKey(key)) continue;
      if (!/^[a-z_][a-z0-9_]*$/i.test(key)) continue;
      env[key] = value;
      count += 1;
      if (count >= MAX_EXTRA_ENV_KEYS) break;
    }
  }
  if (Array.isArray(unsetEnv)) {
    for (const key of unsetEnv) {
      if (typeof key === 'string' && key) {
        delete env[key];
      }
    }
  }
  return env;
}

function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function resolveSafeCwd(rootPath: string, relativePath?: string): string {
  const realRoot = fs.realpathSync(rootPath);
  if (!relativePath) return realRoot;
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new PluginApiError('E_INVALID_INPUT', '无效的工作区子目录路径');
  }
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(realRoot, cleaned);
  const relFromRoot = path.relative(realRoot, candidate);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止在工作区之外启动进程');
  }
  if (relFromRoot === '.git' || relFromRoot.startsWith(`.git${path.sep}`)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止在 .git 目录内启动进程');
  }
  if (!fs.existsSync(candidate)) {
    throw new PluginApiError('E_INVALID_INPUT', `工作区子目录不存在: ${cleaned}`);
  }
  const realTarget = fs.realpathSync(candidate);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止通过符号链接逃逸工作区');
  }
  if (!fs.statSync(realTarget).isDirectory()) {
    throw new PluginApiError('E_INVALID_INPUT', `目标路径不是目录: ${cleaned}`);
  }
  return realTarget;
}

interface ManagedCliEntry {
  processId: string;
  pluginId: string;
  runId: string;
  pid: number;
  child: ChildProcess;
  exited: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  killPromise?: Promise<void>;
  onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export class CliProcessManager {
  private readonly processes = new Map<string, ManagedCliEntry>();

  constructor(
    private readonly store: HarnessMateStore,
    private readonly permissions: PluginPermissionService,
  ) {}

  async spawn(
    plugin: InstalledPluginInfo,
    runId: string,
    spec: SpawnCliSpec,
    callbacks: {
      onOutput: (processId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
      onExit: (processId: string, code: number | null, signal: string | null) => void;
    },
  ): Promise<{ processId: string; pid: number }> {
    const command = typeof spec?.command === 'string' ? spec.command.trim() : '';
    if (!command || !COMMAND_PATTERN.test(command) || command.includes('..')) {
      throw new PluginApiError('E_INVALID_INPUT', `非法 CLI 命令名: ${String(spec?.command ?? '')}`);
    }
    if (!Array.isArray(spec.args) || spec.args.length > MAX_ARGS || spec.args.some((a) => typeof a !== 'string')) {
      throw new PluginApiError('E_INVALID_INPUT', 'CLI 参数必须为字符串数组且数量不超过 64');
    }

    let cwd: string;
    const capability = `process:spawn:${command}`;
    if (typeof spec.cwdWorkspaceId === 'string' && spec.cwdWorkspaceId) {
      const workspace = this.store.getWorkspace(spec.cwdWorkspaceId);
      if (!workspace) {
        throw new PluginApiError('E_INVALID_INPUT', `工作区不存在: ${spec.cwdWorkspaceId}`);
      }
      this.permissions.assertGranted(plugin, capability, workspace.id);
      cwd = resolveSafeCwd(workspace.rootPath, spec.cwdRelativePath);
    } else if (typeof spec.cwd === 'string' && spec.cwd.trim()) {
      const resolvedCwd = fs.existsSync(spec.cwd) ? fs.realpathSync(spec.cwd) : path.resolve(spec.cwd);
      const workspaces = this.store.listWorkspaces();
      const matchedWorkspace = workspaces.find((ws) => {
        if (!fs.existsSync(ws.rootPath)) return false;
        const realRoot = fs.realpathSync(ws.rootPath);
        const rel = path.relative(realRoot, resolvedCwd);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
      if (!matchedWorkspace) {
        throw new PluginApiError('E_PERMISSION_DENIED', '禁止在未注册的工作区之外启动进程');
      }
      if (!this.permissions.isGranted(plugin, capability, matchedWorkspace.id)) {
        this.permissions.assertGranted(plugin, capability, GLOBAL_WORKSPACE_SCOPE);
      }
      const rel = path.relative(fs.realpathSync(matchedWorkspace.rootPath), resolvedCwd);
      cwd = resolveSafeCwd(matchedWorkspace.rootPath, rel || undefined);
    } else {
      this.permissions.assertGranted(plugin, capability, GLOBAL_WORKSPACE_SCOPE);
      cwd = os.tmpdir();
    }

    const activeCount = [...this.processes.values()].filter(
      (entry) => entry.pluginId === plugin.id && entry.runId === runId && !entry.exited,
    ).length;
    if (activeCount >= MAX_SPAWNED_CLI_PER_PLUGIN) {
      throw new PluginApiError('E_LIMIT_EXCEEDED', `插件派生子进程数量已达上限 (${MAX_SPAWNED_CLI_PER_PLUGIN})`);
    }

    let binaryPath = await resolveBinary(command);
    if (!binaryPath && command === 'node') {
      binaryPath = process.execPath;
    }
    if (!binaryPath) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未找到可执行程序: ${command}`);
    }

    const env = buildSanitizedCliEnv(spec.extraEnv, spec.unsetEnv);
    const child =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)
        ? spawn(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', `${quoteCmdArg(binaryPath)} ${spec.args.map(quoteCmdArg).join(' ')}`.trim()],
            {
              cwd,
              env,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
              windowsVerbatimArguments: true,
            },
          )
        : spawn(binaryPath, spec.args, {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          });

    if (!child.pid) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `无法启动进程: ${command}`);
    }

    const processId = randomUUID();
    const entry: ManagedCliEntry = {
      processId,
      pluginId: plugin.id,
      runId,
      pid: child.pid,
      child,
      exited: false,
      onOutput: (stream, chunk) => callbacks.onOutput(processId, stream, chunk),
      onExit: (code, signal) => callbacks.onExit(processId, code, signal),
    };
    this.processes.set(processId, entry);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!entry.exited) entry.onOutput('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      if (!entry.exited) entry.onOutput('stderr', chunk);
    });
    child.stdin?.on('error', () => {
      // Ignore EPIPE when child exits before stdin completes
    });

    const finalizeExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (entry.exited) return;
      entry.exited = true;
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = undefined;
      }
      this.processes.delete(processId);
      entry.onExit(code, signal);
    };

    child.on('error', () => {
      finalizeExit(null, 'SIGKILL');
    });
    child.on('close', (code, signal) => {
      finalizeExit(code, signal);
    });

    if (typeof spec.timeoutMs === 'number' && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
      const clampedTimeout = Math.min(300_000, Math.max(100, Math.floor(spec.timeoutMs)));
      entry.timeoutTimer = setTimeout(() => {
        void this.killEntryTree(entry, 'SIGTERM');
      }, clampedTimeout);
      entry.timeoutTimer.unref();
    }

    return { processId, pid: child.pid };
  }

  writeStdin(pluginId: string, runId: string, processId: string, data: string): void {
    const entry = this.requireEntry(pluginId, runId, processId);
    if (entry.exited || !entry.child.stdin || entry.child.stdin.destroyed) {
      throw new PluginApiError('E_CONFLICT', '子进程标准输入已关闭');
    }
    entry.child.stdin.write(data, 'utf8');
  }

  closeStdin(pluginId: string, runId: string, processId: string): void {
    const entry = this.requireEntry(pluginId, runId, processId);
    if (!entry.exited && entry.child.stdin && !entry.child.stdin.destroyed) {
      entry.child.stdin.end();
    }
  }

  async kill(
    pluginId: string,
    runId: string,
    processId: string,
    signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
  ): Promise<void> {
    const entry = this.processes.get(processId);
    if (!entry) return;
    if (entry.pluginId !== pluginId || entry.runId !== runId) {
      throw new PluginApiError('E_PERMISSION_DENIED', '无权操作其他插件实例的子进程');
    }
    await this.killEntryTree(entry, signal);
  }

  async killAllForRun(pluginId: string, runId?: string): Promise<void> {
    const targets = [...this.processes.values()].filter(
      (entry) => entry.pluginId === pluginId && (!runId || entry.runId === runId),
    );
    if (targets.length === 0) return;
    await Promise.allSettled(targets.map((entry) => this.killEntryTree(entry, 'SIGKILL')));
  }

  async killAll(): Promise<void> {
    const targets = [...this.processes.values()];
    if (targets.length === 0) return;
    await Promise.allSettled(targets.map((entry) => this.killEntryTree(entry, 'SIGKILL')));
  }

  private requireEntry(pluginId: string, runId: string, processId: string): ManagedCliEntry {
    const entry = this.processes.get(processId);
    if (!entry) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `子进程不存在或已退出: ${processId}`);
    }
    if (entry.pluginId !== pluginId || entry.runId !== runId) {
      throw new PluginApiError('E_PERMISSION_DENIED', '无权访问其他插件实例的子进程');
    }
    return entry;
  }

  private killEntryTree(entry: ManagedCliEntry, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (entry.exited) return Promise.resolve();
    if (entry.killPromise) return entry.killPromise;

    entry.killPromise = (async () => {
      try {
        if (process.platform === 'win32') {
          const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
          const taskkillBin = sysRoot ? path.join(sysRoot, 'System32', 'taskkill.exe') : 'taskkill';
          await execFileAsync(taskkillBin, ['/PID', String(entry.pid), '/T', '/F'], {
            timeout: 4_000,
            windowsHide: true,
          });
        } else {
          try {
            process.kill(-entry.pid, signal);
          } catch {
            entry.child.kill(signal);
          }
          if (signal !== 'SIGKILL' && !entry.exited) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            if (!entry.exited) {
              try {
                process.kill(-entry.pid, 'SIGKILL');
              } catch {
                entry.child.kill('SIGKILL');
              }
            }
          }
        }
      } catch {
        try {
          entry.child.kill('SIGKILL');
        } catch {
          // Process already exited
        }
      }
    })();

    return entry.killPromise;
  }
}
