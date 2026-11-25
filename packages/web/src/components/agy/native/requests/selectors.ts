import type {
  ApprovalRequest,
  ResolveNativeRequestInput,
  RiskLevel,
} from '@harnessmate/protocol';
import type {
  Activity,
  AgentIdentity,
  AgentLineage,
  BindingGeneration,
  NativeAgentId,
  NativeRequestReceiptDto,
  NativeRuntimeProjection,
  NativeWorkflow,
  WorkflowId,
} from '../../../../lib/native-client';
import type {
  NativeElicitationFormSpecView,
  NativeRequestDisplayMeta,
  NativeRequestOptionView,
  NativeRequestScopeView,
  NativeRequestViewItem,
} from './types';

export interface SelectNativeRequestsOptions {
  readonly projection: NativeRuntimeProjection | null;
  readonly approvals?: readonly ApprovalRequest[];
  readonly metadataByApprovalId?: Readonly<Record<string, NativeRequestDisplayMeta>>;
  readonly filterAgentId?: NativeAgentId | null;
  readonly filterWorkflowId?: WorkflowId | null;
  readonly filterActivityId?: string | null;
}

function deriveOptions(
  receipt: NativeRequestReceiptDto,
  approval: ApprovalRequest | null,
  meta: NativeRequestDisplayMeta | null,
): NativeRequestOptionView[] {
  if (meta?.options && meta.options.length > 0) {
    return meta.options.map((o) => ({ ...o }));
  }

  if (receipt.kind === 'question' || approval?.kind === 'user_question') {
    const specOpts = approval?.questionSpec?.options ?? [];
    if (specOpts.length > 0) {
      return specOpts.map((o) => ({
        optionId: o.id,
        name: o.label,
        kind: 'custom',
        ...(o.description ? { description: o.description } : {}),
        scopeWidening: false,
      }));
    }
  }

  if (receipt.allowedOptionIds.length > 0) {
    return receipt.allowedOptionIds.map((id) => ({
      optionId: id,
      name: formatDefaultOptionLabel(id),
      kind: inferOptionKind(id),
      scopeWidening: id === 'allow_always' || id === 'allow_session',
    }));
  }

  return [];
}

function inferOptionKind(optionId: string): NativeRequestOptionView['kind'] {
  const lower = optionId.toLowerCase();
  if (lower === 'allow_always' || lower === 'allow_session' || lower === 'allow-session') {
    return 'allow_always';
  }
  if (lower === 'allow_once' || lower === 'allow-once') return 'allow_once';
  if (lower === 'reject_always' || lower === 'reject-always') return 'reject_always';
  if (lower === 'reject_once' || lower === 'reject-once' || lower === 'deny' || lower === 'reject') {
    return 'reject_once';
  }
  if (lower === 'decline') return 'decline';
  return 'custom';
}

function formatDefaultOptionLabel(optionId: string): string {
  switch (optionId) {
    case 'allow_once':
    case 'allow-once':
      return '允许本次';
    case 'allow_always':
    case 'allow_session':
    case 'allow-session':
      return '本会话/始终允许';
    case 'reject_once':
    case 'reject-once':
    case 'deny':
      return '拒绝';
    case 'reject_always':
    case 'reject-always':
      return '始终拒绝';
    case 'decline':
      return '拒绝填表';
    default:
      return optionId;
  }
}

function resolveScope(
  receipt: NativeRequestReceiptDto,
  ownerAgent: AgentIdentity | null,
  workflow: NativeWorkflow | null,
  meta: NativeRequestDisplayMeta | null,
): { scope: NativeRequestScopeView; targetLineage: AgentLineage } {
  const targetLineage: AgentLineage =
    meta?.targetLineage ??
    ownerAgent?.lineage ??
    (receipt.targetLineage === 'confirmed' ? 'confirmed' : 'unresolved');

  if (meta?.scope) {
    return { scope: meta.scope, targetLineage };
  }
  if (targetLineage === 'conflicting') {
    return { scope: 'unknown_child', targetLineage: 'conflicting' };
  }
  if (receipt.agentId) {
    if (targetLineage === 'confirmed') {
      return { scope: 'confirmed_child', targetLineage: 'confirmed' };
    }
    return { scope: 'unknown_child', targetLineage: 'unresolved' };
  }
  if (workflow) {
    return { scope: 'confirmed_workflow', targetLineage: 'confirmed' };
  }
  if (targetLineage === 'unresolved') {
    return { scope: 'unknown_child', targetLineage: 'unresolved' };
  }
  return { scope: 'root', targetLineage: 'confirmed' };
}

/**
 * Projects unified NP-07 native request view items from `NativeRuntimeProjection`,
 * legacy `ApprovalRequest[]`, and optional rich NP-07 display metadata.
 *
 * Designed as the pure selector glue for `ApprovalCenter`, `GlobalAttentionStrip`,
 * and AGY Workbench views without mutating legacy Approval Center state.
 */
export function selectNativeRequestsForSession(
  opts: SelectNativeRequestsOptions,
): NativeRequestViewItem[] {
  const { projection, approvals = [], metadataByApprovalId = {} } = opts;
  if (!projection) return [];

  const approvalById = new Map(approvals.map((a) => [a.id, a]));
  const agentById = new Map<string, AgentIdentity>(projection.agents.map((a) => [a.id, a]));
  const activityById = new Map<string, Activity>(projection.activities.map((a) => [a.id, a]));
  const workflowById = new Map<string, NativeWorkflow>(projection.workflows.map((w) => [w.id, w]));

  const receiptEntries: NativeRequestReceiptDto[] = [];
  const seen = new Set<string>();
  if (projection.receipts) {
    for (const receipt of Object.values(projection.receipts)) {
      seen.add(receipt.approvalId);
      receiptEntries.push(receipt);
    }
  }
  // Ensure any active requestId present in projection.requestIds without a receipt entry is still surfaced honestly
  for (const reqId of projection.requestIds) {
    if (seen.has(reqId)) continue;
    seen.add(reqId);
    const matchedApproval = approvalById.get(reqId);
    receiptEntries.push({
      approvalId: reqId,
      runtimeId: projection.binding.runtimeId,
      generation: projection.binding.generation,
      kind: matchedApproval?.kind === 'user_question' ? 'question' : 'permission',
      targetLineage: 'unconfirmed',
      allowedOptionIds: [],
      receiptState: 'pending',
      updatedAt: matchedApproval?.createdAt ?? 0,
    });
  }

  const items: NativeRequestViewItem[] = [];
  const currentGen = projection.binding.generation;
  const isRuntimeAttached = projection.status === 'attached';

  for (const receipt of receiptEntries) {
    const meta = metadataByApprovalId[receipt.approvalId] ?? null;
    const approval = approvalById.get(receipt.approvalId) ?? null;
    const ownerAgent = receipt.agentId ? agentById.get(receipt.agentId) ?? null : null;
    const activity = receipt.activityId ? activityById.get(receipt.activityId) ?? null : null;
    const matchedWorkflow =
      (meta?.workflowId ? workflowById.get(meta.workflowId) ?? null : null) ??
      (activity ? projection.workflows.find((w) => w.originActivityId === activity.id) ?? null : null);

    if (opts.filterAgentId && receipt.agentId !== opts.filterAgentId) continue;
    if (opts.filterActivityId && receipt.activityId !== opts.filterActivityId) continue;
    if (
      opts.filterWorkflowId &&
      meta?.workflowId !== opts.filterWorkflowId &&
      matchedWorkflow?.id !== opts.filterWorkflowId
    ) {
      continue;
    }

    const { scope, targetLineage } = resolveScope(receipt, ownerAgent, matchedWorkflow, meta);
    const isGenerationCurrent =
      receipt.runtimeId === projection.binding.runtimeId && receipt.generation === currentGen;
    const isPending = receipt.receiptState === 'pending';
    const isActionable = isPending && isGenerationCurrent && isRuntimeAttached;

    const options = deriveOptions(receipt, approval, meta);
    const allowedOptionIds =
      receipt.allowedOptionIds.length > 0
        ? receipt.allowedOptionIds
        : options.map((o) => o.optionId);

    const securityWarnings = [
      ...(meta?.securityWarnings ?? []),
      ...options
        .map((o) => o.securityWarning)
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0),
    ].filter((val, idx, arr) => arr.indexOf(val) === idx);

    const annotations = meta?.annotations ?? approval?.annotations ?? [];
    const riskLevel: RiskLevel =
      meta?.riskLevel ??
      approval?.riskLevel ??
      (securityWarnings.length > 0 ? 'high' : 'low');

    const isDetached =
      meta?.isDetached ?? (activity ? activity.turnId === null : false);
    const forwardedToParentSession = meta?.forwardedToParentSession ?? false;

    let canAnswer: boolean;
    let unsupportedReason = meta?.unsupportedReason;

    if (scope === 'unknown_child' || targetLineage === 'conflicting') {
      canAnswer = false;
      unsupportedReason =
        unsupportedReason ??
        (targetLineage === 'conflicting'
          ? 'conflicting_child_lineage_cancel_only'
          : 'unknown_child_target_cancel_only');
    } else if (receipt.kind === 'elicitation') {
      canAnswer = Boolean(meta?.formSpec?.supported) && (meta?.canAnswer ?? true);
      if (!canAnswer && !unsupportedReason) {
        unsupportedReason = meta?.formSpec?.unsupportedReason ?? 'elicitation_schema_unavailable';
      }
    } else if (receipt.kind === 'question') {
      canAnswer = allowedOptionIds.length > 0 && (meta?.canAnswer ?? true);
      if (!canAnswer && !unsupportedReason) {
        unsupportedReason = 'no_verified_free_text_wire_encoding';
      }
    } else {
      canAnswer = allowedOptionIds.length > 0 && (meta?.canAnswer ?? true);
    }

    const canCancel = isActionable && (meta?.canCancel ?? true);

    items.push({
      approvalId: receipt.approvalId,
      receipt,
      approval,
      ownerAgent,
      activity,
      workflow: matchedWorkflow,
      meta,
      scope,
      targetLineage,
      isGenerationCurrent,
      isRuntimeAttached,
      isPending,
      isActionable,
      canAnswer: isActionable && canAnswer,
      canCancel,
      isDetached,
      forwardedToParentSession,
      options,
      allowedOptionIds,
      securityWarnings,
      annotations,
      riskLevel,
      ...(unsupportedReason ? { unsupportedReason } : {}),
    });
  }

  // Sort: pending & actionable first, then most recently updated
  return items.sort((a, b) => {
    if (a.isPending !== b.isPending) return a.isPending ? -1 : 1;
    return b.receipt.updatedAt - a.receipt.updatedAt;
  });
}

export function selectPendingNativeRequests(
  opts: SelectNativeRequestsOptions,
): NativeRequestViewItem[] {
  return selectNativeRequestsForSession(opts).filter((item) => item.isPending);
}

export function selectHistoricalNativeRequestReceipts(
  opts: SelectNativeRequestsOptions,
): NativeRequestViewItem[] {
  return selectNativeRequestsForSession(opts).filter((item) => !item.isPending);
}

/**
 * Pure client-side validation for elicitation form submission mirroring backend `wire-codec.ts`.
 * Returns a map of fieldName -> errorMessage (empty when valid).
 */
export function validateElicitationDraft(
  formSpec: NativeElicitationFormSpecView,
  values: Readonly<Record<string, string | number | boolean | string[] | undefined>>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!formSpec.supported) {
    errors._form = '当前表单包含未验证或不支持的协议字段，无法提交，仅支持取消或拒绝。';
    return errors;
  }

  for (const field of formSpec.fields) {
    const val = values[field.name];
    if (val === undefined || val === '') {
      if (field.required) {
        errors[field.name] = `请填写必填项「${field.title ?? field.name}」`;
      }
      continue;
    }

    if (field.type === 'string') {
      if (typeof val !== 'string') {
        errors[field.name] = '必须为文本';
        continue;
      }
      if (field.required && val.trim().length === 0) {
        errors[field.name] = `「${field.title ?? field.name}」不能为空`;
        continue;
      }
      if (field.minLength !== undefined && val.length < field.minLength) {
        errors[field.name] = `长度不能少于 ${field.minLength} 个字符`;
        continue;
      }
      if (field.maxLength !== undefined && val.length > field.maxLength) {
        errors[field.name] = `长度不能超过 ${field.maxLength} 个字符`;
        continue;
      }
      if (field.enum && !field.enum.includes(val)) {
        errors[field.name] = '请选择声明的合法选项';
        continue;
      }
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        errors[field.name] = '请输入有效的邮箱格式';
        continue;
      }
      if (field.format === 'uri') {
        try {
          const u = new URL(val);
          if (!u.protocol) errors[field.name] = '请输入有效的 URI';
        } catch {
          errors[field.name] = '请输入有效的 URI';
        }
        continue;
      }
      if (field.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(val) || Number.isNaN(Date.parse(val)))) {
        errors[field.name] = '请输入 YYYY-MM-DD 日期格式';
        continue;
      }
    } else if (field.type === 'number' || field.type === 'integer') {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        errors[field.name] = '请输入有效数字';
        continue;
      }
      if (field.type === 'integer' && !Number.isInteger(val)) {
        errors[field.name] = '请输入整数';
        continue;
      }
      if (field.minimum !== undefined && val < field.minimum) {
        errors[field.name] = `不能小于 ${field.minimum}`;
        continue;
      }
      if (field.maximum !== undefined && val > field.maximum) {
        errors[field.name] = `不能大于 ${field.maximum}`;
        continue;
      }
    } else if (field.type === 'string_array') {
      if (!Array.isArray(val)) {
        errors[field.name] = '必须为选项数组';
        continue;
      }
      if (field.required && val.length === 0) {
        errors[field.name] = `请至少选择一项「${field.title ?? field.name}」`;
        continue;
      }
      if (field.enum && val.some((v) => !field.enum!.includes(v))) {
        errors[field.name] = '包含未声明的选项';
      }
    }
  }

  return errors;
}

export function buildSelectedOptionPayload(
  generation: BindingGeneration,
  optionId: string,
  idempotencyKey?: string,
): ResolveNativeRequestInput {
  return {
    generation: generation as ResolveNativeRequestInput['generation'],
    outcome: 'selected',
    optionId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

export function buildCancelledPayload(
  generation: BindingGeneration,
  comment?: string,
  idempotencyKey?: string,
): ResolveNativeRequestInput {
  return {
    generation: generation as ResolveNativeRequestInput['generation'],
    outcome: 'cancelled',
    ...(comment ? { comment } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

export function buildFormSubmittedPayload(
  generation: BindingGeneration,
  formPayload: Record<string, string | number | boolean | string[]>,
  idempotencyKey?: string,
): ResolveNativeRequestInput {
  return {
    generation: generation as ResolveNativeRequestInput['generation'],
    outcome: 'form_submitted',
    formPayload,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
