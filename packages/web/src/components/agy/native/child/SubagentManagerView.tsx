import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronRight,
  Eye,
  GitBranch,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NativeAgentId } from '../../../../lib/native-client';
import {
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EVIDENCE_SOURCE_LABELS,
  EntityStatusBadge,
  NativeControlMenu,
  NativeRequestCard,
  type NativeWorkbenchViewProps,
} from '../shared';
import { ChildTimelinePanel } from './ChildTimelinePanel';
import {
  buildAgentBreadcrumbs,
  buildSubagentTreeProjection,
  resolveAgentDisplayName,
  resolveSafeChildControlCapability,
  type ChildTreeNode,
} from './child-tree';

type AgentFilterMode = 'all' | 'confirmed' | 'unresolved' | 'needs_action';

/**
 * NP-05 Native Subagent Manager Workbench View.
 *
 * Implements 09_Frontend_Design.md & NP-05 requirements:
 * - Return to main Agent chat + ancestor breadcrumb navigation.
 * - Real parent-child hierarchy tree (supports nested grandchildren and identical roles with distinct opaque IDs).
 * - Dedicated launch batches section (`work.kind === 'subagent'`) separated from confirmed child identities.
 * - Independent child timeline (`ChildTimelinePanel`), never falling back to parent transcript.
 * - Explicit read-only source provenance; strictly disables dangerous controls for unknown/unresolved/conflicting/snapshot-only children.
 * - Pending approvals surfaced per child with confirmed vs unconfirmed/forwarded scope labels.
 */
export function SubagentManagerView({
  projection,
  capabilities,
  pendingApprovals,
  route,
  isNarrowViewport,
  onNavigate,
  onBackToChat,
  onRefresh,
  onResolveRequest,
  onDispatchControl,
  loadTimeline,
}: NativeWorkbenchViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<AgentFilterMode>('all');

  const tree = useMemo(
    () => (projection ? buildSubagentTreeProjection(projection, pendingApprovals) : null),
    [projection, pendingApprovals],
  );

  const allNodes = useMemo(() => {
    if (!tree) return [] as ChildTreeNode[];
    return [...tree.flattenedTree, ...tree.unresolvedOrConflicting];
  }, [tree]);

  const filteredTreeNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchesNode = (node: ChildTreeNode): boolean => {
      if (filterMode === 'confirmed' && node.agent.lineage !== 'confirmed') return false;
      if (filterMode === 'unresolved' && node.agent.lineage === 'confirmed') return false;
      if (filterMode === 'needs_action' && node.pendingApprovalCount === 0) return false;
      if (!q) return true;
      const role = node.agent.role?.kind === 'known' ? node.agent.role.value.toLowerCase() : '';
      return (
        node.displayName.toLowerCase().includes(q) ||
        node.agent.id.toLowerCase().includes(q) ||
        role.includes(q)
      );
    };
    return {
      confirmed: (tree?.flattenedTree ?? []).filter(matchesNode),
      unresolved: (tree?.unresolvedOrConflicting ?? []).filter(matchesNode),
    };
  }, [tree, searchQuery, filterMode]);

  const selectedNode = useMemo(() => {
    if (!allNodes.length) return null;
    if (route.selectedAgentId) {
      const exact = allNodes.find((n) => n.agent.id === route.selectedAgentId);
      if (exact) return exact;
    }
    return filteredTreeNodes.confirmed[0] ?? filteredTreeNodes.unresolved[0] ?? allNodes[0] ?? null;
  }, [allNodes, route.selectedAgentId, filteredTreeNodes]);

  const breadcrumbs = useMemo(
    () => (projection && selectedNode ? buildAgentBreadcrumbs(projection, selectedNode.agent.id) : []),
    [projection, selectedNode],
  );

  if (!projection || !tree) {
    return (
      <CapabilityUnavailable
        title="Subagent Manager 暂无原生数据"
        gate="unknown"
        capabilityId="AGY-W01"
        reason="当前会话尚未接收到原生运行时投影（或 native runtime 门控关闭）。不会使用 HM subagent_runs 伪造原生子 Agent 关系。"
        officialEntryHint="在官方 CLI 中使用 /agents 查看原生子 Agent。"
        officialDocUrl="https://antigravity.google/docs/cli/commands/agents/"
        onRefresh={onRefresh}
        onReadOnlyFallback={onBackToChat}
        readOnlyFallbackLabel="返回主 Agent 聊天"
      />
    );
  }

  const bindingKey = `${projection.binding.runtimeId}:${projection.binding.generation}`;
  const selectedAgent = selectedNode?.agent ?? null;
  const selectedApprovals = selectedAgent
    ? pendingApprovals.filter((appr) => projection.receipts?.[appr.id]?.agentId === selectedAgent.id)
    : [];

  const safeControl = selectedNode
    ? resolveSafeChildControlCapability({
        agent: selectedNode.agent,
        relation: selectedNode.relation,
        isPrimaryRoot: selectedNode.isPrimaryRoot,
        runtimeStatus: projection.status,
        capabilities,
      })
    : { capability: null };

  const renderNodeButton = (node: ChildTreeNode) => {
    const isSelected = selectedAgent?.id === node.agent.id;
    const indentPx = Math.min(node.depth, 5) * 14;
    const sourceText = node.provenance
      ? EVIDENCE_SOURCE_LABELS[node.provenance.sourceKind]
      : '来源未确认';

    return (
      <button
        key={node.agent.id}
        type="button"
        data-testid="np05-agent-row"
        data-agent-id={node.agent.id}
        data-lineage={node.agent.lineage}
        data-depth={node.depth}
        aria-pressed={isSelected}
        onClick={() => onNavigate({ selectedAgentId: node.agent.id })}
        className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-xl border p-2.5 text-left text-[11.5px] transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          paddingLeft: `${10 + indentPx}px`,
          backgroundColor: isSelected ? 'var(--bg-active)' : 'var(--bg-surface)',
          borderColor: isSelected ? 'var(--border-focus)' : 'var(--border-hairline)',
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {node.depth > 0 ? (
              <GitBranch size={12} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
            ) : (
              <Bot size={12.5} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
            )}
            <span className="truncate font-medium text-[var(--text-primary)]">{node.displayName}</span>
            <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
              {node.agent.id}
            </span>
            {node.isPrimaryRoot && (
              <span className="rounded bg-[var(--accent-indigo-soft)] px-1.5 py-0.5 text-[9.5px] font-medium text-[var(--accent-indigo)]">
                主 Agent
              </span>
            )}
            {node.isReadOnlySnapshotOnly && node.agent.lineage === 'confirmed' && (
              <span className="inline-flex items-center gap-0.5 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-muted)]">
                <Eye size={9.5} aria-hidden="true" />
                <span>{sourceText} · 只读</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-muted)]">
            {node.parentAgentId && <span className="font-mono-code">父: {node.parentAgentId}</span>}
            {node.linkedLaunchWork.length > 0 && (
              <span>关联批次: {node.linkedLaunchWork.length}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <EntityStatusBadge kind="lineage" lineage={node.agent.lineage} compact />
          <EntityStatusBadge kind="foreground" observed={node.agent.foreground} compact />
          {node.agent.status && <EntityStatusBadge kind="work" observed={node.agent.status} compact />}
          {node.pendingApprovalCount > 0 && (
            <span
              data-testid="np05-agent-pending-badge"
              className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-star-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-star)]"
            >
              <ShieldAlert size={10} aria-hidden="true" />
              <span>{node.pendingApprovalCount} 需操作</span>
            </span>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-3" data-testid="np05-subagent-manager">
      {/* Top Bar: Return to Main Agent + Search & Filter */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          data-testid="np05-back-to-main"
          onClick={onBackToChat}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          <span>返回主 Agent 聊天</span>
        </button>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex flex-wrap gap-1" role="group" aria-label="子 Agent 筛选">
            {(
              [
                ['all', '全部'],
                ['confirmed', '已确证'],
                ['unresolved', '待确认'],
                ['needs_action', `需操作 (${tree.totalPendingChildApprovals})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filterMode === key}
                onClick={() => setFilterMode(key)}
                className="cursor-pointer rounded-lg border px-2 py-0.5 text-[10.5px]"
                style={{
                  backgroundColor: filterMode === key ? 'var(--bg-active)' : 'var(--bg-surface)',
                  borderColor: filterMode === key ? 'var(--border-focus)' : 'var(--border-hairline)',
                  color: filterMode === key ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <input
            type="search"
            aria-label="搜索子 Agent"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`筛选 ${projection.agents.length} 个 Agent…`}
            className="w-40 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none sm:w-48"
          />
        </div>
      </div>

      {/* Main Content Grid (stacks cleanly at 480px narrow viewport) */}
      <div className={isNarrowViewport ? 'space-y-3' : 'grid grid-cols-1 gap-3 lg:grid-cols-12'}>
        {/* Left Column: Parent Tree + Unresolved + Launch Batches */}
        <div className={isNarrowViewport ? 'space-y-3' : 'space-y-3 lg:col-span-5'}>
          <section className="space-y-1.5" aria-label="父子 Agent 树">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              已确证父子树 ({filteredTreeNodes.confirmed.length})
            </h3>
            {filteredTreeNodes.confirmed.length === 0 ? (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]">
                <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
                <p className="mt-0.5 text-[10.5px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
              </div>
            ) : (
              <div className="max-h-60 space-y-1.5 overflow-y-auto pr-0.5">
                {filteredTreeNodes.confirmed.map(renderNodeButton)}
              </div>
            )}
          </section>

          {filteredTreeNodes.unresolved.length > 0 && (
            <section className="space-y-1.5" aria-label="身份待确认或冲突的子 Agent">
              <h3 className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-clay)]">
                <AlertTriangle size={11} aria-hidden="true" />
                <span>身份待确认 / 冲突 ({filteredTreeNodes.unresolved.length})</span>
              </h3>
              <div className="max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
                {filteredTreeNodes.unresolved.map(renderNodeButton)}
              </div>
            </section>
          )}

          {/* Launch Batches */}
          <section className="space-y-1.5" aria-label="子 Agent 委派批次">
            <h3 className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <Layers size={11} aria-hidden="true" />
              <span>委派批次 ({tree.launchBatches.length})</span>
            </h3>
            {tree.launchBatches.length === 0 ? (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-[11px] text-[var(--text-muted)]">
                尚未观察到子 Agent 委派批次。
              </div>
            ) : (
              <div className="space-y-1.5" data-testid="np05-launch-batches">
                {tree.launchBatches.map(({ work, linkedAgent, isIdentityConfirmed }) => (
                  <div
                    key={work.id}
                    data-testid="np05-launch-batch-row"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-2 text-[11px]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-[var(--text-primary)]">
                          {work.observedLabel ?? '子 Agent 委派'}
                        </span>
                        <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                          {work.id}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                        {isIdentityConfirmed && linkedAgent ? (
                          <button
                            type="button"
                            onClick={() => onNavigate({ selectedAgentId: linkedAgent.id })}
                            className="cursor-pointer text-[var(--accent-indigo)] underline-offset-2 hover:underline"
                          >
                            已关联子 Agent: {linkedAgent.id}
                          </button>
                        ) : (
                          <span>已观察到委派 · 身份待确认</span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <EntityStatusBadge kind="blocking" blocking={work.blocking} compact />
                      <EntityStatusBadge kind="work" observed={work.state} compact />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Selected Child Inspector + Breadcrumbs + Requests + Safe Control + Independent Timeline */}
        <div className={isNarrowViewport ? 'space-y-3' : 'space-y-3 lg:col-span-7'}>
          {selectedNode ? (
            <div
              className="space-y-3 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
              data-testid="np05-child-detail"
            >
              {/* Ancestor Breadcrumb Navigation */}
              {breadcrumbs.length > 0 && (
                <nav
                  aria-label="父子导航面包屑"
                  data-testid="np05-breadcrumbs"
                  className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--text-muted)]"
                >
                  <button
                    type="button"
                    onClick={onBackToChat}
                    className="cursor-pointer text-[var(--accent-indigo)] hover:underline"
                  >
                    主聊天
                  </button>
                  {breadcrumbs.map((crumb) => {
                    const isCurrent = crumb.id === selectedNode.agent.id;
                    return (
                      <span key={crumb.id} className="inline-flex items-center gap-1">
                        <ChevronRight size={11} aria-hidden="true" />
                        {isCurrent ? (
                          <span className="font-medium text-[var(--text-primary)]">
                            {resolveAgentDisplayName(crumb)}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onNavigate({ selectedAgentId: crumb.id as NativeAgentId })}
                            className="cursor-pointer text-[var(--accent-indigo)] hover:underline"
                          >
                            {resolveAgentDisplayName(crumb)}
                          </button>
                        )}
                      </span>
                    );
                  })}
                </nav>
              )}

              {/* Agent Header */}
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--border-hairline)] pb-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h4 className="text-[13px] font-semibold text-[var(--text-primary)]">
                      {selectedNode.displayName}
                    </h4>
                    <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                      {selectedNode.agent.id}
                    </span>
                  </div>
                  {selectedNode.relation && (
                    <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                      亲缘确认方式：
                      {selectedNode.relation.confidence === 'protocol_confirmed'
                        ? '实时协议确证'
                        : '版本化只读快照确证'}
                      {selectedNode.relation.launchWorkId
                        ? ` · 启动批次 ${selectedNode.relation.launchWorkId}`
                        : ''}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <EntityStatusBadge kind="lineage" lineage={selectedNode.agent.lineage} compact />
                  <EntityStatusBadge kind="foreground" observed={selectedNode.agent.foreground} compact />
                  {selectedNode.agent.status && (
                    <EntityStatusBadge kind="work" observed={selectedNode.agent.status} compact />
                  )}
                </div>
              </div>

              {/* Unresolved / Conflicting Warning */}
              {selectedNode.agent.lineage !== 'confirmed' && (
                <CapabilityUnavailable
                  title={
                    selectedNode.agent.lineage === 'conflicting'
                      ? '检测到子 Agent 亲缘冲突'
                      : '已观察到委派 · 身份待确认'
                  }
                  gate="unknown"
                  capabilityId="AGY-W01"
                  reason={
                    selectedNode.agent.lineage === 'conflicting'
                      ? '同一原生实体出现冲突的父关系或命名空间映射，已拒绝建立父边并禁用控制动作。'
                      : '当前仅观察到工具委派调用，尚未获得协议或版本化快照确证的子会话身份；已禁用针对该子项的危险控件与父轨迹回退。'
                  }
                  onReadOnlyFallback={onBackToChat}
                  readOnlyFallbackLabel="返回主 Agent 继续交互"
                />
              )}

              {/* Child-scoped Pending Approvals */}
              {selectedApprovals.length > 0 && (
                <section className="space-y-2" aria-label="该子 Agent 待处理请求">
                  <h5 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-star)]">
                    需操作的原生请求 ({selectedApprovals.length})
                  </h5>
                  {selectedApprovals.map((appr) => (
                    <NativeRequestCard
                      key={appr.id}
                      approval={appr}
                      receipt={projection.receipts?.[appr.id] ?? null}
                      ownerAgent={selectedNode.agent}
                      onResolve={onResolveRequest}
                    />
                  ))}
                </section>
              )}

              {/* Strictly Gated Native Control Bar (disabled for unknown/unresolved/conflicting/snapshot-only) */}
              <div className="space-y-1">
                <NativeControlMenu
                  target={{ type: 'agent', id: selectedNode.agent.id }}
                  targetLabel={selectedNode.displayName}
                  expectedRevision={selectedNode.agent.revision}
                  binding={projection.binding}
                  capability={safeControl.capability}
                  disabled={!safeControl.capability}
                  onDispatchControl={safeControl.capability ? onDispatchControl : undefined}
                />
                {safeControl.blockReason && (
                  <p
                    data-testid="np05-control-guard-reason"
                    className="text-[10.5px] text-[var(--text-muted)]"
                  >
                    控制门控：{safeControl.blockReason}
                  </p>
                )}
              </div>

              {/* Independent Child Timeline */}
              <ChildTimelinePanel
                agent={selectedNode.agent}
                displayName={selectedNode.displayName}
                bindingKey={bindingKey}
                provenance={selectedNode.provenance}
                isReadOnlySnapshotOnly={selectedNode.isReadOnlySnapshotOnly}
                loadTimeline={loadTimeline}
                onBackToChat={onBackToChat}
              />
            </div>
          ) : (
            <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5 text-center text-[12px] text-[var(--text-muted)]">
              <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
              <p className="mt-1 text-[11px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
