import type {
  ActivityId,
  BindingGeneration,
  CapabilityDescriptor,
  NativeAgentId,
  NativeRuntimeProjection,
  RuntimeId,
  WorkId,
  WorkflowId,
} from '../../../../lib/native-client';

const RUNTIME_ID = 'nrt_np09_ui' as RuntimeId;
const GEN_1 = 'gen_np09_1' as BindingGeneration;
const ACT_BOOST = 'act_boost_ui_1' as ActivityId;
const WF_BOOST = 'wf_boost_ui_1' as WorkflowId;
const WORK_VERIFY = 'wrk_boost_ui_verify' as WorkId;
const AGENT_VERIFIER = 'agt_boost_ui_verifier' as NativeAgentId;

const LIVE_EV = {
  sourceKind: 'live_protocol' as const,
  freshness: 'live' as const,
  observedAt: 1_700_000_010_000,
};

export function makeBoostUiCapabilities(opts?: {
  readonly eligible?: boolean;
  readonly reasonCode?: string;
  readonly advertised?: boolean | null;
  readonly tierHint?: string;
  readonly rootCancelAvailable?: boolean;
}): CapabilityDescriptor[] {
  const eligible = opts?.eligible ?? true;
  const advertised = opts?.advertised !== undefined ? opts.advertised : eligible;
  const launchGate = eligible ? 'available' : opts?.reasonCode === 'profile_unauthenticated' ? 'not_tested' : 'unsupported';

  return [
    {
      id: 'AGY-W06',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli', 'acp'],
      tierHint: opts?.tierHint ?? 'Pro/Ultra',
      versionNote: 'NP-09 synthetic T11 fixture',
      advertised,
      launch: launchGate,
      observe: 'upstream_limited',
      control: 'unknown',
      localRead: 'not_tested',
      actions: [
        {
          key: 'launch_boost',
          lane: 'live_workflow',
          gate: launchGate,
          ...(opts?.reasonCode ? { reasonCode: opts.reasonCode } : {}),
          label: '发起 Boost (/boost)',
        },
      ],
      evidenceRefs: advertised ? ['E01', 'RUNTIME_ADVERTISED'] : ['E01'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-R10',
      snapshotRevision: 3,
      surfaces: ['desktop', 'cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: opts?.rootCancelAvailable === false ? 'unknown' : 'available',
      localRead: 'not_tested',
      actions: [
        {
          key: 'cancel',
          lane: 'live_workflow',
          gate: opts?.rootCancelAvailable === false ? 'unknown' : 'available',
          label: '停止当前原生会话',
        },
      ],
      evidenceRefs: ['E05', 'S04'],
      verifiedLevel: null,
    },
  ];
}

export function createBoostWithPhasesFixture(): NativeRuntimeProjection {
  return {
    schemaVersion: 1,
    enabled: true,
    binding: {
      runtimeId: RUNTIME_ID,
      sessionId: 'sess_np09_ui',
      instanceId: 'agy_pro',
      generation: GEN_1,
    },
    asOfSeq: 12,
    status: 'attached',
    capabilitiesRevision: 3,
    activities: [
      {
        id: ACT_BOOST,
        turnId: 'turn_boost_1',
        origin: 'user_turn',
        state: 'running',
        summary: '/boost 验证并发 CAS 与回放边界',
        evidence: LIVE_EV,
        updatedAt: 1_700_000_010_000,
      },
    ],
    work: [
      {
        id: WORK_VERIFY,
        kind: 'workflow_step',
        originActivityId: ACT_BOOST,
        ownerAgentId: AGENT_VERIFIER,
        workflowId: WF_BOOST,
        blocking: 'confirmed_blocking',
        state: { kind: 'known', value: 'finished', evidence: LIVE_EV },
        outcome: { kind: 'known', value: 'succeeded', evidence: LIVE_EV },
        observedLabel: 'Independent Verification Runner',
        revision: 2,
      },
    ],
    agents: [
      {
        id: AGENT_VERIFIER,
        role: { kind: 'known', value: 'verifier', evidence: LIVE_EV },
        label: { kind: 'known', value: 'Independent Verifier', evidence: LIVE_EV },
        foreground: { kind: 'known', value: 'idle', evidence: LIVE_EV },
        launchWorkIds: [WORK_VERIFY],
        lineage: 'confirmed',
        revision: 2,
      },
    ],
    relations: [],
    workflows: [
      {
        id: WF_BOOST,
        originActivityId: ACT_BOOST,
        state: { kind: 'known', value: 'finished', evidence: LIVE_EV },
        detail: {
          kind: 'boost',
          objective: '验证并发 CAS 与回放边界',
          phases: [
            {
              id: 'phase_initial',
              label: 'initial',
              state: { kind: 'known', value: 'finished', evidence: LIVE_EV },
            },
            {
              id: 'phase_unknown_critic',
              label: 'Adversarial Critic Audit',
              state: { kind: 'known', value: 'finished', evidence: LIVE_EV },
              after: ['phase_initial'],
            },
            {
              id: 'phase_verification',
              label: 'verification',
              state: { kind: 'known', value: 'finished', evidence: LIVE_EV },
              after: ['phase_unknown_critic'],
              agentIds: [AGENT_VERIFIER],
            },
          ],
        },
        revision: 4,
      },
    ],
    requestIds: [],
    receipts: {},
  };
}

export function createBoostWithoutPhasesFixture(): NativeRuntimeProjection {
  const base = createBoostWithPhasesFixture();
  return {
    ...base,
    workflows: [
      {
        id: WF_BOOST,
        originActivityId: ACT_BOOST,
        state: { kind: 'known', value: 'running', evidence: LIVE_EV },
        detail: {
          kind: 'boost',
          objective: '无原生阶段字段的 Boost 运行回放',
        },
        revision: 2,
      },
    ],
  };
}
