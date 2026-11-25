import type {
  ActivityId,
  BindingGeneration,
  Evidence,
  NativeAlias,
  NativeWork,
  NativeWorkKind,
  NativeWorkflow,
  Observed,
  PublicEvidenceDto,
  PublicObserved,
  RuntimeBinding,
  WorkId,
  WorkOutcome,
  WorkState,
  WorkflowId,
} from '@harnessmate/protocol';
import type { NativeCommitMutation, NativeEventDraft } from '../../wiring/types.js';

export const TASKS_WORKFLOW_CONTRACT_REVISION = 'agy-np12-tasks-v1.0.0' as const;

export interface TasksWireFieldVersionEntry {
  readonly wirePath: string;
  readonly minCliVersion: string;
  readonly evidenceClass: 'acp_v1_standard' | 'candidate_pending_live_t09' | 'official_docs_only';
  readonly evidenceRefs: readonly string[];
  readonly fallbackBehavior: string;
}

/**
 * Domain-scoped versioned wire field matrix for Goal, Schedule & Native Tasks.
 * Wall-clock semantics live exclusively in this domain (shared attributes remain untouched).
 */
export const TASKS_WIRE_FIELD_VERSIONS: readonly TasksWireFieldVersionEntry[] = Object.freeze([
  {
    wirePath: 'session/update (tool_call / tool_call_update: toolCallId, title, status, rawInput, rawOutput)',
    minCliVersion: '1.5.14',
    evidenceClass: 'acp_v1_standard',
    evidenceRefs: ['E02', 'E05'],
    fallbackBehavior: 'Omitted patch fields preserve prior entity state; status=null maps to unknown.',
  },
  {
    wirePath: 'schedule tool inputs (DurationSeconds, CronExpression, Prompt, IsDaemon, TimerCondition, MaxIterations, ExactTiming)',
    minCliVersion: '1.5.14',
    evidenceClass: 'acp_v1_standard',
    evidenceRefs: ['E05', 'S06', 'official:/schedule'],
    fallbackBehavior: 'Classifies one_shot vs cron strictly from observed fields; unknown when neither is present.',
  },
  {
    wirePath: 'schedule authoritative timing (nextAt / nextRunAt / fireAt / scheduledAt, timezone / timeZone / tz)',
    minCliVersion: '1.5.16',
    evidenceClass: 'candidate_pending_live_t09',
    evidenceRefs: ['E05', '08_Shared_Contracts'],
    fallbackBehavior: 'NEVER guessed locally from Date.now() or cron parsing; missing values stay Observed unknown.',
  },
  {
    wirePath: 'goal updates (objective, verificationArtifactIds, replacesGoalId / supersedes, status, rawOutput)',
    minCliVersion: '1.5.14',
    evidenceClass: 'acp_v1_standard',
    evidenceRefs: ['E05', 'S12', 'official:/goal'],
    fallbackBehavior: 'Host paths in verificationArtifactIds are rejected; missing outcome keeps outcome unknown.',
  },
  {
    wirePath: 'manage_task / early cancel (Action: "kill", TaskId, timer_condition_cancelled)',
    minCliVersion: '1.5.16',
    evidenceClass: 'candidate_pending_live_t09',
    evidenceRefs: ['official:/schedule', 'T09-synthetic'],
    fallbackBehavior: 'Early cancel transitions schedule/occurrence to cancelled while preserving read-only history.',
  },
  {
    wirePath: 'post-turn wake continuation (turnId: null, origin: native_task | native_continuation, distinct ActivityId)',
    minCliVersion: '1.5.15',
    evidenceClass: 'acp_v1_standard',
    evidenceRefs: ['CLI-1.5.15', 'E08', 'T02', 'T09-synthetic'],
    fallbackBehavior: 'Creates a new Activity linked to occurrence WorkId without reopening the ended user turn.',
  },
]);

export interface TasksProtocolExposureAssessment {
  readonly contractRevision: typeof TASKS_WORKFLOW_CONTRACT_REVISION;
  readonly structuredListRpcExposed: false;
  readonly directTaskKillRpcExposed: false;
  readonly directSendInputRpcExposed: false;
  readonly rootSessionCancelAvailableViaAcp: true;
  readonly observedSources: readonly ['live_acp_tool_stream', 'runtime_work_projection'];
  readonly officialEntryHint: string;
  readonly officialDocUrl: string;
  readonly evidenceRefs: readonly string[];
}

export const TASKS_PROTOCOL_EXPOSURE_ASSESSMENT: TasksProtocolExposureAssessment = Object.freeze({
  contractRevision: TASKS_WORKFLOW_CONTRACT_REVISION,
  structuredListRpcExposed: false,
  directTaskKillRpcExposed: false,
  directSendInputRpcExposed: false,
  rootSessionCancelAvailableViaAcp: true,
  observedSources: ['live_acp_tool_stream', 'runtime_work_projection'] as const,
  officialEntryHint: '官方 CLI /tasks 或 Ctrl+T',
  officialDocUrl: 'https://antigravity.google/docs/cli/reference/',
  evidenceRefs: ['E01', 'E02', 'E05', 'E06'],
});

export interface AppAutomationsClosureRecord {
  readonly contractRevision: typeof TASKS_WORKFLOW_CONTRACT_REVISION;
  readonly capabilityIds: readonly ['AGY-W12', 'AGY-E08'];
  readonly surface: 'desktop';
  readonly acpEmulationAllowed: false;
  readonly hmSchedulerAllowed: false;
  readonly rebindExistingUserTasksAllowed: false;
  readonly officialEntry: string;
  readonly officialDocUrls: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly summary: string;
}

export const APP_AUTOMATIONS_CLOSURE_RECORD: AppAutomationsClosureRecord = Object.freeze({
  contractRevision: TASKS_WORKFLOW_CONTRACT_REVISION,
  capabilityIds: ['AGY-W12', 'AGY-E08'] as const,
  surface: 'desktop',
  acpEmulationAllowed: false,
  hmSchedulerAllowed: false,
  rebindExistingUserTasksAllowed: false,
  officialEntry: '官方 Antigravity App /automation · Automations tab',
  officialDocUrls: [
    'https://antigravity.google/docs/commands/automation/',
    'https://antigravity.google/docs/sidecars/',
  ],
  evidenceRefs: ['E01', '03_Official_Research', '02_Capability_Matrix'],
  summary:
    'App Automations (/automation) 与 Sidecars (agentapi) 属官方桌面 App 持久能力；HarnessMate 不将其仿成 ACP，不建 HM 调度器，也不重绑用户现有计划任务。',
});

// ── Goal Domain Types ──────────────────────────────────────────────────

export type GoalLifecyclePhase =
  | 'launched'
  | 'running'
  | 'verifying'
  | 'waiting_action'
  | 'superseded'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'unknown';

export interface GoalStopState {
  readonly state: 'none' | 'requested' | 'confirmed' | 'unconfirmed_unknown';
  readonly requestedAt?: number;
  readonly confirmedAt?: number;
  readonly reasonCode?: string;
  readonly supportedInterruptPath: 'root_session_cancel' | 'official_cli_only';
  readonly evidence?: PublicEvidenceDto;
}

export interface GoalVerificationRecord {
  readonly id: string;
  readonly label: string;
  readonly state: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly artifactId?: string;
  readonly summary?: string;
  readonly evidence: Evidence;
  readonly observedAt: number;
}

export interface GoalVerificationDto {
  readonly id: string;
  readonly label: string;
  readonly state: PublicObserved<WorkState>;
  readonly outcome?: PublicObserved<WorkOutcome>;
  readonly artifactId?: string;
  readonly summary?: string;
  readonly evidence: PublicEvidenceDto;
  readonly observedAt: number;
}

export interface GoalObservedSnapshotDto {
  readonly contractRevision: typeof TASKS_WORKFLOW_CONTRACT_REVISION;
  readonly workflowId: WorkflowId;
  readonly binding: RuntimeBinding;
  readonly originActivityId: ActivityId;
  readonly turnId: string | null;
  readonly objective?: string;
  readonly lifecyclePhase: GoalLifecyclePhase;
  readonly state: PublicObserved<WorkState>;
  readonly outcome?: PublicObserved<WorkOutcome>;
  readonly replacedGoalId?: WorkflowId;
  readonly supersededByGoalId?: WorkflowId;
  readonly verificationArtifactIds: readonly string[];
  readonly verifications: readonly GoalVerificationDto[];
  readonly stop: GoalStopState;
  readonly relatedWorkIds: readonly WorkId[];
  readonly relatedActivityIds: readonly ActivityId[];
  readonly revision: number;
  readonly updatedAt: number;
}

// ── Schedule & Occurrence Domain Types ─────────────────────────────────

export type ScheduleKind = 'one_shot' | 'cron' | 'unknown';

export type ScheduleLifecyclePhase =
  | 'created'
  | 'scheduled'
  | 'triggered'
  | 'cancelled'
  | 'expired'
  | 'finished'
  | 'failed'
  | 'stale'
  | 'unknown';

export type ScheduleNextAtSource = 'native_wire_timestamp' | 'native_snapshot' | 'not_exposed';

export type OccurrenceRecoveryState =
  | 'live'
  | 'reconciling'
  | 'preserved_read_only'
  | 'stale_unconfirmed';

export interface ScheduleOccurrenceRecord {
  readonly workId: WorkId;
  readonly scheduleWorkflowId: WorkflowId;
  readonly occurrenceIndex: number;
  readonly nativeOccurrenceId?: string;
  readonly wakeActivityIds: readonly ActivityId[];
  readonly latestWakeActivityId?: ActivityId;
  readonly hasObservedWake: boolean;
  readonly plannedAt?: Observed<number>;
  readonly actualTriggeredAt?: Observed<number>;
  readonly settledAt?: number;
  readonly timezone: Observed<string>;
  readonly state: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly originSource: 'live_protocol' | 'native_snapshot' | 'replay';
  readonly originGeneration: BindingGeneration;
  readonly recoveryState: OccurrenceRecoveryState;
  readonly summary?: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface ScheduleOccurrenceDto {
  readonly workId: WorkId;
  readonly scheduleWorkflowId: WorkflowId;
  readonly occurrenceIndex: number;
  readonly nativeOccurrenceId?: string;
  readonly wakeActivityIds: readonly ActivityId[];
  readonly latestWakeActivityId?: ActivityId;
  readonly hasObservedWake: boolean;
  readonly plannedAt?: PublicObserved<number>;
  readonly actualTriggeredAt?: PublicObserved<number>;
  readonly settledAt?: number;
  readonly timezone: PublicObserved<string>;
  readonly state: PublicObserved<WorkState>;
  readonly outcome?: PublicObserved<WorkOutcome>;
  readonly originSource: 'live_protocol' | 'native_snapshot' | 'replay';
  readonly originGeneration: BindingGeneration;
  readonly recoveryState: OccurrenceRecoveryState;
  readonly summary?: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface ScheduleStopState {
  readonly state: 'none' | 'requested' | 'confirmed' | 'unconfirmed_unknown';
  readonly requestedAt?: number;
  readonly confirmedAt?: number;
  readonly reasonCode?: string;
  readonly supportedControlNote: string;
  readonly evidence?: PublicEvidenceDto;
}

export interface ScheduleObservedSnapshotDto {
  readonly contractRevision: typeof TASKS_WORKFLOW_CONTRACT_REVISION;
  readonly workflowId: WorkflowId;
  readonly binding: RuntimeBinding;
  readonly originActivityId: ActivityId;
  readonly turnId: string | null;
  readonly scheduleKind: ScheduleKind;
  readonly scheduleLabel?: string;
  readonly cronExpression?: string;
  readonly durationSeconds?: number;
  readonly timerCondition?: string;
  readonly maxIterations?: number;
  readonly exactTiming?: boolean;
  readonly isDaemon?: boolean;
  readonly timezone: PublicObserved<string>;
  readonly nextAt: PublicObserved<number>;
  readonly nextAtSource: ScheduleNextAtSource;
  readonly state: PublicObserved<WorkState>;
  readonly outcome?: PublicObserved<WorkOutcome>;
  readonly lifecyclePhase: ScheduleLifecyclePhase;
  readonly stop: ScheduleStopState;
  readonly occurrences: readonly ScheduleOccurrenceDto[];
  readonly occurrenceWorkIds: readonly WorkId[];
  readonly blocksUserTurn: false;
  readonly deletePolicyNote: string;
  readonly revision: number;
  readonly updatedAt: number;
}

// ── Aggregated Runtime Center / Native Tasks Snapshot ──────────────────

export type NativeTaskCategory =
  | 'goal'
  | 'schedule'
  | 'finite_command'
  | 'daemon'
  | 'workflow_step'
  | 'subagent'
  | 'unknown';

export interface NativeTaskSummaryDto {
  readonly id: string;
  readonly entityKind: 'workflow' | 'work';
  readonly category: NativeTaskCategory;
  readonly label: string;
  readonly blocking: 'confirmed_blocking' | 'detached' | 'unknown';
  readonly state: PublicObserved<WorkState>;
  readonly outcome?: PublicObserved<WorkOutcome>;
  readonly workflowId?: WorkflowId;
  readonly workId?: WorkId;
  readonly originActivityId?: ActivityId;
  readonly updatedAt: number;
}

export interface NativeTasksCenterSnapshotDto {
  readonly contractRevision: typeof TASKS_WORKFLOW_CONTRACT_REVISION;
  readonly binding: RuntimeBinding;
  readonly enabled: boolean;
  readonly readOnlyMode: boolean;
  readonly goals: readonly GoalObservedSnapshotDto[];
  readonly schedules: readonly ScheduleObservedSnapshotDto[];
  readonly works: readonly NativeWork[];
  readonly tasks: readonly NativeTaskSummaryDto[];
  readonly countsByCategory: Readonly<Record<NativeTaskCategory, number>>;
  readonly leaseReasons: readonly string[];
  readonly protocolExposure: TasksProtocolExposureAssessment;
  readonly appAutomationsClosure: AppAutomationsClosureRecord;
}

// ── Diagnostics & Commit Batches ───────────────────────────────────────

export type TasksDiagnosticCode =
  | 'stale_generation_rejected'
  | 'wrong_connection_rejected'
  | 'history_replay_isolated'
  | 'duplicate_frame_ignored'
  | 'observer_disabled_read_only'
  | 'unapproved_artifact_rejected'
  | 'invalid_timezone_ignored'
  | 'app_only_automation_closed'
  | 'cross_scope_recovery_blocked'
  | 'stop_confirmed'
  | 'stop_unconfirmed';

export interface TasksObserverDiagnostic {
  readonly code: TasksDiagnosticCode;
  readonly observedAt: number;
  readonly runtimeId: string;
  readonly generation: string;
  readonly detail: string;
}

export interface TasksCommitBatch {
  readonly mutation: NativeCommitMutation;
  readonly eventDrafts: readonly NativeEventDraft[];
  readonly aliases: readonly {
    readonly targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
    readonly targetEntityId: string;
    readonly alias: NativeAlias;
  }[];
  readonly workflows: readonly NativeWorkflow[];
}

export interface TasksIngestResult {
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly workflowId?: WorkflowId;
  readonly workId?: WorkId;
  readonly wakeActivityId?: ActivityId;
  readonly commits: readonly TasksCommitBatch[];
  readonly diagnostic?: TasksObserverDiagnostic;
}

export type TasksWorkKindCompat = NativeWorkKind;
