import type {
  Activity,
  BindingGeneration,
  Evidence,
  NativeCanonicalEvent,
  NativeRuntimeProjection,
  NativeRuntimeStatus,
  NativeWork,
  Observed,
  RpcId,
  RuntimeBinding,
  RuntimeId,
  WorkId,
  WorkState,
  WorkflowId,
} from '@harnessmate/protocol';
import type { NativeIngress } from '../wiring/types.js';

export const AGY_NP15_RECOVERY_VERSION = '1.0.0-np15' as const;

export interface AgyNativeRecoveryConfig {
  /**
   * Master gate for active recovery / reconcile mutations.
   * Defaults to `false` so disabling or rolling back preserves read-only historical native feeds.
   */
  readonly activeReconcileEnabled: boolean;
  /**
   * ACP v2 Preview negotiation & codec gate. MUST remain `false` unless explicitly enabled
   * AND double-confirmed by server capabilities at handshake.
   */
  readonly allowV2Preview: boolean;
  /** Allow read-only fallback to persisted native feed / indexed SQLite history. */
  readonly allowReadOnlyHistoryFallback: boolean;
  /** Hard bound on sanitized history replay frames accepted per attach. */
  readonly maxHistoryReplayFrames: number;
  /** Hard bound on retained crash & compatibility audit records in memory. */
  readonly maxRecoveryAuditRecords: number;
  /** Default staleness TTL for native_snapshot evidence when not specified. */
  readonly snapshotStaleTtlMs: number;
  /** Bounded grace period for `session/cancel` during connection teardown. */
  readonly cancelGraceMs: number;
  /** Bounded grace period for `session/close` during connection teardown. */
  readonly closeGraceMs: number;
  /** Enforce strict profileRef, sourceRef, bindingRevision, and workspace scope matching. */
  readonly strictProfileGuard: boolean;
  /** Known broken CLI versions that must degrade safely instead of running full live controls. */
  readonly quarantinedCliVersions: readonly string[];
}

export const DEFAULT_AGY_NATIVE_RECOVERY_CONFIG: Readonly<AgyNativeRecoveryConfig> = Object.freeze({
  activeReconcileEnabled: false,
  allowV2Preview: false,
  allowReadOnlyHistoryFallback: true,
  maxHistoryReplayFrames: 2_000,
  maxRecoveryAuditRecords: 200,
  snapshotStaleTtlMs: 60_000,
  cancelGraceMs: 3_000,
  closeGraceMs: 2_000,
  strictProfileGuard: true,
  quarantinedCliVersions: [],
});

export type RecoveryReasonCode =
  | 'daemon_startup_reconcile'
  | 'transport_closed'
  | 'connection_replaced_same_generation'
  | 'generation_retired'
  | 'out_of_order_attach_discarded'
  | 'profile_or_source_mismatch'
  | 'binding_revision_mismatch'
  | 'workspace_scope_mismatch'
  | 'native_session_id_missing'
  | 'auth_required_manual_login'
  | 'v2_downgraded_to_v1'
  | 'unsupported_protocol_version'
  | 'v2_schema_unconfirmed'
  | 'bad_cli_version_degraded'
  | 'history_replay_only'
  | 'no_live_continuation_evidence'
  | 'schedule_occurrence_unverified'
  | 'active_reconcile_disabled'
  | 'reconciling_control_gated'
  | 'process_crash_detected'
  | 'network_disconnect'
  | 'windows_reboot_recovery'
  | 'native_schema_newer_than_reader'
  | 'v1_resume_attached'
  | 'v1_load_replay_attached'
  | 'v2_preview_attached'
  | 'fresh_session_attached';

export type NegotiatedAcpProtocol = 1 | 2;

export interface ParsedAcpInitializeCapabilities {
  readonly requestedProtocol: 1 | 2;
  readonly negotiatedProtocol: NegotiatedAcpProtocol;
  readonly downgradedFromV2: boolean;
  readonly v2SchemaConfirmed: boolean;
  readonly agentName: string | null;
  readonly cliVersion: string | null;
  readonly authMethods: readonly string[];
  readonly loadSession: boolean;
  readonly sessionCapabilities: {
    readonly resume: boolean;
    readonly load: boolean;
    readonly close: boolean;
    readonly list: boolean;
    readonly additionalDirectories: boolean;
    readonly replayCursor: boolean;
  };
  readonly promptCapabilities: {
    readonly image: boolean;
    readonly audio: boolean;
    readonly embeddedContext: boolean;
  };
}

export type AttachStrategyMode =
  | 'v1_resume'
  | 'v1_load_replay'
  | 'v2_resume_cursor'
  | 'fresh'
  | 'manual_attach_only'
  | 'auth_blocked';

export interface AttachStrategyDecision {
  readonly mode: AttachStrategyMode;
  readonly channelDuringAttach: 'live' | 'history_replay';
  readonly willReplayHistory: boolean;
  readonly allowsLiveApprovalsDuringAttach: false;
  readonly allowsWorkflowControlDuringReconcile: false;
  readonly reasonCode: RecoveryReasonCode;
  readonly fallbackFrom?: RecoveryReasonCode;
}

export interface RecoveryBindingGuardInput {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly profileRef: string;
  readonly sourceRef: string;
  readonly workspaceRoot: string;
  readonly authState: 'authenticated' | 'unauthenticated' | 'unknown';
  readonly expectedBindingRevision?: number;
  readonly candidateNativeSessionId?: string | null;
  readonly stored: {
    readonly runtimeId: RuntimeId;
    readonly sessionId: string;
    readonly instanceId: string;
    readonly bindingRevision: number;
    readonly profileRef: string;
    readonly sourceRef: string;
    readonly generation: BindingGeneration;
    readonly workspaceRoot?: string;
  };
  readonly platform?: NodeJS.Platform;
}

export interface RecoveryGuardResult {
  readonly allowed: boolean;
  readonly reasonCode?: RecoveryReasonCode;
  readonly requiresManualAttach: boolean;
  readonly requiresManualAuth: boolean;
  readonly details?: string;
}

export interface RecoverableJobEvidence {
  readonly workId: WorkId;
  readonly kind: NativeWork['kind'];
  readonly continuationState: 'confirmed_continuable' | 'stale_needs_evidence' | 'not_continuable';
  readonly evidenceSource: 'live_protocol' | 'native_snapshot' | 'prior_generation_only';
  readonly reasonCode: RecoveryReasonCode;
  readonly lastObservedAt: number | null;
}

// ── Frozen NP-12 Interop Port (Schedule & Occurrence Recovery) ────────

export interface PersistedScheduleOccurrenceInput {
  readonly workflowId: WorkflowId;
  readonly scheduleNativeId: string;
  readonly occurrenceId: string;
  readonly workId: WorkId;
  readonly originGeneration: BindingGeneration;
  readonly lastState: WorkState;
  readonly fireAt?: number;
  readonly lastObservedAt?: number;
}

export interface FreshScheduleOccurrenceEvidence {
  readonly scheduleNativeId: string;
  readonly occurrenceId: string;
  readonly state: WorkState;
  readonly source: 'live_protocol' | 'native_snapshot';
  readonly observedAt: number;
  readonly staleAt?: number;
  readonly connectionId?: string;
  readonly ingressOrdinal?: number;
  readonly wireVariant?: string;
  readonly sourceId?: string;
  readonly schemaVersion?: string;
  readonly nextAt?: number;
}

export interface ReconciledScheduleOccurrence {
  readonly dedupeKey: string;
  readonly workflowId: WorkflowId;
  readonly workId: WorkId;
  readonly occurrenceId: string;
  readonly status: 'confirmed_active' | 'fired_observed' | 'cancelled_observed' | 'stale_unverified';
  readonly observedState: Observed<WorkState>;
  readonly statusSource: 'live_protocol' | 'native_snapshot' | 'prior_generation_only';
  readonly deduplicatedAcrossGenerations: boolean;
  readonly originGeneration: BindingGeneration;
  readonly reconciledGeneration: BindingGeneration;
  readonly reasonCode: RecoveryReasonCode;
}

export interface NativeScheduleRecoveryPort {
  reconcileScheduleOccurrences(input: {
    readonly binding: RuntimeBinding;
    readonly persistedOccurrences: readonly PersistedScheduleOccurrenceInput[];
    readonly freshEvidence: readonly FreshScheduleOccurrenceEvidence[];
    readonly nowMs?: number;
  }): {
    readonly occurrences: readonly ReconciledScheduleOccurrence[];
    readonly deduplicatedCount: number;
    readonly unverifiedCount: number;
    readonly nextAt?: Observed<number>;
  };
}

// ── UI-Aligned Recovery Status Summary DTO (NP-03 Shared Selectors) ────

export type RecoveryPhase =
  | 'attached'
  | 'reconciling'
  | 'recoverable'
  | 'manual_attach_required'
  | 'read_only_history'
  | 'auth_required';

export interface RecoveryStatusSummaryDto {
  readonly binding: RuntimeBinding;
  readonly asOfSeq: number;
  readonly runtimeStatus: NativeRuntimeStatus;
  readonly recoveryPhase: RecoveryPhase;
  readonly lastSeenAt: number | null;
  readonly invalidatedApprovalIds: readonly string[];
  readonly deliveryUnknownReceiptIds: readonly string[];
  readonly uncertainEntityIds: readonly string[];
  readonly recoverableJobs: readonly RecoverableJobEvidence[];
  readonly historyReadPathAvailable: boolean;
  readonly historyReadSource: 'native_feed' | 'indexed_sqlite' | 'session_load_replay' | 'none';
  readonly autoLoginTriggered: false;
  readonly manualActionHint?: string;
  readonly reasonCode: RecoveryReasonCode;
}

// ── CLI Compatibility & Crash Audit Records ────────────────────────────

export type CliVersionCompatBand =
  | 'legacy_unverified'
  | 'pre_1515_finite_compat'
  | 'boundary_1515'
  | 'verified_handshake_v1'
  | 'quarantined_bad_version'
  | 'unknown_version';

export interface CliVersionCompatProfile {
  readonly band: CliVersionCompatBand;
  readonly cliVersion: string | null;
  readonly supportsReliableCancel: boolean;
  readonly supportsSessionClose: boolean;
  readonly requiresIdleGapLoadGuard: boolean;
  readonly degradedToSafeMode: boolean;
  readonly reasonCode?: RecoveryReasonCode;
  readonly notes: string;
}

export interface CrashRecoveryRecord {
  readonly recordId: string;
  readonly recordedAt: number;
  readonly trigger:
    | 'daemon_startup'
    | 'process_crash'
    | 'network_disconnect'
    | 'windows_reboot'
    | 'transport_closed'
    | 'connection_replaced'
    | 'generation_changed';
  readonly runtimeId?: RuntimeId;
  readonly generation?: BindingGeneration;
  readonly invalidatedApprovalCount: number;
  readonly deliveryUnknownCount: number;
  readonly uncertainEntityCount: number;
  readonly reasonCode: RecoveryReasonCode;
}

export interface CompatIncidentRecord {
  readonly incidentId: string;
  readonly recordedAt: number;
  readonly category:
    | 'protocol_negotiation'
    | 'bad_cli_version'
    | 'teardown_fallback'
    | 'schema_newer_than_reader'
    | 'history_guard_blocked';
  readonly cliVersion?: string | null;
  readonly requestedProtocol?: number;
  readonly negotiatedProtocol?: number | null;
  readonly reasonCode: RecoveryReasonCode;
  readonly summary: string;
}

// ── History Replay & Read-Only Feed Types ──────────────────────────────

export interface HistoryReplayEntry {
  readonly entryId: string;
  readonly ingressOrdinal: number;
  readonly kind: 'user_message' | 'assistant_message' | 'thinking' | 'tool_event' | 'metadata';
  readonly text?: string;
  readonly toolCallId?: string;
  readonly status?: string;
  readonly originSession?: string;
  readonly evidence: Extract<Evidence, { readonly kind: 'replay' }>;
}

export interface BlockedReplayServerRequest {
  readonly ingressOrdinal: number;
  readonly rpcId: RpcId | null;
  readonly method: string;
  readonly reasonCode: 'replay_server_request_blocked';
}

export interface SanitizedHistoryReplayResult {
  readonly entries: readonly HistoryReplayEntry[];
  readonly blockedServerRequests: readonly BlockedReplayServerRequest[];
  readonly blockedServerRequestCount: number;
  readonly ignoredNonReplayCount: number;
  readonly droppedFrameCount: number;
  readonly truncated: boolean;
  readonly createsLiveLeases: false;
  readonly emitsLiveApprovals: false;
}

export interface PersistedNativeHistoryReadResult {
  readonly available: boolean;
  readonly readOnly: true;
  readonly reasonCode?: RecoveryReasonCode;
  readonly projection: NativeRuntimeProjection | null;
  readonly events: readonly NativeCanonicalEvent[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly resyncRequired: boolean;
  readonly resyncReason?: string;
  readonly demotedActivities: readonly Activity[];
}

export interface HistoryReplayEnvelopeBatch {
  readonly frames: readonly NativeIngress[];
  readonly captureId?: string;
  readonly maxFrames?: number;
  readonly expectedBinding?: RuntimeBinding;
}
