import { PluginApiError, type ServiceResolutionV1 } from '@harnessmate/plugin-api';
import type { FastifyInstance } from 'fastify';
import type { PluginManager } from '../../plugins/plugin-manager.js';

export interface ResolveServiceRouteQuery {
  contract?: string;
  versionRange?: string;
  sessionId?: string;
  workspaceId?: string;
  callerInstanceId?: string;
  explicitInstanceId?: string;
  allowSingleCandidate?: string;
}

function trimQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Registers `GET /api/v1/plugins/services/resolve` returning `ServiceResolutionV1`
 * from `PluginManager.resolveServiceSelection`.
 */
export function registerServiceResolutionRoute(
  app: FastifyInstance,
  pluginManager: PluginManager,
): void {
  app.get('/api/v1/plugins/services/resolve', async (request, reply) => {
    const q = (request.query ?? {}) as ResolveServiceRouteQuery;
    const contract = trimQuery(q.contract);
    if (!contract) {
      return reply.code(400).send({ error: '缺少服务契约名 contract', code: 'E_INVALID_INPUT' });
    }
    try {
      const allowSingle = q.allowSingleCandidate === '1' || q.allowSingleCandidate === 'true';
      const resolution: ServiceResolutionV1 = pluginManager.resolveServiceSelection(contract, {
        versionRange: trimQuery(q.versionRange),
        sessionId: trimQuery(q.sessionId),
        workspaceId: trimQuery(q.workspaceId),
        callerInstanceId: trimQuery(q.callerInstanceId),
        explicitInstanceId: trimQuery(q.explicitInstanceId),
        ...(q.allowSingleCandidate !== undefined ? { allowSingleCandidate: allowSingle } : {}),
      });
      return resolution;
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT';
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code,
      });
    }
  });
}
