import type { ApprovalRequest, ResolveApprovalRequest } from '@harnessmate/protocol';
import type {
  AgentIdentity,
  NativeAgentId,
  NativeRequestReceiptDto,
} from '../../../../lib/native-client';

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

/** AGY only shows its protocol receipt. All decisions belong to the bound request view. */
export function NativeRequestCard({ approval, receipt, ownerAgent, onJumpToAgent }: NativeRequestCardProps) {
  const id = approval?.id ?? receipt?.approvalId;
  const pending = approval?.status === 'pending' && (!receipt || receipt.receiptState === 'pending');
  const state = receipt?.receiptState;
  const label = state ? ({pending:'待处理',claimed:'发送中',response_written:'响应已写出',cancelled:'已取消',expired:'已过期',connection_lost:'连接丢失',delivery_unknown:'送达未知'}[state] ?? state) : approval?.status;
  return <article data-testid="native-request-reference" data-receipt-state={state ?? (pending ? 'pending' : undefined)} className="rounded border p-2 text-[12px]">
    <p>{approval?.summary ?? id} · {label}</p>
    {pending && <p>请在当前绑定的请求视图处理此请求。</p>}
    {state === 'connection_lost' && <p>原连接已断开，旧审批不会自动重放。</p>}
    {ownerAgent?.label?.kind === 'known' && <p>子 Agent: {ownerAgent.label.value}</p>}
    {receipt?.targetLineage === 'unconfirmed' && <p>来源未确认（保留原生作用域）</p>}
    {ownerAgent && <button onClick={() => onJumpToAgent?.(ownerAgent.id)}>查看子 Agent</button>}
  </article>;
}
