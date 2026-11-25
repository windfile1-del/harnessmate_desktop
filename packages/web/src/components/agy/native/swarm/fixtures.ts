import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  ActivityId,
  AgentIdentity,
  BindingGeneration,
  CapabilityDescriptor,
  NativeAgentId,
  NativeRuntimeProjection,
  NativeWorkflowResourcePageResponse,
  RuntimeId,
  WorkflowId,
} from '../../../../lib/native-client';

/**
 * Offline synthetic frontend fixtures for NP-08 Swarm Studio tests.
 * Explicitly marked synthetic; never represents live Google ACP captures.
 */
export function createSwarmCapabilitiesFixture(revision = 2): CapabilityDescriptor[] {
  return [
    {
      id: 'AGY-W04',
      snapshotRevision: revision,
      surfaces: ['desktop', 'cli', 'acp'],
      tierHint: 'Preview',
      advertised: true,
      launch: 'unknown',
      observe: 'upstream_limited',
      control: 'upstream_limited',
      localRead: 'not_tested',
      actions: [
        {
          key: 'launch_swarm',
          lane: 'live_workflow',
          gate: 'not_tested',
          reasonCode: 'native_action_not_connected',
          label: '发起 Swarm (/swarm)',
        },
      ],
      evidenceRefs: ['E01', 'T10-OFFLINE-SYNTHETIC'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W05',
      snapshotRevision: revision,
      surfaces: ['desktop', 'cli'],
      advertised: null,
      launch: 'upstream_limited',
      observe: 'upstream_limited',
      control: 'upstream_limited',
      localRead: 'not_tested',
      actions: [
        {
          key: 'open_swarm_board',
          lane: 'manager',
          gate: 'upstream_limited',
          reasonCode: 'acp_swarm_board_not_exposed',
          label: '查看 Swarm Board (/swarm board)',
        },
      ],
      evidenceRefs: ['E01', 'T10-OFFLINE-SYNTHETIC'],
      verifiedLevel: null,
    },
  ];
}

export function createStructuredSwarmProjectionFixture(): {
  projection: NativeRuntimeProjection;
  approvals: ApprovalRequest[];
  boardPage1: NativeWorkflowResourcePageResponse;
  boardPage2: NativeWorkflowResourcePageResponse;
  logsPage: NativeWorkflowResourcePageResponse;
  ids: {
    workflowId: WorkflowId;
    coordinatorId: NativeAgentId;
    workerAlphaId: NativeAgentId;
    workerIdleId: NativeAgentId;
    verifierId: NativeAgentId;
    unconfirmedId: NativeAgentId;
  };
} {
  const now = 1_764_200_000_000;
  const runtimeId = 'nrt_np08_web' as RuntimeId;
  const generation = 'gen_np08_1' as BindingGeneration;
  const workflowId = 'wfl_swarm_01' as WorkflowId;
  const originActivityId = 'act_swarm_01' as ActivityId;
  const coordinatorId = 'agt_swarm_coord' as NativeAgentId;
  const workerAlphaId = 'agt_swarm_worker_alpha' as NativeAgentId;
  const workerIdleId = 'agt_swarm_worker_idle' as NativeAgentId;
  const verifierId = 'agt_swarm_verifier_01' as NativeAgentId;
  const unconfirmedId = 'agt_swarm_unconfirmed' as NativeAgentId;

  const liveEvidence = {
    sourceKind: 'live_protocol' as const,
    freshness: 'live' as const,
    observedAt: now,
  };
  const hostEvidence = {
    sourceKind: 'host_observation' as const,
    freshness: 'host' as const,
    observedAt: now,
  };

  const agents: AgentIdentity[] = [
    {
      id: coordinatorId,
      role: { kind: 'known', value: 'coordinator', evidence: liveEvidence },
      label: { kind: 'known', value: 'Swarm Coordinator', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'running', evidence: liveEvidence },
      status: { kind: 'known', value: 'running', evidence: liveEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 2,
    },
    {
      id: workerAlphaId,
      role: { kind: 'known', value: 'worker', evidence: liveEvidence },
      label: { kind: 'known', value: 'worker-alpha', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'requires_action', evidence: liveEvidence },
      status: { kind: 'known', value: 'requires_action', evidence: liveEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 4,
    },
    {
      id: workerIdleId,
      role: { kind: 'known', value: 'worker', evidence: liveEvidence },
      label: { kind: 'known', value: 'worker-beta-idle', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'idle', evidence: liveEvidence },
      status: { kind: 'known', value: 'waiting', evidence: liveEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 2,
    },
    {
      id: verifierId,
      role: { kind: 'known', value: 'verifier', evidence: liveEvidence },
      label: { kind: 'known', value: 'verifier-1', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'idle', evidence: liveEvidence },
      status: { kind: 'known', value: 'failed', evidence: liveEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 3,
    },
    {
      id: unconfirmedId,
      role: { kind: 'known', value: 'worker', evidence: hostEvidence },
      label: { kind: 'known', value: 'unconfirmed-candidate', evidence: hostEvidence },
      foreground: { kind: 'unknown', reasonCode: 'no_native_worker_id' },
      launchWorkIds: [],
      lineage: 'unresolved',
      revision: 1,
    },
  ];

  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    enabled: true,
    binding: { runtimeId, sessionId: 'sess_np08_web', instanceId: 'agy', generation },
    asOfSeq: 18,
    status: 'attached',
    capabilitiesRevision: 2,
    activities: [
      {
        id: originActivityId,
        turnId: 'turn_1',
        origin: 'user_turn',
        agentId: coordinatorId,
        state: 'running',
        summary: 'Swarm Coordinator executing /swarm task',
        evidence: liveEvidence,
        updatedAt: now,
      },
    ],
    work: [],
    agents,
    relations: [],
    workflows: [
      {
        id: workflowId,
        originActivityId,
        state: { kind: 'known', value: 'running', evidence: liveEvidence },
        detail: {
          kind: 'swarm',
          coordinatorId,
          workerIds: [workerAlphaId, workerIdleId, verifierId, unconfirmedId],
          board: { kind: 'known', value: 'available', evidence: liveEvidence },
          objective: 'Verify Swarm worker wake, linked approvals, and Board threads',
        },
        revision: 5,
      },
    ],
    requestIds: ['appr_swarm_worker_01', 'appr_swarm_unknown_02'],
    receipts: {
      appr_swarm_worker_01: {
        approvalId: 'appr_swarm_worker_01',
        runtimeId,
        generation,
        kind: 'permission',
        agentId: workerAlphaId,
        targetLineage: 'confirmed',
        allowedOptionIds: ['allow_once', 'reject_once'],
        receiptState: 'pending',
        updatedAt: now,
      },
      appr_swarm_unknown_02: {
        approvalId: 'appr_swarm_unknown_02',
        runtimeId,
        generation,
        kind: 'permission',
        targetLineage: 'unconfirmed',
        allowedOptionIds: ['reject_once'],
        receiptState: 'pending',
        updatedAt: now,
      },
    },
  };

  const approvals: ApprovalRequest[] = [
    {
      id: 'appr_swarm_worker_01',
      sessionId: 'sess_np08_web',
      nativeRequestId: 'nat_req_swarm_worker_01',
      kind: 'command_approval',
      toolName: 'run_command',
      toolKind: 'shell',
      summary: 'Run targeted unit tests for worker-alpha',
      input: { command: 'pnpm test' },
      riskLevel: 'medium',
      status: 'pending',
      createdAt: now,
    },
    {
      id: 'appr_swarm_unknown_02',
      sessionId: 'sess_np08_web',
      nativeRequestId: 'nat_req_swarm_unknown_02',
      kind: 'command_approval',
      toolName: 'run_command',
      toolKind: 'shell',
      summary: 'Unconfirmed foreign child request',
      input: { command: 'rm -rf .' },
      riskLevel: 'high',
      status: 'pending',
      createdAt: now,
    },
  ];

  const boardPage1: NativeWorkflowResourcePageResponse = {
    schemaVersion: 1,
    workflowId,
    resource: 'board',
    revision: 2,
    items: [
      {
        kind: 'board_post',
        postId: 'post_t10_001',
        authorAgentId: coordinatorId,
        authorLabel: 'coordinator',
        summary: 'Kickoff: @worker-alpha please inspect auth guard',
        truncated: false,
        createdAt: now - 2000,
        evidence: liveEvidence,
      },
      {
        kind: 'board_post',
        postId: 'post_t10_002',
        threadId: 'post_t10_001',
        authorAgentId: workerAlphaId,
        authorLabel: 'worker-alpha',
        summary: 'Woke up from mention; inspecting guard',
        truncated: false,
        createdAt: now - 1000,
        evidence: liveEvidence,
      },
    ],
    nextPageToken: 'cursor_after_002',
    hasMore: true,
  };

  const boardPage2: NativeWorkflowResourcePageResponse = {
    schemaVersion: 1,
    workflowId,
    resource: 'board',
    revision: 2,
    items: [
      {
        kind: 'board_post',
        postId: 'post_t10_003',
        threadId: 'post_t10_001',
        authorAgentId: verifierId,
        authorLabel: 'verifier-1',
        summary: 'Found failing assertion on negative case',
        truncated: false,
        createdAt: now,
        evidence: liveEvidence,
      },
    ],
    nextPageToken: null,
    hasMore: false,
  };

  const logsPage: NativeWorkflowResourcePageResponse = {
    schemaVersion: 1,
    workflowId,
    resource: 'logs',
    revision: 2,
    items: [
      {
        kind: 'log_entry',
        entryId: 'trc_001',
        seq: 1,
        level: 'info',
        summary: 'Coordinator initialized Swarm session',
        truncated: false,
        createdAt: now - 3000,
        evidence: liveEvidence,
      },
      {
        kind: 'log_entry',
        entryId: 'trc_002',
        seq: 2,
        level: 'warn',
        summary: '已关联已确证成员 (agt_swarm_worker_alpha) 请求 appr_swarm_worker_01',
        truncated: false,
        createdAt: now - 500,
        evidence: hostEvidence,
      },
    ],
    nextPageToken: null,
    hasMore: false,
  };

  return {
    projection,
    approvals,
    boardPage1,
    boardPage2,
    logsPage,
    ids: {
      workflowId,
      coordinatorId,
      workerAlphaId,
      workerIdleId,
      verifierId,
      unconfirmedId,
    },
  };
}

export function createUpstreamLimitedSwarmProjectionFixture(): NativeRuntimeProjection {
  const now = 1_764_200_100_000;
  const runtimeId = 'nrt_np08_limited' as RuntimeId;
  const generation = 'gen_np08_2' as BindingGeneration;
  const workflowId = 'wfl_swarm_limited' as WorkflowId;
  const originActivityId = 'act_swarm_limited' as ActivityId;
  const coordinatorId = 'agt_swarm_coord_limited' as NativeAgentId;

  const liveEvidence = {
    sourceKind: 'live_protocol' as const,
    freshness: 'live' as const,
    observedAt: now,
  };

  return {
    schemaVersion: 1,
    enabled: true,
    binding: { runtimeId, sessionId: 'sess_np08_limited', instanceId: 'agy', generation },
    asOfSeq: 4,
    status: 'attached',
    capabilitiesRevision: 1,
    activities: [
      {
        id: originActivityId,
        turnId: 'turn_1',
        origin: 'user_turn',
        agentId: coordinatorId,
        state: 'running',
        summary: 'Coordinator running without ACP Board feed',
        evidence: liveEvidence,
        updatedAt: now,
      },
    ],
    work: [],
    agents: [
      {
        id: coordinatorId,
        role: { kind: 'known', value: 'coordinator', evidence: liveEvidence },
        label: { kind: 'known', value: 'Swarm Coordinator', evidence: liveEvidence },
        foreground: { kind: 'known', value: 'running', evidence: liveEvidence },
        launchWorkIds: [],
        lineage: 'confirmed',
        revision: 1,
      },
    ],
    relations: [],
    workflows: [
      {
        id: workflowId,
        originActivityId,
        state: { kind: 'known', value: 'running', evidence: liveEvidence },
        detail: {
          kind: 'swarm',
          coordinatorId,
          workerIds: [],
          board: { kind: 'known', value: 'upstream_limited', evidence: liveEvidence },
          objective: 'Observe Coordinator when ACP Board feed is not exposed',
        },
        revision: 2,
      },
    ],
    requestIds: [],
    receipts: {},
  };
}
