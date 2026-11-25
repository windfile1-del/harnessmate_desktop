import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  ActivityId,
  BindingGeneration,
  CapabilityDescriptor,
  NativeRuntimeProjection,
  RuntimeId,
  WorkId,
  WorkflowId,
} from '../../../../lib/native-client';
import { makeFixtureCapabilities } from '../shared';
import type { GoalViewMeta, ScheduleViewMeta } from './types';

export interface NativeTasksFixtureBundle {
  readonly projection: NativeRuntimeProjection;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly approvals: readonly ApprovalRequest[];
  readonly goalMetaByWorkflowId: Readonly<Record<string, GoalViewMeta>>;
  readonly scheduleMetaByWorkflowId: Readonly<Record<string, ScheduleViewMeta>>;
  readonly loadWorkflowResource: (
    workflowId: WorkflowId,
    resource: string,
  ) => Promise<{
    schemaVersion: 1;
    binding: NativeRuntimeProjection['binding'];
    workflowId: WorkflowId;
    resource: 'logs' | 'phases' | 'board' | 'artifacts';
    revision: number;
    available: boolean;
    items: Array<{
      kind: 'log_entry';
      entryId: string;
      seq: number;
      level: 'info' | 'warn' | 'error';
      summary: string;
      truncated: boolean;
      createdAt: number;
      evidence: { sourceKind: 'live_protocol'; freshness: 'live'; observedAt: number };
    }>;
    nextPageToken: null;
    hasMore: boolean;
  }>;
}

export function createGoalAndScheduleTasksFixture(
  sessionId: string,
  mode: 'live_wake_and_cron' | 'disconnected_expired_readonly' = 'live_wake_and_cron',
): NativeTasksFixtureBundle {
  const runtimeId = 'rt_np12_1' as RuntimeId;
  const generation = 'gen_np12_1' as BindingGeneration;
  const binding = { runtimeId, sessionId, instanceId: 'agy', generation };
  const liveEv = { sourceKind: 'live_protocol' as const, freshness: 'live' as const, observedAt: 1_764_100_010_000 };
  const staleEv = { sourceKind: 'host_observation' as const, freshness: 'stale' as const, observedAt: 1_764_100_090_000 };

  const wfGoalOld = 'wf_goal_old' as WorkflowId;
  const wfGoalNew = 'wf_goal_new' as WorkflowId;
  const wfSchedOneShot = 'wf_sched_oneshot' as WorkflowId;
  const wfSchedCron = 'wf_sched_cron' as WorkflowId;
  const occ1Work = 'wrk_occ_1' as WorkId;
  const occ2Work = 'wrk_occ_2' as WorkId;
  const occ3Work = 'wrk_occ_3' as WorkId;
  const finiteWork = 'wrk_finite_1' as WorkId;
  const daemonWork = 'wrk_daemon_1' as WorkId;

  const actOriginGoal = 'act_goal_1' as ActivityId;
  const actOriginSched = 'act_sched_1' as ActivityId;
  const actWakeOneShot = 'act_wake_oneshot_1' as ActivityId;
  const actWakeCron1 = 'act_wake_cron_1' as ActivityId;

  const disconnected = mode === 'disconnected_expired_readonly';

  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    enabled: true,
    binding,
    asOfSeq: 14,
    status: disconnected ? 'disconnected' : 'attached',
    capabilitiesRevision: 3,
    leaseReasons: disconnected ? [] : [`goal_active:${wfGoalNew}`],
    activities: [
      {
        id: actOriginGoal,
        turnId: 'turn_1',
        origin: 'user_turn',
        state: 'finished',
        summary: '发起 Goal 与定时计划',
        updatedAt: 1_764_100_001_000,
      },
      {
        id: actOriginSched,
        turnId: 'turn_2',
        origin: 'user_turn',
        state: 'finished',
        summary: '定时设置后主轮次正常结束',
        updatedAt: 1_764_100_005_000,
      },
      {
        id: actWakeOneShot,
        turnId: null,
        origin: 'native_task',
        priorActivityId: actOriginSched,
        workId: occ1Work,
        state: 'finished',
        summary: '单次定时唤醒执行完成',
        updatedAt: 1_764_100_030_000,
      },
      {
        id: actWakeCron1,
        turnId: null,
        origin: 'native_task',
        priorActivityId: actOriginSched,
        workId: occ2Work,
        state: 'finished',
        summary: 'Cron #1 原生唤醒输出',
        updatedAt: 1_764_100_060_000,
      },
    ],
    work: [
      {
        id: occ1Work,
        kind: 'schedule',
        originActivityId: actWakeOneShot,
        workflowId: wfSchedOneShot,
        blocking: 'detached',
        state: { kind: 'known', value: 'finished', evidence: liveEv },
        outcome: { kind: 'known', value: 'succeeded', evidence: liveEv },
        observedLabel: '20s 检查构建 · #1',
        revision: 2,
      },
      {
        id: occ2Work,
        kind: 'schedule',
        originActivityId: actWakeCron1,
        workflowId: wfSchedCron,
        blocking: 'detached',
        state: { kind: 'known', value: 'finished', evidence: liveEv },
        outcome: { kind: 'known', value: 'succeeded', evidence: liveEv },
        observedLabel: 'Cron 巡检 · #1',
        revision: 2,
      },
      {
        id: occ3Work,
        kind: 'schedule',
        originActivityId: actOriginSched,
        workflowId: wfSchedCron,
        blocking: 'detached',
        state: disconnected
          ? { kind: 'stale', last: 'running', evidence: staleEv, reasonCode: 'transport_closed' }
          : { kind: 'known', value: 'running', evidence: liveEv },
        observedLabel: 'Cron 巡检 · #2（未observed wake）',
        revision: 1,
      },
      {
        id: finiteWork,
        kind: 'finite_command',
        originActivityId: actOriginGoal,
        blocking: 'confirmed_blocking',
        state: disconnected
          ? { kind: 'stale', last: 'running', evidence: staleEv, reasonCode: 'transport_closed' }
          : { kind: 'known', value: 'running', evidence: liveEv },
        observedLabel: 'pnpm test (finite)',
        revision: 1,
      },
      {
        id: daemonWork,
        kind: 'daemon',
        originActivityId: actOriginGoal,
        blocking: 'detached',
        state: disconnected
          ? { kind: 'stale', last: 'running', evidence: staleEv, reasonCode: 'transport_closed' }
          : { kind: 'known', value: 'running', evidence: liveEv },
        observedLabel: 'dev-server (IsDaemon)',
        revision: 1,
      },
    ],
    agents: [],
    relations: [],
    workflows: [
      {
        id: wfGoalOld,
        originActivityId: actOriginGoal,
        state: { kind: 'known', value: 'cancelled', evidence: liveEv },
        detail: { kind: 'goal', objective: '旧目标：初版校验' },
        revision: 2,
      },
      {
        id: wfGoalNew,
        originActivityId: actOriginGoal,
        state: disconnected
          ? { kind: 'stale', last: 'running', evidence: staleEv, reasonCode: 'transport_closed' }
          : { kind: 'known', value: 'running', evidence: liveEv },
        detail: {
          kind: 'goal',
          objective: '新目标：确保所有单元测试零失败并输出核验摘要',
          verificationArtifactIds: ['art_goal_verify_1'],
        },
        revision: 3,
      },
      {
        id: wfSchedOneShot,
        originActivityId: actOriginSched,
        state: { kind: 'known', value: 'finished', evidence: liveEv },
        detail: {
          kind: 'schedule',
          scheduleLabel: '20s 后检查构建状态',
          nextAt: { kind: 'known', value: 1_764_100_025_000, evidence: liveEv },
          occurrenceWorkIds: [occ1Work],
        },
        revision: 3,
      },
      {
        id: wfSchedCron,
        originActivityId: actOriginSched,
        state: disconnected
          ? { kind: 'stale', last: 'waiting', evidence: staleEv, reasonCode: 'transport_closed' }
          : { kind: 'known', value: 'waiting', evidence: liveEv },
        detail: {
          kind: 'schedule',
          scheduleLabel: '每 10 分钟只读巡检',
          nextAt: { kind: 'unknown', reasonCode: 'native_next_at_not_exposed' },
          occurrenceWorkIds: [occ2Work, occ3Work],
        },
        revision: 4,
      },
    ],
    requestIds: [],
  };

  const capabilities = makeFixtureCapabilities().map((cap) => {
    if (cap.id === 'AGY-W09') {
      return {
        ...cap,
        control: disconnected ? ('unknown' as const) : ('available' as const),
        actions: [
          {
            key: 'cancel',
            lane: 'live_workflow' as const,
            gate: disconnected ? ('unknown' as const) : ('available' as const),
            label: '停止当前 Goal',
          },
        ],
      };
    }
    return cap;
  });

  const goalMetaByWorkflowId: Record<string, GoalViewMeta> = {
    [wfGoalOld]: {
      workflowId: wfGoalOld,
      lifecyclePhase: 'superseded',
      supersededByGoalId: wfGoalNew,
    },
    [wfGoalNew]: {
      workflowId: wfGoalNew,
      lifecyclePhase: disconnected ? 'stale' : 'verifying',
      replacedGoalId: wfGoalOld,
      verifications: [
        {
          id: 'gver_1',
          label: '契约与单测核验',
          state: { kind: 'known', value: 'running', evidence: liveEv },
          artifactId: 'art_goal_verify_1',
          summary: '正在核验协议与前端状态',
        },
      ],
    },
  };

  const scheduleMetaByWorkflowId: Record<string, ScheduleViewMeta> = {
    [wfSchedOneShot]: {
      workflowId: wfSchedOneShot,
      scheduleKind: 'one_shot',
      durationSeconds: 20,
      timezone: { kind: 'known', value: 'Asia/Shanghai', evidence: liveEv },
      nextAtSource: 'native_wire_timestamp',
      occurrences: [
        {
          workId: occ1Work,
          occurrenceIndex: 1,
          actualTriggeredAt: { kind: 'known', value: 1_764_100_025_000, evidence: liveEv },
          timezone: { kind: 'known', value: 'Asia/Shanghai', evidence: liveEv },
          wakeActivityIds: [actWakeOneShot],
          originSource: 'live_protocol',
          recoveryState: 'preserved_read_only',
          summary: '单次定时唤醒成功触发',
        },
      ],
    },
    [wfSchedCron]: {
      workflowId: wfSchedCron,
      scheduleKind: 'cron',
      cronExpression: '*/10 * * * *',
      timezone: { kind: 'unknown', reasonCode: 'native_timezone_not_exposed' },
      nextAtSource: 'not_exposed',
      occurrences: [
        {
          workId: occ2Work,
          occurrenceIndex: 1,
          actualTriggeredAt: { kind: 'known', value: 1_764_100_060_000, evidence: liveEv },
          wakeActivityIds: [actWakeCron1],
          originSource: 'live_protocol',
          recoveryState: 'preserved_read_only',
          summary: 'Cron 第 1 次触发已完成',
        },
        {
          workId: occ3Work,
          occurrenceIndex: 2,
          wakeActivityIds: [],
          originSource: 'live_protocol',
          recoveryState: disconnected ? 'stale_unconfirmed' : 'live',
          summary: 'Cron 第 2 次触发（尚未见 wake）',
        },
      ],
    },
  };

  return {
    projection,
    capabilities,
    approvals: [],
    goalMetaByWorkflowId,
    scheduleMetaByWorkflowId,
    loadWorkflowResource: async (workflowId) => ({
      schemaVersion: 1,
      binding,
      workflowId,
      resource: 'logs',
      revision: 1,
      available: true,
      items: [
        {
          kind: 'log_entry',
          entryId: `log_${workflowId}_1`,
          seq: 1,
          level: 'info',
          summary: `已观测 ${workflowId} 原生时间线日志`,
          truncated: false,
          createdAt: 1_764_100_025_000,
          evidence: liveEv,
        },
      ],
      nextPageToken: null,
      hasMore: false,
    }),
  };
}
