import {
  AlertOctagon,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  Clock,
  HelpCircle,
  Layers,
  Shield,
  ShieldAlert,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { EntityStatusBadge } from '../../../components/agy/native/shared/EntityStatusBadge';
import { EvidenceDetails } from '../../../components/agy/native/shared/EvidenceDetails';
import { NativeElicitationForm } from './NativeElicitationForm';
import {
  buildCancelledPayload,
  buildFormSubmittedPayload,
  buildSelectedOptionPayload,
} from './selectors';
import type {
  NativeRequestNavigationHandlers,
  NativeRequestOptionView,
  NativeRequestViewItem,
  ResolveNativeRequestHandler,
} from './types';

export interface NativeRequestDetailCardProps extends NativeRequestNavigationHandlers {
  readonly item: NativeRequestViewItem;
  readonly onResolveNative?: ResolveNativeRequestHandler;
}

function getReceiptDescription(state: NativeRequestViewItem['receipt']['receiptState']): string {
  switch (state) {
    case 'pending':
      return '等待您在当前连接上做出明确选择或取消。';
    case 'claimed':
      return '正在向原连接写入原生响应...';
    case 'response_written':
      return '响应已写入原连接，等待原生后续帧确认实际执行结果。';
    case 'cancelled':
      return '请求已取消，不再接受重复响应。';
    case 'expired':
      return '请求已超出限时自动失效，已向原连接回复取消且不可重放。';
    case 'connection_lost':
      return '原连接已断开或运行代次已切换，旧授权已失效且不会在重连后重放。';
    case 'delivery_unknown':
      return '写出响应期间发生异常或断连，送达结果不确定，严禁自动重放旧授权。';
  }
}

function getScopeLabel(item: NativeRequestViewItem): string {
  if (item.scope === 'confirmed_child') {
    const label =
      item.meta?.agentLabel ??
      (item.ownerAgent?.label?.kind === 'known'
        ? item.ownerAgent.label.value
        : item.ownerAgent?.role?.kind === 'known'
          ? item.ownerAgent.role.value
          : item.receipt.agentId ?? '子 Agent');
    return `子 Agent: ${label}`;
  }
  if (item.scope === 'confirmed_workflow') {
    const wfLabel = item.meta?.workflowLabel ?? item.workflow?.detail.kind ?? 'Workflow';
    return `工作流: ${wfLabel}`;
  }
  if (item.scope === 'unknown_child') {
    return item.targetLineage === 'conflicting'
      ? '子目标亲缘冲突（禁止扩大授权）'
      : '来源未确认（保留原生作用域）';
  }
  return item.isDetached ? '主会话 · 轮次外活动' : '主会话';
}

function isRejectOption(opt: NativeRequestOptionView): boolean {
  return opt.kind === 'reject_once' || opt.kind === 'reject_always' || opt.kind === 'decline';
}

/**
 * Full NP-07 Native Approval, Question & Elicitation Request Card.
 *
 * Guarantees:
 * - Clearly displays owning scope (root / detached activity / confirmed child / workflow / unconfirmed),
 *   security warnings (`agy.security.warning`), Approval Center risk annotations, and real native options.
 * - Highlights pending requests cleanly with semantic badges (color auxiliary).
 * - Submits ONLY exact native `optionId` or schema-validated elicitation `formPayload` via
 *   `ResolveNativeRequestInput`. Never auto-selects first option or encodes free-text into fixed options.
 * - Displays write receipts, conflict resolution notices, and reconnect-invalidated read-only states.
 */
export function NativeRequestDetailCard({
  item,
  onResolveNative,
  onJumpToAgent,
  onJumpToActivity,
  onJumpToWorkflow,
}: NativeRequestDetailCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [selectedOptionId, setSelectedOptionId] = useState<string>('');
  const [criticalArmed, setCriticalArmed] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly tone: 'info' | 'warn' | 'error';
    readonly text: string;
  } | null>(null);

  const { receipt, approval, meta } = item;
  const isCritical = item.riskLevel === 'critical';
  const isUnknownOrConflicting =
    item.scope === 'unknown_child' || item.targetLineage === 'conflicting';
  const isUnresolvedForwarded =
    !isUnknownOrConflicting && item.targetLineage === 'unresolved';

  const title =
    meta?.toolName ??
    approval?.toolName ??
    (receipt.kind === 'elicitation'
      ? '原生表单收集 (Elicitation)'
      : receipt.kind === 'question'
        ? '原生结构化问题'
        : '原生工具权限请求');

  const summary =
    meta?.summary ??
    approval?.summary ??
    meta?.questionText ??
    `原生请求 ${item.approvalId}`;

  const allowedSet = new Set(item.allowedOptionIds);
  const selectableOptions = item.options.filter((opt) => allowedSet.has(opt.optionId));
  const blockedOptions = item.options.filter((opt) => !allowedSet.has(opt.optionId));

  const dispatchResolution = async (
    payload: Parameters<ResolveNativeRequestHandler>[1],
    submittedLabel: string,
  ) => {
    if (!onResolveNative || !item.isActionable || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const outcome = await onResolveNative(item.approvalId, payload);
      if (outcome.conflict) {
        setFeedback({
          tone: 'warn',
          text: `该请求已处理或连接代次已变更（状态：${outcome.receiptState ?? 'conflict'}），未重复发送。`,
        });
      } else if (outcome.receiptState === 'connection_lost') {
        setFeedback({
          tone: 'error',
          text: '原连接已断开，响应未能写出，旧授权不会自动重放。',
        });
      } else if (outcome.receiptState === 'delivery_unknown') {
        setFeedback({
          tone: 'error',
          text: '写出响应状态不确定（delivery_unknown），为保证安全不会自动重放。',
        });
      } else if (outcome.receiptState === 'cancelled') {
        setFeedback({
          tone: 'info',
          text: `已提交取消（回执：${outcome.receiptId ?? receipt.receiptId ?? 'recorded'}）。`,
        });
      } else {
        setFeedback({
          tone: 'info',
          text: `${submittedLabel}已写入原连接（回执：${outcome.receiptId ?? receipt.receiptId ?? 'recorded'}），等待原生后续帧确认。`,
        });
      }
      setCriticalArmed(false);
    } catch (err) {
      setFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const borderColor = item.isActionable
    ? isCritical
      ? 'var(--accent-rose)'
      : isUnknownOrConflicting
        ? 'var(--accent-clay)'
        : 'var(--accent-star)'
    : 'var(--border-hairline)';

  return (
    <article
      data-testid="np07-native-request-card"
      data-approval-id={item.approvalId}
      data-request-kind={receipt.kind}
      data-receipt-state={receipt.receiptState}
      data-scope={item.scope}
      data-target-lineage={item.targetLineage}
      data-actionable={String(item.isActionable)}
      aria-label={`${title} · ${getScopeLabel(item)}`}
      className="space-y-2.5 rounded-2xl p-3 text-[12px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: `${item.isActionable ? '1.5px' : '1px'} solid color-mix(in srgb, ${borderColor} 70%, transparent)`,
      }}
    >
      {/* Header: Kind icon, Title, Receipt Badge, Scope & Lineage Badges, Navigation */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {receipt.kind === 'question' || receipt.kind === 'elicitation' ? (
            <HelpCircle size={15} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
          ) : isCritical ? (
            <AlertOctagon size={15} className="mt-0.5 shrink-0 text-[var(--accent-rose)]" aria-hidden="true" />
          ) : (
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--accent-star)]" aria-hidden="true" />
          )}

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-[var(--text-primary)]">{title}</span>
              <EntityStatusBadge kind="receipt" state={receipt.receiptState} compact />

              <span
                data-testid="np07-scope-badge"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium"
                style={{
                  backgroundColor: isUnknownOrConflicting || isUnresolvedForwarded
                    ? 'var(--accent-clay-soft)'
                    : item.scope === 'confirmed_child' || item.scope === 'confirmed_workflow'
                      ? 'var(--accent-indigo-soft)'
                      : 'var(--bg-elevated)',
                  color: isUnknownOrConflicting || isUnresolvedForwarded
                    ? 'var(--accent-clay)'
                    : item.scope === 'confirmed_child' || item.scope === 'confirmed_workflow'
                      ? 'var(--accent-indigo)'
                      : 'var(--text-secondary)',
                }}
              >
                {item.scope === 'confirmed_child' ? (
                  <Bot size={10.5} aria-hidden="true" />
                ) : item.scope === 'confirmed_workflow' ? (
                  <Layers size={10.5} aria-hidden="true" />
                ) : null}
                <span>{getScopeLabel(item)}</span>
              </span>

              {item.isDetached && (
                <span className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-star-soft)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--accent-star)]">
                  <Clock size={10} aria-hidden="true" />
                  <span>脱离原轮次</span>
                </span>
              )}

              {item.forwardedToParentSession && (
                <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                  经父会话转发
                </span>
              )}

              {meta?.occurrence !== undefined && meta.occurrence > 1 && (
                <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                  #{meta.occurrence}
                </span>
              )}
            </div>

            <p className="mt-1 break-all font-mono-code text-[11.5px] text-[var(--text-secondary)]">
              {summary}
            </p>
          </div>
        </div>

        {/* Jump links for confirmed child / workflow / activity */}
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {item.scope === 'confirmed_child' && receipt.agentId && onJumpToAgent && (
            <button
              type="button"
              onClick={() => onJumpToAgent(receipt.agentId!)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
            >
              <span>查看子 Agent</span>
              <ArrowUpRight size={11} aria-hidden="true" />
            </button>
          )}
          {item.scope === 'confirmed_workflow' && (meta?.workflowId ?? item.workflow?.id) && onJumpToWorkflow && (
            <button
              type="button"
              onClick={() => onJumpToWorkflow((meta?.workflowId ?? item.workflow?.id)!)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
            >
              <span>查看工作流</span>
              <ArrowUpRight size={11} aria-hidden="true" />
            </button>
          )}
          {receipt.activityId && onJumpToActivity && (
            <button
              type="button"
              onClick={() => onJumpToActivity(receipt.activityId!)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <span>关联活动</span>
              <ArrowUpRight size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Security Warnings from Native Wire `_meta['agy.security.warning']` */}
      {item.securityWarnings.length > 0 && (
        <div data-testid="np07-security-warnings" className="space-y-1">
          {item.securityWarnings.map((warning, idx) => (
            <div
              key={idx}
              className="flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]"
              style={{
                backgroundColor: 'var(--accent-rose-soft)',
                color: 'var(--accent-rose)',
              }}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>原生安全说明：{warning}</span>
            </div>
          ))}
        </div>
      )}

      {/* Approval Center Read-only Risk Annotations */}
      {item.annotations.length > 0 && (
        <div className="space-y-1">
          {item.annotations.map((note, idx) => (
            <div
              key={`${note.pluginId}:${idx}`}
              className="flex items-start gap-1.5 rounded-lg px-2.5 py-1 text-[11px]"
              style={{
                backgroundColor: note.degraded
                  ? 'var(--bg-elevated)'
                  : note.risk === 'critical' || note.risk === 'high'
                    ? 'var(--accent-rose-soft)'
                    : 'var(--accent-star-soft)',
                color: note.degraded
                  ? 'var(--text-muted)'
                  : note.risk === 'critical' || note.risk === 'high'
                    ? 'var(--accent-rose)'
                    : 'var(--accent-star)',
              }}
            >
              <Shield size={11.5} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <span className="font-medium">{note.title ?? note.label}</span>
                {note.detail && <span className="ml-1 opacity-90">— {note.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Unknown Child / Unresolved Scope Security Notice */}
      {(isUnknownOrConflicting || isUnresolvedForwarded) && (
        <div
          data-testid="np07-unconfirmed-scope-banner"
          className="flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'var(--accent-clay-soft)',
            color: 'var(--accent-clay)',
          }}
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {isUnknownOrConflicting
              ? '路由无法确证子 Agent 归属，已禁止放行/扩大授权；仅支持拒绝、取消或等待限时自动取消。'
              : '转发请求的子目标尚未确证，已屏蔽持久/跨轮次授权选项，保留当前原生作用域。'}
          </span>
        </div>
      )}

      {/* Generation Mismatch / Reconnect Invalidation Notice */}
      {item.isPending && (!item.isGenerationCurrent || !item.isRuntimeAttached) && (
        <div
          data-testid="np07-reconnect-invalidated-banner"
          className="flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
          }}
        >
          <WifiOff size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {!item.isGenerationCurrent
              ? '当前请求属于旧的运行代次（generation），已自动失效且不可重放。'
              : '原生运行时正在重连校准或已断开，待确认请求暂停提交且不会自动重放。'}
          </span>
        </div>
      )}

      {/* Interactive Body (Actionable Pending Requests) */}
      {item.isActionable && onResolveNative ? (
        receipt.kind === 'elicitation' && meta?.formSpec ? (
          <NativeElicitationForm
            approvalId={item.approvalId}
            formSpec={meta.formSpec}
            canAnswer={item.canAnswer}
            canCancel={item.canCancel}
            submitting={submitting}
            onSubmitForm={(formPayload) =>
              void dispatchResolution(
                buildFormSubmittedPayload(receipt.generation, formPayload),
                '表单回答',
              )
            }
            onDecline={
              allowedSet.has('decline')
                ? () =>
                    void dispatchResolution(
                      buildSelectedOptionPayload(receipt.generation, 'decline'),
                      '拒绝填表',
                    )
                : undefined
            }
            onCancel={() =>
              void dispatchResolution(buildCancelledPayload(receipt.generation), '取消请求')
            }
          />
        ) : receipt.kind === 'question' ? (
          <div className="space-y-2">
            {item.canAnswer && selectableOptions.length > 0 ? (
              <div className="space-y-1.5" role="radiogroup" aria-label="原生固定选项">
                {selectableOptions.map((opt) => {
                  const checked = selectedOptionId === opt.optionId;
                  return (
                    <label
                      key={opt.optionId}
                      className="flex cursor-pointer items-start gap-2 rounded-xl border px-2.5 py-1.5 text-[11.5px]"
                      style={{
                        backgroundColor: checked ? 'var(--bg-active)' : 'var(--bg-elevated)',
                        borderColor: checked ? 'var(--border-focus)' : 'var(--border-hairline)',
                      }}
                    >
                      <input
                        type="radio"
                        name={`np07-q-${item.approvalId}`}
                        value={opt.optionId}
                        checked={checked}
                        disabled={submitting}
                        onChange={() => setSelectedOptionId(opt.optionId)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--text-primary)]">{opt.name}</div>
                        <div className="font-mono-code text-[10px] text-[var(--text-muted)]">
                          id: {opt.optionId}
                        </div>
                        {opt.description && (
                          <div className="text-[10.5px] text-[var(--text-secondary)]">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div
                data-testid="np07-unsupported-question-notice"
                className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[11px] text-[var(--text-secondary)]"
              >
                当前问题未声明可编码的原生选项（原因：{item.unsupportedReason ?? 'no_verified_free_text_wire_encoding'}），禁止以自由文本代填或隐式映射首个选项。
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-1.5">
              <button
                type="button"
                disabled={submitting || !item.canCancel}
                onClick={() =>
                  void dispatchResolution(buildCancelledPayload(receipt.generation), '取消问题')
                }
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
              >
                <XCircle size={11.5} aria-hidden="true" />
                <span>取消</span>
              </button>
              {item.canAnswer && selectableOptions.length > 0 && (
                <button
                  type="button"
                  disabled={submitting || !selectedOptionId}
                  onClick={() =>
                    void dispatchResolution(
                      buildSelectedOptionPayload(receipt.generation, selectedOptionId),
                      `原生选项「${selectedOptionId}」`,
                    )
                  }
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-indigo)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-45"
                >
                  <Check size={11.5} aria-hidden="true" />
                  <span>提交原生选择</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          /* Permission request: render real native options only */
          <div className="space-y-2">
            {isCritical && item.canAnswer && (
              <label
                className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-[11px]"
                style={{
                  backgroundColor: 'var(--accent-rose-soft)',
                  color: 'var(--accent-rose)',
                }}
              >
                <input
                  type="checkbox"
                  checked={criticalArmed}
                  disabled={submitting}
                  onChange={(e) => setCriticalArmed(e.target.checked)}
                />
                <span>高危操作禁止单键误触：我已审阅上述目标范围与安全说明，确认放行</span>
              </label>
            )}

            {blockedOptions.length > 0 && (
              <div className="text-[10.5px] text-[var(--text-muted)]">
                已受限隐藏选项：{blockedOptions.map((o) => `${o.name} (${o.optionId})`).join('、')}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-1.5">
              <button
                type="button"
                disabled={submitting || !item.canCancel}
                onClick={() =>
                  void dispatchResolution(buildCancelledPayload(receipt.generation), '取消权限请求')
                }
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
              >
                <XCircle size={11.5} aria-hidden="true" />
                <span>取消</span>
              </button>

              {selectableOptions.map((opt) => {
                const rejectLike = isRejectOption(opt);
                const disabled =
                  submitting || (!rejectLike && (isCritical && !criticalArmed));
                return (
                  <button
                    key={opt.optionId}
                    type="button"
                    data-option-id={opt.optionId}
                    disabled={disabled}
                    onClick={() =>
                      void dispatchResolution(
                        buildSelectedOptionPayload(receipt.generation, opt.optionId),
                        `选项「${opt.name}」`,
                      )
                    }
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
                    style={
                      rejectLike
                        ? {
                            color: 'var(--accent-rose)',
                            border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
                          }
                        : opt.kind === 'allow_once'
                          ? {
                              backgroundColor: isCritical
                                ? 'var(--accent-rose)'
                                : 'var(--accent-emerald)',
                              color: '#ffffff',
                            }
                          : {
                              backgroundColor: 'var(--bg-elevated)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-primary)',
                            }
                    }
                  >
                    {!rejectLike && <Check size={11.5} aria-hidden="true" />}
                    <span>{opt.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )
      ) : (
        <p data-testid="np07-receipt-readonly" className="text-[11px] text-[var(--text-secondary)]">
          {getReceiptDescription(receipt.receiptState)}
        </p>
      )}

      {/* Submission / Conflict Feedback */}
      {feedback && (
        <div
          data-testid="np07-submit-feedback"
          role="status"
          className="rounded-lg px-2.5 py-1.5 text-[11px]"
          style={{
            backgroundColor:
              feedback.tone === 'error'
                ? 'var(--accent-rose-soft)'
                : feedback.tone === 'warn'
                  ? 'var(--accent-star-soft)'
                  : 'var(--accent-indigo-soft)',
            color:
              feedback.tone === 'error'
                ? 'var(--accent-rose)'
                : feedback.tone === 'warn'
                  ? 'var(--accent-star)'
                  : 'var(--accent-indigo)',
          }}
        >
          {feedback.text}
        </div>
      )}

      {/* Receipt & Provenance Evidence */}
      {receipt.evidence && (
        <EvidenceDetails
          evidence={receipt.evidence}
          reasonCode={
            receipt.receiptId
              ? `receipt:${receipt.receiptId}${meta?.provenanceReason ? ` · ${meta.provenanceReason}` : ''}`
              : meta?.provenanceReason
          }
          label="审批路由与回执证据"
        />
      )}
    </article>
  );
}
