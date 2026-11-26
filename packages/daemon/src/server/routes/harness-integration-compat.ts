import {
  AddMcpServerRequestSchema,
  FailoverPolicySchema,
  ToggleMcpServerRequestSchema,
} from '@harnessmate/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PluginApiError } from '@harnessmate/plugin-api';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import {
  failoverContract,
  mcpConfigContract,
  modelCatalogContract,
  selectedHarnessService,
  usageContract,
  type FailoverContract,
  type McpConfigContract,
  type ModelCatalog,
  type UsageContract,
} from '../../plugin-host/builtin/harness-integration.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';

type ServiceScope = { sessionId?: string; workspaceId?: string };

function unavailable(reply: FastifyReply, name: string) {
  return reply.code(409).send({ error: `${name}服务已停用或不可用`, code: 'E_SERVICE_UNAVAILABLE' });
}

export function registerHarnessIntegrationCompat(
  app: FastifyInstance,
  plugins: PluginManager,
  registry: HarnessRegistry,
  store: HarnessMateStore,
): void {
  const mcp = (scope?: ServiceScope) =>
    selectedHarnessService<McpConfigContract>(plugins, mcpConfigContract, scope);
  const isMcpTarget = (id: string) => ['codex', 'agy', 'claude'].includes(registry.get(id)?.kind ?? id);
  const listAfterMutation = async (service: McpConfigContract) => {
    try {
      return await service.list();
    } catch (error) {
      // A stopped provider can still return the settled write receipt.
      if (error instanceof PluginApiError && error.code === 'E_SERVICE_UNAVAILABLE') return [];
      throw error;
    }
  };

  app.get('/api/v1/mcp/servers', async (request, reply) => {
    const scope = request.query as { sessionId?: string; workspaceId?: string; harnessInstanceId?: string };
    const service = mcp(scope);
    if (!service) return unavailable(reply, 'MCP 配置');
    const session = scope.sessionId ? store.getSession(scope.sessionId) : undefined;
    if (scope.sessionId && !session) return reply.code(404).send({ error: 'Session not found' });
    const instanceId = scope.harnessInstanceId;
    if (instanceId && !isMcpTarget(instanceId)) return reply.code(400).send({ error: 'Unsupported harness for MCP listing' });
    return {
      servers: await service.list(instanceId ? [instanceId] : undefined),
      presets: plugins.listActiveMcpPresets(),
    };
  });

  app.post('/api/v1/mcp/servers', async (request, reply) => {
    const parsed = AddMcpServerRequestSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.targetHarnesses.every(isMcpTarget)) {
      return reply.code(400).send({ error: parsed.success ? 'Unsupported harness for MCP installation' : parsed.error.issues[0]?.message ?? 'Invalid MCP payload' });
    }
    const service = mcp(request.query as ServiceScope);
    if (!service) return unavailable(reply, 'MCP 配置');
    const { results } = await service.add(parsed.data);
    return { results, servers: await listAfterMutation(service) };
  });

  app.patch('/api/v1/mcp/servers/toggle', async (request, reply) => {
    const parsed = ToggleMcpServerRequestSchema.safeParse(request.body);
    if (!parsed.success || !isMcpTarget(parsed.data.harnessId)) {
      return reply.code(400).send({ error: 'Invalid MCP toggle payload' });
    }
    const service = mcp(request.query as ServiceScope);
    if (!service) return unavailable(reply, 'MCP 配置');
    const result = await service.toggle(parsed.data);
    return { result, servers: await listAfterMutation(service) };
  });

  app.delete('/api/v1/mcp/servers/:harnessId/:name', async (request, reply) => {
    const { harnessId, name } = request.params as { harnessId: string; name: string };
    if (!isMcpTarget(harnessId)) return reply.code(400).send({ error: 'Unsupported harness for MCP removal' });
    const service = mcp(request.query as ServiceScope);
    if (!service) return unavailable(reply, 'MCP 配置');
    const result = await service.remove(harnessId, name);
    return { result, servers: await listAfterMutation(service) };
  });

  app.get('/api/v1/usage/accounts', async (request, reply) => {
    const scope = request.query as ServiceScope & { refresh?: string };
    const usage = selectedHarnessService<UsageContract>(plugins, usageContract, scope);
    if (!usage) return unavailable(reply, '额度');
    return {
      accounts: await usage.listAccounts({ forceRefresh: scope.refresh === '1' || scope.refresh === 'true' }),
      collectedAt: Date.now(),
    };
  });

  const failover = (scope: ServiceScope) =>
    selectedHarnessService<FailoverContract>(plugins, failoverContract, scope);

  app.get('/api/v1/usage/failover-policy', async (request, reply) => {
    const service = failover(request.query as ServiceScope);
    return service ? { policy: await service.getPolicy() } : unavailable(reply, 'Failover ');
  });

  app.put('/api/v1/usage/failover-policy', async (request, reply) => {
    const service = failover(request.query as ServiceScope);
    if (!service) return unavailable(reply, 'Failover ');
    const parsed = FailoverPolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid failover policy' });
    return { policy: await service.setPolicy(parsed.data) };
  });

  app.get('/api/v1/sessions/:id/failover-recommendation', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const service = failover({ sessionId: id });
    if (!service) return unavailable(reply, 'Failover ');
    const { failedInstanceId, failureClass } = request.query as { failedInstanceId?: string; failureClass?: string };
    return {
      recommendation: await service.recommend({
        sessionId: id,
        failedInstanceId: failedInstanceId || session.harnessId,
        failureClass: failureClass || 'usage_limit',
      }),
    };
  });

  app.get('/api/v1/sessions/:id/model-candidates', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const { refresh } = request.query as { refresh?: string };
    const scope = { sessionId: id };
    const catalog = selectedHarnessService<ModelCatalog>(plugins, modelCatalogContract, scope);
    if (!catalog) return unavailable(reply, '模型目录');
    const data = await catalog.listModels({
      sessionId: id,
      harnessInstanceId: session.harnessId,
      refresh: refresh === '1' || refresh === 'true',
    });
    return {
      ...data,
      models: data?.models ?? [],
      harnessInstanceId: session.harnessId,
      resolution: plugins.resolveServiceSelection(modelCatalogContract, scope),
    };
  });
}
