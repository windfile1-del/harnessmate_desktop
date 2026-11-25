import type { ApprovalRequest } from '@harnessmate/protocol';
import { ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import { useState } from 'react';
import type {
  NativeAgentId,
  NativeRuntimeProjection,
  WorkflowId,
} from '../../../../lib/native-client';
import { NativeRequestDetailCard } from './NativeRequestDetailCard';
import { selectNativeRequestsForSession } from './selectors';
import type {
  NativeRequestDisplayMeta,
  NativeRequestNavigationHandlers,
  ResolveNativeRequestHandler,
} from './types';

export interface NativeRequestQueuePanelProps extends NativeRequestNavigationHandlers {
  readonly projection: NativeRuntimeProjection | null;
  readonly approvals?: readonly ApprovalRequest[];
  readonly metadataByApprovalId?: Readonly<Record<string, NativeRequestDisplayMeta>>;
  readonly filterAgentId?: NativeAgentId | null;
  readonly filterWorkflowId?: WorkflowId | null;
  readonly filterActivityId?: string | null;
  readonly onResolveNative?: ResolveNativeRequestHandler;
  readonly title?: string;
}

type QueueTab = 'pending' | 'all' | 'history';

/**
 * Session- or entity-scoped native approval/question/elicitation queue panel.
 * Supports 480px narrow layout, pending highlight count, reconnect invalidation notice,
 * and read-only historical receipt inspection.
 */
export function NativeRequestQueuePanel({
  projection,
  approvals,
  metadataByApprovalId,
  filterAgentId,
  filterWorkflowId,
  filterActivityId,
  onResolveNative,
  onJumpToAgent,
  onJumpToActivity,
  onJumpToWorkflow,
  title = '原生审批与交互请求',
}: NativeRequestQueuePanelProps) {
  const [activeTab, setActiveTab] = useState<QueueTab>('all');

  const allItems = selectNativeRequestsForSession({
    projection,
    approvals,
    metadataByApprovalId,
    filterAgentId,
    filterWorkflowId,
    filterActivityId,
  });

  const pendingItems = allItems.filter((item) => item.isPending);
  const historyItems = allItems.filter((item) => !item.isPending);

  const visibleItems =
    activeTab === 'pending'
      ? pendingItems
      : activeTab === 'history'
        ? historyItems
        : allItems;

  return (
    <section
      data-testid="np07-request-queue-panel"
      aria-label={title}
      className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {pendingItems.length > 0 ? (
            <ShieldAlert size={15} className="text-[var(--accent-star)]" aria-hidden="true" />
          ) : (
            <ShieldCheck size={15} className="text-[var(--accent-emerald)]" aria-hidden="true" />
          )}
          <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">{title}</h3>
          {pendingItems.length > 0 && (
            <span
              data-testid="np07-pending-count-badge"
              className="rounded-full bg-[var(--accent-star-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--accent-star)]"
            >
              {pendingItems.length} 项待处理
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 text-[11px]" role="tablist" aria-label="请求状态筛选">
          {(
            [
              { key: 'all', label: `全部 (${allItems.length})` },
              { key: 'pending', label: `待处理 (${pendingItems.length})` },
              { key: 'history', label: `历史回执 (${historyItems.length})` },
            ] as const
          ).map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.key)}
                className="cursor-pointer rounded-lg px-2 py-0.5 font-medium"
                style={{
                  backgroundColor: active ? 'var(--bg-active)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {projection && projection.status !== 'attached' && (
        <div
          data-testid="np07-runtime-disconnected-notice"
          className="flex items-center gap-1.5 rounded-xl bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]"
        >
          <WifiOff size={12.5} className="shrink-0" aria-hidden="true" />
          <span>
            {projection.status === 'reconciling'
              ? '原生运行时正在重连校准，旧连接上的审批已失效且不会重放。'
              : '原生运行时已断开，仅可查看历史回执；新请求将在重新连接后由对端重新发起。'}
          </span>
        </div>
      )}

      {visibleItems.length === 0 ? (
        <p className="rounded-xl bg-[var(--bg-elevated)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
          {activeTab === 'pending'
            ? '当前没有待处理的原生审批或提问请求。'
            : activeTab === 'history'
              ? '尚无已记录的原生请求历史回执。'
              : '尚未观察到原生审批、提问或 Elicitation 请求。'}
        </p>
      ) : (
        <div className="space-y-2">
          {visibleItems.map((item) => (
            <NativeRequestDetailCard
              key={item.approvalId}
              item={item}
              onResolveNative={onResolveNative}
              onJumpToAgent={onJumpToAgent}
              onJumpToActivity={onJumpToActivity}
              onJumpToWorkflow={onJumpToWorkflow}
            />
          ))}
        </div>
      )}
    </section>
  );
}
