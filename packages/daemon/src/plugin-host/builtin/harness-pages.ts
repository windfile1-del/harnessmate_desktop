import { AddMcpServerRequestSchema, FailoverPolicySchema, ToggleMcpServerRequestSchema } from '@harnessmate/protocol';
import { PEER_CONTRACTS } from '@harnessmate/plugin-api';
import type { HostPluginContext } from '../runtime/lifecycle.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import type { UsageService } from '../../core/usage-service.js';
import type { McpService } from '../../core/mcp-service.js';
import type { FailoverContract } from './harness-integration.js';

export function registerUsagePage(
  ctx: HostPluginContext,
  usage: UsageService,
  plugins?: () => PluginManager,
): void {
  ctx.routes?.register('/', async (request) => {
    if (request.path === '/accounts' && request.method === 'GET') {
      return { body: { accounts: await usage.collectAccountUsage({ forceRefresh: request.query.refresh === 'true' }) } };
    }
    if (request.path === '/policy' && ['GET', 'PUT'].includes(request.method)) {
      const manager = plugins?.();
      const selection = manager?.resolveServiceSelection(PEER_CONTRACTS.sessionFailover, {
        sessionId: request.query.sessionId, workspaceId: request.query.workspaceId,
      });
      const policy = selection?.status === 'ready'
        ? manager?.host.getServiceByInstance<FailoverContract>(selection.instanceId, PEER_CONTRACTS.sessionFailover)
        : undefined;
      if (!policy) return { status: 409, body: { error: '切换策略插件不可用' } };
      if (request.method === 'GET') return { body: { policy: await policy.getPolicy() } };
      const parsed = FailoverPolicySchema.safeParse(request.body);
      if (!parsed.success) return { status: 400, body: { error: parsed.error.message } };
      return { body: { policy: await policy.setPolicy(parsed.data) } };
    }
    return { status: 404, body: { error: '页面操作不存在' } };
  });
}

export function registerMcpPage(
  ctx: HostPluginContext,
  config: McpService,
  plugins?: () => PluginManager,
): void {
  ctx.routes?.register('/', async (request) => {
    if (request.path === '/servers' && request.method === 'GET') {
      return { body: { servers: await config.listAllServers(), presets: plugins?.().listActiveMcpPresets() ?? [] } };
    }
    if (request.path === '/servers' && request.method === 'POST') {
      const parsed = AddMcpServerRequestSchema.safeParse(request.body);
      if (!parsed.success || !parsed.data.targetHarnesses.every((id) => config.supports(id))) {
        return { status: 400, body: { error: 'MCP 配置或目标 CLI 无效' } };
      }
      return { body: await config.addServer(parsed.data) };
    }
    if (request.path === '/toggle' && request.method === 'PATCH') {
      const parsed = ToggleMcpServerRequestSchema.safeParse(request.body);
      if (!parsed.success || !config.supports(parsed.data.harnessId)) {
        return { status: 400, body: { error: 'MCP 启停参数无效' } };
      }
      return { body: { result: await config.toggleServer(parsed.data) } };
    }
    if (request.path === '/remove' && request.method === 'POST') {
      const parsed = ToggleMcpServerRequestSchema.omit({ enabled: true }).safeParse(request.body);
      if (!parsed.success || !config.supports(parsed.data.harnessId)) {
        return { status: 400, body: { error: 'MCP 删除参数无效' } };
      }
      return { body: { result: await config.removeServer(parsed.data.harnessId, parsed.data.name) } };
    }
    return { status: 404, body: { error: '页面操作不存在' } };
  });
}
