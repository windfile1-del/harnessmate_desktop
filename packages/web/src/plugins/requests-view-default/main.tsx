import { useEffect, useState } from 'react';
import type { ApprovalRequest, ResolveApprovalRequest } from '@harnessmate/protocol';
import type { RuntimeRequestDto } from '@harnessmate/plugin-api';
import { ComposerPendingRequestBar, RiskRulesModal, RuntimeRequestReceiptBlock } from './ApprovalCenter';
import { NativeRequestDetailCard } from './native/NativeRequestDetailCard';
import type { NativeRequestViewItem } from './native/types';
import { requestCall, startRequestView, useRequestViewStore } from './store';
import '../../styles/theme.css';

export function nativeViewItem(fact: RuntimeRequestDto): NativeRequestViewItem {
  const meta = fact.presentation as any;
  const approval = fact.approval as unknown as ApprovalRequest;
  const pending = fact.status === 'pending';
  return { approvalId: fact.requestId, approval, ownerAgent: null, activity: null, workflow: null, meta,
    receipt: { ...meta, approvalId: fact.requestId, generation: fact.origin.driverGeneration,
      receiptState: pending ? 'pending' : fact.delivery === 'unknown' ? 'delivery_unknown' : fact.delivery === 'unavailable' ? 'connection_lost' : fact.status === 'expired' ? 'expired' : fact.status === 'cancelled' ? 'cancelled' : 'response_written' },
    scope: meta.scope, targetLineage: meta.targetLineage, isGenerationCurrent: pending, isRuntimeAttached: pending,
    isPending: pending, isActionable: pending && meta.canAnswer, canAnswer: pending && meta.canAnswer, canCancel: pending,
    isDetached: meta.isDetached, forwardedToParentSession: meta.forwardedToParentSession,
    options: meta.options ?? [], allowedOptionIds: meta.allowedOptionIds ?? [], securityWarnings: meta.securityWarnings ?? [],
    annotations: meta.annotations ?? [], riskLevel: meta.riskLevel ?? 'low' };
}
export function visibleRequests(requests: RuntimeRequestDto[], history = false) {
  return requests.filter(f => !f.closed && (history ? f.status !== 'pending' : f.status === 'pending'));
}
export function RequestQueue({ initialHistory = false }: { initialHistory?: boolean } = {}) {
  const { session, requests, mode, error, refresh } = useRequestViewStore();
  const [history, setHistory] = useState(initialHistory);
  const [rules, setRules] = useState(false);
  useEffect(() => startRequestView(), []);
  const visible = visibleRequests(requests, history);
  const resolve = async (id: string, input: ResolveApprovalRequest) => {
    try {
      const fact = requests.find(f => f.requestId === id)!;
      const result = await requestCall<{ conflict: boolean }>('resolve', { requestId: id, expectedVersion: fact.version, ...input, actor: 'desktop' });
      await refresh(); return result;
    } finally { input.secretValue = undefined; }
  };
  return <section className="space-y-2 p-2 text-[12px]" data-testid="request-plugin-queue">
    <div className="flex gap-3 [&>button]:rounded [&>button]:border [&>button]:px-3 [&>button]:py-1">
      <button onClick={() => setHistory(false)}>待处理 ({requests.filter(f => f.status === 'pending').length})</button>
      <button onClick={() => setHistory(true)}>历史</button><button onClick={() => setRules(true)}>风险规则</button>
    </div>
    {mode && <p data-testid="request-mode-receipt" data-mode-status={mode.status} data-mode-execution={mode.execution}>
      {{ manual:'人工审批', accept_edits:'自动允许编辑', auto:'自动处理', plan:'只读计划' }[mode.requested]} ·
      {{ applied:'驱动已生效', pending_next_session:'等待新会话确认', unsupported:'不支持', rejected:'驱动拒绝', policy_handled:'由所选策略逐次处理' }[mode.status]} ·
      CLI 接受模式：{String(mode.driverAccepted?.modeId ?? mode.driverAccepted?.permissionMode ?? '尚未确认')}
    </p>}
    {error && <p role="alert">{error}</p>}
    {visible.map(fact => <article key={fact.requestId} className="rounded border border-[var(--border-hairline)] p-2" data-request-id={fact.requestId}>
      <p>{fact.approval.summary as string} · {fact.sessionId === session?.id ? '当前会话' : fact.sessionId}</p>
      {fact.status === 'pending' ? fact.presentation ? <NativeRequestDetailCard item={nativeViewItem(fact)} onResolveNative={async (id, native) => {
        const result = await requestCall<{ conflict: boolean; request: RuntimeRequestDto }>('resolve', { requestId: id, expectedVersion: fact.version, actor: 'desktop', native }); await refresh();
        return { conflict: result.conflict, receiptId: String(fact.presentation?.receiptId ?? ''), receiptState: nativeViewItem(result.request).receipt.receiptState };
      }} /> : session && <ComposerPendingRequestBar session={{ ...session, id: fact.sessionId }} pendingRequests={[fact.approval as unknown as ApprovalRequest]} onResolve={resolve} /> : <>
        {fact.decisionReceipt?.optionId && <p>原生选项：{fact.decisionReceipt.optionId} · 范围：{fact.decisionReceipt.scope}</p>}
        <RuntimeRequestReceiptBlock kind={(fact.approval.kind ?? 'command_approval') as ApprovalRequest['kind'] & string} title={String(fact.approval.toolName)} receiptText={`${fact.status} · ${fact.delivery}`} requestStatus={fact.status as ApprovalRequest['status']} resolvedBy={fact.approval.resolvedBy as ApprovalRequest['resolvedBy']} />
        <button aria-label={`关闭 ${fact.requestId}`} onClick={async () => { await requestCall('close', { requestId: fact.requestId }); await refresh(); }}>关闭</button>
      </>}
    </article>)}
    {rules && <RiskRulesModal onClose={() => setRules(false)} />}
  </section>;
}
