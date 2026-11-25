import type {
  CapabilityDescriptor,
  NativeStage,
  NativeWork,
  NativeWorkflow,
  RuntimeBinding,
  WorkflowId,
} from '../../../../lib/native-client';
import type { NativeRequestViewItem } from '../requests/types';
import type {
  DynamicDagAnalysis,
  DynamicDagEdge,
  DynamicDagLayer,
  DynamicScriptApprovalDisplayState,
  DynamicSortableTimelineItem,
  DynamicWorkflowBannerModel,
  DynamicWorkflowResourceItemView,
} from './types';

export function selectDynamicWorkflows(
  workflows: readonly NativeWorkflow[],
): NativeWorkflow[] {
  return workflows.filter((wf) => wf.detail.kind === 'dynamic');
}

export function findDynamicWorkflowCapability(
  capabilities: readonly CapabilityDescriptor[],
): CapabilityDescriptor | undefined {
  return (
    capabilities.find((c) => c.id === 'AGY-W08') ??
    capabilities.find((c) => c.id === 'agy.workflow.dynamic')
  );
}

/**
 * Analyzes explicit `NativeStage.after` edges into topological DAG layers.
 * NEVER infers edges from Python script text or model prose.
 */
export function analyzeDynamicDag(steps: readonly NativeStage[] | undefined): DynamicDagAnalysis {
  if (!steps || steps.length === 0) {
    return {
      hasVerifiedDag: false,
      hasCycle: false,
      unavailableReason: 'no_steps_observed',
      layers: [],
      edges: [],
    };
  }

  const stepMap = new Map<string, NativeStage>();
  for (const step of steps) {
    stepMap.set(step.id, step);
  }

  const edges: DynamicDagEdge[] = [];
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const step of steps) {
    inDegree.set(step.id, 0);
    children.set(step.id, []);
  }

  for (const step of steps) {
    for (const dep of step.after ?? []) {
      if (!stepMap.has(dep) || dep === step.id) continue;
      edges.push({ from: dep, to: step.id });
      children.get(dep)!.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  if (edges.length === 0) {
    return {
      hasVerifiedDag: false,
      hasCycle: false,
      unavailableReason: 'no_dependency_edges_observed',
      layers: [],
      edges: [],
    };
  }

  const depthById = new Map<string, number>();
  const queue: string[] = [];
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) {
      queue.push(step.id);
      depthById.set(step.id, 0);
    }
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    const currentDepth = depthById.get(current) ?? 0;
    for (const nextId of children.get(current) ?? []) {
      const candidateDepth = currentDepth + 1;
      if ((depthById.get(nextId) ?? 0) < candidateDepth) {
        depthById.set(nextId, candidateDepth);
      }
      const nextDeg = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, nextDeg);
      if (nextDeg === 0) {
        queue.push(nextId);
      }
    }
  }

  if (visited !== steps.length) {
    return {
      hasVerifiedDag: false,
      hasCycle: true,
      unavailableReason: 'cyclic_dependency_edges_detected',
      layers: [],
      edges,
    };
  }

  const byDepth = new Map<number, NativeStage[]>();
  for (const step of steps) {
    const d = depthById.get(step.id) ?? 0;
    const list = byDepth.get(d) ?? [];
    list.push(step);
    byDepth.set(d, list);
  }

  const layers: DynamicDagLayer[] = [...byDepth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([depth, layerSteps]) => ({ depth, steps: layerSteps }));

  return {
    hasVerifiedDag: true,
    hasCycle: false,
    layers,
    edges,
  };
}

export function deriveScriptApprovalState(
  workflow: NativeWorkflow,
  requests: readonly NativeRequestViewItem[],
  explicitState?: DynamicScriptApprovalDisplayState,
): DynamicScriptApprovalDisplayState {
  if (explicitState) return explicitState;
  const scriptReqs = requests.filter(
    (r) =>
      r.meta?.toolName?.toLowerCase().includes('script') ||
      r.meta?.summary?.toLowerCase().includes('script') ||
      r.receipt.kind === 'permission',
  );
  const pending = scriptReqs.find((r) => r.isPending);
  if (pending) return 'pending';
  const latest = scriptReqs[0];
  if (latest) {
    switch (latest.receipt.receiptState) {
      case 'response_written':
        return 'approved';
      case 'cancelled':
        return 'cancelled';
      case 'expired':
        return 'expired';
      case 'pending':
        return 'pending';
      default:
        return 'unknown';
    }
  }
  if (workflow.state.kind === 'known' && workflow.state.value === 'cancelled') {
    return 'cancelled';
  }
  if (workflow.detail.kind === 'dynamic' && workflow.detail.steps && workflow.detail.steps.length > 0) {
    return 'approved';
  }
  return 'unknown';
}

export function deriveDynamicWorkflowBanner(params: {
  readonly workflow: NativeWorkflow;
  readonly runtimeStatus: 'attached' | 'reconciling' | 'disconnected';
  readonly workflowRequests: readonly NativeRequestViewItem[];
  readonly scriptApprovalState: DynamicScriptApprovalDisplayState;
}): DynamicWorkflowBannerModel {
  const { workflow, runtimeStatus, workflowRequests, scriptApprovalState } = params;
  const detail = workflow.detail.kind === 'dynamic' ? workflow.detail : null;
  const steps = detail?.steps ?? [];
  const hasFailedStep = steps.some((s) => s.state.kind === 'known' && s.state.value === 'failed');
  const hasSucceededStep = steps.some(
    (s) => s.state.kind === 'known' && s.state.value === 'finished',
  );
  const hasPartialResults =
    hasFailedStep && (hasSucceededStep || (detail?.resultArtifactIds?.length ?? 0) > 0);
  const pendingCount = workflowRequests.filter((r) => r.isPending).length;

  if (runtimeStatus !== 'attached' || workflow.state.kind === 'stale') {
    return {
      phase: 'stale',
      headline: runtimeStatus === 'reconciling' ? '重连校准中 · 保留最后观测' : '观测连接已断开 · 状态已过期',
      detail: '无法确认原生工作流是否仍在远端继续运行，禁止在客户端伪造完成或执行替代脚本。',
      tone: 'clay',
      isIncompleteWarning: true,
    };
  }

  if (scriptApprovalState === 'denied' || scriptApprovalState === 'cancelled' || scriptApprovalState === 'expired') {
    return {
      phase: 'script_denied',
      headline:
        scriptApprovalState === 'expired' ? '脚本批准请求已过期' : '动态工作流脚本未获批准',
      detail: '用户拒绝或取消了脚本执行权限，原生工作流已停止，未执行任何未授权脚本。',
      tone: 'clay',
      isIncompleteWarning: false,
    };
  }

  if (pendingCount > 0) {
    const isScriptPending = scriptApprovalState === 'pending';
    return {
      phase: isScriptPending ? 'script_pending_approval' : 'requires_action',
      headline: isScriptPending
        ? `等待脚本执行批准 (${pendingCount} 项待处理)`
        : `工作流暂停 · 等待用户确认 (${pendingCount} 项待处理)`,
      detail: '请审查原生权限或 AGY 1.5.16 转发的结构化问题，响应将经共享 Approval Router 写回原连接。',
      tone: 'star',
      isIncompleteWarning: false,
    };
  }

  if (workflow.state.kind === 'known') {
    if (workflow.state.value === 'cancelled') {
      return {
        phase: 'cancelled',
        headline: '动态工作流已取消',
        detail: '收到原生取消状态，保留已观察节点与部分只读结果。',
        tone: 'clay',
        isIncompleteWarning: false,
      };
    }
    if (workflow.state.value === 'failed') {
      return {
        phase: hasPartialResults ? 'partial_results' : 'failed',
        headline: hasPartialResults ? '部分节点失败 · 已保留部分结果' : '动态工作流执行失败',
        detail: hasPartialResults
          ? '部分步骤执行失败，但已完成步骤的结构化产物与日志仍可浏览。'
          : '收到明确的节点或脚本失败信号，请检查节点错误详情与执行日志。',
        tone: hasPartialResults ? 'clay' : 'rose',
        isIncompleteWarning: hasPartialResults,
      };
    }
    if (workflow.state.value === 'finished') {
      return {
        phase: hasPartialResults ? 'partial_results' : 'finished',
        headline: hasPartialResults ? '运行结束（含失败节点与部分结果）' : '动态工作流已运行结束',
        detail: hasPartialResults
          ? '工作流已收尾，部分节点失败，请核对已产出结果摘要。'
          : '工作流节点已到达原生结束态，可在下方浏览结构化结果与审计日志。',
        tone: hasPartialResults ? 'clay' : 'emerald',
        isIncompleteWarning: hasPartialResults,
      };
    }
    if (workflow.state.value === 'running' || workflow.state.value === 'waiting' || workflow.state.value === 'queued') {
      return {
        phase: hasPartialResults ? 'partial_results' : 'running',
        headline: hasPartialResults ? '运行中 · 部分节点失败' : '动态工作流正在执行',
        detail: '正在接收来自 AGY 的阶段、节点任务与结果更新（客户端仅观察，不解释或调度 Python）。',
        tone: hasPartialResults ? 'clay' : 'indigo',
        isIncompleteWarning: hasPartialResults,
      };
    }
  }

  return {
    phase: 'unknown',
    headline: '工作流状态待原生确认',
    detail: '当前仅观测到有限触发字段，空阶段或缺失边不代表成功或已停止。',
    tone: 'muted',
    isIncompleteWarning: false,
  };
}

export function buildSortableWorkflowTimeline(params: {
  readonly workflow: NativeWorkflow;
  readonly works: readonly NativeWork[];
  readonly requests: readonly NativeRequestViewItem[];
  readonly logItems?: readonly DynamicWorkflowResourceItemView[];
  readonly sortOrder: 'asc' | 'desc';
  readonly stepErrorByStepId?: Readonly<Record<string, string>>;
}): DynamicSortableTimelineItem[] {
  const { workflow, works, requests, logItems = [], sortOrder, stepErrorByStepId = {} } = params;
  const items: DynamicSortableTimelineItem[] = [];
  let seq = 0;

  if (workflow.detail.kind === 'dynamic') {
    for (const step of workflow.detail.steps ?? []) {
      seq += 1;
      const errDetail = stepErrorByStepId[step.id];
      const afterText =
        step.after && step.after.length > 0 ? `前置依赖: ${step.after.join(', ')}` : '无依赖边信息';
      items.push({
        itemId: `step:${step.id}`,
        sortSeq: seq,
        kind: 'step',
        stepId: step.id,
        agentIds: step.agentIds,
        title: step.label,
        detail: errDetail ? `错误: ${errDetail} · ${afterText}` : afterText,
        observedState: step.state,
        evidence: step.state.kind === 'known' ? step.state.evidence : undefined,
      });
    }
  }

  for (const w of works) {
    if (w.workflowId !== workflow.id) continue;
    seq += 1;
    items.push({
      itemId: `work:${w.id}`,
      sortSeq: seq,
      kind: 'work',
      workId: w.id,
      ...(w.ownerAgentId ? { agentIds: [w.ownerAgentId] } : {}),
      title: w.observedLabel ?? w.id,
      detail: `工作项 ${w.id}`,
      observedState: w.state,
      blocking: w.blocking,
      evidence: w.state.kind === 'known' ? w.state.evidence : undefined,
    });
  }

  for (const req of requests) {
    seq += 1;
    items.push({
      itemId: `req:${req.approvalId}`,
      sortSeq: seq,
      timestamp: req.receipt.updatedAt,
      kind: 'request',
      title: req.meta?.toolName ?? (req.receipt.kind === 'question' ? '结构化问题' : '脚本/节点权限'),
      detail: req.meta?.summary ?? req.approvalId,
      receiptState: req.receipt.receiptState,
      evidence: req.receipt.evidence,
    });
  }

  for (const log of logItems) {
    seq += 1;
    items.push({
      itemId: `log:${log.id}`,
      sortSeq: seq,
      timestamp: log.createdAt,
      kind: 'log',
      title: log.title,
      detail: log.summary,
      evidence: log.evidence,
    });
  }

  return items.sort((a, b) =>
    sortOrder === 'asc' ? a.sortSeq - b.sortSeq : b.sortSeq - a.sortSeq,
  );
}

export function formatSafeStructuredPreview(value: unknown, maxChars = 2000): {
  readonly text: string;
  readonly truncated: boolean;
} {
  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value, null, 2);
    } catch {
      raw = String(value);
    }
  }
  const truncated = raw.length > maxChars;
  return {
    text: truncated ? raw.slice(0, maxChars) : raw,
    truncated,
  };
}

export function normalizeWorkflowResourceItems(
  items: readonly Record<string, unknown>[],
  workflowId: WorkflowId,
  binding?: RuntimeBinding,
): DynamicWorkflowResourceItemView[] {
  const out: DynamicWorkflowResourceItemView[] = [];
  for (let idx = 0; idx < items.length; idx += 1) {
    const raw = items[idx];
    if (!raw) continue;
    const kind = raw.kind;
    if (kind === 'log_entry') {
      out.push({
        id: typeof raw.entryId === 'string' ? raw.entryId : `${workflowId}:log:${idx}`,
        kind: 'log_entry',
        title: `日志 #${typeof raw.seq === 'number' ? raw.seq : idx + 1}`,
        summary: typeof raw.summary === 'string' ? raw.summary : '',
        level:
          raw.level === 'error' || raw.level === 'warn' || raw.level === 'info'
            ? raw.level
            : 'info',
        seq: typeof raw.seq === 'number' ? raw.seq : idx + 1,
        truncated: raw.truncated === true,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
        evidence:
          raw.evidence && typeof raw.evidence === 'object'
            ? (raw.evidence as DynamicWorkflowResourceItemView['evidence'])
            : undefined,
      });
    } else if (kind === 'artifact_ref') {
      out.push({
        id: typeof raw.artifactId === 'string' ? raw.artifactId : `${workflowId}:art:${idx}`,
        kind: 'artifact_ref',
        title: typeof raw.title === 'string' ? raw.title : String(raw.artifactId ?? 'Artifact'),
        artifactKind: typeof raw.artifactKind === 'string' ? raw.artifactKind : 'unknown',
        createdAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
        ownerAgentId:
          typeof raw.ownerAgentId === 'string'
            ? (raw.ownerAgentId as DynamicWorkflowResourceItemView['ownerAgentId'])
            : undefined,
        activityId:
          typeof raw.activityId === 'string'
            ? (raw.activityId as DynamicWorkflowResourceItemView['activityId'])
            : undefined,
        evidence:
          raw.evidence && typeof raw.evidence === 'object'
            ? (raw.evidence as DynamicWorkflowResourceItemView['evidence'])
            : undefined,
      });
    } else if (kind === 'phase' && raw.stage && typeof raw.stage === 'object') {
      const stage = raw.stage as Record<string, unknown>;
      out.push({
        id: typeof stage.id === 'string' ? stage.id : `${workflowId}:phase:${idx}`,
        kind: 'phase',
        title: typeof stage.label === 'string' ? stage.label : String(stage.id ?? 'Phase'),
        summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      });
    }
  }
  void binding;
  return out;
}
