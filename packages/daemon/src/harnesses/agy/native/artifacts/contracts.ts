import {
  ActivityIdSchema,
  AgentLineageSchema,
  NativeAgentIdSchema,
  PublicEvidenceDtoSchema,
  RuntimeBindingSchema,
  WorkStateSchema,
  WorkflowIdSchema,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { z } from 'zod';
import { isValidOpaqueArtifactId } from '../workflows/dynamic/ports.js';

export const AGY_ARTIFACT_CONTRACT_REVISION = 'agy-np14-artifacts-v1.0.0' as const;
export const AGY_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const AGY_OFFICIAL_DOC_URLS = Object.freeze({
  artifactReview: 'https://antigravity.google/docs/artifact-review/',
  cliArtifacts: 'https://antigravity.google/docs/cli/artifacts/',
  browser: 'https://antigravity.google/docs/browser/',
  browserRecordings: 'https://antigravity.google/docs/ide/browser-recordings/',
  plan: 'https://antigravity.google/docs/plan/',
  reviewChanges: 'https://antigravity.google/docs/review-changes/',
});

// ── Independent Feature Gates (ALL OFF BY DEFAULT) ─────────────────────

export interface AgyArtifactFeatureGates {
  /** Master gate for NP-14 safe native artifact workspace & reader. Default: false. */
  readonly nativeArtifactsEnabled: boolean;
  /** Independent gate for native line-comment & approval control (requires verified wire schema). Default: false. */
  readonly reviewControlEnabled: boolean;
  /** Independent gate for Browser Agent screenshot/recording metadata references. Default: false. */
  readonly mediaArtifactsEnabled: boolean;
}

export const DEFAULT_AGY_ARTIFACT_FEATURE_GATES: Readonly<AgyArtifactFeatureGates> = Object.freeze({
  nativeArtifactsEnabled: false,
  reviewControlEnabled: false,
  mediaArtifactsEnabled: false,
});

// ── Opaque Artifact Identifier & Classification ────────────────────────

export const OpaqueArtifactIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((val) => isValidOpaqueArtifactId(val), {
    message: 'Artifact identifier must be an opaque ID (no host paths, slashes, or traversal)',
  });

export const ArtifactOriginKindSchema = z.enum([
  'brain_session',
  'acp_plan',
  'acp_tool_diff',
  'teamwork_prompt',
  'dynamic_script',
  'dynamic_result',
  'browser_reference',
  'history_snapshot',
]);
export type ArtifactOriginKind = z.infer<typeof ArtifactOriginKindSchema>;

/** Explicitly excludes raw 'html' to prevent arbitrary HTML injection. */
export const ArtifactContentKindSchema = z.enum([
  'markdown',
  'diff',
  'json',
  'text',
  'script',
  'media_ref',
]);
export type ArtifactContentKind = z.infer<typeof ArtifactContentKindSchema>;

export const ArtifactVerifiedActionKeySchema = z.enum([
  'read_artifact',
  'read_plan',
  'read_diff',
  'read_browser_evidence',
  'submit_native_comment',
  'submit_native_approval',
  'submit_native_rejection',
]);
export type ArtifactVerifiedActionKey = z.infer<typeof ArtifactVerifiedActionKeySchema>;

export const ArtifactReviewWireSupportStatusSchema = z.enum([
  'unverified_pending_live_capture',
  'verified_live_wire',
  'unsupported',
]);
export type ArtifactReviewWireSupportStatus = z.infer<typeof ArtifactReviewWireSupportStatusSchema>;

export const ArtifactScopeSummaryDtoSchema = z
  .object({
    scopeKind: z.enum(['root', 'confirmed_child', 'confirmed_workflow', 'unknown_child', 'historical']),
    ownerAgentId: NativeAgentIdSchema.optional(),
    ownerLineage: AgentLineageSchema,
    activityId: ActivityIdSchema.optional(),
    workflowId: WorkflowIdSchema.optional(),
    isHistorical: z.boolean(),
    readOnly: z.boolean(),
  })
  .strict();
export type ArtifactScopeSummaryDto = z.infer<typeof ArtifactScopeSummaryDtoSchema>;

export const ArtifactSecurityFlagsDtoSchema = z
  .object({
    secretsRedactedCount: z.number().int().nonnegative(),
    hostPathsRedactedCount: z.number().int().nonnegative(),
    htmlStrippedOrEscaped: z.boolean(),
    unsafeLinksBlockedCount: z.number().int().nonnegative(),
    binaryRejected: z.boolean(),
    redactionNotes: z.array(z.string().min(1).max(80)),
  })
  .strict();
export type ArtifactSecurityFlagsDto = z.infer<typeof ArtifactSecurityFlagsDtoSchema>;

export const ArtifactResourceSummaryDtoSchema = z
  .object({
    artifactId: OpaqueArtifactIdSchema,
    title: z.string().min(1).max(200),
    originKind: ArtifactOriginKindSchema,
    contentKind: ArtifactContentKindSchema,
    revision: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    scope: ArtifactScopeSummaryDtoSchema,
    verifiedActionKeys: z.array(ArtifactVerifiedActionKeySchema),
    reviewWireSupport: ArtifactReviewWireSupportStatusSchema,
    pendingRequestId: z.string().min(1).max(128).optional(),
    provenance: PublicEvidenceDtoSchema,
  })
  .strict();
export type ArtifactResourceSummaryDto = z.infer<typeof ArtifactResourceSummaryDtoSchema>;

export const ArtifactResourceContentDtoSchema = z
  .object({
    schemaVersion: z.literal(AGY_ARTIFACT_SCHEMA_VERSION),
    contractRevision: z.literal(AGY_ARTIFACT_CONTRACT_REVISION),
    artifactId: OpaqueArtifactIdSchema,
    title: z.string().min(1).max(200),
    originKind: ArtifactOriginKindSchema,
    contentKind: ArtifactContentKindSchema,
    revision: z.number().int().positive(),
    content: z.string(),
    totalChars: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
    nextPageToken: z.string().min(1).max(64).nullable(),
    hasMore: z.boolean(),
    truncated: z.boolean(),
    scope: ArtifactScopeSummaryDtoSchema,
    security: ArtifactSecurityFlagsDtoSchema,
    verifiedActionKeys: z.array(ArtifactVerifiedActionKeySchema),
    provenance: PublicEvidenceDtoSchema,
  })
  .strict();
export type ArtifactResourceContentDto = z.infer<typeof ArtifactResourceContentDtoSchema>;

// ── Plan & ACP Diff Contracts (Separated from AGY Artifact Review) ─────

export const AgyPlanStepDtoSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(400),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'unknown']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    source: z.enum(['acp_agent_plan', 'agy_update_steps']),
  })
  .strict();
export type AgyPlanStepDto = z.infer<typeof AgyPlanStepDtoSchema>;

export const AgyPlanSnapshotDtoSchema = z
  .object({
    schemaVersion: z.literal(AGY_ARTIFACT_SCHEMA_VERSION),
    binding: RuntimeBindingSchema,
    planModeActive: z.boolean(),
    enforcement: z.enum(['native', 'client_guard', 'unknown']),
    steps: z.array(AgyPlanStepDtoSchema),
    revision: z.number().int().nonnegative(),
    isHistorical: z.boolean(),
    updatedAt: z.number().int().nonnegative(),
    provenance: PublicEvidenceDtoSchema.optional(),
  })
  .strict();
export type AgyPlanSnapshotDto = z.infer<typeof AgyPlanSnapshotDtoSchema>;

export const AgyToolDiffEntryDtoSchema = z
  .object({
    diffId: OpaqueArtifactIdSchema,
    toolCallId: z.string().min(1).max(128),
    relativeDisplayPath: z.string().min(1).max(200),
    unifiedDiff: z.string(),
    truncated: z.boolean(),
    origin: z.literal('acp_tool_diff'),
    ownerAgentId: NativeAgentIdSchema.optional(),
    ownerLineage: AgentLineageSchema,
    approvalId: z.string().min(1).max(128).optional(),
    approvalState: z.enum(['not_requested', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'unknown']),
    revision: z.number().int().positive(),
    isHistorical: z.boolean(),
    updatedAt: z.number().int().nonnegative(),
    provenance: PublicEvidenceDtoSchema,
  })
  .strict();
export type AgyToolDiffEntryDto = z.infer<typeof AgyToolDiffEntryDtoSchema>;

// ── Browser Agent Observation Contracts (Read-only, No Embedded Control) ─

export const BrowserRuntimeSurfaceKindSchema = z.enum([
  'app_embedded_browser',
  'cli_chrome_mcp',
  'enterprise_chrome_mcp',
  'unknown',
]);
export type BrowserRuntimeSurfaceKind = z.infer<typeof BrowserRuntimeSurfaceKindSchema>;

export const BrowserAgentRoleDtoSchema = z
  .object({
    roleId: OpaqueArtifactIdSchema,
    agentId: NativeAgentIdSchema.optional(),
    lineage: AgentLineageSchema,
    label: z.string().min(1).max(160),
    surface: BrowserRuntimeSurfaceKindSchema,
    state: WorkStateSchema,
    canControlBrowser: z.literal(false),
    provenance: PublicEvidenceDtoSchema,
  })
  .strict();
export type BrowserAgentRoleDto = z.infer<typeof BrowserAgentRoleDtoSchema>;

export const BrowserLogEntryDtoSchema = z
  .object({
    seq: z.number().int().positive(),
    timestamp: z.number().int().nonnegative(),
    surface: BrowserRuntimeSurfaceKindSchema,
    actionSummary: z.string().min(1).max(320),
    redactedTargetHost: z.string().max(128).optional(),
    status: z.enum(['running', 'completed', 'failed', 'blocked', 'unknown']),
    provenance: PublicEvidenceDtoSchema,
  })
  .strict();
export type BrowserLogEntryDto = z.infer<typeof BrowserLogEntryDtoSchema>;

export const BrowserMediaReferenceDtoSchema = z
  .object({
    mediaId: OpaqueArtifactIdSchema,
    label: z.string().min(1).max(160),
    mediaKind: z.enum(['screenshot', 'recording']),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/webm', 'video/mp4']),
    sizeBytes: z.number().int().nonnegative(),
    magicVerified: z.boolean(),
    sha256Prefix: z.string().min(8).max(32),
    gatedOff: z.boolean(),
    updatedAt: z.number().int().nonnegative(),
    provenance: PublicEvidenceDtoSchema,
  })
  .strict();
export type BrowserMediaReferenceDto = z.infer<typeof BrowserMediaReferenceDtoSchema>;

export const BrowserAgentObservationDtoSchema = z
  .object({
    schemaVersion: z.literal(AGY_ARTIFACT_SCHEMA_VERSION),
    binding: RuntimeBindingSchema,
    surface: BrowserRuntimeSurfaceKindSchema,
    controlSupported: z.literal(false),
    surfaceReasonCode: z.string().min(1).max(128),
    officialAppGuide: z.string().min(1).max(400),
    roles: z.array(BrowserAgentRoleDtoSchema),
    logs: z.array(BrowserLogEntryDtoSchema),
    droppedLogCount: z.number().int().nonnegative(),
    mediaReferences: z.array(BrowserMediaReferenceDtoSchema),
    mediaGateEnabled: z.boolean(),
    isHistorical: z.boolean(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserAgentObservationDto = z.infer<typeof BrowserAgentObservationDtoSchema>;

// ── Native Review Transport Port (Pre-wire fail-closed stub until captured) ─

export interface NativeArtifactReviewDispatchInput {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly requestId: string;
  readonly decision: 'approve' | 'reject' | 'comment';
  readonly lineNumber?: number;
  readonly commentBody?: string;
  readonly idempotencyKey: string;
}

export interface NativeArtifactReviewDispatchResult {
  readonly accepted: boolean;
  readonly state: 'response_written' | 'rejected' | 'unsupported' | 'conflict';
  readonly receiptId?: string;
  readonly reasonCode: string;
}

export interface NativeArtifactReviewTransportPort {
  getWireSupportStatus(binding: RuntimeBinding, artifactId: string): ArtifactReviewWireSupportStatus;
  submitReviewAction(
    input: NativeArtifactReviewDispatchInput,
  ): Promise<NativeArtifactReviewDispatchResult>;
}

export function createUnverifiedReviewTransportStub(): NativeArtifactReviewTransportPort {
  return {
    getWireSupportStatus() {
      return 'unverified_pending_live_capture';
    },
    async submitReviewAction() {
      return {
        accepted: false,
        state: 'unsupported',
        reasonCode: 'review_wire_schema_unverified',
      };
    },
  };
}
