import type { NativeWorkKind, WorkOutcome, WorkState } from '@harnessmate/protocol';
import type { NativeIngress } from '../../wiring/types.js';
import { isValidNativeTimezone, isValidOpaqueArtifactId } from './ports.js';
import type { ScheduleKind } from './types.js';

export type PatchField<T> =
  | { readonly op: 'omit' }
  | { readonly op: 'clear' }
  | { readonly op: 'set'; readonly value: T };

export type DecodedTasksFrame =
  | {
      readonly kind: 'goal_update';
      readonly nativeGoalId: string;
      readonly toolCallId?: string;
      readonly objective?: string;
      readonly replacesGoalId?: string;
      readonly replaceActiveGoal: boolean;
      readonly verificationArtifactIds: readonly string[];
      readonly rejectedArtifactRefs: readonly string[];
      readonly verificationSummary?: string;
      readonly verificationLabel?: string;
      readonly state: PatchField<WorkState>;
      readonly stateReasonCode?: string;
      readonly outcome: PatchField<WorkOutcome>;
      readonly outcomeReasonCode?: string;
      readonly semanticEventId?: string;
    }
  | {
      readonly kind: 'schedule_upsert';
      readonly nativeScheduleId: string;
      readonly toolCallId?: string;
      readonly scheduleKind: ScheduleKind;
      readonly scheduleLabel?: string;
      readonly cronExpression?: string;
      readonly durationSeconds?: number;
      readonly timerCondition?: string;
      readonly maxIterations?: number;
      readonly exactTiming?: boolean;
      readonly isDaemon?: boolean;
      readonly sessionBoundTimer?: boolean;
      readonly nextAt?: number;
      readonly nextAtSource: 'native_wire_timestamp' | 'not_exposed';
      readonly timezone?: string;
      readonly invalidTimezoneIgnored?: boolean;
      readonly state: PatchField<WorkState>;
      readonly stateReasonCode?: string;
      readonly outcome: PatchField<WorkOutcome>;
      readonly outcomeReasonCode?: string;
      readonly semanticEventId?: string;
    }
  | {
      readonly kind: 'schedule_occurrence_triggered';
      readonly nativeScheduleId: string;
      readonly nativeOccurrenceId?: string;
      readonly occurrenceIndex?: number;
      readonly toolCallId?: string;
      readonly plannedAt?: number;
      readonly actualTriggeredAt?: number;
      readonly timezone?: string;
      readonly nextAt?: number;
      readonly summary?: string;
      readonly wakeActivityHint?: string;
      readonly state: PatchField<WorkState>;
      readonly stateReasonCode?: string;
      readonly outcome: PatchField<WorkOutcome>;
      readonly outcomeReasonCode?: string;
      readonly semanticEventId?: string;
    }
  | {
      readonly kind: 'schedule_cancelled';
      readonly nativeScheduleId: string;
      readonly nativeOccurrenceId?: string;
      readonly toolCallId?: string;
      readonly reasonCode: string;
      readonly summary?: string;
      readonly semanticEventId?: string;
    }
  | {
      readonly kind: 'wake_activity_signal';
      readonly nativeScheduleId?: string;
      readonly nativeOccurrenceId?: string;
      readonly sourceWorkIdHint?: string;
      readonly toolCallId?: string;
      readonly summary: string;
      readonly completed?: boolean;
      readonly outcome?: WorkOutcome;
      readonly semanticEventId?: string;
    }
  | {
      readonly kind: 'background_work_update';
      readonly toolCallId: string;
      readonly backgroundTaskId?: string;
      readonly workKind: NativeWorkKind;
      readonly blocking: 'confirmed_blocking' | 'detached' | 'unknown';
      readonly label?: string;
      readonly state: PatchField<WorkState>;
      readonly stateReasonCode?: string;
      readonly outcome: PatchField<WorkOutcome>;
      readonly outcomeReasonCode?: string;
      readonly semanticEventId?: string;
    }
  | {
      readonly kind: 'app_only_automation_notice';
      readonly capabilityId: 'AGY-W12' | 'AGY-E08';
      readonly reasonCode: string;
      readonly summary: string;
    }
  | { readonly kind: 'ignored' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function omit<T>(): PatchField<T> {
  return { op: 'omit' };
}

function set<T>(value: T): PatchField<T> {
  return { op: 'set', value };
}

function pickString(obj: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function pickBoolean(obj: Record<string, unknown> | null, keys: readonly string[]): boolean | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    if (typeof obj[key] === 'boolean') return obj[key] as boolean;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown> | null, keys: readonly string[]): number | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return undefined;
}

/**
 * Parses an authoritative wire timestamp ONLY if explicitly present as epoch ms or
 * an ISO-8601 string carrying an explicit UTC `Z` or offset. NEVER fabricates timestamps locally.
 */
function pickAuthoritativeEpochMs(
  sources: ReadonlyArray<Record<string, unknown> | null>,
  keys: readonly string[],
): number | undefined {
  for (const src of sources) {
    if (!src) continue;
    for (const key of keys) {
      const val = src[key];
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
        return Math.trunc(val);
      }
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
          const parsed = Date.parse(trimmed);
          if (Number.isFinite(parsed) && parsed >= 0) {
            return Math.trunc(parsed);
          }
        }
      }
    }
  }
  return undefined;
}

function decodeStateAndOutcome(
  update: Record<string, unknown>,
  rawOutput: Record<string, unknown> | null,
  statusContainer: Record<string, unknown> | null,
): {
  state: PatchField<WorkState>;
  stateReasonCode?: string;
  outcome: PatchField<WorkOutcome>;
  outcomeReasonCode?: string;
} {
  const exitCode =
    rawOutput && typeof rawOutput.exitCode === 'number' && Number.isInteger(rawOutput.exitCode)
      ? rawOutput.exitCode
      : undefined;
  const isErrorFlag = rawOutput?.isError === true || rawOutput?.ok === false;
  const isExplicitOk =
    rawOutput?.ok === true ||
    rawOutput?.verified === true ||
    rawOutput?.status === 'ok' ||
    rawOutput?.status === 'succeeded';

  const hasStatusInUpdate = 'status' in update;
  const hasStatusInContainer = Boolean(statusContainer && 'status' in statusContainer);
  const rawStatusValue = hasStatusInUpdate
    ? update.status
    : hasStatusInContainer
      ? statusContainer!.status
      : undefined;

  if (!hasStatusInUpdate && !hasStatusInContainer) {
    if (exitCode !== undefined && exitCode !== 0) {
      return { state: set('failed'), outcome: set('failed') };
    }
    return { state: omit(), outcome: omit() };
  }

  if (rawStatusValue === null) {
    return { state: set('unknown'), stateReasonCode: 'wire_status_null', outcome: omit() };
  }

  const normalized = typeof rawStatusValue === 'string' ? rawStatusValue.trim().toLowerCase() : '';
  switch (normalized) {
    case 'queued':
    case 'pending':
    case 'created':
    case 'armed':
    case 'scheduled':
      return { state: set(normalized === 'queued' || normalized === 'pending' ? 'queued' : 'waiting'), outcome: omit() };
    case 'running':
    case 'in_progress':
    case 'active':
    case 'verifying':
    case 'triggered':
      return { state: set('running'), outcome: omit() };
    case 'waiting':
    case 'paused':
      return { state: set('waiting'), outcome: omit() };
    case 'requires_action':
    case 'awaiting_approval':
    case 'awaiting_input':
      return { state: set('requires_action'), outcome: omit() };
    case 'failed':
    case 'error':
      return { state: set('failed'), outcome: set('failed') };
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'stopped':
    case 'killed':
      return { state: set('cancelled'), outcome: set('cancelled') };
    case 'completed':
    case 'done':
    case 'finished':
    case 'succeeded':
    case 'verified': {
      if ((exitCode !== undefined && exitCode !== 0) || isErrorFlag) {
        return { state: set('failed'), outcome: set('failed') };
      }
      if (exitCode === 0 || isExplicitOk || normalized === 'succeeded' || normalized === 'verified') {
        return { state: set('finished'), outcome: set('succeeded') };
      }
      return {
        state: set('finished'),
        outcome: omit(),
        outcomeReasonCode: 'outcome_not_reported_by_wire',
      };
    }
    default:
      return {
        state: set('unknown'),
        stateReasonCode: normalized ? `unrecognized_wire_status:${normalized.slice(0, 48)}` : 'wire_status_empty',
        outcome: omit(),
      };
  }
}

export function decodeTasksIngressFrame(
  envelope: NativeIngress,
  opts?: { readonly strictMode?: boolean },
): DecodedTasksFrame {
  const strictMode = opts?.strictMode ?? false;
  const wire = envelope.wire;
  if (!isRecord(wire) || wire.method !== 'session/update' || !isRecord(wire.params)) {
    return { kind: 'ignored' };
  }

  const params = wire.params;
  const update = isRecord(params.update) ? params.update : params;
  const sessionUpdate = pickString(update, ['sessionUpdate', 'type']) ?? '';
  const toolCallId = pickString(update, ['toolCallId']);
  const title = pickString(update, ['title']) ?? '';
  const toolName = pickString(update, ['toolName']) ?? '';
  const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : null;
  const meta = isRecord(update._meta) ? update._meta : isRecord(params._meta) ? params._meta : null;
  const semanticEventId = pickString(update, ['eventId', 'updateId']);

  // 1. App-only Automations & Sidecars boundary closure (never emulated as ACP!)
  const automationObj = isRecord(update.automation) ? update.automation : isRecord(meta?.automation) ? meta.automation : null;
  if (
    automationObj ||
    toolName === 'automation' ||
    /^\/?automation\b/i.test(title) ||
    sessionUpdate === 'automation_update'
  ) {
    return {
      kind: 'app_only_automation_notice',
      capabilityId: 'AGY-W12',
      reasonCode: 'app_automation_outside_acp_boundary',
      summary: '检测到 /automation 提及；App Automations 仅限官方桌面 App 持久管理，不仿成 ACP 或 HM 调度器。',
    };
  }
  if (toolName === 'sidecar' || /\bsidecar\b|\bagentapi\b/i.test(title)) {
    return {
      kind: 'app_only_automation_notice',
      capabilityId: 'AGY-E08',
      reasonCode: 'app_sidecar_outside_acp_boundary',
      summary: '检测到 Sidecar/agentapi 提及；Sidecars 属官方 App 生命周期管理，不仿成 ACP。',
    };
  }

  // 2. Post-turn Wake Continuation Signals (agent_message_chunk / tool_call carrying wake metadata)
  const wakeFromScheduleId =
    pickString(meta, ['wakeFromScheduleId', 'scheduleId', 'sourceWorkflowId']) ??
    pickString(update, ['wakeFromScheduleId']);
  const wakeOccurrenceId =
    pickString(meta, ['occurrenceId', 'nativeOccurrenceId']) ??
    pickString(update, ['occurrenceId', 'nativeOccurrenceId']);
  const wakeWorkHint =
    pickString(meta, ['sourceWorkId', 'workId']) ?? pickString(update, ['sourceWorkId']);
  if (
    (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'agent_thought_chunk') &&
    (wakeFromScheduleId || wakeOccurrenceId || wakeWorkHint)
  ) {
    const content = isRecord(update.content) ? update.content : null;
    const text = pickString(content, ['text']) ?? '定时唤醒续跑输出';
    return {
      kind: 'wake_activity_signal',
      ...(wakeFromScheduleId ? { nativeScheduleId: wakeFromScheduleId } : {}),
      ...(wakeOccurrenceId ? { nativeOccurrenceId: wakeOccurrenceId } : {}),
      ...(wakeWorkHint ? { sourceWorkIdHint: wakeWorkHint } : {}),
      summary: text.slice(0, 320),
      completed: pickBoolean(meta, ['wakeCompleted']) ?? pickBoolean(update, ['wakeCompleted']),
      ...(pickString(meta, ['outcome']) === 'succeeded'
        ? { outcome: 'succeeded' }
        : pickString(meta, ['outcome']) === 'failed'
          ? { outcome: 'failed' }
          : {}),
      ...(semanticEventId ? { semanticEventId } : {}),
    };
  }

  // 3. Goal updates
  const goalObj = isRecord(update.goal)
    ? update.goal
    : isRecord(meta?.goal)
      ? meta.goal
      : isRecord(rawOutput?.goal)
        ? rawOutput.goal
        : null;
  const isGoalTool =
    sessionUpdate === 'goal_update' ||
    Boolean(goalObj) ||
    toolName === 'goal' ||
    (!strictMode && /^\/?goal\b/i.test(title));

  if (isGoalTool) {
    const nativeGoalId =
      pickString(goalObj, ['goalId', 'id', 'nativeGoalId']) ??
      pickString(rawInput, ['goalId', 'id']) ??
      pickString(rawOutput, ['goalId', 'id']) ??
      toolCallId ??
      'goal_primary';
    const objective =
      pickString(goalObj, ['objective', 'goal', 'description']) ??
      pickString(rawInput, ['objective', 'Objective', 'goal', 'Goal', 'Prompt', 'text']) ??
      (title && !/^\/?goal$/i.test(title) ? title.replace(/^\/?goal\s*/i, '').trim() || undefined : undefined);
    const replacesGoalId =
      pickString(goalObj, ['replacesGoalId', 'supersedes']) ??
      pickString(rawInput, ['replacesGoalId', 'supersedes']);
    const replaceActiveGoal =
      Boolean(replacesGoalId) ||
      pickBoolean(goalObj, ['replace', 'replacesActive']) === true ||
      pickBoolean(rawInput, ['replace', 'replacesActive']) === true;

    const rawArtifactList: unknown[] = [
      ...(Array.isArray(goalObj?.verificationArtifactIds) ? goalObj.verificationArtifactIds : []),
      ...(Array.isArray(rawOutput?.verificationArtifactIds) ? rawOutput.verificationArtifactIds : []),
      ...(typeof rawOutput?.verificationArtifactId === 'string' ? [rawOutput.verificationArtifactId] : []),
      ...(typeof goalObj?.verificationArtifactId === 'string' ? [goalObj.verificationArtifactId] : []),
    ];
    const verificationArtifactIds: string[] = [];
    const rejectedArtifactRefs: string[] = [];
    for (const cand of rawArtifactList) {
      if (typeof cand !== 'string' || !cand.trim()) continue;
      const trimmed = cand.trim();
      if (isValidOpaqueArtifactId(trimmed)) {
        if (!verificationArtifactIds.includes(trimmed)) verificationArtifactIds.push(trimmed);
      } else {
        rejectedArtifactRefs.push(trimmed);
      }
    }

    const verificationSummary =
      pickString(goalObj, ['verificationSummary', 'summary']) ??
      pickString(rawOutput, ['verificationSummary', 'stdout', 'message']);
    const verificationLabel = pickString(goalObj, ['verificationLabel', 'stepLabel']);
    const statusParsed = decodeStateAndOutcome(update, rawOutput, goalObj);

    return {
      kind: 'goal_update',
      nativeGoalId,
      ...(toolCallId ? { toolCallId } : {}),
      ...(objective ? { objective: objective.slice(0, 1000) } : {}),
      ...(replacesGoalId ? { replacesGoalId } : {}),
      replaceActiveGoal,
      verificationArtifactIds,
      rejectedArtifactRefs,
      ...(verificationSummary ? { verificationSummary: verificationSummary.slice(0, 400) } : {}),
      ...(verificationLabel ? { verificationLabel: verificationLabel.slice(0, 200) } : {}),
      ...statusParsed,
      ...(semanticEventId ? { semanticEventId } : {}),
    };
  }

  // 4. Early Schedule Cancellation via manage_task(Action: "kill", TaskId)
  const isManageTask =
    toolName === 'manage_task' ||
    (!strictMode && /\bmanage_task\b/i.test(title)) ||
    (rawInput !== null && typeof rawInput.Action === 'string' && typeof rawInput.TaskId === 'string');
  if (isManageTask && rawInput?.Action === 'kill' && typeof rawInput.TaskId === 'string') {
    const taskId = rawInput.TaskId.trim();
    if (taskId) {
      return {
        kind: 'schedule_cancelled',
        nativeScheduleId: taskId,
        ...(toolCallId ? { toolCallId } : {}),
        reasonCode: pickString(rawInput, ['reason', 'reasonCode']) ?? 'manage_task_kill_requested',
        summary: pickString(rawOutput, ['message', 'stdout']) ?? `通过 manage_task(kill) 取消任务 ${taskId}`,
        ...(semanticEventId ? { semanticEventId } : {}),
      };
    }
  }

  // 5. Schedule Occurrence Trigger
  const scheduleObj = isRecord(update.schedule)
    ? update.schedule
    : isRecord(meta?.schedule)
      ? meta.schedule
      : isRecord(rawOutput?.schedule)
        ? rawOutput.schedule
        : null;
  const occurrenceObj = isRecord(update.occurrence)
    ? update.occurrence
    : isRecord(rawOutput?.occurrence)
      ? rawOutput.occurrence
      : isRecord(meta?.occurrence)
        ? meta.occurrence
        : null;
  const isOccurrenceTrigger =
    sessionUpdate === 'schedule_triggered' ||
    Boolean(occurrenceObj) ||
    rawOutput?.triggered === true ||
    Boolean(update.scheduleTrigger);

  if (isOccurrenceTrigger) {
    const nativeScheduleId =
      pickString(occurrenceObj, ['scheduleId', 'nativeScheduleId', 'taskId']) ??
      pickString(scheduleObj, ['scheduleId', 'id', 'taskId']) ??
      pickString(rawInput, ['scheduleId', 'taskId']) ??
      pickString(rawOutput, ['scheduleId', 'taskId']) ??
      toolCallId ??
      'schedule_primary';
    const nativeOccurrenceId =
      pickString(occurrenceObj, ['occurrenceId', 'id', 'nativeOccurrenceId']) ??
      pickString(rawOutput, ['occurrenceId']);
    const occurrenceIndex = pickNumber(occurrenceObj ?? rawOutput, ['occurrenceIndex', 'index', 'iteration']);
    const plannedAt = pickAuthoritativeEpochMs([occurrenceObj, rawOutput, update], ['plannedAt', 'scheduledAt']);
    const actualTriggeredAt = pickAuthoritativeEpochMs(
      [occurrenceObj, rawOutput, update],
      ['actualTriggeredAt', 'triggeredAt', 'firedAt'],
    );
    const nextAt = pickAuthoritativeEpochMs([scheduleObj, rawOutput, update], [
      'nextAt',
      'nextRunAt',
      'fireAt',
      'nextFireAt',
    ]);
    const rawTz = pickString(occurrenceObj ?? scheduleObj ?? rawOutput ?? update, [
      'timezone',
      'timeZone',
      'tz',
      'ianaTimezone',
    ]);
    const timezone = rawTz && isValidNativeTimezone(rawTz) ? rawTz : undefined;
    const statusParsed = decodeStateAndOutcome(update, rawOutput, occurrenceObj);

    return {
      kind: 'schedule_occurrence_triggered',
      nativeScheduleId,
      ...(nativeOccurrenceId ? { nativeOccurrenceId } : {}),
      ...(occurrenceIndex !== undefined ? { occurrenceIndex: Math.trunc(occurrenceIndex) } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(plannedAt !== undefined ? { plannedAt } : {}),
      ...(actualTriggeredAt !== undefined ? { actualTriggeredAt } : {}),
      ...(timezone ? { timezone } : {}),
      ...(nextAt !== undefined ? { nextAt } : {}),
      ...(pickString(occurrenceObj ?? rawOutput, ['summary', 'message', 'stdout'])
        ? { summary: pickString(occurrenceObj ?? rawOutput, ['summary', 'message', 'stdout'])!.slice(0, 320) }
        : {}),
      ...(pickString(occurrenceObj ?? meta, ['wakeActivityId', 'wakeHint'])
        ? { wakeActivityHint: pickString(occurrenceObj ?? meta, ['wakeActivityId', 'wakeHint']) }
        : {}),
      ...statusParsed,
      ...(semanticEventId ? { semanticEventId } : {}),
    };
  }

  // 6. Schedule Upsert / Cancel
  const cronExpr =
    pickString(rawInput, ['CronExpression', 'cronExpression', 'cron']) ??
    pickString(scheduleObj, ['cronExpression', 'cron']);
  const durationSeconds =
    pickNumber(rawInput, ['DurationSeconds', 'durationSeconds']) ??
    pickNumber(scheduleObj, ['durationSeconds']);
  const isScheduleFrame =
    sessionUpdate === 'schedule_update' ||
    Boolean(scheduleObj) ||
    toolName === 'schedule' ||
    cronExpr !== undefined ||
    durationSeconds !== undefined ||
    (!strictMode && /^\/?schedule\b/i.test(title));

  if (isScheduleFrame) {
    const nativeScheduleId =
      pickString(scheduleObj, ['scheduleId', 'id', 'taskId']) ??
      pickString(rawOutput, ['scheduleId', 'taskId']) ??
      pickString(rawInput, ['scheduleId', 'taskId']) ??
      toolCallId ??
      'schedule_primary';

    const statusParsed = decodeStateAndOutcome(update, rawOutput, scheduleObj);
    const cancelledEarly =
      pickBoolean(scheduleObj ?? update, ['cancelledEarly']) === true ||
      (statusParsed.state.op === 'set' && statusParsed.state.value === 'cancelled');

    if (cancelledEarly) {
      return {
        kind: 'schedule_cancelled',
        nativeScheduleId,
        ...(toolCallId ? { toolCallId } : {}),
        reasonCode:
          pickString(scheduleObj ?? rawOutput ?? update, ['cancelReason', 'reasonCode']) ??
          'schedule_cancelled_native',
        summary:
          pickString(scheduleObj ?? rawOutput, ['summary', 'message']) ??
          '定时任务已在触发前或运行中被原生端取消',
        ...(semanticEventId ? { semanticEventId } : {}),
      };
    }

    const scheduleKind: ScheduleKind = cronExpr
      ? 'cron'
      : durationSeconds !== undefined && durationSeconds >= 0
        ? 'one_shot'
        : (pickString(scheduleObj, ['scheduleKind']) as ScheduleKind | undefined) ?? 'unknown';

    const nextAt = pickAuthoritativeEpochMs([scheduleObj, rawOutput, update], [
      'nextAt',
      'nextRunAt',
      'fireAt',
      'nextFireAt',
      'scheduledAt',
    ]);
    const rawTz = pickString(scheduleObj ?? rawInput ?? rawOutput ?? update, [
      'timezone',
      'timeZone',
      'tz',
      'ianaTimezone',
    ]);
    const timezone = rawTz && isValidNativeTimezone(rawTz) ? rawTz : undefined;
    const invalidTimezoneIgnored = Boolean(rawTz && !timezone);

    const scheduleLabel =
      pickString(scheduleObj, ['label', 'scheduleLabel', 'prompt']) ??
      pickString(rawInput, ['Prompt', 'prompt']) ??
      (title ? title.slice(0, 240) : undefined);

    return {
      kind: 'schedule_upsert',
      nativeScheduleId,
      ...(toolCallId ? { toolCallId } : {}),
      scheduleKind,
      ...(scheduleLabel ? { scheduleLabel: scheduleLabel.slice(0, 240) } : {}),
      ...(cronExpr ? { cronExpression: cronExpr } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(pickString(rawInput ?? scheduleObj, ['TimerCondition', 'timerCondition'])
        ? { timerCondition: pickString(rawInput ?? scheduleObj, ['TimerCondition', 'timerCondition']) }
        : {}),
      ...(pickNumber(rawInput ?? scheduleObj, ['MaxIterations', 'maxIterations']) !== undefined
        ? { maxIterations: Math.trunc(pickNumber(rawInput ?? scheduleObj, ['MaxIterations', 'maxIterations'])!) }
        : {}),
      ...(pickBoolean(rawInput ?? scheduleObj, ['ExactTiming', 'exactTiming']) !== undefined
        ? { exactTiming: pickBoolean(rawInput ?? scheduleObj, ['ExactTiming', 'exactTiming']) }
        : {}),
      ...(pickBoolean(rawInput ?? scheduleObj, ['IsDaemon', 'isDaemon']) !== undefined
        ? { isDaemon: pickBoolean(rawInput ?? scheduleObj, ['IsDaemon', 'isDaemon']) }
        : {}),
      ...(pickBoolean(scheduleObj ?? meta, ['sessionBoundTimer']) !== undefined
        ? { sessionBoundTimer: pickBoolean(scheduleObj ?? meta, ['sessionBoundTimer']) }
        : {}),
      ...(nextAt !== undefined ? { nextAt } : {}),
      nextAtSource: nextAt !== undefined ? 'native_wire_timestamp' : 'not_exposed',
      ...(timezone ? { timezone } : {}),
      ...(invalidTimezoneIgnored ? { invalidTimezoneIgnored: true } : {}),
      ...statusParsed,
      ...(semanticEventId ? { semanticEventId } : {}),
    };
  }

  // 7. Background Finite / Daemon Work (for Runtime Center aggregation)
  if ((sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') && toolCallId) {
    const isDaemon = rawInput?.IsDaemon === true || rawInput?.isDaemon === true;
    const bgTaskId = pickString(rawInput, ['backgroundTaskId']);
    const isFiniteBg = rawInput?.isBackground === true || Boolean(bgTaskId);
    if (isDaemon || isFiniteBg) {
      const statusParsed = decodeStateAndOutcome(update, rawOutput, null);
      const label =
        title ||
        pickString(rawInput, ['CommandLine', 'command', 'Prompt']) ||
        undefined;
      return {
        kind: 'background_work_update',
        toolCallId,
        ...(bgTaskId ? { backgroundTaskId: bgTaskId } : {}),
        workKind: isDaemon ? 'daemon' : 'finite_command',
        blocking: isDaemon ? 'detached' : 'confirmed_blocking',
        ...(label ? { label: label.slice(0, 240) } : {}),
        ...statusParsed,
        ...(semanticEventId ? { semanticEventId } : {}),
      };
    }
  }

  // 8. Fallback wake signal if frame arrives after turn end on an active schedule wake
  if (sessionUpdate === 'agent_message_chunk' && wakeFromScheduleId === undefined && wakeOccurrenceId === undefined) {
    const content = isRecord(update.content) ? update.content : null;
    const text = pickString(content, ['text']);
    if (text && pickBoolean(update, ['isWakeContinuation']) === true) {
      return {
        kind: 'wake_activity_signal',
        summary: text.slice(0, 320),
        ...(semanticEventId ? { semanticEventId } : {}),
      };
    }
  }

  return { kind: 'ignored' };
}
