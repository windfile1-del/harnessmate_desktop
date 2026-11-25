import type {
  ActivityId,
  AgentLineage,
  BindingGeneration,
  Evidence,
  GateState,
  NativeAgentId,
  NativeStage,
  NativeStageDto,
  NativeWorkflow,
  NativeWorkflowDto,
  Observed,
  PublicEvidenceDto,
  PublicObserved,
  RuntimeBinding,
  RuntimeId,
  WorkId,
  WorkOutcome,
  WorkState,
  WorkflowId,
} from '@harnessmate/protocol';

export const BOOST_WORKFLOW_CONTRACT_REVISION = '1.0-np09' as const;
export const BOOST_CAPABILITY_ID = 'AGY-W06' as const;
export const BOOST_CAPABILITY_ALIAS = 'agy.workflow.boost' as const;
export const BOOST_SLASH_COMMAND = '/boost' as const;
export const BOOST_OFFICIAL_DOC_URL = 'https://antigravity.google/docs/boost/' as const;

/**
 * Canonical Boost phase enum is ONLY assigned when explicit protocol/runtime signals
 * match `initial`, `improvement`, or `verification`.
 * Unrecognized roles/stages are NEVER coerced into this enum and are preserved
 * verbatim as `observedLabel` without inferring progress or round counts.
 */
export type BoostCanonicalPhaseKind = 'initial' | 'improvement' | 'verification';

export type BoostPhaseClassification =
  | {
      readonly kind: 'canonical';
      readonly phaseKind: BoostCanonicalPhaseKind;
      readonly observedLabel: string;
    }
  | {
      readonly kind: 'observed_unknown';
      readonly observedLabel: string;
    };

export type BoostEligibilityStatus =
  | 'eligible_advertised'
  | 'paid_opt_in_required'
  | 'ineligible_tier'
  | 'ineligible_server_denied'
  | 'unverified_profile'
  | 'desktop_source_unsupported'
  | 'not_advertised'
  | 'advertisement_unknown'
  | 'no_live_connection';

export interface BoostServerDenialRecord {
  readonly code: string;
  readonly message: string;
  readonly category: 'entitlement' | 'quota' | 'plan_required' | 'policy' | 'permission_denied' | 'unknown_denial';
  readonly observedAt: number;
  readonly evidence: Evidence;
}

export interface BoostPreservedIntentGuidance {
  readonly originalModeIntent: string;
  readonly draftPreserved: true;
  readonly autoUpgradeBlocked: true;
  readonly reasonCode: string;
  readonly message: string;
  readonly officialEntry: string;
  readonly officialDocUrl: string;
}

export interface BoostEligibilityResolution {
  readonly status: BoostEligibilityStatus;
  readonly eligible: boolean;
  readonly canLaunchNow: boolean;
  readonly launchGate: GateState;
  readonly observeGate: GateState;
  readonly controlGate: GateState;
  readonly boostAdvertised: boolean | null;
  readonly modelObserved: Observed<string>;
  readonly tierObserved: Observed<string>;
  readonly autoUpgradeBlocked: true;
  readonly serverDenial: BoostServerDenialRecord | null;
  readonly guidance: BoostPreservedIntentGuidance;
  readonly evidenceRefs: readonly string[];
  readonly evaluatedAt: number;
}

export interface BoostEligibilityDto {
  readonly status: BoostEligibilityStatus;
  readonly eligible: boolean;
  readonly canLaunchNow: boolean;
  readonly launchGate: GateState;
  readonly observeGate: GateState;
  readonly controlGate: GateState;
  readonly boostAdvertised: boolean | null;
  readonly modelObserved: PublicObserved<string>;
  readonly tierObserved: PublicObserved<string>;
  readonly autoUpgradeBlocked: true;
  readonly serverDenial: {
    readonly code: string;
    readonly category: BoostServerDenialRecord['category'];
    readonly message: string;
    readonly evidence: PublicEvidenceDto;
  } | null;
  readonly guidance: BoostPreservedIntentGuidance;
  readonly evidenceRefs: readonly string[];
  readonly evaluatedAt: number;
}

export interface BoostLaunchValidationInput {
  readonly binding: RuntimeBinding;
  readonly lane: 'query' | 'config' | 'live_workflow' | 'manager';
  readonly userInitiated: boolean;
  readonly explicitUserSelection: boolean;
  readonly autoUpgradeAttempt?: boolean;
  readonly useAuxiliaryCli?: boolean;
  readonly task: string;
  readonly attachmentIds?: readonly string[];
  readonly eligibility: BoostEligibilityResolution;
}

export type BoostLaunchValidationResult =
  | {
      readonly ok: true;
      readonly promptText: string;
      readonly attachmentIds: readonly string[];
      readonly lane: 'live_workflow';
      readonly capabilityId: typeof BOOST_CAPABILITY_ID;
      readonly actionKey: 'launch_boost';
    }
  | {
      readonly ok: false;
      readonly statusCode: 400 | 403 | 422;
      readonly code: 'INVALID_REQUEST' | 'FORBIDDEN' | 'UNSUPPORTED_ACTION';
      readonly reasonCode: string;
      readonly message: string;
      readonly guidance: BoostPreservedIntentGuidance;
    };

export interface BoostRoleObservation {
  readonly roleKey: string;
  readonly observedLabel: string;
  readonly classification: BoostPhaseClassification;
  /** Lineage is tracked strictly separately from Boost phases (07_Architecture.md). */
  readonly agentId?: NativeAgentId;
  readonly lineage: AgentLineage | 'unlinked';
  readonly workIds: readonly WorkId[];
  readonly state: Observed<WorkState>;
  readonly revision: number;
  readonly evidence: Evidence;
}

export interface BoostRoleDto {
  readonly roleKey: string;
  readonly observedLabel: string;
  readonly classification: BoostPhaseClassification;
  readonly agentId?: NativeAgentId;
  readonly lineage: AgentLineage | 'unlinked';
  readonly workIds: readonly WorkId[];
  readonly state: PublicObserved<WorkState>;
  readonly revision: number;
  readonly evidence: PublicEvidenceDto;
}

export type BoostVerificationClueKind =
  | 'launch_confirmed'
  | 'phase_signal'
  | 'role_observed'
  | 'verification_check'
  | 'verification_outcome'
  | 'server_denied'
  | 'stop_requested'
  | 'stop_confirmed'
  | 'stop_unknown'
  | 'unknown_stage_observed';

export interface BoostVerificationClue {
  readonly clueId: string;
  readonly seq: number;
  readonly kind: BoostVerificationClueKind;
  readonly label: string;
  readonly summary: string;
  readonly state: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly stageId?: string;
  readonly agentId?: NativeAgentId;
  readonly workId?: WorkId;
  readonly artifactId?: string;
  readonly evidence: Evidence;
  readonly observedAt: number;
}

export interface BoostVerificationClueDto {
  readonly clueId: string;
  readonly seq: number;
  readonly kind: BoostVerificationClueKind;
  readonly label: string;
  readonly summary: string;
  readonly state: PublicObserved<WorkState>;
  readonly outcome?: PublicObserved<WorkOutcome>;
  readonly stageId?: string;
  readonly agentId?: NativeAgentId;
  readonly workId?: WorkId;
  readonly artifactId?: string;
  readonly evidence: PublicEvidenceDto;
  readonly observedAt: number;
}

export interface BoostArtifactObservation {
  readonly artifactId: string;
  readonly title: string;
  readonly artifactKind: 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown';
  readonly ownerAgentId?: NativeAgentId;
  readonly activityId?: ActivityId;
  readonly revision: number;
  readonly updatedAt: number;
  readonly evidence: Evidence;
}

export type BoostStopState = 'none' | 'requested' | 'confirmed' | 'unknown' | 'unsupported';

export interface BoostStopObservation {
  readonly state: BoostStopState;
  readonly supportedInterruptPath: 'root_session_cancel' | 'none';
  readonly requestedAt?: number;
  readonly confirmedAt?: number;
  readonly reasonCode?: string;
  readonly evidence?: Evidence;
}

export interface BoostStopDto {
  readonly state: BoostStopState;
  readonly supportedInterruptPath: 'root_session_cancel' | 'none';
  readonly requestedAt?: number;
  readonly confirmedAt?: number;
  readonly reasonCode?: string;
  readonly evidence?: PublicEvidenceDto;
}

export interface BoostObserverDiagnostic {
  readonly code:
    | 'stale_generation_rejected'
    | 'wrong_connection_rejected'
    | 'history_replay_isolated'
    | 'duplicate_frame_ignored'
    | 'model_spontaneous_ignored'
    | 'unknown_stage_preserved'
    | 'unknown_role_preserved'
    | 'server_denial_recorded'
    | 'stop_requested'
    | 'stop_confirmed'
    | 'stop_unknown_after_disconnect'
    | 'unconfirmed_lineage_kept_unlinked';
  readonly observedAt: number;
  readonly runtimeId: RuntimeId;
  readonly generation: BindingGeneration;
  readonly detail: string;
}

export interface BoostStageRecord {
  readonly stage: NativeStage;
  readonly classification: BoostPhaseClassification;
  readonly summary?: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface BoostWorkflowState {
  readonly binding: RuntimeBinding;
  readonly workflow: NativeWorkflow;
  readonly launchConfirmed: boolean;
  readonly launchEvidence: Evidence;
  readonly stagesById: ReadonlyMap<string, BoostStageRecord>;
  readonly stageOrder: readonly string[];
  readonly rolesByKey: ReadonlyMap<string, BoostRoleObservation>;
  readonly clues: readonly BoostVerificationClue[];
  readonly artifacts: readonly BoostArtifactObservation[];
  readonly relatedActivityIds: readonly ActivityId[];
  readonly relatedWorkIds: readonly WorkId[];
  readonly stop: BoostStopObservation;
  readonly serverDenial: BoostServerDenialRecord | null;
  readonly revision: number;
}

export interface BoostStudioSnapshotDto {
  readonly contractRevision: typeof BOOST_WORKFLOW_CONTRACT_REVISION;
  readonly binding: RuntimeBinding;
  readonly workflow: NativeWorkflowDto | null;
  readonly launchConfirmed: boolean;
  readonly hasObservedPhases: boolean;
  readonly phaseClassifications: Readonly<Record<string, BoostPhaseClassification>>;
  readonly stages?: readonly NativeStageDto[];
  readonly roles: readonly BoostRoleDto[];
  readonly verificationClues: readonly BoostVerificationClueDto[];
  readonly relatedActivityIds: readonly ActivityId[];
  readonly relatedWorkIds: readonly WorkId[];
  readonly stop: BoostStopDto;
  readonly serverDenial: BoostEligibilityDto['serverDenial'];
  readonly revision: number;
}

export interface BoostPlanTierEvidenceEntry {
  readonly tierLabel: string;
  readonly expectedBoostEligible: boolean | null;
  readonly evidenceCategory: 'official_doc' | 'synthetic' | 'replay_with_provenance' | 'live_raw' | 'live_hm' | 'official_comparison';
  readonly verifiedLevel: 0 | 1 | 2 | 3 | 4 | 5 | null;
  readonly evidenceRef: string;
  readonly note: string;
}
