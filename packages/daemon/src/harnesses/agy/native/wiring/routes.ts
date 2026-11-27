import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  NativeApiErrorSchema,
  NativeCommandRequestSchema,
  NativeCommandResponseSchema,
  NativeControlRequestSchema,
  NativeControlResponseSchema,
  NativeEventsQuerySchema,
  NativeEventsResponseSchema,
  NativeRequestDetailsResponseSchema,
  NativeSnapshotResponseSchema,
  NativeTimelineQuerySchema,
  NativeTimelineResponseSchema,
  NativeWorkflowResourceKindSchema,
  NativeWorkflowResourceResponseSchema,
  ResolveNativeRequestInputSchema,
  ResolveNativeRequestResponseSchema,
  asWorkflowId,
  type CapabilityDescriptor,
  type NativeApiErrorCode,
  type NativeControlTargetType,
} from '@harnessmate/protocol';
import { PluginApiError } from '@harnessmate/plugin-api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveAgyRuntimeProvider } from '../../../../core/agy-peer-router.js';
import type { SessionManager } from '../../../../core/session-manager.js';
import type { HarnessMateStore } from '../../../../db/sqlite.js';
import type { PluginManager } from '../../../../plugins/plugin-manager.js';
import type { HarnessRegistry } from '../../../registry.js';
import { isLoopbackAddress } from '../../../../server/auth.js';
import { AgyAdapter } from '../../agy-driver.js';
import { NativePersistenceError, computePayloadDigest } from './persistence.js';
import {
  AgyConsumerProvenanceError,
  assertAgyConsumerProvenance,
  mintAgyDispatchProvenance,
} from './provenance.js';
import type { AgyNativeRuntimeRegistry } from './registry.js';

export interface NativeRoutesDeps {
  readonly sessionManager: SessionManager;
  readonly harnessRegistry: HarnessRegistry;
  /** Optional direct registry for standalone unit tests; production daemon routes via `pluginManager`. */
  readonly nativeRegistry?: AgyNativeRuntimeRegistry;
  readonly pluginManager?: PluginManager;
  readonly store?: HarnessMateStore;
}

function sendNativeError(
  reply: FastifyReply,
  statusCode: number,
  code: NativeApiErrorCode,
  message: string,
  opts?: { retryable?: boolean; details?: Record<string, string | number | boolean | null> },
) {
  const body = NativeApiErrorSchema.parse({
    schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
    code,
    message,
    ...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}),
    ...(opts?.details ? { details: opts.details } : {}),
  });
  return reply.code(statusCode).send(body);
}

function checkSchemaGate(nativeRegistry: AgyNativeRuntimeRegistry, reply: FastifyReply): boolean {
  const schema = nativeRegistry.getSchemaStatus();
  if (!schema.compatible) {
    sendNativeError(
      reply,
      503,
      'NATIVE_SCHEMA_NEWER_THAN_READER',
      'Native runtime schema in database is newer than this daemon reader; native routes are closed while legacy sessions remain readable.',
      {
        retryable: false,
        details: {
          storedVersion: schema.storedVersion,
          supportedVersion: schema.supportedVersion,
        },
      },
    );
    return false;
  }
  return true;
}

function mapPeerErrorToNativeReply(
  reply: FastifyReply,
  error: { code: string; message: string },
) {
  switch (error.code) {
    case 'plugin_disabled':
    case 'E_PLUGIN_DISABLED':
      return reply.code(409).send({ code: 'E_PLUGIN_DISABLED', error: error.message });
    case 'NATIVE_SCHEMA_NEWER_THAN_READER':
      return sendNativeError(reply, 503, 'NATIVE_SCHEMA_NEWER_THAN_READER', error.message, { retryable: false });
    case 'NATIVE_RUNTIME_DISABLED':
      return sendNativeError(reply, 503, 'NATIVE_RUNTIME_DISABLED', error.message);
    case 'NOT_FOUND':
    case 'not_found':
      return sendNativeError(reply, 404, 'NOT_FOUND', error.message);
    case 'UNSUPPORTED_ACTION':
    case 'not_supported':
      return sendNativeError(reply, 422, 'UNSUPPORTED_ACTION', error.message);
    case 'CONSUMER_PROVENANCE_BLOCKED':
    case 'permission_denied':
      return sendNativeError(reply, 403, 'CONSUMER_PROVENANCE_BLOCKED', error.message);
    case 'STALE_BINDING':
      return sendNativeError(reply, 409, 'STALE_BINDING', error.message, { retryable: true });
    case 'IDEMPOTENCY_CONFLICT':
      return sendNativeError(reply, 409, 'IDEMPOTENCY_CONFLICT', error.message);
    case 'ALREADY_RESOLVED':
      return sendNativeError(reply, 409, 'ALREADY_RESOLVED', error.message);
    case 'BUSY':
      return sendNativeError(reply, 409, 'BUSY', error.message, { retryable: true });
    case 'DELIVERY_UNKNOWN':
      return sendNativeError(reply, 409, 'DELIVERY_UNKNOWN', error.message, { retryable: false });
    default:
      return sendNativeError(reply, 400, 'INVALID_REQUEST', error.message);
  }
}

function sendPeerNativePayload(reply: FastifyReply, payload: Record<string, unknown>) {
  const errObj = payload.__nativeError as
    | {
        statusCode: number;
        code: NativeApiErrorCode;
        message: string;
        retryable?: boolean;
        details?: Record<string, string | number | boolean | null>;
      }
    | undefined;
  if (errObj) {
    return sendNativeError(reply, errObj.statusCode, errObj.code, errObj.message, {
      retryable: errObj.retryable,
      details: errObj.details,
    });
  }
  if (typeof payload.statusCode === 'number' && 'body' in payload) {
    return reply.code(payload.statusCode).send(payload.body);
  }
  return payload;
}

function resolvePeerRuntimeForRoute(
  deps: NativeRoutesDeps,
  sessionId: string,
  reply: FastifyReply,
) {
  if (!deps.pluginManager) return null;
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) {
    sendNativeError(reply, 404, 'NOT_FOUND', 'Session not found');
    return { handled: true as const };
  }
  if (session.harnessKind !== 'agy') {
    sendNativeError(
      reply,
      422,
      'UNSUPPORTED_ACTION',
      'Native AGY runtime routes are only available for AGY sessions',
    );
    return { handled: true as const };
  }
  try {
    const adapter = deps.harnessRegistry.get(session.harnessId);
    const provider = resolveAgyRuntimeProvider(deps.pluginManager, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      driverProviderInstanceId: adapter?.providerInstanceId,
      store: deps.store,
      allowSingleCandidate: true,
    });
    return { handled: false as const, session, provider };
  } catch (err) {
    if (err instanceof PluginApiError && err.code === 'E_PLUGIN_DISABLED') {
      reply.code(409).send({ code: 'E_PLUGIN_DISABLED', error: err.message });
      return { handled: true as const };
    }
    sendNativeError(
      reply,
      503,
      'NATIVE_RUNTIME_DISABLED',
      err instanceof Error ? err.message : 'AGY native runtime provider is unavailable',
    );
    return { handled: true as const };
  }
}

function resolveAgySessionContext(
  deps: NativeRoutesDeps,
  sessionId: string,
  reply: FastifyReply,
) {
  if (!deps.nativeRegistry) {
    sendNativeError(reply, 503, 'NATIVE_RUNTIME_DISABLED', 'Native AGY runtime is not mounted');
    return null;
  }
  if (!checkSchemaGate(deps.nativeRegistry, reply)) return null;
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) {
    sendNativeError(reply, 404, 'NOT_FOUND', 'Session not found');
    return null;
  }
  if (session.harnessKind !== 'agy') {
    sendNativeError(
      reply,
      422,
      'UNSUPPORTED_ACTION',
      'Native AGY runtime routes are only available for AGY sessions',
    );
    return null;
  }
  const adapter = deps.harnessRegistry.get(session.harnessId);
  return {
    session,
    nativeRegistry: deps.nativeRegistry,
    adapter: adapter instanceof AgyAdapter ? adapter : null,
  };
}

function requireLocalWriteBoundary(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    sendNativeError(
      reply,
      403,
      'FORBIDDEN',
      'Native AGY write operations require local interactive desktop access; remote clients receive read-only allowlisted projections.',
    );
    return false;
  }
  return true;
}

function isControlAuthorizedByCatalog(
  descriptors: readonly CapabilityDescriptor[],
  targetType: NativeControlTargetType,
  action: string,
): boolean {
  const targetMatchesDescriptor = (descId: string): boolean => {
    switch (targetType) {
      case 'runtime':
        return ['AGY-R01', 'AGY-R10', 'agy.acp.v1', 'agy.reactive.background'].includes(descId);
      case 'activity':
      case 'work':
        return descId === 'agy.acp.v1' ||
          descId.startsWith('agy.reactive') ||
          descId.startsWith('agy.workflow.');
      case 'agent':
        return descId === 'agy.subagents' || descId.startsWith('agy.workflow.swarm');
      case 'workflow':
        return descId.startsWith('agy.workflow.');
    }
  };

  for (const desc of descriptors) {
    if (desc.control !== 'available') continue;
    if (!targetMatchesDescriptor(desc.id)) continue;
    // If the descriptor declares explicit actions, the action key must be explicitly `available`
    if (desc.actions.length > 0) {
      const matched = desc.actions.find((a) => (a.key === action || (action === 'stop' && a.key === 'cancel')) && a.gate === 'available');
      if (matched) return true;
    } else {
      return true;
    }
  }
  return false;
}

export function registerAgyNativeRoutes(app: FastifyInstance, deps: NativeRoutesDeps): void {
  // ── GET /api/v1/sessions/:id/native/snapshot ─────────────────────────
  app.get('/api/v1/sessions/:id/native/snapshot', async (request, reply) => {
    const { id } = request.params as { id: string };
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      const res = await peer.provider.service.getSnapshot({
        sessionId: peer.session.id,
        harnessId: peer.session.harnessId,
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      return res.value.snapshot;
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const projection = ctx.nativeRegistry.getProjectionForSession(
      ctx.session.id,
      ctx.session.harnessId,
    );
    return NativeSnapshotResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      contractRevision: AGY_NATIVE_CONTRACT_REVISION,
      enabled: projection.enabled,
      projection,
    });
  });

  // ── GET /api/v1/sessions/:id/native/capabilities ─────────────────────
  app.get('/api/v1/sessions/:id/native/capabilities', async (request, reply) => {
    const { id } = request.params as { id: string };
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      const res = await peer.provider.service.getCapabilities({
        sessionId: peer.session.id,
        harnessId: peer.session.harnessId,
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      return res.value.capabilities;
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    return ctx.nativeRegistry.getCapabilitiesForSession(ctx.session.id, ctx.session.harnessId);
  });

  // ── GET /api/v1/sessions/:id/native/events ───────────────────────────
  app.get('/api/v1/sessions/:id/native/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = NativeEventsQuerySchema.safeParse(request.query ?? {});
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      if (!query.success) {
        return sendNativeError(
          reply,
          400,
          'INVALID_REQUEST',
          query.error.issues[0]?.message ?? 'Invalid native events query parameters',
        );
      }
      const res = await peer.provider.service.readEvents({
        sessionId: peer.session.id,
        harnessId: peer.session.harnessId,
        afterSeq: query.data.after,
        limit: query.data.limit,
        cursor: query.data.cursor,
        generation: query.data.generation,
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      const data = res.value as {
        resyncRequired?: boolean;
        reason?: string;
        latestSeq?: number;
        currentGeneration?: string | null;
      };
      if (data.resyncRequired) {
        return sendNativeError(
          reply,
          410,
          'RESYNC_REQUIRED',
          `Native event cursor requires snapshot resync (${data.reason ?? 'cursor_invalid'})`,
          {
            retryable: true,
            details: {
              reason: data.reason ?? 'cursor_invalid',
              latestSeq: data.latestSeq ?? 0,
              currentGeneration: data.currentGeneration ?? null,
            },
          },
        );
      }
      const { stream: _stream, ...rest } = res.value;
      return rest;
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    if (!query.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        query.error.issues[0]?.message ?? 'Invalid native events query parameters',
      );
    }

    const res = ctx.nativeRegistry.readEventsForSession(ctx.session.id, ctx.session.harnessId, {
      afterSeq: query.data.after,
      limit: query.data.limit,
      cursor: query.data.cursor,
      expectedGeneration: query.data.generation,
    });

    if (res.resyncRequired) {
      return sendNativeError(
        reply,
        410,
        'RESYNC_REQUIRED',
        `Native event cursor requires snapshot resync (${res.reason})`,
        {
          retryable: true,
          details: {
            reason: res.reason,
            latestSeq: res.latestSeq,
            currentGeneration: res.currentGeneration,
          },
        },
      );
    }

    return NativeEventsResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      binding: res.binding,
      runtimeId: res.runtimeId,
      generation: res.generation,
      asOfSeq: res.asOfSeq,
      events: res.events,
      nextSeq: res.nextSeq,
      nextCursor: res.nextCursor,
      hasMore: res.hasMore,
    });
  });

  // ── GET /api/v1/sessions/:id/native/activity/:activityId/timeline ────
  app.get('/api/v1/sessions/:id/native/activity/:activityId/timeline', async (request, reply) => {
    const { id, activityId } = request.params as { id: string; activityId: string };
    const query = NativeTimelineQuerySchema.safeParse(request.query ?? {});
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      if (!query.success) {
        return sendNativeError(reply, 400, 'INVALID_REQUEST', query.error.issues[0]?.message ?? 'Invalid timeline query');
      }
      const res = await peer.provider.service.readTimeline({
        sessionId: peer.session.id,
        scopeKind: 'activity',
        scopeId: activityId,
        pageToken: query.data.pageToken,
        limit: query.data.limit,
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      return res.value;
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    if (!query.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        query.error.issues[0]?.message ?? 'Invalid timeline query',
      );
    }

    const projection = ctx.nativeRegistry.getProjectionForSession(
      ctx.session.id,
      ctx.session.harnessId,
    );
    const flags = ctx.nativeRegistry.getFeatureFlags();
    const reader = flags.enabled ? ctx.nativeRegistry.getTimelineReaderPort() : null;
    const page = reader
      ? reader.readTimeline({
          binding: projection.binding,
          scopeKind: 'activity',
          scopeId: activityId,
          pageToken: query.data.pageToken,
          limit: query.data.limit,
        })
      : {
          revision: projection.asOfSeq,
          items: [],
          nextPageToken: null,
          hasMore: false,
          sourceUnavailableReason: flags.enabled
            ? 'timeline_reader_unregistered'
            : 'native_runtime_disabled',
        };

    return NativeTimelineResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      binding: projection.binding,
      scopeKind: 'activity',
      scopeId: activityId,
      revision: page.revision,
      items: [...page.items],
      nextPageToken: page.nextPageToken,
      hasMore: page.hasMore,
      ...(page.sourceUnavailableReason
        ? { sourceUnavailableReason: page.sourceUnavailableReason }
        : {}),
    });
  });

  // ── GET /api/v1/sessions/:id/native/agents/:agentId/timeline ─────────
  app.get('/api/v1/sessions/:id/native/agents/:agentId/timeline', async (request, reply) => {
    const { id, agentId } = request.params as { id: string; agentId: string };
    const query = NativeTimelineQuerySchema.safeParse(request.query ?? {});
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      if (!query.success) {
        return sendNativeError(reply, 400, 'INVALID_REQUEST', query.error.issues[0]?.message ?? 'Invalid timeline query');
      }
      const res = await peer.provider.service.readTimeline({
        sessionId: peer.session.id,
        scopeKind: 'agent',
        scopeId: agentId,
        pageToken: query.data.pageToken,
        limit: query.data.limit,
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      return res.value;
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    if (!query.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        query.error.issues[0]?.message ?? 'Invalid timeline query',
      );
    }

    const projection = ctx.nativeRegistry.getProjectionForSession(
      ctx.session.id,
      ctx.session.harnessId,
    );
    const flags = ctx.nativeRegistry.getFeatureFlags();
    const reader = flags.enabled ? ctx.nativeRegistry.getTimelineReaderPort() : null;
    const page = reader
      ? reader.readTimeline({
          binding: projection.binding,
          scopeKind: 'agent',
          scopeId: agentId,
          pageToken: query.data.pageToken,
          limit: query.data.limit,
        })
      : {
          revision: projection.asOfSeq,
          items: [],
          nextPageToken: null,
          hasMore: false,
          sourceUnavailableReason: flags.enabled
            ? 'timeline_reader_unregistered'
            : 'native_runtime_disabled',
        };

    return NativeTimelineResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      binding: projection.binding,
      scopeKind: 'agent',
      scopeId: agentId,
      revision: page.revision,
      items: [...page.items],
      nextPageToken: page.nextPageToken,
      hasMore: page.hasMore,
      ...(page.sourceUnavailableReason
        ? { sourceUnavailableReason: page.sourceUnavailableReason }
        : {}),
    });
  });

  // ── GET /api/v1/sessions/:id/native/workflows/:workflowId/:resource ──
  app.get(
    '/api/v1/sessions/:id/native/workflows/:workflowId/:resource',
    async (request, reply) => {
      const { id, workflowId, resource } = request.params as {
        id: string;
        workflowId: string;
        resource: string;
      };
      const parsedResource = NativeWorkflowResourceKindSchema.safeParse(resource);
      const query = NativeTimelineQuerySchema.safeParse(request.query ?? {});
      const peer = resolvePeerRuntimeForRoute(deps, id, reply);
      if (peer) {
        if (peer.handled) return;
        if (!parsedResource.success) {
          return sendNativeError(reply, 400, 'INVALID_REQUEST', 'Workflow resource must be one of: board, phases, logs, artifacts');
        }
        if (!query.success) {
          return sendNativeError(reply, 400, 'INVALID_REQUEST', query.error.issues[0]?.message ?? 'Invalid workflow resource query');
        }
        const res = await peer.provider.service.readWorkflowResource({
          sessionId: peer.session.id,
          workflowId,
          resource: parsedResource.data,
          pageToken: query.data.pageToken,
          limit: query.data.limit,
        });
        if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
        return sendPeerNativePayload(reply, res.value);
      }
      const ctx = resolveAgySessionContext(deps, id, reply);
      if (!ctx) return;

      if (!parsedResource.success) {
        return sendNativeError(
          reply,
          400,
          'INVALID_REQUEST',
          'Workflow resource must be one of: board, phases, logs, artifacts',
        );
      }

      if (!query.success) {
        return sendNativeError(
          reply,
          400,
          'INVALID_REQUEST',
          query.error.issues[0]?.message ?? 'Invalid workflow resource query',
        );
      }

      const projection = ctx.nativeRegistry.getProjectionForSession(
        ctx.session.id,
        ctx.session.harnessId,
      );
      const parsedWorkflowId = asWorkflowId(workflowId);
      const flags = ctx.nativeRegistry.getFeatureFlags();
      const reader = flags.enabled ? ctx.nativeRegistry.getWorkflowResourceReaderPort() : null;
      const page = reader
        ? reader.readWorkflowResource({
            binding: projection.binding,
            workflowId: parsedWorkflowId,
            resource: parsedResource.data,
            pageToken: query.data.pageToken,
            limit: query.data.limit,
          })
        : {
            revision: projection.asOfSeq,
            available: false,
            sourceUnavailableReason: flags.enabled
              ? 'workflow_resource_not_available'
              : 'native_runtime_disabled',
            items: [],
            nextPageToken: null,
            hasMore: false,
          };

      const validated = NativeWorkflowResourceResponseSchema.safeParse({
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        binding: projection.binding,
        workflowId: parsedWorkflowId,
        resource: parsedResource.data,
        revision: page.revision,
        available: page.available,
        ...(page.sourceUnavailableReason
          ? { sourceUnavailableReason: page.sourceUnavailableReason }
          : {}),
        items: [...page.items],
        nextPageToken: page.nextPageToken,
        hasMore: page.hasMore,
      });
      if (!validated.success) {
        return sendNativeError(
          reply,
          500,
          'INVALID_REQUEST',
          'Workflow resource reader returned payload failing public DTO allowlist validation',
        );
      }
      return validated.data;
    },
  );

  // ── POST /api/v1/sessions/:id/native/commands ────────────────────────
  app.post('/api/v1/sessions/:id/native/commands', async (request, reply) => {
    if (!requireLocalWriteBoundary(request, reply)) return;
    const { id } = request.params as { id: string };
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      const res = await peer.provider.service.submitCommand({
        sessionId: peer.session.id,
        body: (request.body ?? {}) as Record<string, unknown>,
        provenance: {
          channel: 'human_direct',
          actor: 'desktop',
          issuedAt: Date.now(),
          reason: 'POST /native/commands',
          verifiedByHost: true,
        },
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      return sendPeerNativePayload(reply, res.value);
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const flags = ctx.nativeRegistry.getFeatureFlags();
    if (!flags.enabled || !flags.nativeCommands) {
      return sendNativeError(
        reply,
        503,
        'NATIVE_RUNTIME_DISABLED',
        'Native AGY command routing is currently disabled by feature gate',
      );
    }

    const parsed = NativeCommandRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid native command payload',
      );
    }

    try {
      assertAgyConsumerProvenance(
        {
          instanceId: ctx.session.harnessId,
          driverId: ctx.session.harnessKind,
          profile: ctx.adapter?.getProfile() ?? null,
        },
        mintAgyDispatchProvenance('human_direct', 'desktop', 'POST /native/commands'),
      );
    } catch (err) {
      if (err instanceof AgyConsumerProvenanceError) {
        return sendNativeError(reply, 403, 'CONSUMER_PROVENANCE_BLOCKED', err.message);
      }
      throw err;
    }

    const binding = ctx.nativeRegistry.getActiveBinding(ctx.session.id, ctx.session.harnessId);
    if (!binding || binding.generation !== parsed.data.bindingGeneration) {
      return sendNativeError(
        reply,
        409,
        'STALE_BINDING',
        'Binding generation does not match active runtime generation',
        {
          retryable: true,
          details: { currentGeneration: binding?.generation ?? null },
        },
      );
    }

    const caps = ctx.nativeRegistry.getCapabilitiesForSession(
      ctx.session.id,
      ctx.session.harnessId,
    );
    if (caps.capabilitiesRevision !== parsed.data.catalogRevision) {
      return sendNativeError(
        reply,
        409,
        'STALE_BINDING',
        'Capability catalog revision is stale; refresh capabilities before retrying',
        {
          retryable: true,
          details: { currentCatalogRevision: caps.capabilitiesRevision },
        },
      );
    }

    const router = ctx.nativeRegistry.getCommandRouterPort();
    if (!router) {
      return sendNativeError(
        reply,
        422,
        'UNSUPPORTED_ACTION',
        'No native command router is registered for this runtime',
      );
    }

    const descriptor = caps.descriptors.find((d) => d.id === parsed.data.capabilityId);
    const action = descriptor?.actions.find((a) => a.key === parsed.data.actionKey);
    if (!descriptor || !action || action.gate !== 'available') {
      return sendNativeError(
        reply,
        422,
        'UNSUPPORTED_ACTION',
        `Action "${parsed.data.actionKey}" on capability "${parsed.data.capabilityId}" is not available`,
        {
          details: {
            gate: action?.gate ?? 'unsupported',
          },
        },
      );
    }

    const digest = computePayloadDigest({
      bindingGeneration: parsed.data.bindingGeneration,
      catalogRevision: parsed.data.catalogRevision,
      capabilityId: parsed.data.capabilityId,
      actionKey: parsed.data.actionKey,
      args: parsed.data.args,
    });

    let claimed;
    try {
      claimed = ctx.nativeRegistry.persistence.claimIdempotentReceipt({
        binding,
        kind: 'command',
        idempotencyKey: parsed.data.idempotencyKey,
        payloadDigest: digest,
      });
    } catch (err) {
      if (err instanceof NativePersistenceError) {
        if (err.code === 'IDEMPOTENCY_CONFLICT') {
          return sendNativeError(reply, 409, 'IDEMPOTENCY_CONFLICT', err.message);
        }
        if (err.code === 'STALE_BINDING') {
          return sendNativeError(reply, 409, 'STALE_BINDING', err.message, { retryable: true });
        }
      }
      throw err;
    }

    // Strict R2 concurrency guard: ONLY `claimed.replayed === false` may execute the command port!
    if (claimed.replayed) {
      if (claimed.receipt.state === 'completed' && claimed.receipt.responseJson) {
        const cached = NativeCommandResponseSchema.safeParse(claimed.receipt.responseJson);
        if (cached.success) {
          return reply.code(cached.data.kind === 'accepted' ? 202 : 200).send(cached.data);
        }
      }
      if (claimed.receipt.state === 'claimed') {
        return sendNativeError(
          reply,
          409,
          'BUSY',
          'A command with this idempotencyKey is currently in flight',
          {
            retryable: true,
            details: { receiptId: claimed.receipt.receiptId, receiptState: 'claimed' },
          },
        );
      }
      return sendNativeError(
        reply,
        409,
        'DELIVERY_UNKNOWN',
        'Previous execution for this idempotencyKey did not finish cleanly; inspect runtime state before issuing a new key',
        {
          retryable: false,
          details: { receiptId: claimed.receipt.receiptId, receiptState: claimed.receipt.state },
        },
      );
    }

    try {
      const rawResponse = await router.executeCommand({
        binding,
        request: parsed.data,
        receiptId: claimed.receipt.receiptId,
      });
      const validatedResponse = NativeCommandResponseSchema.parse(rawResponse);
      const completed = ctx.nativeRegistry.persistence.completeIdempotentReceipt(
        claimed.receipt.receiptId,
        'completed',
        validatedResponse,
      );
      if (!completed) {
        return sendNativeError(reply, 409, 'DELIVERY_UNKNOWN', 'Runtime changed before its receipt could be completed', {
          retryable: false,
          details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
        });
      }
      return reply
        .code(validatedResponse.kind === 'accepted' ? 202 : 200)
        .send(validatedResponse);
    } catch {
      ctx.nativeRegistry.persistence.completeIdempotentReceipt(
        claimed.receipt.receiptId,
        'delivery_unknown',
        { error: 'command_execution_failed' },
      );
      return sendNativeError(
        reply,
        500,
        'DELIVERY_UNKNOWN',
        'Command execution failed after dispatch claim; outcome is uncertain',
        {
          retryable: false,
          details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
        },
      );
    }
  });

  // ── POST /api/v1/sessions/:id/native/control ─────────────────────────
  app.post('/api/v1/sessions/:id/native/control', async (request, reply) => {
    if (!requireLocalWriteBoundary(request, reply)) return;
    const { id } = request.params as { id: string };
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      const res = await peer.provider.service.dispatchControl({
        sessionId: peer.session.id,
        body: (request.body ?? {}) as Record<string, unknown>,
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      return sendPeerNativePayload(reply, res.value);
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const flags = ctx.nativeRegistry.getFeatureFlags();
    if (!flags.enabled || !flags.nativeCommands) {
      return sendNativeError(
        reply,
        503,
        'NATIVE_RUNTIME_DISABLED',
        'Native AGY control operations are currently disabled by feature gate',
      );
    }

    const parsed = NativeControlRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid native control payload',
      );
    }

    const binding = ctx.nativeRegistry.getActiveBinding(ctx.session.id, ctx.session.harnessId);
    if (!binding || binding.generation !== parsed.data.generation) {
      return sendNativeError(
        reply,
        409,
        'STALE_BINDING',
        'Binding generation does not match active runtime generation',
        {
          retryable: true,
          details: { currentGeneration: binding?.generation ?? null },
        },
      );
    }

    const router = ctx.nativeRegistry.getCommandRouterPort();
    if (!router) {
      return sendNativeError(
        reply,
        422,
        'UNSUPPORTED_ACTION',
        'No native control handler is registered for this runtime',
      );
    }

    // R2 Closed-Loop Control Authorization:
    // 1. Verify current capability catalog actually opens control for this target type & action
    const caps = ctx.nativeRegistry.getCapabilitiesForSession(
      ctx.session.id,
      ctx.session.harnessId,
    );
    if (!isControlAuthorizedByCatalog(caps.descriptors, parsed.data.target.type, parsed.data.action)) {
      return sendNativeError(
        reply,
        422,
        'UNSUPPORTED_ACTION',
        `Control action "${parsed.data.action}" on target type "${parsed.data.target.type}" is not authorized by current capability descriptors`,
      );
    }

    // 2. Verify target exists in this runtime, belongs to current generation, and matches expectedRevision
    if (parsed.data.target.type === 'runtime') {
      if (parsed.data.target.id !== binding.runtimeId) {
        return sendNativeError(reply, 404, 'NOT_FOUND', 'Control target runtime does not match session binding');
      }
      const storedBinding = ctx.nativeRegistry.persistence.getBinding(binding.runtimeId);
      if (!storedBinding || storedBinding.asOfSeq !== parsed.data.expectedRevision) {
        return sendNativeError(
          reply,
          409,
          'STALE_BINDING',
          'Expected runtime revision does not match current binding revision',
          {
            retryable: true,
            details: { actualRevision: storedBinding?.asOfSeq ?? 0 },
          },
        );
      }
    } else {
      const entityMeta = ctx.nativeRegistry.persistence.getEntityMeta(
        binding.runtimeId,
        parsed.data.target.type,
        parsed.data.target.id,
      );
      if (!entityMeta) {
        return sendNativeError(
          reply,
          404,
          'NOT_FOUND',
          `Control target ${parsed.data.target.type}:${parsed.data.target.id} was not found in active runtime`,
        );
      }
      if (entityMeta.generation !== binding.generation) {
        return sendNativeError(
          reply,
          409,
          'STALE_BINDING',
          'Control target belongs to an older generation and cannot be controlled',
          { retryable: false },
        );
      }
      if (entityMeta.revision !== parsed.data.expectedRevision) {
        return sendNativeError(
          reply,
          409,
          'STALE_BINDING',
          'Control target revision mismatch',
          {
            retryable: true,
            details: { actualRevision: entityMeta.revision },
          },
        );
      }
    }

    const digest = computePayloadDigest({
      generation: parsed.data.generation,
      target: parsed.data.target,
      action: parsed.data.action,
      expectedRevision: parsed.data.expectedRevision,
    });

    let claimed;
    try {
      claimed = ctx.nativeRegistry.persistence.claimIdempotentReceipt({
        binding,
        kind: 'control',
        idempotencyKey: parsed.data.idempotencyKey,
        payloadDigest: digest,
      });
    } catch (err) {
      if (err instanceof NativePersistenceError) {
        if (err.code === 'IDEMPOTENCY_CONFLICT') {
          return sendNativeError(reply, 409, 'IDEMPOTENCY_CONFLICT', err.message);
        }
        if (err.code === 'STALE_BINDING') {
          return sendNativeError(reply, 409, 'STALE_BINDING', err.message, { retryable: true });
        }
      }
      throw err;
    }

    // Strict R2 concurrency guard: ONLY sole claimer may invoke control port
    if (claimed.replayed) {
      if (claimed.receipt.state === 'completed' && claimed.receipt.responseJson) {
        const cached = NativeControlResponseSchema.safeParse(claimed.receipt.responseJson);
        if (cached.success) {
          return reply.code(200).send(cached.data);
        }
      }
      if (claimed.receipt.state === 'claimed') {
        return sendNativeError(
          reply,
          409,
          'BUSY',
          'A control request with this idempotencyKey is currently in flight',
          {
            retryable: true,
            details: { receiptId: claimed.receipt.receiptId, receiptState: 'claimed' },
          },
        );
      }
      return sendNativeError(
        reply,
        409,
        'DELIVERY_UNKNOWN',
        'Previous control execution for this idempotencyKey did not finish cleanly',
        {
          retryable: false,
          details: { receiptId: claimed.receipt.receiptId, receiptState: claimed.receipt.state },
        },
      );
    }

    try {
      const rawResponse = await router.executeControl({
        binding,
        request: parsed.data,
        receiptId: claimed.receipt.receiptId,
      });
      const validatedResponse = NativeControlResponseSchema.parse(rawResponse);
      const completed = ctx.nativeRegistry.persistence.completeIdempotentReceipt(
        claimed.receipt.receiptId,
        'completed',
        validatedResponse,
      );
      if (!completed) {
        return sendNativeError(reply, 409, 'DELIVERY_UNKNOWN', 'Runtime changed before its receipt could be completed', {
          retryable: false,
          details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
        });
      }
      return reply.code(200).send(validatedResponse);
    } catch {
      ctx.nativeRegistry.persistence.completeIdempotentReceipt(
        claimed.receipt.receiptId,
        'delivery_unknown',
        { error: 'control_execution_failed' },
      );
      return sendNativeError(
        reply,
        500,
        'DELIVERY_UNKNOWN',
        'Control execution failed after dispatch claim; outcome is uncertain',
        {
          retryable: false,
          details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
        },
      );
    }
  });

  app.get('/api/v1/sessions/:id/native/requests', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return sendNativeError(reply, 403, 'FORBIDDEN', 'Native request details require local desktop access');
    }
    const { id } = request.params as { id: string };
    const peer = resolvePeerRuntimeForRoute(deps, id, reply);
    if (peer) {
      if (peer.handled) return;
      const res = await peer.provider.service.getRequestDetails({
        sessionId: peer.session.id,
        requestId: '',
      });
      if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
      return res.value;
    }
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;
    const flags = ctx.nativeRegistry.getFeatureFlags();
    if (!flags.enabled || !flags.nativePermissions) {
      return sendNativeError(reply, 503, 'NATIVE_RUNTIME_DISABLED', 'Native request routing is disabled');
    }
    const binding = ctx.nativeRegistry.getActiveBinding(id, ctx.session.harnessId);
    if (!binding) return sendNativeError(reply, 404, 'NOT_FOUND', 'No native binding for this session');
    return NativeRequestDetailsResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      binding,
      requests: ctx.nativeRegistry.getPermissionPort()?.listRequestDetails?.(binding) ?? [],
    });
  });

  // ── POST /api/v1/sessions/:id/native/requests/:approvalId/resolve ────
  app.post(
    '/api/v1/sessions/:id/native/requests/:approvalId/resolve',
    async (request, reply) => {
      if (!requireLocalWriteBoundary(request, reply)) return;
      const { id, approvalId } = request.params as { id: string; approvalId: string };
      const peer = resolvePeerRuntimeForRoute(deps, id, reply);
      if (peer) {
        if (peer.handled) return;
        const res = await peer.provider.service.resolveNativeRequest({
          sessionId: peer.session.id,
          requestId: approvalId,
          body: (request.body ?? {}) as Record<string, unknown>,
        });
        if (!res.ok) return mapPeerErrorToNativeReply(reply, res.error);
        return sendPeerNativePayload(reply, res.value);
      }
      const ctx = resolveAgySessionContext(deps, id, reply);
      if (!ctx) return;

      const flags = ctx.nativeRegistry.getFeatureFlags();
      if (!flags.enabled || !flags.nativePermissions) {
        return sendNativeError(
          reply,
          503,
          'NATIVE_RUNTIME_DISABLED',
          'Native AGY request routing is currently disabled by feature gate',
        );
      }

      const parsed = ResolveNativeRequestInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendNativeError(
          reply,
          400,
          'INVALID_REQUEST',
          parsed.error.issues[0]?.message ?? 'Invalid native request resolution payload',
        );
      }

      const binding = ctx.nativeRegistry.getActiveBinding(ctx.session.id, ctx.session.harnessId);
      if (!binding || binding.generation !== parsed.data.generation) {
        return sendNativeError(
          reply,
          409,
          'STALE_BINDING',
          'Approval generation does not match active runtime generation',
          {
            retryable: false,
            details: { currentGeneration: binding?.generation ?? null },
          },
        );
      }

      const permissionPort = ctx.nativeRegistry.getPermissionPort();
      if (!permissionPort) {
        return sendNativeError(
          reply,
          422,
          'UNSUPPORTED_ACTION',
          'No native permission router is registered for this runtime',
        );
      }

      // R2 Closed-Loop Approval Authorization: request MUST exist in live pending list for this binding & generation
      const pendingList = permissionPort.listPendingRequests(binding);
      const matchingPending = pendingList.find(
        (p) =>
          p.approvalId === approvalId &&
          p.runtimeId === binding.runtimeId &&
          p.generation === binding.generation,
      );
      if (!matchingPending) {
        const existingReceipt =
          ctx.nativeRegistry.persistence.getApprovalReceiptByApprovalId(approvalId);
        if (existingReceipt && existingReceipt.sessionId === ctx.session.id) {
          return sendNativeError(
            reply,
            409,
            'ALREADY_RESOLVED',
            `Native request "${approvalId}" is no longer pending (state: ${existingReceipt.state})`,
            {
              retryable: false,
              details: {
                receiptId: existingReceipt.receiptId,
                receiptState: existingReceipt.state,
              },
            },
          );
        }
        return sendNativeError(
          reply,
          404,
          'NOT_FOUND',
          `Pending native request "${approvalId}" was not found for the active runtime generation`,
        );
      }

      if (parsed.data.outcome === 'selected') {
        if (
          !parsed.data.optionId ||
          !matchingPending.allowedOptionIds.includes(parsed.data.optionId)
        ) {
          return sendNativeError(
            reply,
            400,
            'INVALID_REQUEST',
            'Selected optionId is not in the request allowedOptionIds',
          );
        }
      }
      if (
        parsed.data.outcome === 'form_submitted' &&
        matchingPending.kind !== 'elicitation' &&
        !matchingPending.allowsFreeText
      ) {
        return sendNativeError(
          reply,
          400,
          'INVALID_REQUEST',
          'Free-form payload is not accepted for fixed-option permission requests',
        );
      }

      const validation = permissionPort.validateResolutionInput?.(binding, approvalId, parsed.data);
      if (validation && !validation.valid) {
        if (validation.errorCode === 'STALE_GENERATION') {
          return sendNativeError(reply, 409, 'STALE_BINDING', 'Native request belongs to a different binding');
        }
        if (validation.errorCode === 'REQUEST_NOT_PENDING' || validation.errorCode === 'REQUEST_EXPIRED') {
          return sendNativeError(reply, 409, 'ALREADY_RESOLVED', 'Native request is no longer pending');
        }
        return sendNativeError(reply, 400, 'INVALID_REQUEST', 'Invalid option or form for the pending native request');
      }

      // Ensure durable receipt exists and acquire authoritative DB CAS BEFORE calling permissionPort!
      try {
        ctx.nativeRegistry.persistence.createPendingApprovalReceipt({
          binding,
          approvalId,
        });
      } catch (err) {
        if (err instanceof NativePersistenceError && err.code === 'STALE_BINDING') {
          return sendNativeError(reply, 409, 'STALE_BINDING', err.message, { retryable: false });
        }
        throw err;
      }

      const cas = ctx.nativeRegistry.persistence.claimApprovalReceiptCas({
        approvalId,
        expectedGeneration: binding.generation,
        expectedSessionId: ctx.session.id,
        idempotencyKey: parsed.data.idempotencyKey,
      });

      if (!cas.claimed || !cas.receipt) {
        return sendNativeError(
          reply,
          409,
          cas.staleGeneration ? 'STALE_BINDING' : 'ALREADY_RESOLVED',
          cas.staleGeneration
            ? 'Approval generation is no longer active'
            : `Native request "${approvalId}" was already claimed or resolved`,
          {
            retryable: false,
            details: {
              receiptId: cas.receipt?.receiptId ?? null,
              receiptState: cas.receipt?.state ?? null,
            },
          },
        );
      }

      try {
        const outcome = await permissionPort.resolveNativeRequest({
          binding,
          approvalId,
          receiptId: cas.receipt.receiptId,
          request: parsed.data,
          resolvedBy: 'desktop',
        });

        const finalState = outcome.receiptState;
        const transition = ctx.nativeRegistry.persistence.transitionApprovalReceiptState(
          cas.receipt.receiptId,
          ['claimed'],
          finalState,
          { outcome: parsed.data.outcome },
        );
        if (!transition.transitioned) {
          return sendNativeError(reply, 409, 'DELIVERY_UNKNOWN', 'Runtime changed before its approval receipt could be completed', {
            retryable: false,
            details: { receiptId: cas.receipt.receiptId, receiptState: transition.receipt?.state ?? 'delivery_unknown' },
          });
        }

        const body = ResolveNativeRequestResponseSchema.parse({
          schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
          approvalId: outcome.approvalId,
          receiptId: cas.receipt.receiptId,
          receiptState: finalState,
          conflict: outcome.conflict,
        });

        if (outcome.conflict) {
          return reply.code(409).send(body);
        }
        return reply.code(200).send(body);
      } catch {
        ctx.nativeRegistry.persistence.transitionApprovalReceiptState(
          cas.receipt.receiptId,
          ['claimed'],
          'delivery_unknown',
          { error: 'permission_wire_write_uncertain' },
        );
        return sendNativeError(
          reply,
          500,
          'DELIVERY_UNKNOWN',
          'Permission response write failed or timed out; delivery state is unknown and will not be replayed',
          {
            retryable: false,
            details: { receiptId: cas.receipt.receiptId, receiptState: 'delivery_unknown' },
          },
        );
      }
    },
  );
}
