import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  Activity,
  AgentIdentity,
  CapabilityDescriptor,
  EvidenceDto,
  GateState,
  NativeStage,
  NativeWork,
  NativeWorkflow,
  Observed,
  WorkflowId,
} from '../../../../lib/native-client';

export const BOOST_STUDIO_VIEW_REVISION = '1.0-np09' as const;
export const BOOST_CAPABILITY_ID = 'AGY-W06' as const;
export const BOOST_OFFICIAL_DOC_URL = 'https://antigravity.google/docs/boost/' as const;

export type BoostCanonicalPhaseKind = 'initial' | 'improvement' | 'verification';

export type BoostPhaseDisplayClassification =
  | { readonly kind: 'canonical'; readonly phaseKind: BoostCanonicalPhaseKind; readonly label: string }
  | { readonly kind: 'observed_unknown'; readonly label: string };

export interface BoostEligibilityBannerModel {
  readonly capabilityId: string;
  readonly launchGate: GateState;
  readonly observeGate: GateState;
  readonly controlGate: GateState;
  readonly advertised: boolean | null;
  readonly tierHint: string;
  readonly versionNote?: string;
  readonly snapshotRevision: number;
  readonly reasonCode: string;
  readonly headline: string;
  readonly explanation: string;
  readonly autoUpgradeNotice: string;
  readonly officialEntryHint: string;
  readonly officialDocUrl: string;
  readonly evidenceRefs: readonly string[];
  readonly verifiedLevel: CapabilityDescriptor['verifiedLevel'];
  readonly isEligibleToLaunch: boolean;
}

export interface BoostObservedPhaseView {
  readonly stage: NativeStage;
  readonly classification: BoostPhaseDisplayClassification;
  readonly linkedAgents: readonly AgentIdentity[];
  readonly summary?: string;
  readonly evidence: EvidenceDto | null;
  readonly reasonCode?: string;
}

export interface BoostVerificationClueView {
  readonly id: string;
  readonly seq: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly summary: string;
  readonly createdAt: number;
  readonly evidence?: EvidenceDto;
}

export interface BoostArtifactRefView {
  readonly artifactId: string;
  readonly title: string;
  readonly artifactKind: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly evidence?: EvidenceDto;
}

export interface BoostStopTargetModel {
  readonly targetType: 'workflow' | 'runtime';
  readonly targetId: string;
  readonly targetLabel: string;
  readonly expectedRevision: number;
  readonly capability: CapabilityDescriptor | null;
  readonly interruptionNote: string;
}

export interface BoostStudioViewModel {
  readonly eligibility: BoostEligibilityBannerModel;
  readonly boostWorkflows: readonly NativeWorkflow[];
  readonly activeWorkflow: NativeWorkflow | null;
  /** Strictly `null` when native runtime provided no Boost phase fields (NEVER hardcoded or inferred). */
  readonly phases: readonly BoostObservedPhaseView[] | null;
  readonly originActivity: Activity | null;
  readonly relatedActivities: readonly Activity[];
  readonly relatedWork: readonly NativeWork[];
  readonly relatedAgents: readonly AgentIdentity[];
  readonly relatedApprovals: readonly ApprovalRequest[];
  readonly stopTarget: BoostStopTargetModel | null;
  readonly workflowEvidence: EvidenceDto | null;
  readonly workflowReasonCode?: string;
}

export interface BoostWorkflowResourceBundle {
  readonly workflowId: WorkflowId;
  readonly logs: readonly BoostVerificationClueView[];
  readonly logsUnavailableReason?: string;
  readonly artifacts: readonly BoostArtifactRefView[];
  readonly artifactsUnavailableReason?: string;
  readonly phaseSummariesById: Readonly<Record<string, string>>;
  readonly loading: boolean;
}
