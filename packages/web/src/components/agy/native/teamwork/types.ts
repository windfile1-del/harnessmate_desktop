import type {
  ActivityId,
  AgentForeground,
  AgentLineage,
  EvidenceDto,
  NativeAgentId,
  NativeRequestReceiptState,
  Observed,
} from '../../../../lib/native-client';
import type { NativeWorkbenchViewProps } from '../shared';

export type TeamworkRoleKind =
  | 'sentinel'
  | 'project_orchestrator'
  | 'milestone_worker'
  | 'auditor'
  | 'unknown_role';

export type TeamworkApprovalGateState =
  | 'not_reached'
  | 'awaiting_native_approval'
  | 'upstream_limited_manual_app'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'connection_lost'
  | 'delivery_unknown';

export type TeamworkScopeRelationship =
  | 'distinct_from_hm_workspace'
  | 'within_authorized_root'
  | 'unverified';

export type TeamworkPathAccessGate =
  | 'authorized_read_only'
  | 'requires_explicit_authorization'
  | 'unavailable';

/**
 * Frozen NP-14 Artifact Review & Native Approval control props.
 * During G3 parallel development, defaults keep native approval disabled and
 * honestly guide the user to official Antigravity App / CLI without natural-language forgery.
 */
export interface TeamworkReviewControlProps {
  /** Independent gate for review/approval controls; false preserves read-only history. */
  readonly reviewControlEnabled?: boolean;
  /** True ONLY when NP-14 verifies native ACP artifact approval protocol support. */
  readonly canApproveViaNativeProtocol?: boolean;
  /** Reason code or explanation shown when native approval is disabled. */
  readonly disabledReason?: string;
  /** Safe read-only excerpt of the Prompt Artifact provided by NP-14 reader. */
  readonly promptArtifactTitle?: string;
  readonly promptArtifactPreview?: string;
  readonly promptArtifactRevision?: number;
  readonly officialFallbackHint?: string;
  readonly onNativeApprove?: (artifactId: string) => Promise<void>;
  readonly onNativeReject?: (artifactId: string) => Promise<void>;
}

export interface TeamworkProjectScopeView {
  readonly hmWorkspaceLabel: string;
  readonly hmWorkspaceId?: string;
  readonly nativeProjectCreated: boolean;
  readonly nativeProjectLabel?: string;
  readonly nativeProjectScopeId?: string;
  readonly scopeRelationship: TeamworkScopeRelationship;
  readonly pathAccessGate: TeamworkPathAccessGate;
  readonly pathOpenAuthorized: boolean;
  readonly authorizationReasonCode: string;
  readonly onOpenAuthorizedProjectPath?: () => void;
}

export interface TeamworkRoleView {
  readonly agentId: NativeAgentId;
  readonly roleKind: TeamworkRoleKind;
  readonly displayLabel: string;
  readonly lineage: AgentLineage;
  readonly foreground: Observed<AgentForeground>;
  readonly milestoneIds: readonly string[];
}

export interface TeamworkScopingItemView {
  readonly questionId: string;
  readonly approvalId?: string;
  readonly promptSummary: string;
  readonly receiptState: NativeRequestReceiptState;
  readonly selectedOptionLabel?: string;
  readonly occurrence: number;
  readonly duplicateDeliveriesIgnored?: number;
  readonly evidence?: EvidenceDto;
}

export interface TeamworkAuditEntryView {
  readonly auditId: string;
  readonly milestoneId?: string;
  readonly label: string;
  readonly verdict: 'pending' | 'passed' | 'changes_requested' | 'failed' | 'cancelled' | 'unknown';
  readonly auditorAgentId?: NativeAgentId;
  readonly artifactId?: string;
  readonly summary?: string;
  readonly evidence?: EvidenceDto;
}

export interface TeamworkArtifactItemView {
  readonly artifactId: string;
  readonly title: string;
  readonly artifactKind: 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown';
  readonly isPromptArtifact?: boolean;
  readonly ownerAgentId?: NativeAgentId;
  readonly activityId?: ActivityId;
  readonly revision: number;
  readonly updatedAt: number;
  readonly evidence?: EvidenceDto;
}

export interface TeamworkStudioProps extends NativeWorkbenchViewProps {
  /** Master Teamwork feature gate. When false, previously observed history stays strictly read-only. */
  readonly teamworkFeatureEnabled?: boolean;
  /** NP-14 Artifact Review control seam (defaults to safe read-only / disabled). */
  readonly reviewControl?: TeamworkReviewControlProps;
  /** Optional enriched scope metadata supplied by domain adapter/fixtures. */
  readonly projectScopeOverride?: TeamworkProjectScopeView;
  /** Optional enriched scoping Q&A items. */
  readonly scopingItemsOverride?: readonly TeamworkScopingItemView[];
  /** Optional enriched audit gate entries. */
  readonly auditEntriesOverride?: readonly TeamworkAuditEntryView[];
  /** Optional enriched artifacts list. */
  readonly artifactsOverride?: readonly TeamworkArtifactItemView[];
  /** Optional explicit gate state override (e.g. rejected/awaiting_native_approval). */
  readonly approvalGateOverride?: TeamworkApprovalGateState;
  /** Optional command discovery hint (`/teamwork` vs unadvertised vs legacy preview). */
  readonly commandDiscoveryState?:
    | 'not_observed'
    | 'advertised'
    | 'not_advertised'
    | 'legacy_preview_unverified';
}
