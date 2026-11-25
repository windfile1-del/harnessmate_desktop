import {
  ActivityIdSchema,
  AgentForegroundSchema,
  AgentLineageSchema,
  NativeAgentIdSchema,
  NativeRequestReceiptStateSchema,
  NativeStageDtoSchema,
  PublicEvidenceDtoSchema,
  WorkOutcomeSchema,
  WorkStateSchema,
  WorkflowIdSchema,
  publicObservedSchema,
} from '@harnessmate/protocol';
import { z } from 'zod';

export const TEAMWORK_OBSERVER_CONTRACT_REVISION = 'agy-np10-teamwork-v1.0.0' as const;
export const TEAMWORK_CAPABILITY_ID = 'AGY-W07' as const;
export const TEAMWORK_PRIMARY_SLASH_COMMAND = 'teamwork' as const;
export const TEAMWORK_LEGACY_PREVIEW_SLASH_COMMANDS = ['teamwork-preview'] as const;

const opaqueIdString = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'Invalid opaque identifier');

export const TeamworkCommandDiscoveryStateSchema = z.enum([
  'not_observed',
  'advertised',
  'not_advertised',
  'legacy_preview_unverified',
]);
export type TeamworkCommandDiscoveryState = z.infer<typeof TeamworkCommandDiscoveryStateSchema>;

export const TeamworkLifecyclePhaseSchema = z.enum([
  'idle',
  'launch_pending_evidence',
  'scoping',
  'prompt_review',
  'rejected',
  'project_active',
  'auditing',
  'finished',
  'failed',
  'cancelled',
  'reconciling',
  'stale',
  'unknown',
]);
export type TeamworkLifecyclePhase = z.infer<typeof TeamworkLifecyclePhaseSchema>;

export const TeamworkApprovalGateStateSchema = z.enum([
  'not_reached',
  'awaiting_native_approval',
  'upstream_limited_manual_app',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'connection_lost',
  'delivery_unknown',
]);
export type TeamworkApprovalGateState = z.infer<typeof TeamworkApprovalGateStateSchema>;

export const TeamworkRoleKindSchema = z.enum([
  'sentinel',
  'project_orchestrator',
  'milestone_worker',
  'auditor',
  'unknown_role',
]);
export type TeamworkRoleKind = z.infer<typeof TeamworkRoleKindSchema>;

export const TeamworkScopeRelationshipSchema = z.enum([
  'distinct_from_hm_workspace',
  'within_authorized_root',
  'unverified',
]);
export type TeamworkScopeRelationship = z.infer<typeof TeamworkScopeRelationshipSchema>;

export const TeamworkPathAccessGateSchema = z.enum([
  'authorized_read_only',
  'requires_explicit_authorization',
  'unavailable',
]);
export type TeamworkPathAccessGate = z.infer<typeof TeamworkPathAccessGateSchema>;

export const TeamworkScopingQuestionDtoSchema = z
  .object({
    questionId: opaqueIdString,
    approvalId: z.string().min(1).max(128).optional(),
    dedupKey: z.string().min(1).max(160),
    promptSummary: z.string().min(1).max(600),
    requestKind: z.enum(['question', 'elicitation', 'permission']),
    receiptState: NativeRequestReceiptStateSchema,
    receiptId: z.string().min(1).max(128).optional(),
    selectedOptionLabel: z.string().max(240).optional(),
    occurrence: z.number().int().positive(),
    duplicateDeliveriesIgnored: z.number().int().nonnegative(),
    evidence: PublicEvidenceDtoSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TeamworkScopingQuestionDto = z.infer<typeof TeamworkScopingQuestionDtoSchema>;

export const TeamworkPromptArtifactDtoSchema = z
  .object({
    artifactId: opaqueIdString,
    title: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    reviewGate: TeamworkApprovalGateStateSchema,
    canApproveViaNativeProtocol: z.boolean(),
    reviewControlEnabled: z.boolean(),
    approvalRequestId: z.string().min(1).max(128).optional(),
    approvalReceiptId: z.string().min(1).max(128).optional(),
    approvalReceiptState: NativeRequestReceiptStateSchema.optional(),
    reasonCode: z.string().min(1).max(160).optional(),
    officialFallbackHint: z.string().max(320),
    previewExcerpt: z.string().max(1200).optional(),
    evidence: PublicEvidenceDtoSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TeamworkPromptArtifactDto = z.infer<typeof TeamworkPromptArtifactDtoSchema>;

/**
 * Strictly sanitized scope separation DTO:
 * separates HarnessMate workspace scope from AGY Native Teamwork project scope.
 * Never exposes unsanitized raw host filesystem paths.
 */
export const TeamworkProjectScopeDtoSchema = z
  .object({
    hmWorkspace: z
      .object({
        workspaceId: opaqueIdString.optional(),
        label: z.string().min(1).max(160),
        isolatedFromNativeProject: z.literal(true),
      })
      .strict(),
    nativeProject: z
      .object({
        created: z.boolean(),
        projectScopeId: opaqueIdString.optional(),
        projectLabel: z.string().min(1).max(160).optional(),
        scopeRelationship: TeamworkScopeRelationshipSchema,
        pathAccessGate: TeamworkPathAccessGateSchema,
        pathOpenAuthorized: z.boolean(),
        authorizationReasonCode: z.string().min(1).max(160),
        evidence: PublicEvidenceDtoSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type TeamworkProjectScopeDto = z.infer<typeof TeamworkProjectScopeDtoSchema>;

export const TeamworkRoleAttributionDtoSchema = z
  .object({
    agentId: NativeAgentIdSchema,
    roleKind: TeamworkRoleKindSchema,
    displayLabel: z.string().min(1).max(160),
    lineage: AgentLineageSchema,
    foreground: publicObservedSchema(AgentForegroundSchema),
    milestoneIds: z.array(z.string().min(1).max(128)),
    evidence: PublicEvidenceDtoSchema,
  })
  .strict();
export type TeamworkRoleAttributionDto = z.infer<typeof TeamworkRoleAttributionDtoSchema>;

export const TeamworkAuditGateDtoSchema = z
  .object({
    auditId: opaqueIdString,
    milestoneId: z.string().min(1).max(128).optional(),
    label: z.string().min(1).max(200),
    verdict: z.enum(['pending', 'passed', 'changes_requested', 'failed', 'cancelled', 'unknown']),
    auditorAgentId: NativeAgentIdSchema.optional(),
    artifactId: opaqueIdString.optional(),
    summary: z.string().max(600).optional(),
    evidence: PublicEvidenceDtoSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TeamworkAuditGateDto = z.infer<typeof TeamworkAuditGateDtoSchema>;

export const TeamworkArtifactCategorySchema = z.enum([
  'prompt_artifact',
  'milestone_plan',
  'milestone_deliverable',
  'audit_report',
  'unknown',
]);
export type TeamworkArtifactCategory = z.infer<typeof TeamworkArtifactCategorySchema>;

export const TeamworkArtifactRefDtoSchema = z
  .object({
    artifactId: opaqueIdString,
    title: z.string().min(1).max(200),
    category: TeamworkArtifactCategorySchema,
    artifactKind: z.enum(['markdown', 'text', 'diff', 'script', 'json', 'media', 'unknown']),
    milestoneId: z.string().min(1).max(128).optional(),
    ownerAgentId: NativeAgentIdSchema.optional(),
    activityId: ActivityIdSchema.optional(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    evidence: PublicEvidenceDtoSchema,
  })
  .strict();
export type TeamworkArtifactRefDto = z.infer<typeof TeamworkArtifactRefDtoSchema>;

export const TeamworkEventTraceEntryDtoSchema = z
  .object({
    seq: z.number().int().positive(),
    eventKind: z.enum([
      'command_discovery',
      'launch_requested',
      'launch_blocked',
      'scoping_question',
      'scoping_receipt',
      'prompt_artifact',
      'approval_gate',
      'approval_forgery_blocked',
      'project_scope',
      'role_attributed',
      'milestone_updated',
      'audit_updated',
      'artifact_recorded',
      'transport_disconnected',
      'generation_fenced',
      'reconciling',
      'feature_gate_changed',
    ]),
    summary: z.string().min(1).max(600),
    entityId: z.string().min(1).max(128).optional(),
    reasonCode: z.string().min(1).max(160).optional(),
    evidence: PublicEvidenceDtoSchema,
  })
  .strict();
export type TeamworkEventTraceEntryDto = z.infer<typeof TeamworkEventTraceEntryDtoSchema>;

export const TeamworkMilestoneDetailDtoSchema = z
  .object({
    stage: NativeStageDtoSchema,
    outcome: publicObservedSchema(WorkOutcomeSchema).optional(),
    summary: z.string().max(600).optional(),
    auditIds: z.array(opaqueIdString),
    artifactIds: z.array(opaqueIdString),
  })
  .strict();
export type TeamworkMilestoneDetailDto = z.infer<typeof TeamworkMilestoneDetailDtoSchema>;

/**
 * Private/domain Teamwork Workbench Projection DTO (NP-10).
 * Strictly allowlisted and validated with Zod; safe for first-party UI rendering.
 */
export const TeamworkWorkbenchProjectionDtoSchema = z
  .object({
    contractRevision: z.literal(TEAMWORK_OBSERVER_CONTRACT_REVISION),
    capabilityId: z.literal(TEAMWORK_CAPABILITY_ID),
    workflowId: WorkflowIdSchema,
    originActivityId: ActivityIdSchema,
    scopingActivityId: ActivityIdSchema.optional(),
    revision: z.number().int().nonnegative(),
    readOnly: z.boolean(),
    readOnlyReasonCode: z.string().min(1).max(160).optional(),
    commandDiscovery: TeamworkCommandDiscoveryStateSchema,
    phase: TeamworkLifecyclePhaseSchema,
    workflowState: publicObservedSchema(WorkStateSchema),
    approvalGate: TeamworkApprovalGateStateSchema,
    scopingQuestions: z.array(TeamworkScopingQuestionDtoSchema),
    promptArtifact: TeamworkPromptArtifactDtoSchema.nullable(),
    projectScope: TeamworkProjectScopeDtoSchema,
    confirmedRoles: z.array(TeamworkRoleAttributionDtoSchema),
    unconfirmedRoleCandidates: z.array(TeamworkRoleAttributionDtoSchema),
    milestones: z.array(TeamworkMilestoneDetailDtoSchema).optional(),
    auditGates: z.array(TeamworkAuditGateDtoSchema),
    artifacts: z.array(TeamworkArtifactRefDtoSchema),
    eventTraceCount: z.number().int().nonnegative(),
    officialAppGuide: z.string().min(1).max(400),
  })
  .strict();
export type TeamworkWorkbenchProjectionDto = z.infer<typeof TeamworkWorkbenchProjectionDtoSchema>;

const RAW_HOST_PATH_PATTERNS: readonly RegExp[] = [
  /[a-zA-Z]:\\[^\s"'`]+/,
  /\\\\[a-zA-Z0-9._-]+\\[^\s"'`]+/,
  /(?:^|[\s"'`])\/(?:Users|home|var|etc|tmp|opt|mnt)\/[^\s"'`]+/,
];

/**
 * Defense-in-depth sanitizer check verifying no raw OS filesystem paths leak into
 * public Teamwork DTOs.
 */
export function containsRawHostPath(value: unknown): boolean {
  if (typeof value === 'string') {
    return RAW_HOST_PATH_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsRawHostPath(item));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsRawHostPath(entry),
    );
  }
  return false;
}
