import {
  AGY_NATIVE_CONTRACT_VERSION,
  NativeApiErrorSchema,
  NativeCommandRequestSchema,
  NativeControlRequestSchema,
  NativeEventsQuerySchema,
  NativeEventsResponseSchema,
  NativeTimelineQuerySchema,
  NativeTimelineResponseSchema,
  NativeWorkflowResourceKindSchema,
  NativeWorkflowResourceResponseSchema,
  ResolveNativeRequestInputSchema,
  ResolveNativeRequestResponseSchema,
  asWorkflowId,
  type NativeApiErrorCode,
} from '@harnessmate/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionManager } from '../../../../core/session-manager.js';
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
  readonly nativeRegistry: AgyNativeRuntimeRegistry;
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

function resolveAgySessionContext(
  deps: NativeRoutesDeps,
  sessionId: string,
  reply: FastifyReply,
) {
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

export function registerAgyNativeRoutes(app: FastifyInstance, deps: NativeRoutesDeps): void {
  // ── GET /api/v1/sessions/:id/native/snapshot ─────────────────────────
  app.get('/api/v1/sessions/:id/native/snapshot', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    return deps.nativeRegistry.getProjectionForSession(ctx.session.id, ctx.session.harnessId);
  });

  // ── GET /api/v1/sessions/:id/native/capabilities ─────────────────────
  app.get('/api/v1/sessions/:id/native/capabilities', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    return deps.nativeRegistry.getCapabilitiesForSession(ctx.session.id, ctx.session.harnessId);
  });

  // ── GET /api/v1/sessions/:id/native/events ───────────────────────────
  app.get('/api/v1/sessions/:id/native/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const query = NativeEventsQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        query.error.issues[0]?.message ?? 'Invalid native events query parameters',
      );
    }

    const res = deps.nativeRegistry.readEventsForSession(ctx.session.id, ctx.session.harnessId, {
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
      runtimeId: res.runtimeId,
      generation: res.generation,
      events: res.events,
      nextSeq: res.nextSeq,
      nextCursor: res.nextCursor,
      hasMore: res.hasMore,
    });
  });

  // ── GET /api/v1/sessions/:id/native/activity/:activityId/timeline ────
  app.get('/api/v1/sessions/:id/native/activity/:activityId/timeline', async (request, reply) => {
    const { id, activityId } = request.params as { id: string; activityId: string };
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const query = NativeTimelineQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        query.error.issues[0]?.message ?? 'Invalid timeline query',
      );
    }

    const projection = deps.nativeRegistry.getProjectionForSession(
      ctx.session.id,
      ctx.session.harnessId,
    );
    const reader = deps.nativeRegistry.getTimelineReaderPort();
    const page = reader
      ? reader.readTimeline({
          binding: projection.binding,
          scopeType: 'activity',
          scopeId: activityId,
          pageToken: query.data.pageToken,
          limit: query.data.limit,
        })
      : { revision: projection.asOfSeq, entries: [], nextPageToken: null };

    return NativeTimelineResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      runtimeId: projection.binding.runtimeId,
      generation: projection.binding.generation,
      scopeType: 'activity',
      scopeId: activityId,
      revision: page.revision,
      entries: [...page.entries],
      nextPageToken: page.nextPageToken,
    });
  });

  // ── GET /api/v1/sessions/:id/native/agents/:agentId/timeline ─────────
  app.get('/api/v1/sessions/:id/native/agents/:agentId/timeline', async (request, reply) => {
    const { id, agentId } = request.params as { id: string; agentId: string };
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const query = NativeTimelineQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return sendNativeError(
        reply,
        400,
        'INVALID_REQUEST',
        query.error.issues[0]?.message ?? 'Invalid timeline query',
      );
    }

    const projection = deps.nativeRegistry.getProjectionForSession(
      ctx.session.id,
      ctx.session.harnessId,
    );
    const reader = deps.nativeRegistry.getTimelineReaderPort();
    const page = reader
      ? reader.readTimeline({
          binding: projection.binding,
          scopeType: 'agent',
          scopeId: agentId,
          pageToken: query.data.pageToken,
          limit: query.data.limit,
        })
      : { revision: projection.asOfSeq, entries: [], nextPageToken: null };

    return NativeTimelineResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      runtimeId: projection.binding.runtimeId,
      generation: projection.binding.generation,
      scopeType: 'agent',
      scopeId: agentId,
      revision: page.revision,
      entries: [...page.entries],
      nextPageToken: page.nextPageToken,
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
      const ctx = resolveAgySessionContext(deps, id, reply);
      if (!ctx) return;

      const parsedResource = NativeWorkflowResourceKindSchema.safeParse(resource);
      if (!parsedResource.success) {
        return sendNativeError(
          reply,
          400,
          'INVALID_REQUEST',
          'Workflow resource must be one of: board, phases, logs, artifacts',
        );
      }

      const query = NativeTimelineQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return sendNativeError(
          reply,
          400,
          'INVALID_REQUEST',
          query.error.issues[0]?.message ?? 'Invalid workflow resource query',
        );
      }

      const projection = deps.nativeRegistry.getProjectionForSession(
        ctx.session.id,
        ctx.session.harnessId,
      );
      const parsedWorkflowId = asWorkflowId(workflowId);
      const reader = deps.nativeRegistry.getWorkflowResourceReaderPort();
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
            reasonCode: 'workflow_resource_not_available',
            items: [],
            nextPageToken: null,
          };

      return NativeWorkflowResourceResponseSchema.parse({
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        runtimeId: projection.binding.runtimeId,
        generation: projection.binding.generation,
        workflowId: parsedWorkflowId,
        resource: parsedResource.data,
        revision: page.revision,
        available: page.available,
        ...(page.reasonCode ? { reasonCode: page.reasonCode } : {}),
        items: [...page.items],
        nextPageToken: page.nextPageToken,
      });
    },
  );

  // ── POST /api/v1/sessions/:id/native/commands ────────────────────────
  app.post('/api/v1/sessions/:id/native/commands', async (request, reply) => {
    if (!requireLocalWriteBoundary(request, reply)) return;
    const { id } = request.params as { id: string };
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const flags = deps.nativeRegistry.getFeatureFlags();
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

    // Verify human-direct provenance before invoking consumer AGY
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

    const binding = deps.nativeRegistry.getActiveBinding(ctx.session.id, ctx.session.harnessId);
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

    const caps = deps.nativeRegistry.getCapabilitiesForSession(
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

    const router = deps.nativeRegistry.getCommandRouterPort();
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
      claimed = deps.nativeRegistry.persistence.claimIdempotentReceipt({
        binding,
        kind: 'command',
        idempotencyKey: parsed.data.idempotencyKey,
        payloadDigest: digest,
      });
    } catch (err) {
      if (err instanceof NativePersistenceError && err.code === 'IDEMPOTENCY_CONFLICT') {
        return sendNativeError(reply, 409, 'IDEMPOTENCY_CONFLICT', err.message);
      }
      throw err;
    }

    if (claimed.replayed && claimed.receipt.responseJson) {
      const prev = claimed.receipt.responseJson as { kind?: string };
      return reply.code(prev.kind === 'accepted' ? 202 : 200).send(claimed.receipt.responseJson);
    }

    const response = await router.executeCommand({
      binding,
      request: parsed.data,
      receiptId: claimed.receipt.receiptId,
    });
    deps.nativeRegistry.persistence.completeIdempotentReceipt(
      claimed.receipt.receiptId,
      'completed',
      response,
    );
    return reply.code(response.kind === 'accepted' ? 202 : 200).send(response);
  });

  // ── POST /api/v1/sessions/:id/native/control ─────────────────────────
  app.post('/api/v1/sessions/:id/native/control', async (request, reply) => {
    if (!requireLocalWriteBoundary(request, reply)) return;
    const { id } = request.params as { id: string };
    const ctx = resolveAgySessionContext(deps, id, reply);
    if (!ctx) return;

    const flags = deps.nativeRegistry.getFeatureFlags();
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

    const binding = deps.nativeRegistry.getActiveBinding(ctx.session.id, ctx.session.harnessId);
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

    const router = deps.nativeRegistry.getCommandRouterPort();
    if (!router) {
      return sendNativeError(
        reply,
        422,
        'UNSUPPORTED_ACTION',
        'No native control handler is registered for this runtime',
      );
    }

    const digest = computePayloadDigest({
      generation: parsed.data.generation,
      target: parsed.data.target,
      action: parsed.data.action,
      expectedRevision: parsed.data.expectedRevision,
    });

    let claimed;
    try {
      claimed = deps.nativeRegistry.persistence.claimIdempotentReceipt({
        binding,
        kind: 'control',
        idempotencyKey: parsed.data.idempotencyKey,
        payloadDigest: digest,
      });
    } catch (err) {
      if (err instanceof NativePersistenceError && err.code === 'IDEMPOTENCY_CONFLICT') {
        return sendNativeError(reply, 409, 'IDEMPOTENCY_CONFLICT', err.message);
      }
      throw err;
    }

    if (claimed.replayed && claimed.receipt.responseJson) {
      return reply.code(200).send(claimed.receipt.responseJson);
    }

    const response = await router.executeControl({
      binding,
      request: parsed.data,
      receiptId: claimed.receipt.receiptId,
    });
    deps.nativeRegistry.persistence.completeIdempotentReceipt(
      claimed.receipt.receiptId,
      'completed',
      response,
    );
    return reply.code(200).send(response);
  });

  // ── POST /api/v1/sessions/:id/native/requests/:approvalId/resolve ────
  app.post(
    '/api/v1/sessions/:id/native/requests/:approvalId/resolve',
    async (request, reply) => {
      if (!requireLocalWriteBoundary(request, reply)) return;
      const { id, approvalId } = request.params as { id: string; approvalId: string };
      const ctx = resolveAgySessionContext(deps, id, reply);
      if (!ctx) return;

      const flags = deps.nativeRegistry.getFeatureFlags();
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

      const binding = deps.nativeRegistry.getActiveBinding(ctx.session.id, ctx.session.harnessId);
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

      const permissionPort = deps.nativeRegistry.getPermissionPort();
      if (!permissionPort) {
        return sendNativeError(
          reply,
          422,
          'UNSUPPORTED_ACTION',
          'No native permission router is registered for this runtime',
        );
      }

      const pendingList = permissionPort.listPendingRequests?.(binding);
      const matchingPending = pendingList?.find((p) => p.approvalId === approvalId);
      if (matchingPending && parsed.data.outcome === 'selected') {
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

      const outcome = await permissionPort.resolveNativeRequest({
        binding,
        approvalId,
        request: parsed.data,
        resolvedBy: 'desktop',
      });

      const body = ResolveNativeRequestResponseSchema.parse({
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        approvalId: outcome.approvalId,
        receiptId: outcome.receiptId,
        receiptState: outcome.receiptState,
        conflict: outcome.conflict,
      });

      if (outcome.conflict) {
        return reply.code(409).send(body);
      }
      return reply.code(200).send(body);
    },
  );
}
