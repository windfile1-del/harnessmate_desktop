import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PluginApiError, type PluginManifest } from '@harnessmate/plugin-api';
import {
  ImportNativeSessionRequestSchema,
  ImportSessionBundleRequestSchema,
  type DiscoveredCliSession,
  type Session,
} from '@harnessmate/protocol';
import type { HistoryImportAdapter } from '../../core/history-import-adapter.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import { isLoopbackAddress } from '../auth.js';

export const HISTORY_SESSION_DATA_PLUGIN_ID = 'core.history-session-data';
export const HISTORY_SESSION_DATA_CONTRACT = 'hm.session-data.v1';
export const HISTORY_SOURCE_CONTRACT = 'history.source.v1';
export const HISTORY_IMPORT_CONTRACT = 'history.import.v1';

export const HISTORY_SESSION_DATA_MANIFEST: PluginManifest = {
  id: HISTORY_SESSION_DATA_PLUGIN_ID,
  name: '历史会话事务与变更读模型适配器',
  version: '1.0.0',
  description: '第一批解耦期内核会话写入事务与搜索快照/变更游标只读适配器。',
  author: 'HarnessMate Core',
  category: 'workflow',
  contributes: {},
};

export function createHistorySessionDataHostPlugin(
  adapter: HistoryImportAdapter,
): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  return {
    provides: [HISTORY_SESSION_DATA_CONTRACT],
    apply(ctx) {
      ctx.provide(HISTORY_SESSION_DATA_CONTRACT, adapter.createHostService(), {
        version: '1.0.0',
        metadata: { role: 'session-data-adapter' },
      });
    },
  };
}

export interface HistoryImportCompatDeps {
  store: HarnessMateStore;
  pluginManager: PluginManager;
  adapter: HistoryImportAdapter;
}

interface HistorySourceSummaryDto {
  ref: {
    sourceInstanceId: string;
    sourceId: string;
    nativeSessionId: string;
  };
  title: string;
  harnessKind: string;
  updatedAt: number;
  workspaceHint?: {
    cwd?: string;
    label?: string;
  };
  source?: string;
  legacySource?: string;
  compatLegacySources?: string[];
  sourcePath?: string;
  fileSizeBytes?: number;
  compressed?: boolean;
  approxTurnCount?: number;
  partial?: boolean;
}

type HistorySourceDiscoverResult =
  | { ok: true; value: { sessions: HistorySourceSummaryDto[]; nextCursor: string | null } }
  | { ok: false; error: { code: string; message: string } };

type HistoryImportCallResult =
  | {
      ok: true;
      value: {
        sessionId: string;
        disposition: 'created' | 'reused';
        partial: boolean;
        warnings: string[];
        lockWarning?: string;
        mode?: 'attach' | 'mirror';
      };
    }
  | { ok: false; error: { code: string; message: string } };

interface ServiceResolutionLike {
  contract: string;
  versionRange: string;
  instanceId: string | null;
  source: string;
  status: string;
  candidates: Array<{ instanceId: string; pluginId: string; version: string }>;
}

function resolveImportInstance(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; explicitInstanceId?: string },
): ServiceResolutionLike {
  const pmWithNewResolver = pluginManager as PluginManager & {
    resolveServiceSelection?: (
      contract: string,
      options?: {
        versionRange?: string;
        workspaceId?: string;
        explicitInstanceId?: string;
        allowSingleCandidate?: boolean;
      },
    ) => ServiceResolutionLike;
  };

  if (typeof pmWithNewResolver.resolveServiceSelection === 'function') {
    return pmWithNewResolver.resolveServiceSelection(HISTORY_IMPORT_CONTRACT, {
      versionRange: '^1.0.0',
      workspaceId: opts?.workspaceId,
      explicitInstanceId: opts?.explicitInstanceId,
      allowSingleCandidate: true,
    });
  }

  const providers = pluginManager.host.listServiceProviders(HISTORY_IMPORT_CONTRACT);
  const candidates = providers.map(({ instanceId, pluginId, version }) => ({
    instanceId,
    pluginId,
    version,
  }));

  if (opts?.explicitInstanceId) {
    const ready = providers.some((p) => p.instanceId === opts.explicitInstanceId);
    if (ready) {
      return {
        contract: HISTORY_IMPORT_CONTRACT,
        versionRange: '^1.0.0',
        instanceId: opts.explicitInstanceId,
        source: 'explicit',
        status: 'ready',
        candidates,
      };
    }
    const installed = pluginManager.listInstalled().find((p) => (p.instanceId ?? p.id) === opts.explicitInstanceId);
    return {
      contract: HISTORY_IMPORT_CONTRACT,
      versionRange: '^1.0.0',
      instanceId: opts.explicitInstanceId,
      source: 'explicit',
      status: installed && !installed.enabled ? 'disabled' : 'unavailable',
      candidates,
    };
  }

  const binding = pluginManager.resolveCapabilityBinding(HISTORY_IMPORT_CONTRACT, {
    workspaceId: opts?.workspaceId,
  });
  if (binding.instanceId) {
    const ready = providers.some((p) => p.instanceId === binding.instanceId);
    const installed = pluginManager.listInstalled().find((p) => (p.instanceId ?? p.id) === binding.instanceId);
    return {
      contract: HISTORY_IMPORT_CONTRACT,
      versionRange: '^1.0.0',
      instanceId: binding.instanceId,
      source: binding.source === 'default' ? 'composition' : binding.source,
      status: ready ? 'ready' : installed && !installed.enabled ? 'disabled' : 'unavailable',
      candidates,
    };
  }

  if (candidates.length === 1) {
    return {
      contract: HISTORY_IMPORT_CONTRACT,
      versionRange: '^1.0.0',
      instanceId: candidates[0]!.instanceId,
      source: 'single',
      status: 'ready',
      candidates,
    };
  }

  return {
    contract: HISTORY_IMPORT_CONTRACT,
    versionRange: '^1.0.0',
    instanceId: null,
    source: 'none',
    status: candidates.length > 1 ? 'selection_required' : 'unconfigured',
    candidates,
  };
}

function inferLegacySource(summary: HistorySourceSummaryDto): DiscoveredCliSession['source'] {
  if (summary.legacySource) return summary.legacySource as DiscoveredCliSession['source'];
  if (summary.source) return summary.source as DiscoveredCliSession['source'];
  const sid = summary.ref.sourceId;
  if (sid === 'codex:default' || sid.startsWith('codex')) return 'codex_cli';
  if (sid === 'claude:default' || sid.startsWith('claude')) return 'claude_cli';
  if (sid === 'agy_cli:default') return 'agy_cli';
  if (sid === 'agy_desktop:default') return 'agy_desktop';
  if (summary.harnessKind === 'codex') return 'codex_cli';
  if (summary.harnessKind === 'claude') return 'claude_cli';
  if (summary.harnessKind === 'agy') return 'agy_cli';
  return 'custom';
}

function sourceProviderMatchesLegacySource(
  provider: { instanceId: string; metadata?: Record<string, unknown> },
  legacySource: string,
): boolean {
  const meta = provider.metadata ?? {};
  const ns = typeof meta.sourceNamespace === 'string' ? meta.sourceNamespace : '';
  const defaultSourceId = typeof meta.defaultSourceId === 'string' ? meta.defaultSourceId : '';
  const harnessKind = typeof meta.harnessKind === 'string' ? meta.harnessKind : '';

  if (legacySource === 'codex_cli' || legacySource === 'codex_desktop') {
    return ns === 'codex' || harnessKind === 'codex' || defaultSourceId.startsWith('codex') || provider.instanceId.includes('codex');
  }
  if (legacySource === 'claude_cli') {
    return ns === 'claude' || harnessKind === 'claude' || defaultSourceId.startsWith('claude') || provider.instanceId.includes('claude');
  }
  if (legacySource === 'agy_cli') {
    return ns === 'agy_cli' || defaultSourceId === 'agy_cli:default' || provider.instanceId.includes('agy-cli');
  }
  if (legacySource === 'agy_desktop') {
    return ns === 'agy_desktop' || defaultSourceId === 'agy_desktop:default' || provider.instanceId.includes('agy-desktop');
  }
  return true;
}

function normalizeHarnessKindForDto(raw: string): DiscoveredCliSession['harnessKind'] {
  if (raw === 'codex' || raw === 'claude' || raw === 'agy' || raw === 'acp') {
    return raw;
  }
  return 'acp';
}

async function resolveNativeRefFromSources(
  deps: HistoryImportCompatDeps,
  req: {
    source: string;
    scannerId?: string;
    nativeSessionId: string;
    sourceInstanceId?: string;
    sourceId?: string;
  },
): Promise<{
  ref: { sourceInstanceId: string; sourceId: string; nativeSessionId: string };
  summary?: HistorySourceSummaryDto;
} | null> {
  if (req.sourceInstanceId && req.sourceId) {
    return {
      ref: {
        sourceInstanceId: req.sourceInstanceId,
        sourceId: req.sourceId,
        nativeSessionId: req.nativeSessionId,
      },
    };
  }

  const providers = deps.pluginManager.host.listServiceProviders(HISTORY_SOURCE_CONTRACT);
  if (providers.length === 0) return null;

  const prioritized = req.scannerId
    ? [
        ...providers.filter((p) => p.instanceId === req.scannerId),
        ...providers.filter((p) => p.instanceId !== req.scannerId && sourceProviderMatchesLegacySource(p, req.source)),
      ]
    : providers.filter((p) => sourceProviderMatchesLegacySource(p, req.source));

  const searchOrder = prioritized.length > 0 ? prioritized : providers;

  for (const refresh of [false, true]) {
    for (const provider of searchOrder) {
      const svc = deps.pluginManager.host.getServiceByInstance<{
        discover?: (arg: Record<string, unknown>) => Promise<HistorySourceDiscoverResult>;
      }>(provider.instanceId, HISTORY_SOURCE_CONTRACT);
      if (!svc || typeof svc.discover !== 'function') continue;
      try {
        const res = await svc.discover({
          query: req.nativeSessionId,
          limit: 50,
          refresh,
        });
        if (!res?.ok) continue;
        const matched = res.value.sessions.find(
          (item) => item.ref.nativeSessionId === req.nativeSessionId,
        );
        if (matched) {
          return { ref: matched.ref, summary: matched };
        }
      } catch {
        // Isolate failing source providers and try remaining candidates
      }
    }
  }

  return null;
}

export async function handleDiscoveredSessionsCompat(
  deps: HistoryImportCompatDeps,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { limit: rawLimit, refresh } = request.query as { limit?: string; refresh?: string };
  const limit = Number(rawLimit ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return reply.code(400).send({ error: 'Invalid history list limit' });
  }
  const forceRefresh = refresh === '1' || refresh === 'true';

  const providers = deps.pluginManager.host.listServiceProviders(HISTORY_SOURCE_CONTRACT);
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const svc = deps.pluginManager.host.getServiceByInstance<{
        discover?: (arg: Record<string, unknown>) => Promise<HistorySourceDiscoverResult>;
      }>(provider.instanceId, HISTORY_SOURCE_CONTRACT);
      if (!svc || typeof svc.discover !== 'function') return [];
      const res = await svc.discover({ limit: limit + 1, refresh: forceRefresh });
      if (!res?.ok) return [];
      return res.value.sessions;
    }),
  );

  const collected: DiscoveredCliSession[] = [];
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue;
    for (const summary of item.value) {
      const mapping = deps.adapter.lookupNativeMapping({
        sourceId: summary.ref.sourceId,
        nativeSessionId: summary.ref.nativeSessionId,
        compatLegacySources: summary.compatLegacySources,
      });
      collected.push({
        harnessKind: normalizeHarnessKindForDto(summary.harnessKind),
        source: inferLegacySource(summary),
        scannerId: summary.ref.sourceInstanceId,
        nativeSessionId: summary.ref.nativeSessionId,
        title: summary.title,
        cwd: summary.workspaceHint?.cwd ?? null,
        updatedAt: summary.updatedAt,
        ...(summary.sourcePath ? { sourcePath: summary.sourcePath } : {}),
        ...(typeof summary.fileSizeBytes === 'number' ? { fileSizeBytes: summary.fileSizeBytes } : {}),
        ...(typeof summary.compressed === 'boolean' ? { compressed: summary.compressed } : {}),
        ...(typeof summary.approxTurnCount === 'number' ? { approxTurnCount: summary.approxTurnCount } : {}),
        ...(typeof summary.partial === 'boolean' ? { partial: summary.partial } : {}),
        alreadyImportedSessionId: mapping.existingSessionId,
      });
    }
  }

  collected.sort((a, b) => b.updatedAt - a.updatedAt);
  const counts = new Map<string, number>();
  const sessions = collected.filter((item) => {
    const key = item.scannerId ?? item.source ?? item.harnessKind;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= limit;
  });

  return {
    sessions,
    hasMore: limit < 1000 && collected.length > sessions.length,
  };
}

export async function handleImportNativeSessionCompat(
  deps: HistoryImportCompatDeps,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return reply.code(403).send({ error: 'Native history import is local only' });
  }
  const parsed = ImportNativeSessionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid history import request' });
  }

  const rawBody = (request.body ?? {}) as Record<string, unknown>;
  const explicitInstanceId =
    typeof rawBody.importInstanceId === 'string' && rawBody.importInstanceId.trim()
      ? rawBody.importInstanceId.trim()
      : undefined;
  const resolution = resolveImportInstance(deps.pluginManager, {
    workspaceId: parsed.data.workspaceId,
    explicitInstanceId,
  });

  if (resolution.status !== 'ready' || !resolution.instanceId) {
    return reply.code(503).send({
      error: '历史导入插件当前不可用',
      code: 'E_SERVICE_UNAVAILABLE',
      resolution,
    });
  }

  const importSvc = deps.pluginManager.host.getServiceByInstance<{
    import?: (arg: Record<string, unknown>) => Promise<HistoryImportCallResult>;
  }>(resolution.instanceId, HISTORY_IMPORT_CONTRACT);
  if (!importSvc || typeof importSvc.import !== 'function') {
    return reply.code(503).send({
      error: '历史导入插件当前不可用',
      code: 'E_SERVICE_UNAVAILABLE',
      resolution,
    });
  }

  const resolvedRef = await resolveNativeRefFromSources(deps, {
    source: parsed.data.source,
    scannerId: parsed.data.scannerId,
    nativeSessionId: parsed.data.nativeSessionId,
    sourceInstanceId:
      typeof rawBody.sourceInstanceId === 'string' ? rawBody.sourceInstanceId : undefined,
    sourceId: typeof rawBody.sourceId === 'string' ? rawBody.sourceId : undefined,
  });
  if (!resolvedRef) {
    return reply.code(400).send({ error: '找不到此原生会话' });
  }

  const requestId =
    typeof rawBody.requestId === 'string' && rawBody.requestId.trim()
      ? rawBody.requestId.trim()
      : typeof request.headers['idempotency-key'] === 'string' && request.headers['idempotency-key'].trim()
        ? request.headers['idempotency-key'].trim()
        : `compat_${randomUUID()}`;

  try {
    const callRes = await importSvc.import({
      input: {
        kind: 'native',
        ref: resolvedRef.ref,
        mode: parsed.data.mode ?? 'attach',
        legacySource: parsed.data.source,
        ...(resolvedRef.summary
          ? {
              title: resolvedRef.summary.title,
              harnessKind: resolvedRef.summary.harnessKind,
              cwd: resolvedRef.summary.workspaceHint?.cwd ?? null,
              updatedAt: resolvedRef.summary.updatedAt,
              sourcePath: resolvedRef.summary.sourcePath,
              compatLegacySources: resolvedRef.summary.compatLegacySources,
            }
          : {}),
      },
      workspaceId: parsed.data.workspaceId,
      requestId,
    });

    if (!callRes?.ok) {
      const code = callRes?.error?.code ?? 'invalid_request';
      const status = code === 'conflict' ? 409 : 400;
      return reply.code(status).send({
        error: callRes?.error?.message ?? '历史会话导入失败',
        code: code === 'conflict' ? 'E_CONFLICT' : code,
      });
    }

    const session = deps.store.getSession(callRes.value.sessionId);
    if (!session) {
      return reply.code(500).send({ error: '导入事务已提交但未找到会话记录' });
    }
    return {
      session,
      partial: callRes.value.partial,
      ...(callRes.value.lockWarning ? { lockWarning: callRes.value.lockWarning } : {}),
      mode: callRes.value.mode ?? (parsed.data.mode ?? 'attach'),
      disposition: callRes.value.disposition,
    };
  } catch (err) {
    if (err instanceof PluginApiError) {
      const status = err.code === 'E_CONFLICT' ? 409 : err.code === 'E_SERVICE_UNAVAILABLE' ? 503 : 400;
      return reply.code(status).send({ error: err.message, code: err.code });
    }
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleImportSessionBundleCompat(
  deps: HistoryImportCompatDeps,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = ImportSessionBundleRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid session bundle payload' });
  }

  const rawBody = (request.body ?? {}) as Record<string, unknown>;
  const explicitInstanceId =
    typeof rawBody.importInstanceId === 'string' && rawBody.importInstanceId.trim()
      ? rawBody.importInstanceId.trim()
      : undefined;
  const resolution = resolveImportInstance(deps.pluginManager, {
    workspaceId: parsed.data.workspaceId,
    explicitInstanceId,
  });

  if (resolution.status !== 'ready' || !resolution.instanceId) {
    return reply.code(503).send({
      error: '历史导入插件当前不可用',
      code: 'E_SERVICE_UNAVAILABLE',
      resolution,
    });
  }

  const importSvc = deps.pluginManager.host.getServiceByInstance<{
    import?: (arg: Record<string, unknown>) => Promise<HistoryImportCallResult>;
  }>(resolution.instanceId, HISTORY_IMPORT_CONTRACT);
  if (!importSvc || typeof importSvc.import !== 'function') {
    return reply.code(503).send({
      error: '历史导入插件当前不可用',
      code: 'E_SERVICE_UNAVAILABLE',
      resolution,
    });
  }

  const requestId =
    typeof rawBody.requestId === 'string' && rawBody.requestId.trim()
      ? rawBody.requestId.trim()
      : typeof request.headers['idempotency-key'] === 'string' && request.headers['idempotency-key'].trim()
        ? request.headers['idempotency-key'].trim()
        : `compat_bundle_${randomUUID()}`;

  try {
    const callRes = await importSvc.import({
      input: {
        kind: 'bundle',
        bundle: parsed.data.bundle,
        ...(parsed.data.titleOverride ? { titleOverride: parsed.data.titleOverride } : {}),
      },
      workspaceId: parsed.data.workspaceId,
      requestId,
    });

    if (!callRes?.ok) {
      const code = callRes?.error?.code ?? 'invalid_request';
      const status = code === 'conflict' ? 409 : 400;
      return reply.code(status).send({
        error: callRes?.error?.message ?? '归档包导入失败',
        code: code === 'conflict' ? 'E_CONFLICT' : code,
      });
    }

    const session: Session | null = deps.store.getSession(callRes.value.sessionId);
    if (!session) {
      return reply.code(500).send({ error: '归档包导入已提交但未找到会话记录' });
    }
    return reply.code(201).send({ session });
  } catch (err) {
    if (err instanceof PluginApiError) {
      const status = err.code === 'E_CONFLICT' ? 409 : err.code === 'E_SERVICE_UNAVAILABLE' ? 503 : 400;
      return reply.code(status).send({ error: err.message, code: err.code });
    }
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerHistoryImportCompatRoutes(
  app: FastifyInstance,
  deps: HistoryImportCompatDeps,
): void {
  app.get('/api/v1/harnesses/discovered-sessions', (request, reply) =>
    handleDiscoveredSessionsCompat(deps, request, reply),
  );
  app.post('/api/v1/harnesses/import-session', (request, reply) =>
    handleImportNativeSessionCompat(deps, request, reply),
  );
  app.post('/api/v1/sessions/import-bundle', (request, reply) =>
    handleImportSessionBundleCompat(deps, request, reply),
  );
}
