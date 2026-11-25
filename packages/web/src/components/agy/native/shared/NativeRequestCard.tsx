import type { ApprovalRequest, ResolveApprovalRequest } from '@harnessmate/protocol';
import { ArrowUpRight, Bot, Check, HelpCircle, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import type {
  AgentIdentity,
  NativeAgentId,
  NativeRequestReceiptDto,
} from '../../../../lib/native-client';
import { EntityStatusBadge } from './EntityStatusBadge';
import { EvidenceDetails } from './EvidenceDetails';

export interface NativeRequestCardProps {
  approval?: ApprovalRequest | null;
  receipt?: NativeRequestReceiptDto | null;
  ownerAgent?: AgentIdentity | null;
  onJumpToAgent?: (agentId: NativeAgentId) => void;
  onResolve?: (
    approvalId: string,
    req: ResolveApprovalRequest,
  ) => Promise<{ conflict?: boolean; resolvedBy?: string | null }>;
}

/**
 * Shared native permission / structured question card backed by HarnessMate's
 * Approval Center data plus native receipt/scope provenance.
 *
 * Rules enforced per 08_Shared_Contracts.md & 09_Frontend_Design.md:
 * - Confirmed child attribution displays the real owning agent + jump action.
 * - Unconfirmed scope is labeled explicitly ("来源未确认") without impersonating parent.
 * - Never auto-selects an option; never exposes free-text input when fixed native options apply.
 * - After submission or connection change, preserves read-only receipt state (`response_written`,
 *   `connection_lost`, `delivery_unknown`, `expired`) without replaying stale approvals.
 */
export function NativeRequestCard({
  approval,
  receipt,
  ownerAgent,
  onJumpToAgent,
  onResolve,
}: NativeRequestCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('');
  const [localReceiptNotice, setLocalReceiptNotice] = useState<string | null>(null);

  const approvalId = approval?.id ?? receipt?.approvalId ?? 'unknown';
  const receiptState = receipt?.receiptState ?? (approval?.status === 'pending' ? 'pending' : 'response_written');
  const isActionable =
    receiptState === 'pending' &&
    (!approval || approval.status === 'pending') &&
    Boolean(onResolve);

  const isConfirmedChild = Boolean(
    receipt?.agentId && receipt.targetLineage === 'confirmed' && ownerAgent?.lineage === 'confirmed',
  );
  const isUnconfirmedScope = receipt?.targetLineage === 'unconfirmed' || ownerAgent?.lineage === 'unresolved';

  const ownerLabel = ownerAgent
    ? ownerAgent.label?.kind === 'known'
      ? ownerAgent.label.value
      : ownerAgent.role?.kind === 'known'
        ? ownerAgent.role.value
        : ownerAgent.id
    : receipt?.agentId ?? '主会话';

  const questionOptions = approval?.questionSpec?.options ?? [];
  const allowedOptions = receipt?.allowedOptionIds ?? [];
  const filteredOptions =
    allowedOptions.length > 0 && questionOptions.length > 0
      ? questionOptions.filter((opt) => allowedOptions.includes(opt.id))
      : questionOptions;

  const handleDecision = async (decision: 'allow_once' | 'allow_session' | 'deny') => {
    if (!onResolve || !isActionable || submitting) return;
    setSubmitting(true);
    try {
      const outcome = await onResolve(approvalId, { decision, resolvedBy: 'desktop' });
      setLocalReceiptNotice(
        outcome.conflict
          ? '该请求已由其他客户端处理，已同步收起。'
          : '响应已提交，等待原生后续帧确认。',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitOption = async () => {
    if (!onResolve || !isActionable || !selectedOptionId || submitting) return;
    setSubmitting(true);
    try {
      await onResolve(approvalId, {
        questionAnswer: { selectedOptionIds: [selectedOptionId] },
        resolvedBy: 'desktop',
      });
      setLocalReceiptNotice('已提交原生选项，等待对端确认。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article
      data-testid="native-request-card"
      data-receipt-state={receiptState}
      data-target-lineage={receipt?.targetLineage ?? 'confirmed'}
      className="space-y-2.5 rounded-2xl p-3 text-[12px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: `1px solid ${
          isActionable
            ? 'color-mix(in srgb, var(--accent-star) 55%, transparent)'
            : 'var(--border-hairline)'
        }`,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {receipt?.kind === 'question' || approval?.kind === 'user_question' ? (
            <HelpCircle size={15} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
          ) : (
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--accent-star)]" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-[var(--text-primary)]">
                {approval?.toolName ?? (receipt?.kind === 'question' ? '原生结构化问题' : '原生权限请求')}
              </span>
              <EntityStatusBadge kind="receipt" state={receiptState} compact />
              {isConfirmedChild && receipt?.agentId && (
                <span className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-indigo-soft)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--accent-indigo)]">
                  <Bot size={10.5} aria-hidden="true" />
                  <span>子 Agent: {ownerLabel}</span>
                </span>
              )}
              {isUnconfirmedScope && (
                <span className="rounded-md bg-[var(--accent-clay-soft)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--accent-clay)]">
                  来源未确认（保留原生作用域）
                </span>
              )}
            </div>
            <p className="mt-1 break-all font-mono-code text-[11.5px] text-[var(--text-secondary)]">
              {approval?.summary ?? `请求 ${approvalId} · 当前仅保留原生收据状态`}
            </p>
          </div>
        </div>

        {isConfirmedChild && receipt?.agentId && onJumpToAgent && (
          <button
            type="button"
            onClick={() => onJumpToAgent(receipt.agentId!)}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
          >
            <span>查看子 Agent</span>
            <ArrowUpRight size={11} aria-hidden="true" />
          </button>
        )}
      </div>

      {isActionable && (receipt?.kind === 'question' || approval?.kind === 'user_question') ? (
        <div className="space-y-2">
          {filteredOptions.length > 0 ? (
            <div className="space-y-1" role="radiogroup" aria-label="原生可选回答">
              {filteredOptions.map((opt) => (
                <label
                  key={opt.id}
                  className="flex cursor-pointer items-start gap-2 rounded-xl border px-2.5 py-1.5 text-[11.5px]"
                  style={{
                    backgroundColor:
                      selectedOptionId === opt.id ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    borderColor:
                      selectedOptionId === opt.id ? 'var(--border-focus)' : 'var(--border-hairline)',
                  }}
                >
                  <input
                    type="radio"
                    name={`native-req-${approvalId}`}
                    value={opt.id}
                    checked={selectedOptionId === opt.id}
                    onChange={() => setSelectedOptionId(opt.id)}
                  />
                  <span className="text-[var(--text-primary)]">{opt.label}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)]">
              该问题未声明固定可编码选项，禁止以自由文本代填固定选项。
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleDecision('deny')}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
            >
              <XCircle size={11.5} aria-hidden="true" />
              <span>拒绝/取消</span>
            </button>
            <button
              type="button"
              disabled={submitting || !selectedOptionId}
              onClick={() => void handleSubmitOption()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-indigo)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-45"
            >
              <Check size={11.5} aria-hidden="true" />
              <span>提交选择</span>
            </button>
          </div>
        </div>
      ) : isActionable ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleDecision('deny')}
            className="cursor-pointer rounded-lg px-2.5 py-1 text-[11px] font-medium"
            style={{
              color: 'var(--accent-rose)',
              border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
            }}
          >
            拒绝
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleDecision('allow_session')}
            className="cursor-pointer rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)]"
          >
            本会话信任
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleDecision('allow_once')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-emerald)] px-2.5 py-1 text-[11px] font-medium text-white"
          >
            <Check size={11.5} aria-hidden="true" />
            <span>允许本次</span>
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-[var(--text-muted)]">
          只读历史收据：
          {receiptState === 'connection_lost'
            ? '原连接已断开，旧审批不会自动重放。'
            : receiptState === 'delivery_unknown'
              ? '写出响应后发生中断，送达结果未知且不可重放授权。'
              : receiptState === 'response_written'
                ? '响应已写入原生连接，等待后续帧确认实际执行。'
                : '该请求已关闭或已处理。'}
        </p>
      )}

      {localReceiptNotice && (
        <div className="text-[11px] text-[var(--accent-indigo)]" role="status">
          {localReceiptNotice}
        </div>
      )}

      {receipt?.evidence && (
        <EvidenceDetails
          evidence={receipt.evidence}
          reasonCode={receipt.receiptId ? `receipt:${receipt.receiptId}` : undefined}
          label="审批路由与收据证据"
        />
      )}
    </article>
  );
}
