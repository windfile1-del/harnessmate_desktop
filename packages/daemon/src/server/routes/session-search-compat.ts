import type { FastifyInstance } from 'fastify';
import { PluginApiError } from '@harnessmate/plugin-api';
import type { SessionSearchResponse } from '@harnessmate/protocol';
import {
  SESSION_SEARCH_CONTRACT,
  type SearchContractResult,
  type SearchEngineStatus,
  type SessionSearchQueryRequest,
  type SessionSearchQueryResult,
} from '../../core/session-search-engine.js';
import type { SessionManager } from '../../core/session-manager.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';

export interface SearchServiceCandidate {
  instanceId: string;
  pluginId: string;
  version: string;
}

export interface SearchServiceResolution {
  contract: string;
  versionRange: string;
  instanceId: string | null;
  source: 'explicit' | 'session' | 'workspace' | 'dependency' | 'composition' | 'single' | 'default' | 'none';
  status: 'ready' | 'disabled' | 'unavailable' | 'incompatible' | 'unconfigured' | 'selection_required';
  candidates: SearchServiceCandidate[];
}

export interface SessionSearchProviderProxy {
  query(req: SessionSearchQueryRequest): Promise<SearchContractResult<SessionSearchQueryResult>>;
  reindex(req?: {
    mode?: 'full' | 'incremental' | 'resume';
    jobId?: string;
    workspaceId?: string;
  }): Promise<SearchContractResult<Record<string, unknown>>>;
  getStatus?(): Promise<SearchContractResult<SearchEngineStatus>>;
  cancelReindex?(req?: { jobId?: string }): Promise<SearchContractResult<Record<string, unknown>>>;
  resumeReindex?(req?: { jobId?: string }): Promise<SearchContractResult<Record<string, unknown>>>;
}

export interface SessionSearchCompatDeps {
  pluginManager: PluginManager;
  sessionManager?: SessionManager;
  /**
   * Optional legacy fallback when no `session.search.v1` plugin is configured/active.
   * Disabled by default once B1-06 switches over to plugin-only search.
   */
  allowLegacyFallback?: boolean;
}

/**
 * Legacy direct search index call sites documented for B1-06 integration & cleanup.
 */
export const LEGACY_DIRECT_SEARCH_INDEX_CALL_SITES = [
  {
    file: 'packages/daemon/src/core/session-manager.ts',
    lines: '535-566, 665-671',
    symbol: 'getExplorerService / searchSessions / rebuildSearchIndex',
    replacement: 'Route via session-search-compat (`session.search.v1`) instead of SessionExplorerService direct store calls.',
  },
  {
    file: 'packages/daemon/src/core/session-manager.ts',
    lines: '1847-1854, 3128-3135',
    symbol: 'store.indexSearchItem (user_message / assistant_text)',
    replacement: 'Remove direct index writes; B1-03 committed session_turn_items + session_change_log drives B1-04 async projection.',
  },
  {
    file: 'packages/daemon/src/core/session-explorer-service.ts',
    lines: '199-315, 572-580, 730-738, 930-937, 1365-1373',
    symbol: 'query / enqueueIndexItem / indexSessionTurn / rebuildBacklogIndex / direct store.indexSearchItem',
    replacement: 'Delegate search & reindex to session.search.v1; drop direct FTS writes on import/fork/mergeBack/bundle.',
  },
  {
    file: 'packages/daemon/src/plugin-host/builtin/services.ts',
    lines: '358-378',
    symbol: 'hm.plugin.session-explorer builtin kernel registration (session-search)',
    replacement: 'Retire kernel session-search service in favor of bundled hm.plugin.session-search-fts peer plugin.',
  },
  {
    file: 'packages/daemon/src/db/sqlite.ts',
    lines: '553-560, 1230-1234, 2786-3000',
    symbol: 'session_search_fts / indexSearchItem / deleteSessionSearchIndex / listUnindexedTurnItems / searchSessionFts*',
    replacement: 'Search FTS index moves to per-instance storage owned by B1-04; keep read-only legacy methods only if fallback enabled.',
  },
  {
    file: 'packages/daemon/src/server/app.ts',
    lines: '661-689',
    symbol: 'GET /api/v1/search/sessions & POST /api/v1/search/reindex',
    replacement: 'Mount registerSessionSearchCompatRoutes(app, { pluginManager, sessionManager }) from session-search-compat.ts.',
  },
] as const;

type PluginManagerWithSelection = PluginManager & {
  resolveServiceSelection?: (
    contract: string,
    opts?: {
      versionRange?: string;
      sessionId?: string;
      workspaceId?: string;
      callerInstanceId?: string;
      explicitInstanceId?: string;
      allowSingleCandidate?: boolean;
    },
  ) => SearchServiceResolution;
};

/**
 * Resolves the target `session.search.v1` instance using B1-01 `resolveServiceSelection` when present,
 * or falls back cleanly to `resolveCapabilityBinding` + `listServiceProviders` on baseline hosts.
 */
export function resolveSessionSearchInstance(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; explicitInstanceId?: string },
): SearchServiceResolution {
  const pm = pluginManager as PluginManagerWithSelection;
  if (typeof pm.resolveServiceSelection === 'function') {
    return pm.resolveServiceSelection(SESSION_SEARCH_CONTRACT, {
      versionRange: '^1.0.0',
      workspaceId: opts?.workspaceId,
      explicitInstanceId: opts?.explicitInstanceId,
      allowSingleCandidate: true,
    });
  }

  const providers = pluginManager.listServiceProviders(SESSION_SEARCH_CONTRACT);
  const candidates: SearchServiceCandidate[] = providers
    .filter((p) => p.state === 'ACTIVE')
    .map((p) => ({
      instanceId: p.instanceId,
      pluginId: p.pluginId,
      version: p.version,
    }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  const installed = pluginManager.listInstalled();
  const classifyUnready = (
    instanceId: string,
    source: SearchServiceResolution['source'],
  ): SearchServiceResolution => {
    const info = installed.find((p) => (p.instanceId ?? p.id) === instanceId);
    if (info && !info.enabled) {
      return {
        contract: SESSION_SEARCH_CONTRACT,
        versionRange: '^1.0.0',
        instanceId,
        source,
        status: 'disabled',
        candidates,
      };
    }
    return {
      contract: SESSION_SEARCH_CONTRACT,
      versionRange: '^1.0.0',
      instanceId,
      source,
      status: 'unavailable',
      candidates,
    };
  };

  if (opts?.explicitInstanceId) {
    const ready = candidates.find((c) => c.instanceId === opts.explicitInstanceId);
    if (ready) {
      return {
        contract: SESSION_SEARCH_CONTRACT,
        versionRange: '^1.0.0',
        instanceId: ready.instanceId,
        source: 'explicit',
        status: 'ready',
        candidates,
      };
    }
    return classifyUnready(opts.explicitInstanceId, 'explicit');
  }

  const bound = pluginManager.resolveCapabilityBinding(SESSION_SEARCH_CONTRACT, {
    workspaceId: opts?.workspaceId,
  });
  if (bound.instanceId) {
    const ready = candidates.find((c) => c.instanceId === bound.instanceId);
    const source: SearchServiceResolution['source'] =
      bound.source === 'none' ? 'composition' : bound.source;
    if (ready) {
      return {
        contract: SESSION_SEARCH_CONTRACT,
        versionRange: '^1.0.0',
        instanceId: ready.instanceId,
        source,
        status: 'ready',
        candidates,
      };
    }
    return classifyUnready(bound.instanceId, source);
  }

  if (candidates.length === 1) {
    return {
      contract: SESSION_SEARCH_CONTRACT,
      versionRange: '^1.0.0',
      instanceId: candidates[0]!.instanceId,
      source: 'single',
      status: 'ready',
      candidates,
    };
  }

  if (candidates.length > 1) {
    return {
      contract: SESSION_SEARCH_CONTRACT,
      versionRange: '^1.0.0',
      instanceId: null,
      source: 'none',
      status: 'selection_required',
      candidates,
    };
  }

  return {
    contract: SESSION_SEARCH_CONTRACT,
    versionRange: '^1.0.0',
    instanceId: null,
    source: 'none',
    status: 'unconfigured',
    candidates,
  };
}

function getProviderProxy(
  pluginManager: PluginManager,
  instanceId: string,
): SessionSearchProviderProxy | undefined {
  return pluginManager.host.getServiceByInstance<SessionSearchProviderProxy>(
    instanceId,
    SESSION_SEARCH_CONTRACT,
  );
}

function resolutionFailureStatus(resolution: SearchServiceResolution): {
  httpStatus: number;
  code: string;
  message: string;
} {
  switch (resolution.status) {
    case 'selection_required':
      return {
        httpStatus: 409,
        code: 'E_CONFLICT',
        message: '存在多个可用搜索实例，请先选择或绑定目标实例',
      };
    case 'incompatible':
      return {
        httpStatus: 400,
        code: 'E_NOT_SUPPORTED',
        message: `搜索实例 ${resolution.instanceId ?? ''} 契约版本不兼容`,
      };
    case 'disabled':
      return {
        httpStatus: 503,
        code: 'E_SERVICE_UNAVAILABLE',
        message: `搜索实例 ${resolution.instanceId ?? ''} 已停用`,
      };
    default:
      return {
        httpStatus: 503,
        code: 'E_SERVICE_UNAVAILABLE',
        message: '当前没有可用的会话搜索实例',
      };
  }
}

function unwrapContractResult<T>(raw: SearchContractResult<T> | T): T {
  if (raw && typeof raw === 'object' && 'ok' in raw) {
    const res = raw as SearchContractResult<T>;
    if (res.ok) return res.value;
    throw new PluginApiError(
      res.error.code === 'invalid_request'
        ? 'E_INVALID_INPUT'
        : res.error.code === 'conflict'
          ? 'E_CONFLICT'
          : 'E_SERVICE_UNAVAILABLE',
      res.error.message,
    );
  }
  return raw as T;
}

export async function querySessionSearchCompat(
  deps: SessionSearchCompatDeps,
  opts: SessionSearchQueryRequest & { instanceId?: string },
): Promise<SessionSearchQueryResult & { instanceId?: string | null; resolution?: SearchServiceResolution }> {
  const resolution = resolveSessionSearchInstance(deps.pluginManager, {
    workspaceId: opts.workspaceId,
    explicitInstanceId: opts.instanceId,
  });

  if (resolution.status === 'ready' && resolution.instanceId) {
    const proxy = getProviderProxy(deps.pluginManager, resolution.instanceId);
    if (proxy && typeof proxy.query === 'function') {
      const { instanceId: _ignored, ...queryReq } = opts;
      const value = unwrapContractResult(await proxy.query(queryReq));
      return {
        ...value,
        nextOffset: value.nextOffset ?? null,
        instanceId: resolution.instanceId,
        resolution,
      };
    }
  }

  if (deps.allowLegacyFallback && deps.sessionManager) {
    const legacy: SessionSearchResponse = deps.sessionManager.searchSessions(opts);
    return {
      ...legacy,
      nextOffset: null,
      instanceId: null,
      resolution,
    };
  }

  const failure = resolutionFailureStatus(resolution);
  const err = new PluginApiError(failure.code as PluginApiError['code'], failure.message);
  throw Object.assign(err, { httpStatus: failure.httpStatus, resolution });
}

export async function reindexSessionSearchCompat(
  deps: SessionSearchCompatDeps,
  opts?: { instanceId?: string; workspaceId?: string; mode?: 'full' | 'incremental' | 'resume'; jobId?: string },
): Promise<{
  indexedCount: number;
  jobId?: string;
  status?: string;
  cursorSeq?: number;
  instanceId?: string | null;
  resolution?: SearchServiceResolution;
}> {
  const resolution = resolveSessionSearchInstance(deps.pluginManager, {
    workspaceId: opts?.workspaceId,
    explicitInstanceId: opts?.instanceId,
  });

  if (resolution.status === 'ready' && resolution.instanceId) {
    const proxy = getProviderProxy(deps.pluginManager, resolution.instanceId);
    if (proxy && typeof proxy.reindex === 'function') {
      const value = unwrapContractResult(
        await proxy.reindex({
          mode: opts?.mode ?? 'full',
          ...(opts?.jobId ? { jobId: opts.jobId } : {}),
          ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        }),
      );
      return {
        indexedCount: typeof value?.indexedCount === 'number' ? value.indexedCount : 0,
        jobId: typeof value?.jobId === 'string' ? value.jobId : undefined,
        status: typeof value?.status === 'string' ? value.status : undefined,
        cursorSeq: typeof value?.cursorSeq === 'number' ? value.cursorSeq : undefined,
        instanceId: resolution.instanceId,
        resolution,
      };
    }
  }

  if (deps.allowLegacyFallback && deps.sessionManager) {
    const legacy = await deps.sessionManager.rebuildSearchIndex();
    return { indexedCount: legacy.indexedCount, status: 'completed', instanceId: null, resolution };
  }

  const failure = resolutionFailureStatus(resolution);
  const err = new PluginApiError(failure.code as PluginApiError['code'], failure.message);
  throw Object.assign(err, { httpStatus: failure.httpStatus, resolution });
}

/**
 * Registers `/api/v1/search/sessions`, `/api/v1/search/reindex`, and companion search lifecycle
 * compatibility endpoints backed by the resolved `session.search.v1` plugin instance.
 */
export function registerSessionSearchCompatRoutes(
  app: FastifyInstance,
  deps: SessionSearchCompatDeps,
): void {
  const sendCompatError = (reply: { code: (s: number) => { send: (body: unknown) => unknown } }, err: unknown) => {
    const withStatus = err as { httpStatus?: number; resolution?: SearchServiceResolution; code?: string; message?: string };
    const status =
      typeof withStatus?.httpStatus === 'number'
        ? withStatus.httpStatus
        : err instanceof PluginApiError
          ? err.code === 'E_CONFLICT'
            ? 409
            : err.code === 'E_SERVICE_UNAVAILABLE'
              ? 503
              : 400
          : 500;
    return reply.code(status).send({
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof PluginApiError ? err.code : 'E_SERVICE_UNAVAILABLE',
      ...(withStatus?.resolution ? { resolution: withStatus.resolution } : {}),
    });
  };

  app.get('/api/v1/search/sessions', async (request, reply) => {
    const q = request.query as {
      q?: string;
      workspaceId?: string;
      driverId?: string;
      fromTs?: string;
      toTs?: string;
      limit?: string;
      offset?: string;
      instanceId?: string;
      forceLikeFallback?: string;
    };
    const fromTs = q.fromTs !== undefined && q.fromTs !== '' ? Number(q.fromTs) : undefined;
    const toTs = q.toTs !== undefined && q.toTs !== '' ? Number(q.toTs) : undefined;
    const limit = q.limit !== undefined && q.limit !== '' ? Number(q.limit) : 25;
    const offset = q.offset !== undefined && q.offset !== '' ? Number(q.offset) : 0;

    try {
      return await querySessionSearchCompat(deps, {
        q: q.q ?? '',
        workspaceId: q.workspaceId || undefined,
        driverId: q.driverId || undefined,
        fromTs: Number.isFinite(fromTs) ? fromTs : undefined,
        toTs: Number.isFinite(toTs) ? toTs : undefined,
        limit: Number.isFinite(limit) ? limit : 25,
        offset: Number.isFinite(offset) ? offset : 0,
        instanceId: q.instanceId || undefined,
        forceLikeFallback: q.forceLikeFallback === 'true' || q.forceLikeFallback === '1',
      });
    } catch (err) {
      return sendCompatError(reply, err);
    }
  });

  app.post('/api/v1/search/reindex', async (request, reply) => {
    const body = (request.body ?? {}) as {
      instanceId?: string;
      workspaceId?: string;
      mode?: 'full' | 'incremental' | 'resume';
      jobId?: string;
    };
    try {
      return await reindexSessionSearchCompat(deps, {
        instanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
        workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
        mode: body.mode === 'incremental' || body.mode === 'resume' ? body.mode : 'full',
        jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
      });
    } catch (err) {
      return sendCompatError(reply, err);
    }
  });

  app.get('/api/v1/search/status', async (request, reply) => {
    const q = request.query as { workspaceId?: string; instanceId?: string };
    const resolution = resolveSessionSearchInstance(deps.pluginManager, {
      workspaceId: q.workspaceId || undefined,
      explicitInstanceId: q.instanceId || undefined,
    });
    if (resolution.status !== 'ready' || !resolution.instanceId) {
      return { resolution, status: null };
    }
    const proxy = getProviderProxy(deps.pluginManager, resolution.instanceId);
    if (!proxy || typeof proxy.getStatus !== 'function') {
      return reply.code(503).send({
        error: '搜索实例不支持状态查询',
        code: 'E_NOT_SUPPORTED',
        resolution,
      });
    }
    try {
      const status = unwrapContractResult(await proxy.getStatus());
      return { resolution, status };
    } catch (err) {
      return sendCompatError(reply, err);
    }
  });

  app.post('/api/v1/search/reindex/cancel', async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: string; instanceId?: string; jobId?: string };
    const resolution = resolveSessionSearchInstance(deps.pluginManager, {
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
      explicitInstanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
    });
    if (resolution.status !== 'ready' || !resolution.instanceId) {
      const failure = resolutionFailureStatus(resolution);
      return reply.code(failure.httpStatus).send({ error: failure.message, code: failure.code, resolution });
    }
    const proxy = getProviderProxy(deps.pluginManager, resolution.instanceId);
    if (!proxy || typeof proxy.cancelReindex !== 'function') {
      return reply.code(400).send({ error: '搜索实例不支持取消重建', code: 'E_NOT_SUPPORTED', resolution });
    }
    try {
      const result = unwrapContractResult(await proxy.cancelReindex({ jobId: body.jobId }));
      return { ...result, resolution };
    } catch (err) {
      return sendCompatError(reply, err);
    }
  });

  app.post('/api/v1/search/reindex/resume', async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: string; instanceId?: string; jobId?: string };
    const resolution = resolveSessionSearchInstance(deps.pluginManager, {
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
      explicitInstanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
    });
    if (resolution.status !== 'ready' || !resolution.instanceId) {
      const failure = resolutionFailureStatus(resolution);
      return reply.code(failure.httpStatus).send({ error: failure.message, code: failure.code, resolution });
    }
    const proxy = getProviderProxy(deps.pluginManager, resolution.instanceId);
    if (!proxy || typeof proxy.resumeReindex !== 'function') {
      return reply.code(400).send({ error: '搜索实例不支持断点续跑', code: 'E_NOT_SUPPORTED', resolution });
    }
    try {
      const result = unwrapContractResult(await proxy.resumeReindex({ jobId: body.jobId }));
      return { ...result, resolution };
    } catch (err) {
      return sendCompatError(reply, err);
    }
  });
}
