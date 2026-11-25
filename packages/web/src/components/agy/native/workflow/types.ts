import type {
  ActivityId,
  CapabilityDescriptor,
  EvidenceDto,
  NativeAgentId,
  NativeRequestReceiptState,
  NativeStage,
  NativeWork,
  NativeWorkflow,
  Observed,
  RuntimeBinding,
  WorkId,
  WorkState,
  WorkflowId,
} from '../../../../lib/native-client';
import type { NativeWorkbenchViewProps } from '../shared';
import type {
  NativeRequestDisplayMeta,
  ResolveNativeRequestHandler,
} from '../requests/types';

export const DYNAMIC_WORKFLOW_STUDIO_CONTRACT_REVISION = '1.0-np11' as const;

export type DynamicScriptApprovalDisplayState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'unknown';

export interface DynamicScriptPreviewData {
  readonly artifactId: string;
  readonly approvalState: DynamicScriptApprovalDisplayState;
  readonly approvalId?: string;
  readonly language?: 'python' | 'text';
  readonly previewLines: readonly string[];
  readonly totalLines?: number;
  readonly truncated: boolean;
  readonly nextPageToken: string | null;
  readonly sourceScopeNote?: string;
  readonly rawPathRedacted?: boolean;
  readonly provenance?: EvidenceDto;
}

export interface DynamicResultPreviewData {
  readonly artifactId: string;
  readonly title?: string;
  readonly format: 'json_object' | 'json_array' | 'scalar' | 'unparsed_text';
  readonly totalItems?: number;
  readonly topLevelKeys?: readonly string[];
  readonly previewText: string;
  readonly truncated: boolean;
  readonly nextPageToken?: string | null;
  readonly provenance?: EvidenceDto;
}

export interface DynamicWorkflowStudioProps extends NativeWorkbenchViewProps {
  readonly requestMetadataByApprovalId?: Readonly<Record<string, NativeRequestDisplayMeta>>;
  readonly scriptPreviewByWorkflowId?: Readonly<Record<string, DynamicScriptPreviewData>>;
  readonly resultPreviewByArtifactId?: Readonly<Record<string, DynamicResultPreviewData>>;
  readonly stepErrorByStepId?: Readonly<Record<string, string>>;
  readonly onResolveNativeRequest?: ResolveNativeRequestHandler;
  readonly onLoadMoreScriptPreview?: (
    workflowId: WorkflowId,
    artifactId: string,
    pageToken: string,
  ) => Promise<DynamicScriptPreviewData | null>;
}

export type DynamicWorkflowBannerPhase =
  | 'script_pending_approval'
  | 'script_denied'
  | 'running'
  | 'requires_action'
  | 'partial_results'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'unknown';

export interface DynamicWorkflowBannerModel {
  readonly phase: DynamicWorkflowBannerPhase;
  readonly headline: string;
  readonly detail: string;
  readonly tone: 'indigo' | 'emerald' | 'star' | 'rose' | 'clay' | 'muted';
  readonly isIncompleteWarning: boolean;
}

export interface DynamicDagEdge {
  readonly from: string;
  readonly to: string;
}

export interface DynamicDagLayer {
  readonly depth: number;
  readonly steps: readonly NativeStage[];
}

export type DynamicDagUnavailableReason =
  | 'no_steps_observed'
  | 'no_dependency_edges_observed'
  | 'cyclic_dependency_edges_detected';

export interface DynamicDagAnalysis {
  readonly hasVerifiedDag: boolean;
  readonly hasCycle: boolean;
  readonly unavailableReason?: DynamicDagUnavailableReason;
  readonly layers: readonly DynamicDagLayer[];
  readonly edges: readonly DynamicDagEdge[];
}

export interface DynamicSortableTimelineItem {
  readonly itemId: string;
  readonly sortSeq: number;
  readonly timestamp?: number;
  readonly kind: 'step' | 'work' | 'activity' | 'request' | 'log';
  readonly stepId?: string;
  readonly workId?: WorkId;
  readonly agentIds?: readonly NativeAgentId[];
  readonly activityId?: ActivityId;
  readonly title: string;
  readonly detail?: string;
  readonly observedState?: Observed<WorkState>;
  readonly receiptState?: NativeRequestReceiptState;
  readonly blocking?: NativeWork['blocking'];
  readonly evidence?: EvidenceDto;
}

export interface DynamicWorkflowResourceItemView {
  readonly id: string;
  readonly kind: 'log_entry' | 'artifact_ref' | 'phase';
  readonly title: string;
  readonly summary?: string;
  readonly level?: 'info' | 'warn' | 'error';
  readonly seq?: number;
  readonly artifactKind?: string;
  readonly truncated?: boolean;
  readonly createdAt?: number;
  readonly ownerAgentId?: NativeAgentId;
  readonly activityId?: ActivityId;
  readonly evidence?: EvidenceDto;
}

export interface DynamicWorkflowCapabilityContext {
  readonly binding?: RuntimeBinding;
  readonly capability?: CapabilityDescriptor | null;
}
