import type { FastifyInstance } from 'fastify';
import { isReservedServiceName, PluginApiError } from '@harnessmate/plugin-api';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import { isHostHarnessOperation } from '../../plugin-host/service-access.js';

/** The page has the same public peer-service transport as an isolated plugin. */
export function registerUiServices(app: FastifyInstance, plugins: PluginManager): void {
  app.post('/api/v1/plugin-instances/:instanceId/services/call', async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    const body = request.body as Record<string, unknown> | null;
    const pkg = plugins.getInstancePackageRoot(instanceId);
    if (!body || !pkg || !plugins.isInstanceEnabled(instanceId)
      || body.runId !== (pkg.runId ?? pkg.digest)) {
      return reply.code(409).send({ code: 'E_STALE_RUN', error: '页面实例已停止或已更新' });
    }
    const contract = typeof body.contract === 'string' ? body.contract : '';
    const method = typeof body.method === 'string' ? body.method : '';
    if (!contract || !method || isReservedServiceName(contract) || isHostHarnessOperation(contract, method)
      || ['__proto__', 'prototype', 'constructor', 'then', 'toString', 'valueOf'].includes(method)) {
      return reply.code(400).send({ code: 'E_INVALID_INPUT', error: '需要公开契约与方法' });
    }
    try {
      return await plugins.invokeServiceSelection(contract, method,
        Array.isArray(body.args) ? body.args : [], {
          callerInstanceId: instanceId,
          explicitInstanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
          workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          allowSingleCandidate: false,
        });
    } catch (error) {
      return reply.code(error instanceof PluginApiError && error.code === 'E_PLUGIN_DISABLED' ? 409 : 400)
        .send({ code: error instanceof PluginApiError ? error.code : 'E_SERVICE_UNAVAILABLE',
          error: error instanceof Error ? error.message : String(error) });
    }
  });
}
