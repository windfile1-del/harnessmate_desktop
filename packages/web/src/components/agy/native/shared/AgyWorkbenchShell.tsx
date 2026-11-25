import {
  Activity as ActivityIcon,
  ArrowLeft,
  Bot,
  CalendarClock,
  Layers,
  Maximize2,
  Minimize2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  coalesceTimelineEntries,
  type CapabilityDescriptor,
  type NativeAgentId,
  type NativeTimelineEntry,
  type NativeWork,
  type NativeWorkflow,
} from '../../../../lib/native-client';
import { CapabilityUnavailable } from './CapabilityUnavailable';
import { EntityStatusBadge } from './EntityStatusBadge';
import { EvidenceDetails } from './EvidenceDetails';
import {
  computeNextTabIndex,
  focusFirstInContainer,
  handleDialogTabTrap,
  shouldWorkbenchHandleEscape,
} from './focus-utils';
import { NativeControlMenu } from './NativeControlMenu';
import { NativeRequestCard } from './NativeRequestCard';
import { NativeTimeline } from './NativeTimeline';
import {
  ACTIVITY_ORIGIN_LABELS,
  EMPTY_STATE_COPY,
  WORK_KIND_LABELS,
} from './status-dictionary';
import {
  agyWorkbenchRegistry,
  type AgyWorkbenchRegistry,
  type NativeWorkbenchViewProps,
  type WorkbenchSurfaceId,
} from './workbench-registry';

// ── Built-in Default Views (Order 900; overridden by NP-04..NP-12 Studios) ──

function findCap(
  capabilities: readonly CapabilityDescriptor[],
  ids: readonly string[],
): CapabilityDescriptor | undefined {
  for (const id of ids) {
    const found = capabilities.find((c) => c.id === id);
    if (found) return found;
  }
  return undefined;
}

interface ScopedTimelineState {
  scopeKey: string;
  entries: NativeTimelineEntry[];
  loading: boolean;
  nextPageToken: string | null;
  sourceUnavailable: boolean;
  sourceUnavailableReason?: string;
}

/**
 * Binding- and scope-isolated timeline loader shared by Runtime Center & Subagent Manager.
 * - Immediately resets entries when runtime/generation/entity changes (no stale entries under new header).
 * - Cancels BOTH initial fetch and any in-flight `loadMore` fetch on scope change or unmount.
 * - Guards async resolution with `activeScopeKeyRef` and coalesces paginated deltas safely.
 */
function useScopedNativeTimeline(
  scope: { kind: 'activity' | 'agent'; id: string } | null,
  bindingKey: string | null,
  loadTimeline?: NativeWorkbenchViewProps['loadTimeline'],
) {
  const scopeKey = scope && bindingKey ? `${bindingKey}:${scope.kind}:${scope.id}` : '';
  const activeScopeKeyRef = useRef(scopeKey);
  activeScopeKeyRef.current = scopeKey;
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<ScopedTimelineState>({
    scopeKey,
    entries: [],
    loading: false,
    nextPageToken: null,
    sourceUnavailable: false,
  });

  useEffect(() => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

    if (!scope || !bindingKey || !loadTimeline) {
      setState({
        scopeKey,
        entries: [],
        loading: false,
        nextPageToken: null,
        sourceUnavailable: false,
      });
      return;
    }

    const requestScopeKey = scopeKey;
    const controller = new AbortController();
    // Immediately clear stale entries from previous scope while loading new scope
    setState({
      scopeKey: requestScopeKey,
      entries: [],
      loading: true,
      nextPageToken: null,
      sourceUnavailable: false,
    });

    void loadTimeline(scope, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState({
          scopeKey: requestScopeKey,
          entries: coalesceTimelineEntries([], page.items),
          loading: false,
          nextPageToken: page.nextPageToken,
          sourceUnavailable: Boolean(page.sourceUnavailableReason),
          sourceUnavailableReason: page.sourceUnavailableReason,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState({
          scopeKey: requestScopeKey,
          entries: [],
          loading: false,
          nextPageToken: null,
          sourceUnavailable: true,
        });
      });

    return () => {
      controller.abort();
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [scope?.kind, scope?.id, bindingKey, scopeKey, loadTimeline]);

  const loadMore = useCallback(() => {
    if (!scope || !bindingKey || !loadTimeline) return;
    if (state.scopeKey !== scopeKey || !state.nextPageToken || state.loading) return;
    const requestScopeKey = scopeKey;
    const token = state.nextPageToken;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setState((prev) => (prev.scopeKey === requestScopeKey ? { ...prev, loading: true } : prev));

    void loadTimeline(scope, token, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState((prev) => {
          if (prev.scopeKey !== requestScopeKey) return prev;
          return {
            ...prev,
            entries: coalesceTimelineEntries(prev.entries, page.items),
            nextPageToken: page.nextPageToken,
            loading: false,
          };
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState((prev) => (prev.scopeKey === requestScopeKey ? { ...prev, loading: false } : prev));
      });
  }, [scope, bindingKey, loadTimeline, state.scopeKey, state.nextPageToken, state.loading, scopeKey]);

  // Never render entries belonging to an older scope during render transition
  const matchesCurrentScope = state.scopeKey === scopeKey;
  return {
    entries: matchesCurrentScope ? state.entries : [],
    loading: matchesCurrentScope ? state.loading : Boolean(scope && bindingKey && loadTimeline),
    hasMore: matchesCurrentScope && Boolean(state.nextPageToken),
    sourceUnavailable: matchesCurrentScope && state.sourceUnavailable,
    sourceUnavailableReason: matchesCurrentScope ? state.sourceUnavailableReason : undefined,
    loadMore: matchesCurrentScope && state.nextPageToken ? loadMore : undefined,
  };
}

function DefaultRuntimeCenterView({
  projection,
  syncState,
  capabilities,
  pendingApprovals,
  route,
  onNavigate,
  onRefresh,
  onResolveRequest,
  onDispatchControl,
  loadTimeline,
}: NativeWorkbenchViewProps) {
  const [filterKind, setFilterKind] = useState<'all' | NativeWork['kind']>('all');

  const activities = projection?.activities ?? [];
  const workItems = projection?.work ?? [];
  const filteredWork = useMemo(
    () => (filterKind === 'all' ? workItems : workItems.filter((w) => w.kind === filterKind)),
    [workItems, filterKind],
  );
  const selectedActivity =
    activities.find((a) => a.id === route.selectedActivityId) ?? activities[0] ?? null;
  const selectedWork =
    filteredWork.find((w) => w.id === route.selectedWorkId) ?? filteredWork[0] ?? null;

  const runtimeCap = findCap(capabilities, ['AGY-R10', 'AGY-W11', 'AGY-R04']);
  const bindingKey = projection
    ? `${projection.binding.runtimeId}:${projection.binding.generation}`
    : null;
  const activityScope = useMemo(
    () => (selectedActivity ? { kind: 'activity' as const, id: selectedActivity.id } : null),
    [selectedActivity?.id],
  );
  const timeline = useScopedNativeTimeline(activityScope, bindingKey, loadTimeline);

  if (!projection) {
    return (
      <CapabilityUnavailable
        title="原生运行时尚未连接"
        gate="unknown"
        capabilityId="AGY-W11"
        reason="当前会话尚未接收到原生运行时快照（或后端 native feed 尚未启用）。现有聊天与 AGY-5 基础功能不受影响。"
        officialEntryHint="在官方 CLI 中可使用 /tasks 查看后台任务与状态。"
        officialDocUrl="https://antigravity.google/docs/cli/reference/"
        onRefresh={onRefresh}
      />
    );
  }

  const runningWorkCount = workItems.filter(
    (w) => w.state.kind === 'known' && w.state.value === 'running',
  ).length;
  const waitingWorkCount = workItems.filter(
    (w) => w.state.kind === 'known' && (w.state.value === 'waiting' || w.state.value === 'queued'),
  ).length;
  const activeReceipts = Object.values(projection.receipts ?? {});

  return (
    <div className="space-y-4" data-testid="workbench-runtime-center">
      {/* Top Runtime Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryStat label="连接状态">
          <EntityStatusBadge kind="runtime" status={projection.status} compact />
        </SummaryStat>
        <SummaryStat label="已证实运行中">
          <span className="font-mono-code text-[14px] font-semibold text-[var(--accent-indigo)]">
            {runningWorkCount}
          </span>
        </SummaryStat>
        <SummaryStat label="等待/排队">
          <span className="font-mono-code text-[14px] font-semibold text-[var(--accent-star)]">
            {waitingWorkCount}
          </span>
        </SummaryStat>
        <SummaryStat label="待处理请求">
          <span className="font-mono-code text-[14px] font-semibold text-[var(--accent-rose)]">
            {pendingApprovals.length}
          </span>
        </SummaryStat>
      </div>

      {syncState?.phase === 'incomplete' && (
        <CapabilityUnavailable
          title="数据未完成同步"
          gate="unknown"
          capabilityId="AGY-S03"
          reason={
            syncState.lastError ??
            '事件补缺未完成或触达分页上限，当前展示可能落后于实时状态，请点击刷新重试。'
          }
          onRefresh={onRefresh}
        />
      )}

      {projection.status !== 'attached' && (
        <CapabilityUnavailable
          title={projection.status === 'reconciling' ? '重连校准中' : '观测连接已断开'}
          gate={projection.status === 'reconciling' ? 'unknown' : 'unsupported'}
          capabilityId="AGY-S03"
          reason={
            projection.status === 'reconciling'
              ? '正在重新对齐最新原生快照，未确认的工作项已标为最后观测或未知，不自动重放旧权限。'
              : '观测进程已断开，不能直接推断后台进程已停止；保留只读收据与最后观测。'
          }
          onRefresh={onRefresh}
        />
      )}

      {/* Pending Requests & Receipts */}
      {(pendingApprovals.length > 0 || activeReceipts.length > 0) && (
        <section className="space-y-2" aria-label="原生权限与收据">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            原生请求与收据 ({pendingApprovals.length} 待决 · {activeReceipts.length} 收据)
          </h3>
          <div className="space-y-2">
            {pendingApprovals.map((appr) => {
              const receipt = projection.receipts?.[appr.id] ?? null;
              const owner = receipt?.agentId
                ? projection.agents.find((a) => a.id === receipt.agentId) ?? null
                : null;
              return (
                <NativeRequestCard
                  key={appr.id}
                  approval={appr}
                  receipt={receipt}
                  ownerAgent={owner}
                  onResolve={onResolveRequest}
                  onJumpToAgent={(agentId) =>
                    onNavigate({ surface: 'subagents', selectedAgentId: agentId })
                  }
                />
              );
            })}
            {activeReceipts
              .filter((r) => !pendingApprovals.some((a) => a.id === r.approvalId))
              .map((receipt) => {
                const owner = receipt.agentId
                  ? projection.agents.find((a) => a.id === receipt.agentId) ?? null
                  : null;
                return (
                  <NativeRequestCard
                    key={receipt.approvalId}
                    receipt={receipt}
                    ownerAgent={owner}
                    onJumpToAgent={(agentId) =>
                      onNavigate({ surface: 'subagents', selectedAgentId: agentId })
                    }
                  />
                );
              })}
          </div>
        </section>
      )}

      {/* Work Filter & List */}
      <section className="space-y-2" aria-label="原生工作项列表">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            后台命令 / Daemon / 定时任务 ({filteredWork.length})
          </h3>
          <div className="flex flex-wrap gap-1" role="group" aria-label="按工作类型筛选">
            {(['all', 'finite_command', 'daemon', 'schedule', 'subagent'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={filterKind === k}
                onClick={() => setFilterKind(k)}
                className="cursor-pointer rounded-lg border px-2 py-0.5 text-[10.5px]"
                style={{
                  backgroundColor: filterKind === k ? 'var(--bg-active)' : 'var(--bg-surface)',
                  borderColor: filterKind === k ? 'var(--border-focus)' : 'var(--border-hairline)',
                  color: filterKind === k ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                }}
              >
                {k === 'all' ? '全部' : WORK_KIND_LABELS[k]}
              </button>
            ))}
          </div>
        </div>

        {filteredWork.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]">
            <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
            <p className="mt-0.5 text-[10.5px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredWork.map((work) => {
              const selected = selectedWork?.id === work.id;
              return (
                <button
                  key={work.id}
                  type="button"
                  onClick={() => onNavigate({ selectedWorkId: work.id })}
                  className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-xl border p-2.5 text-left text-[11.5px] transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-surface)',
                    borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                  }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-[var(--text-primary)]">
                        {work.observedLabel ?? WORK_KIND_LABELS[work.kind]}
                      </span>
                      <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                        {work.id}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <EntityStatusBadge kind="blocking" blocking={work.blocking} compact />
                    <EntityStatusBadge kind="work" observed={work.state} compact />
                    {work.outcome && <EntityStatusBadge kind="outcome" observed={work.outcome} compact />}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selectedWork && (
          <div className="space-y-2 pt-1">
            <NativeControlMenu
              target={{ type: 'work', id: selectedWork.id }}
              targetLabel={selectedWork.observedLabel ?? selectedWork.id}
              expectedRevision={selectedWork.revision}
              binding={projection.binding}
              capability={runtimeCap}
              onDispatchControl={onDispatchControl}
            />
            <EvidenceDetails
              evidence={
                selectedWork.state.kind === 'known'
                  ? selectedWork.state.evidence
                  : selectedWork.state.kind === 'stale'
                    ? selectedWork.state.evidence
                    : null
              }
              reasonCode={
                selectedWork.state.kind !== 'known' ? selectedWork.state.reasonCode : undefined
              }
              label={`工作项 ${selectedWork.id} 观测证据`}
            />
          </div>
        )}
      </section>

      {/* Activities & Scoped Timeline */}
      <section className="space-y-2" aria-label="原生活动时间线">
        <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          原生活动与续跑 ({activities.length})
        </h3>
        {activities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {activities.map((act) => (
              <button
                key={act.id}
                type="button"
                onClick={() => onNavigate({ selectedActivityId: act.id })}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
                style={{
                  backgroundColor:
                    selectedActivity?.id === act.id ? 'var(--bg-active)' : 'var(--bg-surface)',
                  borderColor:
                    selectedActivity?.id === act.id ? 'var(--border-focus)' : 'var(--border-hairline)',
                }}
              >
                <span>{ACTIVITY_ORIGIN_LABELS[act.origin]}</span>
                <EntityStatusBadge kind="activity" status={act.state} compact />
              </button>
            ))}
          </div>
        )}
        <NativeTimeline
          entries={timeline.entries}
          scopeLabel={selectedActivity ? `活动 ${selectedActivity.id}` : '活动时间线'}
          loading={timeline.loading}
          hasMore={timeline.hasMore}
          sourceNotProvided={timeline.sourceUnavailable}
          sourceUnavailableReason={
            timeline.sourceUnavailable
              ? (timeline.sourceUnavailableReason ??
                '当前连接未暴露活动级分页时间线，请在主聊天或官方 /tasks 查看。')
              : undefined
          }
          onLoadMore={timeline.loadMore}
        />
      </section>
    </div>
  );
}

function DefaultSubagentManagerView({
  projection,
  capabilities,
  pendingApprovals,
  route,
  onNavigate,
  onBackToChat,
  onRefresh,
  onResolveRequest,
  onDispatchControl,
  loadTimeline,
}: NativeWorkbenchViewProps) {
  const [roleFilter, setRoleFilter] = useState('');

  const agents = projection?.agents ?? [];
  const relations = projection?.relations ?? [];
  const filteredAgents = useMemo(() => {
    const q = roleFilter.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => {
      const role = a.role?.kind === 'known' ? a.role.value.toLowerCase() : '';
      const label = a.label?.kind === 'known' ? a.label.value.toLowerCase() : '';
      return a.id.toLowerCase().includes(q) || role.includes(q) || label.includes(q);
    });
  }, [agents, roleFilter]);

  const selectedAgent =
    agents.find((a) => a.id === route.selectedAgentId) ?? filteredAgents[0] ?? null;
  const childCap = findCap(capabilities, ['AGY-W02', 'AGY-W01']);
  const bindingKey = projection
    ? `${projection.binding.runtimeId}:${projection.binding.generation}`
    : null;
  const agentScope = useMemo(
    () => (selectedAgent ? { kind: 'agent' as const, id: selectedAgent.id } : null),
    [selectedAgent?.id],
  );
  const timeline = useScopedNativeTimeline(agentScope, bindingKey, loadTimeline);

  if (!projection) {
    return (
      <CapabilityUnavailable
        title="Subagent Manager 暂无数据"
        gate="unknown"
        capabilityId="AGY-W01"
        reason="尚未加载原生运行时投影。"
        officialEntryHint="在官方 CLI 中使用 /agents 查看原生子 Agent 列表。"
        onRefresh={onRefresh}
      />
    );
  }

  const parentByChild = new Map<NativeAgentId, NativeAgentId>(
    relations.map((r) => [r.childAgentId, r.parentAgentId]),
  );

  const agentApprovals = selectedAgent
    ? pendingApprovals.filter((appr) => projection.receipts?.[appr.id]?.agentId === selectedAgent.id)
    : [];

  return (
    <div className="space-y-3" data-testid="workbench-subagent-manager">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBackToChat}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          <span>返回主 Agent 聊天</span>
        </button>

        <input
          type="search"
          aria-label="筛选子 Agent"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          placeholder={`筛选 ${agents.length} 个子 Agent…`}
          className="w-48 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
      </div>

      {filteredAgents.length === 0 ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-center text-[12px] text-[var(--text-muted)]">
          <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
          <p className="mt-1 text-[11px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto pr-0.5">
          {filteredAgents.slice(0, 120).map((agent) => {
            const label =
              agent.label?.kind === 'known'
                ? agent.label.value
                : agent.role?.kind === 'known'
                  ? agent.role.value
                  : agent.id;
            const parentId = parentByChild.get(agent.id);
            const selected = selectedAgent?.id === agent.id;
            const pendingCount = pendingApprovals.filter(
              (a) => projection.receipts?.[a.id]?.agentId === agent.id,
            ).length;

            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onNavigate({ selectedAgentId: agent.id })}
                className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-xl border p-2.5 text-left text-[11.5px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-surface)',
                  borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                }}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Bot size={12.5} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
                    <span className="truncate font-medium text-[var(--text-primary)]">{label}</span>
                    <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                      {agent.id}
                    </span>
                    {parentId && (
                      <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                        ← {parentId}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <EntityStatusBadge kind="lineage" lineage={agent.lineage} compact />
                  <EntityStatusBadge kind="foreground" observed={agent.foreground} compact />
                  {pendingCount > 0 && (
                    <span className="rounded-full bg-[var(--accent-star-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-star)]">
                      {pendingCount} 审批
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selectedAgent && (
        <div className="space-y-2.5 border-t border-[var(--border-hairline)] pt-2.5">
          {selectedAgent.lineage !== 'confirmed' && (
            <CapabilityUnavailable
              title="已观察到委派 · 身份待确认"
              gate="unknown"
              capabilityId="AGY-W01"
              reason="仅观察到子任务启动批次，尚未获得协议或版本化快照确证的子身份；已禁用针对该子项的控制与错误归属。"
              onReadOnlyFallback={onBackToChat}
              readOnlyFallbackLabel="返回主 Agent 继续交互"
            />
          )}

          {agentApprovals.map((appr) => (
            <NativeRequestCard
              key={appr.id}
              approval={appr}
              receipt={projection.receipts?.[appr.id] ?? null}
              ownerAgent={selectedAgent}
              onResolve={onResolveRequest}
            />
          ))}

          <NativeControlMenu
            target={{ type: 'agent', id: selectedAgent.id }}
            targetLabel={selectedAgent.id}
            expectedRevision={selectedAgent.revision}
            binding={projection.binding}
            capability={selectedAgent.lineage === 'confirmed' ? childCap : null}
            onDispatchControl={onDispatchControl}
          />

          <NativeTimeline
            entries={timeline.entries}
            scopeLabel={`子 Agent ${selectedAgent.id} 轨迹`}
            loading={timeline.loading}
            hasMore={timeline.hasMore}
            onLoadMore={timeline.loadMore}
            sourceNotProvided={timeline.sourceUnavailable}
            sourceUnavailableReason={
              timeline.sourceUnavailableReason ??
              '该子 Agent 暂无已验证的独立轨迹源；不会回退到父会话历史以免错标。'
            }
          />
        </div>
      )}
    </div>
  );
}

function DefaultWorkflowDegradedView({
  kind,
  title,
  capabilityIds,
  officialEntryHint,
  officialDocUrl,
  props,
}: {
  kind: NativeWorkflow['detail']['kind'];
  title: string;
  capabilityIds: readonly string[];
  officialEntryHint: string;
  officialDocUrl: string;
  props: NativeWorkbenchViewProps;
}) {
  const { projection, capabilities, onRefresh, onBackToChat } = props;
  const workflows = (projection?.workflows ?? []).filter((w) => w.detail.kind === kind);
  const cap = findCap(capabilities, capabilityIds);

  return (
    <div className="space-y-3" data-testid={`workbench-studio-${kind}`}>
      {workflows.length === 0 ? (
        <CapabilityUnavailable
          title={`${title} · ${cap ? '按证据门控' : '尚未观察到工作流'}`}
          gate={cap?.observe ?? 'upstream_limited'}
          capabilityId={capabilityIds[0]}
          reason={
            cap?.observe === 'upstream_limited'
              ? `当前 ACP 未提供完整的 ${title} 结构化 feed，仅展示已确证的活动与子项，不从文本推断阶段或进度。`
              : `当前会话尚未观察到活跃的 ${title} 实例。空列表不能证明原生侧已停止。`
          }
          officialEntryHint={officialEntryHint}
          officialDocUrl={officialDocUrl}
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天观察原始流"
        />
      ) : (
        workflows.map((wf) => (
          <div
            key={wf.id}
            className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--text-primary)]">{title}</span>
                <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                  {wf.id}
                </span>
              </div>
              <EntityStatusBadge kind="work" observed={wf.state} />
            </div>

            {wf.detail.kind === 'swarm' && (
              <div className="space-y-2">
                {wf.detail.board.kind === 'known' && wf.detail.board.value === 'upstream_limited' && (
                  <CapabilityUnavailable
                    title="当前 ACP 未提供 Board"
                    gate="upstream_limited"
                    capabilityId="AGY-W05"
                    reason="保留协调者与已确认子项，不从文本伪造帖子或 worker 进度。"
                    officialEntryHint="在官方 CLI 中运行 /swarm board 或按 Alt+S 查看完整协作板。"
                    officialDocUrl="https://antigravity.google/docs/swarm/"
                  />
                )}
                <div className="text-[11.5px] text-[var(--text-secondary)]">
                  协调者：{wf.detail.coordinatorId ?? '待确认'} · 已确认 Workers：{wf.detail.workerIds.length}
                </div>
              </div>
            )}

            {wf.detail.kind === 'boost' && (
              <div className="space-y-1.5">
                {wf.detail.phases && wf.detail.phases.length > 0 ? (
                  wf.detail.phases.map((phase) => (
                    <div
                      key={phase.id}
                      className="flex items-center justify-between rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11.5px]"
                    >
                      <span>{phase.label}</span>
                      <EntityStatusBadge kind="work" observed={phase.state} compact />
                    </div>
                  ))
                ) : (
                  <p className="text-[11.5px] text-[var(--text-muted)]">
                    未获得原生 Boost 阶段证据，已隐藏阶段进度条，仅保留通用任务与活动追踪。
                  </p>
                )}
              </div>
            )}

            {wf.detail.kind === 'teamwork' && (
              <div className="space-y-1.5 text-[11.5px] text-[var(--text-secondary)]">
                <div>项目：{wf.detail.projectLabel ?? '待原生确认'}</div>
                {(!wf.detail.milestones || wf.detail.milestones.length === 0) && (
                  <CapabilityUnavailable
                    title="Teamwork 里程碑或原生批准路径未开放"
                    gate="upstream_limited"
                    capabilityId="AGY-W07"
                    reason="未收到里程碑数据时隐藏图表，仅保留已观察的访谈与 Prompt Artifact 路径说明。"
                    officialEntryHint="在官方 App/CLI 中完成 Teamwork Prompt Artifact 批准。"
                    officialDocUrl="https://antigravity.google/docs/teamwork/"
                  />
                )}
              </div>
            )}

            {wf.detail.kind === 'dynamic' && (
              <div className="space-y-1.5 text-[11.5px] text-[var(--text-secondary)]">
                {(!wf.detail.steps || wf.detail.steps.length === 0) ? (
                  <CapabilityUnavailable
                    title="未获得实际依赖图 (DAG)"
                    gate="upstream_limited"
                    capabilityId="AGY-W08"
                    reason="未收到真实 phase/edge 证据时仅展示可排序时间线与脚本审阅，不根据模型输出虚构 DAG。"
                    officialEntryHint="脚本批准走原生 Approval Router；不在客户端执行替代脚本。"
                    officialDocUrl="https://antigravity.google/docs/dynamic-workflows/"
                  />
                ) : (
                  wf.detail.steps.map((step) => (
                    <div
                      key={step.id}
                      className="flex items-center justify-between rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1.5"
                    >
                      <span>{step.label}</span>
                      <EntityStatusBadge kind="work" observed={step.state} compact />
                    </div>
                  ))
                )}
              </div>
            )}

            {wf.detail.kind === 'goal' && (
              <div className="text-[11.5px] text-[var(--text-secondary)]">
                目标：{wf.detail.objective ?? '待观测'} · 验证产物：{wf.detail.verificationArtifactIds?.length ?? 0}
              </div>
            )}

            {wf.detail.kind === 'schedule' && (
              <div className="text-[11.5px] text-[var(--text-secondary)]">
                计划：{wf.detail.scheduleLabel ?? '以原生观测为准'} · 已记录触发次数：{wf.detail.occurrenceWorkIds.length}
              </div>
            )}

            <EvidenceDetails
              evidence={
                wf.state.kind === 'known'
                  ? wf.state.evidence
                  : wf.state.kind === 'stale'
                    ? wf.state.evidence
                    : null
              }
              reasonCode={wf.state.kind !== 'known' ? wf.state.reasonCode : undefined}
              evidenceRefs={cap?.evidenceRefs}
            />
          </div>
        ))
      )}
    </div>
  );
}

function SummaryStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * Registers the default honest-degradation Workbench views into the given registry at order 900.
 * Idempotent: domain packages (NP-04..NP-12) override any surface by registering with order < 500.
 */
export function registerDefaultWorkbenchViews(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
): () => void {
  const disposers = [
    registry.registerView({
      id: 'runtime',
      owner: 'core.agy-workbench',
      title: 'Runtime Center',
      shortTitle: 'Runtime',
      description: '原生运行时摘要、后台任务、Daemon、活动时间线与待决审批',
      capabilityIds: ['AGY-R03', 'AGY-R04', 'AGY-R05', 'AGY-W11'],
      order: 900,
      badgeCount: (proj, pending) =>
        pending.length +
        (proj?.work.filter((w) => w.state.kind === 'known' && w.state.value === 'running').length ?? 0),
      render: (props) => <DefaultRuntimeCenterView {...props} />,
    }),
    registry.registerView({
      id: 'subagents',
      owner: 'core.agy-workbench',
      title: 'Subagent Manager',
      shortTitle: 'Subagents',
      description: '原生父子树、子身份确证状态、独立轨迹与子审批跳转',
      capabilityIds: ['AGY-W01', 'AGY-W02'],
      order: 900,
      badgeCount: (proj) => proj?.agents.length ?? 0,
      render: (props) => <DefaultSubagentManagerView {...props} />,
    }),
    registry.registerView({
      id: 'swarm',
      owner: 'core.agy-workbench',
      title: 'Swarm Studio',
      shortTitle: 'Swarm',
      description: 'Coordinator、已确认 Workers 与 Swarm Board（依上游证据开放）',
      capabilityIds: ['AGY-W04', 'AGY-W05'],
      order: 900,
      badgeCount: (proj) => proj?.workflows.filter((w) => w.detail.kind === 'swarm').length ?? 0,
      render: (props) => (
        <DefaultWorkflowDegradedView
          kind="swarm"
          title="Swarm Studio"
          capabilityIds={['AGY-W04', 'AGY-W05']}
          officialEntryHint="在官方 CLI 中运行 /swarm <task> 或 /swarm board。"
          officialDocUrl="https://antigravity.google/docs/swarm/"
          props={props}
        />
      ),
    }),
    registry.registerView({
      id: 'boost',
      owner: 'core.agy-workbench',
      title: 'Boost Studio',
      shortTitle: 'Boost',
      description: '实现、挑战、修复与验证阶段追踪（仅凭阶段证据渲染）',
      capabilityIds: ['AGY-W06'],
      order: 900,
      badgeCount: (proj) => proj?.workflows.filter((w) => w.detail.kind === 'boost').length ?? 0,
      render: (props) => (
        <DefaultWorkflowDegradedView
          kind="boost"
          title="Boost Studio"
          capabilityIds={['AGY-W06']}
          officialEntryHint="在官方 App/CLI 中运行 /boost <task>。"
          officialDocUrl="https://antigravity.google/docs/boost/"
          props={props}
        />
      ),
    }),
    registry.registerView({
      id: 'teamwork',
      owner: 'core.agy-workbench',
      title: 'Teamwork Studio',
      shortTitle: 'Teamwork',
      description: '访谈、Prompt Artifact 审阅与项目里程碑',
      capabilityIds: ['AGY-W07'],
      order: 900,
      preferredLayout: 'full',
      badgeCount: (proj) => proj?.workflows.filter((w) => w.detail.kind === 'teamwork').length ?? 0,
      render: (props) => (
        <DefaultWorkflowDegradedView
          kind="teamwork"
          title="Teamwork Studio"
          capabilityIds={['AGY-W07']}
          officialEntryHint="在官方 App/CLI 中运行 /teamwork <goal>。"
          officialDocUrl="https://antigravity.google/docs/teamwork/"
          props={props}
        />
      ),
    }),
    registry.registerView({
      id: 'dynamic',
      owner: 'core.agy-workbench',
      title: 'Dynamic Workflows',
      shortTitle: 'Workflows',
      description: '脚本预览、权限批准与 phase/edge 时间线',
      capabilityIds: ['AGY-W08'],
      order: 900,
      badgeCount: (proj) => proj?.workflows.filter((w) => w.detail.kind === 'dynamic').length ?? 0,
      render: (props) => (
        <DefaultWorkflowDegradedView
          kind="dynamic"
          title="Dynamic Workflow Studio"
          capabilityIds={['AGY-W08']}
          officialEntryHint="在官方 App/CLI 中运行 /run-workflow <task>。"
          officialDocUrl="https://antigravity.google/docs/dynamic-workflows/"
          props={props}
        />
      ),
    }),
    registry.registerView({
      id: 'tasks',
      owner: 'core.agy-workbench',
      title: 'Native Tasks · Goal & Schedule',
      shortTitle: 'Native Tasks',
      description: 'Goal 目标验证与 Schedule 定时唤醒记录（App Automations 另列）',
      capabilityIds: ['AGY-W09', 'AGY-W10', 'AGY-W11'],
      order: 900,
      badgeCount: (proj) =>
        proj?.workflows.filter((w) => w.detail.kind === 'goal' || w.detail.kind === 'schedule')
          .length ?? 0,
      render: (props) => (
        <div className="space-y-3" data-testid="workbench-tasks-view">
          <DefaultWorkflowDegradedView
            kind="goal"
            title="Goal 推进"
            capabilityIds={['AGY-W09']}
            officialEntryHint="在官方 CLI 中使用 /goal <objective>。"
            officialDocUrl="https://antigravity.google/docs/commands/goal/"
            props={props}
          />
          <DefaultWorkflowDegradedView
            kind="schedule"
            title="Schedule 定时唤醒"
            capabilityIds={['AGY-W10']}
            officialEntryHint="在官方 CLI 中使用 /schedule <when> <task>；跨会话持久 Automations 请在官方 App 管理。"
            officialDocUrl="https://antigravity.google/docs/commands/schedule/"
            props={props}
          />
        </div>
      ),
    }),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}

// Register default views once on module load so the Workbench always has honest fallbacks
let defaultViewsRegistered = false;
export function ensureDefaultWorkbenchViewsRegistered(): void {
  if (defaultViewsRegistered) return;
  defaultViewsRegistered = true;
  registerDefaultWorkbenchViews(agyWorkbenchRegistry);
}

function surfaceIcon(id: WorkbenchSurfaceId) {
  switch (id) {
    case 'runtime':
      return <ActivityIcon size={12.5} aria-hidden="true" />;
    case 'subagents':
      return <Bot size={12.5} aria-hidden="true" />;
    case 'swarm':
      return <Users size={12.5} aria-hidden="true" />;
    case 'boost':
      return <Sparkles size={12.5} aria-hidden="true" />;
    case 'teamwork':
      return <Layers size={12.5} aria-hidden="true" />;
    case 'dynamic':
      return <Workflow size={12.5} aria-hidden="true" />;
    case 'tasks':
      return <CalendarClock size={12.5} aria-hidden="true" />;
  }
}

export interface AgyWorkbenchShellProps extends NativeWorkbenchViewProps {
  registry?: AgyWorkbenchRegistry;
  /** Element to return keyboard focus to when closing the Workbench or narrow sheet. */
  returnFocusToRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Shared AGY Native Workbench Shell (09_Frontend_Design.md).
 * - Renders registered domain Studios via stable `NativeWorkbenchViewProps`.
 * - Supports full-width expansion, split-pane layout, and 480px narrow-viewport modal sheet.
 * - Handles keyboard tab navigation (ArrowLeft/ArrowRight) and Escape close with focus restoration.
 * - Switching views NEVER stops AGY execution.
 */
export function AgyWorkbenchShell({
  registry = agyWorkbenchRegistry,
  returnFocusToRef,
  ...viewProps
}: AgyWorkbenchShellProps) {
  ensureDefaultWorkbenchViewsRegistered();
  const views = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const shellRef = useRef<HTMLElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Partial<Record<WorkbenchSurfaceId, HTMLButtonElement | null>>>({});
  const pendingTabFocusRef = useRef<WorkbenchSurfaceId | null>(null);

  const activeSurface: WorkbenchSurfaceId =
    viewProps.route.surface === 'chat' ? 'runtime' : viewProps.route.surface;
  const activeView = views.find((v) => v.id === activeSurface) ?? views[0] ?? null;

  const handleClose = useCallback(() => {
    viewProps.onBackToChat();
    if (returnFocusToRef?.current) {
      queueMicrotask(() => {
        if (returnFocusToRef.current?.isConnected) {
          returnFocusToRef.current.focus();
        }
      });
    }
  }, [viewProps.onBackToChat, returnFocusToRef]);

  // Narrow-viewport modal sheet: enter focus on open, trap Tab/Shift+Tab, and keep focus inside dialog
  useEffect(() => {
    if (!viewProps.isNarrowViewport) return;
    const container = shellRef.current;
    focusFirstInContainer(container, closeBtnRef.current);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        handleDialogTabTrap(e, shellRef.current, document.activeElement);
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      const dlg = shellRef.current;
      if (!dlg) return;
      const target = e.target as Node | null;
      if (target && !dlg.contains(target)) {
        focusFirstInContainer(dlg, closeBtnRef.current);
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [viewProps.isNarrowViewport]);

  // Escape closes Workbench (unless consumed by IME, nested listbox/menu, or external modal)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!shouldWorkbenchHandleEscape(e, shellRef.current)) return;
      e.preventDefault();
      handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleClose]);

  // Ensure keyboard-selected tab receives DOM focus after controlled route update commits
  useEffect(() => {
    if (pendingTabFocusRef.current === activeSurface) {
      pendingTabFocusRef.current = null;
      tabRefs.current[activeSurface]?.focus();
    }
  }, [activeSurface]);

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (views.length === 0) return;
    const idx = views.findIndex((v) => v.id === activeSurface);
    const nextIdx = computeNextTabIndex(e.key, idx, views.length);
    if (nextIdx === null) return;
    e.preventDefault();
    const target = views[nextIdx]!;
    pendingTabFocusRef.current = target.id;
    viewProps.onNavigate({ surface: target.id });
    tabRefs.current[target.id]?.focus();
  };

  const shellContent = (
    <section
      ref={shellRef}
      tabIndex={viewProps.isNarrowViewport ? -1 : undefined}
      data-testid="agy-workbench-shell"
      data-layout-mode={viewProps.isNarrowViewport ? 'narrow_sheet' : viewProps.route.layout}
      data-active-surface={activeSurface}
      role={viewProps.isNarrowViewport ? 'dialog' : 'region'}
      aria-modal={viewProps.isNarrowViewport ? true : undefined}
      aria-label="AGY 原生工作台"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden focus:outline-none"
      style={{
        backgroundColor: 'var(--bg-rail)',
        borderLeft: viewProps.isNarrowViewport ? 'none' : '1px solid var(--border-hairline)',
      }}
    >
      {/* Top Workbench Header */}
      <header
        className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          >
            <ArrowLeft size={12} aria-hidden="true" />
            <span>返回聊天</span>
          </button>
          <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {activeView?.title ?? 'AGY 工作台'}
          </span>
          {viewProps.projection && (
            <EntityStatusBadge kind="runtime" status={viewProps.projection.status} compact />
          )}
          {viewProps.pendingApprovals.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-star-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--accent-star)]">
              <ShieldAlert size={10.5} aria-hidden="true" />
              <span>{viewProps.pendingApprovals.length} 待操作</span>
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="刷新原生工作台快照"
            onClick={viewProps.onRefresh}
            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
          {!viewProps.isNarrowViewport && (
            <button
              type="button"
              aria-label={viewProps.route.layout === 'full' ? '切换为分栏视图' : '扩展为全宽工作台'}
              aria-pressed={viewProps.route.layout === 'full'}
              onClick={() =>
                viewProps.onNavigate({
                  layout: viewProps.route.layout === 'full' ? 'split' : 'full',
                })
              }
              className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            >
              {viewProps.route.layout === 'full' ? (
                <Minimize2 size={13} aria-hidden="true" />
              ) : (
                <Maximize2 size={13} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="关闭 AGY 工作台"
            onClick={handleClose}
            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Surface Navigation Tab Strip */}
      <div
        role="tablist"
        aria-label="AGY 领域工作台视图"
        onKeyDown={handleTabKeyDown}
        className="flex items-center gap-1 overflow-x-auto px-3 py-2"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        {views.map((view) => {
          const selected = view.id === activeSurface;
          const badge = view.badgeCount?.(viewProps.projection, viewProps.pendingApprovals) ?? 0;
          return (
            <button
              key={view.id}
              ref={(el) => {
                tabRefs.current[view.id] = el;
              }}
              id={`agy-wb-tab-${view.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`agy-wb-panel-${view.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => viewProps.onNavigate({ surface: view.id })}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
              style={{
                backgroundColor: selected ? 'var(--bg-active)' : 'transparent',
                borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                color: selected ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              }}
            >
              {surfaceIcon(view.id)}
              <span>{view.shortTitle}</span>
              {badge > 0 && (
                <span className="rounded-full bg-[var(--bg-surface)] px-1.5 py-0.2 font-mono-code text-[10px] text-[var(--text-primary)]">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active Studio Body */}
      <div
        id={`agy-wb-panel-${activeSurface}`}
        role="tabpanel"
        aria-labelledby={`agy-wb-tab-${activeSurface}`}
        className="min-h-0 flex-1 overflow-y-auto p-3.5"
      >
        {activeView ? (
          activeView.render(viewProps)
        ) : (
          <div className="p-4 text-[12px] text-[var(--text-muted)]">未注册任何 AGY 工作台视图。</div>
        )}
      </div>
    </section>
  );

  if (viewProps.isNarrowViewport) {
    return (
      <div
        data-testid="agy-workbench-narrow-backdrop"
        className="fixed inset-0 z-40 flex flex-col"
        style={{ backgroundColor: 'rgba(6, 8, 16, 0.72)', backdropFilter: 'blur(6px)' }}
      >
        {shellContent}
      </div>
    );
  }

  return shellContent;
}
