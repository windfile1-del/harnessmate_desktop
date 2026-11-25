import crypto from 'node:crypto';
import {
  ActivitySchema,
  NativeWorkSchema,
  NativeWorkflowResourceItemDtoSchema,
  NativeWorkflowSchema,
  asActivityId,
  asWorkId,
  asWorkflowId,
  sanitizeNativeWorkForPublic,
  sanitizeNativeWorkflowForPublic,
  sanitizeObservedForPublic,
  toPublicEvidenceDto,
  type Activity,
  type ActivityId,
  type BindingGeneration,
  type Evidence,
  type NativeAlias,
  type NativeWork,
  type NativeWorkflow,
  type NativeWorkflowResourceItemDto,
  type NativeWorkflowResourceKind,
  type Observed,
  type RuntimeBinding,
  type WorkId,
  type WorkOutcome,
  type WorkState,
  type WorkflowId,
} from '@harnessmate/protocol';
import type { AgyNativeRuntimeRegistry } from '../../wiring/registry.js';
import type {
  NativeCommitMutation,
  NativeEventDraft,
  NativeIngress,
  NativeWorkflowResourceReaderPort,
} from '../../wiring/types.js';
import { decodeTasksIngressFrame, type DecodedTasksFrame } from './codec.js';
import {
  FrozenTasksRecoveryEvidenceStub,
  isValidOpaqueArtifactId,
  type TasksRecoveryEvidencePort,
  type TasksRecoveryReconcileRequest,
  type TasksRecoveryReconcileResult,
} from './ports.js';
import {
  APP_AUTOMATIONS_CLOSURE_RECORD,
  TASKS_PROTOCOL_EXPOSURE_ASSESSMENT,
  TASKS_WORKFLOW_CONTRACT_REVISION,
  type GoalLifecyclePhase,
  type GoalObservedSnapshotDto,
  type GoalStopState,
  type GoalVerificationRecord,
  type NativeTaskCategory,
  type NativeTaskSummaryDto,
  type NativeTasksCenterSnapshotDto,
  type ScheduleKind,
  type ScheduleLifecyclePhase,
  type ScheduleNextAtSource,
  type ScheduleObservedSnapshotDto,
  type ScheduleOccurrenceDto,
  type ScheduleOccurrenceRecord,
  type ScheduleStopState,
  type TasksCommitBatch,
  type TasksIngestResult,
  type TasksObserverDiagnostic,
} from './types.js';

export interface TasksObserverLimits {
  readonly maxLogsPerWorkflow: number;
  readonly maxOccurrencesPerSchedule: number;
  readonly maxDiagnostics: number;
  readonly maxDedupeKeys: number;
}

export const DEFAULT_TASKS_OBSERVER_LIMITS: Readonly<TasksObserverLimits> = Object.freeze({
  maxLogsPerWorkflow: 400,
  maxOccurrencesPerSchedule: 200,
  maxDiagnostics: 200,
  maxDedupeKeys: 2048,
});

export interface GoalScheduleTasksObserverOptions {
  readonly enabled?: boolean;
  readonly strictMode?: boolean;
  readonly recoveryPort?: TasksRecoveryEvidencePort;
  readonly now?: () => number;
  readonly limits?: Partial<TasksObserverLimits>;
}

interface InternalLogEntry {
  readonly entryId: string;
  readonly seq: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly summary: string;
  readonly createdAt: number;
  readonly evidence: Evidence;
}

interface InternalGoalState {
  readonly workflowId: WorkflowId;
  readonly nativeGoalId: string;
  readonly binding: RuntimeBinding;
  readonly originActivityId: ActivityId;
  readonly turnId: string | null;
  objective?: string;
  state: Observed<WorkState>;
  outcome?: Observed<WorkOutcome>;
  lifecyclePhase: GoalLifecyclePhase;
  replacedGoalId?: WorkflowId;
  supersededByGoalId?: WorkflowId;
  readonly verificationArtifactIds: string[];
  readonly verifications: GoalVerificationRecord[];
  stop: GoalStopState;
  readonly relatedWorkIds: WorkId[];
  readonly relatedActivityIds: ActivityId[];
  readonly logs: InternalLogEntry[];
  logSeq: number;
  revision: number;
  updatedAt: number;
}

interface InternalScheduleState {
  readonly workflowId: WorkflowId;
  readonly nativeScheduleId: string;
  readonly binding: RuntimeBinding;
  readonly originActivityId: ActivityId;
  readonly turnId: string | null;
  scheduleKind: ScheduleKind;
  scheduleLabel?: string;
  cronExpression?: string;
  durationSeconds?: number;
  timerCondition?: string;
  maxIterations?: number;
  exactTiming?: boolean;
  isDaemon?: boolean;
  sessionBoundTimer: boolean;
  timezone: Observed<string>;
  nextAt: Observed<number>;
  nextAtSource: ScheduleNextAtSource;
  state: Observed<WorkState>;
  outcome?: Observed<WorkOutcome>;
  lifecyclePhase: ScheduleLifecyclePhase;
  stop: ScheduleStopState;
  readonly occurrenceOrder: WorkId[];
  readonly occurrencesByWorkId: Map<WorkId, ScheduleOccurrenceRecord>;
  readonly workIdByNativeOccurrenceKey: Map<string, WorkId>;
  lastTriggeredWorkId: WorkId | null;
  occurrenceCounter: number;
  readonly logs: InternalLogEntry[];
  logSeq: number;
  revision: number;
  updatedAt: number;
}

interface InternalBackgroundWorkState {
  work: NativeWork;
  toolCallId: string;
  backgroundTaskId?: string;
  updatedAt: number;
}

interface TasksScopeState {
  readonly binding: RuntimeBinding;
  connectionId: string | null;
  rootNativeSessionId: string;
  readonly goalsById: Map<WorkflowId, InternalGoalState>;
  readonly goalIdByNativeKey: Map<string, WorkflowId>;
  activeGoalId: WorkflowId | null;
  readonly schedulesById: Map<WorkflowId, InternalScheduleState>;
  readonly scheduleIdByNativeKey: Map<string, WorkflowId>;
  readonly worksById: Map<WorkId, InternalBackgroundWorkState>;
  readonly workIdByToolCallId: Map<string, WorkId>;
  readonly activitiesById: Map<ActivityId, Activity>;
  readonly endedTurnIds: Set<string>;
  readonly seenDedupeKeys: Set<string>;
  readonly seenDedupeQueue: string[];
  seqCounter: number;
}

function slotKey(binding: RuntimeBinding): string {
  return `${binding.runtimeId}::${binding.sessionId}::${binding.instanceId}::${binding.generation}`;
}

function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.sessionId === b.sessionId &&
    a.instanceId === b.instanceId &&
    a.generation === b.generation
  );
}

function isTerminalWorkState(state: WorkState): boolean {
  return state === 'finished' || state === 'failed' || state === 'cancelled';
}

function isActiveWorkState(state: WorkState): boolean {
  return state === 'queued' || state === 'running' || state === 'waiting' || state === 'requires_action';
}

function shortToken(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseOffset(token: string | undefined): number {
  if (!token) return 0;
  const n = Number.parseInt(token, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * NP-12 Goal, Schedule & Native Tasks Observer + Resource Reader.
 *
 * Guarantees:
 * - Never starts an HM scheduler or injects synthetic wake prompts.
 * - Strictly separates WorkId (finite/daemon/schedule occurrence) from wake ActivityId (`turnId: null`).
 * - Never locally computes `nextAt` or substitutes host OS/browser timezone for native timezone.
 * - App Automations (/automation) & Sidecars remain closed as App-only read-only evidence (`AGY-W12`/`AGY-E08`).
 * - Disabling the observer blocks live mutations while preserving expired/historical records read-only.
 */
export class GoalScheduleTasksObserver implements NativeWorkflowResourceReaderPort {
  private enabled: boolean;
  private readonly strictMode: boolean;
  private readonly recoveryPort: TasksRecoveryEvidencePort;
  private readonly now: () => number;
  private readonly limits: TasksObserverLimits;
  private readonly scopes = new Map<string, TasksScopeState>();
  private readonly diagnostics: TasksObserverDiagnostic[] = [];

  constructor(opts: GoalScheduleTasksObserverOptions = {}) {
    this.enabled = opts.enabled ?? false;
    this.strictMode = opts.strictMode ?? true;
    this.recoveryPort = opts.recoveryPort ?? new FrozenTasksRecoveryEvidenceStub();
    this.now = opts.now ?? (() => Date.now());
    this.limits = {
      ...DEFAULT_TASKS_OBSERVER_LIMITS,
      ...opts.limits,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getRecoveryPort(): TasksRecoveryEvidencePort {
    return this.recoveryPort;
  }

  getDiagnostics(): readonly TasksObserverDiagnostic[] {
    return [...this.diagnostics];
  }

  registerBinding(config: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly rootNativeSessionId: string;
  }): void {
    if (!config.connectionId || !config.rootNativeSessionId) return;

    // Retire prior generations of the same runtimeId before attaching the new binding.
    for (const prior of this.scopes.values()) {
      if (
        prior.binding.runtimeId === config.binding.runtimeId &&
        prior.connectionId &&
        !sameBinding(prior.binding, config.binding)
      ) {
        this.handleTransportClosed(prior.binding, prior.connectionId, 'generation_replaced');
      }
    }

    const key = slotKey(config.binding);
    const existing = this.scopes.get(key);
    if (existing) {
      if (existing.connectionId === config.connectionId) {
        existing.rootNativeSessionId = config.rootNativeSessionId;
        return;
      }
      if (existing.connectionId) {
        this.handleTransportClosed(existing.binding, existing.connectionId, 'connection_replaced');
      }
      existing.connectionId = config.connectionId;
      existing.rootNativeSessionId = config.rootNativeSessionId;
      return;
    }

    this.scopes.set(key, {
      binding: config.binding,
      connectionId: config.connectionId,
      rootNativeSessionId: config.rootNativeSessionId,
      goalsById: new Map(),
      goalIdByNativeKey: new Map(),
      activeGoalId: null,
      schedulesById: new Map(),
      scheduleIdByNativeKey: new Map(),
      worksById: new Map(),
      workIdByToolCallId: new Map(),
      activitiesById: new Map(),
      endedTurnIds: new Set(),
      seenDedupeKeys: new Set(),
      seenDedupeQueue: [],
      seqCounter: 0,
    });
  }

  onUserTurnEnded(binding: RuntimeBinding, turnId: string): void {
    const scope = this.scopes.get(slotKey(binding));
    if (!scope || !turnId) return;
    scope.endedTurnIds.add(turnId);
  }

  /**
   * Records an explicit user-confirmed `/goal <objective>` launch via live_workflow.
   * Supersedes any active prior Goal in the same binding while preserving its history.
   */
  recordConfirmedGoalLaunch(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly originActivityId: ActivityId;
    readonly turnId?: string | null;
    readonly objective: string;
    readonly nativeGoalId?: string;
    readonly workflowId?: WorkflowId;
    readonly ingressOrdinal?: number;
    readonly observedAt?: number;
  }): TasksIngestResult {
    const observedAt = input.observedAt ?? this.now();
    if (!this.enabled) {
      return this.rejectedDisabled(input.binding, observedAt);
    }
    const scope = this.getLiveScope(input.binding, input.connectionId);
    if (!scope) {
      return this.rejectedScope(input.binding, observedAt, 'wrong_connection_rejected');
    }

    const nativeGoalId = input.nativeGoalId?.trim() || `goal_${++scope.seqCounter}`;
    const workflowId = input.workflowId ?? asWorkflowId(`wf_goal_${shortToken(`${scope.binding.generation}:${nativeGoalId}`)}`);
    const dedupeKey = `goal_launch:${input.connectionId}:${workflowId}:${input.originActivityId}`;
    if (this.hasOrRecordDedupe(scope, dedupeKey)) {
      return { accepted: true, deduplicated: true, workflowId, commits: [] };
    }

    const evidence: Evidence = {
      kind: 'live_protocol',
      connectionId: input.connectionId,
      ingressOrdinal: input.ingressOrdinal ?? 0,
      wireVariant: 'goal_live_workflow_launch',
      observedAt,
    };

    const commits: TasksCommitBatch[] = [];
    const replacedGoalId = this.supersedeActiveGoalIfNeeded(scope, workflowId, evidence, observedAt, commits);

    const goal: InternalGoalState = {
      workflowId,
      nativeGoalId,
      binding: scope.binding,
      originActivityId: input.originActivityId,
      turnId: input.turnId ?? null,
      objective: input.objective.trim().slice(0, 1000),
      state: { kind: 'known', value: 'running', evidence },
      lifecyclePhase: 'launched',
      ...(replacedGoalId ? { replacedGoalId } : {}),
      verificationArtifactIds: [],
      verifications: [],
      stop: {
        state: 'none',
        supportedInterruptPath: 'root_session_cancel',
      },
      relatedWorkIds: [],
      relatedActivityIds: [input.originActivityId],
      logs: [],
      logSeq: 0,
      revision: 1,
      updatedAt: observedAt,
    };

    this.appendGoalLog(goal, 'info', `发起原生 Goal：${goal.objective ?? nativeGoalId}`, evidence, observedAt);
    scope.goalsById.set(workflowId, goal);
    scope.goalIdByNativeKey.set(nativeGoalId, workflowId);
    scope.activeGoalId = workflowId;

    this.recordGoalRecoveryEvidence(scope, goal, 'live_protocol', true, 'goal_launched', observedAt);
    commits.push(this.buildGoalCommit(goal, [], [], `goal_launch:${workflowId}:1`));

    return { accepted: true, deduplicated: false, workflowId, commits };
  }

  /**
   * Marks a Stop request for a Goal; never fabricates `cancelled` before native confirmation.
   */
  recordGoalStopRequested(
    binding: RuntimeBinding,
    workflowId: WorkflowId,
    observedAt = this.now(),
  ): TasksIngestResult {
    if (!this.enabled) return this.rejectedDisabled(binding, observedAt);
    const scope = this.scopes.get(slotKey(binding));
    if (!scope?.connectionId) {
      return this.rejectedScope(binding, observedAt, 'wrong_connection_rejected');
    }
    const goal = scope.goalsById.get(workflowId);
    if (!goal) return { accepted: false, deduplicated: false, commits: [] };
    if (goal.state.kind === 'known' && isTerminalWorkState(goal.state.value)) {
      return { accepted: true, deduplicated: true, workflowId, commits: [] };
    }

    const hostEvidence: Evidence = {
      kind: 'host_observation',
      observedAt,
      reasonCode: 'goal_stop_requested',
    };
    goal.stop = {
      state: 'requested',
      requestedAt: observedAt,
      reasonCode: 'goal_stop_requested',
      supportedInterruptPath: 'root_session_cancel',
      evidence: toPublicEvidenceDto(hostEvidence, observedAt),
    };
    this.appendGoalLog(goal, 'warn', '已发送 Goal 停止请求，等待原生终态确认', hostEvidence, observedAt);
    goal.revision += 1;
    goal.updatedAt = observedAt;

    return {
      accepted: true,
      deduplicated: false,
      workflowId,
      commits: [this.buildGoalCommit(goal, [], [], `goal_stop_req:${workflowId}:${goal.revision}`)],
    };
  }

  /**
   * Records an explicit user-confirmed `/schedule <when> <task>` launch via live_workflow.
   * Never creates an HM timer or blocks the user turn.
   */
  recordConfirmedScheduleLaunch(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly originActivityId: ActivityId;
    readonly turnId?: string | null;
    readonly scheduleKind?: ScheduleKind;
    readonly scheduleLabel?: string;
    readonly cronExpression?: string;
    readonly durationSeconds?: number;
    readonly nextAt?: number;
    readonly timezone?: string;
    readonly nativeScheduleId?: string;
    readonly workflowId?: WorkflowId;
    readonly ingressOrdinal?: number;
    readonly observedAt?: number;
  }): TasksIngestResult {
    const observedAt = input.observedAt ?? this.now();
    if (!this.enabled) return this.rejectedDisabled(input.binding, observedAt);
    const scope = this.getLiveScope(input.binding, input.connectionId);
    if (!scope) return this.rejectedScope(input.binding, observedAt, 'wrong_connection_rejected');

    const nativeScheduleId = input.nativeScheduleId?.trim() || `sched_${++scope.seqCounter}`;
    const workflowId =
      input.workflowId ??
      asWorkflowId(`wf_sched_${shortToken(`${scope.binding.generation}:${nativeScheduleId}`)}`);
    const dedupeKey = `sched_launch:${input.connectionId}:${workflowId}:${input.originActivityId}`;
    if (this.hasOrRecordDedupe(scope, dedupeKey)) {
      return { accepted: true, deduplicated: true, workflowId, commits: [] };
    }

    const evidence: Evidence = {
      kind: 'live_protocol',
      connectionId: input.connectionId,
      ingressOrdinal: input.ingressOrdinal ?? 0,
      wireVariant: 'schedule_live_workflow_launch',
      observedAt,
    };

    const scheduleKind: ScheduleKind =
      input.scheduleKind ??
      (input.cronExpression
        ? 'cron'
        : input.durationSeconds !== undefined
          ? 'one_shot'
          : 'unknown');

    const sched: InternalScheduleState = {
      workflowId,
      nativeScheduleId,
      binding: scope.binding,
      originActivityId: input.originActivityId,
      turnId: input.turnId ?? null,
      scheduleKind,
      ...(input.scheduleLabel ? { scheduleLabel: input.scheduleLabel.slice(0, 240) } : {}),
      ...(input.cronExpression ? { cronExpression: input.cronExpression } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      sessionBoundTimer: false,
      timezone: input.timezone
        ? { kind: 'known', value: input.timezone, evidence }
        : { kind: 'unknown', reasonCode: 'native_timezone_not_exposed' },
      nextAt:
        input.nextAt !== undefined
          ? { kind: 'known', value: input.nextAt, evidence }
          : { kind: 'unknown', reasonCode: 'native_next_at_not_exposed' },
      nextAtSource: input.nextAt !== undefined ? 'native_wire_timestamp' : 'not_exposed',
      state: { kind: 'known', value: 'waiting', evidence },
      lifecyclePhase: 'created',
      stop: {
        state: 'none',
        supportedControlNote: '真实已有计划的编辑、暂停或删除请使用官方 CLI /tasks 或原生 App。',
      },
      occurrenceOrder: [],
      occurrencesByWorkId: new Map(),
      workIdByNativeOccurrenceKey: new Map(),
      lastTriggeredWorkId: null,
      occurrenceCounter: 0,
      logs: [],
      logSeq: 0,
      revision: 1,
      updatedAt: observedAt,
    };

    this.appendScheduleLog(
      sched,
      'info',
      `已创建原生定时计划 (${scheduleKind})${sched.scheduleLabel ? `：${sched.scheduleLabel}` : ''}`,
      evidence,
      observedAt,
    );
    scope.schedulesById.set(workflowId, sched);
    scope.scheduleIdByNativeKey.set(nativeScheduleId, workflowId);

    this.recordScheduleRecoveryEvidence(scope, sched, undefined, 'live_protocol', true, 'schedule_created', observedAt);
    return {
      accepted: true,
      deduplicated: false,
      workflowId,
      commits: [this.buildScheduleCommit(sched, [], [], [], `sched_launch:${workflowId}:1`)],
    };
  }

  /**
   * Ingests an ACP wire frame into the Goal, Schedule & Native Tasks domain.
   */
  acceptFrame(
    envelope: NativeIngress,
    opts?: {
      readonly activeTurnId?: string | null;
      readonly activeTurnEnded?: boolean;
      readonly originActivityId?: ActivityId;
      readonly observedAt?: number;
    },
  ): TasksIngestResult {
    const observedAt = opts?.observedAt ?? this.now();
    if (!this.enabled) {
      return this.rejectedDisabled(envelope.binding, observedAt);
    }

    const scope = this.scopes.get(slotKey(envelope.binding));
    if (!scope || !sameBinding(scope.binding, envelope.binding)) {
      return this.rejectedScope(envelope.binding, observedAt, 'stale_generation_rejected');
    }
    if (!scope.connectionId || scope.connectionId !== envelope.connectionId) {
      return this.rejectedScope(envelope.binding, observedAt, 'wrong_connection_rejected');
    }
    if (envelope.channel === 'history_replay') {
      const diag = this.pushDiagnostic({
        code: 'history_replay_isolated',
        observedAt,
        runtimeId: envelope.binding.runtimeId,
        generation: envelope.binding.generation,
        detail: 'Isolated history_replay frame from mutating live Goal/Schedule/Tasks state',
      });
      return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
    }

    const wire = envelope.wire;
    const params = isRecord(wire) && isRecord(wire.params) ? wire.params : null;
    const frameSessionId =
      (params && typeof params.sessionId === 'string' && params.sessionId.trim()) ||
      envelope.originSession;
    if (frameSessionId && frameSessionId !== scope.rootNativeSessionId) {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    const decoded = decodeTasksIngressFrame(envelope, { strictMode: this.strictMode });
    if (decoded.kind === 'ignored') {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    const ordKey = `ord:${envelope.connectionId}:${envelope.ingressOrdinal}`;
    if (this.hasOrRecordDedupe(scope, ordKey)) {
      const diag = this.pushDiagnostic({
        code: 'duplicate_frame_ignored',
        observedAt,
        runtimeId: envelope.binding.runtimeId,
        generation: envelope.binding.generation,
        detail: `Duplicate ingressOrdinal ${envelope.ingressOrdinal} ignored`,
      });
      return { accepted: true, deduplicated: true, commits: [], diagnostic: diag };
    }

    if ('semanticEventId' in decoded && decoded.semanticEventId) {
      const semKey = `sem:${decoded.kind}:${decoded.semanticEventId}`;
      if (this.hasOrRecordDedupe(scope, semKey)) {
        const diag = this.pushDiagnostic({
          code: 'duplicate_frame_ignored',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Duplicate semantic event ${decoded.semanticEventId} ignored`,
        });
        return { accepted: true, deduplicated: true, commits: [], diagnostic: diag };
      }
    }

    const evidence: Evidence = {
      kind: 'live_protocol',
      connectionId: envelope.connectionId,
      ingressOrdinal: Math.max(0, envelope.ingressOrdinal),
      wireVariant: isRecord(wire) && typeof wire.method === 'string' ? wire.method : 'acp_v1',
      observedAt,
    };

    switch (decoded.kind) {
      case 'app_only_automation_notice': {
        const diag = this.pushDiagnostic({
          code: 'app_only_automation_closed',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `${decoded.capabilityId}: ${decoded.summary}`,
        });
        return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
      }

      case 'goal_update':
        return this.applyGoalUpdate(scope, decoded, evidence, observedAt, opts);

      case 'schedule_upsert':
        return this.applyScheduleUpsert(scope, decoded, evidence, observedAt, opts);

      case 'schedule_occurrence_triggered':
        return this.applyOccurrenceTriggered(scope, decoded, evidence, observedAt, opts);

      case 'schedule_cancelled':
        return this.applyScheduleCancelled(scope, decoded, evidence, observedAt);

      case 'wake_activity_signal':
        return this.applyWakeSignal(scope, decoded, evidence, observedAt);

      case 'background_work_update':
        return this.applyBackgroundWorkUpdate(scope, decoded, evidence, observedAt, opts);
    }
  }

  /**
   * Honest lease evaluation: ONLY holds retention leases when provably active on the live connection.
   * Never holds leases for idle cron schedules or after transport disconnect.
   */
  listRetentionReasons(binding: RuntimeBinding): string[] {
    if (!this.enabled) return [];
    const scope = this.scopes.get(slotKey(binding));
    if (!scope?.connectionId) return [];

    const reasons: string[] = [];
    for (const goal of scope.goalsById.values()) {
      if (goal.stop.state === 'requested') {
        reasons.push(`goal_stop_grace:${goal.workflowId}`);
      } else if (goal.state.kind === 'known' && isActiveWorkState(goal.state.value)) {
        reasons.push(`goal_active:${goal.workflowId}`);
      }
    }

    for (const sched of scope.schedulesById.values()) {
      for (const occ of sched.occurrencesByWorkId.values()) {
        if (occ.recoveryState === 'live' && occ.state.kind === 'known' && isActiveWorkState(occ.state.value)) {
          reasons.push(`schedule_occurrence_active:${occ.workId}`);
        }
      }
      if (
        sched.sessionBoundTimer &&
        sched.scheduleKind === 'one_shot' &&
        sched.state.kind === 'known' &&
        isActiveWorkState(sched.state.value)
      ) {
        reasons.push(`schedule_session_timer:${sched.workflowId}`);
      }
    }

    return reasons;
  }

  /**
   * Marks non-terminal Goals, armed Schedules, and live non-terminal occurrences as `stale`
   * on transport disconnect while keeping already-terminal/expired occurrence history untouched.
   */
  handleTransportClosed(
    binding: RuntimeBinding,
    connectionId: string,
    reason = 'transport_closed',
  ): TasksCommitBatch[] {
    const scope = this.getLiveScope(binding, connectionId);
    if (!scope) return [];
    scope.connectionId = null;

    const observedAt = this.now();
    const hostEvidence: Evidence = {
      kind: 'host_observation',
      observedAt,
      reasonCode: reason,
    };
    const batches: TasksCommitBatch[] = [];

    for (const goal of scope.goalsById.values()) {
      const lastState = goal.state.kind === 'known' ? goal.state.value : undefined;
      if (goal.state.kind === 'stale' || (lastState && isTerminalWorkState(lastState))) {
        continue;
      }
      goal.state = {
        kind: 'stale',
        ...(lastState ? { last: lastState } : {}),
        evidence: hostEvidence,
        reasonCode: reason,
      };
      if (goal.stop.state === 'requested') {
        goal.stop = {
          ...goal.stop,
          state: 'unconfirmed_unknown',
          reasonCode: reason,
          evidence: toPublicEvidenceDto(hostEvidence, observedAt),
        };
      }
      goal.lifecyclePhase = 'stale';
      goal.revision += 1;
      goal.updatedAt = observedAt;
      this.appendGoalLog(goal, 'warn', `观测连接已关闭 (${reason})，保留最后观测状态`, hostEvidence, observedAt);
      this.recordGoalRecoveryEvidence(scope, goal, 'live_protocol', false, reason, observedAt);
      batches.push(this.buildGoalCommit(goal, [], [], `goal_closed:${connectionId}:${goal.workflowId}:${goal.revision}`));
    }

    for (const sched of scope.schedulesById.values()) {
      const changedWorks: NativeWork[] = [];
      let schedMutated = false;

      for (const workId of sched.occurrenceOrder) {
        const occ = sched.occurrencesByWorkId.get(workId);
        if (!occ) continue;
        const occVal = occ.state.kind === 'known' ? occ.state.value : undefined;
        if (occVal && isTerminalWorkState(occVal)) {
          // Preserve expired / terminal occurrence history untouched, mark read-only recovery state
          if (occ.recoveryState !== 'preserved_read_only') {
            sched.occurrencesByWorkId.set(workId, { ...occ, recoveryState: 'preserved_read_only' });
          }
          continue;
        }
        const staleState: Observed<WorkState> = {
          kind: 'stale',
          ...(occVal ? { last: occVal } : {}),
          evidence: hostEvidence,
          reasonCode: reason,
        };
        const nextOcc: ScheduleOccurrenceRecord = {
          ...occ,
          state: staleState,
          recoveryState: 'stale_unconfirmed',
          revision: occ.revision + 1,
          updatedAt: observedAt,
        };
        sched.occurrencesByWorkId.set(workId, nextOcc);
        changedWorks.push(this.buildOccurrenceNativeWork(sched, nextOcc));
        schedMutated = true;
        this.recordScheduleRecoveryEvidence(scope, sched, nextOcc, occ.originSource, false, reason, observedAt);
      }

      const schedVal = sched.state.kind === 'known' ? sched.state.value : undefined;
      if (sched.state.kind !== 'stale' && !(schedVal && isTerminalWorkState(schedVal))) {
        sched.state = {
          kind: 'stale',
          ...(schedVal ? { last: schedVal } : {}),
          evidence: hostEvidence,
          reasonCode: reason,
        };
        if (sched.nextAt.kind === 'known') {
          sched.nextAt = {
            kind: 'stale',
            last: sched.nextAt.value,
            evidence: sched.nextAt.evidence,
            reasonCode: reason,
          };
        }
        sched.lifecyclePhase = 'stale';
        schedMutated = true;
        this.recordScheduleRecoveryEvidence(scope, sched, undefined, 'live_protocol', false, reason, observedAt);
      }

      if (schedMutated) {
        sched.revision += 1;
        sched.updatedAt = observedAt;
        this.appendScheduleLog(sched, 'warn', `连接断开 (${reason})，定时状态转 stale`, hostEvidence, observedAt);
        batches.push(
          this.buildScheduleCommit(
            sched,
            changedWorks,
            [],
            [],
            `sched_closed:${connectionId}:${sched.workflowId}:${sched.revision}`,
          ),
        );
      }
    }

    return batches;
  }

  /**
   * NP-15 Recovery reconciliation: validates profile/source/workspace/conversation scope,
   * deduplicates occurrences across generations, preserves expired history read-only,
   * and keeps unconfirmed armed schedules honest without guessing live state.
   */
  reconcileRecovery(request: TasksRecoveryReconcileRequest): TasksRecoveryReconcileResult {
    const observedAt = request.nowMs ?? this.now();
    const result = this.recoveryPort.reconcile(request);
    if (!result.accepted) {
      this.pushDiagnostic({
        code: 'cross_scope_recovery_blocked',
        observedAt,
        runtimeId: request.nextBinding.runtimeId,
        generation: request.nextBinding.generation,
        detail: `Blocked cross-scope task recovery: ${result.reasonCode}`,
      });
      return result;
    }

    const key = slotKey(request.nextBinding);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = {
        binding: request.nextBinding,
        connectionId: null,
        rootNativeSessionId: '',
        goalsById: new Map(),
        goalIdByNativeKey: new Map(),
        activeGoalId: null,
        schedulesById: new Map(),
        scheduleIdByNativeKey: new Map(),
        worksById: new Map(),
        workIdByToolCallId: new Map(),
        activitiesById: new Map(),
        endedTurnIds: new Set(),
        seenDedupeKeys: new Set(),
        seenDedupeQueue: [],
        seqCounter: 0,
      };
      this.scopes.set(key, scope);
    }

    const hostEvidence: Evidence = {
      kind: 'host_observation',
      observedAt,
      reasonCode: result.reasonCode,
    };

    for (const item of result.reconciledEntries) {
      const priorEv = request.priorEvidence.find(
        (e) => e.workflowId === item.workflowId && (e.workId === item.workId || !item.workId),
      );
      if (!priorEv) continue;

      if (priorEv.workflowKind === 'goal') {
        if (!scope.goalsById.has(item.workflowId)) {
          const originActivityId = asActivityId(`act_rec_${shortToken(item.workflowId)}`);
          const state: Observed<WorkState> =
            item.reconciledState === 'preserved_terminal'
              ? { kind: 'known', value: item.lastKnownState, evidence: hostEvidence }
              : item.reconciledState === 'unknown'
                ? { kind: 'unknown', reasonCode: item.reasonCode }
                : { kind: 'stale', last: item.lastKnownState, evidence: hostEvidence, reasonCode: item.reasonCode };
          scope.goalsById.set(item.workflowId, {
            workflowId: item.workflowId,
            nativeGoalId: item.nativeWorkflowKey,
            binding: request.nextBinding,
            originActivityId,
            turnId: null,
            objective: priorEv.objectiveOrLabel,
            state,
            ...(item.lastOutcome ? { outcome: { kind: 'known', value: item.lastOutcome, evidence: hostEvidence } } : {}),
            lifecyclePhase:
              item.reconciledState === 'preserved_terminal'
                ? (item.lastKnownState === 'failed' ? 'failed' : item.lastKnownState === 'cancelled' ? 'cancelled' : 'finished')
                : 'stale',
            verificationArtifactIds: [],
            verifications: [],
            stop: { state: 'none', supportedInterruptPath: 'root_session_cancel' },
            relatedWorkIds: [],
            relatedActivityIds: [originActivityId],
            logs: [],
            logSeq: 0,
            revision: 1,
            updatedAt: observedAt,
          });
          scope.goalIdByNativeKey.set(item.nativeWorkflowKey, item.workflowId);
        }
        continue;
      }

      // Schedule reconciliation
      let sched = scope.schedulesById.get(item.workflowId);
      if (!sched) {
        const originActivityId = asActivityId(`act_rec_${shortToken(item.workflowId)}`);
        const schedState: Observed<WorkState> =
          item.reconciledState === 'preserved_terminal' && !item.workId
            ? { kind: 'known', value: item.lastKnownState, evidence: hostEvidence }
            : { kind: 'stale', last: item.lastKnownState, evidence: hostEvidence, reasonCode: item.reasonCode };
        sched = {
          workflowId: item.workflowId,
          nativeScheduleId: item.nativeWorkflowKey,
          binding: request.nextBinding,
          originActivityId,
          turnId: null,
          scheduleKind: priorEv.scheduleKind ?? 'unknown',
          scheduleLabel: priorEv.objectiveOrLabel,
          sessionBoundTimer: false,
          timezone: priorEv.timezone
            ? { kind: 'stale', last: priorEv.timezone, evidence: hostEvidence, reasonCode: item.reasonCode }
            : { kind: 'unknown', reasonCode: 'native_timezone_not_exposed' },
          nextAt: priorEv.nextAt !== undefined
            ? { kind: 'stale', last: priorEv.nextAt, evidence: hostEvidence, reasonCode: item.reasonCode }
            : { kind: 'unknown', reasonCode: 'native_next_at_not_exposed' },
          nextAtSource: priorEv.nextAt !== undefined ? 'native_snapshot' : 'not_exposed',
          state: schedState,
          lifecyclePhase: item.reconciledState === 'preserved_terminal' ? 'expired' : 'stale',
          stop: {
            state: 'none',
            supportedControlNote: '真实已有计划的删除仍由用户经原生端完成。',
          },
          occurrenceOrder: [],
          occurrencesByWorkId: new Map(),
          workIdByNativeOccurrenceKey: new Map(),
          lastTriggeredWorkId: null,
          occurrenceCounter: 0,
          logs: [],
          logSeq: 0,
          revision: 1,
          updatedAt: observedAt,
        };
        scope.schedulesById.set(item.workflowId, sched);
        scope.scheduleIdByNativeKey.set(item.nativeWorkflowKey, item.workflowId);
      }

      if (item.workId && !sched.occurrencesByWorkId.has(item.workId)) {
        const occState: Observed<WorkState> =
          item.reconciledState === 'preserved_terminal'
            ? { kind: 'known', value: item.lastKnownState, evidence: hostEvidence }
            : { kind: 'stale', last: item.lastKnownState, evidence: hostEvidence, reasonCode: item.reasonCode };
        const occ: ScheduleOccurrenceRecord = {
          workId: item.workId,
          scheduleWorkflowId: sched.workflowId,
          occurrenceIndex: item.occurrenceIndex ?? sched.occurrenceOrder.length + 1,
          ...(item.nativeOccurrenceKey ? { nativeOccurrenceId: item.nativeOccurrenceKey } : {}),
          wakeActivityIds: [...item.wakeActivityIds],
          latestWakeActivityId: item.wakeActivityIds[item.wakeActivityIds.length - 1],
          hasObservedWake: item.wakeActivityIds.length > 0,
          ...(priorEv.plannedAt !== undefined
            ? { plannedAt: { kind: 'known', value: priorEv.plannedAt, evidence: hostEvidence } }
            : {}),
          ...(priorEv.actualTriggeredAt !== undefined
            ? { actualTriggeredAt: { kind: 'known', value: priorEv.actualTriggeredAt, evidence: hostEvidence } }
            : {}),
          timezone: priorEv.timezone
            ? { kind: 'known', value: priorEv.timezone, evidence: hostEvidence }
            : { kind: 'unknown', reasonCode: 'native_timezone_not_exposed' },
          state: occState,
          ...(item.lastOutcome ? { outcome: { kind: 'known', value: item.lastOutcome, evidence: hostEvidence } } : {}),
          originSource: priorEv.originSource,
          originGeneration: priorEv.originGeneration,
          recoveryState: item.recoveryState,
          revision: 1,
          updatedAt: observedAt,
        };
        sched.occurrenceOrder.push(item.workId);
        sched.occurrencesByWorkId.set(item.workId, occ);
        if (item.nativeOccurrenceKey) {
          sched.workIdByNativeOccurrenceKey.set(item.nativeOccurrenceKey, item.workId);
        }
      }
    }

    return result;
  }

  /**
   * Implements `NativeWorkflowResourceReaderPort` for Goal (`phases`/`logs`/`artifacts`)
   * and Schedule (`phases` = occurrences, `logs` = schedule/occurrence history).
   * Remains readable even when live ingestion is disabled (`this.enabled === false`).
   */
  readWorkflowResource(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly resource: NativeWorkflowResourceKind;
    readonly pageToken?: string;
    readonly limit: number;
  }): {
    readonly revision: number;
    readonly available: boolean;
    readonly sourceUnavailableReason?: string;
    readonly items: readonly NativeWorkflowResourceItemDto[];
    readonly nextPageToken: string | null;
    readonly hasMore: boolean;
  } {
    const scope = this.scopes.get(slotKey(input.binding));
    if (!scope) {
      return {
        revision: 0,
        available: false,
        sourceUnavailableReason: 'tasks_binding_not_found',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const nowMs = this.now();
    const limit = Math.max(1, Math.min(input.limit, 100));
    const offset = parseOffset(input.pageToken);

    const goal = scope.goalsById.get(input.workflowId);
    if (goal) {
      if (input.resource === 'board') {
        return {
          revision: goal.revision,
          available: false,
          sourceUnavailableReason: 'goal_does_not_provide_board',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      if (input.resource === 'phases') {
        const all = goal.verifications.map((v) =>
          NativeWorkflowResourceItemDtoSchema.parse({
            kind: 'phase',
            stage: {
              id: v.id,
              label: v.label,
              state: sanitizeObservedForPublic(v.state, nowMs),
            },
            ...(v.summary ? { summary: v.summary } : {}),
          }),
        );
        const page = all.slice(offset, offset + limit);
        const hasMore = offset + page.length < all.length;
        return {
          revision: goal.revision,
          available: true,
          items: page,
          nextPageToken: hasMore ? String(offset + page.length) : null,
          hasMore,
        };
      }
      if (input.resource === 'artifacts') {
        const all = goal.verificationArtifactIds.map((artId) =>
          NativeWorkflowResourceItemDtoSchema.parse({
            kind: 'artifact_ref',
            artifactId: artId,
            title: `Goal 验证产物 (${artId})`,
            artifactKind: 'markdown',
            activityId: goal.originActivityId,
            revision: goal.revision,
            updatedAt: goal.updatedAt,
            evidence:
              goal.state.kind === 'known'
                ? toPublicEvidenceDto(goal.state.evidence, nowMs)
                : { sourceKind: 'host_observation', freshness: 'host', observedAt: goal.updatedAt },
          }),
        );
        const page = all.slice(offset, offset + limit);
        const hasMore = offset + page.length < all.length;
        return {
          revision: goal.revision,
          available: true,
          items: page,
          nextPageToken: hasMore ? String(offset + page.length) : null,
          hasMore,
        };
      }
      // logs
      const all = goal.logs.map((entry) =>
        NativeWorkflowResourceItemDtoSchema.parse({
          kind: 'log_entry',
          entryId: entry.entryId,
          seq: entry.seq,
          level: entry.level,
          summary: entry.summary,
          truncated: false,
          createdAt: entry.createdAt,
          evidence: toPublicEvidenceDto(entry.evidence, nowMs),
        }),
      );
      const page = all.slice(offset, offset + limit);
      const hasMore = offset + page.length < all.length;
      return {
        revision: goal.revision,
        available: true,
        items: page,
        nextPageToken: hasMore ? String(offset + page.length) : null,
        hasMore,
      };
    }

    const sched = scope.schedulesById.get(input.workflowId);
    if (sched) {
      if (input.resource === 'board' || input.resource === 'artifacts') {
        return {
          revision: sched.revision,
          available: false,
          sourceUnavailableReason:
            input.resource === 'board' ? 'schedule_does_not_provide_board' : 'schedule_artifacts_not_exposed',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      if (input.resource === 'phases') {
        const all = sched.occurrenceOrder
          .map((wid) => sched.occurrencesByWorkId.get(wid))
          .filter((o): o is ScheduleOccurrenceRecord => Boolean(o))
          .map((occ) =>
            NativeWorkflowResourceItemDtoSchema.parse({
              kind: 'phase',
              stage: {
                id: occ.workId,
                label: `Occurrence #${occ.occurrenceIndex}${occ.hasObservedWake ? ` · wake:${occ.latestWakeActivityId}` : ''}`,
                state: sanitizeObservedForPublic(occ.state, nowMs),
              },
              ...(occ.summary ? { summary: occ.summary } : {}),
            }),
          );
        const page = all.slice(offset, offset + limit);
        const hasMore = offset + page.length < all.length;
        return {
          revision: sched.revision,
          available: true,
          items: page,
          nextPageToken: hasMore ? String(offset + page.length) : null,
          hasMore,
        };
      }
      // logs
      const all = sched.logs.map((entry) =>
        NativeWorkflowResourceItemDtoSchema.parse({
          kind: 'log_entry',
          entryId: entry.entryId,
          seq: entry.seq,
          level: entry.level,
          summary: entry.summary,
          truncated: false,
          createdAt: entry.createdAt,
          evidence: toPublicEvidenceDto(entry.evidence, nowMs),
        }),
      );
      const page = all.slice(offset, offset + limit);
      const hasMore = offset + page.length < all.length;
      return {
        revision: sched.revision,
        available: true,
        items: page,
        nextPageToken: hasMore ? String(offset + page.length) : null,
        hasMore,
      };
    }

    return {
      revision: 0,
      available: false,
      sourceUnavailableReason: 'workflow_not_found',
      items: [],
      nextPageToken: null,
      hasMore: false,
    };
  }

  getGoalSnapshot(binding: RuntimeBinding, workflowId: WorkflowId): GoalObservedSnapshotDto | null {
    const scope = this.scopes.get(slotKey(binding));
    const goal = scope?.goalsById.get(workflowId);
    return goal ? this.toGoalSnapshotDto(goal, this.now()) : null;
  }

  getScheduleSnapshot(binding: RuntimeBinding, workflowId: WorkflowId): ScheduleObservedSnapshotDto | null {
    const scope = this.scopes.get(slotKey(binding));
    const sched = scope?.schedulesById.get(workflowId);
    return sched ? this.toScheduleSnapshotDto(sched, this.now()) : null;
  }

  /**
   * Aggregates Runtime Center tasks across Goals, Schedules, finite commands, daemons,
   * and optional external NP-04 work items (deduplicated by WorkId).
   */
  getTasksCenterSnapshot(
    binding: RuntimeBinding,
    externalWorks: readonly NativeWork[] = [],
  ): NativeTasksCenterSnapshotDto {
    const nowMs = this.now();
    const scope = this.scopes.get(slotKey(binding));
    const goals: GoalObservedSnapshotDto[] = scope
      ? [...scope.goalsById.values()].map((g) => this.toGoalSnapshotDto(g, nowMs))
      : [];
    const schedules: ScheduleObservedSnapshotDto[] = scope
      ? [...scope.schedulesById.values()].map((s) => this.toScheduleSnapshotDto(s, nowMs))
      : [];

    const worksMap = new Map<WorkId, NativeWork>();
    if (scope) {
      for (const rec of scope.worksById.values()) {
        worksMap.set(rec.work.id, rec.work);
      }
      for (const sched of scope.schedulesById.values()) {
        for (const occ of sched.occurrencesByWorkId.values()) {
          worksMap.set(occ.workId, this.buildOccurrenceNativeWork(sched, occ));
        }
      }
    }
    for (const ext of externalWorks) {
      if (!worksMap.has(ext.id)) {
        worksMap.set(ext.id, ext);
      }
    }

    const works = [...worksMap.values()];
    const tasks: NativeTaskSummaryDto[] = [];
    const countsByCategory: Record<NativeTaskCategory, number> = {
      goal: 0,
      schedule: 0,
      finite_command: 0,
      daemon: 0,
      workflow_step: 0,
      subagent: 0,
      unknown: 0,
    };

    for (const g of goals) {
      countsByCategory.goal += 1;
      tasks.push({
        id: g.workflowId,
        entityKind: 'workflow',
        category: 'goal',
        label: g.objective ?? `Goal (${g.workflowId})`,
        blocking: 'unknown',
        state: g.state,
        ...(g.outcome ? { outcome: g.outcome } : {}),
        workflowId: g.workflowId,
        originActivityId: g.originActivityId,
        updatedAt: g.updatedAt,
      });
    }

    for (const s of schedules) {
      countsByCategory.schedule += 1;
      tasks.push({
        id: s.workflowId,
        entityKind: 'workflow',
        category: 'schedule',
        label: s.scheduleLabel ?? `Schedule (${s.scheduleKind})`,
        blocking: 'detached',
        state: s.state,
        ...(s.outcome ? { outcome: s.outcome } : {}),
        workflowId: s.workflowId,
        originActivityId: s.originActivityId,
        updatedAt: s.updatedAt,
      });
    }

    for (const w of works) {
      const cat: NativeTaskCategory = w.kind;
      countsByCategory[cat] += 1;
      tasks.push({
        id: w.id,
        entityKind: 'work',
        category: cat,
        label: w.observedLabel ?? `${w.kind} (${w.id})`,
        blocking: w.blocking,
        state: sanitizeObservedForPublic(w.state, nowMs),
        ...(w.outcome ? { outcome: sanitizeObservedForPublic(w.outcome, nowMs) } : {}),
        ...(w.workflowId ? { workflowId: w.workflowId } : {}),
        workId: w.id,
        ...(w.originActivityId ? { originActivityId: w.originActivityId } : {}),
        updatedAt: nowMs,
      });
    }

    return {
      contractRevision: TASKS_WORKFLOW_CONTRACT_REVISION,
      binding,
      enabled: this.enabled,
      readOnlyMode: !this.enabled,
      goals,
      schedules,
      works,
      tasks,
      countsByCategory,
      leaseReasons: this.listRetentionReasons(binding),
      protocolExposure: TASKS_PROTOCOL_EXPOSURE_ASSESSMENT,
      appAutomationsClosure: APP_AUTOMATIONS_CLOSURE_RECORD,
    };
  }

  commitToRegistry(
    registry: AgyNativeRuntimeRegistry,
    binding: RuntimeBinding,
    commits: readonly TasksCommitBatch[],
  ): void {
    for (const batch of commits) {
      for (let i = 0; i < batch.eventDrafts.length; i += 1) {
        const draft = batch.eventDrafts[i]!;
        if (i === 0) {
          registry.commitAndPublish(binding, batch.mutation, draft);
        } else {
          registry.commitAndPublish(binding, {}, draft);
        }
      }
    }
  }

  // ── Internal Frame Handlers ──────────────────────────────────────────

  private applyGoalUpdate(
    scope: TasksScopeState,
    decoded: Extract<DecodedTasksFrame, { kind: 'goal_update' }>,
    evidence: Evidence,
    observedAt: number,
    opts?: {
      readonly activeTurnId?: string | null;
      readonly originActivityId?: ActivityId;
    },
  ): TasksIngestResult {
    const commits: TasksCommitBatch[] = [];
    for (const rejected of decoded.rejectedArtifactRefs) {
      this.pushDiagnostic({
        code: 'unapproved_artifact_rejected',
        observedAt,
        runtimeId: scope.binding.runtimeId,
        generation: scope.binding.generation,
        detail: `Rejected non-opaque Goal verification artifact ref: ${rejected.slice(0, 64)}`,
      });
    }

    let workflowId = scope.goalIdByNativeKey.get(decoded.nativeGoalId);
    let goal = workflowId ? scope.goalsById.get(workflowId) : undefined;
    const aliases: Array<{
      readonly targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
      readonly targetEntityId: string;
      readonly alias: NativeAlias;
    }> = [];

    if (!goal) {
      workflowId = asWorkflowId(
        `wf_goal_${shortToken(`${scope.binding.generation}:${decoded.nativeGoalId}`)}`,
      );
      let replacedGoalId: WorkflowId | undefined;
      if (decoded.replaceActiveGoal || decoded.replacesGoalId) {
        const explicitPriorId = decoded.replacesGoalId
          ? scope.goalIdByNativeKey.get(decoded.replacesGoalId)
          : undefined;
        replacedGoalId = this.supersedeActiveGoalIfNeeded(
          scope,
          workflowId,
          evidence,
          observedAt,
          commits,
          explicitPriorId,
        );
      }

      const originActivityId =
        opts?.originActivityId ?? asActivityId(`act_goal_${shortToken(`${workflowId}:${observedAt}`)}`);
      goal = {
        workflowId,
        nativeGoalId: decoded.nativeGoalId,
        binding: scope.binding,
        originActivityId,
        turnId: opts?.activeTurnId ?? null,
        ...(decoded.objective ? { objective: decoded.objective } : {}),
        state:
          decoded.state.op === 'set'
            ? decoded.state.value === 'unknown'
              ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'goal_state_unknown' }
              : { kind: 'known', value: decoded.state.value, evidence }
            : { kind: 'known', value: 'running', evidence },
        ...(decoded.outcome.op === 'set'
          ? { outcome: { kind: 'known', value: decoded.outcome.value, evidence } }
          : decoded.outcomeReasonCode
            ? { outcome: { kind: 'unknown', reasonCode: decoded.outcomeReasonCode } }
            : {}),
        lifecyclePhase: 'launched',
        ...(replacedGoalId ? { replacedGoalId } : {}),
        verificationArtifactIds: [...decoded.verificationArtifactIds],
        verifications: [],
        stop: {
          state: 'none',
          supportedInterruptPath: 'root_session_cancel',
        },
        relatedWorkIds: [],
        relatedActivityIds: [originActivityId],
        logs: [],
        logSeq: 0,
        revision: 1,
        updatedAt: observedAt,
      };
      scope.goalsById.set(workflowId, goal);
      scope.goalIdByNativeKey.set(decoded.nativeGoalId, workflowId);
      scope.activeGoalId = workflowId;

      aliases.push({
        targetEntityKind: 'workflow',
        targetEntityId: workflowId,
        alias: {
          namespace: 'workflow',
          originSessionId: scope.rootNativeSessionId,
          nativeValue: decoded.nativeGoalId,
          evidence,
        },
      });
    } else {
      if (decoded.objective) goal.objective = decoded.objective;
      if (decoded.state.op === 'set') {
        goal.state =
          decoded.state.value === 'unknown'
            ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'goal_state_unknown' }
            : { kind: 'known', value: decoded.state.value, evidence };
      }
      if (decoded.outcome.op === 'set') {
        goal.outcome = { kind: 'known', value: decoded.outcome.value, evidence };
      } else if (decoded.outcomeReasonCode && !goal.outcome) {
        goal.outcome = { kind: 'unknown', reasonCode: decoded.outcomeReasonCode };
      }
      for (const artId of decoded.verificationArtifactIds) {
        if (!goal.verificationArtifactIds.includes(artId) && isValidOpaqueArtifactId(artId)) {
          goal.verificationArtifactIds.push(artId);
        }
      }
      goal.revision += 1;
      goal.updatedAt = observedAt;
    }

    if (decoded.verificationLabel || decoded.verificationSummary || decoded.verificationArtifactIds.length > 0) {
      const vState: Observed<WorkState> =
        decoded.state.op === 'set'
          ? { kind: 'known', value: decoded.state.value, evidence }
          : goal.state;
      goal.verifications.push({
        id: `gver_${goal.verifications.length + 1}`,
        label: decoded.verificationLabel ?? '目标核验检查',
        state: vState,
        ...(goal.outcome ? { outcome: goal.outcome } : {}),
        ...(decoded.verificationArtifactIds[0] ? { artifactId: decoded.verificationArtifactIds[0] } : {}),
        ...(decoded.verificationSummary ? { summary: decoded.verificationSummary } : {}),
        evidence,
        observedAt,
      });
    }

    if (goal.state.kind === 'known' && goal.state.value === 'cancelled' && goal.stop.state === 'requested') {
      goal.stop = {
        ...goal.stop,
        state: 'confirmed',
        confirmedAt: observedAt,
        reasonCode: 'native_goal_cancelled',
        evidence: toPublicEvidenceDto(evidence, observedAt),
      };
      this.pushDiagnostic({
        code: 'stop_confirmed',
        observedAt,
        runtimeId: scope.binding.runtimeId,
        generation: scope.binding.generation,
        detail: `Goal ${goal.workflowId} confirmed cancelled by native wire`,
      });
    }

    goal.lifecyclePhase = this.computeGoalPhase(goal);
    this.appendGoalLog(
      goal,
      goal.lifecyclePhase === 'failed' ? 'error' : 'info',
      decoded.verificationSummary ?? `Goal 状态更新为 ${goal.lifecyclePhase}`,
      evidence,
      observedAt,
    );
    this.recordGoalRecoveryEvidence(scope, goal, 'live_protocol', true, 'goal_updated', observedAt);
    commits.push(this.buildGoalCommit(goal, [], aliases, `goal_upd:${goal.workflowId}:${goal.revision}`));

    return { accepted: true, deduplicated: false, workflowId: goal.workflowId, commits };
  }

  private applyScheduleUpsert(
    scope: TasksScopeState,
    decoded: Extract<DecodedTasksFrame, { kind: 'schedule_upsert' }>,
    evidence: Evidence,
    observedAt: number,
    opts?: { readonly activeTurnId?: string | null; readonly originActivityId?: ActivityId },
  ): TasksIngestResult {
    if (decoded.invalidTimezoneIgnored) {
      this.pushDiagnostic({
        code: 'invalid_timezone_ignored',
        observedAt,
        runtimeId: scope.binding.runtimeId,
        generation: scope.binding.generation,
        detail: `Ignored invalid native timezone on schedule ${decoded.nativeScheduleId}`,
      });
    }

    let workflowId = scope.scheduleIdByNativeKey.get(decoded.nativeScheduleId);
    let sched = workflowId ? scope.schedulesById.get(workflowId) : undefined;
    const aliases: Array<{
      readonly targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
      readonly targetEntityId: string;
      readonly alias: NativeAlias;
    }> = [];

    if (!sched) {
      workflowId = asWorkflowId(
        `wf_sched_${shortToken(`${scope.binding.generation}:${decoded.nativeScheduleId}`)}`,
      );
      const originActivityId =
        opts?.originActivityId ?? asActivityId(`act_sched_${shortToken(`${workflowId}:${observedAt}`)}`);
      sched = {
        workflowId,
        nativeScheduleId: decoded.nativeScheduleId,
        binding: scope.binding,
        originActivityId,
        turnId: opts?.activeTurnId ?? null,
        scheduleKind: decoded.scheduleKind,
        ...(decoded.scheduleLabel ? { scheduleLabel: decoded.scheduleLabel } : {}),
        ...(decoded.cronExpression ? { cronExpression: decoded.cronExpression } : {}),
        ...(decoded.durationSeconds !== undefined ? { durationSeconds: decoded.durationSeconds } : {}),
        ...(decoded.timerCondition ? { timerCondition: decoded.timerCondition } : {}),
        ...(decoded.maxIterations !== undefined ? { maxIterations: decoded.maxIterations } : {}),
        ...(decoded.exactTiming !== undefined ? { exactTiming: decoded.exactTiming } : {}),
        ...(decoded.isDaemon !== undefined ? { isDaemon: decoded.isDaemon } : {}),
        sessionBoundTimer: decoded.sessionBoundTimer ?? false,
        timezone: decoded.timezone
          ? { kind: 'known', value: decoded.timezone, evidence }
          : { kind: 'unknown', reasonCode: 'native_timezone_not_exposed' },
        nextAt:
          decoded.nextAt !== undefined
            ? { kind: 'known', value: decoded.nextAt, evidence }
            : { kind: 'unknown', reasonCode: 'native_next_at_not_exposed' },
        nextAtSource: decoded.nextAtSource,
        state:
          decoded.state.op === 'set'
            ? decoded.state.value === 'unknown'
              ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'schedule_state_unknown' }
              : { kind: 'known', value: decoded.state.value, evidence }
            : { kind: 'known', value: 'waiting', evidence },
        ...(decoded.outcome.op === 'set'
          ? { outcome: { kind: 'known', value: decoded.outcome.value, evidence } }
          : {}),
        lifecyclePhase: 'scheduled',
        stop: {
          state: 'none',
          supportedControlNote: '真实已有计划的编辑、暂停或删除请使用官方 CLI /tasks 或原生 App。',
        },
        occurrenceOrder: [],
        occurrencesByWorkId: new Map(),
        workIdByNativeOccurrenceKey: new Map(),
        lastTriggeredWorkId: null,
        occurrenceCounter: 0,
        logs: [],
        logSeq: 0,
        revision: 1,
        updatedAt: observedAt,
      };
      scope.schedulesById.set(workflowId, sched);
      scope.scheduleIdByNativeKey.set(decoded.nativeScheduleId, workflowId);
      aliases.push({
        targetEntityKind: 'workflow',
        targetEntityId: workflowId,
        alias: {
          namespace: 'workflow',
          originSessionId: scope.rootNativeSessionId,
          nativeValue: decoded.nativeScheduleId,
          evidence,
        },
      });
    } else {
      if (decoded.scheduleKind !== 'unknown') sched.scheduleKind = decoded.scheduleKind;
      if (decoded.scheduleLabel) sched.scheduleLabel = decoded.scheduleLabel;
      if (decoded.cronExpression) sched.cronExpression = decoded.cronExpression;
      if (decoded.durationSeconds !== undefined) sched.durationSeconds = decoded.durationSeconds;
      if (decoded.timerCondition) sched.timerCondition = decoded.timerCondition;
      if (decoded.maxIterations !== undefined) sched.maxIterations = decoded.maxIterations;
      if (decoded.exactTiming !== undefined) sched.exactTiming = decoded.exactTiming;
      if (decoded.sessionBoundTimer !== undefined) sched.sessionBoundTimer = decoded.sessionBoundTimer;
      if (decoded.timezone) {
        sched.timezone = { kind: 'known', value: decoded.timezone, evidence };
      }
      if (decoded.nextAt !== undefined) {
        sched.nextAt = { kind: 'known', value: decoded.nextAt, evidence };
        sched.nextAtSource = 'native_wire_timestamp';
      }
      if (decoded.state.op === 'set') {
        sched.state =
          decoded.state.value === 'unknown'
            ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'schedule_state_unknown' }
            : { kind: 'known', value: decoded.state.value, evidence };
      }
      if (decoded.outcome.op === 'set') {
        sched.outcome = { kind: 'known', value: decoded.outcome.value, evidence };
      }
      sched.revision += 1;
      sched.updatedAt = observedAt;
    }

    sched.lifecyclePhase = this.computeSchedulePhase(sched);
    this.appendScheduleLog(
      sched,
      'info',
      `定时计划状态：${sched.lifecyclePhase} (${sched.scheduleKind})`,
      evidence,
      observedAt,
    );
    this.recordScheduleRecoveryEvidence(scope, sched, undefined, 'live_protocol', true, 'schedule_upserted', observedAt);

    return {
      accepted: true,
      deduplicated: false,
      workflowId: sched.workflowId,
      commits: [this.buildScheduleCommit(sched, [], [], aliases, `sched_upsert:${sched.workflowId}:${sched.revision}`)],
    };
  }

  private applyOccurrenceTriggered(
    scope: TasksScopeState,
    decoded: Extract<DecodedTasksFrame, { kind: 'schedule_occurrence_triggered' }>,
    evidence: Evidence,
    observedAt: number,
    opts?: { readonly activeTurnId?: string | null; readonly activeTurnEnded?: boolean; readonly originActivityId?: ActivityId },
  ): TasksIngestResult {
    let workflowId = scope.scheduleIdByNativeKey.get(decoded.nativeScheduleId);
    let sched = workflowId ? scope.schedulesById.get(workflowId) : undefined;
    if (!sched) {
      // Auto-register minimal schedule container from live occurrence if launch frame was missed
      const upserted = this.applyScheduleUpsert(
        scope,
        {
          kind: 'schedule_upsert',
          nativeScheduleId: decoded.nativeScheduleId,
          scheduleKind: 'unknown',
          nextAt: decoded.nextAt,
          nextAtSource: decoded.nextAt !== undefined ? 'native_wire_timestamp' : 'not_exposed',
          timezone: decoded.timezone,
          state: { op: 'set', value: 'waiting' },
          outcome: { op: 'omit' },
        },
        evidence,
        observedAt,
        opts,
      );
      workflowId = upserted.workflowId!;
      sched = scope.schedulesById.get(workflowId)!;
    }

    const occKey = decoded.nativeOccurrenceId ?? (decoded.occurrenceIndex !== undefined ? `idx:${decoded.occurrenceIndex}` : undefined);
    let workId = occKey ? sched.workIdByNativeOccurrenceKey.get(occKey) : undefined;
    let occ = workId ? sched.occurrencesByWorkId.get(workId) : undefined;

    if (!occ) {
      const occIdx = decoded.occurrenceIndex ?? ++sched.occurrenceCounter;
      sched.occurrenceCounter = Math.max(sched.occurrenceCounter, occIdx);
      workId = asWorkId(`wrk_occ_${shortToken(`${sched.workflowId}:${occKey ?? occIdx}`)}`);
      occ = {
        workId,
        scheduleWorkflowId: sched.workflowId,
        occurrenceIndex: occIdx,
        ...(decoded.nativeOccurrenceId ? { nativeOccurrenceId: decoded.nativeOccurrenceId } : {}),
        wakeActivityIds: [],
        hasObservedWake: false,
        ...(decoded.plannedAt !== undefined
          ? { plannedAt: { kind: 'known', value: decoded.plannedAt, evidence } }
          : {}),
        ...(decoded.actualTriggeredAt !== undefined
          ? { actualTriggeredAt: { kind: 'known', value: decoded.actualTriggeredAt, evidence } }
          : {}),
        timezone: decoded.timezone
          ? { kind: 'known', value: decoded.timezone, evidence }
          : sched.timezone,
        state:
          decoded.state.op === 'set'
            ? decoded.state.value === 'unknown'
              ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'occurrence_state_unknown' }
              : { kind: 'known', value: decoded.state.value, evidence }
            : { kind: 'known', value: 'running', evidence },
        ...(decoded.outcome.op === 'set'
          ? { outcome: { kind: 'known', value: decoded.outcome.value, evidence } }
          : decoded.outcomeReasonCode
            ? { outcome: { kind: 'unknown', reasonCode: decoded.outcomeReasonCode } }
            : {}),
        originSource: 'live_protocol',
        originGeneration: scope.binding.generation,
        recoveryState: 'live',
        ...(decoded.summary ? { summary: decoded.summary } : {}),
        revision: 1,
        updatedAt: observedAt,
      };
      if (sched.occurrenceOrder.length < this.limits.maxOccurrencesPerSchedule) {
        sched.occurrenceOrder.push(workId);
      }
      sched.occurrencesByWorkId.set(workId, occ);
      if (occKey) sched.workIdByNativeOccurrenceKey.set(occKey, workId);
    } else {
      const nextState: Observed<WorkState> =
        decoded.state.op === 'set'
          ? decoded.state.value === 'unknown'
            ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'occurrence_state_unknown' }
            : { kind: 'known', value: decoded.state.value, evidence }
          : occ.state;
      const nextOutcome: Observed<WorkOutcome> | undefined =
        decoded.outcome.op === 'set'
          ? { kind: 'known', value: decoded.outcome.value, evidence }
          : decoded.outcomeReasonCode && !occ.outcome
            ? { kind: 'unknown', reasonCode: decoded.outcomeReasonCode }
            : occ.outcome;
      occ = {
        ...occ,
        ...(decoded.plannedAt !== undefined
          ? { plannedAt: { kind: 'known', value: decoded.plannedAt, evidence } }
          : {}),
        ...(decoded.actualTriggeredAt !== undefined
          ? { actualTriggeredAt: { kind: 'known', value: decoded.actualTriggeredAt, evidence } }
          : {}),
        state: nextState,
        ...(nextOutcome ? { outcome: nextOutcome } : {}),
        ...(nextState.kind === 'known' && isTerminalWorkState(nextState.value) ? { settledAt: observedAt } : {}),
        ...(decoded.summary ? { summary: decoded.summary } : {}),
        revision: occ.revision + 1,
        updatedAt: observedAt,
      };
      sched.occurrencesByWorkId.set(workId!, occ);
    }

    sched.lastTriggeredWorkId = workId!;
    if (decoded.nextAt !== undefined) {
      sched.nextAt = { kind: 'known', value: decoded.nextAt, evidence };
      sched.nextAtSource = 'native_wire_timestamp';
    }
    if (decoded.timezone) {
      sched.timezone = { kind: 'known', value: decoded.timezone, evidence };
    }

    // Create a distinct wake Activity when post-turn or explicit wake hint is present
    const createdActivities: Activity[] = [];
    let wakeActivityId: ActivityId | undefined;
    const isPostTurn = Boolean(
      opts?.activeTurnEnded ||
      (sched.turnId && scope.endedTurnIds.has(sched.turnId)) ||
      decoded.wakeActivityHint,
    );
    if (isPostTurn && !occ.hasObservedWake) {
      wakeActivityId = asActivityId(`act_wake_${shortToken(`${workId}:${observedAt}:${++scope.seqCounter}`)}`);
      const wakeAct = ActivitySchema.parse({
        id: wakeActivityId,
        turnId: null,
        origin: 'native_task',
        priorActivityId: sched.originActivityId,
        workId,
        state: occ.state.kind === 'known' && isTerminalWorkState(occ.state.value) ? occ.state.value : 'running',
        summary: decoded.summary ?? `定时计划 #${occ.occurrenceIndex} 原生唤醒`,
        evidence: toPublicEvidenceDto(evidence, observedAt),
        updatedAt: observedAt,
      });
      scope.activitiesById.set(wakeActivityId, wakeAct);
      createdActivities.push(wakeAct);
      occ = {
        ...occ,
        wakeActivityIds: [...occ.wakeActivityIds, wakeActivityId],
        latestWakeActivityId: wakeActivityId,
        hasObservedWake: true,
      };
      sched.occurrencesByWorkId.set(workId!, occ);
    }

    if (sched.scheduleKind === 'one_shot' && occ.state.kind === 'known' && isTerminalWorkState(occ.state.value)) {
      sched.state = occ.state;
      if (occ.outcome) sched.outcome = occ.outcome;
    } else if (occ.state.kind === 'known' && isActiveWorkState(occ.state.value)) {
      sched.state = { kind: 'known', value: 'running', evidence };
    } else if (sched.scheduleKind === 'cron' && occ.state.kind === 'known' && isTerminalWorkState(occ.state.value)) {
      // Cron remains armed/waiting for next occurrence unless explicitly finished/cancelled
      sched.state = { kind: 'known', value: 'waiting', evidence };
    }

    sched.lifecyclePhase = this.computeSchedulePhase(sched);
    sched.revision += 1;
    sched.updatedAt = observedAt;

    const nativeWork = this.buildOccurrenceNativeWork(sched, occ);
    this.appendScheduleLog(
      sched,
      'info',
      `Occurrence #${occ.occurrenceIndex} (${workId}) 触发/更新${wakeActivityId ? ` · wake ${wakeActivityId}` : ''}`,
      evidence,
      observedAt,
    );
    this.recordScheduleRecoveryEvidence(scope, sched, occ, 'live_protocol', true, 'occurrence_updated', observedAt);

    return {
      accepted: true,
      deduplicated: false,
      workflowId: sched.workflowId,
      workId,
      ...(wakeActivityId ? { wakeActivityId } : {}),
      commits: [
        this.buildScheduleCommit(
          sched,
          [nativeWork],
          createdActivities,
          [],
          `sched_occ:${sched.workflowId}:${workId}:${occ.revision}`,
        ),
      ],
    };
  }

  private applyScheduleCancelled(
    scope: TasksScopeState,
    decoded: Extract<DecodedTasksFrame, { kind: 'schedule_cancelled' }>,
    evidence: Evidence,
    observedAt: number,
  ): TasksIngestResult {
    const workflowId = scope.scheduleIdByNativeKey.get(decoded.nativeScheduleId);
    const sched = workflowId ? scope.schedulesById.get(workflowId) : undefined;
    if (!sched) {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    sched.state = { kind: 'known', value: 'cancelled', evidence };
    sched.outcome = { kind: 'known', value: 'cancelled', evidence };
    sched.lifecyclePhase = 'cancelled';
    sched.stop = {
      ...sched.stop,
      state: 'confirmed',
      confirmedAt: observedAt,
      reasonCode: decoded.reasonCode,
      evidence: toPublicEvidenceDto(evidence, observedAt),
    };

    const changedWorks: NativeWork[] = [];
    for (const workId of sched.occurrenceOrder) {
      const occ = sched.occurrencesByWorkId.get(workId);
      if (!occ) continue;
      if (occ.state.kind === 'known' && isTerminalWorkState(occ.state.value)) {
        continue; // Preserve already-expired/completed occurrence history!
      }
      const cancelledOcc: ScheduleOccurrenceRecord = {
        ...occ,
        state: { kind: 'known', value: 'cancelled', evidence },
        outcome: { kind: 'known', value: 'cancelled', evidence },
        settledAt: observedAt,
        recoveryState: 'preserved_read_only',
        revision: occ.revision + 1,
        updatedAt: observedAt,
      };
      sched.occurrencesByWorkId.set(workId, cancelledOcc);
      changedWorks.push(this.buildOccurrenceNativeWork(sched, cancelledOcc));
    }

    sched.revision += 1;
    sched.updatedAt = observedAt;
    this.appendScheduleLog(
      sched,
      'warn',
      decoded.summary ?? `定时计划已提前取消 (${decoded.reasonCode})`,
      evidence,
      observedAt,
    );
    this.recordScheduleRecoveryEvidence(scope, sched, undefined, 'live_protocol', false, decoded.reasonCode, observedAt);

    return {
      accepted: true,
      deduplicated: false,
      workflowId: sched.workflowId,
      commits: [
        this.buildScheduleCommit(
          sched,
          changedWorks,
          [],
          [],
          `sched_cancel:${sched.workflowId}:${sched.revision}`,
        ),
      ],
    };
  }

  private applyWakeSignal(
    scope: TasksScopeState,
    decoded: Extract<DecodedTasksFrame, { kind: 'wake_activity_signal' }>,
    evidence: Evidence,
    observedAt: number,
  ): TasksIngestResult {
    let matched: { schedule: InternalScheduleState; occurrence: ScheduleOccurrenceRecord } | undefined;
    for (const schedule of scope.schedulesById.values()) {
      if (decoded.nativeScheduleId && schedule.nativeScheduleId !== decoded.nativeScheduleId) continue;
      const occurrenceWorkId = decoded.nativeOccurrenceId
        ? schedule.workIdByNativeOccurrenceKey.get(decoded.nativeOccurrenceId)
        : decoded.sourceWorkIdHint;
      if (!occurrenceWorkId || (decoded.sourceWorkIdHint && decoded.sourceWorkIdHint !== occurrenceWorkId)) continue;
      const occurrence = schedule.occurrencesByWorkId.get(asWorkId(occurrenceWorkId));
      if (!occurrence) continue;
      if (matched) return { accepted: false, deduplicated: false, commits: [] };
      matched = { schedule, occurrence };
    }
    if (!matched) return { accepted: false, deduplicated: false, commits: [] };

    const sched = matched.schedule;
    let occ = matched.occurrence;
    const workId = occ.workId;
    const wakeActivityId =
      occ.latestWakeActivityId ??
      asActivityId(`act_wake_${shortToken(`${workId}:${observedAt}:${++scope.seqCounter}`)}`);
    const isNewWake = !occ.wakeActivityIds.includes(wakeActivityId);

    const wakeState = decoded.completed ? 'finished' : 'running';
    const wakeAct = ActivitySchema.parse({
      id: wakeActivityId,
      turnId: null,
      origin: 'native_task',
      priorActivityId: sched.originActivityId,
      workId,
      state: wakeState,
      summary: decoded.summary,
      evidence: toPublicEvidenceDto(evidence, observedAt),
      updatedAt: observedAt,
    });
    scope.activitiesById.set(wakeActivityId, wakeAct);

    occ = {
      ...occ,
      wakeActivityIds: isNewWake ? [...occ.wakeActivityIds, wakeActivityId] : occ.wakeActivityIds,
      latestWakeActivityId: wakeActivityId,
      hasObservedWake: true,
      state: decoded.completed
        ? { kind: 'known', value: 'finished', evidence }
        : occ.state,
      ...(decoded.outcome
        ? { outcome: { kind: 'known', value: decoded.outcome, evidence } }
        : {}),
      ...(decoded.completed ? { settledAt: observedAt } : {}),
      summary: decoded.summary,
      revision: occ.revision + 1,
      updatedAt: observedAt,
    };
    sched.occurrencesByWorkId.set(workId, occ);

    if (decoded.completed) {
      if (sched.scheduleKind === 'one_shot') {
        sched.state = { kind: 'known', value: 'finished', evidence };
        if (decoded.outcome) sched.outcome = { kind: 'known', value: decoded.outcome, evidence };
      } else if (sched.scheduleKind === 'cron') {
        sched.state = { kind: 'known', value: 'waiting', evidence };
      }
    }
    sched.lifecyclePhase = this.computeSchedulePhase(sched);
    sched.revision += 1;
    sched.updatedAt = observedAt;

    const nativeWork = this.buildOccurrenceNativeWork(sched, occ);
    this.appendScheduleLog(sched, 'info', `Wake ${wakeActivityId}：${decoded.summary}`, evidence, observedAt);
    this.recordScheduleRecoveryEvidence(scope, sched, occ, 'live_protocol', true, 'wake_observed', observedAt);

    return {
      accepted: true,
      deduplicated: false,
      workflowId: sched.workflowId,
      workId,
      wakeActivityId,
      commits: [
        this.buildScheduleCommit(
          sched,
          [nativeWork],
          [wakeAct],
          [],
          `sched_wake:${sched.workflowId}:${workId}:${occ.revision}`,
        ),
      ],
    };
  }

  private applyBackgroundWorkUpdate(
    scope: TasksScopeState,
    decoded: Extract<DecodedTasksFrame, { kind: 'background_work_update' }>,
    evidence: Evidence,
    observedAt: number,
    opts?: { readonly activeTurnId?: string | null; readonly originActivityId?: ActivityId },
  ): TasksIngestResult {
    let workId = scope.workIdByToolCallId.get(decoded.toolCallId);
    let rec = workId ? scope.worksById.get(workId) : undefined;

    if (!rec) {
      workId = asWorkId(`wrk_task_${shortToken(`${scope.binding.generation}:${decoded.toolCallId}`)}`);
      const work = NativeWorkSchema.parse({
        id: workId,
        kind: decoded.workKind,
        ...(opts?.originActivityId ? { originActivityId: opts.originActivityId } : {}),
        blocking: decoded.blocking,
        state:
          decoded.state.op === 'set'
            ? decoded.state.value === 'unknown'
              ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'wire_status_unknown' }
              : { kind: 'known', value: decoded.state.value, evidence }
            : { kind: 'known', value: 'running', evidence },
        ...(decoded.outcome.op === 'set'
          ? { outcome: { kind: 'known', value: decoded.outcome.value, evidence } }
          : decoded.outcomeReasonCode
            ? { outcome: { kind: 'unknown', reasonCode: decoded.outcomeReasonCode } }
            : {}),
        ...(decoded.label ? { observedLabel: decoded.label } : {}),
        revision: 1,
      });
      rec = {
        work,
        toolCallId: decoded.toolCallId,
        ...(decoded.backgroundTaskId ? { backgroundTaskId: decoded.backgroundTaskId } : {}),
        updatedAt: observedAt,
      };
      scope.worksById.set(workId, rec);
      scope.workIdByToolCallId.set(decoded.toolCallId, workId);
    } else {
      const nextState: Observed<WorkState> =
        decoded.state.op === 'set'
          ? decoded.state.value === 'unknown'
            ? { kind: 'unknown', reasonCode: decoded.stateReasonCode ?? 'wire_status_unknown' }
            : { kind: 'known', value: decoded.state.value, evidence }
          : rec.work.state;
      const nextOutcome: Observed<WorkOutcome> | undefined =
        decoded.outcome.op === 'set'
          ? { kind: 'known', value: decoded.outcome.value, evidence }
          : decoded.outcomeReasonCode && !rec.work.outcome
            ? { kind: 'unknown', reasonCode: decoded.outcomeReasonCode }
            : rec.work.outcome;
      rec.work = NativeWorkSchema.parse({
        ...rec.work,
        state: nextState,
        ...(nextOutcome ? { outcome: nextOutcome } : {}),
        ...(decoded.label ? { observedLabel: decoded.label } : {}),
        revision: rec.work.revision + 1,
      });
      rec.updatedAt = observedAt;
    }

    const workDto = sanitizeNativeWorkForPublic(rec.work, observedAt);
    const batch: TasksCommitBatch = {
      mutation: { work: [rec.work] },
      eventDrafts: [
        {
          type: 'native.work.changed',
          turnId: opts?.activeTurnId ?? null,
          payload: { work: workDto },
          mutationKey: `tasks_wk:${rec.work.id}:${rec.work.revision}`,
        },
      ],
      aliases: [],
      workflows: [],
    };
    return { accepted: true, deduplicated: false, workId: rec.work.id, commits: [batch] };
  }

  // ── Builders & Helpers ───────────────────────────────────────────────

  private supersedeActiveGoalIfNeeded(
    scope: TasksScopeState,
    replacementWorkflowId: WorkflowId,
    evidence: Evidence,
    observedAt: number,
    commits: TasksCommitBatch[],
    explicitPriorId?: WorkflowId,
  ): WorkflowId | undefined {
    const targetId = explicitPriorId ?? scope.activeGoalId;
    if (!targetId || targetId === replacementWorkflowId) return undefined;
    const prior = scope.goalsById.get(targetId);
    if (!prior) return undefined;
    if (prior.state.kind === 'known' && isTerminalWorkState(prior.state.value)) {
      return prior.workflowId;
    }
    prior.state = { kind: 'known', value: 'cancelled', evidence };
    prior.outcome = { kind: 'known', value: 'cancelled', evidence };
    prior.supersededByGoalId = replacementWorkflowId;
    prior.lifecyclePhase = 'superseded';
    prior.revision += 1;
    prior.updatedAt = observedAt;
    this.appendGoalLog(prior, 'info', `已被新 Goal (${replacementWorkflowId}) 替换`, evidence, observedAt);
    commits.push(this.buildGoalCommit(prior, [], [], `goal_superseded:${prior.workflowId}:${prior.revision}`));
    return prior.workflowId;
  }

  private computeGoalPhase(goal: InternalGoalState): GoalLifecyclePhase {
    if (goal.supersededByGoalId) return 'superseded';
    if (goal.state.kind === 'stale') return 'stale';
    if (goal.state.kind === 'unknown') return 'unknown';
    switch (goal.state.value) {
      case 'queued':
        return 'launched';
      case 'running':
        return goal.verifications.length > 0 ? 'verifying' : 'running';
      case 'waiting':
      case 'requires_action':
        return 'waiting_action';
      case 'finished':
        return 'finished';
      case 'failed':
        return 'failed';
      case 'cancelled':
        return 'cancelled';
      case 'unknown':
        return 'unknown';
    }
  }

  private computeSchedulePhase(sched: InternalScheduleState): ScheduleLifecyclePhase {
    if (sched.state.kind === 'stale') return 'stale';
    if (sched.state.kind === 'unknown') return 'unknown';
    switch (sched.state.value) {
      case 'cancelled':
        return 'cancelled';
      case 'failed':
        return 'failed';
      case 'finished':
        return 'finished';
      case 'running':
        return 'triggered';
      case 'queued':
      case 'waiting':
        return sched.occurrenceOrder.length > 0 ? 'triggered' : 'scheduled';
      case 'requires_action':
        return 'triggered';
      case 'unknown':
        return 'unknown';
    }
  }

  private buildGoalNativeWorkflow(goal: InternalGoalState): NativeWorkflow {
    return NativeWorkflowSchema.parse({
      id: goal.workflowId,
      originActivityId: goal.originActivityId,
      state: goal.state,
      detail: {
        kind: 'goal',
        ...(goal.objective ? { objective: goal.objective } : {}),
        ...(goal.verificationArtifactIds.length > 0
          ? { verificationArtifactIds: [...goal.verificationArtifactIds] }
          : {}),
      },
      revision: goal.revision,
    });
  }

  private buildScheduleNativeWorkflow(sched: InternalScheduleState): NativeWorkflow {
    return NativeWorkflowSchema.parse({
      id: sched.workflowId,
      originActivityId: sched.originActivityId,
      state: sched.state,
      detail: {
        kind: 'schedule',
        ...(sched.scheduleLabel ? { scheduleLabel: sched.scheduleLabel } : {}),
        nextAt: sched.nextAt,
        occurrenceWorkIds: [...sched.occurrenceOrder],
      },
      revision: sched.revision,
    });
  }

  private buildOccurrenceNativeWork(
    sched: InternalScheduleState,
    occ: ScheduleOccurrenceRecord,
  ): NativeWork {
    return NativeWorkSchema.parse({
      id: occ.workId,
      kind: 'schedule',
      originActivityId: occ.latestWakeActivityId ?? sched.originActivityId,
      workflowId: sched.workflowId,
      blocking: 'detached',
      state: occ.state,
      ...(occ.outcome ? { outcome: occ.outcome } : {}),
      observedLabel: `${sched.scheduleLabel ?? '定时触发'} · #${occ.occurrenceIndex}`,
      revision: occ.revision,
    });
  }

  private buildGoalCommit(
    goal: InternalGoalState,
    works: readonly NativeWork[],
    aliases: TasksCommitBatch['aliases'],
    mutationKeyBase: string,
  ): TasksCommitBatch {
    const nowMs = this.now();
    const workflow = this.buildGoalNativeWorkflow(goal);
    const workflowDto = sanitizeNativeWorkflowForPublic(workflow, nowMs);
    const eventDrafts: NativeEventDraft[] = [
      {
        type: 'native.workflow.changed',
        turnId: goal.turnId,
        payload: {
          workflow: workflowDto,
          ...(goal.verificationArtifactIds.length > 0
            ? { resourceIds: [...goal.verificationArtifactIds] }
            : {}),
        },
        mutationKey: `${mutationKeyBase}:wf`,
      },
    ];
    for (const work of works) {
      eventDrafts.push({
        type: 'native.work.changed',
        turnId: goal.turnId,
        payload: { work: sanitizeNativeWorkForPublic(work, nowMs) },
        mutationKey: `${mutationKeyBase}:wk:${work.id}`,
      });
    }
    return {
      mutation: {
        workflows: [workflow],
        ...(works.length > 0 ? { work: works } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
      },
      eventDrafts,
      aliases,
      workflows: [workflow],
    };
  }

  private buildScheduleCommit(
    sched: InternalScheduleState,
    works: readonly NativeWork[],
    activities: readonly Activity[],
    aliases: TasksCommitBatch['aliases'],
    mutationKeyBase: string,
  ): TasksCommitBatch {
    const nowMs = this.now();
    const workflow = this.buildScheduleNativeWorkflow(sched);
    const workflowDto = sanitizeNativeWorkflowForPublic(workflow, nowMs);
    const eventDrafts: NativeEventDraft[] = [
      {
        type: 'native.workflow.changed',
        turnId: sched.turnId,
        payload: { workflow: workflowDto },
        mutationKey: `${mutationKeyBase}:wf`,
      },
    ];
    for (const work of works) {
      eventDrafts.push({
        type: 'native.work.changed',
        turnId: sched.turnId,
        payload: { work: sanitizeNativeWorkForPublic(work, nowMs) },
        mutationKey: `${mutationKeyBase}:wk:${work.id}`,
      });
    }
    for (const act of activities) {
      eventDrafts.push({
        type: 'native.activity.changed',
        turnId: act.turnId,
        payload: { activity: act },
        mutationKey: `${mutationKeyBase}:act:${act.id}`,
      });
    }
    return {
      mutation: {
        workflows: [workflow],
        ...(works.length > 0 ? { work: works } : {}),
        ...(activities.length > 0 ? { activities } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
      },
      eventDrafts,
      aliases,
      workflows: [workflow],
    };
  }

  private toGoalSnapshotDto(goal: InternalGoalState, nowMs: number): GoalObservedSnapshotDto {
    return {
      contractRevision: TASKS_WORKFLOW_CONTRACT_REVISION,
      workflowId: goal.workflowId,
      binding: goal.binding,
      originActivityId: goal.originActivityId,
      turnId: goal.turnId,
      ...(goal.objective ? { objective: goal.objective } : {}),
      lifecyclePhase: goal.lifecyclePhase,
      state: sanitizeObservedForPublic(goal.state, nowMs),
      ...(goal.outcome ? { outcome: sanitizeObservedForPublic(goal.outcome, nowMs) } : {}),
      ...(goal.replacedGoalId ? { replacedGoalId: goal.replacedGoalId } : {}),
      ...(goal.supersededByGoalId ? { supersededByGoalId: goal.supersededByGoalId } : {}),
      verificationArtifactIds: [...goal.verificationArtifactIds],
      verifications: goal.verifications.map((v) => ({
        id: v.id,
        label: v.label,
        state: sanitizeObservedForPublic(v.state, nowMs),
        ...(v.outcome ? { outcome: sanitizeObservedForPublic(v.outcome, nowMs) } : {}),
        ...(v.artifactId ? { artifactId: v.artifactId } : {}),
        ...(v.summary ? { summary: v.summary } : {}),
        evidence: toPublicEvidenceDto(v.evidence, nowMs),
        observedAt: v.observedAt,
      })),
      stop: goal.stop,
      relatedWorkIds: [...goal.relatedWorkIds],
      relatedActivityIds: [...goal.relatedActivityIds],
      revision: goal.revision,
      updatedAt: goal.updatedAt,
    };
  }

  private toScheduleSnapshotDto(sched: InternalScheduleState, nowMs: number): ScheduleObservedSnapshotDto {
    const occurrences: ScheduleOccurrenceDto[] = sched.occurrenceOrder
      .map((wid) => sched.occurrencesByWorkId.get(wid))
      .filter((o): o is ScheduleOccurrenceRecord => Boolean(o))
      .map((occ) => ({
        workId: occ.workId,
        scheduleWorkflowId: occ.scheduleWorkflowId,
        occurrenceIndex: occ.occurrenceIndex,
        ...(occ.nativeOccurrenceId ? { nativeOccurrenceId: occ.nativeOccurrenceId } : {}),
        wakeActivityIds: [...occ.wakeActivityIds],
        ...(occ.latestWakeActivityId ? { latestWakeActivityId: occ.latestWakeActivityId } : {}),
        hasObservedWake: occ.hasObservedWake,
        ...(occ.plannedAt ? { plannedAt: sanitizeObservedForPublic(occ.plannedAt, nowMs) } : {}),
        ...(occ.actualTriggeredAt
          ? { actualTriggeredAt: sanitizeObservedForPublic(occ.actualTriggeredAt, nowMs) }
          : {}),
        ...(occ.settledAt !== undefined ? { settledAt: occ.settledAt } : {}),
        timezone: sanitizeObservedForPublic(occ.timezone, nowMs),
        state: sanitizeObservedForPublic(occ.state, nowMs),
        ...(occ.outcome ? { outcome: sanitizeObservedForPublic(occ.outcome, nowMs) } : {}),
        originSource: occ.originSource,
        originGeneration: occ.originGeneration,
        recoveryState: occ.recoveryState,
        ...(occ.summary ? { summary: occ.summary } : {}),
        revision: occ.revision,
        updatedAt: occ.updatedAt,
      }));

    return {
      contractRevision: TASKS_WORKFLOW_CONTRACT_REVISION,
      workflowId: sched.workflowId,
      binding: sched.binding,
      originActivityId: sched.originActivityId,
      turnId: sched.turnId,
      scheduleKind: sched.scheduleKind,
      ...(sched.scheduleLabel ? { scheduleLabel: sched.scheduleLabel } : {}),
      ...(sched.cronExpression ? { cronExpression: sched.cronExpression } : {}),
      ...(sched.durationSeconds !== undefined ? { durationSeconds: sched.durationSeconds } : {}),
      ...(sched.timerCondition ? { timerCondition: sched.timerCondition } : {}),
      ...(sched.maxIterations !== undefined ? { maxIterations: sched.maxIterations } : {}),
      ...(sched.exactTiming !== undefined ? { exactTiming: sched.exactTiming } : {}),
      ...(sched.isDaemon !== undefined ? { isDaemon: sched.isDaemon } : {}),
      timezone: sanitizeObservedForPublic(sched.timezone, nowMs),
      nextAt: sanitizeObservedForPublic(sched.nextAt, nowMs),
      nextAtSource: sched.nextAtSource,
      state: sanitizeObservedForPublic(sched.state, nowMs),
      ...(sched.outcome ? { outcome: sanitizeObservedForPublic(sched.outcome, nowMs) } : {}),
      lifecyclePhase: sched.lifecyclePhase,
      stop: sched.stop,
      occurrences,
      occurrenceWorkIds: [...sched.occurrenceOrder],
      blocksUserTurn: false,
      deletePolicyNote: '真实已有计划的删除仍由用户经原生端完成',
      revision: sched.revision,
      updatedAt: sched.updatedAt,
    };
  }

  private recordGoalRecoveryEvidence(
    scope: TasksScopeState,
    goal: InternalGoalState,
    originSource: 'live_protocol' | 'native_snapshot' | 'replay',
    authoritativeAfterRestart: boolean,
    reasonCode: string,
    observedAt: number,
  ): void {
    const lastKnownState =
      goal.state.kind === 'known'
        ? goal.state.value
        : goal.state.kind === 'stale' && goal.state.last
          ? goal.state.last
          : 'unknown';
    this.recoveryPort.recordEvidence({
      binding: scope.binding,
      workflowId: goal.workflowId,
      workflowKind: 'goal',
      nativeWorkflowKey: goal.nativeGoalId,
      objectiveOrLabel: goal.objective,
      originSource,
      originGeneration: scope.binding.generation,
      lastKnownState,
      ...(goal.outcome?.kind === 'known' ? { lastOutcome: goal.outcome.value } : {}),
      wakeActivityIds: [],
      observedAt,
      authoritativeAfterRestart,
      reasonCode,
    });
  }

  private recordScheduleRecoveryEvidence(
    scope: TasksScopeState,
    sched: InternalScheduleState,
    occ: ScheduleOccurrenceRecord | undefined,
    originSource: 'live_protocol' | 'native_snapshot' | 'replay',
    authoritativeAfterRestart: boolean,
    reasonCode: string,
    observedAt: number,
  ): void {
    const lastKnownState = occ
      ? occ.state.kind === 'known'
        ? occ.state.value
        : occ.state.kind === 'stale' && occ.state.last
          ? occ.state.last
          : 'unknown'
      : sched.state.kind === 'known'
        ? sched.state.value
        : sched.state.kind === 'stale' && sched.state.last
          ? sched.state.last
          : 'unknown';

    this.recoveryPort.recordEvidence({
      binding: scope.binding,
      workflowId: sched.workflowId,
      workflowKind: 'schedule',
      nativeWorkflowKey: sched.nativeScheduleId,
      scheduleKind: sched.scheduleKind,
      objectiveOrLabel: sched.scheduleLabel,
      ...(occ ? { workId: occ.workId, occurrenceIndex: occ.occurrenceIndex } : {}),
      ...(occ?.nativeOccurrenceId ? { nativeOccurrenceKey: occ.nativeOccurrenceId } : {}),
      originSource,
      originGeneration: occ?.originGeneration ?? scope.binding.generation,
      lastKnownState,
      ...(occ?.outcome?.kind === 'known' ? { lastOutcome: occ.outcome.value } : {}),
      ...(occ?.plannedAt?.kind === 'known' ? { plannedAt: occ.plannedAt.value } : {}),
      ...(occ?.actualTriggeredAt?.kind === 'known' ? { actualTriggeredAt: occ.actualTriggeredAt.value } : {}),
      ...(sched.nextAt.kind === 'known' ? { nextAt: sched.nextAt.value } : {}),
      ...(sched.timezone.kind === 'known' ? { timezone: sched.timezone.value } : {}),
      wakeActivityIds: occ ? [...occ.wakeActivityIds] : [],
      observedAt,
      authoritativeAfterRestart,
      reasonCode,
    });
  }

  private appendGoalLog(
    goal: InternalGoalState,
    level: 'info' | 'warn' | 'error',
    summary: string,
    evidence: Evidence,
    createdAt: number,
  ): void {
    goal.logSeq += 1;
    goal.logs.push({
      entryId: `glog_${goal.workflowId}_${goal.logSeq}`,
      seq: goal.logSeq,
      level,
      summary: summary.slice(0, 4000),
      createdAt,
      evidence,
    });
    if (goal.logs.length > this.limits.maxLogsPerWorkflow) {
      goal.logs.splice(0, goal.logs.length - this.limits.maxLogsPerWorkflow);
    }
  }

  private appendScheduleLog(
    sched: InternalScheduleState,
    level: 'info' | 'warn' | 'error',
    summary: string,
    evidence: Evidence,
    createdAt: number,
  ): void {
    sched.logSeq += 1;
    sched.logs.push({
      entryId: `slog_${sched.workflowId}_${sched.logSeq}`,
      seq: sched.logSeq,
      level,
      summary: summary.slice(0, 4000),
      createdAt,
      evidence,
    });
    if (sched.logs.length > this.limits.maxLogsPerWorkflow) {
      sched.logs.splice(0, sched.logs.length - this.limits.maxLogsPerWorkflow);
    }
  }

  private getLiveScope(binding: RuntimeBinding, connectionId: string): TasksScopeState | null {
    const scope = this.scopes.get(slotKey(binding));
    if (!scope || !sameBinding(scope.binding, binding) || scope.connectionId !== connectionId) {
      return null;
    }
    return scope;
  }

  private hasOrRecordDedupe(scope: TasksScopeState, key: string): boolean {
    if (scope.seenDedupeKeys.has(key)) return true;
    scope.seenDedupeKeys.add(key);
    scope.seenDedupeQueue.push(key);
    if (scope.seenDedupeQueue.length > this.limits.maxDedupeKeys) {
      const oldest = scope.seenDedupeQueue.shift();
      if (oldest) scope.seenDedupeKeys.delete(oldest);
    }
    return false;
  }

  private rejectedDisabled(binding: RuntimeBinding, observedAt: number): TasksIngestResult {
    const diag = this.pushDiagnostic({
      code: 'observer_disabled_read_only',
      observedAt,
      runtimeId: binding.runtimeId,
      generation: binding.generation,
      detail: 'NP-12 observer is disabled; live mutations blocked while historical records stay read-only',
    });
    return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
  }

  private rejectedScope(
    binding: RuntimeBinding,
    observedAt: number,
    code: 'stale_generation_rejected' | 'wrong_connection_rejected',
  ): TasksIngestResult {
    const diag = this.pushDiagnostic({
      code,
      observedAt,
      runtimeId: binding.runtimeId,
      generation: binding.generation,
      detail: `Rejected frame/action (${code})`,
    });
    return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
  }

  private pushDiagnostic(diag: TasksObserverDiagnostic): TasksObserverDiagnostic {
    this.diagnostics.push(diag);
    if (this.diagnostics.length > this.limits.maxDiagnostics) {
      this.diagnostics.splice(0, this.diagnostics.length - this.limits.maxDiagnostics);
    }
    return diag;
  }
}

export type TasksScopeGenerationKey = BindingGeneration;
