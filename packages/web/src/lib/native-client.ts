import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  NativeCapabilitiesResponseSchema,
  NativeCommandRequestSchema,
  NativeCommandResponseSchema,
  NativeControlRequestSchema,
  NativeControlResponseSchema,
  NativeEventsResponseSchema,
  NativeSnapshotResponseSchema,
  NativeWsClientFrameSchema,
  NativeWsServerFrameSchema,
  NativeTimelineResponseSchema,
  NativeWorkflowResourceResponseSchema,
  ResolveNativeRequestInputSchema,
  ResolveNativeRequestResponseSchema,
  type NativeCanonicalEvent as WireNativeEvent,
  type NativeRequestSummaryDto,
  type NativeRuntimeProjection as WireProjection,
  type PublicEvidenceFreshness,
} from '@harnessmate/protocol';
import { ApiHttpError, getDaemonBaseUrl } from '../api/client';

export const NATIVE_FRONTEND_CONTRACT_REVISION = AGY_NATIVE_CONTRACT_REVISION;
export const NATIVE_SCHEMA_VERSION = AGY_NATIVE_CONTRACT_VERSION;

export type OpaqueId<Name extends string> = string & { readonly __idKind?: Name };
export type RuntimeId = OpaqueId<'Runtime'>;
export type ActivityId = OpaqueId<'Activity'>;
export type WorkId = OpaqueId<'Work'>;
export type NativeAgentId = OpaqueId<'NativeAgent'>;
export type WorkflowId = OpaqueId<'Workflow'>;
export type BindingGeneration = OpaqueId<'BindingGeneration'>;

export interface RuntimeBinding {
  runtimeId: RuntimeId;
  sessionId: string;
  instanceId: string;
  generation: BindingGeneration;
}

/**
 * Public allowlisted provenance DTO.
 * Internal `connectionId`, `NativeAlias`, raw wire payloads, and unredacted host paths
 * are explicitly excluded from frontend projection DTOs per 08_Shared_Contracts.md.
 */
export type EvidenceSourceKind =
  | 'live_protocol'
  | 'native_snapshot'
  | 'host_observation'
  | 'replay';

export type EvidenceFreshness = PublicEvidenceFreshness | 'fresh' | 'unknown';

export interface EvidenceDto {
  sourceKind: EvidenceSourceKind;
  freshness: EvidenceFreshness;
  observedAt: number;
  reasonCode?: string;
  wireVariant?: string;
  schemaVersion?: string;
  captureId?: string;
}

export type Observed<T> =
  | { kind: 'known'; value: T; evidence: EvidenceDto }
  | { kind: 'stale'; last?: T; evidence?: EvidenceDto; reasonCode: string }
  | { kind: 'unknown'; reasonCode: string };

export type AgentForeground = 'running' | 'requires_action' | 'idle' | 'unknown';

export type WorkState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'requires_action'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type Blocking = 'confirmed_blocking' | 'detached' | 'unknown';

export type ActivityStatus =
  | 'starting'
  | 'running'
  | 'waiting_background'
  | 'requires_action'
  | 'quiescent'
  | 'cancelling'
  | 'reconciling'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type ActivityOrigin =
  | 'user_turn'
  | 'native_continuation'
  | 'native_task'
  | 'recovery';

export interface Activity {
  id: ActivityId;
  turnId: string | null;
  origin: ActivityOrigin;
  priorActivityId?: ActivityId;
  workId?: WorkId;
  agentId?: NativeAgentId;
  state: ActivityStatus;
  summary?: string;
  evidence?: EvidenceDto;
  updatedAt: number;
}

export type NativeWorkKind =
  | 'finite_command'
  | 'daemon'
  | 'subagent'
  | 'schedule'
  | 'workflow_step'
  | 'unknown';

export type WorkOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface NativeWork {
  id: WorkId;
  kind: NativeWorkKind;
  originActivityId?: ActivityId;
  ownerAgentId?: NativeAgentId;
  workflowId?: WorkflowId;
  blocking: Blocking;
  state: Observed<WorkState>;
  outcome?: Observed<WorkOutcome>;
  observedLabel?: string;
  revision: number;
}

export type AgentLineage = 'confirmed' | 'unresolved' | 'conflicting';

export interface AgentIdentity {
  id: NativeAgentId;
  role?: Observed<string>;
  label?: Observed<string>;
  foreground: Observed<AgentForeground>;
  status?: Observed<WorkState>;
  launchWorkIds: WorkId[];
  lineage: AgentLineage;
  revision: number;
}

export interface NativeRelationship {
  parentAgentId: NativeAgentId;
  childAgentId: NativeAgentId;
  confidence: 'protocol_confirmed' | 'snapshot_confirmed';
  launchWorkId?: WorkId;
  evidence: EvidenceDto;
}

export type WorkflowKind =
  | 'swarm'
  | 'boost'
  | 'teamwork'
  | 'dynamic'
  | 'goal'
  | 'schedule';

export interface NativeStage {
  id: string;
  label: string;
  state: Observed<WorkState>;
  after?: string[];
  agentIds?: NativeAgentId[];
}

export type WorkflowDetail =
  | {
      kind: 'swarm';
      coordinatorId?: NativeAgentId;
      workerIds: NativeAgentId[];
      board: Observed<'available' | 'upstream_limited'>;
      objective?: string;
    }
  | {
      kind: 'boost';
      phases?: NativeStage[];
      objective?: string;
    }
  | {
      kind: 'teamwork';
      scopingActivityId?: ActivityId;
      promptArtifactId?: string;
      projectLabel?: string;
      milestones?: NativeStage[];
    }
  | {
      kind: 'dynamic';
      scriptArtifactId?: string;
      steps?: NativeStage[];
      resultArtifactIds?: string[];
    }
  | {
      kind: 'goal';
      objective?: string;
      verificationArtifactIds?: string[];
    }
  | {
      kind: 'schedule';
      scheduleLabel?: string;
      nextAt?: Observed<number>;
      occurrenceWorkIds: WorkId[];
    };

export interface NativeWorkflow {
  id: WorkflowId;
  originActivityId: ActivityId;
  state: Observed<WorkState>;
  detail: WorkflowDetail;
  revision: number;
}

export type GateState =
  | 'available'
  | 'unknown'
  | 'unsupported'
  | 'upstream_limited'
  | 'not_tested';

export type CommandLane = 'query' | 'config' | 'live_workflow' | 'manager';

export interface CapabilityActionDescriptor {
  key: string;
  lane: CommandLane;
  gate: GateState;
  reasonCode?: string;
  label?: string;
}

export interface CapabilityDescriptor {
  id: string;
  snapshotRevision: number;
  surfaces: Array<'desktop' | 'cli' | 'ide' | 'acp'>;
  tierHint?: string;
  versionNote?: string;
  advertised: boolean | null;
  launch: GateState;
  observe: GateState;
  control: GateState;
  localRead: GateState;
  actions: CapabilityActionDescriptor[];
  evidenceRefs: string[];
  verifiedLevel: 0 | 1 | 2 | 3 | 4 | 5 | null;
}

export type NativeRequestReceiptState =
  | 'pending'
  | 'claimed'
  | 'response_written'
  | 'cancelled'
  | 'expired'
  | 'connection_lost'
  | 'delivery_unknown';

export interface NativeRequestReceiptDto {
  approvalId: string;
  runtimeId: RuntimeId;
  generation: BindingGeneration;
  kind: 'permission' | 'question' | 'elicitation';
  agentId?: NativeAgentId;
  activityId?: ActivityId;
  targetLineage: 'confirmed' | 'unconfirmed';
  allowedOptionIds: string[];
  allowsFreeText?: boolean;
  receiptState: NativeRequestReceiptState;
  receiptId?: string;
  deadline?: number;
  evidence?: EvidenceDto;
  updatedAt: number;
}

export type NativeRuntimeStatus = 'attached' | 'reconciling' | 'disconnected';

export interface NativeRuntimeProjection {
  schemaVersion: 1;
  enabled?: boolean;
  binding: RuntimeBinding;
  asOfSeq: number;
  status: NativeRuntimeStatus;
  capabilitiesRevision: number;
  leaseReasons?: string[];
  activities: Activity[];
  work: NativeWork[];
  agents: AgentIdentity[];
  relations: NativeRelationship[];
  workflows: NativeWorkflow[];
  requestIds: string[];
  receipts?: Record<string, NativeRequestReceiptDto>;
}

// ── Canonical Native Feed Events ────────────────────────────────────────

export interface NativeCanonicalEventBase {
  schemaVersion: 1;
  runtimeId: RuntimeId;
  generation: BindingGeneration;
  seq: number;
  turnId: string | null;
  hmAnchorSeq?: number;
  createdAt: number;
}

export type NativeCanonicalEvent =
  | (NativeCanonicalEventBase & {
      type: 'native.runtime.changed';
      payload: {
        status: NativeRuntimeStatus;
        leaseReasons?: string[];
        binding?: RuntimeBinding;
        revision?: number;
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.activity.changed';
      payload: {
        activity: Activity;
        removed?: boolean;
        textDelta?: string;
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.work.changed';
      payload: {
        work: NativeWork;
        removed?: boolean;
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.agent.changed';
      payload: {
        agent: AgentIdentity;
        removed?: boolean;
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.relation.changed';
      payload: {
        relation: NativeRelationship;
        revoked?: boolean;
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.workflow.changed';
      payload: {
        workflow: NativeWorkflow;
        removed?: boolean;
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.request.changed';
      payload: {
        receipt: NativeRequestReceiptDto;
        removed?: boolean;
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.capabilities.changed';
      payload: {
        capabilitiesRevision: number;
        changedDescriptorIds: string[];
        descriptors?: CapabilityDescriptor[];
      };
    })
  | (NativeCanonicalEventBase & {
      type: 'native.recovery.changed';
      payload: {
        status: NativeRuntimeStatus;
        invalidatedGeneration?: BindingGeneration;
        uncertainWorkIds?: WorkId[];
        reasonCode?: string;
      };
    });

// ── Paginated & Command/Control DTOs ────────────────────────────────────

export interface NativeSnapshotResponse {
  schemaVersion: 1;
  projection: NativeRuntimeProjection;
}

export interface NativeCapabilitiesResponse {
  schemaVersion: 1;
  binding: RuntimeBinding;
  capabilitiesRevision: number;
  descriptors: CapabilityDescriptor[];
}

export interface NativeEventsPageResponse {
  schemaVersion: 1;
  binding: RuntimeBinding;
  asOfSeq: number;
  events: NativeCanonicalEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type NativeTimelineEntryKind =
  | 'assistant_text'
  | 'thinking'
  | 'tool'
  | 'diff'
  | 'request'
  | 'status'
  | 'artifact_ref'
  | 'notice';

export interface NativeTimelineEntry {
  entryId: string;
  seq: number;
  timestamp: number;
  kind: NativeTimelineEntryKind;
  actorKind: 'main' | 'child' | 'system' | 'user';
  actorId?: string;
  actorLabel?: string;
  title?: string;
  text?: string;
  diff?: string;
  status?: WorkState | ActivityStatus;
  evidence?: EvidenceDto;
  /** When present and identical to the previous entry's key (same actor & kind), consecutive text deltas coalesce cleanly. */
  deltaCoalesceKey?: string;
  /** Tracks all original entryIds merged into this entry so duplicate re-delivery never appends twice. */
  mergedEntryIds?: readonly string[];
}

export interface NativeTimelinePageResponse {
  schemaVersion: 1;
  scopeKind: 'activity' | 'agent';
  scopeId: string;
  revision: number;
  items: NativeTimelineEntry[];
  nextPageToken: string | null;
  hasMore: boolean;
  sourceUnavailableReason?: string;
}

export interface NativeWorkflowResourcePageResponse {
  schemaVersion: 1;
  workflowId: WorkflowId;
  resource: string;
  revision: number;
  items: Array<Record<string, unknown>>;
  nextPageToken: string | null;
  hasMore: boolean;
  sourceUnavailableReason?: string;
}

export interface NativeCommandSubmitRequest {
  bindingGeneration: BindingGeneration;
  catalogRevision: number;
  capabilityId: string;
  actionKey: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
}

export interface NativeCommandSubmitResponse {
  schemaVersion: 1;
  status: 'accepted' | 'completed';
  receiptId?: string;
  activityId?: ActivityId;
  turnId?: string | null;
  modeEvidenceObserved?: boolean;
  output?: string;
}

export interface NativeControlRequest {
  generation: BindingGeneration;
  target: {
    type: 'runtime' | 'activity' | 'work' | 'agent' | 'workflow';
    id: string;
  };
  action: string;
  expectedRevision?: number;
  idempotencyKey: string;
}

export interface NativeControlResponse {
  schemaVersion: 1;
  receiptId: string;
  state: 'requested' | 'applied' | 'noop' | 'unknown';
  reasonCode?: string;
}

export type NativeRequestResolveRequest = import('@harnessmate/protocol').ResolveNativeRequestInput;

export interface NativeRequestResolveResponse {
  schemaVersion: 1;
  approvalId: string;
  receiptId: string;
  receiptState: NativeRequestReceiptState;
}

// ── Errors ──────────────────────────────────────────────────────────────

export type NativeErrorCode =
  | 'RESYNC_REQUIRED'
  | 'STALE_BINDING'
  | 'BUSY'
  | 'DELIVERY_UNKNOWN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_ACTION'
  | 'FORBIDDEN'
  | 'ENDPOINT_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export class NativeClientError extends Error {
  readonly status: number;
  readonly code: NativeErrorCode;
  readonly payload?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: NativeErrorCode,
    payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'NativeClientError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function classifyNativeError(err: unknown): NativeClientError {
  if (err instanceof NativeClientError) return err;
  if (err instanceof ApiHttpError) {
    const rawCode = err.code ?? (typeof err.payload?.errorCode === 'string' ? err.payload.errorCode : undefined);
    if (err.status === 410 || rawCode === 'RESYNC_REQUIRED') {
      return new NativeClientError(err.message, 410, 'RESYNC_REQUIRED', err.payload);
    }
    if (rawCode === 'DELIVERY_UNKNOWN' || rawCode === 'IDEMPOTENCY_CONFLICT' ||
        rawCode === 'BUSY' || rawCode === 'STALE_BINDING') {
      return new NativeClientError(err.message, err.status, rawCode, err.payload);
    }
    if (err.status === 422 || rawCode === 'UNSUPPORTED_ACTION') {
      return new NativeClientError(err.message, 422, 'UNSUPPORTED_ACTION', err.payload);
    }
    if (err.status === 403 || rawCode === 'FORBIDDEN') {
      return new NativeClientError(err.message, 403, 'FORBIDDEN', err.payload);
    }
    if (err.status === 404 || err.status === 501 || rawCode === 'NATIVE_RUNTIME_DISABLED' || rawCode === 'NATIVE_SCHEMA_NEWER_THAN_READER') {
      return new NativeClientError(err.message, err.status, 'ENDPOINT_UNAVAILABLE', err.payload);
    }
    return new NativeClientError(err.message, err.status, 'UNKNOWN_ERROR', err.payload);
  }
  return new NativeClientError(
    err instanceof Error ? err.message : String(err),
    0,
    'NETWORK_ERROR',
  );
}

// ── Transport Interface & HTTP Implementation ───────────────────────────

interface NativeLiveFeed {
  binding: RuntimeBinding;
  afterSeq: number;
  onEvent: (event: NativeCanonicalEvent) => void;
  onReady: (lastSeq: number) => void;
  onInterrupted: (reason: string) => void;
}

export interface NativeRuntimeTransport {
  readonly mode: 'http' | 'stub';
  watchEvents?(feed: NativeLiveFeed): () => void;
  getSnapshot(sessionId: string, signal?: AbortSignal): Promise<NativeSnapshotResponse>;
  getCapabilities(sessionId: string, signal?: AbortSignal): Promise<NativeCapabilitiesResponse>;
  getEvents(
    sessionId: string,
    params: { afterSeq: number; limit?: number; cursor?: string | null; generation?: BindingGeneration },
    signal?: AbortSignal,
  ): Promise<NativeEventsPageResponse>;
  getActivityTimeline(
    sessionId: string,
    activityId: ActivityId,
    params?: { pageToken?: string | null; limit?: number },
    signal?: AbortSignal,
  ): Promise<NativeTimelinePageResponse>;
  getAgentTimeline(
    sessionId: string,
    agentId: NativeAgentId,
    params?: { pageToken?: string | null; limit?: number },
    signal?: AbortSignal,
  ): Promise<NativeTimelinePageResponse>;
  getWorkflowResource(
    sessionId: string,
    workflowId: WorkflowId,
    resource: string,
    params?: { pageToken?: string | null; limit?: number },
    signal?: AbortSignal,
  ): Promise<NativeWorkflowResourcePageResponse>;
  submitCommand(
    sessionId: string,
    req: NativeCommandSubmitRequest,
    signal?: AbortSignal,
  ): Promise<NativeCommandSubmitResponse>;
  dispatchControl(
    sessionId: string,
    req: NativeControlRequest,
    signal?: AbortSignal,
  ): Promise<NativeControlResponse>;
  resolveNativeRequest(
    sessionId: string,
    approvalId: string,
    req: NativeRequestResolveRequest,
    signal?: AbortSignal,
  ): Promise<NativeRequestResolveResponse>;
}

function sameBinding(left: RuntimeBinding, right: RuntimeBinding): boolean {
  return left.sessionId === right.sessionId && left.instanceId === right.instanceId &&
    left.runtimeId === right.runtimeId && left.generation === right.generation;
}

function toReceipt(request: NativeRequestSummaryDto): NativeRequestReceiptDto {
  return {
    ...request,
    targetLineage: request.targetLineage === 'confirmed' ? 'confirmed' : 'unconfirmed',
  };
}

function toProjection(projection: WireProjection): NativeRuntimeProjection {
  return {
    ...projection,
    leaseReasons: projection.retentionReasons,
    receipts: Object.fromEntries((projection.requests ?? []).map(request => [
      request.approvalId, toReceipt(request),
    ])),
  };
}

function toNativeEvent(event: WireNativeEvent): NativeCanonicalEvent {
  switch (event.type) {
    case 'native.runtime.changed':
      return { ...event, payload: { ...event.payload, leaseReasons: event.payload.retentionReasons } };
    case 'native.relation.changed':
      return { ...event, payload: { relation: event.payload.relation, revoked: event.payload.op === 'revoke' } };
    case 'native.request.changed': {
      const request = event.payload;
      return {
        ...event,
        payload: {
          receipt: {
            approvalId: request.approvalId,
            receiptId: request.receiptId,
            receiptState: request.receiptState,
            kind: request.kind,
            agentId: request.targetAgentId,
            activityId: request.activityId,
            runtimeId: event.runtimeId,
            generation: event.generation,
            targetLineage: 'unconfirmed',
            allowedOptionIds: [],
            updatedAt: event.createdAt,
          },
        },
      };
    }
    case 'native.recovery.changed':
      return { ...event, payload: { ...event.payload, uncertainWorkIds: event.payload.uncertainEntityIds } };
    default:
      return event;
  }
}

type NativeResponseSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

async function nativeFetch<T>(
  path: string,
  schema: NativeResponseSchema<T>,
  init?: RequestInit,
): Promise<T> {
  const url = `${getDaemonBaseUrl()}${path}`;
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  try {
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    if (!res.ok) {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
      const errMsg = typeof obj?.message === 'string' ? obj.message : typeof obj?.error === 'string' ? obj.error : `HTTP ${res.status}`;
      throw classifyNativeError(new ApiHttpError(errMsg, res.status, obj));
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new NativeClientError('Invalid native response shape', 502, 'INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw classifyNativeError(err);
  }
}

function watchNativeEvents(path: string, feed: NativeLiveFeed): () => void {
  const url = new URL(path, getDaemonBaseUrl() || window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    socket.close();
  };
  const interrupt = (reason: string) => {
    if (closed) return;
    stop();
    feed.onInterrupted(reason);
  };
  const deadline = setTimeout(() => interrupt('native_feed_timeout'), 10_000);

  socket.addEventListener('message', ({ data }) => {
    if (closed) return;
    let input: unknown;
    try {
      input = JSON.parse(typeof data === 'string' ? data : '');
    } catch {
      interrupt('invalid_native_frame');
      return;
    }
    const parsed = NativeWsServerFrameSchema.safeParse(input);
    if (!parsed.success) {
      interrupt('invalid_native_frame');
      return;
    }
    const frame = parsed.data;
    switch (frame.op) {
      case 'native_hello':
        if (!frame.enabled || frame.sessionId !== feed.binding.sessionId ||
            (frame.runtimeId !== null && frame.runtimeId !== feed.binding.runtimeId) ||
            (frame.generation !== null && frame.generation !== feed.binding.generation)) {
          interrupt('native_binding_changed');
          return;
        }
        socket.send(JSON.stringify(NativeWsClientFrameSchema.parse({
          op: 'subscribe_native',
          schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
          afterSeq: feed.afterSeq,
          generation: feed.binding.generation,
        })));
        break;
      case 'native_event':
        if (frame.event.sessionId !== feed.binding.sessionId ||
            frame.event.runtimeId !== feed.binding.runtimeId ||
            frame.event.generation !== feed.binding.generation) {
          interrupt('native_binding_changed');
          return;
        }
        feed.onEvent(toNativeEvent(frame.event));
        break;
      case 'native_replay_complete':
        if (frame.runtimeId !== feed.binding.runtimeId || frame.generation !== feed.binding.generation) {
          interrupt('native_binding_changed');
          return;
        }
        clearTimeout(deadline);
        feed.onReady(frame.lastSeq);
        break;
      case 'native_resync_required':
      case 'native_error':
        interrupt(frame.code);
        break;
    }
  });
  socket.addEventListener('error', () => interrupt('native_feed_error'));
  socket.addEventListener('close', () => interrupt('native_feed_closed'));
  return stop;
}

export function createHttpNativeTransport(): NativeRuntimeTransport {
  const base = (sessionId: string) => `/api/v1/sessions/${encodeURIComponent(sessionId)}/native`;

  return {
    mode: 'http',
    watchEvents: (feed) => watchNativeEvents(`${base(feed.binding.sessionId)}/ws`, feed),
    getSnapshot: async (sessionId, signal) => {
      const response = await nativeFetch(`${base(sessionId)}/snapshot`, NativeSnapshotResponseSchema, { signal });
      return { ...response, projection: toProjection(response.projection) };
    },

    getCapabilities: (sessionId, signal) =>
      nativeFetch(`${base(sessionId)}/capabilities`, NativeCapabilitiesResponseSchema, { signal }),

    getEvents: async (sessionId, { afterSeq, limit = 200, cursor, generation }, signal) => {
      const qs = new URLSearchParams({ after: String(afterSeq), limit: String(limit) });
      if (cursor) qs.set('cursor', cursor);
      if (generation) qs.set('generation', generation);
      const page = await nativeFetch(`${base(sessionId)}/events?${qs.toString()}`, NativeEventsResponseSchema, {
        signal,
      });
      return { ...page, events: page.events.map(toNativeEvent) };
    },

    getActivityTimeline: (sessionId, activityId, params, signal) => {
      const qs = new URLSearchParams();
      if (params?.pageToken) qs.set('pageToken', params.pageToken);
      if (params?.limit) qs.set('limit', String(params.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return nativeFetch(
        `${base(sessionId)}/activity/${encodeURIComponent(activityId)}/timeline${suffix}`,
        NativeTimelineResponseSchema,
        { signal },
      );
    },

    getAgentTimeline: (sessionId, agentId, params, signal) => {
      const qs = new URLSearchParams();
      if (params?.pageToken) qs.set('pageToken', params.pageToken);
      if (params?.limit) qs.set('limit', String(params.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return nativeFetch(
        `${base(sessionId)}/agents/${encodeURIComponent(agentId)}/timeline${suffix}`,
        NativeTimelineResponseSchema,
        { signal },
      );
    },

    getWorkflowResource: (sessionId, workflowId, resource, params, signal) => {
      const qs = new URLSearchParams();
      if (params?.pageToken) qs.set('pageToken', params.pageToken);
      if (params?.limit) qs.set('limit', String(params.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return nativeFetch(
        `${base(sessionId)}/workflows/${encodeURIComponent(workflowId)}/${encodeURIComponent(resource)}${suffix}`,
        NativeWorkflowResourceResponseSchema,
        { signal },
      );
    },

    submitCommand: async (sessionId, req, signal) => {
      const response = await nativeFetch(`${base(sessionId)}/commands`, NativeCommandResponseSchema, {
        method: 'POST',
        body: JSON.stringify(NativeCommandRequestSchema.parse(req)),
        signal,
      });
      return response.kind === 'accepted'
        ? { ...response, status: 'accepted' }
        : { ...response, status: 'completed' };
    },

    dispatchControl: (sessionId, req, signal) =>
      nativeFetch(`${base(sessionId)}/control`, NativeControlResponseSchema, {
        method: 'POST',
        body: JSON.stringify(NativeControlRequestSchema.parse(req)),
        signal,
      }),

    resolveNativeRequest: (sessionId, approvalId, req, signal) =>
      nativeFetch(
        `${base(sessionId)}/requests/${encodeURIComponent(approvalId)}/resolve`,
        ResolveNativeRequestResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify(ResolveNativeRequestInputSchema.parse(req)),
          signal,
        },
      ),
  };
}

// ── Pure Projection Reducer & Delta Coalescing ──────────────────────────

function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const idx = list.findIndex((existing) => existing.id === item.id);
  if (idx < 0) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function removeById<T extends { id: string }>(list: readonly T[], id: string): T[] {
  const next = list.filter((existing) => existing.id !== id);
  return next.length === list.length ? (list as T[]) : next;
}

function upsertRelation(
  list: readonly NativeRelationship[],
  relation: NativeRelationship,
): NativeRelationship[] {
  // Enforce single-parent invariant per childAgentId (08_Shared_Contracts.md)
  const filtered = list.filter((existing) => existing.childAgentId !== relation.childAgentId);
  return [...filtered, relation];
}

export interface NativeApplyOutcome {
  projection: NativeRuntimeProjection;
  appliedCount: number;
  droppedStaleGenerationCount: number;
  droppedDuplicateSeqCount: number;
  seqGapDetected: { expectedSeq: number; receivedSeq: number } | null;
  /** Valid current-generation events with seq >= receivedSeq preserved for replay after gap repair. */
  unappliedAfterGap: NativeCanonicalEvent[];
  /** Present when an in-order frame announces a binding generation change requiring authoritative resync. */
  generationTransitionDetected: RuntimeBinding | null;
  capabilitiesChangedRevision: number | null;
  updatedCapabilities?: CapabilityDescriptor[];
}

export interface ApplyNativeBatchOptions {
  retiredGenerations?: ReadonlySet<string>;
}

/**
 * Applies a single or batched set of `NativeCanonicalEvent` frames idempotently
 * using strict `runtimeId + generation + seq` fencing.
 *
 * Rules:
 * - Events from ANY mismatched `runtimeId` or `generation` are strictly rejected (never allowing
 *   an old-binding `native.runtime.changed` frame to roll back the projection).
 * - Duplicate/older `seq <= asOfSeq` events are ignored idempotently.
 * - A `seq > asOfSeq + 1` gap halts live application, preserves the suffix in `unappliedAfterGap`,
 *   and signals `seqGapDetected` so the controller can catch up and replay without dropping frames.
 */
export function applyNativeEventBatch(
  current: NativeRuntimeProjection,
  rawEvents: readonly NativeCanonicalEvent[],
  options?: ApplyNativeBatchOptions,
): NativeApplyOutcome {
  if (rawEvents.length === 0) {
    return {
      projection: current,
      appliedCount: 0,
      droppedStaleGenerationCount: 0,
      droppedDuplicateSeqCount: 0,
      seqGapDetected: null,
      unappliedAfterGap: [],
      generationTransitionDetected: null,
      capabilitiesChangedRevision: null,
    };
  }

  const ordered = rawEvents.length > 1 ? [...rawEvents].sort((a, b) => a.seq - b.seq) : rawEvents;

  let next = current;
  let appliedCount = 0;
  let droppedStaleGenerationCount = 0;
  let droppedDuplicateSeqCount = 0;
  let seqGapDetected: { expectedSeq: number; receivedSeq: number } | null = null;
  const unappliedAfterGap: NativeCanonicalEvent[] = [];
  let generationTransitionDetected: RuntimeBinding | null = null;
  let capabilitiesChangedRevision: number | null = null;
  let updatedCapabilities: CapabilityDescriptor[] | undefined;

  for (let i = 0; i < ordered.length; i += 1) {
    const event = ordered[i]!;
    if (
      event.runtimeId !== next.binding.runtimeId ||
      event.generation !== next.binding.generation
    ) {
      droppedStaleGenerationCount += 1;
      continue;
    }

    if (event.seq <= next.asOfSeq) {
      droppedDuplicateSeqCount += 1;
      continue;
    }

    if (event.seq > next.asOfSeq + 1) {
      seqGapDetected = { expectedSeq: next.asOfSeq + 1, receivedSeq: event.seq };
      for (let j = i; j < ordered.length; j += 1) {
        const trailing = ordered[j]!;
        if (
          trailing.runtimeId === next.binding.runtimeId &&
          trailing.generation === next.binding.generation &&
          trailing.seq > next.asOfSeq
        ) {
          unappliedAfterGap.push(trailing);
        } else if (
          trailing.runtimeId !== next.binding.runtimeId ||
          trailing.generation !== next.binding.generation
        ) {
          droppedStaleGenerationCount += 1;
        }
      }
      break;
    }

    if (
      event.type === 'native.runtime.changed' &&
      event.payload.binding &&
      (event.payload.binding.runtimeId !== next.binding.runtimeId ||
        event.payload.binding.generation !== next.binding.generation)
    ) {
      if (options?.retiredGenerations?.has(event.payload.binding.generation)) {
        droppedStaleGenerationCount += 1;
        continue;
      }
      // Signal authoritative resync on binding transition instead of mutating generation in-place
      generationTransitionDetected = event.payload.binding;
      break;
    }

    appliedCount += 1;

    switch (event.type) {
      case 'native.runtime.changed': {
        next = {
          ...next,
          asOfSeq: event.seq,
          status: event.payload.status,
          leaseReasons: event.payload.leaseReasons ?? next.leaseReasons,
        };
        break;
      }
      case 'native.activity.changed': {
        const activities = event.payload.removed
          ? removeById(next.activities, event.payload.activity.id)
          : upsertById(next.activities, event.payload.activity);
        next = { ...next, asOfSeq: event.seq, activities };
        break;
      }
      case 'native.work.changed': {
        const work = event.payload.removed
          ? removeById(next.work, event.payload.work.id)
          : upsertById(next.work, event.payload.work);
        next = { ...next, asOfSeq: event.seq, work };
        break;
      }
      case 'native.agent.changed': {
        const agents = event.payload.removed
          ? removeById(next.agents, event.payload.agent.id)
          : upsertById(next.agents, event.payload.agent);
        next = { ...next, asOfSeq: event.seq, agents };
        break;
      }
      case 'native.relation.changed': {
        const rel = event.payload.relation;
        const relations = event.payload.revoked
          ? next.relations.filter(
              (r) => !(r.parentAgentId === rel.parentAgentId && r.childAgentId === rel.childAgentId),
            )
          : upsertRelation(next.relations, rel);
        next = { ...next, asOfSeq: event.seq, relations };
        break;
      }
      case 'native.workflow.changed': {
        const workflows = event.payload.removed
          ? removeById(next.workflows, event.payload.workflow.id)
          : upsertById(next.workflows, event.payload.workflow);
        next = { ...next, asOfSeq: event.seq, workflows };
        break;
      }
      case 'native.request.changed': {
        const receipt = event.payload.receipt;
        const nextReceipts = { ...(next.receipts ?? {}) };
        let nextRequestIds = next.requestIds;
        if (event.payload.removed) {
          delete nextReceipts[receipt.approvalId];
          nextRequestIds = nextRequestIds.filter((id) => id !== receipt.approvalId);
        } else {
          nextReceipts[receipt.approvalId] = receipt;
          const isActive = receipt.receiptState === 'pending' || receipt.receiptState === 'claimed';
          if (isActive && !nextRequestIds.includes(receipt.approvalId)) {
            nextRequestIds = [...nextRequestIds, receipt.approvalId];
          } else if (!isActive && nextRequestIds.includes(receipt.approvalId)) {
            nextRequestIds = nextRequestIds.filter((id) => id !== receipt.approvalId);
          }
        }
        next = {
          ...next,
          asOfSeq: event.seq,
          requestIds: nextRequestIds,
          receipts: nextReceipts,
        };
        break;
      }
      case 'native.capabilities.changed': {
        capabilitiesChangedRevision = event.payload.capabilitiesRevision;
        updatedCapabilities = event.payload.descriptors;
        next = {
          ...next,
          asOfSeq: event.seq,
          capabilitiesRevision: event.payload.capabilitiesRevision,
        };
        break;
      }
      case 'native.recovery.changed': {
        const uncertain = new Set(event.payload.uncertainWorkIds ?? []);
        const work =
          uncertain.size > 0
            ? next.work.map((item) =>
                uncertain.has(item.id)
                  ? {
                      ...item,
                      state: {
                        kind: 'stale' as const,
                        last: item.state.kind === 'known' ? item.state.value : item.state.kind === 'stale' ? item.state.last : undefined,
                        evidence: item.state.kind === 'known' ? item.state.evidence : item.state.kind === 'stale' ? item.state.evidence : undefined,
                        reasonCode: event.payload.reasonCode ?? 'recovery_reconciling',
                      },
                    }
                  : item,
              )
            : next.work;
        next = {
          ...next,
          asOfSeq: event.seq,
          status: event.payload.status,
          work,
        };
        break;
      }
    }
  }

  return {
    projection: next,
    appliedCount,
    droppedStaleGenerationCount,
    droppedDuplicateSeqCount,
    seqGapDetected,
    unappliedAfterGap,
    generationTransitionDetected,
    capabilitiesChangedRevision,
    updatedCapabilities,
  };
}

/**
 * Coalesces consecutive text deltas that share an explicit `deltaCoalesceKey`, `kind`, and actor
 * identity (`actorKind` + `actorId`) while preserving every merged `entryId` so re-delivered
 * deltas are never duplicated and distinct actors never cross-merge.
 */
export function coalesceTimelineEntries(
  existing: readonly NativeTimelineEntry[],
  incoming: readonly NativeTimelineEntry[],
): NativeTimelineEntry[] {
  if (incoming.length === 0) return existing.slice();
  const seenIds = new Set<string>();
  for (const entry of existing) {
    seenIds.add(entry.entryId);
    if (entry.mergedEntryIds) {
      for (const mergedId of entry.mergedEntryIds) seenIds.add(mergedId);
    }
  }
  const merged = existing.slice();

  for (const item of incoming) {
    const itemIds = item.mergedEntryIds?.length ? item.mergedEntryIds : [item.entryId];
    if (seenIds.has(item.entryId) || itemIds.every((id) => seenIds.has(id))) continue;
    seenIds.add(item.entryId);
    for (const id of itemIds) seenIds.add(id);

    const prev = merged.at(-1);
    const sameActor =
      prev !== undefined &&
      prev.actorKind === item.actorKind &&
      (prev.actorId ?? '') === (item.actorId ?? '');

    if (
      prev &&
      sameActor &&
      item.deltaCoalesceKey &&
      prev.deltaCoalesceKey === item.deltaCoalesceKey &&
      prev.kind === item.kind &&
      typeof prev.text === 'string' &&
      typeof item.text === 'string'
    ) {
      const priorMerged = prev.mergedEntryIds ?? [prev.entryId];
      merged[merged.length - 1] = {
        ...prev,
        seq: Math.max(prev.seq, item.seq),
        timestamp: Math.max(prev.timestamp, item.timestamp),
        text: prev.text + item.text,
        mergedEntryIds: [...priorMerged, ...itemIds],
      };
    } else {
      merged.push(item);
    }
  }

  return merged;
}

// ── Snapshot + Cursor Feed Controller (03b Core Engine) ─────────────────

export interface NativeFeedSyncState {
  phase:
    | 'idle'
    | 'hydrating'
    | 'live'
    | 'catching_up'
    | 'resyncing'
    | 'incomplete'
    | 'unavailable'
    | 'error';
  resyncCount: number;
  droppedStaleEvents: number;
  incompleteReason?: string | null;
  lastError?: string | null;
  lastSyncedAt: number | null;
}

export interface NativeFeedControllerOptions {
  sessionId: string;
  transport: NativeRuntimeTransport;
  batchWindowMs?: number;
  pageLimit?: number;
  maxPages?: number;
  maxResyncAttempts?: number;
  onUpdate: (update: {
    projection: NativeRuntimeProjection | null;
    capabilities: CapabilityDescriptor[];
    syncState: NativeFeedSyncState;
  }) => void;
}

const MAX_QUEUED_EVENTS = 5_000;
const MAX_PENDING_GAP_EVENTS = 2_000;

/**
 * Manages snapshot hydration, paginated catch-up (`GET /events?after=...`),
 * `410 RESYNC_REQUIRED` recovery, seq-gap suffix preservation & replay, monotonic
 * generation fencing, request-epoch ordering, and frame-batched live flushing.
 */
export class NativeFeedController {
  private projection: NativeRuntimeProjection | null = null;
  private capabilities: CapabilityDescriptor[] = [];
  private syncState: NativeFeedSyncState = {
    phase: 'idle',
    resyncCount: 0,
    droppedStaleEvents: 0,
    incompleteReason: null,
    lastError: null,
    lastSyncedAt: null,
  };
  private queuedEvents: NativeCanonicalEvent[] = [];
  private pendingAfterGap = new Map<number, NativeCanonicalEvent>();
  private stopWatching: (() => void) | null = null;
  private liveFeedReady = false;
  private liveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private liveRetryCount = 0;
  private gapTargetSeq: number | null = null;
  private retiredGenerations = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private catchUpEpoch: number | null = null;
  private requestEpoch = 0;
  private resyncAttemptsInCycle = 0;

  constructor(private readonly options: NativeFeedControllerOptions) {}

  getSnapshot(): {
    projection: NativeRuntimeProjection | null;
    capabilities: CapabilityDescriptor[];
    syncState: NativeFeedSyncState;
  } {
    return {
      projection: this.projection,
      capabilities: this.capabilities,
      syncState: this.syncState,
    };
  }

  async hydrate(isResync = false): Promise<void> {
    if (this.disposed) return;
    if (!isResync) {
      this.resyncAttemptsInCycle = 0;
      this.liveRetryCount = 0;
    }
    this.stopLiveFeed();
    this.abortInFlight();
    const epoch = ++this.requestEpoch;
    const controller = new AbortController();
    this.abortController = controller;
    this.updateSync({
      phase: this.projection ? 'resyncing' : 'hydrating',
      incompleteReason: null,
      lastError: null,
    });

    try {
      const [snapRes, capRes] = await Promise.all([
        this.options.transport.getSnapshot(this.options.sessionId, controller.signal),
        this.options.transport.getCapabilities(this.options.sessionId, controller.signal),
      ]);
      if (this.disposed || controller.signal.aborted || epoch !== this.requestEpoch) return;

      const incomingBinding = snapRes.projection.binding;
      if (incomingBinding.sessionId !== this.options.sessionId ||
          !sameBinding(incomingBinding, capRes.binding) ||
          snapRes.projection.capabilitiesRevision !== capRes.capabilitiesRevision) {
        this.capabilities = [];
        this.updateSync({
          phase: 'incomplete',
          incompleteReason: 'capabilities_binding_mismatch',
          lastError: '会话绑定或能力目录已变化，请重试同步。',
        });
        return;
      }
      if (
        this.projection &&
        (this.projection.binding.runtimeId !== incomingBinding.runtimeId ||
          this.projection.binding.generation !== incomingBinding.generation)
      ) {
        // Retire old generation and clear gap state belonging to the previous binding
        if (this.retiredGenerations.has(incomingBinding.generation)) {
          this.updateSync({
            phase: 'incomplete',
            incompleteReason: 'stale_snapshot_generation',
            lastError: '服务端返回了已退役的旧绑定快照，请重试同步。',
          });
          return;
        }
        this.retiredGenerations.add(this.projection.binding.generation);
        this.pendingAfterGap.clear();
        this.gapTargetSeq = null;
      }

      if (this.projection && sameBinding(this.projection.binding, incomingBinding) &&
          snapRes.projection.asOfSeq < this.projection.asOfSeq) {
        this.capabilities = [];
        this.updateSync({
          phase: 'incomplete',
          incompleteReason: 'snapshot_watermark_regressed',
          lastError: '服务端快照早于当前事件水位，请重试同步。',
        });
        return;
      }
      this.projection = snapRes.projection;
      this.capabilities = capRes.descriptors;
      this.updateSync({
        phase: 'catching_up',
        lastSyncedAt: Date.now(),
        incompleteReason: null,
        lastError: null,
      });

      await this.catchUp(controller.signal, epoch);
    } catch (err) {
      if (
        this.disposed ||
        epoch !== this.requestEpoch ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        return;
      }
      const typed = classifyNativeError(err);
      this.updateSync({
        phase: typed.code === 'ENDPOINT_UNAVAILABLE' ? 'unavailable' : 'error',
        lastError: typed.message,
      });
    }
  }

  async catchUp(externalSignal?: AbortSignal, expectedEpoch?: number): Promise<void> {
    const epoch = expectedEpoch ?? this.requestEpoch;
    if (this.disposed || !this.projection || this.catchUpEpoch === epoch) return;
    this.catchUpEpoch = epoch;
    const signal = externalSignal ?? this.abortController?.signal;
    const maxPages = this.options.maxPages ?? 50;
    const maxResyncAttempts = this.options.maxResyncAttempts ?? 2;

    try {
      let cursor: string | null = null;
      let hitPageLimit = false;
      let pageGapDetected = false;
      let generationChanged = false;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        if (this.disposed || signal?.aborted || epoch !== this.requestEpoch || !this.projection) {
          return;
        }
        const page = await this.options.transport.getEvents(
          this.options.sessionId,
          {
            afterSeq: this.projection.asOfSeq,
            generation: this.projection.binding.generation,
            limit: this.options.pageLimit ?? 200,
            cursor,
          },
          signal,
        );
        if (this.disposed || signal?.aborted || epoch !== this.requestEpoch || !this.projection) {
          return;
        }

        // If backend binding generation changed during catch-up, require full snapshot resync
        if (!sameBinding(page.binding, this.projection.binding)) {
          if (this.retiredGenerations.has(page.binding.generation)) {
            this.syncState = {
              ...this.syncState,
              droppedStaleEvents: this.syncState.droppedStaleEvents + Math.max(1, page.events.length),
            };
            pageGapDetected = true;
            break;
          }
          generationChanged = true;
          break;
        }

        if (page.events.length > 0) {
          const outcome = applyNativeEventBatch(this.projection, page.events, {
            retiredGenerations: this.retiredGenerations,
          });
          this.projection = outcome.projection;
          if (outcome.capabilitiesChangedRevision !== null) {
            this.capabilities = outcome.updatedCapabilities ?? [];
          }
          if (outcome.droppedStaleGenerationCount > 0) {
            this.syncState = {
              ...this.syncState,
              droppedStaleEvents:
                this.syncState.droppedStaleEvents + outcome.droppedStaleGenerationCount,
            };
          }
          if (outcome.capabilitiesChangedRevision !== null && !outcome.updatedCapabilities) {
            void this.refreshCapabilities();
          }
          if (outcome.generationTransitionDetected) {
            generationChanged = true;
            break;
          }
          if (outcome.seqGapDetected) {
            this.retainAfterGap(outcome.unappliedAfterGap);
            pageGapDetected = true;
            break;
          }
        }

        cursor = page.nextCursor;
        if (!page.hasMore || page.events.length === 0) break;
        if (pageIndex === maxPages - 1 && page.hasMore) {
          hitPageLimit = true;
        }
      }

      if (this.disposed || signal?.aborted || epoch !== this.requestEpoch || !this.projection) {
        return;
      }

      if (generationChanged) {
        if (this.resyncAttemptsInCycle < maxResyncAttempts) {
          this.resyncAttemptsInCycle += 1;
          this.syncState = { ...this.syncState, resyncCount: this.syncState.resyncCount + 1 };
          await this.hydrate(true);
        } else {
          this.updateSync({
            phase: 'incomplete',
            incompleteReason: 'generation_resync_exhausted',
            lastError: '绑定代次多次变更，超过自动重同步上限，请手动刷新。',
          });
        }
        return;
      }

      // Replay any buffered post-gap suffix events now that the prefix may have filled in
      this.replayPendingAfterGap();

      const hasUnresolvedGap =
        pageGapDetected ||
        this.pendingAfterGap.size > 0 ||
        (this.gapTargetSeq !== null && this.projection.asOfSeq < this.gapTargetSeq);

      if (hasUnresolvedGap) {
        if (this.resyncAttemptsInCycle < maxResyncAttempts) {
          this.resyncAttemptsInCycle += 1;
          this.syncState = { ...this.syncState, resyncCount: this.syncState.resyncCount + 1 };
          await this.hydrate(true);
        } else {
          this.updateSync({
            phase: 'incomplete',
            incompleteReason: pageGapDetected ? 'seq_gap_unresolved' : 'gap_catchup_empty',
            lastError: `事件补缺未完成（当前水位 #${this.projection.asOfSeq}），请点击重试同步。`,
          });
        }
        return;
      }

      if (hitPageLimit) {
        this.updateSync({
          phase: 'incomplete',
          incompleteReason: 'page_limit_reached',
          lastError: `事件分页达到单次上限（${maxPages} 页），数据未完成同步，请点击重试继续拉取。`,
        });
        return;
      }

      this.gapTargetSeq = null;
      this.resyncAttemptsInCycle = 0;
      if (this.options.transport.watchEvents && !this.projection.enabled) {
        this.updateSync({ phase: 'unavailable' });
      } else if (this.options.transport.watchEvents && !this.liveFeedReady) {
        this.startLiveFeed(epoch);
      } else {
        this.updateSync({ phase: 'live', incompleteReason: null, lastSyncedAt: Date.now(), lastError: null });
      }
    } catch (err) {
      if (
        this.disposed ||
        epoch !== this.requestEpoch ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        return;
      }
      const typed = classifyNativeError(err);
      if (typed.code === 'RESYNC_REQUIRED') {
        if (this.resyncAttemptsInCycle < maxResyncAttempts) {
          this.resyncAttemptsInCycle += 1;
          this.syncState = {
            ...this.syncState,
            resyncCount: this.syncState.resyncCount + 1,
          };
          await this.hydrate(true);
        } else {
          this.updateSync({
            phase: 'incomplete',
            incompleteReason: 'resync_limit_reached',
            lastError: '游标连续过期，超过自动重同步上限，请点击重试。',
          });
        }
        return;
      }
      this.updateSync({
        phase: typed.code === 'ENDPOINT_UNAVAILABLE' ? 'unavailable' : 'error',
        lastError: typed.message,
      });
    } finally {
      if (this.catchUpEpoch === epoch) this.catchUpEpoch = null;
    }

    // Drain any events queued before or during hydration/catch-up once live
    if (
      !this.disposed &&
      epoch === this.requestEpoch &&
      this.syncState.phase === 'live' &&
      this.queuedEvents.length > 0
    ) {
      this.flushNow();
    }
  }

  /**
   * Pushes live events from WS/subscription into a bounded micro-batched queue.
   * Events arriving before initial hydration completes are retained and drained after hydrate().
   */
  enqueueLiveEvents(events: readonly NativeCanonicalEvent[]): void {
    if (this.disposed || events.length === 0) return;
    this.queuedEvents.push(...events);
    if (this.queuedEvents.length > MAX_QUEUED_EVENTS) {
      this.queuedEvents = this.queuedEvents.slice(-MAX_QUEUED_EVENTS);
    }
    const windowMs = this.options.batchWindowMs ?? 16;
    if (windowMs <= 0) {
      this.flushNow();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushNow();
      }, windowMs);
    }
  }

  flushNow(): void {
    if (this.disposed) return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Keep queued events buffered until initial snapshot & active catch-up complete
    if (this.queuedEvents.length === 0 || !this.projection || this.catchUpEpoch === this.requestEpoch) return;
    const batch = this.queuedEvents;
    this.queuedEvents = [];

    const outcome = applyNativeEventBatch(this.projection, batch, {
      retiredGenerations: this.retiredGenerations,
    });
    this.projection = outcome.projection;
    if (outcome.capabilitiesChangedRevision !== null) {
      this.capabilities = outcome.updatedCapabilities ?? [];
    }
    if (outcome.droppedStaleGenerationCount > 0) {
      this.syncState = {
        ...this.syncState,
        droppedStaleEvents:
          this.syncState.droppedStaleEvents + outcome.droppedStaleGenerationCount,
      };
    }

    if (outcome.generationTransitionDetected) {
      this.retiredGenerations.add(this.projection.binding.generation);
      this.pendingAfterGap.clear();
      this.gapTargetSeq = null;
      this.syncState = { ...this.syncState, resyncCount: this.syncState.resyncCount + 1 };
      void this.hydrate(true);
      return;
    }

    if (outcome.appliedCount > 0 || outcome.droppedStaleGenerationCount > 0) {
      this.emit();
    }

    if (outcome.capabilitiesChangedRevision !== null && !outcome.updatedCapabilities) {
      void this.refreshCapabilities();
    }

    if (outcome.seqGapDetected) {
      this.retainAfterGap(outcome.unappliedAfterGap);
      this.updateSync({ phase: 'catching_up', incompleteReason: null });
      void this.catchUp();
    }
  }

  private startLiveFeed(epoch: number): void {
    const transport = this.options.transport;
    const projection = this.projection;
    if (!transport.watchEvents || !projection || this.stopWatching || this.liveRetryTimer) return;

    const binding = projection.binding;
    const stillCurrent = () => !this.disposed && epoch === this.requestEpoch &&
      this.projection !== null && sameBinding(binding, this.projection.binding);
    const recover = (reason: string) => {
      if (!stillCurrent()) return;
      this.stopLiveFeed();
      this.capabilities = [];
      this.updateSync({
        phase: 'incomplete',
        incompleteReason: reason,
        lastError: '原生事件流已中断，请重试同步。',
      });
      if (this.liveRetryCount < 3) {
        const delay = 300 * 2 ** this.liveRetryCount++;
        this.liveRetryTimer = setTimeout(() => {
          this.liveRetryTimer = null;
          if (stillCurrent()) void this.hydrate(true);
        }, delay);
      }
    };

    try {
      this.stopWatching = transport.watchEvents({
        binding,
        afterSeq: projection.asOfSeq,
        onEvent: (event) => {
          if (stillCurrent()) this.enqueueLiveEvents([event]);
        },
        onReady: (lastSeq) => {
          if (!stillCurrent()) return;
          this.flushNow();
          if (!stillCurrent() || !this.projection) return;
          if (this.projection.asOfSeq < lastSeq) {
            recover('native_replay_gap');
            return;
          }
          this.liveFeedReady = true;
          this.updateSync({ phase: 'live', incompleteReason: null, lastSyncedAt: Date.now(), lastError: null });
        },
        onInterrupted: recover,
      });
    } catch {
      recover('native_feed_start_failed');
    }
  }

  private stopLiveFeed(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.liveFeedReady = false;
    if (this.liveRetryTimer) {
      clearTimeout(this.liveRetryTimer);
      this.liveRetryTimer = null;
    }
  }

  async refreshCapabilities(): Promise<void> {
    if (this.disposed || !this.projection) return;
    const epoch = this.requestEpoch;
    const binding = this.projection.binding;
    try {
      const capRes = await this.options.transport.getCapabilities(
        this.options.sessionId,
        this.abortController?.signal,
      );
      if (this.disposed || epoch !== this.requestEpoch || !this.projection) return;
      if (!sameBinding(binding, this.projection.binding) ||
          !sameBinding(binding, capRes.binding) ||
          capRes.capabilitiesRevision !== this.projection.capabilitiesRevision) return;
      this.capabilities = capRes.descriptors;
      this.emit();
    } catch {
      // Keep last known descriptors; surface error only during full hydration
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopLiveFeed();
    this.requestEpoch += 1;
    this.abortInFlight();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queuedEvents = [];
    this.pendingAfterGap.clear();
    this.gapTargetSeq = null;
  }

  private retainAfterGap(events: readonly NativeCanonicalEvent[]): void {
    for (const ev of events) {
      this.pendingAfterGap.set(ev.seq, ev);
      this.gapTargetSeq =
        this.gapTargetSeq === null ? ev.seq : Math.max(this.gapTargetSeq, ev.seq);
    }
    if (this.pendingAfterGap.size > MAX_PENDING_GAP_EVENTS) {
      const sortedKeys = [...this.pendingAfterGap.keys()].sort((a, b) => a - b);
      const excess = sortedKeys.length - MAX_PENDING_GAP_EVENTS;
      for (let i = 0; i < excess; i += 1) {
        this.pendingAfterGap.delete(sortedKeys[i]!);
      }
    }
  }

  private replayPendingAfterGap(): void {
    if (!this.projection || this.pendingAfterGap.size === 0) return;
    const pending = [...this.pendingAfterGap.values()].sort((a, b) => a.seq - b.seq);
    this.pendingAfterGap.clear();
    const outcome = applyNativeEventBatch(this.projection, pending, {
      retiredGenerations: this.retiredGenerations,
    });
    this.projection = outcome.projection;
    if (outcome.capabilitiesChangedRevision !== null) {
      this.capabilities = outcome.updatedCapabilities ?? [];
    }
    if (outcome.capabilitiesChangedRevision !== null && !outcome.updatedCapabilities) {
      void this.refreshCapabilities();
    }
    if (outcome.unappliedAfterGap.length > 0) {
      this.retainAfterGap(outcome.unappliedAfterGap);
    }
  }

  private abortInFlight(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private updateSync(patch: Partial<NativeFeedSyncState>): void {
    this.syncState = { ...this.syncState, ...patch };
    this.emit();
  }

  private emit(): void {
    this.options.onUpdate({
      projection: this.projection,
      capabilities: this.capabilities,
      syncState: this.syncState,
    });
  }
}

// ── Idempotency Key Helper ──────────────────────────────────────────────

export function createNativeIdempotencyKey(
  scope: string,
  payloadDigest: string,
  nonce = Date.now().toString(36),
): string {
  return `np_${scope}_${payloadDigest}_${nonce}`;
}

export const defaultNativeTransport: NativeRuntimeTransport = createHttpNativeTransport();
