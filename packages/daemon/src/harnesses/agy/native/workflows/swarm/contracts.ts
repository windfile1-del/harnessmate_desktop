import type {
  ActivityId,
  AgentForeground,
  AgentIdentity,
  AgentLineage,
  BindingGeneration,
  Evidence,
  NativeAgentId,
  NativeRequestReceiptState,
  NativeWorkflow,
  Observed,
  RuntimeBinding,
  RuntimeId,
  WorkId,
  WorkOutcome,
  WorkState,
  WorkflowId,
} from '@harnessmate/protocol';
import type { NativeCommitMutation, NativeEventDraft } from '../../wiring/types.js';

/**
 * Frozen contract revision for NP-08 Swarm Observer, Board Store & Studio projection.
 */
export const SWARM_OBSERVER_CONTRACT_REVISION = 'agy-np08-swarm-v1.0.0' as const;

export const SWARM_OFFICIAL_DOC_URL = 'https://antigravity.google/docs/swarm/' as const;
export const SWARM_OFFICIAL_CLI_LAUNCH_HINT = '官方 CLI /swarm <task>' as const;
export const SWARM_OFFICIAL_BOARD_HINT = '官方 CLI /swarm board · Alt+S' as const;

/**
 * Independent feature & rollback gates for NP-08 Swarm.
 *
 * Per NP-08-swarm.md rollback rules:
 * - Closing `swarmEnabled` or `boardFeedEnabled` disables structured Swarm/Board projection
 *   while preserving any already-captured read-only coordinator trace.
 * - `localBoardSnapshotEnabled` defaults to `false` and fails closed until an authorized
 *   Windows AGY capture verifies a stable local read-only Board schema.
 * - `liveLaunchEnabled` defaults to `false` until live `/swarm` trigger evidence is recorded.
 */
export interface SwarmObserverGateConfig {
  readonly swarmEnabled: boolean;
  readonly boardFeedEnabled: boolean;
  readonly localBoardSnapshotEnabled: boolean;
  readonly liveLaunchEnabled: boolean;
}

export const DEFAULT_SWARM_OBSERVER_GATES: Readonly<SwarmObserverGateConfig> = Object.freeze({
  swarmEnabled: false,
  boardFeedEnabled: false,
  localBoardSnapshotEnabled: false,
  liveLaunchEnabled: false,
});

export type SwarmMemberRole = 'coordinator' | 'worker' | 'verifier';

export type SwarmBoardAvailabilityValue = 'available' | 'upstream_limited';

export interface SwarmObserverLimits {
  readonly maxWorkflowsPerRuntime: number;
  readonly maxWorkersPerWorkflow: number;
  readonly maxBoardPostsPerWorkflow: number;
  readonly maxCoordinatorTraceEntries: number;
  readonly maxMentionsPerWorkflow: number;
  readonly maxDiagnostics: number;
}

export const DEFAULT_SWARM_OBSERVER_LIMITS: Readonly<SwarmObserverLimits> = Object.freeze({
  maxWorkflowsPerRuntime: 16,
  maxWorkersPerWorkflow: 64,
  maxBoardPostsPerWorkflow: 500,
  maxCoordinatorTraceEntries: 500,
  maxMentionsPerWorkflow: 250,
  maxDiagnostics: 200,
});

export interface SwarmObserverBindingConfig {
  readonly binding: RuntimeBinding;
  readonly rootNativeSessionId: string;
  readonly profileRef: string;
  readonly sourceRef: string;
  readonly connectionId?: string;
}

export interface SwarmLaunchReceiptInput {
  readonly binding: RuntimeBinding;
  readonly receiptId: string;
  readonly activityId: ActivityId;
  readonly turnId?: string | null;
  readonly objective: string;
  readonly observedAt?: number;
  readonly modeEvidenceObserved?: boolean;
}

export interface SwarmWorkerRecord {
  readonly agentId: NativeAgentId;
  readonly nativeWorkerId: string;
  readonly role: 'worker' | 'verifier';
  readonly rosterName: string;
  readonly modelHint?: string;
  readonly foreground: Observed<AgentForeground>;
  readonly workState: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly lineage: AgentLineage;
  readonly idleWakeCount: number;
  readonly lastMentionWakeAt?: number;
  readonly lastMentionPostId?: string;
  readonly linkedApprovalIds: readonly string[];
  readonly updatedAt: number;
  readonly evidence: Evidence;
}

export interface SwarmBoardPostRecord {
  readonly postId: string;
  readonly threadId?: string;
  readonly authorAgentId?: NativeAgentId;
  readonly authorLabel?: string;
  readonly summary: string;
  readonly truncated: boolean;
  readonly mentions: readonly string[];
  readonly isSystemWake: boolean;
  readonly createdAt: number;
  readonly ingressOrdinal: number;
  readonly evidence: Evidence;
}

export interface SwarmMentionObservation {
  readonly mentionId: string;
  readonly postId: string;
  readonly targetRosterName: string;
  readonly targetWorkerId?: NativeAgentId;
  readonly observedAt: number;
  readonly wakeObserved: boolean;
  readonly wakeObservedAt?: number;
  readonly evidence: Evidence;
}

export interface SwarmCoordinatorTraceEntry {
  readonly entryId: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly kind:
    | 'launch_receipt'
    | 'coordinator_update'
    | 'unverified_launch_tool'
    | 'worker_state'
    | 'mention_observed'
    | 'approval_linked'
    | 'board_status'
    | 'settled'
    | 'transport_closed';
  readonly summary: string;
  readonly truncated: boolean;
  readonly evidence: Evidence;
}

export interface SwarmLinkedApprovalRecord {
  readonly approvalId: string;
  readonly workerAgentId: NativeAgentId;
  readonly receiptState: NativeRequestReceiptState;
  readonly forwardedToParentSession: boolean;
  readonly provenanceReason: string;
  readonly linkedAt: number;
  readonly updatedAt: number;
}

export interface SwarmObserverDiagnostic {
  readonly code:
    | 'swarm_gate_disabled'
    | 'board_gate_disabled'
    | 'stale_generation_rejected'
    | 'cross_profile_rejected'
    | 'scope_mismatch_rejected'
    | 'unverified_worker_title_ignored'
    | 'unconfirmed_approval_not_linked'
    | 'duplicate_ingress_ignored'
    | 'history_replay_isolated'
    | 'board_snapshot_rejected'
    | 'board_snapshot_disabled'
    | 'worker_cap_exceeded'
    | 'board_post_trimmed'
    | 'trace_trimmed';
  readonly observedAt: number;
  readonly runtimeId: RuntimeId;
  readonly generation: BindingGeneration;
  readonly detail: string;
}

export interface SwarmWorkflowStateSnapshot {
  readonly workflow: NativeWorkflow;
  readonly binding: RuntimeBinding;
  readonly nativeWorkflowId?: string;
  readonly launchReceiptId?: string;
  readonly launchAdvertised: boolean | null;
  readonly coordinatorAgentId?: NativeAgentId;
  readonly workers: readonly SwarmWorkerRecord[];
  readonly mentions: readonly SwarmMentionObservation[];
  readonly linkedApprovals: readonly SwarmLinkedApprovalRecord[];
  readonly boardPostCount: number;
  readonly coordinatorTraceCount: number;
  readonly boardUnavailableReason?: string;
  readonly unverifiedLaunchToolCount: number;
  readonly updatedAt: number;
}

export interface SwarmFrameIngestionResult {
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly workflowId?: WorkflowId;
  readonly affectedAgentIds: readonly NativeAgentId[];
  readonly affectedWorkIds: readonly WorkId[];
  readonly coordinatorTraceAppended: boolean;
  readonly diagnostic?: SwarmObserverDiagnostic;
  readonly commits: readonly {
    readonly mutation: NativeCommitMutation;
    readonly eventDraft: NativeEventDraft;
  }[];
}

export interface SwarmBindingAuditSnapshot {
  readonly binding: RuntimeBinding;
  readonly profileRef: string;
  readonly sourceRef: string;
  readonly swarmAdvertised: boolean | null;
  readonly workflows: readonly SwarmWorkflowStateSnapshot[];
  readonly coordinatorTracesByWorkflow: ReadonlyMap<WorkflowId, readonly SwarmCoordinatorTraceEntry[]>;
  readonly diagnostics: readonly SwarmObserverDiagnostic[];
  readonly agents: readonly AgentIdentity[];
}

export interface SwarmBoardSnapshotReadInput {
  readonly snapshotRootPath: string;
  readonly candidateRelativeFile: string;
  readonly expectedNativeSessionId: string;
  readonly expectedWorkflowNativeId?: string;
  readonly expectedProfileRef: string;
  readonly gates: SwarmObserverGateConfig;
  /**
   * Explicitly allowlisted schema versions.
   * Production default is EMPTY (`[]`) so all unverified local Board formats fail closed
   * until an authorized live AGY capture proves a stable read-only schema.
   */
  readonly supportedSchemas?: readonly string[];
  readonly maxFileBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxPosts?: number;
  readonly staleTtlMs?: number;
  readonly nowMs?: number;
}

export interface SwarmBoardSnapshotReadResult {
  readonly available: boolean;
  readonly schemaVersion?: string;
  readonly reasonCode?: string;
  readonly posts: readonly SwarmBoardPostRecord[];
  readonly truncated: boolean;
}
