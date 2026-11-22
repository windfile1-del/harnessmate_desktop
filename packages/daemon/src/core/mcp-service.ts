import type {
  AddMcpServerRequest,
  McpServerEntry,
  ToggleMcpServerRequest,
} from '@harnessmate/protocol';
import { CodexAppServerAdapter } from '../harnesses/codex-adapter.js';
import { execCliQuick, resolveBinary } from '../harnesses/process.js';
import type { HarnessRegistry } from '../harnesses/registry.js';

export class McpService {
  constructor(
    private readonly registry: HarnessRegistry,
    private readonly binaryOverrides: Record<string, string> = {},
  ) {}

  async listAllServers(): Promise<McpServerEntry[]> {
    const [codexServers, agyServers, claudeServers] = await Promise.all([
      this.listCodexServers(),
      this.listAgyServers(),
      this.listClaudeServers(),
    ]);
    return [...codexServers, ...agyServers, ...claudeServers];
  }

  async addServer(req: AddMcpServerRequest): Promise<{
    results: Array<{ harnessId: string; ok: boolean; message: string }>;
  }> {
    const results: Array<{ harnessId: string; ok: boolean; message: string }> = [];

    for (const target of req.targetHarnesses) {
      try {
        const bin = await resolveBinary(target, this.binaryOverrides[target]);
        if (!bin) {
          results.push({ harnessId: target, ok: false, message: `${target} CLI 未安装` });
          continue;
        }

        const args = buildAddMcpArgs(target, req);
        const res = await execCliQuick(bin, args, 12_000);
        const output = `${res.stdout}\n${res.stderr}`.trim();
        results.push({
          harnessId: target,
          ok: res.exitCode === 0,
          message: res.exitCode === 0 ? output || '添加成功' : output || `退出码 ${res.exitCode}`,
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

  async removeServer(harnessId: 'codex' | 'agy' | 'claude', name: string): Promise<{ ok: boolean; message: string }> {
    const bin = await resolveBinary(harnessId, this.binaryOverrides[harnessId]);
    if (!bin) return { ok: false, message: `${harnessId} CLI 未安装` };

    const res = await execCliQuick(bin, ['mcp', 'remove', name], 10_000);
    const out = `${res.stdout}\n${res.stderr}`.trim();
    return {
      ok: res.exitCode === 0,
      message: out || (res.exitCode === 0 ? '已移除' : `退出码 ${res.exitCode}`),
    };
  }

  async toggleServer(req: ToggleMcpServerRequest): Promise<{ ok: boolean; message: string }> {
    const bin = await resolveBinary(req.harnessId, this.binaryOverrides[req.harnessId]);
    if (!bin) return { ok: false, message: `${req.harnessId} CLI 未安装` };

    if (req.harnessId === 'agy') {
      const action = req.enabled ? 'enable' : 'disable';
      const res = await execCliQuick(bin, ['mcp', action, req.name], 10_000);
      const out = `${res.stdout}\n${res.stderr}`.trim();
      return { ok: res.exitCode === 0, message: out || (res.exitCode === 0 ? '已更新' : '更新失败') };
    }

    return {
      ok: false,
      message: `${req.harnessId} CLI 暂不支持命令行直接启停，请使用移除或重新添加。`,
    };
  }

  private async listCodexServers(): Promise<McpServerEntry[]> {
    const entries: McpServerEntry[] = [];
    const seen = new Set<string>();

    // First try live app-server mcpServerStatus/list for tool count & authStatus
    const adapter = this.registry.get('codex');
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

    const bin = await resolveBinary('codex', this.binaryOverrides.codex);
    if (bin) {
      const res = await execCliQuick(bin, ['mcp', 'list'], 8000);
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
          id: `codex:${name}`,
          harnessId: 'codex',
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
        id: `codex:${name}`,
        harnessId: 'codex',
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

  private async listAgyServers(): Promise<McpServerEntry[]> {
    const bin = await resolveBinary('agy', this.binaryOverrides.agy);
    if (!bin) return [];

    const res = await execCliQuick(bin, ['mcp', 'list'], 8000);
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
        id: `agy:${name}`,
        harnessId: 'agy',
        harnessKind: 'agy',
        name,
        transport,
        status: status === 'disabled' ? 'disabled' : 'enabled',
        commandOrUrl: rest.join(' ').trim(),
      });
    }
    return entries;
  }

  private async listClaudeServers(): Promise<McpServerEntry[]> {
    const bin = await resolveBinary('claude', this.binaryOverrides.claude);
    if (!bin) return [];

    const res = await execCliQuick(bin, ['mcp', 'list'], 8000);
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
        id: `claude:${name}`,
        harnessId: 'claude',
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
