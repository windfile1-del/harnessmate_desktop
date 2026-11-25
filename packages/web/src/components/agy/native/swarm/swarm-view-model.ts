import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  Activity,
  AgentIdentity,
  CapabilityDescriptor,
  EvidenceDto,
  EvidenceSourceKind,
  NativeAgentId,
  NativeRuntimeProjection,
  NativeRuntimeStatus,
  NativeWorkflow,
  NativeWorkflowResourcePageResponse,
  WorkflowId,
} from '../../../../lib/native-client';

export type SwarmStudioTab = 'overview' | 'workers' | 'board' | 'activity';

export const SWARM_OFFICIAL_DOC_URL = 'https://antigravity.google/docs/swarm/' as const;
export const SWARM_OFFICIAL_CLI_BOARD_HINT = '在官方 CLI 中运行 /swarm board 或按 Alt+S 查看完整协作板。' as const;
export const SWARM_OFFICIAL_CLI_LAUNCH_HINT = '在官方 CLI 中运行 /swarm <task> 发起原生 Swarm 协作。' as const;

export type SwarmWorkflowEntity = NativeWorkflow & {
  readonly detail: Extract<NativeWorkflow['detail'], { kind: 'swarm' }>;
};

export interface SwarmWorkerViewRow {
  readonly agent: AgentIdentity;
  readonly displayName: string;
  readonly memberRole: 'coordinator' | 'worker' | 'verifier';
  readonly isConfirmed: boolean;
  readonly isIdle: boolean;
  readonly isActiveRunning: boolean;
  readonly isFailed: boolean;
  readonly isFinished: boolean;
  readonly isUnknownOrStale: boolean;
  readonly isReadOnlySnapshotOnly: boolean;
  readonly provenance: EvidenceDto | null;
  readonly pendingApprovals: readonly ApprovalRequest[];
}

export interface SwarmWorkerSummaryCounts {
  readonly totalConfirmedMembers: number;
  readonly runningCount: number;
  readonly requiresActionCount: number;
  /** Idle workers are tracked explicitly and NEVER counted as succeeded progress. */
  readonly idleCount: number;
  readonly failedCount: number;
  readonly finishedCount: number;
  readonly unknownOrStaleCount: number;
  readonly unconfirmedCandidateCount: number;
  /** Always false when workers are idle/unknown or Board/outcomes are incomplete; prevents fake progress bars. */
  readonly hasFakeProgressBar: false;
}

export interface SwarmBoardPostDto {
  readonly postId: string;
  readonly threadId?: string;
  readonly authorAgentId?: NativeAgentId;
  readonly authorLabel?: string;
  readonly summary: string;
  readonly truncated: boolean;
  readonly createdAt: number;
  readonly evidence: EvidenceDto;
}

export interface SwarmBoardThreadGroup {
  readonly threadId: string;
  readonly rootPost: SwarmBoardPostDto | null;
  readonly replies: readonly SwarmBoardPostDto[];
  readonly latestAt: number;
}

export interface SwarmLogEntryDto {
  readonly entryId: string;
  readonly seq: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly summary: string;
  readonly truncated: boolean;
  readonly createdAt: number;
  readonly evidence: EvidenceDto;
}

export interface SwarmBoardStatusSummary {
  readonly status: 'available' | 'upstream_limited' | 'stale' | 'unknown' | 'gate_disabled';
  readonly title: string;
  readonly reason: string;
  readonly reasonCode?: string;
  readonly evidence: EvidenceDto | null;
  readonly canPostOrMention: false;
}

export interface SwarmControlGuardResult {
  readonly capability: CapabilityDescriptor | null;
  readonly blockReason?: string;
}

export interface SwarmStudioViewModel {
  readonly workflows: readonly SwarmWorkflowEntity[];
  readonly selectedWorkflow: SwarmWorkflowEntity | null;
  readonly coordinator: SwarmWorkerViewRow | null;
  readonly workers: readonly SwarmWorkerViewRow[];
  readonly verifiers: readonly SwarmWorkerViewRow[];
  readonly unconfirmedMembers: readonly SwarmWorkerViewRow[];
  readonly counts: SwarmWorkerSummaryCounts;
  readonly boardStatus: SwarmBoardStatusSummary;
  readonly linkedApprovals: readonly ApprovalRequest[];
  readonly unconfirmedApprovalCount: number;
  readonly activities: readonly Activity[];
  readonly swarmCapability: CapabilityDescriptor | null;
  readonly boardCapability: CapabilityDescriptor | null;
  readonly workflowProvenance: EvidenceDto | null;
}

export function extractAgentEvidence(agent: AgentIdentity): EvidenceDto | null {
  if (agent.foreground.kind === 'known') return agent.foreground.evidence;
  if (agent.foreground.kind === 'stale' && agent.foreground.evidence) return agent.foreground.evidence;
  if (agent.status?.kind === 'known') return agent.status.evidence;
  if (agent.label?.kind === 'known') return agent.label.evidence;
  if (agent.role?.kind === 'known') return agent.role.evidence;
  return null;
}

export function resolveSwarmAgentDisplayName(agent: AgentIdentity): string {
  if (agent.label?.kind === 'known' && agent.label.value.trim()) return agent.label.value.trim();
  if (agent.role?.kind === 'known' && agent.role.value.trim()) return agent.role.value.trim();
  return agent.id;
}

function classifyMemberRole(
  agent: AgentIdentity,
  isCoordinator: boolean,
): 'coordinator' | 'worker' | 'verifier' {
  if (isCoordinator) return 'coordinator';
  const roleText = agent.role?.kind === 'known' ? agent.role.value : '';
  const labelText = agent.label?.kind === 'known' ? agent.label.value : '';
  if (/\bverifier\b|verify|reviewer|audit/i.test(`${roleText} ${labelText}`)) {
    return 'verifier';
  }
  return 'worker';
}

function buildWorkerRow(
  agent: AgentIdentity,
  isCoordinator: boolean,
  projection: NativeRuntimeProjection,
  pendingApprovals: readonly ApprovalRequest[],
): SwarmWorkerViewRow {
  const provenance = extractAgentEvidence(agent);
  const isConfirmed = agent.lineage === 'confirmed';
  const linkedApprovals = isConfirmed
    ? pendingApprovals.filter((appr) => {
        const receipt = projection.receipts?.[appr.id];
        return receipt?.agentId === agent.id && receipt.targetLineage === 'confirmed';
      })
    : [];

  const isIdle = agent.foreground.kind === 'known' && agent.foreground.value === 'idle';
  const isActiveRunning =
    agent.foreground.kind === 'known' && agent.foreground.value === 'running';
  const isFailed = agent.status?.kind === 'known' && agent.status.value === 'failed';
  const isFinished = agent.status?.kind === 'known' && agent.status.value === 'finished';
  const isUnknownOrStale =
    agent.foreground.kind !== 'known' || agent.foreground.value === 'unknown';
  const isReadOnlySnapshotOnly =
    provenance?.sourceKind === 'native_snapshot' || provenance?.sourceKind === 'replay';

  return {
    agent,
    displayName: resolveSwarmAgentDisplayName(agent),
    memberRole: classifyMemberRole(agent, isCoordinator),
    isConfirmed,
    isIdle,
    isActiveRunning,
    isFailed,
    isFinished,
    isUnknownOrStale,
    isReadOnlySnapshotOnly,
    provenance,
    pendingApprovals: linkedApprovals,
  };
}

export function findSwarmCapability(
  capabilities: readonly CapabilityDescriptor[],
  ids: readonly string[],
): CapabilityDescriptor | null {
  for (const id of ids) {
    const found = capabilities.find((c) => c.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * Strictly gates Swarm workflow/member controls.
 * Never allows control actions when runtime is disconnected/reconciling, target is unconfirmed,
 * source is snapshot/replay only, or capability descriptor does not expose an `available` control action.
 */
export function resolveSafeSwarmControlCapability(input: {
  readonly runtimeStatus: NativeRuntimeStatus;
  readonly targetConfirmed: boolean;
  readonly targetEvidence: EvidenceDto | null;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly targetKind: 'workflow' | 'agent';
}): SwarmControlGuardResult {
  if (input.runtimeStatus !== 'attached') {
    return {
      capability: null,
      blockReason: '观测连接未附着，已禁用原生控制动作。',
    };
  }
  if (!input.targetConfirmed) {
    return {
      capability: null,
      blockReason: '成员身份尚未确证，已禁用原生控制动作。',
    };
  }
  if (
    input.targetEvidence?.sourceKind === 'native_snapshot' ||
    input.targetEvidence?.sourceKind === 'replay'
  ) {
    return {
      capability: null,
      blockReason: '当前数据来自只读快照或历史回放，仅允许只读查看。',
    };
  }

  const candidateIds =
    input.targetKind === 'workflow'
      ? ['agy.workflow.swarm', 'AGY-W04']
      : ['agy.workflow.swarm', 'AGY-W04', 'agy.subagents', 'AGY-W02'];
  const cap = findSwarmCapability(input.capabilities, candidateIds);
  if (!cap || cap.control !== 'available') {
    return {
      capability: null,
      blockReason:
        cap?.control === 'upstream_limited'
          ? '上游 ACP 尚未开放 Swarm 成员/工作流控制动作，当前保持只读。'
          : '当前绑定未广告可用的 Swarm 原生控制动作。',
    };
  }
  const hasAvailableAction =
    cap.actions.length === 0 || cap.actions.some((a) => a.gate === 'available');
  if (!hasAvailableAction) {
    return {
      capability: null,
      blockReason: '能力目录中无已验证可用的控制动作，已保持只读。',
    };
  }
  return { capability: cap };
}

export function resolveSwarmBoardStatus(
  workflow: SwarmWorkflowEntity | null,
  boardCap: CapabilityDescriptor | null,
  resourceUnavailableReason?: string,
): SwarmBoardStatusSummary {
  if (resourceUnavailableReason === 'swarm_board_gate_disabled' || resourceUnavailableReason === 'swarm_gate_disabled') {
    return {
      status: 'gate_disabled',
      title: 'Swarm Board 门控已关闭',
      reason: 'Swarm 或 Board 门控已关闭；已保留捕获的 Coordinator 轨迹供只读排查，不显示假进度。',
      reasonCode: resourceUnavailableReason,
      evidence: null,
      canPostOrMention: false,
    };
  }

  if (!workflow) {
    return {
      status: boardCap?.observe === 'upstream_limited' ? 'upstream_limited' : 'unknown',
      title: '当前 ACP 未提供 Board',
      reason: '尚未观察到活跃的 Swarm 工作流或结构化 Board feed。空列表不能证明原生侧已停止。',
      reasonCode: 'no_swarm_workflow_observed',
      evidence: null,
      canPostOrMention: false,
    };
  }

  const board = workflow.detail.board;
  if (board.kind === 'known' && board.value === 'available' && !resourceUnavailableReason) {
    return {
      status: 'available',
      title: '已观测到结构化 Board 源（只读）',
      reason: '当前 Board 帖子来自已验证的同作用域结构化源；不自动发送 @mention 或代写帖子。',
      evidence: board.evidence,
      canPostOrMention: false,
    };
  }

  if (board.kind === 'stale') {
    return {
      status: 'stale',
      title: 'Board 观测已过期',
      reason: `连接变动或快照过期 (${board.reasonCode})，仅保留最后观测到的历史帖子，禁用一切动作。`,
      reasonCode: board.reasonCode,
      evidence: board.evidence ?? null,
      canPostOrMention: false,
    };
  }

  if (
    (board.kind === 'known' && board.value === 'upstream_limited') ||
    resourceUnavailableReason === 'acp_swarm_board_not_exposed'
  ) {
    return {
      status: 'upstream_limited',
      title: '当前 ACP 未提供 Board',
      reason:
        '当前 ACP 协议流未暴露 Swarm Board 帖子 feed；保留 Coordinator 轨迹与已确认成员，不从文本伪造帖子、Worker 或进度。',
      reasonCode: resourceUnavailableReason ?? 'acp_swarm_board_not_exposed',
      evidence: board.kind === 'known' ? board.evidence : null,
      canPostOrMention: false,
    };
  }

  const reasonCode =
    resourceUnavailableReason ?? (board.kind === 'unknown' ? board.reasonCode : 'board_status_unknown');
  if (reasonCode === 'swarm_board_gate_disabled') {
    return {
      status: 'gate_disabled',
      title: 'Swarm Board 门控已关闭',
      reason: 'Board 单独门控已关闭；已保留 Coordinator 轨迹与官方入口说明。',
      reasonCode,
      evidence: null,
      canPostOrMention: false,
    };
  }

  return {
    status: 'unknown',
    title: '当前 ACP 未提供 Board',
    reason: '尚未观测到已验证的 Board 数据源；不会从 Coordinator 输出或未验证私有数据库推测帖子。',
    reasonCode,
    evidence: null,
    canPostOrMention: false,
  };
}

/**
 * Safely parses `kind: 'board_post'` items from a paginated workflow resource response
 * and deduplicates by stable `postId`.
 */
export function parseBoardResourcePosts(
  page: NativeWorkflowResourcePageResponse,
  existing: readonly SwarmBoardPostDto[] = [],
): SwarmBoardPostDto[] {
  const byId = new Map<string, SwarmBoardPostDto>(existing.map((p) => [p.postId, p]));
  const ordered: SwarmBoardPostDto[] = [...existing];

  for (const raw of page.items) {
    if (!raw || raw.kind !== 'board_post') continue;
    const postId = typeof raw.postId === 'string' ? raw.postId.trim() : '';
    const summary = typeof raw.summary === 'string' ? raw.summary : '';
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    const evidence = raw.evidence as EvidenceDto | undefined;
    if (!postId || !evidence || typeof evidence.sourceKind !== 'string') continue;

    const dto: SwarmBoardPostDto = {
      postId,
      ...(typeof raw.threadId === 'string' && raw.threadId ? { threadId: raw.threadId } : {}),
      ...(typeof raw.authorAgentId === 'string' && raw.authorAgentId
        ? { authorAgentId: raw.authorAgentId as NativeAgentId }
        : {}),
      ...(typeof raw.authorLabel === 'string' && raw.authorLabel ? { authorLabel: raw.authorLabel } : {}),
      summary,
      truncated: raw.truncated === true,
      createdAt,
      evidence,
    };

    if (byId.has(postId)) {
      const idx = ordered.findIndex((p) => p.postId === postId);
      if (idx >= 0) ordered[idx] = dto;
      byId.set(postId, dto);
    } else {
      ordered.push(dto);
      byId.set(postId, dto);
    }
  }

  return ordered;
}

/**
 * Groups stable-ID Board posts into expandable thread groups preserving chronological order.
 */
export function groupBoardPostsIntoThreads(
  posts: readonly SwarmBoardPostDto[],
): SwarmBoardThreadGroup[] {
  const groups = new Map<string, { rootPost: SwarmBoardPostDto | null; replies: SwarmBoardPostDto[]; latestAt: number }>();
  const order: string[] = [];

  for (const post of posts) {
    const key = post.threadId ?? post.postId;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { rootPost: null, replies: [], latestAt: post.createdAt };
      groups.set(key, bucket);
      order.push(key);
    }
    if (!post.threadId || post.threadId === post.postId) {
      bucket.rootPost = post;
    } else {
      bucket.replies.push(post);
    }
    bucket.latestAt = Math.max(bucket.latestAt, post.createdAt);
  }

  return order.map((threadId) => {
    const bucket = groups.get(threadId)!;
    return {
      threadId,
      rootPost: bucket.rootPost,
      replies: bucket.replies,
      latestAt: bucket.latestAt,
    };
  });
}

export function parseSwarmLogEntries(
  page: NativeWorkflowResourcePageResponse,
  existing: readonly SwarmLogEntryDto[] = [],
): SwarmLogEntryDto[] {
  const byId = new Map<string, SwarmLogEntryDto>(existing.map((e) => [e.entryId, e]));
  const ordered: SwarmLogEntryDto[] = [...existing];

  for (const raw of page.items) {
    if (!raw || raw.kind !== 'log_entry') continue;
    const entryId = typeof raw.entryId === 'string' ? raw.entryId.trim() : '';
    const summary = typeof raw.summary === 'string' ? raw.summary : '';
    const seq = typeof raw.seq === 'number' ? raw.seq : 0;
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    const level = raw.level === 'warn' || raw.level === 'error' ? raw.level : 'info';
    const evidence = raw.evidence as EvidenceDto | undefined;
    if (!entryId || !evidence || typeof evidence.sourceKind !== 'string') continue;

    const dto: SwarmLogEntryDto = {
      entryId,
      seq,
      level,
      summary,
      truncated: raw.truncated === true,
      createdAt,
      evidence,
    };
    if (!byId.has(entryId)) {
      byId.set(entryId, dto);
      ordered.push(dto);
    }
  }

  return ordered;
}

export function filterEntriesBySource<T extends { readonly evidence?: EvidenceDto | null }>(
  entries: readonly T[],
  sourceFilter: 'all' | EvidenceSourceKind,
): T[] {
  if (sourceFilter === 'all') return [...entries];
  return entries.filter((entry) => entry.evidence?.sourceKind === sourceFilter);
}

/**
 * Pure projection builder for NP-08 Swarm Studio.
 *
 * Guarantees:
 * - Never fabricates workers from tool titles or HM sub-sessions; ONLY projects agents
 *   explicitly referenced in `workflow.detail.workerIds` / `coordinatorId`.
 * - Separates confirmed workers/verifiers from unconfirmed candidates.
 * - Counts `idle` workers explicitly and NEVER counts idle or unknown workers as succeeded progress.
 * - Links pending approvals ONLY when `receipt.targetLineage === 'confirmed'` and agent matches a confirmed Swarm member.
 */
export function buildSwarmStudioViewModel(
  projection: NativeRuntimeProjection | null,
  capabilities: readonly CapabilityDescriptor[],
  pendingApprovals: readonly ApprovalRequest[],
  selectedWorkflowId?: WorkflowId | null,
): SwarmStudioViewModel {
  const swarmCapability = findSwarmCapability(capabilities, ['AGY-W04', 'agy.workflow.swarm']);
  const boardCapability = findSwarmCapability(capabilities, ['AGY-W05']);

  if (!projection) {
    return {
      workflows: [],
      selectedWorkflow: null,
      coordinator: null,
      workers: [],
      verifiers: [],
      unconfirmedMembers: [],
      counts: {
        totalConfirmedMembers: 0,
        runningCount: 0,
        requiresActionCount: 0,
        idleCount: 0,
        failedCount: 0,
        finishedCount: 0,
        unknownOrStaleCount: 0,
        unconfirmedCandidateCount: 0,
        hasFakeProgressBar: false,
      },
      boardStatus: resolveSwarmBoardStatus(null, boardCapability),
      linkedApprovals: [],
      unconfirmedApprovalCount: 0,
      activities: [],
      swarmCapability,
      boardCapability,
      workflowProvenance: null,
    };
  }

  const workflows = projection.workflows.filter(
    (wf): wf is SwarmWorkflowEntity => wf.detail.kind === 'swarm',
  );
  const selectedWorkflow =
    workflows.find((w) => w.id === selectedWorkflowId) ?? workflows[0] ?? null;

  const agentsById = new Map<NativeAgentId, AgentIdentity>(
    projection.agents.map((a) => [a.id, a]),
  );

  const coordinatorAgent = selectedWorkflow?.detail.coordinatorId
    ? agentsById.get(selectedWorkflow.detail.coordinatorId) ?? null
    : null;
  const coordinator = coordinatorAgent
    ? buildWorkerRow(coordinatorAgent, true, projection, pendingApprovals)
    : null;

  const workers: SwarmWorkerViewRow[] = [];
  const verifiers: SwarmWorkerViewRow[] = [];
  const unconfirmedMembers: SwarmWorkerViewRow[] = [];

  for (const workerId of selectedWorkflow?.detail.workerIds ?? []) {
    if (workerId === selectedWorkflow?.detail.coordinatorId) continue;
    const agent = agentsById.get(workerId);
    if (!agent) continue;
    const row = buildWorkerRow(agent, false, projection, pendingApprovals);
    if (!row.isConfirmed) {
      unconfirmedMembers.push(row);
    } else if (row.memberRole === 'verifier') {
      verifiers.push(row);
    } else {
      workers.push(row);
    }
  }

  const confirmedWorkersAndVerifiers = [...workers, ...verifiers];
  const allConfirmedMembers = coordinator?.isConfirmed
    ? [coordinator, ...confirmedWorkersAndVerifiers]
    : confirmedWorkersAndVerifiers;

  const confirmedMemberIds = new Set<NativeAgentId>(allConfirmedMembers.map((m) => m.agent.id));
  const linkedApprovals = pendingApprovals.filter((appr) => {
    const receipt = projection.receipts?.[appr.id];
    return Boolean(
      receipt?.agentId &&
        receipt.targetLineage === 'confirmed' &&
        confirmedMemberIds.has(receipt.agentId),
    );
  });
  const unconfirmedApprovalCount = pendingApprovals.filter((appr) => {
    const receipt = projection.receipts?.[appr.id];
    return receipt?.targetLineage === 'unconfirmed';
  }).length;

  const counts: SwarmWorkerSummaryCounts = {
    totalConfirmedMembers: confirmedWorkersAndVerifiers.length,
    runningCount: confirmedWorkersAndVerifiers.filter((w) => w.isActiveRunning).length,
    requiresActionCount: confirmedWorkersAndVerifiers.filter(
      (w) =>
        (w.agent.foreground.kind === 'known' && w.agent.foreground.value === 'requires_action') ||
        w.pendingApprovals.length > 0,
    ).length,
    idleCount: confirmedWorkersAndVerifiers.filter((w) => w.isIdle).length,
    failedCount: confirmedWorkersAndVerifiers.filter((w) => w.isFailed).length,
    finishedCount: confirmedWorkersAndVerifiers.filter((w) => w.isFinished).length,
    unknownOrStaleCount: confirmedWorkersAndVerifiers.filter((w) => w.isUnknownOrStale).length,
    unconfirmedCandidateCount: unconfirmedMembers.length,
    hasFakeProgressBar: false,
  };

  const activities = selectedWorkflow
    ? projection.activities.filter(
        (act) =>
          act.id === selectedWorkflow.originActivityId ||
          (act.agentId !== undefined && confirmedMemberIds.has(act.agentId)),
      )
    : [];

  const workflowProvenance =
    selectedWorkflow?.state.kind === 'known'
      ? selectedWorkflow.state.evidence
      : selectedWorkflow?.state.kind === 'stale'
        ? selectedWorkflow.state.evidence ?? null
        : null;

  return {
    workflows,
    selectedWorkflow,
    coordinator,
    workers,
    verifiers,
    unconfirmedMembers,
    counts,
    boardStatus: resolveSwarmBoardStatus(selectedWorkflow, boardCapability),
    linkedApprovals,
    unconfirmedApprovalCount,
    activities,
    swarmCapability,
    boardCapability,
    workflowProvenance,
  };
}
