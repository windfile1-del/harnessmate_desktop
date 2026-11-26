import type {
  AddMcpServerRequest,
  McpServerEntry,
  ToggleMcpServerRequest,
} from '@harnessmate/protocol';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgyAdapter } from '../harnesses/agy/agy-driver.js';
import { PluginApiError } from '@harnessmate/plugin-api';
import { CodexAppServerAdapter } from '../harnesses/codex-adapter.js';
import { execCliQuick, resolveBinary } from '../harnesses/process.js';
import type { HarnessRegistry } from '../harnesses/registry.js';

type McpCli = 'codex' | 'agy' | 'claude';
const mcpClis = ['codex', 'agy', 'claude'] as const;
const configOperations = new Map<string, Promise<unknown>>();

function canonicalConfigPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonicalConfigPath(parent), path.basename(file));
  }
}

export class McpService {
  private stopped = false;

  constructor(
    private readonly registry: HarnessRegistry,
    private readonly binaryOverrides: Record<string, string> = {},
  ) {}

  stop(): void {
    this.stopped = true;
  }

  supports(instanceId: string): boolean {
    return mcpClis.some((cli) => cli === (this.registry.get(instanceId)?.kind ?? instanceId));
  }

  private async target(instanceId: string) {
    const adapter = this.registry.get(instanceId);
    const instance = this.registry.getInstanceConfig(instanceId);
    const kind = adapter?.kind ?? instanceId;
    if (!mcpClis.some((cli) => cli === kind)) throw new Error('Unsupported harness for MCP configuration');
    const cli = kind as McpCli;
    const agy = adapter instanceof AgyAdapter ? await adapter.getLaunchContext() : undefined;
    const opts = agy?.buildEnv() ?? { env: { ...instance?.sanitizedEnv }, unsetEnv: [] };
    const env = opts.env;
    let file: string;
    if (cli === 'codex') {
      const home = instance?.homeDir || env.CODEX_HOME || (!adapter || instanceId === cli ? process.env.CODEX_HOME : undefined);
      if (home) env.CODEX_HOME = path.resolve(home);
      else if (instanceId !== cli) throw new Error('该 Codex 实例没有独立配置目录');
      file = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    } else if (cli === 'claude') {
      const home = instance?.homeDir || env.CLAUDE_CONFIG_DIR || (instanceId === cli ? process.env.CLAUDE_CONFIG_DIR : undefined);
      if (home) env.CLAUDE_CONFIG_DIR = path.resolve(home);
      else if (instanceId !== cli) throw new Error('该 Claude 实例没有独立配置目录');
      file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
    } else {
      if (!agy && instanceId !== cli) throw new Error('该 AGY 实例没有可用的配置目录');
      file = path.join(agy?.appDataPath || path.join(process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini'), 'antigravity-cli'), 'mcp_config.json');
    }
    const key = canonicalConfigPath(path.resolve(file));
    const bin = agy?.binaryPath || await resolveBinary(cli, instance?.binaryPath ?? this.binaryOverrides[cli]);
    return {
      cli,
      key: process.platform === 'win32' ? key.toLowerCase() : key,
      bin,
      run: (args: string[], timeout: number) => execCliQuick(bin!, agy?.buildCliArgs(args) ?? args, timeout, {
        ...opts,
        waitForTimeoutTermination: true,
      }),
    };
  }

  private async withConfig<T>(instanceId: string, operation: (target: Awaited<ReturnType<McpService['target']>>) => Promise<T>): Promise<T> {
    if (this.stopped) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'MCP 配置管理已停用');
    const target = await this.target(instanceId);
    if (this.stopped) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'MCP 配置管理已停用');
    const previous = configOperations.get(target.key);
    const pending = Promise.resolve(previous).catch(() => {}).then(() => operation(target));
    configOperations.set(target.key, pending);
    try {
      return await pending;
    } finally {
      if (configOperations.get(target.key) === pending) configOperations.delete(target.key);
    }
  }

  async listAllServers(instanceIds?: string[]): Promise<McpServerEntry[]> {
    const targets = instanceIds ?? [...new Set([...mcpClis, ...this.registry.listAdapters()
      .map(({ id }) => id).filter((id) => this.supports(id))])];
    return (await Promise.all(targets.map((instanceId) => this.withConfig(instanceId, async (target) => {
      if (target.cli === 'codex') return this.listCodexServers(instanceId, target);
      if (target.cli === 'agy') return this.listAgyServers(instanceId, target);
      return this.listClaudeServers(instanceId, target);
    }).catch((error: unknown) => {
      if (error instanceof PluginApiError) throw error;
      return [];
    })))).flat();
  }

  async addServer(req: AddMcpServerRequest): Promise<{
    results: Array<{ harnessId: string; ok: boolean; message: string }>;
  }> {
    const results: Array<{ harnessId: string; ok: boolean; message: string }> = [];

    for (const target of req.targetHarnesses) {
      try {
        const result = await this.withConfig(target, async ({ bin, cli, run }) => {
          if (!bin) return { ok: false, message: `${target} CLI 未安装` };
          const res = await run(buildAddMcpArgs(cli, req), 12_000);
          const output = `${res.stdout}\n${res.stderr}`.trim();
          return {
            ok: res.exitCode === 0,
            message: res.exitCode === 0 ? output || '添加成功' : output || `退出码 ${res.exitCode}`,
          };
        });
        results.push({
          harnessId: target,
          ...result,
        });
      } catch (err) {
        results.push({
          harnessId: target,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { results };
  }

  async removeServer(harnessId: string, name: string): Promise<{ ok: boolean; message: string }> {
    return this.withConfig(harnessId, async ({ bin, run }) => {
      if (!bin) return { ok: false, message: `${harnessId} CLI 未安装` };

      const res = await run(['mcp', 'remove', name], 10_000);
      const out = `${res.stdout}\n${res.stderr}`.trim();
      return {
        ok: res.exitCode === 0,
        message: out || (res.exitCode === 0 ? '已移除' : `退出码 ${res.exitCode}`),
      };
    });
  }

  async toggleServer(req: ToggleMcpServerRequest): Promise<{ ok: boolean; message: string }> {
    return this.withConfig(req.harnessId, async ({ bin, cli, run }) => {
      if (!bin) return { ok: false, message: `${req.harnessId} CLI 未安装` };

      if (cli === 'agy') {
        const action = req.enabled ? 'enable' : 'disable';
        const res = await run(['mcp', action, req.name], 10_000);
        const out = `${res.stdout}\n${res.stderr}`.trim();
        return { ok: res.exitCode === 0, message: out || (res.exitCode === 0 ? '已更新' : '更新失败') };
      }

      return {
        ok: false,
        message: `${req.harnessId} CLI 暂不支持命令行直接启停，请使用移除或重新添加。`,
      };
    });
  }

  private async listCodexServers(instanceId: string, { bin, run }: Awaited<ReturnType<McpService['target']>>): Promise<McpServerEntry[]> {
    const entries: McpServerEntry[] = [];
    const seen = new Set<string>();

    // First try live app-server mcpServerStatus/list for tool count & authStatus
    const adapter = this.registry.get(instanceId);
    const toolCountByName = new Map<string, { tools: number; authStatus: string }>();
    if (adapter instanceof CodexAppServerAdapter) {
      try {
        const snap = await adapter.probeAppServerMetadata(undefined, true);
        for (const raw of snap.mcpServers) {
          if (!raw || typeof raw !== 'object') continue;
          const rec = raw as { name?: string; authStatus?: string; tools?: Record<string, unknown> };
          if (!rec.name) continue;
          toolCountByName.set(rec.name, {
            tools: rec.tools ? Object.keys(rec.tools).length : 0,
            authStatus: String(rec.authStatus ?? 'unknown'),
          });
        }
      } catch {
        // fallback to CLI list
      }
    }

    if (bin) {
      const res = await run(['mcp', 'list'], 8000);
      for (const rawLine of res.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('Name') || line.startsWith('opencodex:')) continue;
        const cols = line.split(/\s{2,}/);
        if (cols.length < 3) continue;
        const name = cols[0]!.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const second = cols[1]!.trim();
        const isUrl = /^https?:\/\//i.test(second);
        const statusCol = cols.find((c) => /^(enabled|disabled)$/i.test(c.trim()))?.toLowerCase();
        const meta = toolCountByName.get(name);

        entries.push({
          id: `${instanceId}:${name}`,
          harnessId: instanceId,
          harnessKind: 'codex',
          name,
          transport: isUrl ? 'http' : 'stdio',
          status:
            statusCol === 'disabled'
              ? 'disabled'
              : meta?.authStatus === 'notLoggedIn'
                ? 'auth_required'
                : 'enabled',
          commandOrUrl: second,
          args: !isUrl && cols[2] && cols[2] !== '-' ? [cols[2].trim()] : undefined,
          toolCount: meta?.tools,
          authStatus: meta?.authStatus,
        });
      }
    }

    // Include any runtime/built-in Codex MCP servers reported by app-server (e.g., codex_apps)
    for (const [name, meta] of toolCountByName.entries()) {
      if (seen.has(name)) continue;
      entries.push({
        id: `${instanceId}:${name}`,
        harnessId: instanceId,
        harnessKind: 'codex',
        name,
        transport: 'unknown',
        status: meta.authStatus === 'notLoggedIn' ? 'auth_required' : 'connected',
        commandOrUrl: 'Codex Runtime MCP',
        toolCount: meta.tools,
        authStatus: meta.authStatus,
      });
    }

    return entries;
  }

  private async listAgyServers(instanceId: string, { bin, run }: Awaited<ReturnType<McpService['target']>>): Promise<McpServerEntry[]> {
    if (!bin) return [];

    const res = await run(['mcp', 'list'], 8000);
    const entries: McpServerEntry[] = [];
    for (const rawLine of res.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('NAME') || line.startsWith('No MCP')) continue;
      const cols = line.split(/\s{2,}/);
      if (cols.length < 4) continue;
      const [name, type, status, ...rest] = cols;
      if (!name) continue;
      const transport =
        type === 'stdio' || type === 'http' || type === 'sse' ? type : 'unknown';
      entries.push({
        id: `${instanceId}:${name}`,
        harnessId: instanceId,
        harnessKind: 'agy',
        name,
        transport,
        status: status === 'disabled' ? 'disabled' : 'enabled',
        commandOrUrl: rest.join(' ').trim(),
      });
    }
    return entries;
  }

  private async listClaudeServers(instanceId: string, { bin, run }: Awaited<ReturnType<McpService['target']>>): Promise<McpServerEntry[]> {
    if (!bin) return [];

    const res = await run(['mcp', 'list'], 8000);
    const entries: McpServerEntry[] = [];
    for (const rawLine of res.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /No MCP servers/i.test(line) || line.startsWith('Checking')) continue;
      // Claude format: "name: command/url - ✓ Connected" or "name: url"
      const m = line.match(/^([^:\s]+):\s+(.+?)(?:\s+-\s+(.+))?$/);
      if (!m?.[1] || !m[2]) continue;
      const name = m[1].trim();
      const cmdOrUrl = m[2].trim();
      const statusText = (m[3] ?? '').toLowerCase();
      entries.push({
        id: `${instanceId}:${name}`,
        harnessId: instanceId,
        harnessKind: 'claude',
        name,
        transport: /^https?:\/\//i.test(cmdOrUrl) ? 'http' : 'stdio',
        status: statusText.includes('connected')
          ? 'connected'
          : statusText.includes('failed') || statusText.includes('error')
            ? 'error'
            : 'enabled',
        commandOrUrl: cmdOrUrl,
      });
    }
    return entries;
  }
}

function buildAddMcpArgs(target: 'codex' | 'agy' | 'claude', req: AddMcpServerRequest): string[] {
  if (req.transport === 'http' || req.transport === 'sse') {
    if (!req.url) throw new Error('HTTP/SSE MCP 服务器需要提供 URL');
    if (target === 'codex') {
      return ['mcp', 'add', req.name, '--url', req.url];
    }
    return ['mcp', 'add', '--transport', req.transport, req.name, req.url];
  }

  if (!req.command) throw new Error('Stdio MCP 服务器需要提供可执行命令');
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(req.env ?? {})) {
    if (target === 'claude') {
      envFlags.push('-e', `${k}=${v}`);
    } else {
      envFlags.push('--env', `${k}=${v}`);
    }
  }

  if (target === 'codex') {
    return ['mcp', 'add', req.name, ...envFlags, '--', req.command, ...req.args];
  }
  return ['mcp', 'add', req.name, ...envFlags, '--', req.command, ...req.args];
}
