import type { EvidenceDto, GateState, NativeAgentId, NativeRuntimeStatus, WorkflowId } from '../../../../lib/native-client';

export type ArtifactOriginKind =
  | 'brain_session'
  | 'acp_plan'
  | 'acp_tool_diff'
  | 'teamwork_prompt'
  | 'dynamic_script'
  | 'dynamic_result'
  | 'browser_reference'
  | 'history_snapshot';

export type ArtifactContentKind = 'markdown' | 'diff' | 'json' | 'text' | 'script' | 'media_ref';

export type ArtifactVerifiedActionKey =
  | 'read_artifact'
  | 'read_plan'
  | 'read_diff'
  | 'read_browser_evidence'
  | 'submit_native_comment'
  | 'submit_native_approval'
  | 'submit_native_rejection';

export type ArtifactReviewWireSupportStatus =
  | 'unverified_pending_live_capture'
  | 'verified_live_wire'
  | 'unsupported';

export interface ArtifactWorkspaceFeatureGates {
  readonly nativeArtifactsEnabled: boolean;
  readonly reviewControlEnabled: boolean;
  readonly mediaArtifactsEnabled: boolean;
}

export interface ArtifactScopeSummaryView {
  readonly scopeKind: 'root' | 'confirmed_child' | 'confirmed_workflow' | 'unknown_child' | 'historical';
  readonly ownerAgentId?: NativeAgentId;
  readonly ownerLineage: 'confirmed' | 'unresolved' | 'conflicting';
  readonly workflowId?: WorkflowId;
  readonly isHistorical: boolean;
  readonly readOnly: boolean;
}

export interface ArtifactSecurityFlagsView {
  readonly secretsRedactedCount: number;
  readonly hostPathsRedactedCount: number;
  readonly htmlStrippedOrEscaped: boolean;
  readonly unsafeLinksBlockedCount: number;
  readonly binaryRejected: boolean;
  readonly redactionNotes: readonly string[];
}

export interface ArtifactSummaryView {
  readonly artifactId: string;
  readonly title: string;
  readonly originKind: ArtifactOriginKind;
  readonly contentKind: ArtifactContentKind;
  readonly revision: number;
  readonly sizeBytes: number;
  readonly updatedAt: number;
  readonly scope: ArtifactScopeSummaryView;
  readonly verifiedActionKeys: readonly ArtifactVerifiedActionKey[];
  readonly reviewWireSupport: ArtifactReviewWireSupportStatus;
  readonly pendingRequestId?: string;
  readonly provenance: EvidenceDto;
}

export interface ArtifactContentView {
  readonly artifactId: string;
  readonly title: string;
  readonly originKind: ArtifactOriginKind;
  readonly contentKind: ArtifactContentKind;
  readonly revision: number;
  readonly content: string;
  readonly totalChars: number;
  readonly lineCount: number;
  readonly nextPageToken: string | null;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly scope: ArtifactScopeSummaryView;
  readonly security: ArtifactSecurityFlagsView;
  readonly verifiedActionKeys: readonly ArtifactVerifiedActionKey[];
  readonly provenance: EvidenceDto;
}

export interface ArtifactLineCommentDraft {
  readonly artifactId: string;
  readonly line: number;
  readonly comment: string;
}

export interface ReviewCapabilityView {
  readonly canRead: boolean;
  readonly canComment: boolean;
  readonly canApproveViaNativeProtocol: boolean;
  readonly approveGate: GateState;
  readonly reasonCode: string;
  readonly officialFallbackHint: string;
}

export interface AgyPlanStepView {
  readonly id: string;
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly priority?: 'high' | 'medium' | 'low';
  readonly source: 'acp_agent_plan' | 'agy_update_steps';
}

export interface PlanSnapshotView {
  readonly planModeActive: boolean;
  readonly enforcement: 'native' | 'client_guard' | 'unknown';
  readonly steps: readonly AgyPlanStepView[];
  readonly revision: number;
  readonly isHistorical: boolean;
  readonly updatedAt: number;
  readonly provenance?: EvidenceDto;
}

export interface ToolDiffView {
  readonly diffId: string;
  readonly toolCallId: string;
  readonly relativeDisplayPath: string;
  readonly unifiedDiff: string;
  readonly truncated: boolean;
  readonly origin: 'acp_tool_diff';
  readonly ownerAgentId?: NativeAgentId;
  readonly ownerLineage: 'confirmed' | 'unresolved' | 'conflicting';
  readonly approvalId?: string;
  readonly approvalState:
    | 'not_requested'
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'expired'
    | 'unknown';
  readonly revision: number;
  readonly isHistorical: boolean;
  readonly updatedAt: number;
  readonly provenance: EvidenceDto;
}

export type BrowserRuntimeSurfaceKind =
  | 'app_embedded_browser'
  | 'cli_chrome_mcp'
  | 'enterprise_chrome_mcp'
  | 'unknown';

export interface BrowserAgentRoleView {
  readonly roleId: string;
  readonly agentId?: NativeAgentId;
  readonly lineage: 'confirmed' | 'unresolved' | 'conflicting';
  readonly label: string;
  readonly surface: BrowserRuntimeSurfaceKind;
  readonly state: string;
  readonly canControlBrowser: false;
  readonly provenance: EvidenceDto;
}

export interface BrowserLogEntryView {
  readonly seq: number;
  readonly timestamp: number;
  readonly surface: BrowserRuntimeSurfaceKind;
  readonly actionSummary: string;
  readonly redactedTargetHost?: string;
  readonly status: 'running' | 'completed' | 'failed' | 'blocked' | 'unknown';
  readonly provenance: EvidenceDto;
}

export interface BrowserMediaReferenceView {
  readonly mediaId: string;
  readonly label: string;
  readonly mediaKind: 'screenshot' | 'recording';
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/webm' | 'video/mp4';
  readonly sizeBytes: number;
  readonly magicVerified: boolean;
  readonly sha256Prefix: string;
  readonly gatedOff: boolean;
  readonly updatedAt: number;
  readonly provenance: EvidenceDto;
}

export interface BrowserObservationView {
  readonly surface: BrowserRuntimeSurfaceKind;
  readonly controlSupported: false;
  readonly surfaceReasonCode: string;
  readonly officialAppGuide: string;
  readonly roles: readonly BrowserAgentRoleView[];
  readonly logs: readonly BrowserLogEntryView[];
  readonly droppedLogCount: number;
  readonly mediaReferences: readonly BrowserMediaReferenceView[];
  readonly mediaGateEnabled: boolean;
  readonly isHistorical: boolean;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface AgyArtifactReviewWorkspaceProps {
  readonly runtimeStatus: NativeRuntimeStatus;
  readonly featureGates: ArtifactWorkspaceFeatureGates;
  readonly artifacts: readonly ArtifactSummaryView[];
  readonly selectedArtifactId?: string | null;
  readonly selectedContent?: ArtifactContentView | null;
  readonly reviewCapability?: ReviewCapabilityView | null;
  readonly planSnapshot?: PlanSnapshotView | null;
  readonly toolDiffs?: readonly ToolDiffView[];
  readonly browserObservation?: BrowserObservationView | null;
  readonly isNarrowViewport?: boolean;
  readonly onSelectArtifact?: (artifactId: string) => void;
  readonly onLoadMoreArtifact?: (artifactId: string, pageToken: string) => Promise<void>;
  readonly onRefresh?: () => void;
  readonly onSubmitLineComment?: (input: {
    artifactId: string;
    revision: number;
    requestId?: string;
    line: number;
    comment: string;
  }) => Promise<void>;
  readonly onSubmitApproval?: (input: {
    artifactId: string;
    revision: number;
    requestId?: string;
    decision: 'approve' | 'reject';
    comments: readonly ArtifactLineCommentDraft[];
  }) => Promise<void>;
  readonly onJumpToChildAgent?: (agentId: NativeAgentId) => void;
}
