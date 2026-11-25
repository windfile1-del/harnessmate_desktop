import type { ApprovalRequest } from '@harnessmate/protocol';
import {
  NativeClientError,
  type ActivityId,
  type AgentIdentity,
  type BindingGeneration,
  type CapabilityDescriptor,
  type NativeAgentId,
  type NativeCanonicalEvent,
  type NativeRelationship,
  type NativeRuntimeProjection,
  type NativeRuntimeTransport,
  type NativeTimelineEntry,
  type RuntimeId,
  type WorkId,
  type WorkflowId,
} from '../../../../lib/native-client';

/**
 * Sanitized, deterministic 03a/03b frontend fixtures covering:
 * 1. Live reactive runtime (finite blocking work, detached daemon, confirmed child, pending approval)
 * 2. Unknown / unauthenticated profile state
 * 3. Stale / reconciling state after reconnect with delivery_unknown receipt
 * 4. Crashed / disconnected state with connection_lost receipt
 * 5. Unsupported / upstream_limited Studios (Swarm Board, Boost phases, Teamwork approval, Dynamic DAG)
 * 6. Stress fixture generator (100 children / 10,000 events / 20 pending requests for T18 / NP-16)
 *
 * All fixtures are explicitly marked as synthetic fixtures and never elevate real capability levels.
 */

const BASE_TS = 1_764_000_000_000;

export function makeFixtureCapabilities(
  overrides?: Partial<Record<string, Partial<CapabilityDescriptor>>>,
): CapabilityDescriptor[] {
  const base: CapabilityDescriptor[] = [
    {
      id: 'AGY-R03',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'unknown',
      actions: [{ key: 'cancel', lane: 'live_workflow', gate: 'available', label: '停止活动' }],
      evidenceRefs: ['SYNTH-NP03-REACTIVE'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-R10',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'unknown',
      actions: [{ key: 'cancel', lane: 'live_workflow', gate: 'available', label: '原生取消 (Stop)' }],
      evidenceRefs: ['SYNTH-NP03-STOP'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W01',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'upstream_limited',
      localRead: 'unknown',
      actions: [],
      evidenceRefs: ['SYNTH-NP03-CHILD'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W04',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli'],
      tierHint: 'Preview',
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'upstream_limited',
      localRead: 'unknown',
      actions: [],
      evidenceRefs: ['SYNTH-NP03-SWARM'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W05',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli'],
      advertised: false,
      launch: 'upstream_limited',
      observe: 'upstream_limited',
      control: 'upstream_limited',
      localRead: 'unknown',
      actions: [],
      evidenceRefs: ['SYNTH-NP03-BOARD'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W06',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli'],
      tierHint: 'Pro/Ultra',
      advertised: false,
      launch: 'not_tested',
      observe: 'upstream_limited',
      control: 'unknown',
      localRead: 'unknown',
      actions: [],
      evidenceRefs: ['SYNTH-NP03-BOOST'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W07',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli'],
      tierHint: 'Pro/Ultra',
      advertised: false,
      launch: 'not_tested',
      observe: 'upstream_limited',
      control: 'upstream_limited',
      localRead: 'unknown',
      actions: [],
      evidenceRefs: ['SYNTH-NP03-TEAMWORK'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W08',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli'],
      advertised: true,
      launch: 'available',
      observe: 'upstream_limited',
      control: 'unknown',
      localRead: 'unknown',
      actions: [],
      evidenceRefs: ['SYNTH-NP03-DYNAMIC'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W09',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'unknown',
      actions: [{ key: 'cancel', lane: 'live_workflow', gate: 'available', label: '中止 Goal' }],
      evidenceRefs: ['SYNTH-NP03-GOAL'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W10',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'upstream_limited',
      localRead: 'unknown',
      actions: [],
      evidenceRefs: ['SYNTH-NP03-SCHEDULE'],
      verifiedLevel: null,
    },
  ];

  if (!overrides) return base;
  return base.map((cap) => (overrides[cap.id] ? { ...cap, ...overrides[cap.id] } : cap));
}

export function createLiveReactiveFixture(sessionId = 'sess_agy_np03_live'): {
  projection: NativeRuntimeProjection;
  capabilities: CapabilityDescriptor[];
  approvals: ApprovalRequest[];
  timelineByScope: Record<string, NativeTimelineEntry[]>;
} {
  const runtimeId = 'rt_live_1' as RuntimeId;
  const generation = 'gen_1' as BindingGeneration;
  const actUser = 'act_user_1' as ActivityId;
  const actWake = 'act_wake_2' as ActivityId;
  const workFinite = 'wk_finite_1' as WorkId;
  const workDaemon = 'wk_daemon_2' as WorkId;
  const agentMain = 'ag_main' as NativeAgentId;
  const agentChild = 'ag_child_researcher' as NativeAgentId;

  const liveEvidence = {
    sourceKind: 'live_protocol' as const,
    freshness: 'fresh' as const,
    observedAt: BASE_TS + 15_000,
    wireVariant: 'acp_v1',
  };

  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    binding: { runtimeId, sessionId, instanceId: 'agy', generation },
    asOfSeq: 12,
    status: 'attached',
    capabilitiesRevision: 3,
    leaseReasons: ['finite_blocking:wk_finite_1', 'pending_request:appr_child_1'],
    activities: [
      {
        id: actUser,
        turnId: 'turn_1',
        origin: 'user_turn',
        workId: workFinite,
        agentId: agentMain,
        state: 'waiting_background',
        summary: '等待 20s 有限构建任务完成',
        evidence: liveEvidence,
        updatedAt: BASE_TS + 12_000,
      },
      {
        id: actWake,
        turnId: null,
        origin: 'native_continuation',
        priorActivityId: actUser,
        workId: workFinite,
        agentId: agentChild,
        state: 'requires_action',
        summary: '子 Agent 唤醒后请求读取测试报告权限',
        evidence: liveEvidence,
        updatedAt: BASE_TS + 15_000,
      },
    ],
    work: [
      {
        id: workFinite,
        kind: 'finite_command',
        originActivityId: actUser,
        ownerAgentId: agentMain,
        blocking: 'confirmed_blocking',
        state: { kind: 'known', value: 'running', evidence: liveEvidence },
        observedLabel: 'pnpm test --filter web',
        revision: 4,
      },
      {
        id: workDaemon,
        kind: 'daemon',
        originActivityId: actUser,
        ownerAgentId: agentMain,
        blocking: 'detached',
        state: { kind: 'known', value: 'running', evidence: liveEvidence },
        observedLabel: 'vite dev server (detached)',
        revision: 2,
      },
    ],
    agents: [
      {
        id: agentMain,
        role: { kind: 'known', value: 'coordinator', evidence: liveEvidence },
        label: { kind: 'known', value: '主 Agent', evidence: liveEvidence },
        foreground: { kind: 'known', value: 'idle', evidence: liveEvidence },
        launchWorkIds: [workFinite, workDaemon],
        lineage: 'confirmed',
        revision: 3,
      },
      {
        id: agentChild,
        role: { kind: 'known', value: 'researcher', evidence: liveEvidence },
        label: { kind: 'known', value: 'Codebase Researcher', evidence: liveEvidence },
        foreground: { kind: 'known', value: 'requires_action', evidence: liveEvidence },
        launchWorkIds: [],
        lineage: 'confirmed',
        revision: 5,
      },
    ],
    relations: [
      {
        parentAgentId: agentMain,
        childAgentId: agentChild,
        confidence: 'protocol_confirmed',
        launchWorkId: workFinite,
        evidence: liveEvidence,
      },
    ],
    workflows: [],
    requestIds: ['appr_child_1'],
    receipts: {
      appr_child_1: {
        approvalId: 'appr_child_1',
        runtimeId,
        generation,
        kind: 'permission',
        agentId: agentChild,
        activityId: actWake,
        targetLineage: 'confirmed',
        allowedOptionIds: ['allow_once', 'deny'],
        receiptState: 'pending',
        evidence: liveEvidence,
        updatedAt: BASE_TS + 15_000,
      },
    },
  };

  const approvals: ApprovalRequest[] = [
    {
      id: 'appr_child_1',
      kind: 'command_approval',
      sessionId,
      nativeRequestId: 'nat_req_child_1',
      toolName: 'ReadFile',
      toolKind: 'file_read',
      summary: 'Read sanitized test fixture report',
      input: { path: 'tests/report.json' },
      riskLevel: 'low',
      status: 'pending',
      createdAt: BASE_TS + 15_000,
    },
  ];

  const timelineByScope: Record<string, NativeTimelineEntry[]> = {
    [`activity:${actUser}`]: [
      {
        entryId: 'e1',
        seq: 1,
        timestamp: BASE_TS + 1_000,
        kind: 'tool',
        actorKind: 'main',
        actorLabel: '主 Agent',
        title: '启动有限后台命令',
        text: 'pnpm test --filter web',
        evidence: liveEvidence,
      },
      {
        entryId: 'e2',
        seq: 2,
        timestamp: BASE_TS + 12_000,
        kind: 'status',
        actorKind: 'system',
        title: '进入等待后台状态',
        text: '主响应已返回，保持有限任务 lease 观察。',
        evidence: liveEvidence,
      },
    ],
    [`agent:${agentChild}`]: [
      {
        entryId: 'c1',
        seq: 1,
        timestamp: BASE_TS + 14_000,
        kind: 'assistant_text',
        actorKind: 'child',
        actorLabel: 'Codebase Researcher',
        text: '正在检查工作区测试报告，等待权限放行。',
        evidence: liveEvidence,
      },
    ],
  };

  return {
    projection,
    capabilities: makeFixtureCapabilities(),
    approvals,
    timelineByScope,
  };
}

export function createUnknownFixture(sessionId = 'sess_agy_np03_unknown'): {
  projection: NativeRuntimeProjection;
  capabilities: CapabilityDescriptor[];
} {
  return {
    projection: {
      schemaVersion: 1,
      binding: {
        runtimeId: 'rt_unknown_1' as RuntimeId,
        sessionId,
        instanceId: 'agy',
        generation: 'gen_0' as BindingGeneration,
      },
      asOfSeq: 1,
      status: 'attached',
      capabilitiesRevision: 0,
      activities: [
        {
          id: 'act_unk_1' as ActivityId,
          turnId: 'turn_unk',
          origin: 'user_turn',
          state: 'unknown',
          summary: '尚未获得有效状态证据',
          updatedAt: BASE_TS,
        },
      ],
      work: [
        {
          id: 'wk_unk_1' as WorkId,
          kind: 'unknown',
          blocking: 'unknown',
          state: { kind: 'unknown', reasonCode: 'unauthenticated_profile' },
          revision: 1,
        },
      ],
      agents: [
        {
          id: 'ag_unresolved_1' as NativeAgentId,
          foreground: { kind: 'unknown', reasonCode: 'launch_only_no_child_id' },
          launchWorkIds: ['wk_unk_1' as WorkId],
          lineage: 'unresolved',
          revision: 1,
        },
      ],
      relations: [],
      workflows: [],
      requestIds: [],
      receipts: {},
    },
    capabilities: [],
  };
}

export function createStaleReconcilingFixture(sessionId = 'sess_agy_np03_stale'): {
  projection: NativeRuntimeProjection;
  capabilities: CapabilityDescriptor[];
} {
  const staleEvidence = {
    sourceKind: 'native_snapshot' as const,
    freshness: 'stale' as const,
    observedAt: BASE_TS - 120_000,
    reasonCode: 'reconnect_pending_confirmation',
    schemaVersion: 'snapshot-v1',
  };
  return {
    projection: {
      schemaVersion: 1,
      binding: {
        runtimeId: 'rt_stale_1' as RuntimeId,
        sessionId,
        instanceId: 'agy',
        generation: 'gen_2' as BindingGeneration,
      },
      asOfSeq: 44,
      status: 'reconciling',
      capabilitiesRevision: 2,
      activities: [
        {
          id: 'act_stale_1' as ActivityId,
          turnId: null,
          origin: 'recovery',
          state: 'reconciling',
          summary: '重连后校准最后观测状态',
          evidence: staleEvidence,
          updatedAt: BASE_TS,
        },
      ],
      work: [
        {
          id: 'wk_stale_1' as WorkId,
          kind: 'finite_command',
          blocking: 'unknown',
          state: {
            kind: 'stale',
            last: 'running',
            evidence: staleEvidence,
            reasonCode: 'snapshot_ttl_expired',
          },
          observedLabel: 'long-build-job',
          revision: 7,
        },
      ],
      agents: [],
      relations: [],
      workflows: [],
      requestIds: [],
      receipts: {
        appr_old_1: {
          approvalId: 'appr_old_1',
          runtimeId: 'rt_stale_1' as RuntimeId,
          generation: 'gen_1' as BindingGeneration,
          kind: 'permission',
          targetLineage: 'unconfirmed',
          allowedOptionIds: ['allow_once', 'deny'],
          receiptState: 'delivery_unknown',
          receiptId: 'rcpt_901',
          evidence: staleEvidence,
          updatedAt: BASE_TS - 60_000,
        },
      },
    },
    capabilities: makeFixtureCapabilities({
      'AGY-R10': { control: 'unknown', actions: [] },
    }),
  };
}

export function createCrashedDisconnectedFixture(sessionId = 'sess_agy_np03_crashed'): {
  projection: NativeRuntimeProjection;
  capabilities: CapabilityDescriptor[];
} {
  const crashEvidence = {
    sourceKind: 'host_observation' as const,
    freshness: 'stale' as const,
    observedAt: BASE_TS,
    reasonCode: 'worker_process_exited',
  };
  return {
    projection: {
      schemaVersion: 1,
      binding: {
        runtimeId: 'rt_crash_1' as RuntimeId,
        sessionId,
        instanceId: 'agy',
        generation: 'gen_3' as BindingGeneration,
      },
      asOfSeq: 88,
      status: 'disconnected',
      capabilitiesRevision: 2,
      activities: [
        {
          id: 'act_crash_1' as ActivityId,
          turnId: 'turn_crash',
          origin: 'user_turn',
          state: 'unknown',
          summary: '原生进程异常退出，状态保留最后观测',
          evidence: crashEvidence,
          updatedAt: BASE_TS,
        },
      ],
      work: [
        {
          id: 'wk_crash_1' as WorkId,
          kind: 'daemon',
          blocking: 'detached',
          state: { kind: 'stale', last: 'running', evidence: crashEvidence, reasonCode: 'transport_closed' },
          observedLabel: 'background-watcher',
          revision: 9,
        },
      ],
      agents: [],
      relations: [],
      workflows: [],
      requestIds: [],
      receipts: {
        appr_lost_1: {
          approvalId: 'appr_lost_1',
          runtimeId: 'rt_crash_1' as RuntimeId,
          generation: 'gen_3' as BindingGeneration,
          kind: 'permission',
          targetLineage: 'confirmed',
          allowedOptionIds: ['allow_once', 'deny'],
          receiptState: 'connection_lost',
          receiptId: 'rcpt_lost_1',
          evidence: crashEvidence,
          updatedAt: BASE_TS,
        },
      },
    },
    capabilities: makeFixtureCapabilities({
      'AGY-R10': { control: 'unsupported', actions: [] },
    }),
  };
}

export function createUnsupportedStudiosFixture(sessionId = 'sess_agy_np03_unsupported'): {
  projection: NativeRuntimeProjection;
  capabilities: CapabilityDescriptor[];
} {
  const ev = {
    sourceKind: 'live_protocol' as const,
    freshness: 'fresh' as const,
    observedAt: BASE_TS,
    wireVariant: 'acp_v1',
  };
  const originAct = 'act_wf_1' as ActivityId;
  return {
    projection: {
      schemaVersion: 1,
      binding: {
        runtimeId: 'rt_unsup_1' as RuntimeId,
        sessionId,
        instanceId: 'agy',
        generation: 'gen_4' as BindingGeneration,
      },
      asOfSeq: 20,
      status: 'attached',
      capabilitiesRevision: 4,
      activities: [
        {
          id: originAct,
          turnId: 'turn_wf',
          origin: 'user_turn',
          state: 'running',
          summary: '已启动原生模式，部分上游 feed 受限',
          evidence: ev,
          updatedAt: BASE_TS,
        },
      ],
      work: [],
      agents: [],
      relations: [],
      workflows: [
        {
          id: 'wf_swarm_1' as WorkflowId,
          originActivityId: originAct,
          state: { kind: 'known', value: 'running', evidence: ev },
          detail: {
            kind: 'swarm',
            coordinatorId: 'ag_coord' as NativeAgentId,
            workerIds: ['ag_w1' as NativeAgentId],
            board: { kind: 'known', value: 'upstream_limited', evidence: ev },
          },
          revision: 1,
        },
        {
          id: 'wf_boost_1' as WorkflowId,
          originActivityId: originAct,
          state: { kind: 'known', value: 'running', evidence: ev },
          detail: { kind: 'boost' },
          revision: 1,
        },
        {
          id: 'wf_teamwork_1' as WorkflowId,
          originActivityId: originAct,
          state: { kind: 'known', value: 'waiting', evidence: ev },
          detail: { kind: 'teamwork', projectLabel: 'NP-03 Demo Project' },
          revision: 1,
        },
        {
          id: 'wf_dynamic_1' as WorkflowId,
          originActivityId: originAct,
          state: { kind: 'known', value: 'running', evidence: ev },
          detail: { kind: 'dynamic', scriptArtifactId: 'art_script_1' },
          revision: 1,
        },
      ],
      requestIds: [],
      receipts: {},
    },
    capabilities: makeFixtureCapabilities({
      'AGY-W05': { observe: 'upstream_limited', control: 'upstream_limited' },
      'AGY-W06': { observe: 'upstream_limited', control: 'unsupported' },
      'AGY-W07': { observe: 'upstream_limited', control: 'upstream_limited' },
      'AGY-W08': { observe: 'upstream_limited', control: 'unsupported' },
    }),
  };
}

/**
 * Generates a high-volume synthetic stress dataset (default 100 children, 10,000 events,
 * 20 pending requests) for NP-03 / NP-16 joint performance, virtualization, and batching tests (T18).
 */
export function createStressFixture(options?: {
  sessionId?: string;
  agentCount?: number;
  eventCount?: number;
  pendingRequestCount?: number;
}): {
  projection: NativeRuntimeProjection;
  events: NativeCanonicalEvent[];
  timelineEntries: NativeTimelineEntry[];
  approvals: ApprovalRequest[];
} {
  const sessionId = options?.sessionId ?? 'sess_agy_stress';
  const agentCount = options?.agentCount ?? 100;
  const eventCount = options?.eventCount ?? 10_000;
  const pendingRequestCount = options?.pendingRequestCount ?? 20;

  const runtimeId = 'rt_stress_1' as RuntimeId;
  const generation = 'gen_stress_1' as BindingGeneration;
  const parentId = 'ag_stress_root' as NativeAgentId;
  const ev = {
    sourceKind: 'replay' as const,
    freshness: 'fresh' as const,
    observedAt: BASE_TS,
    captureId: 'SYNTH-T18-STRESS',
  };

  const agents: AgentIdentity[] = [
    {
      id: parentId,
      role: { kind: 'known', value: 'coordinator', evidence: ev },
      label: { kind: 'known', value: 'Root Coordinator', evidence: ev },
      foreground: { kind: 'known', value: 'running', evidence: ev },
      launchWorkIds: [] as WorkId[],
      lineage: 'confirmed',
      revision: 1,
    },
  ];
  const relations: NativeRelationship[] = [];

  for (let i = 0; i < agentCount; i += 1) {
    const childId = `ag_stress_child_${i}` as NativeAgentId;
    agents.push({
      id: childId,
      role: { kind: 'known', value: `worker-${i % 5}`, evidence: ev },
      label: { kind: 'known', value: `Worker #${i}`, evidence: ev },
      foreground: {
        kind: 'known',
        value: i < pendingRequestCount ? 'requires_action' : i % 3 === 0 ? 'running' : 'idle',
        evidence: ev,
      },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 1,
    });
    relations.push({
      parentAgentId: parentId,
      childAgentId: childId,
      confidence: 'protocol_confirmed' as const,
      evidence: ev,
    });
  }

  const approvals: ApprovalRequest[] = [];
  const requestIds: string[] = [];
  const receipts: NativeRuntimeProjection['receipts'] = {};
  for (let i = 0; i < pendingRequestCount; i += 1) {
    const id = `appr_stress_${i}`;
    requestIds.push(id);
    approvals.push({
      id,
      kind: 'command_approval',
      sessionId,
      nativeRequestId: `nat_${i}`,
      toolName: 'RunShell',
      toolKind: 'shell',
      summary: `stress command #${i}`,
      input: { index: i },
      riskLevel: 'low',
      status: 'pending',
      createdAt: BASE_TS + i,
    });
    receipts[id] = {
      approvalId: id,
      runtimeId,
      generation,
      kind: 'permission',
      agentId: `ag_stress_child_${i}` as NativeAgentId,
      targetLineage: 'confirmed',
      allowedOptionIds: ['allow_once', 'deny'],
      receiptState: 'pending',
      evidence: ev,
      updatedAt: BASE_TS + i,
    };
  }

  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    binding: { runtimeId, sessionId, instanceId: 'agy', generation },
    asOfSeq: 0,
    status: 'attached',
    capabilitiesRevision: 1,
    activities: [],
    work: [],
    agents,
    relations,
    workflows: [],
    requestIds,
    receipts,
  };

  const events: NativeCanonicalEvent[] = [];
  const timelineEntries: NativeTimelineEntry[] = [];
  for (let seq = 1; seq <= eventCount; seq += 1) {
    const workId = `wk_stress_${seq % 50}` as WorkId;
    events.push({
      schemaVersion: 1,
      runtimeId,
      generation,
      seq,
      turnId: null,
      createdAt: BASE_TS + seq,
      type: 'native.work.changed',
      payload: {
        work: {
          id: workId,
          kind: seq % 4 === 0 ? 'daemon' : 'finite_command',
          blocking: seq % 4 === 0 ? 'detached' : 'confirmed_blocking',
          state: { kind: 'known', value: seq % 10 === 0 ? 'finished' : 'running', evidence: ev },
          observedLabel: `stress-task-${seq % 50}`,
          revision: seq,
        },
      },
    });
    timelineEntries.push({
      entryId: `tl_stress_${seq}`,
      seq,
      timestamp: BASE_TS + seq,
      kind: seq % 5 === 0 ? 'tool' : 'assistant_text',
      actorKind: seq % 2 === 0 ? 'child' : 'main',
      actorLabel: seq % 2 === 0 ? `Worker #${seq % agentCount}` : 'Main Agent',
      title: `Step #${seq}`,
      text: `Sanitized synthetic event payload #${seq}`,
      evidence: ev,
    });
  }

  return { projection, events, timelineEntries, approvals };
}

/**
 * In-memory stub transport for 03a/03b development and deterministic pagination/resync tests.
 */
export function createStubNativeTransport(config: {
  snapshot: NativeRuntimeProjection;
  capabilities: CapabilityDescriptor[];
  events?: NativeCanonicalEvent[];
  timelineByScope?: Record<string, NativeTimelineEntry[]>;
  simulateResyncOnce?: boolean;
  pageSize?: number;
}): NativeRuntimeTransport {
  let resyncTriggered = false;
  let currentSnapshot = config.snapshot;
  const allEvents = config.events ?? [];
  const pageSize = config.pageSize ?? 50;

  return {
    mode: 'stub',
    getSnapshot: async () => ({
      schemaVersion: 1,
      projection: currentSnapshot,
    }),
    getCapabilities: async () => ({
      schemaVersion: 1,
      binding: currentSnapshot.binding,
      capabilitiesRevision: currentSnapshot.capabilitiesRevision,
      descriptors: config.capabilities,
    }),
    getEvents: async (_sessionId, { afterSeq, limit = pageSize }) => {
      if (config.simulateResyncOnce && !resyncTriggered) {
        resyncTriggered = true;
        currentSnapshot = {
          ...currentSnapshot,
          asOfSeq: Math.max(currentSnapshot.asOfSeq, allEvents.at(-1)?.seq ?? currentSnapshot.asOfSeq),
        };
        throw new NativeClientError('Cursor expired; full snapshot required', 410, 'RESYNC_REQUIRED');
      }
      const matching = allEvents.filter((e) => e.seq > afterSeq);
      const slice = matching.slice(0, limit);
      const hasMore = matching.length > slice.length;
      return {
        schemaVersion: 1,
        binding: currentSnapshot.binding,
        asOfSeq: slice.at(-1)?.seq ?? afterSeq,
        events: slice,
        nextCursor: hasMore ? `after:${slice.at(-1)!.seq}` : null,
        hasMore,
      };
    },
    getActivityTimeline: async (_sessionId, activityId, params) => {
      const key = `activity:${activityId}`;
      const list = config.timelineByScope?.[key] ?? [];
      const offset = params?.pageToken ? Number(params.pageToken) || 0 : 0;
      const limit = params?.limit ?? 50;
      const items = list.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        schemaVersion: 1,
        scopeKind: 'activity',
        scopeId: activityId,
        revision: 1,
        items,
        nextPageToken: nextOffset < list.length ? String(nextOffset) : null,
        hasMore: nextOffset < list.length,
      };
    },
    getAgentTimeline: async (_sessionId, agentId, params) => {
      const key = `agent:${agentId}`;
      const list = config.timelineByScope?.[key];
      if (!list) {
        return {
          schemaVersion: 1,
          scopeKind: 'agent',
          scopeId: agentId,
          revision: 1,
          items: [],
          nextPageToken: null,
          hasMore: false,
          sourceUnavailableReason: '当前未提供独立子 Agent 轨迹源',
        };
      }
      const offset = params?.pageToken ? Number(params.pageToken) || 0 : 0;
      const limit = params?.limit ?? 50;
      const items = list.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        schemaVersion: 1,
        scopeKind: 'agent',
        scopeId: agentId,
        revision: 1,
        items,
        nextPageToken: nextOffset < list.length ? String(nextOffset) : null,
        hasMore: nextOffset < list.length,
      };
    },
    getWorkflowResource: async (_sessionId, workflowId, resource) => ({
      schemaVersion: 1,
      workflowId,
      resource,
      revision: 1,
      items: [],
      nextPageToken: null,
      hasMore: false,
      sourceUnavailableReason: '当前 stub 未提供该工作流分页资源',
    }),
    submitCommand: async () => ({
      schemaVersion: 1,
      status: 'accepted',
      activityId: 'act_stub_cmd' as ActivityId,
      turnId: null,
      modeEvidenceObserved: false,
    }),
    dispatchControl: async () => ({
      schemaVersion: 1,
      receiptId: 'rcpt_stub_ctrl',
      state: 'requested',
    }),
    resolveNativeRequest: async (_sessionId, approvalId) => ({
      schemaVersion: 1,
      approvalId,
      receiptId: `rcpt_${approvalId}`,
      receiptState: 'response_written',
    }),
  };
}
