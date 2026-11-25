import type {
  ActivityId,
  BindingGeneration,
  CapabilityDescriptor,
  NativeWork,
  NativeWorkKind,
  NativeWorkflow,
  Observed,
  WorkId,
  WorkOutcome,
  WorkState,
  WorkflowId,
} from '../../../../lib/native-client';
import type { NativeWorkbenchViewProps } from '../shared';

export type TaskCategoryFilter =
  | 'all'
  | 'goal'
  | 'schedule'
  | 'finite_command'
  | 'daemon'
  | 'workflow_step'
  | 'subagent'
  | 'unknown';

export type ScheduleKindView = 'one_shot' | 'cron' | 'unknown';
export type ScheduleNextAtSourceView = 'native_wire_timestamp' | 'native_snapshot' | 'not_exposed';
export type OccurrenceRecoveryStateView =
  | 'live'
  | 'reconciling'
  | 'preserved_read_only'
  | 'stale_unconfirmed';

export interface GoalVerificationViewMeta {
  readonly id: string;
  readonly label: string;
  readonly state: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly artifactId?: string;
  readonly summary?: string;
}

export interface GoalViewMeta {
  readonly workflowId: WorkflowId;
  readonly lifecyclePhase?: string;
  readonly replacedGoalId?: WorkflowId;
  readonly supersededByGoalId?: WorkflowId;
  readonly verifications?: readonly GoalVerificationViewMeta[];
  readonly stopState?: 'none' | 'requested' | 'confirmed' | 'unconfirmed_unknown';
}

export interface ScheduleOccurrenceViewMeta {
  readonly workId: WorkId;
  readonly occurrenceIndex?: number;
  readonly nativeOccurrenceId?: string;
  readonly plannedAt?: Observed<number>;
  readonly actualTriggeredAt?: Observed<number>;
  readonly timezone?: Observed<string>;
  readonly wakeActivityIds?: readonly ActivityId[];
  readonly originSource?: 'live_protocol' | 'native_snapshot' | 'replay';
  readonly originGeneration?: BindingGeneration;
  readonly recoveryState?: OccurrenceRecoveryStateView;
  readonly summary?: string;
}

export interface ScheduleViewMeta {
  readonly workflowId: WorkflowId;
  readonly scheduleKind?: ScheduleKindView;
  readonly cronExpression?: string;
  readonly durationSeconds?: number;
  readonly timerCondition?: string;
  readonly timezone?: Observed<string>;
  readonly nextAtSource?: ScheduleNextAtSourceView;
  readonly lifecyclePhase?: string;
  readonly occurrences?: readonly ScheduleOccurrenceViewMeta[];
}

export interface FormattedNativeTime {
  readonly text: string;
  readonly timezoneLabel: string;
  readonly timezoneKnown: boolean;
  readonly nextAtKnown: boolean;
  readonly isStale: boolean;
}

export interface GoalCardModel {
  readonly workflow: NativeWorkflow;
  readonly objective: string;
  readonly verificationArtifactIds: readonly string[];
  readonly meta?: GoalViewMeta;
}

export interface ScheduleOccurrenceCardModel {
  readonly workId: WorkId;
  readonly work: NativeWork | null;
  readonly occurrenceIndex: number;
  readonly state: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly plannedAt?: Observed<number>;
  readonly actualTriggeredAt?: Observed<number>;
  readonly timezone?: Observed<string>;
  readonly wakeActivityIds: readonly ActivityId[];
  readonly latestWakeActivityId: ActivityId | null;
  readonly hasObservedWake: boolean;
  readonly recoveryState: OccurrenceRecoveryStateView;
  readonly originSource: string;
  readonly summary?: string;
}

export interface ScheduleCardModel {
  readonly workflow: NativeWorkflow;
  readonly scheduleLabel: string;
  readonly scheduleKind: ScheduleKindView;
  readonly cronExpression?: string;
  readonly durationSeconds?: number;
  readonly timerCondition?: string;
  readonly timezone?: Observed<string>;
  readonly nextAt?: Observed<number>;
  readonly nextAtSource: ScheduleNextAtSourceView;
  readonly formattedNextAt: FormattedNativeTime;
  readonly occurrences: readonly ScheduleOccurrenceCardModel[];
}

export interface CategorizedTaskItem {
  readonly id: string;
  readonly category: Exclude<TaskCategoryFilter, 'all'>;
  readonly kindLabel: string;
  readonly title: string;
  readonly blocking: NativeWork['blocking'];
  readonly state: Observed<WorkState>;
  readonly outcome?: Observed<WorkOutcome>;
  readonly workId?: WorkId;
  readonly workflowId?: WorkflowId;
  readonly originActivityId?: ActivityId;
  readonly kind: NativeWorkKind | 'goal' | 'schedule';
}

export interface NativeTasksViewProps extends NativeWorkbenchViewProps {
  readonly goalMetaByWorkflowId?: Readonly<Record<string, GoalViewMeta>>;
  readonly scheduleMetaByWorkflowId?: Readonly<Record<string, ScheduleViewMeta>>;
  readonly readOnlyDisabledMode?: boolean;
  readonly onJumpToActivity?: (activityId: ActivityId) => void;
  readonly capabilities: readonly CapabilityDescriptor[];
}
