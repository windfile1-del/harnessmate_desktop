import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  Activity,
  AgentIdentity,
  CapabilityDescriptor,
  EvidenceDto,
  NativeRuntimeProjection,
  NativeStage,
  NativeWork,
  NativeWorkflow,
  Observed,
  WorkflowId,
} from '../../../../lib/native-client';
import {
  BOOST_CAPABILITY_ID,
  BOOST_OFFICIAL_DOC_URL,
  type BoostArtifactRefView,
  type BoostEligibilityBannerModel,
  type BoostObservedPhaseView,
  type BoostPhaseDisplayClassification,
  type BoostStopTargetModel,
  type BoostStudioViewModel,
  type BoostVerificationClueView,
} from './types';

const CANONICAL_INITIAL_RE = /^(initial([_ -]?(implementation|draft|pass|solve|attempt|build))?|implement(ation)?)$/i;
const CANONICAL_IMPROVEMENT_RE = /^(improvement|improve|challenge|critique[_ -]?and[_ -]?fix|fix(es)?|refin(e|ement)|revision)$/i;
const CANONICAL_VERIFICATION_RE = /^(verification|verify|verifier|independent[_ -]?verification|final[_ -]?verification)$/i;

/**
 * Classifies an observed stage label into canonical internal enum ONLY when
 * explicit initial/improvement/verification tokens match.
 * Unknown labels are preserved verbatim without progress or round inference.
 */
export function classifyBoostStageLabel(label: string): BoostPhaseDisplayClassification {
  const cleaned = label.trim() || 'observed_stage';
  if (CANONICAL_INITIAL_RE.test(cleaned)) {
    return { kind: 'canonical', phaseKind: 'initial', label: cleaned };
  }
  if (CANONICAL_IMPROVEMENT_RE.test(cleaned)) {
    return { kind: 'canonical', phaseKind: 'improvement', label: cleaned };
  }
  if (CANONICAL_VERIFICATION_RE.test(cleaned)) {
    return { kind: 'canonical', phaseKind: 'verification', label: cleaned };
  }
  return { kind: 'observed_unknown', label: cleaned };
}

export function extractObservedEvidence<T>(observed: Observed<T> | undefined): {
  evidence: EvidenceDto | null;
  reasonCode?: string;
} {
  if (!observed) return { evidence: null };
  if (observed.kind === 'known') {
    return { evidence: observed.evidence };
  }
  if (observed.kind === 'stale') {
    return { evidence: observed.evidence ?? null, reasonCode: observed.reasonCode };
  }
  return { evidence: null, reasonCode: observed.reasonCode };
}

export function findBoostCapability(
  capabilities: readonly CapabilityDescriptor[],
): CapabilityDescriptor | null {
  return (
    capabilities.find((cap) => cap.id === BOOST_CAPABILITY_ID || cap.id === 'agy.workflow.boost') ??
    null
  );
}

export function findRootCancelCapability(
  capabilities: readonly CapabilityDescriptor[],
): CapabilityDescriptor | null {
  return (
    capabilities.find(
      (cap) =>
        (cap.id === 'AGY-R10' ||
          cap.id === 'AGY-R01' ||
          cap.id === 'agy.reactive.background' ||
          cap.id === 'agy.acp.v1') &&
        cap.control === 'available' &&
        cap.actions.some((a) => (a.key === 'cancel' || a.key === 'stop') && a.gate === 'available'),
    ) ?? null
  );
}

export function deriveBoostEligibilityBanner(
  capabilities: readonly CapabilityDescriptor[],
): BoostEligibilityBannerModel {
  const cap = findBoostCapability(capabilities);
  const launchAction = cap?.actions.find((a) => a.key === 'launch_boost');
  const launchGate = launchAction?.gate ?? cap?.launch ?? 'not_tested';
  const observeGate = cap?.observe ?? 'upstream_limited';
  const controlGate = cap?.control ?? 'unknown';
  const reasonCode =
    launchAction?.reasonCode ??
    (cap?.advertised === false
      ? 'command_not_advertised_or_revoked'
      : cap?.advertised === null
        ? 'advertisement_not_observed'
        : launchGate === 'available'
          ? 'eligible_live_workflow'
          : 'boost_gate_closed');

  const tierHint = cap?.tierHint ?? 'Pro/Ultra（以当前绑定实际广告为准）';

  let headline = 'Boost 资格待核实';
  let explanation =
    '当前绑定尚未确认 Boost 的运行时广告与计划资格；已保持原始模式意图与草稿。';

  switch (reasonCode) {
    case 'eligible_live_workflow':
      headline = '当前会话已广告 /boost（仅显式触发）';
      explanation =
        '当前绑定观测到 /boost 广告且满足资格门控；仅当用户在 Composer 显式选用 Boost（live_workflow）并点击发送时单次提交。';
      break;
    case 'tier_ineligible':
      headline = '当前账号计划未包含 Boost 资格';
      explanation =
        '当前观测到的账号计划不支持 Boost（需符合条件的付费计划）；已保持您的原始模式意图与草稿，不会自动升级到付费模式或切换账号。';
      break;
    case 'profile_unauthenticated':
      headline = 'Profile 尚未通过官方登录验证';
      explanation =
        '请先使用官方登录完成当前 Profile 认证，再刷新能力探测核实 Boost 广告与计划资格；当前保持只读说明。';
      break;
    case 'command_not_advertised_or_revoked':
      headline = '当前 ACP 会话未广告 /boost';
      explanation =
        '服务端最新 available_commands_update 未包含 /boost（或已被撤销）；已禁用发起入口并保持原始模式意图。';
      break;
    case 'agy_desktop_source_unsupported':
      headline = 'AGY Desktop 来源不支持 ACP 直接发起';
      explanation =
        '当前绑定来源为 AGY Desktop，ACP 路径不提供直接 /boost 触发；请在官方 App/CLI 中执行。';
      break;
    case 'native_action_not_connected':
      headline = 'Boost 离线观测已就绪 · 原生触发待接线授权';
      explanation =
        '当前会话已识别 /boost 能力边界，但 live_workflow 写入门控尚未对付费模式开放；离线观察、降级展示与只读回放保持可用。';
      break;
    case 'no_live_connection':
      headline = '当前无活跃 live ACP 连接';
      explanation =
        'Boost 必须在同一活跃 ACP 会话中运行，禁止启动独立辅助 CLI 替代；恢复连接后请刷新能力探测。';
      break;
    default:
      if (launchGate === 'unsupported') {
        headline = '当前环境不支持发起 Boost';
        explanation = `当前能力门控返回不支持 (${reasonCode})；已保持原始模式意图与草稿。`;
      } else if (launchGate === 'not_tested') {
        headline = 'Boost 等待授权与真机验证';
        explanation =
          'Boost 属于按需付费增强推理模式；在获得用户账号资格与单场景预算确认前保持安全门控。';
      }
      break;
  }

  return {
    capabilityId: cap?.id ?? BOOST_CAPABILITY_ID,
    launchGate,
    observeGate,
    controlGate,
    advertised: cap?.advertised ?? null,
    tierHint,
    versionNote: cap?.versionNote,
    snapshotRevision: cap?.snapshotRevision ?? 0,
    reasonCode,
    headline,
    explanation,
    autoUpgradeNotice: '默认不自动升级到付费模式 · 保持原始模式意图 · 仅用户显式选用 live_workflow 触发',
    officialEntryHint: '官方 App / CLI 中可使用 /boost <task> 发起深度实现与独立验证。',
    officialDocUrl: BOOST_OFFICIAL_DOC_URL,
    evidenceRefs: cap?.evidenceRefs ?? ['E01'],
    verifiedLevel: cap?.verifiedLevel ?? null,
    isEligibleToLaunch: launchGate === 'available' && cap?.advertised === true,
  };
}

export function selectBoostWorkflows(
  projection: NativeRuntimeProjection | null,
): readonly NativeWorkflow[] {
  if (!projection) return [];
  return projection.workflows.filter((wf) => wf.detail.kind === 'boost');
}

export function parseBoostResourceItems(
  resource: 'phases' | 'logs' | 'artifacts',
  items: ReadonlyArray<Record<string, unknown>>,
): {
  logs: BoostVerificationClueView[];
  artifacts: BoostArtifactRefView[];
  phaseSummariesById: Record<string, string>;
} {
  const logs: BoostVerificationClueView[] = [];
  const artifacts: BoostArtifactRefView[] = [];
  const phaseSummariesById: Record<string, string> = {};

  for (const item of items) {
    if (resource === 'logs' && item.kind === 'log_entry') {
      const entryId = typeof item.entryId === 'string' ? item.entryId : '';
      const summary = typeof item.summary === 'string' ? item.summary : '';
      if (!entryId || !summary) continue;
      const level = item.level === 'error' || item.level === 'warn' ? item.level : 'info';
      logs.push({
        id: entryId,
        seq: typeof item.seq === 'number' ? item.seq : logs.length + 1,
        level,
        summary,
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
        evidence: item.evidence as EvidenceDto | undefined,
      });
    } else if (resource === 'artifacts' && item.kind === 'artifact_ref') {
      const artifactId = typeof item.artifactId === 'string' ? item.artifactId : '';
      const title = typeof item.title === 'string' ? item.title : '';
      if (!artifactId || !title) continue;
      artifacts.push({
        artifactId,
        title,
        artifactKind: typeof item.artifactKind === 'string' ? item.artifactKind : 'unknown',
        revision: typeof item.revision === 'number' ? item.revision : 1,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        evidence: item.evidence as EvidenceDto | undefined,
      });
    } else if (resource === 'phases' && item.kind === 'phase') {
      const stage = item.stage as NativeStage | undefined;
      if (stage?.id && typeof item.summary === 'string' && item.summary.trim()) {
        phaseSummariesById[stage.id] = item.summary.trim();
      }
    }
  }

  return { logs, artifacts, phaseSummariesById };
}

export function deriveBoostStudioViewModel(
  projection: NativeRuntimeProjection | null,
  capabilities: readonly CapabilityDescriptor[],
  pendingApprovals: readonly ApprovalRequest[],
  selectedWorkflowId?: WorkflowId | null,
  phaseSummariesById: Readonly<Record<string, string>> = {},
): BoostStudioViewModel {
  const eligibility = deriveBoostEligibilityBanner(capabilities);
  const boostWorkflows = selectBoostWorkflows(projection);
  const activeWorkflow =
    boostWorkflows.find((wf) => wf.id === selectedWorkflowId) ?? boostWorkflows[0] ?? null;

  if (!projection || !activeWorkflow || activeWorkflow.detail.kind !== 'boost') {
    return {
      eligibility,
      boostWorkflows,
      activeWorkflow: null,
      phases: null,
      originActivity: null,
      relatedActivities: [],
      relatedWork: [],
      relatedAgents: [],
      relatedApprovals: [],
      stopTarget: null,
      workflowEvidence: null,
    };
  }

  const agentsById = new Map(projection.agents.map((a) => [a.id, a]));
  const rawPhases = activeWorkflow.detail.phases;
  const phases: readonly BoostObservedPhaseView[] | null =
    rawPhases && rawPhases.length > 0
      ? rawPhases.map((stage) => {
          const ev = extractObservedEvidence(stage.state);
          const linkedAgents = (stage.agentIds ?? [])
            .map((id) => agentsById.get(id))
            .filter((agent): agent is AgentIdentity => Boolean(agent && agent.lineage === 'confirmed'));
          return {
            stage,
            classification: classifyBoostStageLabel(stage.label),
            linkedAgents,
            ...(phaseSummariesById[stage.id] ? { summary: phaseSummariesById[stage.id] } : {}),
            evidence: ev.evidence,
            ...(ev.reasonCode ? { reasonCode: ev.reasonCode } : {}),
          };
        })
      : null;

  const relatedWork = projection.work.filter(
    (w) => w.workflowId === activeWorkflow.id || w.originActivityId === activeWorkflow.originActivityId,
  );
  const relatedWorkIds = new Set(relatedWork.map((w) => w.id));

  const originActivity =
    projection.activities.find((a) => a.id === activeWorkflow.originActivityId) ?? null;

  const relatedActivities = projection.activities.filter(
    (a) =>
      a.id === activeWorkflow.originActivityId ||
      a.priorActivityId === activeWorkflow.originActivityId ||
      (a.workId !== undefined && relatedWorkIds.has(a.workId)),
  );
  const relatedActivityIds = new Set(relatedActivities.map((a) => a.id));

  const relatedAgentIdSet = new Set<string>();
  for (const phase of rawPhases ?? []) {
    for (const id of phase.agentIds ?? []) {
      relatedAgentIdSet.add(id);
    }
  }
  for (const w of relatedWork) {
    if (w.ownerAgentId) relatedAgentIdSet.add(w.ownerAgentId);
  }
  for (const a of relatedActivities) {
    if (a.agentId) relatedAgentIdSet.add(a.agentId);
  }
  const relatedAgents = projection.agents.filter((agent) => relatedAgentIdSet.has(agent.id));

  const relatedApprovals = pendingApprovals.filter((appr) => {
    const receipt = projection.receipts?.[appr.id];
    if (!receipt) return false;
    if (receipt.activityId && relatedActivityIds.has(receipt.activityId)) return true;
    if (receipt.agentId && relatedAgentIdSet.has(receipt.agentId)) return true;
    return false;
  });

  const boostCap = findBoostCapability(capabilities);
  const rootCancelCap = findRootCancelCapability(capabilities);

  let stopTarget: BoostStopTargetModel;
  if (
    boostCap &&
    boostCap.control === 'available' &&
    boostCap.actions.some((a) => (a.key === 'cancel' || a.key === 'stop') && a.gate === 'available')
  ) {
    stopTarget = {
      targetType: 'workflow',
      targetId: activeWorkflow.id,
      targetLabel: `Boost ${activeWorkflow.id}`,
      expectedRevision: activeWorkflow.revision,
      capability: boostCap,
      interruptionNote: '已验证工作流级原生停止动作。',
    };
  } else {
    stopTarget = {
      targetType: 'runtime',
      targetId: projection.binding.runtimeId,
      targetLabel: `根会话 ${projection.binding.runtimeId}`,
      expectedRevision: projection.asOfSeq,
      capability: rootCancelCap,
      interruptionNote: rootCancelCap
        ? '当前 ACP v1 仅验证根会话级 session/cancel，不虚构单阶段或子 Agent 独立停止；点击后等待原生终态确认。'
        : '当前绑定未开放已验证的停止控制，已保持只读边界。',
    };
  }

  const wfEv = extractObservedEvidence(activeWorkflow.state);

  return {
    eligibility,
    boostWorkflows,
    activeWorkflow,
    phases,
    originActivity,
    relatedActivities,
    relatedWork,
    relatedAgents,
    relatedApprovals,
    stopTarget,
    workflowEvidence: wfEv.evidence,
    ...(wfEv.reasonCode ? { workflowReasonCode: wfEv.reasonCode } : {}),
  };
}
