import type {
  ActivityId,
  NativeAgentId,
  NativeAlias,
  NativeWork,
  NativeWorkflow,
  Observed,
  PublicEvidenceDto,
  PublicObserved,
  RpcId,
  RuntimeBinding,
  WorkId,
  WorkOutcome,
  WorkState,
  WorkflowId,
} from '@harnessmate/protocol';
import type { NativeEventDraft, NativeCommitMutation } from '../../wiring/types.js';

export const DYNAMIC_WORKFLOW_OBSERVER_CONTRACT_REVISION =
  'agy-np11-dynamic-workflow-v1.0.0' as const;

export type DynamicWorkflowFieldProvenance =
  | 'acp_v1_standard'
  | 'observed_replay_1_5_14'
  | 'candidate_pending_live_t13';

export interface DynamicWorkflowWireFieldVersionEntry {
  readonly fieldPath: string;
  readonly minCliVersion: string;
  readonly maxCliVersion?: string;
  readonly provenance: DynamicWorkflowFieldProvenance;
  readonly evidenceRefs: readonly string[];
  readonly description: string;
  readonly fallbackWhenOmitted: string;
}

/**
 * Versioned field applicability matrix for AGY Dynamic Workflows (NP-11).
 * Explicitly separates standard ACP v1 / replayed shapes from candidate vendor fields
 * awaiting live authorized T13 Windows capture.
 */
export const DYNAMIC_WORKFLOW_WIRE_FIELD_VERSIONS: readonly DynamicWorkflowWireFieldVersionEntry[] =
  Object.freeze([
    {
      fieldPath: 'session/update (tool_call / tool_call_update)',
      minCliVersion: '1.5.14',
      provenance: 'acp_v1_standard',
      evidenceRefs: ['E02', 'E05', 'ACP-v1'],
      description:
        'Standard ACP v1 tool lifecycle updates carrying toolCallId, title, kind, status, rawInput, and rawOutput.',
      fallbackWhenOmitted: 'Preserve prior per-ID values on omitted patch fields; null status maps to unknown.',
    },
    {
      fieldPath: 'rawInput.Script / rawInput.ScriptPath / rawInput.Task',
      minCliVersion: '1.5.15',
      provenance: 'candidate_pending_live_t13',
      evidenceRefs: ['E01', 'antigravity.google/docs/dynamic-workflows'],
      description:
        'Candidate dynamic workflow trigger fields describing the generated Python script preview or task objective.',
      fallbackWhenOmitted:
        'ScriptPath is redacted and never read from disk; inline Script becomes read-only artifact preview only when supplied.',
    },
    {
      fieldPath: 'rawOutput.steps / rawOutput.phases / update.steps / stageId / after',
      minCliVersion: '1.5.15',
      provenance: 'candidate_pending_live_t13',
      evidenceRefs: ['E01', '08_Shared_Contracts.md#NativeStage'],
      description:
        'Structured phase/step records and explicit dependency edges (`after` / `dependsOn` / `upstreamStepIds`).',
      fallbackWhenOmitted:
        'When `after` is omitted or empty, DAG rendering is disabled (`hasVerifiedDag=false`) and Studio falls back to chronological timeline without parsing Python.',
    },
    {
      fieldPath: 'rawOutput.structuredOutput / rawOutput.result / rawOutput.exitCode / rawOutput.ok',
      minCliVersion: '1.5.15',
      provenance: 'acp_v1_standard',
      evidenceRefs: ['E05', '08_Shared_Contracts.md#L105'],
      description:
        'Explicit completion outcome and structured JSON outputs returned by workflow execution or individual nodes.',
      fallbackWhenOmitted:
        'Completed status without exitCode===0 or ok===true yields work state=finished with outcome=unknown.',
    },
    {
      fieldPath: 'session/prompt prolonged finite hold + background wake',
      minCliVersion: '1.5.15',
      provenance: 'acp_v1_standard',
      evidenceRefs: ['CLI-1.5.15', 'E08', 'T02'],
      description:
        'Prolonged finite prompt handling and post-settle continuation frames for multi-step workflow execution.',
      fallbackWhenOmitted:
        'Active blocking workflow steps hold activity retention until terminal status, cancellation, or transport close.',
    },
    {
      fieldPath: 'session/request_permission (toolCallId=interaction_* + _meta workflow/child hints)',
      minCliVersion: '1.5.16',
      provenance: 'candidate_pending_live_t13',
      evidenceRefs: ['CLI-1.5.16', 'E05#turn_ask_question'],
      description:
        'AGY 1.5.16 forwarded workflow/subagent permission forms & interaction_* questions delivered via the parent wire session.',
      fallbackWhenOmitted:
        'Preserves outer actualNativeSessionId and fixed native optionIds; unresolved hints strip scope-widening options.',
    },
  ]);

export type DynamicWorkflowLifecyclePhase =
  | 'triggered'
  | 'awaiting_script_approval'
  | 'script_denied'
  | 'running'
  | 'awaiting_step_action'
  | 'partial_results'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'unknown';

export type DynamicScriptApprovalState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'unknown';

export type DynamicStepExecutionMode = 'parallel' | 'serial' | 'unknown';

export interface DynamicStructuredOutputSummary {
  readonly artifactId?: string;
  readonly format: 'json_object' | 'json_array' | 'scalar' | 'unparsed_text';
  readonly totalItems?: number;
  readonly topLevelKeys?: readonly string[];
  readonly previewJson: string;
  readonly truncated: boolean;
  readonly provenance: PublicEvidenceDto;
}

export interface DynamicWorkflowScriptPreviewDto {
  readonly artifactId: string;
  readonly approvalState: DynamicScriptApprovalState;
  readonly approvalId?: string;
  readonly language: 'python' | 'text';
  readonly previewLines: readonly string[];
  readonly totalLines?: number;
  readonly truncated: boolean;
  readonly nextPageToken: string | null;
  readonly provenance: PublicEvidenceDto;
  readonly sourceScopeNote: string;
  readonly rawPathRedacted: boolean;
}

export interface DynamicWorkflowStepRecord {
  readonly id: string;
  readonly label: string;
  readonly state: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly after?: readonly string[];
  readonly executionMode: DynamicStepExecutionMode;
  readonly agentIds: readonly NativeAgentId[];
  readonly workIds: readonly WorkId[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly errorSummary?: string;
  readonly resultArtifactIds: readonly string[];
  readonly structuredOutput?: DynamicStructuredOutputSummary;
  readonly logCount: number;
}

export interface DynamicWorkflowStepViewDto {
  readonly id: string;
  readonly label: string;
  readonly state: PublicObserved<WorkState>;
  readonly outcome?: PublicObserved<WorkOutcome>;
  readonly after?: readonly string[];
  readonly executionMode: DynamicStepExecutionMode;
  readonly agentIds: readonly NativeAgentId[];
  readonly workIds: readonly WorkId[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly errorSummary?: string;
  readonly resultArtifactIds: readonly string[];
  readonly structuredOutput?: DynamicStructuredOutputSummary;
  readonly logCount: number;
}

export interface DynamicWorkflowLogEntry {
  readonly entryId: string;
  readonly seq: number;
  readonly stepId?: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly summary: string;
  readonly truncated: boolean;
  readonly createdAt: number;
  readonly provenance: PublicEvidenceDto;
  readonly scopeLabel: string;
}

export interface DynamicWorkflowArtifactRecord {
  readonly artifactId: string;
  readonly title: string;
  readonly artifactKind: 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown';
  readonly stepId?: string;
  readonly ownerAgentId?: NativeAgentId;
  readonly activityId?: ActivityId;
  readonly revision: number;
  readonly updatedAt: number;
  readonly approvedScope: boolean;
  readonly structuredSummary?: DynamicStructuredOutputSummary;
  readonly provenance: PublicEvidenceDto;
}

export interface DynamicWorkflowTimelineEntry {
  readonly entryId: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly kind: 'trigger' | 'approval' | 'step' | 'log' | 'artifact' | 'error' | 'status';
  readonly stepId?: string;
  readonly workId?: WorkId;
  readonly agentId?: NativeAgentId;
  readonly title: string;
  readonly detail?: string;
  readonly status?: WorkState;
  readonly provenance: PublicEvidenceDto;
}

export interface DynamicWorkflowObservedSnapshot {
  readonly contractRevision: typeof DYNAMIC_WORKFLOW_OBSERVER_CONTRACT_REVISION;
  readonly workflowId: WorkflowId;
  readonly binding: RuntimeBinding;
  readonly originActivityId: ActivityId;
  readonly turnId: string | null;
  readonly title: string;
  readonly objective?: string;
  readonly lifecyclePhase: DynamicWorkflowLifecyclePhase;
  readonly workflow: NativeWorkflow;
  readonly hasVerifiedDag: boolean;
  readonly dagUnavailableReason?: string;
  readonly scriptPreview?: DynamicWorkflowScriptPreviewDto;
  readonly steps: readonly DynamicWorkflowStepViewDto[];
  readonly resultSummaries: readonly DynamicStructuredOutputSummary[];
  readonly artifacts: readonly DynamicWorkflowArtifactRecord[];
  readonly timeline: readonly DynamicWorkflowTimelineEntry[];
  readonly totalLogCount: number;
  readonly droppedLogCount: number;
  readonly activeRequestIds: readonly string[];
  readonly revision: number;
  readonly updatedAt: number;
}

export interface DynamicWorkflowCommitBatch {
  readonly workflows: readonly NativeWorkflow[];
  readonly work: readonly NativeWork[];
  readonly aliases: readonly {
    readonly targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
    readonly targetEntityId: string;
    readonly alias: NativeAlias;
  }[];
  readonly eventDrafts: readonly NativeEventDraft[];
  readonly mutationKeyBase: string;
}

export interface DynamicWorkflowIngestResult {
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly ignoredDisabled: boolean;
  readonly workflowIds: readonly WorkflowId[];
  readonly workIds: readonly WorkId[];
  readonly pendingRequestHint?: {
    readonly wireRequestId: RpcId;
    readonly method: string;
    readonly actualNativeSessionId: string;
    readonly workflowId: WorkflowId;
    readonly stepId?: string;
    readonly toolCallId?: string;
    readonly isInteractionQuestion: boolean;
  };
  readonly commits: DynamicWorkflowCommitBatch;
}

export interface DecodedDynamicStepPatch {
  readonly id: string;
  readonly label?: string;
  readonly state?: WorkState;
  readonly stateReasonCode?: string;
  readonly outcome?: WorkOutcome;
  readonly outcomeReasonCode?: string;
  readonly after?: readonly string[];
  readonly executionMode?: DynamicStepExecutionMode;
  readonly errorSummary?: string;
  readonly resultArtifactId?: string;
  readonly structuredPayload?: unknown;
  readonly logText?: string;
  readonly logLevel?: 'info' | 'warn' | 'error';
  readonly logTruncated?: boolean;
}

export type DecodedDynamicWorkflowFrame =
  | {
      readonly kind: 'not_dynamic_workflow';
      readonly reasonCode: string;
    }
  | {
      readonly kind: 'dynamic_tool_patch';
      readonly updateKind: 'tool_call' | 'tool_call_update';
      readonly toolCallId: string;
      readonly workflowNativeId: string;
      readonly title?: string;
      readonly objective?: string;
      readonly scriptText?: string;
      readonly scriptPathRedacted: boolean;
      readonly stepId?: string;
      readonly workflowState?: WorkState;
      readonly workflowStateReasonCode?: string;
      readonly workflowOutcome?: WorkOutcome;
      readonly workflowOutcomeReasonCode?: string;
      readonly blocking: 'confirmed_blocking' | 'detached' | 'unknown';
      readonly steps: readonly DecodedDynamicStepPatch[];
      readonly structuredOutputPayload?: unknown;
      readonly resultArtifactId?: string;
      readonly logText?: string;
      readonly logLevel: 'info' | 'warn' | 'error';
      readonly logTruncated: boolean;
      readonly childSessionHint?: string;
      readonly unknownFields: readonly string[];
      readonly matchedRuleIds: readonly string[];
    }
  | {
      readonly kind: 'dynamic_workflow_request';
      readonly wireRequestId: RpcId;
      readonly rpcIdType: 'number' | 'string';
      readonly method: string;
      readonly actualNativeSessionId: string;
      readonly toolCallId?: string;
      readonly workflowNativeId?: string;
      readonly stepId?: string;
      readonly childSessionHint?: string;
      readonly isScriptApproval: boolean;
      readonly isInteractionQuestion: boolean;
      readonly summary: string;
      readonly scriptText?: string;
      readonly scriptPathRedacted: boolean;
      readonly optionIds: readonly string[];
    };

export type DynamicWorkflowRegistryCommitSpec = {
  readonly mutation: NativeCommitMutation;
  readonly eventDraft: NativeEventDraft;
};
