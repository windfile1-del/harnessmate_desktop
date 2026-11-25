import type { ApprovalRequest, Session } from '@harnessmate/protocol';
import type {
  CapabilityDescriptor,
  NativeAgentId,
  NativeRequestReceiptDto,
  NativeRuntimeProjection,
  NativeStage,
  NativeWorkflow,
  WorkflowId,
} from '../../../../lib/native-client';
import type {
  TeamworkApprovalGateState,
  TeamworkArtifactItemView,
  TeamworkAuditEntryView,
  TeamworkProjectScopeView,
  TeamworkReviewControlProps,
  TeamworkRoleKind,
  TeamworkRoleView,
} from './types';

export const TEAMWORK_OFFICIAL_DOC_URL = 'https://antigravity.google/docs/teamwork/';
export const TEAMWORK_ARTIFACT_DOC_URL = 'https://antigravity.google/docs/artifact-review/';
export const TEAMWORK_DEFAULT_OFFICIAL_HINT =
  '在官方 Antigravity App 或 CLI 中使用 /teamwork <goal>（不假定旧 /teamwork-preview 可用）；缺少原生批准协议时请在官方端完成 Prompt Artifact 审阅与批准。';

export const TEAMWORK_ROLE_LABELS: Record<TeamworkRoleKind, string> = {
  sentinel: 'Sentinel',
  project_orchestrator: 'Project Orchestrator',
  milestone_worker: 'Milestone Worker',
  auditor: 'Auditor',
  unknown_role: 'Teamwork 角色',
};

export const TEAMWORK_APPROVAL_GATE_LABELS: Record<
  TeamworkApprovalGateState,
  { readonly label: string; readonly tone: 'neutral' | 'indigo' | 'emerald' | 'star' | 'rose' | 'clay' }
> = {
  not_reached: { label: '尚未进入 Prompt 审阅', tone: 'neutral' },
  awaiting_native_approval: { label: '等待原生协议批准', tone: 'star' },
  upstream_limited_manual_app: { label: '缺少原生批准入口 · 指引官方 App', tone: 'clay' },
  approved: { label: '已通过原生批准', tone: 'emerald' },
  rejected: { label: '已拒绝（未创建项目）', tone: 'rose' },
  cancelled: { label: '已取消（未创建项目）', tone: 'neutral' },
  expired: { label: '审批已过期（未创建项目）', tone: 'clay' },
  connection_lost: { label: '连接已断开 · 审批已失效', tone: 'rose' },
  delivery_unknown: { label: '送达状态未知 · 禁止重放', tone: 'rose' },
};

export type TeamworkWorkflowEntity = NativeWorkflow & {
  detail: Extract<NativeWorkflow['detail'], { kind: 'teamwork' }>;
};

export function selectTeamworkWorkflows(
  projection: NativeRuntimeProjection | null,
): TeamworkWorkflowEntity[] {
  if (!projection) return [];
  return projection.workflows.filter(
    (wf): wf is TeamworkWorkflowEntity => wf.detail.kind === 'teamwork',
  );
}

export function selectActiveTeamworkWorkflow(
  projection: NativeRuntimeProjection | null,
  selectedWorkflowId?: WorkflowId | null,
): TeamworkWorkflowEntity | null {
  const list = selectTeamworkWorkflows(projection);
  if (list.length === 0) return null;
  if (selectedWorkflowId) {
    const matched = list.find((w) => w.id === selectedWorkflowId);
    if (matched) return matched;
  }
  return list[0] ?? null;
}

export function findTeamworkCapability(
  capabilities: readonly CapabilityDescriptor[],
): CapabilityDescriptor | undefined {
  return capabilities.find((c) => c.id === 'AGY-W07' || c.id === 'agy.workflow.teamwork');
}

export function classifyTeamworkRoleLabel(raw: string): TeamworkRoleKind {
  const lowered = raw.trim().toLowerCase();
  if (lowered.includes('sentinel')) return 'sentinel';
  if (lowered.includes('orchestrator')) return 'project_orchestrator';
  if (lowered.includes('audit')) return 'auditor';
  if (lowered.includes('worker') || lowered.includes('executor') || lowered.includes('implement')) {
    return 'milestone_worker';
  }
  return 'unknown_role';
}

/**
 * Separates confirmed Teamwork roles (`lineage === 'confirmed'`) from unconfirmed candidates.
 * Never fabricates Sentinel/Orchestrator/Auditor roles from plain chat prose.
 */
export function deriveTeamworkRoles(
  projection: NativeRuntimeProjection | null,
  workflow: TeamworkWorkflowEntity | null,
): {
  readonly confirmedRoles: TeamworkRoleView[];
  readonly unconfirmedCandidates: TeamworkRoleView[];
} {
  if (!projection || !workflow) {
    return { confirmedRoles: [], unconfirmedCandidates: [] };
  }

  const milestoneIdsByAgent = new Map<NativeAgentId, string[]>();
  for (const ms of workflow.detail.milestones ?? []) {
    for (const agentId of ms.agentIds ?? []) {
      const existing = milestoneIdsByAgent.get(agentId) ?? [];
      if (!existing.includes(ms.id)) existing.push(ms.id);
      milestoneIdsByAgent.set(agentId, existing);
    }
  }

  const confirmedRoles: TeamworkRoleView[] = [];
  const unconfirmedCandidates: TeamworkRoleView[] = [];

  for (const agent of projection.agents) {
    const roleText = agent.role?.kind === 'known' ? agent.role.value : '';
    const labelText = agent.label?.kind === 'known' ? agent.label.value : '';
    const assignedMilestones = milestoneIdsByAgent.get(agent.id) ?? [];
    const roleKind = classifyTeamworkRoleLabel(`${roleText} ${labelText}`);

    // Include agents that either carry a recognized Teamwork role or are referenced by a verified milestone
    if (roleKind === 'unknown_role' && assignedMilestones.length === 0) continue;

    const view: TeamworkRoleView = {
      agentId: agent.id,
      roleKind,
      displayLabel: labelText || roleText || agent.id,
      lineage: agent.lineage,
      foreground: agent.foreground,
      milestoneIds: assignedMilestones,
    };

    if (agent.lineage === 'confirmed') {
      confirmedRoles.push(view);
    } else {
      unconfirmedCandidates.push(view);
    }
  }

  return { confirmedRoles, unconfirmedCandidates };
}

export function deriveTeamworkScopingRequests(
  projection: NativeRuntimeProjection | null,
  pendingApprovals: readonly ApprovalRequest[],
  workflow: TeamworkWorkflowEntity | null,
): {
  readonly pendingScopingApprovals: ApprovalRequest[];
  readonly scopingReceipts: NativeRequestReceiptDto[];
} {
  if (!projection || !workflow) {
    return { pendingScopingApprovals: [], scopingReceipts: [] };
  }

  const scopingActId = workflow.detail.scopingActivityId;
  const originActId = workflow.originActivityId;
  const allReceipts = Object.values(projection.receipts ?? {});

  const matchesWorkflowActivity = (receipt: NativeRequestReceiptDto | undefined): boolean => {
    if (!receipt) return false;
    if (scopingActId && receipt.activityId === scopingActId) return true;
    if (receipt.activityId === originActId) return true;
    return false;
  };

  const pendingScopingApprovals = pendingApprovals.filter((appr) => {
    const receipt = projection.receipts?.[appr.id];
    if (matchesWorkflowActivity(receipt)) return true;
    return !scopingActId && (appr.kind === 'user_question' || receipt?.kind === 'question' || receipt?.kind === 'elicitation');
  });

  const scopingReceipts = allReceipts.filter((receipt) => matchesWorkflowActivity(receipt));
  return { pendingScopingApprovals, scopingReceipts };
}

export function deriveTeamworkApprovalGate(opts: {
  readonly projection: NativeRuntimeProjection | null;
  readonly workflow: TeamworkWorkflowEntity | null;
  readonly capability?: CapabilityDescriptor;
  readonly reviewControl?: TeamworkReviewControlProps;
  readonly teamworkFeatureEnabled: boolean;
  readonly override?: TeamworkApprovalGateState;
}): {
  readonly gateState: TeamworkApprovalGateState;
  readonly canActNativeApproval: boolean;
  readonly disabledReason: string | null;
} {
  const { projection, workflow, capability, reviewControl, teamworkFeatureEnabled, override } = opts;

  let gateState: TeamworkApprovalGateState = override ?? 'not_reached';
  if (!override && workflow) {
    const wfVal = workflow.state.kind === 'known' ? workflow.state.value : null;
    const hasProjectOrMilestones = Boolean(
      workflow.detail.projectLabel || (workflow.detail.milestones && workflow.detail.milestones.length > 0),
    );
    if (projection?.status === 'disconnected' && workflow.detail.promptArtifactId && !hasProjectOrMilestones) {
      gateState = 'connection_lost';
    } else if (hasProjectOrMilestones) {
      gateState = 'approved';
    } else if (wfVal === 'cancelled') {
      gateState = 'cancelled';
    } else if (workflow.detail.promptArtifactId) {
      gateState =
        reviewControl?.reviewControlEnabled && reviewControl?.canApproveViaNativeProtocol
          ? 'awaiting_native_approval'
          : 'upstream_limited_manual_app';
    }
  }

  const isAttached = projection?.status === 'attached';
  const reviewEnabled = reviewControl?.reviewControlEnabled === true;
  const nativeCapAvailable =
    reviewControl?.canApproveViaNativeProtocol === true &&
    (capability ? capability.control !== 'unsupported' : true);

  const canActNativeApproval =
    teamworkFeatureEnabled &&
    isAttached &&
    reviewEnabled &&
    nativeCapAvailable &&
    gateState === 'awaiting_native_approval' &&
    Boolean(reviewControl?.onNativeApprove || reviewControl?.onNativeReject);

  let disabledReason: string | null = null;
  if (!teamworkFeatureEnabled) {
    disabledReason = 'Teamwork 功能门控已关闭，已呈现的历史记录保持只读。';
  } else if (!isAttached) {
    disabledReason = '原生运行时尚未连接或正在重连校准，已禁用交互审阅操作（旧授权永不重放）。';
  } else if (gateState === 'rejected' || gateState === 'cancelled' || gateState === 'expired') {
    disabledReason = 'Prompt Artifact 批准门控已关闭，未创建 Teamwork 项目或里程碑。';
  } else if (!reviewEnabled) {
    disabledReason =
      reviewControl?.disabledReason ??
      'Prompt Artifact 审阅控制已关闭（保留历史只读）；如需批准请在官方 Antigravity App 或 CLI 中操作。';
  } else if (!nativeCapAvailable) {
    disabledReason =
      reviewControl?.disabledReason ??
      '当前 ACP 连接尚未提供已验证的原生 Prompt Artifact 批准动作（等待 NP-14 联测），禁止通过自然语言伪造批准。';
  }

  return { gateState, canActNativeApproval, disabledReason };
}

export function deriveTeamworkProjectScope(
  session: Session,
  workflow: TeamworkWorkflowEntity | null,
  override?: TeamworkProjectScopeView,
): TeamworkProjectScopeView {
  if (override) return override;
  const created = Boolean(workflow?.detail.projectLabel);
  return {
    hmWorkspaceLabel: session.workspaceId || 'HM Session Workspace',
    hmWorkspaceId: session.workspaceId || undefined,
    nativeProjectCreated: created,
    nativeProjectLabel: workflow?.detail.projectLabel,
    scopeRelationship: created ? 'distinct_from_hm_workspace' : 'unverified',
    pathAccessGate: created ? 'requires_explicit_authorization' : 'unavailable',
    pathOpenAuthorized: false,
    authorizationReasonCode: created
      ? 'native_project_path_requires_explicit_authorization'
      : 'native_project_not_created',
  };
}

export function parseWorkflowResourcePhases(
  items: ReadonlyArray<Record<string, unknown>>,
): NativeStage[] {
  const stages: NativeStage[] = [];
  for (const item of items) {
    if (item.kind === 'phase' && item.stage && typeof item.stage === 'object') {
      stages.push(item.stage as NativeStage);
    }
  }
  return stages;
}

export function parseWorkflowResourceArtifacts(
  items: ReadonlyArray<Record<string, unknown>>,
  promptArtifactId?: string,
): TeamworkArtifactItemView[] {
  const result: TeamworkArtifactItemView[] = [];
  for (const item of items) {
    if (item.kind !== 'artifact_ref' || typeof item.artifactId !== 'string') continue;
    result.push({
      artifactId: item.artifactId,
      title: typeof item.title === 'string' ? item.title : item.artifactId,
      artifactKind:
        typeof item.artifactKind === 'string'
          ? (item.artifactKind as TeamworkArtifactItemView['artifactKind'])
          : 'unknown',
      isPromptArtifact: Boolean(promptArtifactId && item.artifactId === promptArtifactId),
      ...(typeof item.ownerAgentId === 'string'
        ? { ownerAgentId: item.ownerAgentId as NativeAgentId }
        : {}),
      revision: typeof item.revision === 'number' ? item.revision : 1,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    });
  }
  return result;
}

export function parseWorkflowResourceAuditLogs(
  items: ReadonlyArray<Record<string, unknown>>,
): TeamworkAuditEntryView[] {
  const result: TeamworkAuditEntryView[] = [];
  for (const item of items) {
    if (item.kind !== 'log_entry' || typeof item.entryId !== 'string') continue;
    const summary = typeof item.summary === 'string' ? item.summary : '';
    const verdict: TeamworkAuditEntryView['verdict'] = summary.includes('passed')
      ? 'passed'
      : summary.includes('failed')
        ? 'failed'
        : summary.includes('changes_requested')
          ? 'changes_requested'
          : summary.includes('cancelled')
            ? 'cancelled'
            : summary.includes('pending')
              ? 'pending'
              : 'unknown';
    result.push({
      auditId: item.entryId,
      label: summary.slice(0, 140) || item.entryId,
      verdict,
      summary,
    });
  }
  return result;
}
