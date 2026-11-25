import {
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asRuntimeId,
  asWorkId,
  asWorkflowId,
  type ActivityId,
  type AgentIdentity,
  type NativeAgentId,
  type RuntimeBinding,
  type WorkId,
  type WorkflowId,
} from '@harnessmate/protocol';
import type { ObservedRuntimeSignals } from '../../commands/descriptors.js';
import type { NativeIngress } from '../../wiring/types.js';
import type { BoostPlanTierEvidenceEntry } from './types.js';

export const BOOST_FIXTURE_PROVENANCE = Object.freeze({
  category: 'synthetic' as const,
  scenario: 'T11',
  note: 'Offline synthetic T11 fixtures aligned with agy-native-v1.0.0; live paid Boost runs require explicit user account/budget authorization.',
});

/**
 * Actual plan tier & evidence matrix for AGY Boost (AGY-W06).
 * Preserves honest `verifiedLevel: null` / `0` until live authorized runs occur.
 */
export const BOOST_PLAN_TIER_EVIDENCE_MATRIX: readonly BoostPlanTierEvidenceEntry[] = Object.freeze([
  {
    tierLabel: 'Free / Standard',
    expectedBoostEligible: false,
    evidenceCategory: 'official_doc',
    verifiedLevel: 0,
    evidenceRef: 'E01 · antigravity.google/docs/boost',
    note: '官方声明 Boost 为付费能力；未包含资格时返回确定性提示并保持原始模式意图，不自动升级。',
  },
  {
    tierLabel: 'Pro',
    expectedBoostEligible: true,
    evidenceCategory: 'synthetic',
    verifiedLevel: null,
    evidenceRef: 'T11-synthetic · E01',
    note: '离线合成验证广告与 live_workflow 门控；真机需用户确认账号资格与单场景预算。',
  },
  {
    tierLabel: 'Ultra',
    expectedBoostEligible: true,
    evidenceCategory: 'synthetic',
    verifiedLevel: null,
    evidenceRef: 'T11-synthetic · E01',
    note: '离线合成验证多阶段观察、验证线索与停止收尾；真机待授权采样。',
  },
  {
    tierLabel: 'Enterprise / Business',
    expectedBoostEligible: true,
    evidenceCategory: 'official_doc',
    verifiedLevel: 0,
    evidenceRef: 'E01 · antigravity.google/docs/boost',
    note: '受组织管理员策略与当前会话广告约束；若服务端拒绝则确定性降级。',
  },
  {
    tierLabel: 'Unknown (未登录 / 未观测)',
    expectedBoostEligible: null,
    evidenceCategory: 'live_raw',
    verifiedLevel: 1,
    evidenceRef: 'E02 · E04 (clean profile handshake)',
    note: '本机 1.5.16 空白握手实证未开通 session/new，无模型/计划/命令广告，保持 not_tested/unknown。',
  },
]);

export function makeBoostSyntheticBinding(overrides?: Partial<RuntimeBinding>): RuntimeBinding {
  return {
    runtimeId: overrides?.runtimeId ?? asRuntimeId('nrt_np09_boost'),
    sessionId: overrides?.sessionId ?? 'sess_np09_boost',
    instanceId: overrides?.instanceId ?? 'agy_pro',
    generation: overrides?.generation ?? asBindingGeneration('gen_np09_1'),
  };
}

export function makeBoostSignals(overrides?: Partial<ObservedRuntimeSignals>): ObservedRuntimeSignals {
  return {
    cliVersion: '1.5.16',
    protocolVersion: 1,
    profileRef: 'profile_pro_test',
    authMethod: 'oauth-personal',
    profileVerified: true,
    source: 'acp',
    tierName: 'Pro',
    effectiveModel: 'gemini-3.8-pro',
    effectivePermissionMode: 'manual',
    effectiveEnforcement: 'native',
    advertisedCommands: [
      { name: 'plan', description: 'Plan mode' },
      { name: 'boost', description: 'Deep reasoning and verification', argumentHint: '<task>' },
    ],
    hasLiveConnection: true,
    ...overrides,
  };
}

export function makeConfirmedBoostVerifierAgent(
  id: NativeAgentId = asNativeAgentId('agt_boost_verifier_1'),
): AgentIdentity {
  return {
    id,
    role: {
      kind: 'known',
      value: 'verifier',
      evidence: {
        kind: 'live_protocol',
        connectionId: 'conn_np09_1',
        ingressOrdinal: 4,
        wireVariant: 'subagent_update',
        observedAt: 1_700_000_004_000,
      },
    },
    label: {
      kind: 'known',
      value: 'Independent Verifier',
      evidence: {
        kind: 'live_protocol',
        connectionId: 'conn_np09_1',
        ingressOrdinal: 4,
        wireVariant: 'subagent_update',
        observedAt: 1_700_000_004_000,
      },
    },
    foreground: {
      kind: 'known',
      value: 'running',
      evidence: {
        kind: 'live_protocol',
        connectionId: 'conn_np09_1',
        ingressOrdinal: 4,
        wireVariant: 'subagent_update',
        observedAt: 1_700_000_004_000,
      },
    },
    launchWorkIds: [asWorkId('wrk_boost_verify_1')],
    lineage: 'confirmed',
    revision: 1,
  };
}

export interface BoostSyntheticScenarioPack {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly rootNativeSessionId: string;
  readonly workflowId: WorkflowId;
  readonly originActivityId: ActivityId;
  readonly workIds: { readonly verifyWorkId: WorkId };
  readonly frames: {
    readonly canonicalPhases: readonly NativeIngress[];
    readonly unknownStageAndDuplicate: readonly NativeIngress[];
    readonly serverDenied: NativeIngress;
    readonly nativeCancelConfirmed: NativeIngress;
    readonly modelSpontaneousMention: NativeIngress;
  };
}

export function createT11BoostSyntheticFixtures(): BoostSyntheticScenarioPack {
  const binding = makeBoostSyntheticBinding();
  const connectionId = 'conn_np09_1';
  const rootNativeSessionId = 'agy_sess_boost_001';
  const workflowId = asWorkflowId('wf_boost_t11_1');
  const originActivityId = asActivityId('act_boost_t11_1');
  const verifyWorkId = asWorkId('wrk_boost_verify_1');

  const frame = (ingressOrdinal: number, wire: unknown, channel: 'live' | 'history_replay' = 'live'): NativeIngress => ({
    binding,
    connectionId,
    ingressOrdinal,
    channel,
    originSession: rootNativeSessionId,
    wire,
  });

  return {
    binding,
    connectionId,
    rootNativeSessionId,
    workflowId,
    originActivityId,
    workIds: { verifyWorkId },
    frames: {
      canonicalPhases: [
        frame(10, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: rootNativeSessionId,
            update: {
              sessionUpdate: 'boost_phase_update',
              updateId: 'bupd_1',
              stage: {
                id: 'phase_initial',
                label: 'Initial Implementation',
                phaseKind: 'initial',
                state: 'finished',
                summary: '初步实现核心补丁与边界检查。',
              },
            },
          },
        }),
        frame(11, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: rootNativeSessionId,
            update: {
              sessionUpdate: 'boost_phase_update',
              updateId: 'bupd_2',
              stage: {
                id: 'phase_improvement',
                label: 'Challenge & Fix',
                phaseKind: 'improvement',
                state: 'finished',
                after: ['phase_initial'],
                summary: '复核竞态边界并修补去重逻辑。',
              },
            },
          },
        }),
        frame(12, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: rootNativeSessionId,
            update: {
              sessionUpdate: 'boost_phase_update',
              updateId: 'bupd_3',
              stage: {
                id: 'phase_verification',
                label: 'Independent Verification',
                phaseKind: 'verification',
                state: 'finished',
                outcome: 'succeeded',
                after: ['phase_improvement'],
                summary: '独立验证测试全部通过。',
              },
              artifact: {
                id: 'art_boost_verify_report',
                title: 'Boost Verification Summary',
                artifactKind: 'markdown',
                revision: 1,
              },
              workflowState: 'finished',
            },
          },
        }),
      ],
      unknownStageAndDuplicate: [
        frame(20, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: rootNativeSessionId,
            update: {
              sessionUpdate: 'boost_phase_update',
              updateId: 'bupd_unknown_1',
              stage: {
                id: 'stage_adversarial_audit',
                label: 'Adversarial Critic Audit',
                state: 'running',
                summary: '观测到未在标准枚举中的自定义阶段标签。',
              },
            },
          },
        }),
        // Duplicate updateId with new ordinal
        frame(21, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: rootNativeSessionId,
            update: {
              sessionUpdate: 'boost_phase_update',
              updateId: 'bupd_unknown_1',
              stage: {
                id: 'stage_adversarial_audit',
                label: 'Adversarial Critic Audit',
                state: 'running',
                summary: '观测到未在标准枚举中的自定义阶段标签。',
              },
            },
          },
        }),
        // Unknown subagent role observed during Boost
        frame(22, {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: rootNativeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc_boost_role_1',
              title: 'Run invoke_subagent',
              status: 'running',
              rawInput: {
                Role: 'Domain Spec Auditor',
                TypeName: 'research',
              },
            },
          },
        }),
      ],
      serverDenied: frame(30, {
        jsonrpc: '2.0',
        id: 9001,
        error: {
          code: -32000,
          message: 'Boost requires an eligible Pro or Ultra subscription plan.',
          data: { reason: 'PLAN_REQUIRED' },
        },
      }),
      nativeCancelConfirmed: frame(40, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: rootNativeSessionId,
          update: {
            sessionUpdate: 'boost_workflow_update',
            workflowState: 'cancelled',
            reasonCode: 'user_session_cancelled',
            summary: 'AGY 原生端已确认取消本次 Boost 执行。',
          },
        },
      }),
      modelSpontaneousMention: frame(50, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: rootNativeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'I think we should run /boost automatically to verify this thoroughly.',
            },
          },
        },
      }),
    },
  };
}
