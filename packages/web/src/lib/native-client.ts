import { ApiHttpError, getDaemonBaseUrl } from '../api/client';

/**
 * NP-03 Frozen Frontend Native Runtime Contract Mirror (aligned to 08_Shared_Contracts.md v0.1).
 *
 * Once NP-02 G1 freezes `@harnessmate/protocol` native DTO exports, this module can swap its
 * type definitions to re-export from `@harnessmate/protocol` without breaking NP-03 / NP-04..NP-15 consumers.
 */
export const NATIVE_FRONTEND_CONTRACT_REVISION = '0.1-np03-stub' as const;
export const NATIVE_SCHEMA_VERSION = 1 as const;

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

export type EvidenceFreshness = 'fresh' | 'stale' | 'unknown';

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
  state: 'requested' | 'confirmed' | 'unknown';
  reasonCode?: string;
}

export interface NativeRequestResolveRequest {
  generation: BindingGeneration;
  optionId?: string;
  formPayload?: Record<string, unknown>;
  decision?: 'allow_once' | 'allow_session' | 'deny';
  idempotencyKey: string;
}

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
    if (err.status === 409) {
      const code: NativeErrorCode = rawCode === 'BUSY' ? 'BUSY' : 'STALE_BINDING';
      return new NativeClientError(err.message, 409, code, err.payload);
    }
    if (err.status === 422 || rawCode === 'UNSUPPORTED_ACTION') {
      return new NativeClientError(err.message, 422, 'UNSUPPORTED_ACTION', err.payload);
    }
    if (err.status === 403 || rawCode === 'FORBIDDEN') {
      return new NativeClientError(err.message, 403, 'FORBIDDEN', err.payload);
    }
    if (err.status === 404 || err.status === 501) {
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

export interface NativeRuntimeTransport {
  readonly mode: 'http' | 'stub';
  getSnapshot(sessionId: string, signal?: AbortSignal): Promise<NativeSnapshotResponse>;
  getCapabilities(sessionId: string, signal?: AbortSignal): Promise<NativeCapabilitiesResponse>;
  getEvents(
    sessionId: string,
    params: { afterSeq: number; limit?: number; cursor?: string | null },
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeBinding(value: unknown): value is RuntimeBinding {
  return (
    isRecord(value) &&
    typeof value.runtimeId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.instanceId === 'string' &&
    typeof value.generation === 'string'
  );
}

function assertSnapshotResponse(data: unknown): NativeSnapshotResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    !isRecord(data.projection) ||
    data.projection.schemaVersion !== 1 ||
    !isRuntimeBinding(data.projection.binding) ||
    typeof data.projection.asOfSeq !== 'number' ||
    !Array.isArray(data.projection.activities) ||
    !Array.isArray(data.projection.work) ||
    !Array.isArray(data.projection.agents) ||
    !Array.isArray(data.projection.relations) ||
    !Array.isArray(data.projection.workflows) ||
    !Array.isArray(data.projection.requestIds)
  ) {
    throw new NativeClientError('Invalid native snapshot response shape', 502, 'INVALID_RESPONSE');
  }
  return data as unknown as NativeSnapshotResponse;
}

function assertCapabilitiesResponse(data: unknown): NativeCapabilitiesResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    typeof data.capabilitiesRevision !== 'number' ||
    !Array.isArray(data.descriptors)
  ) {
    throw new NativeClientError(
      'Invalid native capabilities response shape',
      502,
      'INVALID_RESPONSE',
    );
  }
  return data as unknown as NativeCapabilitiesResponse;
}

function assertEventsPageResponse(data: unknown): NativeEventsPageResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    !isRuntimeBinding(data.binding) ||
    typeof data.asOfSeq !== 'number' ||
    !Array.isArray(data.events) ||
    typeof data.hasMore !== 'boolean'
  ) {
    throw new NativeClientError('Invalid native events page response shape', 502, 'INVALID_RESPONSE');
  }
  return data as unknown as NativeEventsPageResponse;
}

function assertTimelinePageResponse(data: unknown): NativeTimelinePageResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    (data.scopeKind !== 'activity' && data.scopeKind !== 'agent') ||
    typeof data.scopeId !== 'string' ||
    !Array.isArray(data.items) ||
    typeof data.hasMore !== 'boolean'
  ) {
    throw new NativeClientError('Invalid native timeline response shape', 502, 'INVALID_RESPONSE');
  }
  return data as unknown as NativeTimelinePageResponse;
}

function assertWorkflowResourcePageResponse(data: unknown): NativeWorkflowResourcePageResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    typeof data.workflowId !== 'string' ||
    typeof data.resource !== 'string' ||
    !Array.isArray(data.items) ||
    typeof data.hasMore !== 'boolean'
  ) {
    throw new NativeClientError(
      'Invalid native workflow resource response shape',
      502,
      'INVALID_RESPONSE',
    );
  }
  return data as unknown as NativeWorkflowResourcePageResponse;
}

function assertCommandSubmitResponse(data: unknown): NativeCommandSubmitResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    (data.status !== 'accepted' && data.status !== 'completed')
  ) {
    throw new NativeClientError('Invalid native command response shape', 502, 'INVALID_RESPONSE');
  }
  return data as unknown as NativeCommandSubmitResponse;
}

function assertControlResponse(data: unknown): NativeControlResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    typeof data.receiptId !== 'string' ||
    (data.state !== 'requested' && data.state !== 'confirmed' && data.state !== 'unknown')
  ) {
    throw new NativeClientError('Invalid native control response shape', 502, 'INVALID_RESPONSE');
  }
  return data as unknown as NativeControlResponse;
}

function assertRequestResolveResponse(data: unknown): NativeRequestResolveResponse {
  if (
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    typeof data.approvalId !== 'string' ||
    typeof data.receiptId !== 'string' ||
    typeof data.receiptState !== 'string'
  ) {
    throw new NativeClientError('Invalid native request resolve response shape', 502, 'INVALID_RESPONSE');
  }
  return data as unknown as NativeRequestResolveResponse;
}

async function nativeFetch<T>(
  path: string,
  validate: (data: unknown) => T,
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
      const errMsg = obj && 'error' in obj ? String(obj.error) : `HTTP ${res.status}`;
      throw classifyNativeError(new ApiHttpError(errMsg, res.status, obj));
    }
    return validate(data);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw classifyNativeError(err);
  }
}

export function createHttpNativeTransport(): NativeRuntimeTransport {
  const base = (sessionId: string) => `/api/v1/sessions/${encodeURIComponent(sessionId)}/native`;

  return {
    mode: 'http',
    getSnapshot: (sessionId, signal) =>
      nativeFetch(`${base(sessionId)}/snapshot`, assertSnapshotResponse, { signal }),

    getCapabilities: (sessionId, signal) =>
      nativeFetch(`${base(sessionId)}/capabilities`, assertCapabilitiesResponse, { signal }),

    getEvents: (sessionId, { afterSeq, limit = 200, cursor }, signal) => {
      const qs = new URLSearchParams({ after: String(afterSeq), limit: String(limit) });
      if (cursor) qs.set('cursor', cursor);
      return nativeFetch(`${base(sessionId)}/events?${qs.toString()}`, assertEventsPageResponse, {
        signal,
      });
    },

    getActivityTimeline: (sessionId, activityId, params, signal) => {
      const qs = new URLSearchParams();
      if (params?.pageToken) qs.set('pageToken', params.pageToken);
      if (params?.limit) qs.set('limit', String(params.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return nativeFetch(
        `${base(sessionId)}/activity/${encodeURIComponent(activityId)}/timeline${suffix}`,
        assertTimelinePageResponse,
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
        assertTimelinePageResponse,
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
        assertWorkflowResourcePageResponse,
        { signal },
      );
    },

    submitCommand: (sessionId, req, signal) =>
      nativeFetch(`${base(sessionId)}/commands`, assertCommandSubmitResponse, {
        method: 'POST',
        body: JSON.stringify(req),
        signal,
      }),

    dispatchControl: (sessionId, req, signal) =>
      nativeFetch(`${base(sessionId)}/control`, assertControlResponse, {
        method: 'POST',
        body: JSON.stringify(req),
        signal,
      }),

    resolveNativeRequest: (sessionId, approvalId, req, signal) =>
      nativeFetch(
        `${base(sessionId)}/requests/${encodeURIComponent(approvalId)}/resolve`,
        assertRequestResolveResponse,
        {
          method: 'POST',
          body: JSON.stringify(req),
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
        if (event.payload.descriptors) {
          updatedCapabilities = event.payload.descriptors;
        }
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
  private gapTargetSeq: number | null = null;
  private retiredGenerations = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private catchingUp = false;
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
    }
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
    if (this.disposed || !this.projection || this.catchingUp) return;
    this.catchingUp = true;
    const epoch = expectedEpoch ?? this.requestEpoch;
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
            limit: this.options.pageLimit ?? 200,
            cursor,
          },
          signal,
        );
        if (this.disposed || signal?.aborted || epoch !== this.requestEpoch || !this.projection) {
          return;
        }

        // If backend binding generation changed during catch-up, require full snapshot resync
        if (
          page.binding.runtimeId !== this.projection.binding.runtimeId ||
          page.binding.generation !== this.projection.binding.generation
        ) {
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
          if (outcome.updatedCapabilities) {
            this.capabilities = outcome.updatedCapabilities;
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
        this.catchingUp = false;
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
        this.catchingUp = false;
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
      this.updateSync({
        phase: 'live',
        incompleteReason: null,
        lastSyncedAt: Date.now(),
        lastError: null,
      });
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
        this.catchingUp = false;
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
      this.catchingUp = false;
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
    if (this.queuedEvents.length === 0 || !this.projection || this.catchingUp) return;
    const batch = this.queuedEvents;
    this.queuedEvents = [];

    const outcome = applyNativeEventBatch(this.projection, batch, {
      retiredGenerations: this.retiredGenerations,
    });
    this.projection = outcome.projection;
    if (outcome.updatedCapabilities) {
      this.capabilities = outcome.updatedCapabilities;
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

  async refreshCapabilities(): Promise<void> {
    if (this.disposed || !this.projection) return;
    const epoch = this.requestEpoch;
    const bindingKey = `${this.projection.binding.runtimeId}:${this.projection.binding.generation}`;
    try {
      const capRes = await this.options.transport.getCapabilities(
        this.options.sessionId,
        this.abortController?.signal,
      );
      if (this.disposed || epoch !== this.requestEpoch || !this.projection) return;
      const currentKey = `${this.projection.binding.runtimeId}:${this.projection.binding.generation}`;
      if (currentKey !== bindingKey) return;
      this.capabilities = capRes.descriptors;
      this.emit();
    } catch {
      // Keep last known descriptors; surface error only during full hydration
    }
  }

  dispose(): void {
    this.disposed = true;
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
    if (outcome.updatedCapabilities) {
      this.capabilities = outcome.updatedCapabilities;
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
