import type {
  ActivityId,
  AgentLineage,
  ApprovalAnnotationDto,
  ApprovalRequest,
  BindingGeneration,
  Evidence,
  NativeAgentId,
  NativeRequestKind,
  NativeRequestReceiptState,
  NativeRequestSummaryDto,
  PublicEvidenceDto,
  ResolveApprovalRequest,
  ResolveNativeRequestInput,
  RiskLevel,
  RpcId,
  RuntimeBinding,
  RuntimeId,
  RuntimeRequestKind,
  ToolKind,
  WorkflowId,
  WorkflowKind,
} from '@harnessmate/protocol';
import type { ApprovalAnnotateContext } from '../../../../core/approval-center-service.js';

export type NativeRequestOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | 'decline'
  | 'custom';

export interface NativeRequestOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: NativeRequestOptionKind;
  readonly description?: string;
  readonly securityWarning?: string;
  /** True for persistent/session-wide permissions such as allow_always / allow_session. */
  readonly scopeWidening: boolean;
}

export type NativeElicitationFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'string_array';

export type NativeElicitationStringFormat = 'email' | 'uri' | 'date' | 'date-time';

export interface NativeElicitationFieldSchema {
  readonly name: string;
  readonly type: NativeElicitationFieldType;
  readonly title?: string;
  readonly description?: string;
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly enumNames?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: NativeElicitationStringFormat;
  readonly defaultValue?: string | number | boolean | readonly string[];
}

export interface NativeElicitationFormSpec {
  readonly message: string;
  readonly mode: 'form' | 'url';
  readonly fields: readonly NativeElicitationFieldSchema[];
  readonly requiredFields: readonly string[];
  readonly additionalProperties: boolean;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export type NativeRequestTargetScope =
  | 'root'
  | 'confirmed_child'
  | 'confirmed_workflow'
  | 'unknown_child';

export interface NativeRequestTargetResolverInput {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly actualNativeSessionId: string;
  readonly rootNativeSessionId?: string | null;
  readonly toolCallId?: string;
  readonly parentSessionHint?: string;
  readonly childSessionHint?: string;
  readonly workflowIdHint?: string;
  readonly rawParams: Record<string, unknown>;
}

export interface NativeRequestTargetResolution {
  readonly scope: NativeRequestTargetScope;
  readonly targetLineage: AgentLineage;
  readonly agentId?: NativeAgentId;
  readonly agentLabel?: string;
  readonly activityId?: ActivityId;
  readonly workflowId?: WorkflowId;
  readonly workflowKind?: WorkflowKind;
  readonly workflowLabel?: string;
  readonly turnId: string | null;
  readonly isDetached: boolean;
  readonly forwardedToParentSession: boolean;
  readonly provenanceReason: string;
}

/**
 * Frozen NP-05 / NP-04 target & lineage attribution seam consumed by NP-07.
 * During G2 parallel development, `StubNativeRequestTargetResolver` implements this port;
 * at G2 integration, NP-05 child router and NP-04 reactive runtime provide live backing data.
 */
export interface NativeRequestTargetResolver {
  resolveTarget(input: NativeRequestTargetResolverInput): NativeRequestTargetResolution;
  getRootNativeSessionId?(binding: RuntimeBinding, connectionId: string): string | null | undefined;
}

export type UnknownChildRequestPolicy = 'hold_bounded_cancel_only' | 'reject_immediately';

export type NativeRequestValidationErrorCode =
  | 'INVALID_PAYLOAD'
  | 'INVALID_OPTION'
  | 'FREE_TEXT_NOT_SUPPORTED'
  | 'FORM_SCHEMA_INVALID'
  | 'UNKNOWN_CHILD_WIDENING_BLOCKED'
  | 'UNSUPPORTED_FORM'
  | 'STALE_GENERATION'
  | 'REQUEST_EXPIRED'
  | 'REQUEST_NOT_PENDING';

export class NativeRequestValidationError extends Error {
  constructor(
    readonly code: NativeRequestValidationErrorCode,
    message: string,
    readonly details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
    this.name = 'NativeRequestValidationError';
  }
}

export interface NativeRequestValidationResult {
  readonly valid: boolean;
  readonly errorCode?: NativeRequestValidationErrorCode;
  readonly message?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/**
 * Strictly sanitized public request detail DTO for UI & Approval Center selectors.
 * Explicitly omits `connectionId`, `wireRequestId`, `actualNativeSessionId`, and raw host paths.
 */
export interface NativeRequestDetailDto extends NativeRequestSummaryDto {
  readonly scope: NativeRequestTargetScope;
  readonly agentLabel?: string;
  readonly workflowId?: WorkflowId;
  readonly workflowKind?: WorkflowKind;
  readonly workflowLabel?: string;
  readonly isDetached: boolean;
  readonly forwardedToParentSession: boolean;
  readonly provenanceReason: string;
  readonly occurrence: number;
  readonly toolName: string;
  readonly toolKind: ToolKind;
  readonly summary: string;
  readonly diffPreview?: string | null;
  readonly riskLevel: RiskLevel;
  readonly annotations: readonly ApprovalAnnotationDto[];
  readonly securityWarnings: readonly string[];
  readonly options: readonly NativeRequestOption[];
  readonly questionText?: string;
  readonly formSpec?: NativeElicitationFormSpec;
  readonly canAnswer: boolean;
  readonly canCancel: boolean;
  readonly unsupportedReason?: string;
  readonly resolvedAt?: number;
  readonly terminalReason?: string;
}

/**
 * Optional read-only Approval Center bridge.
 * Strictly evaluates existing rules (never modifies general permission rules or risk scores)
 * and optionally mirrors sanitized ApprovalRequest entries so legacy Approval Center stays usable.
 */
export interface NativeApprovalCenterBridge {
  evaluateLocalAnnotations?(ctx: ApprovalAnnotateContext): ApprovalAnnotationDto[];
  getSessionContext?(sessionId: string): {
    readonly workspaceId: string;
    readonly cwd?: string;
    readonly parentSessionId?: string | null;
  } | null;
  mirrorPendingApproval?(approval: ApprovalRequest): void;
  syncResolvedApproval?(params: {
    readonly approvalId: string;
    readonly status: ApprovalRequest['status'];
    readonly decision?: ApprovalRequest['decision'];
    readonly resolvedBy?: 'desktop' | 'mobile' | 'auto' | null;
    readonly comment?: string | null;
  }): void;
}

export interface NativePermissionRouterOptions {
  /** Target & child lineage resolver (NP-05 stub or real implementation). */
  readonly targetResolver?: NativeRequestTargetResolver;
  /** Optional read-only Approval Center bridge for risk annotations and legacy mirroring. */
  readonly approvalCenterBridge?: NativeApprovalCenterBridge;
  /** Policy when a request targets an unconfirmed foreign child session or conflicting lineage. */
  readonly unknownChildPolicy?: UnknownChildRequestPolicy;
  /** Default bounded deadline for standard pending native requests (ms). Default: 120_000. */
  readonly defaultDeadlineMs?: number;
  /** Independent shorter deadline for unknown/unconfirmed child requests (ms). Default: 30_000. */
  readonly unknownChildDeadlineMs?: number;
  /** Whether unsupported `mode: 'url'` elicitation should be rejected with -32601 immediately (default: true). */
  readonly rejectUrlElicitationMode?: boolean;
  /** Monotonic/wall clock provider for deterministic tests. */
  readonly now?: () => number;
  /** Custom approval ID generator for deterministic tests. */
  readonly generateApprovalId?: () => string;
  /** Optional custom timer hooks for deterministic tests. */
  readonly scheduleTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface LegacyApprovalBridgeInput {
  readonly binding: RuntimeBinding;
  readonly approvalId: string;
  readonly receiptId: string;
  readonly request: ResolveApprovalRequest;
  readonly resolvedBy: 'desktop' | 'mobile';
}

export interface NativeRequestResolutionOutcome {
  readonly approvalId: string;
  readonly receiptId: string;
  readonly receiptState: NativeRequestReceiptState;
  readonly conflict: boolean;
}

export interface ParsedIncomingWireRequest {
  readonly method: string;
  readonly kind: NativeRequestKind;
  readonly actualNativeSessionId: string;
  readonly toolCallId?: string;
  readonly parentSessionHint?: string;
  readonly childSessionHint?: string;
  readonly workflowIdHint?: string;
  readonly toolName: string;
  readonly toolKind: ToolKind;
  readonly legacyRequestKind: RuntimeRequestKind;
  readonly summary: string;
  readonly diffPreview?: string | null;
  readonly riskLevel: RiskLevel;
  readonly rawInput: unknown;
  readonly options: readonly NativeRequestOption[];
  readonly securityWarnings: readonly string[];
  readonly allowsFreeText: boolean;
  readonly questionText?: string;
  readonly formSpec?: NativeElicitationFormSpec;
  readonly canAnswer: boolean;
  readonly unsupportedReason?: string;
  readonly dedupKey: string;
}

export interface InternalPendingNativeRequestRecord {
  readonly approvalId: string;
  readonly receiptId: string;
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly ingressOrdinal: number;
  readonly wireRequestId: RpcId;
  readonly occurrence: number;
  readonly actualNativeSessionId: string;
  readonly method: string;
  readonly kind: NativeRequestKind;
  readonly scope: NativeRequestTargetScope;
  readonly targetLineage: AgentLineage;
  readonly agentId?: NativeAgentId;
  readonly agentLabel?: string;
  readonly activityId?: ActivityId;
  readonly workflowId?: WorkflowId;
  readonly workflowKind?: WorkflowKind;
  readonly workflowLabel?: string;
  readonly turnId: string | null;
  readonly isDetached: boolean;
  readonly forwardedToParentSession: boolean;
  readonly provenanceReason: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly toolKind: ToolKind;
  readonly legacyRequestKind: RuntimeRequestKind;
  readonly summary: string;
  readonly diffPreview?: string | null;
  readonly riskLevel: RiskLevel;
  readonly annotations: readonly ApprovalAnnotationDto[];
  readonly securityWarnings: readonly string[];
  readonly options: readonly NativeRequestOption[];
  readonly allowedOptionIds: readonly string[];
  readonly allowsFreeText: boolean;
  readonly questionText?: string;
  readonly formSpec?: NativeElicitationFormSpec;
  readonly canAnswer: boolean;
  readonly canCancel: boolean;
  readonly unsupportedReason?: string;
  readonly deadline: number;
  readonly evidence: Evidence;
  readonly createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  terminalReason?: string;
  receiptState: NativeRequestReceiptState;
  wireWritten: boolean;
  respond: ((result: unknown) => boolean) | null;
  respondError: ((code: number, message: string) => boolean) | null;
  timer?: ReturnType<typeof setTimeout>;
}

export type ResolveNativeRequestWithCasInput = {
  readonly binding: RuntimeBinding;
  readonly approvalId: string;
  readonly request: ResolveNativeRequestInput;
  readonly resolvedBy: 'desktop' | 'mobile';
};

export type PublicEvidenceConverter = (evidence: Evidence, nowMs?: number) => PublicEvidenceDto;
export type NativeRequestScopeIds = {
  readonly runtimeId: RuntimeId;
  readonly generation: BindingGeneration;
};
