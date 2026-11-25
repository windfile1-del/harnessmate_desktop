import type {
  Activity,
  ActivityId,
  CapabilityDescriptor,
  NativeRuntimeProjection,
  NativeWork,
  NativeWorkflow,
  Observed,
  WorkState,
} from '../../../../lib/native-client';
import { WORK_KIND_LABELS } from '../shared';
import type {
  CategorizedTaskItem,
  FormattedNativeTime,
  GoalCardModel,
  GoalViewMeta,
  ScheduleCardModel,
  ScheduleOccurrenceCardModel,
  ScheduleViewMeta,
  TaskCategoryFilter,
} from './types';

function formatEpochInZone(ms: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(new Date(ms));
}

function formatEpochUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function isKnownValidIana(tz: string): boolean {
  if (tz === 'UTC' || tz === 'GMT') return true;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats a native timestamp with explicit native timezone or honest `原生时区未知` + UTC.
 * NEVER falls back to browser local timezone as if it were the native schedule timezone.
 */
export function formatNativeTime(
  nextAt?: Observed<number>,
  timezone?: Observed<string>,
): FormattedNativeTime {
  const tzKnown = timezone?.kind === 'known' ? timezone.value.trim() : null;
  const tzStaleLast = timezone?.kind === 'stale' ? timezone.last?.trim() : null;
  const activeTz = tzKnown ?? tzStaleLast ?? null;

  const timezoneLabel = tzKnown
    ? `原生时区：${tzKnown}`
    : tzStaleLast
      ? `原记录时区（已过期）：${tzStaleLast}`
      : '原生时区未知';

  if (!nextAt || nextAt.kind === 'unknown') {
    return {
      text: '未由原生端提供（不本地猜测）',
      timezoneLabel,
      timezoneKnown: Boolean(tzKnown),
      nextAtKnown: false,
      isStale: false,
    };
  }

  const epoch = nextAt.kind === 'known' ? nextAt.value : nextAt.last;
  if (epoch === undefined) {
    return {
      text: '上次时间记录已过期',
      timezoneLabel,
      timezoneKnown: Boolean(tzKnown),
      nextAtKnown: false,
      isStale: true,
    };
  }

  const formattedClock =
    activeTz && isKnownValidIana(activeTz)
      ? `${formatEpochInZone(epoch, activeTz)} (${activeTz})`
      : `${formatEpochUtc(epoch)}（原生时区未知，以 UTC 显示）`;

  if (nextAt.kind === 'stale') {
    return {
      text: `${formattedClock} · 观测已过期`,
      timezoneLabel,
      timezoneKnown: Boolean(tzKnown),
      nextAtKnown: false,
      isStale: true,
    };
  }

  return {
    text: formattedClock,
    timezoneLabel,
    timezoneKnown: Boolean(tzKnown),
    nextAtKnown: true,
    isStale: false,
  };
}

export function selectGoalCards(
  projection: NativeRuntimeProjection,
  goalMetaByWorkflowId?: Readonly<Record<string, GoalViewMeta>>,
): GoalCardModel[] {
  return projection.workflows
    .filter(
      (wf): wf is NativeWorkflow & { detail: Extract<NativeWorkflow['detail'], { kind: 'goal' }> } =>
        wf.detail.kind === 'goal',
    )
    .map((wf) => ({
      workflow: wf,
      objective: wf.detail.objective ?? '目标内容待原生端确认',
      verificationArtifactIds: wf.detail.verificationArtifactIds ?? [],
      meta: goalMetaByWorkflowId?.[wf.id],
    }));
}

function resolveWakeActivitiesForOccurrence(
  activities: readonly Activity[],
  workId: string,
  originActivityId: ActivityId,
): ActivityId[] {
  const matched = activities
    .filter((act) => act.workId === workId && (act.turnId === null || act.id !== originActivityId))
    .map((act) => act.id);
  return matched;
}

export function selectScheduleCards(
  projection: NativeRuntimeProjection,
  scheduleMetaByWorkflowId?: Readonly<Record<string, ScheduleViewMeta>>,
): ScheduleCardModel[] {
  const workById = new Map<string, NativeWork>(projection.work.map((w) => [w.id, w]));

  return projection.workflows
    .filter(
      (wf): wf is NativeWorkflow & { detail: Extract<NativeWorkflow['detail'], { kind: 'schedule' }> } =>
        wf.detail.kind === 'schedule',
    )
    .map((wf) => {
      const meta = scheduleMetaByWorkflowId?.[wf.id];
      const metaOccMap = new Map(
        (meta?.occurrences ?? []).map((o) => [o.workId, o]),
      );

      const occurrences: ScheduleOccurrenceCardModel[] = wf.detail.occurrenceWorkIds.map(
        (workId, idx) => {
          const work = workById.get(workId) ?? null;
          const occMeta = metaOccMap.get(workId);
          const wakeFromMeta = occMeta?.wakeActivityIds ?? [];
          const wakeFromActivities = resolveWakeActivitiesForOccurrence(
            projection.activities,
            workId,
            wf.originActivityId,
          );
          const mergedWakeIds = [...new Set([...wakeFromMeta, ...wakeFromActivities])];
          const state: Observed<WorkState> =
            work?.state ?? { kind: 'unknown', reasonCode: 'occurrence_work_missing' };

          return {
            workId,
            work,
            occurrenceIndex: occMeta?.occurrenceIndex ?? idx + 1,
            state,
            outcome: work?.outcome,
            plannedAt: occMeta?.plannedAt,
            actualTriggeredAt: occMeta?.actualTriggeredAt,
            timezone: occMeta?.timezone ?? meta?.timezone,
            wakeActivityIds: mergedWakeIds,
            latestWakeActivityId: mergedWakeIds[mergedWakeIds.length - 1] ?? null,
            hasObservedWake: mergedWakeIds.length > 0,
            recoveryState:
              occMeta?.recoveryState ??
              (state.kind === 'stale' ? 'stale_unconfirmed' : 'live'),
            originSource:
              occMeta?.originSource ??
              (state.kind === 'known' ? state.evidence.sourceKind : 'unknown'),
            summary: occMeta?.summary ?? work?.observedLabel,
          };
        },
      );

      const scheduleKind =
        meta?.scheduleKind ??
        (meta?.cronExpression
          ? 'cron'
          : meta?.durationSeconds !== undefined
            ? 'one_shot'
            : 'unknown');

      return {
        workflow: wf,
        scheduleLabel: wf.detail.scheduleLabel ?? `定时计划 (${wf.id})`,
        scheduleKind,
        cronExpression: meta?.cronExpression,
        durationSeconds: meta?.durationSeconds,
        timerCondition: meta?.timerCondition,
        timezone: meta?.timezone,
        nextAt: wf.detail.nextAt,
        nextAtSource:
          meta?.nextAtSource ??
          (wf.detail.nextAt?.kind === 'known' ? 'native_wire_timestamp' : 'not_exposed'),
        formattedNextAt: formatNativeTime(wf.detail.nextAt, meta?.timezone),
        occurrences,
      };
    });
}

export function buildCategorizedTasks(
  projection: NativeRuntimeProjection,
): {
  readonly items: readonly CategorizedTaskItem[];
  readonly countsByCategory: Readonly<Record<TaskCategoryFilter, number>>;
} {
  const items: CategorizedTaskItem[] = [];
  const counts: Record<TaskCategoryFilter, number> = {
    all: 0,
    goal: 0,
    schedule: 0,
    finite_command: 0,
    daemon: 0,
    workflow_step: 0,
    subagent: 0,
    unknown: 0,
  };

  for (const wf of projection.workflows) {
    if (wf.detail.kind === 'goal') {
      counts.goal += 1;
      counts.all += 1;
      items.push({
        id: wf.id,
        category: 'goal',
        kindLabel: 'Goal 目标',
        title: wf.detail.objective ?? `Goal (${wf.id})`,
        blocking: 'unknown',
        state: wf.state,
        workflowId: wf.id,
        originActivityId: wf.originActivityId,
        kind: 'goal',
      });
    } else if (wf.detail.kind === 'schedule') {
      counts.schedule += 1;
      counts.all += 1;
      items.push({
        id: wf.id,
        category: 'schedule',
        kindLabel: 'Schedule 定时',
        title: wf.detail.scheduleLabel ?? `Schedule (${wf.id})`,
        blocking: 'detached',
        state: wf.state,
        workflowId: wf.id,
        originActivityId: wf.originActivityId,
        kind: 'schedule',
      });
    }
  }

  for (const work of projection.work) {
    const cat = work.kind;
    counts[cat] += 1;
    counts.all += 1;
    items.push({
      id: work.id,
      category: cat,
      kindLabel: WORK_KIND_LABELS[work.kind],
      title: work.observedLabel ?? `${WORK_KIND_LABELS[work.kind]} (${work.id})`,
      blocking: work.blocking,
      state: work.state,
      outcome: work.outcome,
      workId: work.id,
      workflowId: work.workflowId,
      originActivityId: work.originActivityId,
      kind: work.kind,
    });
  }

  return { items, countsByCategory: counts };
}

export function findTasksCapability(
  capabilities: readonly CapabilityDescriptor[],
  capabilityIds: readonly string[],
): CapabilityDescriptor | null {
  for (const id of capabilityIds) {
    const found = capabilities.find((c) => c.id === id);
    if (found) return found;
  }
  return null;
}

export function resolveTasksControlGate(
  capabilities: readonly CapabilityDescriptor[],
  capabilityIds: readonly string[],
  readOnlyDisabledMode = false,
): {
  readonly capability: CapabilityDescriptor | null;
  readonly controlAvailable: boolean;
  readonly reason: string;
} {
  const capability = findTasksCapability(capabilities, capabilityIds);
  if (readOnlyDisabledMode) {
    return {
      capability,
      controlAvailable: false,
      reason: '观测动作已关闭：当前仅允许只读查看历史与到期记录。',
    };
  }
  if (!capability || capability.control !== 'available') {
    return {
      capability,
      controlAvailable: false,
      reason: '当前绑定未确认可直接控制，请使用官方原生端入口。',
    };
  }
  return {
    capability,
    controlAvailable: true,
    reason: '当前绑定允许经原生控制路径操作。',
  };
}
