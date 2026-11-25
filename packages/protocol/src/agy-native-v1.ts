import { z } from 'zod';

// ── Contract Version & Migration Constants ─────────────────────────────

export const AGY_NATIVE_CONTRACT_VERSION = 1 as const;
export const AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0' as const;
export const AGY_NATIVE_MIGRATION_COMPONENT = 'agy-native-runtime' as const;
export const AGY_NATIVE_MIGRATION_VERSION = 1 as const;

// ── Branded Opaque Scopes (Single Source of Truth) ─────────────────────

const opaqueIdString = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'Invalid opaque identifier');

export const RuntimeIdSchema = opaqueIdString.brand<'Runtime'>();
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

export const ActivityIdSchema = opaqueIdString.brand<'Activity'>();
export type ActivityId = z.infer<typeof ActivityIdSchema>;

export const WorkIdSchema = opaqueIdString.brand<'Work'>();
export type WorkId = z.infer<typeof WorkIdSchema>;

export const NativeAgentIdSchema = opaqueIdString.brand<'NativeAgent'>();
export type NativeAgentId = z.infer<typeof NativeAgentIdSchema>;

export const WorkflowIdSchema = opaqueIdString.brand<'Workflow'>();
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

export const BindingGenerationSchema = opaqueIdString.brand<'BindingGeneration'>();
export type BindingGeneration = z.infer<typeof BindingGenerationSchema>;

export const RpcIdSchema = z.union([z.string().min(1).max(256), z.number().int()]);
export type RpcId = z.infer<typeof RpcIdSchema>;

export function asRuntimeId(value: string): RuntimeId {
  return RuntimeIdSchema.parse(value);
}

export function asActivityId(value: string): ActivityId {
  return ActivityIdSchema.parse(value);
}

export function asWorkId(value: string): WorkId {
  return WorkIdSchema.parse(value);
}

export function asNativeAgentId(value: string): NativeAgentId {
  return NativeAgentIdSchema.parse(value);
}

export function asWorkflowId(value: string): WorkflowId {
  return WorkflowIdSchema.parse(value);
}

export function asBindingGeneration(value: string): BindingGeneration {
  return BindingGenerationSchema.parse(value);
}

export const RuntimeBindingSchema = z
  .object({
    runtimeId: RuntimeIdSchema,
    sessionId: z.string().min(1).max(128),
    instanceId: z.string().min(1).max(128),
    generation: BindingGenerationSchema,
  })
  .strict();
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

// ── Evidence & Observed<T> ─────────────────────────────────────────────

export const EvidenceSourceKindSchema = z.enum([
  'live_protocol',
  'native_snapshot',
  'host_observation',
  'replay',
]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKindSchema>;

export const EvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('live_protocol'),
      connectionId: z.string().min(1).max(128),
      ingressOrdinal: z.number().int().nonnegative(),
      wireVariant: z.string().min(1).max(64),
      observedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('native_snapshot'),
      sourceId: z.string().min(1).max(128),
      schemaVersion: z.string().min(1).max(64),
      observedAt: z.number().int().nonnegative(),
      staleAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('host_observation'),
      observedAt: z.number().int().nonnegative(),
      reasonCode: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('replay'),
      captureId: z.string().min(1).max(128),
      ordinal: z.number().int().nonnegative(),
      observedAt: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const PublicEvidenceFreshnessSchema = z.enum(['live', 'snapshot', 'stale', 'replay', 'host']);
export type PublicEvidenceFreshness = z.infer<typeof PublicEvidenceFreshnessSchema>;

/**
 * External DTO allowlist for Evidence. Never exposes connectionId, sourceId, captureId,
 * NativeAlias values, raw payloads, or unsanitized filesystem paths.
 */
export const PublicEvidenceDtoSchema = z
  .object({
    sourceKind: EvidenceSourceKindSchema,
    freshness: PublicEvidenceFreshnessSchema,
    observedAt: z.number().int().nonnegative(),
    reasonCode: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PublicEvidenceDto = z.infer<typeof PublicEvidenceDtoSchema>;

export function toPublicEvidenceDto(evidence: Evidence, nowMs = Date.now()): PublicEvidenceDto {
  switch (evidence.kind) {
    case 'live_protocol':
      return {
        sourceKind: 'live_protocol',
        freshness: 'live',
        observedAt: evidence.observedAt,
      };
    case 'native_snapshot':
      return {
        sourceKind: 'native_snapshot',
        freshness: nowMs >= evidence.staleAt ? 'stale' : 'snapshot',
        observedAt: evidence.observedAt,
      };
    case 'host_observation':
      return {
        sourceKind: 'host_observation',
        freshness: 'host',
        observedAt: evidence.observedAt,
        reasonCode: evidence.reasonCode,
      };
    case 'replay':
      return {
        sourceKind: 'replay',
        freshness: 'replay',
        observedAt: evidence.observedAt,
      };
  }
}

export function observedSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('known'),
        value: valueSchema,
        evidence: EvidenceSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('stale'),
        last: valueSchema.optional(),
        evidence: EvidenceSchema.optional(),
        reasonCode: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({
        kind: z.literal('unknown'),
        reasonCode: z.string().min(1).max(128),
      })
      .strict(),
  ]);
}

export type Observed<T> =
  | { kind: 'known'; value: T; evidence: Evidence }
  | { kind: 'stale'; last?: T; evidence?: Evidence; reasonCode: string }
  | { kind: 'unknown'; reasonCode: string };

export function publicObservedSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('known'),
        value: valueSchema,
        evidence: PublicEvidenceDtoSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('stale'),
        last: valueSchema.optional(),
        evidence: PublicEvidenceDtoSchema.optional(),
        reasonCode: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({
        kind: z.literal('unknown'),
        reasonCode: z.string().min(1).max(128),
      })
      .strict(),
  ]);
}

export type PublicObserved<T> =
  | { kind: 'known'; value: T; evidence: PublicEvidenceDto }
  | { kind: 'stale'; last?: T; evidence?: PublicEvidenceDto; reasonCode: string }
  | { kind: 'unknown'; reasonCode: string };

export function sanitizeObservedForPublic<T>(
  observed: Observed<T>,
  nowMs = Date.now(),
): PublicObserved<T> {
  if (observed.kind === 'known') {
    return {
      kind: 'known',
      value: observed.value,
      evidence: toPublicEvidenceDto(observed.evidence, nowMs),
    };
  }
  if (observed.kind === 'stale') {
    return {
      kind: 'stale',
      ...(observed.last !== undefined ? { last: observed.last } : {}),
      ...(observed.evidence ? { evidence: toPublicEvidenceDto(observed.evidence, nowMs) } : {}),
      reasonCode: observed.reasonCode,
    };
  }
  return {
    kind: 'unknown',
    reasonCode: observed.reasonCode,
  };
}

// ── State Enums ────────────────────────────────────────────────────────

export const AgentForegroundSchema = z.enum(['running', 'requires_action', 'idle', 'unknown']);
export type AgentForeground = z.infer<typeof AgentForegroundSchema>;

export const WorkStateSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'requires_action',
  'finished',
  'failed',
  'cancelled',
  'unknown',
]);
export type WorkState = z.infer<typeof WorkStateSchema>;

export const WorkOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled']);
export type WorkOutcome = z.infer<typeof WorkOutcomeSchema>;

export const BlockingSchema = z.enum(['confirmed_blocking', 'detached', 'unknown']);
export type Blocking = z.infer<typeof BlockingSchema>;

export const ActivityStatusSchema = z.enum([
  'starting',
  'running',
  'waiting_background',
  'requires_action',
  'quiescent',
  'cancelling',
  'reconciling',
  'finished',
  'failed',
  'cancelled',
  'unknown',
]);
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

export const ActivityOriginSchema = z.enum([
  'user_turn',
  'native_continuation',
  'native_task',
  'recovery',
]);
export type ActivityOrigin = z.infer<typeof ActivityOriginSchema>;

export const NativeWorkKindSchema = z.enum([
  'finite_command',
  'daemon',
  'subagent',
  'schedule',
  'workflow_step',
  'unknown',
]);
export type NativeWorkKind = z.infer<typeof NativeWorkKindSchema>;

export const AgentLineageSchema = z.enum(['confirmed', 'unresolved', 'conflicting']);
export type AgentLineage = z.infer<typeof AgentLineageSchema>;

export const NativeRelationshipConfidenceSchema = z.enum([
  'protocol_confirmed',
  'snapshot_confirmed',
]);
export type NativeRelationshipConfidence = z.infer<typeof NativeRelationshipConfidenceSchema>;

export const NativeAliasNamespaceSchema = z.enum([
  'session',
  'tool_call',
  'task',
  'native_record',
  'workflow',
]);
export type NativeAliasNamespace = z.infer<typeof NativeAliasNamespaceSchema>;

/** Server-only alias record. Public APIs must only expose opaque HM IDs. */
export const NativeAliasSchema = z
  .object({
    namespace: NativeAliasNamespaceSchema,
    originSessionId: z.string().min(1).max(256).optional(),
    nativeValue: z.string().min(1).max(512),
    incarnation: z.string().min(1).max(128).optional(),
    evidence: EvidenceSchema,
  })
  .strict();
export type NativeAlias = z.infer<typeof NativeAliasSchema>;

// ── Core Domain Entities (Internal & Public DTO Allowlists) ────────────

export const ActivitySchema = z
  .object({
    id: ActivityIdSchema,
    turnId: z.string().min(1).max(128).nullable(),
    origin: ActivityOriginSchema,
    priorActivityId: ActivityIdSchema.optional(),
    workId: WorkIdSchema.optional(),
    agentId: NativeAgentIdSchema.optional(),
    state: ActivityStatusSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Activity = z.infer<typeof ActivitySchema>;

export const NativeWorkSchema = z
  .object({
    id: WorkIdSchema,
    kind: NativeWorkKindSchema,
    originActivityId: ActivityIdSchema.optional(),
    ownerAgentId: NativeAgentIdSchema.optional(),
    workflowId: WorkflowIdSchema.optional(),
    blocking: BlockingSchema,
    state: observedSchema(WorkStateSchema),
    outcome: observedSchema(WorkOutcomeSchema).optional(),
    observedLabel: z.string().max(240).optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NativeWork = z.infer<typeof NativeWorkSchema>;

export const NativeWorkDtoSchema = z
  .object({
    id: WorkIdSchema,
    kind: NativeWorkKindSchema,
    originActivityId: ActivityIdSchema.optional(),
    ownerAgentId: NativeAgentIdSchema.optional(),
    workflowId: WorkflowIdSchema.optional(),
    blocking: BlockingSchema,
    state: publicObservedSchema(WorkStateSchema),
    outcome: publicObservedSchema(WorkOutcomeSchema).optional(),
    observedLabel: z.string().max(240).optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NativeWorkDto = z.infer<typeof NativeWorkDtoSchema>;

export const AgentIdentitySchema = z
  .object({
    id: NativeAgentIdSchema,
    role: observedSchema(z.string().min(1).max(160)).optional(),
    label: observedSchema(z.string().min(1).max(160)).optional(),
    foreground: observedSchema(AgentForegroundSchema),
    status: observedSchema(WorkStateSchema).optional(),
    launchWorkIds: z.array(WorkIdSchema),
    lineage: AgentLineageSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const AgentIdentityDtoSchema = z
  .object({
    id: NativeAgentIdSchema,
    role: publicObservedSchema(z.string().min(1).max(160)).optional(),
    label: publicObservedSchema(z.string().min(1).max(160)).optional(),
    foreground: publicObservedSchema(AgentForegroundSchema),
    status: publicObservedSchema(WorkStateSchema).optional(),
    launchWorkIds: z.array(WorkIdSchema),
    lineage: AgentLineageSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type AgentIdentityDto = z.infer<typeof AgentIdentityDtoSchema>;

export const NativeRelationshipSchema = z
  .object({
    parentAgentId: NativeAgentIdSchema,
    childAgentId: NativeAgentIdSchema,
    confidence: NativeRelationshipConfidenceSchema,
    launchWorkId: WorkIdSchema.optional(),
    evidence: EvidenceSchema,
  })
  .strict();
export type NativeRelationship = z.infer<typeof NativeRelationshipSchema>;

export const NativeRelationshipDtoSchema = z
  .object({
    parentAgentId: NativeAgentIdSchema,
    childAgentId: NativeAgentIdSchema,
    confidence: NativeRelationshipConfidenceSchema,
    launchWorkId: WorkIdSchema.optional(),
    evidence: PublicEvidenceDtoSchema,
  })
  .strict();
export type NativeRelationshipDto = z.infer<typeof NativeRelationshipDtoSchema>;

// ── Workflows ──────────────────────────────────────────────────────────

export const WorkflowKindSchema = z.enum([
  'swarm',
  'boost',
  'teamwork',
  'dynamic',
  'goal',
  'schedule',
]);
export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;

export const NativeStageSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(200),
    state: observedSchema(WorkStateSchema),
    after: z.array(z.string().min(1).max(128)).optional(),
    agentIds: z.array(NativeAgentIdSchema).optional(),
  })
  .strict();
export type NativeStage = z.infer<typeof NativeStageSchema>;

export const NativeStageDtoSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(200),
    state: publicObservedSchema(WorkStateSchema),
    after: z.array(z.string().min(1).max(128)).optional(),
    agentIds: z.array(NativeAgentIdSchema).optional(),
  })
  .strict();
export type NativeStageDto = z.infer<typeof NativeStageDtoSchema>;

export const SwarmBoardAvailabilitySchema = z.enum(['available', 'upstream_limited']);

export const WorkflowDetailSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('swarm'),
      coordinatorId: NativeAgentIdSchema.optional(),
      workerIds: z.array(NativeAgentIdSchema),
      board: observedSchema(SwarmBoardAvailabilitySchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('boost'),
      phases: z.array(NativeStageSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('teamwork'),
      scopingActivityId: ActivityIdSchema.optional(),
      promptArtifactId: z.string().min(1).max(128).optional(),
      projectLabel: z.string().min(1).max(160).optional(),
      milestones: z.array(NativeStageSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dynamic'),
      scriptArtifactId: z.string().min(1).max(128).optional(),
      steps: z.array(NativeStageSchema).optional(),
      resultArtifactIds: z.array(z.string().min(1).max(128)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goal'),
      objective: z.string().max(1000).optional(),
      verificationArtifactIds: z.array(z.string().min(1).max(128)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('schedule'),
      scheduleLabel: z.string().max(240).optional(),
      nextAt: observedSchema(z.number().int().nonnegative()).optional(),
      occurrenceWorkIds: z.array(WorkIdSchema),
    })
    .strict(),
]);
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;

export const WorkflowDetailDtoSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('swarm'),
      coordinatorId: NativeAgentIdSchema.optional(),
      workerIds: z.array(NativeAgentIdSchema),
      board: publicObservedSchema(SwarmBoardAvailabilitySchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('boost'),
      phases: z.array(NativeStageDtoSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('teamwork'),
      scopingActivityId: ActivityIdSchema.optional(),
      promptArtifactId: z.string().min(1).max(128).optional(),
      projectLabel: z.string().min(1).max(160).optional(),
      milestones: z.array(NativeStageDtoSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dynamic'),
      scriptArtifactId: z.string().min(1).max(128).optional(),
      steps: z.array(NativeStageDtoSchema).optional(),
      resultArtifactIds: z.array(z.string().min(1).max(128)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goal'),
      objective: z.string().max(1000).optional(),
      verificationArtifactIds: z.array(z.string().min(1).max(128)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('schedule'),
      scheduleLabel: z.string().max(240).optional(),
      nextAt: publicObservedSchema(z.number().int().nonnegative()).optional(),
      occurrenceWorkIds: z.array(WorkIdSchema),
    })
    .strict(),
]);
export type WorkflowDetailDto = z.infer<typeof WorkflowDetailDtoSchema>;

export const NativeWorkflowSchema = z
  .object({
    id: WorkflowIdSchema,
    originActivityId: ActivityIdSchema,
    state: observedSchema(WorkStateSchema),
    detail: WorkflowDetailSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NativeWorkflow = z.infer<typeof NativeWorkflowSchema>;

export const NativeWorkflowDtoSchema = z
  .object({
    id: WorkflowIdSchema,
    originActivityId: ActivityIdSchema,
    state: publicObservedSchema(WorkStateSchema),
    detail: WorkflowDetailDtoSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NativeWorkflowDto = z.infer<typeof NativeWorkflowDtoSchema>;

// ── Capability Discovery & Command Catalog ─────────────────────────────

export const GateStateSchema = z.enum([
  'available',
  'unknown',
  'unsupported',
  'upstream_limited',
  'not_tested',
]);
export type GateState = z.infer<typeof GateStateSchema>;

export const CommandLaneSchema = z.enum(['query', 'config', 'live_workflow', 'manager']);
export type CommandLane = z.infer<typeof CommandLaneSchema>;

export const CapabilitySurfaceSchema = z.enum(['desktop', 'cli', 'ide', 'acp']);
export type CapabilitySurface = z.infer<typeof CapabilitySurfaceSchema>;

export const CapabilityActionDescriptorSchema = z
  .object({
    key: z.string().min(1).max(80),
    lane: CommandLaneSchema,
    gate: GateStateSchema,
    reasonCode: z.string().min(1).max(128).optional(),
  })
  .strict();
export type CapabilityActionDescriptor = z.infer<typeof CapabilityActionDescriptorSchema>;

export const CapabilityVerifiedLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.null(),
]);
export type CapabilityVerifiedLevel = z.infer<typeof CapabilityVerifiedLevelSchema>;

export const CapabilityDescriptorSchema = z
  .object({
    id: z.string().min(1).max(64),
    snapshotRevision: z.number().int().nonnegative(),
    surfaces: z.array(CapabilitySurfaceSchema),
    tierHint: z.string().max(80).optional(),
    versionNote: z.string().max(240).optional(),
    advertised: z.boolean().nullable(),
    launch: GateStateSchema,
    observe: GateStateSchema,
    control: GateStateSchema,
    localRead: GateStateSchema,
    actions: z.array(CapabilityActionDescriptorSchema),
    evidenceRefs: z.array(z.string().min(1).max(80)),
    verifiedLevel: CapabilityVerifiedLevelSchema,
  })
  .strict();
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

// ── Approval & Native Request Routing ──────────────────────────────────

export const NativeRequestKindSchema = z.enum(['permission', 'question', 'elicitation']);
export type NativeRequestKind = z.infer<typeof NativeRequestKindSchema>;

export const NativeRequestReceiptStateSchema = z.enum([
  'pending',
  'claimed',
  'response_written',
  'cancelled',
  'expired',
  'connection_lost',
  'delivery_unknown',
]);
export type NativeRequestReceiptState = z.infer<typeof NativeRequestReceiptStateSchema>;

/** Server-side pending native request record (contains private connection/RPC/native session IDs). */
export const PendingNativeRequestSchema = z
  .object({
    approvalId: z.string().min(1).max(128),
    runtimeId: RuntimeIdSchema,
    generation: BindingGenerationSchema,
    connectionId: z.string().min(1).max(128),
    wireRequestId: RpcIdSchema,
    occurrence: z.number().int().nonnegative(),
    actualNativeSessionId: z.string().min(1).max(256),
    agentId: NativeAgentIdSchema.optional(),
    activityId: ActivityIdSchema.optional(),
    kind: NativeRequestKindSchema,
    allowedOptionIds: z.array(z.string().min(1).max(128)),
    deadline: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PendingNativeRequest = z.infer<typeof PendingNativeRequestSchema>;

/** Minimal public authorization DTO exposed to first-party UI and allowlisted remote readers. */
export const NativeRequestSummaryDtoSchema = z
  .object({
    approvalId: z.string().min(1).max(128),
    runtimeId: RuntimeIdSchema,
    generation: BindingGenerationSchema,
    agentId: NativeAgentIdSchema.optional(),
    activityId: ActivityIdSchema.optional(),
    targetLineage: AgentLineageSchema.default('unresolved'),
    kind: NativeRequestKindSchema,
    allowedOptionIds: z.array(z.string().min(1).max(128)),
    receiptState: NativeRequestReceiptStateSchema,
    deadline: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type NativeRequestSummaryDto = z.infer<typeof NativeRequestSummaryDtoSchema>;

// ── Native Canonical Event Feed (schemaVersion: 1) ─────────────────────

export const NativeRuntimeStatusSchema = z.enum(['attached', 'reconciling', 'disconnected']);
export type NativeRuntimeStatus = z.infer<typeof NativeRuntimeStatusSchema>;

export const NativeCanonicalEventTypeSchema = z.enum([
  'native.runtime.changed',
  'native.activity.changed',
  'native.work.changed',
  'native.agent.changed',
  'native.relation.changed',
  'native.workflow.changed',
  'native.request.changed',
  'native.capabilities.changed',
  'native.recovery.changed',
]);
export type NativeCanonicalEventType = z.infer<typeof NativeCanonicalEventTypeSchema>;

const nativeEventBase = {
  schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
  runtimeId: RuntimeIdSchema,
  sessionId: z.string().min(1).max(128),
  generation: BindingGenerationSchema,
  seq: z.number().int().positive(),
  turnId: z.string().min(1).max(128).nullable(),
  hmAnchorSeq: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
};

export const NativeCanonicalEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.runtime.changed'),
      payload: z
        .object({
          status: NativeRuntimeStatusSchema,
          retentionReasons: z.array(z.string().min(1).max(128)),
          revision: z.number().int().nonnegative(),
          reasonCode: z.string().min(1).max(128).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.activity.changed'),
      payload: z
        .object({
          activity: ActivitySchema,
          deltaSummary: z.string().max(2048).optional(),
          timelinePageHint: z.string().max(128).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.work.changed'),
      payload: z
        .object({
          work: NativeWorkDtoSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.agent.changed'),
      payload: z
        .object({
          agent: AgentIdentityDtoSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.relation.changed'),
      payload: z
        .object({
          op: z.enum(['upsert', 'revoke']),
          relation: NativeRelationshipDtoSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.workflow.changed'),
      payload: z
        .object({
          workflow: NativeWorkflowDtoSchema,
          resourceIds: z.array(z.string().min(1).max(128)).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.request.changed'),
      payload: z
        .object({
          approvalId: z.string().min(1).max(128),
          targetAgentId: NativeAgentIdSchema.optional(),
          activityId: ActivityIdSchema.optional(),
          receiptId: z.string().min(1).max(128).optional(),
          receiptState: NativeRequestReceiptStateSchema,
          kind: NativeRequestKindSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.capabilities.changed'),
      payload: z
        .object({
          capabilitiesRevision: z.number().int().nonnegative(),
          changedDescriptorIds: z.array(z.string().min(1).max(64)),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...nativeEventBase,
      type: z.literal('native.recovery.changed'),
      payload: z
        .object({
          status: NativeRuntimeStatusSchema,
          invalidatedGenerations: z.array(BindingGenerationSchema),
          uncertainEntityIds: z.array(z.string().min(1).max(128)),
          reasonCode: z.string().min(1).max(128),
        })
        .strict(),
    })
    .strict(),
]);
export type NativeCanonicalEvent = z.infer<typeof NativeCanonicalEventSchema>;

// ── Public Projection DTO (Allowlist) ──────────────────────────────────

export const NativeRuntimeProjectionSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    contractRevision: z.literal(AGY_NATIVE_CONTRACT_REVISION).default(AGY_NATIVE_CONTRACT_REVISION),
    enabled: z.boolean(),
    binding: RuntimeBindingSchema,
    asOfSeq: z.number().int().nonnegative(),
    status: NativeRuntimeStatusSchema,
    capabilitiesRevision: z.number().int().nonnegative(),
    retentionReasons: z.array(z.string().min(1).max(128)).default([]),
    activities: z.array(ActivitySchema),
    work: z.array(NativeWorkDtoSchema),
    agents: z.array(AgentIdentityDtoSchema),
    relations: z.array(NativeRelationshipDtoSchema),
    workflows: z.array(NativeWorkflowDtoSchema),
    requestIds: z.array(z.string().min(1).max(128)),
    requests: z.array(NativeRequestSummaryDtoSchema).optional(),
  })
  .strict();
export type NativeRuntimeProjection = z.infer<typeof NativeRuntimeProjectionSchema>;

// ── Sanitization Helpers (Internal -> Public DTO) ──────────────────────

export function sanitizeNativeWorkForPublic(
  work: NativeWork,
  nowMs = Date.now(),
): NativeWorkDto {
  return NativeWorkDtoSchema.parse({
    id: work.id,
    kind: work.kind,
    ...(work.originActivityId ? { originActivityId: work.originActivityId } : {}),
    ...(work.ownerAgentId ? { ownerAgentId: work.ownerAgentId } : {}),
    ...(work.workflowId ? { workflowId: work.workflowId } : {}),
    blocking: work.blocking,
    state: sanitizeObservedForPublic(work.state, nowMs),
    ...(work.outcome ? { outcome: sanitizeObservedForPublic(work.outcome, nowMs) } : {}),
    ...(work.observedLabel !== undefined ? { observedLabel: work.observedLabel } : {}),
    revision: work.revision,
  });
}

export function sanitizeAgentIdentityForPublic(
  agent: AgentIdentity,
  nowMs = Date.now(),
): AgentIdentityDto {
  return AgentIdentityDtoSchema.parse({
    id: agent.id,
    ...(agent.role ? { role: sanitizeObservedForPublic(agent.role, nowMs) } : {}),
    ...(agent.label ? { label: sanitizeObservedForPublic(agent.label, nowMs) } : {}),
    foreground: sanitizeObservedForPublic(agent.foreground, nowMs),
    ...(agent.status ? { status: sanitizeObservedForPublic(agent.status, nowMs) } : {}),
    launchWorkIds: [...agent.launchWorkIds],
    lineage: agent.lineage,
    revision: agent.revision,
  });
}

export function sanitizeNativeRelationshipForPublic(
  relation: NativeRelationship,
  nowMs = Date.now(),
): NativeRelationshipDto {
  return NativeRelationshipDtoSchema.parse({
    parentAgentId: relation.parentAgentId,
    childAgentId: relation.childAgentId,
    confidence: relation.confidence,
    ...(relation.launchWorkId ? { launchWorkId: relation.launchWorkId } : {}),
    evidence: toPublicEvidenceDto(relation.evidence, nowMs),
  });
}

function sanitizeStageForPublic(stage: NativeStage, nowMs = Date.now()): NativeStageDto {
  return {
    id: stage.id,
    label: stage.label,
    state: sanitizeObservedForPublic(stage.state, nowMs),
    ...(stage.after ? { after: [...stage.after] } : {}),
    ...(stage.agentIds ? { agentIds: [...stage.agentIds] } : {}),
  };
}

export function sanitizeNativeWorkflowForPublic(
  workflow: NativeWorkflow,
  nowMs = Date.now(),
): NativeWorkflowDto {
  let detail: WorkflowDetailDto;
  switch (workflow.detail.kind) {
    case 'swarm':
      detail = {
        kind: 'swarm',
        ...(workflow.detail.coordinatorId ? { coordinatorId: workflow.detail.coordinatorId } : {}),
        workerIds: [...workflow.detail.workerIds],
        board: sanitizeObservedForPublic(workflow.detail.board, nowMs),
      };
      break;
    case 'boost':
      detail = {
        kind: 'boost',
        ...(workflow.detail.phases
          ? { phases: workflow.detail.phases.map((s) => sanitizeStageForPublic(s, nowMs)) }
          : {}),
      };
      break;
    case 'teamwork':
      detail = {
        kind: 'teamwork',
        ...(workflow.detail.scopingActivityId
          ? { scopingActivityId: workflow.detail.scopingActivityId }
          : {}),
        ...(workflow.detail.promptArtifactId
          ? { promptArtifactId: workflow.detail.promptArtifactId }
          : {}),
        ...(workflow.detail.projectLabel ? { projectLabel: workflow.detail.projectLabel } : {}),
        ...(workflow.detail.milestones
          ? { milestones: workflow.detail.milestones.map((s) => sanitizeStageForPublic(s, nowMs)) }
          : {}),
      };
      break;
    case 'dynamic':
      detail = {
        kind: 'dynamic',
        ...(workflow.detail.scriptArtifactId
          ? { scriptArtifactId: workflow.detail.scriptArtifactId }
          : {}),
        ...(workflow.detail.steps
          ? { steps: workflow.detail.steps.map((s) => sanitizeStageForPublic(s, nowMs)) }
          : {}),
        ...(workflow.detail.resultArtifactIds
          ? { resultArtifactIds: [...workflow.detail.resultArtifactIds] }
          : {}),
      };
      break;
    case 'goal':
      detail = {
        kind: 'goal',
        ...(workflow.detail.objective !== undefined ? { objective: workflow.detail.objective } : {}),
        ...(workflow.detail.verificationArtifactIds
          ? { verificationArtifactIds: [...workflow.detail.verificationArtifactIds] }
          : {}),
      };
      break;
    case 'schedule':
      detail = {
        kind: 'schedule',
        ...(workflow.detail.scheduleLabel !== undefined
          ? { scheduleLabel: workflow.detail.scheduleLabel }
          : {}),
        ...(workflow.detail.nextAt
          ? { nextAt: sanitizeObservedForPublic(workflow.detail.nextAt, nowMs) }
          : {}),
        occurrenceWorkIds: [...workflow.detail.occurrenceWorkIds],
      };
      break;
  }

  return NativeWorkflowDtoSchema.parse({
    id: workflow.id,
    originActivityId: workflow.originActivityId,
    state: sanitizeObservedForPublic(workflow.state, nowMs),
    detail,
    revision: workflow.revision,
  });
}

// ── REST API Error & Endpoint DTO Schemas (/api/v1/sessions/:id/native) ──

export const NativeApiErrorCodeSchema = z.enum([
  'NATIVE_RUNTIME_DISABLED',
  'NATIVE_SCHEMA_NEWER_THAN_READER',
  'STALE_BINDING',
  'BUSY',
  'UNSUPPORTED_ACTION',
  'FORBIDDEN',
  'RESYNC_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'ALREADY_RESOLVED',
  'CONNECTION_LOST',
  'CONSUMER_PROVENANCE_BLOCKED',
]);
export type NativeApiErrorCode = z.infer<typeof NativeApiErrorCodeSchema>;

export const NativeApiErrorSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    code: NativeApiErrorCodeSchema,
    message: z.string().min(1).max(400),
    retryable: z.boolean().optional(),
    details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();
export type NativeApiError = z.infer<typeof NativeApiErrorSchema>;

export const NativeCapabilitiesResponseSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    contractRevision: z.literal(AGY_NATIVE_CONTRACT_REVISION).default(AGY_NATIVE_CONTRACT_REVISION),
    enabled: z.boolean(),
    binding: RuntimeBindingSchema,
    capabilitiesRevision: z.number().int().nonnegative(),
    descriptors: z.array(CapabilityDescriptorSchema),
  })
  .strict();
export type NativeCapabilitiesResponse = z.infer<typeof NativeCapabilitiesResponseSchema>;

export const NativeEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(256).optional(),
  generation: BindingGenerationSchema.optional(),
});
export type NativeEventsQuery = z.infer<typeof NativeEventsQuerySchema>;

export const NativeEventsResponseSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    runtimeId: RuntimeIdSchema,
    generation: BindingGenerationSchema,
    events: z.array(NativeCanonicalEventSchema),
    nextSeq: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).max(256),
    hasMore: z.boolean(),
  })
  .strict();
export type NativeEventsResponse = z.infer<typeof NativeEventsResponseSchema>;

export const NativeTimelineQuerySchema = z.object({
  pageToken: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type NativeTimelineQuery = z.infer<typeof NativeTimelineQuerySchema>;

export const NativeTimelineEntryDtoSchema = z
  .object({
    entryId: z.string().min(1).max(128),
    seq: z.number().int().nonnegative(),
    kind: z.enum(['text', 'thinking', 'tool', 'diff', 'request', 'status', 'artifact_ref']),
    summary: z.string().max(4096),
    truncated: z.boolean().default(false),
    createdAt: z.number().int().nonnegative(),
    evidence: PublicEvidenceDtoSchema,
  })
  .strict();
export type NativeTimelineEntryDto = z.infer<typeof NativeTimelineEntryDtoSchema>;

export const NativeTimelineResponseSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    runtimeId: RuntimeIdSchema,
    generation: BindingGenerationSchema,
    scopeType: z.enum(['activity', 'agent']),
    scopeId: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    entries: z.array(NativeTimelineEntryDtoSchema),
    nextPageToken: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type NativeTimelineResponse = z.infer<typeof NativeTimelineResponseSchema>;

export const NativeWorkflowResourceKindSchema = z.enum(['board', 'phases', 'logs', 'artifacts']);
export type NativeWorkflowResourceKind = z.infer<typeof NativeWorkflowResourceKindSchema>;

export const NativeWorkflowResourceResponseSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    runtimeId: RuntimeIdSchema,
    generation: BindingGenerationSchema,
    workflowId: WorkflowIdSchema,
    resource: NativeWorkflowResourceKindSchema,
    revision: z.number().int().nonnegative(),
    available: z.boolean(),
    reasonCode: z.string().min(1).max(128).optional(),
    items: z.array(z.record(z.unknown())),
    nextPageToken: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type NativeWorkflowResourceResponse = z.infer<typeof NativeWorkflowResourceResponseSchema>;

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'Invalid idempotency key');

export const NativeCommandRequestSchema = z
  .object({
    bindingGeneration: BindingGenerationSchema,
    catalogRevision: z.number().int().nonnegative(),
    capabilityId: z.string().min(1).max(64),
    actionKey: z.string().min(1).max(80),
    args: z.record(z.unknown()).default({}),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type NativeCommandRequest = z.infer<typeof NativeCommandRequestSchema>;

export const NativeCommandResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      kind: z.literal('inspect'),
      receiptId: z.string().min(1).max(128),
      output: z.string().max(65_536),
      data: z.record(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      kind: z.literal('accepted'),
      receiptId: z.string().min(1).max(128),
      activityId: ActivityIdSchema,
      turnId: z.string().min(1).max(128).optional(),
    })
    .strict(),
]);
export type NativeCommandResponse = z.infer<typeof NativeCommandResponseSchema>;

export const NativeControlTargetTypeSchema = z.enum([
  'activity',
  'work',
  'agent',
  'workflow',
  'runtime',
]);
export type NativeControlTargetType = z.infer<typeof NativeControlTargetTypeSchema>;

export const NativeControlRequestSchema = z
  .object({
    generation: BindingGenerationSchema,
    target: z
      .object({
        type: NativeControlTargetTypeSchema,
        id: opaqueIdString,
      })
      .strict(),
    action: z.string().trim().min(1).max(80),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type NativeControlRequest = z.infer<typeof NativeControlRequestSchema>;

export const NativeControlResponseSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    receiptId: z.string().min(1).max(128),
    accepted: z.boolean(),
    state: z.enum(['requested', 'applied', 'noop']),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NativeControlResponse = z.infer<typeof NativeControlResponseSchema>;

export const NativeFormFieldValueSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(256)).max(64),
]);

export const ResolveNativeRequestInputSchema = z
  .object({
    generation: BindingGenerationSchema,
    outcome: z.enum(['selected', 'cancelled', 'form_submitted']),
    optionId: z.string().trim().min(1).max(128).optional(),
    formPayload: z.record(z.string().min(1).max(128), NativeFormFieldValueSchema).optional(),
    comment: z.string().max(500).optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.outcome === 'selected' && !val.optionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'optionId is required when outcome is "selected"',
        path: ['optionId'],
      });
    }
    if (val.outcome === 'selected' && val.formPayload !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'formPayload must not be supplied when outcome is "selected"',
        path: ['formPayload'],
      });
    }
    if (val.outcome === 'form_submitted' && (!val.formPayload || Object.keys(val.formPayload).length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'formPayload is required when outcome is "form_submitted"',
        path: ['formPayload'],
      });
    }
    if (val.outcome === 'cancelled' && (val.optionId !== undefined || val.formPayload !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'optionId and formPayload must not be supplied when outcome is "cancelled"',
        path: ['outcome'],
      });
    }
  });
export type ResolveNativeRequestInput = z.infer<typeof ResolveNativeRequestInputSchema>;

export const ResolveNativeRequestResponseSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    approvalId: z.string().min(1).max(128),
    receiptId: z.string().min(1).max(128),
    receiptState: NativeRequestReceiptStateSchema,
    conflict: z.boolean(),
  })
  .strict();
export type ResolveNativeRequestResponse = z.infer<typeof ResolveNativeRequestResponseSchema>;

// ── Versioned Native WebSocket Namespace Frames (/api/v1/sessions/:id/native/ws) ──

export const NativeWsClientFrameSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('subscribe_native'),
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      afterSeq: z.number().int().nonnegative().default(0),
      generation: BindingGenerationSchema.optional(),
      cursor: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('unsubscribe_native'),
    })
    .strict(),
  z
    .object({
      op: z.literal('ping'),
      ts: z.number().optional(),
    })
    .strict(),
]);
export type NativeWsClientFrame = z.infer<typeof NativeWsClientFrameSchema>;

export const NativeWsServerFrameSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('native_hello'),
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      contractRevision: z.literal(AGY_NATIVE_CONTRACT_REVISION),
      sessionId: z.string().min(1).max(128),
      runtimeId: RuntimeIdSchema.nullable(),
      generation: BindingGenerationSchema.nullable(),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal('native_event'),
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      event: NativeCanonicalEventSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('native_replay_complete'),
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      runtimeId: RuntimeIdSchema,
      generation: BindingGenerationSchema,
      lastSeq: z.number().int().nonnegative(),
      nextCursor: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      op: z.literal('native_resync_required'),
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      code: z.literal('RESYNC_REQUIRED'),
      reason: z.string().min(1).max(240),
      latestSeq: z.number().int().nonnegative(),
      currentGeneration: BindingGenerationSchema.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal('native_pong'),
      ts: z.number(),
    })
    .strict(),
  z
    .object({
      op: z.literal('native_error'),
      schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
      code: NativeApiErrorCodeSchema,
      message: z.string().min(1).max(400),
    })
    .strict(),
]);
export type NativeWsServerFrame = z.infer<typeof NativeWsServerFrameSchema>;

// ── Observatory Capture Alignment Schema (for NP-01) ───────────────────

export const NativeCaptureMetadataSchema = z
  .object({
    schemaVersion: z.literal(AGY_NATIVE_CONTRACT_VERSION),
    captureId: z.string().min(1).max(128),
    scenario: z.string().min(1).max(64),
    platform: z.string().min(1).max(64),
    cliVersion: z.string().min(1).max(64),
    protocol: z.string().min(1).max(32),
    accountCategory: z.string().min(1).max(64),
    source: z.enum(['synthetic', 'replay_with_provenance', 'live_raw', 'live_hm', 'official_comparison']),
    observedAt: z.number().int().nonnegative(),
    producer: z.string().min(1).max(64),
    seq: z.number().int().nonnegative(),
    monotonicMs: z.number().nonnegative(),
    direction: z.enum(['in', 'out', 'internal']),
    messageKind: z.string().min(1).max(64),
    connectionAlias: z.string().min(1).max(64).optional(),
    sessionAlias: z.string().min(1).max(64).optional(),
    correlationId: z.string().min(1).max(128).optional(),
    truncated: z.boolean().optional(),
    droppedCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NativeCaptureMetadata = z.infer<typeof NativeCaptureMetadataSchema>;

// ── Known Empty & Sample Fixtures (for NP-03 & Contract Tests) ─────────

export function createDefaultAgyCapabilityDescriptors(
  snapshotRevision = 0,
): CapabilityDescriptor[] {
  const baselineIds: Array<{ id: string; surfaces: CapabilitySurface[]; versionNote?: string }> = [
    { id: 'agy.acp.v1', surfaces: ['cli', 'acp'], versionNote: 'Default v1 handshake; v2 Preview disabled' },
    { id: 'agy.reactive.background', surfaces: ['cli', 'acp'] },
    { id: 'agy.subagents', surfaces: ['desktop', 'cli', 'acp'] },
    { id: 'agy.workflow.swarm', surfaces: ['desktop', 'cli', 'acp'] },
    { id: 'agy.workflow.boost', surfaces: ['desktop', 'cli', 'acp'] },
    { id: 'agy.workflow.teamwork', surfaces: ['desktop', 'cli', 'acp'] },
    { id: 'agy.workflow.dynamic', surfaces: ['desktop', 'cli', 'acp'] },
    { id: 'agy.workflow.goal', surfaces: ['desktop', 'cli', 'acp'] },
    { id: 'agy.workflow.schedule', surfaces: ['desktop', 'cli', 'acp'] },
  ];

  return baselineIds.map((entry) =>
    CapabilityDescriptorSchema.parse({
      id: entry.id,
      snapshotRevision,
      surfaces: entry.surfaces,
      ...(entry.versionNote ? { versionNote: entry.versionNote } : {}),
      advertised: null,
      launch: 'not_tested',
      observe: 'not_tested',
      control: 'not_tested',
      localRead: 'not_tested',
      actions: [],
      evidenceRefs: [],
      verifiedLevel: null,
    }),
  );
}

export function createKnownEmptyNativeProjection(params: {
  sessionId: string;
  instanceId: string;
  runtimeId?: string;
  generation?: string;
  enabled?: boolean;
  status?: NativeRuntimeStatus;
  capabilitiesRevision?: number;
}): NativeRuntimeProjection {
  return NativeRuntimeProjectionSchema.parse({
    schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
    contractRevision: AGY_NATIVE_CONTRACT_REVISION,
    enabled: params.enabled ?? false,
    binding: {
      runtimeId: asRuntimeId(params.runtimeId ?? `nrt_${params.sessionId}`),
      sessionId: params.sessionId,
      instanceId: params.instanceId,
      generation: asBindingGeneration(params.generation ?? 'gen_0'),
    },
    asOfSeq: 0,
    status: params.status ?? 'disconnected',
    capabilitiesRevision: params.capabilitiesRevision ?? 0,
    retentionReasons: [],
    activities: [],
    work: [],
    agents: [],
    relations: [],
    workflows: [],
    requestIds: [],
    requests: [],
  });
}

export function createSampleNativeProjectionFixture(params?: {
  sessionId?: string;
  instanceId?: string;
  nowMs?: number;
}): NativeRuntimeProjection {
  const sessionId = params?.sessionId ?? 'sess_fixture_np03';
  const instanceId = params?.instanceId ?? 'agy';
  const nowMs = params?.nowMs ?? 1_764_000_000_000;
  const runtimeId = asRuntimeId('nrt_fixture_01');
  const generation = asBindingGeneration('gen_fixture_1');
  const activityId = asActivityId('act_fixture_01');
  const workId = asWorkId('wrk_fixture_01');
  const rootAgentId = asNativeAgentId('agt_fixture_root');
  const childAgentId = asNativeAgentId('agt_fixture_child');

  return NativeRuntimeProjectionSchema.parse({
    schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
    contractRevision: AGY_NATIVE_CONTRACT_REVISION,
    enabled: true,
    binding: {
      runtimeId,
      sessionId,
      instanceId,
      generation,
    },
    asOfSeq: 4,
    status: 'attached',
    capabilitiesRevision: 1,
    retentionReasons: ['finite_work:wrk_fixture_01'],
    activities: [
      {
        id: activityId,
        turnId: 'turn_fixture_01',
        origin: 'user_turn',
        workId,
        agentId: rootAgentId,
        state: 'waiting_background',
        updatedAt: nowMs,
      },
    ],
    work: [
      {
        id: workId,
        kind: 'finite_command',
        originActivityId: activityId,
        ownerAgentId: rootAgentId,
        blocking: 'confirmed_blocking',
        state: {
          kind: 'known',
          value: 'running',
          evidence: {
            sourceKind: 'replay',
            freshness: 'replay',
            observedAt: nowMs,
          },
        },
        observedLabel: 'Synthetic finite background task',
        revision: 2,
      },
    ],
    agents: [
      {
        id: rootAgentId,
        role: {
          kind: 'known',
          value: 'primary',
          evidence: {
            sourceKind: 'replay',
            freshness: 'replay',
            observedAt: nowMs,
          },
        },
        foreground: {
          kind: 'known',
          value: 'idle',
          evidence: {
            sourceKind: 'replay',
            freshness: 'replay',
            observedAt: nowMs,
          },
        },
        launchWorkIds: [workId],
        lineage: 'confirmed',
        revision: 1,
      },
      {
        id: childAgentId,
        role: {
          kind: 'unknown',
          reasonCode: 'no_child_announcement_observed',
        },
        foreground: {
          kind: 'unknown',
          reasonCode: 'no_live_child_stream',
        },
        launchWorkIds: [],
        lineage: 'unresolved',
        revision: 1,
      },
    ],
    relations: [],
    workflows: [],
    requestIds: ['appr_fixture_01'],
    requests: [
      {
        approvalId: 'appr_fixture_01',
        runtimeId,
        generation,
        activityId,
        targetLineage: 'confirmed',
        kind: 'permission',
        allowedOptionIds: ['allow_once', 'reject_once'],
        receiptState: 'pending',
        updatedAt: nowMs,
      },
    ],
  });
}
