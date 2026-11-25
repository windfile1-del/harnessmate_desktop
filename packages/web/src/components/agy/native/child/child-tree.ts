import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  AgentIdentity,
  CapabilityDescriptor,
  EvidenceDto,
  NativeAgentId,
  NativeRelationship,
  NativeRequestReceiptDto,
  NativeRuntimeProjection,
  NativeWork,
  WorkId,
} from '../../../../lib/native-client';

export interface ChildTreeNode {
  readonly agent: AgentIdentity;
  readonly depth: number;
  readonly parentAgentId: NativeAgentId | null;
  readonly relation: NativeRelationship | null;
  readonly isPrimaryRoot: boolean;
  readonly displayName: string;
  readonly pendingApprovalCount: number;
  readonly linkedLaunchWork: readonly NativeWork[];
  readonly provenance: EvidenceDto | null;
  readonly isReadOnlySnapshotOnly: boolean;
  readonly children: readonly ChildTreeNode[];
}

export interface SubagentLaunchBatchRow {
  readonly work: NativeWork;
  readonly linkedAgent: AgentIdentity | null;
  readonly isIdentityConfirmed: boolean;
}

export interface SubagentTreeProjection {
  readonly rootNodes: readonly ChildTreeNode[];
  readonly flattenedTree: readonly ChildTreeNode[];
  readonly unresolvedOrConflicting: readonly ChildTreeNode[];
  readonly launchBatches: readonly SubagentLaunchBatchRow[];
  readonly totalPendingChildApprovals: number;
}

export function resolveAgentDisplayName(agent: AgentIdentity): string {
  if (agent.label?.kind === 'known') return agent.label.value;
  if (agent.role?.kind === 'known') return agent.role.value;
  if (agent.label?.kind === 'stale' && agent.label.last) return agent.label.last;
  if (agent.role?.kind === 'stale' && agent.role.last) return agent.role.last;
  return agent.id;
}

export function extractAgentProvenance(
  agent: AgentIdentity,
  relation?: NativeRelationship | null,
): EvidenceDto | null {
  if (relation?.evidence) return relation.evidence;
  if (agent.foreground.kind === 'known') return agent.foreground.evidence;
  if (agent.foreground.kind === 'stale' && agent.foreground.evidence) {
    return agent.foreground.evidence;
  }
  if (agent.status?.kind === 'known') return agent.status.evidence;
  if (agent.status?.kind === 'stale' && agent.status.evidence) return agent.status.evidence;
  if (agent.role?.kind === 'known') return agent.role.evidence;
  return null;
}

export function isAgentSnapshotReadOnly(
  agent: AgentIdentity,
  relation?: NativeRelationship | null,
): boolean {
  if (relation?.confidence === 'snapshot_confirmed') return true;
  const ev = extractAgentProvenance(agent, relation);
  return ev?.sourceKind === 'native_snapshot' || ev?.sourceKind === 'replay';
}

/**
 * Resolves the safe control capability for a selected child agent.
 *
 * Strict NP-05 safety gate:
 * - Unknown, unresolved, or conflicting child agents NEVER receive executable controls.
 * - Snapshot-only / replay-only / disconnected / stale children NEVER receive executable controls.
 * - Primary root is handled by session-level Stop, not child cancel.
 * - Only a `confirmed` live child on an `attached` runtime with an explicitly `available`
 *   control descriptor action is eligible.
 */
export function resolveSafeChildControlCapability(params: {
  readonly agent: AgentIdentity;
  readonly relation: NativeRelationship | null;
  readonly isPrimaryRoot: boolean;
  readonly runtimeStatus: NativeRuntimeProjection['status'];
  readonly capabilities: readonly CapabilityDescriptor[];
}): { readonly capability: CapabilityDescriptor | null; readonly blockReason?: string } {
  if (params.isPrimaryRoot) {
    return { capability: null, blockReason: '主 Agent 请在主聊天或 Runtime Center 使用会话停止。' };
  }
  if (params.agent.lineage === 'conflicting') {
    return { capability: null, blockReason: '检测到亲缘冲突，已禁用所有控制动作。' };
  }
  if (params.agent.lineage !== 'confirmed') {
    return { capability: null, blockReason: '子 Agent 身份尚未确证，已禁用危险控件。' };
  }
  if (params.runtimeStatus !== 'attached') {
    return { capability: null, blockReason: '当前运行时未处于实时连接状态，仅允许只读查看。' };
  }
  if (isAgentSnapshotReadOnly(params.agent, params.relation)) {
    return { capability: null, blockReason: '该子 Agent 来自只读快照或回放源，不支持实时取消。' };
  }
  if (params.agent.foreground.kind !== 'known') {
    return { capability: null, blockReason: '子 Agent 状态已过期或未知，暂不开放控制。' };
  }

  const descriptor =
    params.capabilities.find((c) => c.id === 'agy.subagents') ??
    params.capabilities.find((c) => c.id === 'AGY-W02') ??
    params.capabilities.find((c) => c.id === 'AGY-W01') ??
    null;

  if (!descriptor || descriptor.control !== 'available') {
    return {
      capability: null,
      blockReason: '当前协议未声明该子 Agent 的原生取消能力（child.capabilities）。',
    };
  }

  const hasAvailableAction = descriptor.actions.some((a) => a.gate === 'available');
  if (!hasAvailableAction) {
    return {
      capability: null,
      blockReason: '当前能力目录未开放可执行的子 Agent 控制动作。',
    };
  }

  return { capability: descriptor };
}

/**
 * Builds an acyclic parent-child tree, launch batch list, and unresolved/conflicting bucket
 * purely from authoritative opaque IDs (`AgentIdentity`, `NativeRelationship`, `NativeWork`).
 * Never maps `toolCallId` to a child record ID in the frontend.
 */
export function buildSubagentTreeProjection(
  projection: NativeRuntimeProjection,
  pendingApprovals: readonly ApprovalRequest[],
): SubagentTreeProjection {
  const agentById = new Map<NativeAgentId, AgentIdentity>(
    projection.agents.map((a) => [a.id, a]),
  );
  const workById = new Map<WorkId, NativeWork>(projection.work.map((w) => [w.id, w]));
  const relationByChild = new Map<NativeAgentId, NativeRelationship>(
    projection.relations.map((r) => [r.childAgentId, r]),
  );

  // Count pending approvals attributed via server-resolved receipts (never guessing toolId!)
  const pendingCountByAgent = new Map<NativeAgentId, number>();
  let totalPendingChildApprovals = 0;
  for (const appr of pendingApprovals) {
    const receipt: NativeRequestReceiptDto | undefined = projection.receipts?.[appr.id];
    if (receipt?.agentId) {
      pendingCountByAgent.set(receipt.agentId, (pendingCountByAgent.get(receipt.agentId) ?? 0) + 1);
      totalPendingChildApprovals += 1;
    }
  }

  const childrenByParent = new Map<NativeAgentId, NativeAgentId[]>();
  for (const rel of projection.relations) {
    if (!agentById.has(rel.parentAgentId) || !agentById.has(rel.childAgentId)) continue;
    if (rel.parentAgentId === rel.childAgentId) continue;
    const list = childrenByParent.get(rel.parentAgentId) ?? [];
    list.push(rel.childAgentId);
    childrenByParent.set(rel.parentAgentId, list);
  }

  const isPrimaryAgent = (agent: AgentIdentity): boolean => {
    if (relationByChild.has(agent.id)) return false;
    const roleVal = agent.role?.kind === 'known' ? agent.role.value : undefined;
    return roleVal === 'primary' || agent.lineage === 'confirmed';
  };

  const visited = new Set<NativeAgentId>();

  const buildNode = (agentId: NativeAgentId, depth: number, ancestorSet: Set<NativeAgentId>): ChildTreeNode | null => {
    const agent = agentById.get(agentId);
    if (!agent || ancestorSet.has(agentId)) return null;
    visited.add(agentId);

    const nextAncestors = new Set(ancestorSet);
    nextAncestors.add(agentId);

    const rel = relationByChild.get(agentId) ?? null;
    const childIds = childrenByParent.get(agentId) ?? [];
    const childNodes: ChildTreeNode[] = [];
    for (const cid of childIds) {
      if (depth >= 16 || nextAncestors.has(cid)) continue;
      const childNode = buildNode(cid, depth + 1, nextAncestors);
      if (childNode) childNodes.push(childNode);
    }

    const linkedLaunchWork = agent.launchWorkIds
      .map((wid) => workById.get(wid))
      .filter((w): w is NativeWork => Boolean(w));

    return {
      agent,
      depth,
      parentAgentId: rel?.parentAgentId ?? null,
      relation: rel,
      isPrimaryRoot: depth === 0 && !rel && isPrimaryAgent(agent),
      displayName: resolveAgentDisplayName(agent),
      pendingApprovalCount: pendingCountByAgent.get(agentId) ?? 0,
      linkedLaunchWork,
      provenance: extractAgentProvenance(agent, rel),
      isReadOnlySnapshotOnly: isAgentSnapshotReadOnly(agent, rel),
      children: childNodes,
    };
  };

  const rootNodes: ChildTreeNode[] = [];
  const unresolvedOrConflicting: ChildTreeNode[] = [];

  for (const agent of projection.agents) {
    if (agent.lineage !== 'confirmed') {
      const linkedLaunchWork = agent.launchWorkIds
        .map((wid) => workById.get(wid))
        .filter((w): w is NativeWork => Boolean(w));
      unresolvedOrConflicting.push({
        agent,
        depth: 0,
        parentAgentId: relationByChild.get(agent.id)?.parentAgentId ?? null,
        relation: relationByChild.get(agent.id) ?? null,
        isPrimaryRoot: false,
        displayName: resolveAgentDisplayName(agent),
        pendingApprovalCount: pendingCountByAgent.get(agent.id) ?? 0,
        linkedLaunchWork,
        provenance: extractAgentProvenance(agent, relationByChild.get(agent.id) ?? null),
        isReadOnlySnapshotOnly: true,
        children: [],
      });
      visited.add(agent.id);
      continue;
    }

    const rel = relationByChild.get(agent.id);
    if (!rel || !agentById.has(rel.parentAgentId)) {
      const node = buildNode(agent.id, 0, new Set());
      if (node) rootNodes.push(node);
    }
  }

  // Catch any confirmed nodes trapped in a broken/detached cycle safely without infinite loop
  for (const agent of projection.agents) {
    if (!visited.has(agent.id)) {
      const node = buildNode(agent.id, 0, new Set());
      if (node) rootNodes.push(node);
    }
  }

  const flattenedTree: ChildTreeNode[] = [];
  const flatten = (nodes: readonly ChildTreeNode[]) => {
    for (const n of nodes) {
      flattenedTree.push(n);
      flatten(n.children);
    }
  };
  flatten(rootNodes);

  // Build launch batch list from authoritative `work.kind === 'subagent'` items
  const agentByLaunchWorkId = new Map<WorkId, AgentIdentity>();
  for (const agent of projection.agents) {
    for (const wid of agent.launchWorkIds) {
      const existing = agentByLaunchWorkId.get(wid);
      if (!existing || (existing.lineage !== 'confirmed' && agent.lineage === 'confirmed')) {
        agentByLaunchWorkId.set(wid, agent);
      }
    }
  }
  for (const rel of projection.relations) {
    if (rel.launchWorkId) {
      const child = agentById.get(rel.childAgentId);
      if (child) agentByLaunchWorkId.set(rel.launchWorkId, child);
    }
  }

  const launchBatches: SubagentLaunchBatchRow[] = projection.work
    .filter((w) => w.kind === 'subagent')
    .map((work) => {
      const linkedAgent = agentByLaunchWorkId.get(work.id) ?? null;
      return {
        work,
        linkedAgent,
        isIdentityConfirmed: linkedAgent?.lineage === 'confirmed',
      };
    });

  return {
    rootNodes,
    flattenedTree,
    unresolvedOrConflicting,
    launchBatches,
    totalPendingChildApprovals,
  };
}

/**
 * Computes the ancestor breadcrumb chain for a selected agent, guarded against cycles.
 */
export function buildAgentBreadcrumbs(
  projection: NativeRuntimeProjection,
  agentId: NativeAgentId,
): readonly AgentIdentity[] {
  const agentById = new Map<NativeAgentId, AgentIdentity>(
    projection.agents.map((a) => [a.id, a]),
  );
  const parentByChild = new Map<NativeAgentId, NativeAgentId>(
    projection.relations.map((r) => [r.childAgentId, r.parentAgentId]),
  );

  const chain: AgentIdentity[] = [];
  const visited = new Set<NativeAgentId>();
  let cursor: NativeAgentId | undefined = agentId;

  while (cursor && !visited.has(cursor) && chain.length < 18) {
    visited.add(cursor);
    const agent = agentById.get(cursor);
    if (!agent) break;
    chain.unshift(agent);
    cursor = parentByChild.get(cursor);
  }

  return chain;
}
