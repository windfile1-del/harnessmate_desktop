import {
  Activity as ActivityIcon,
  ArrowLeft,
  LayoutDashboard,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NativeAgentId, WorkflowId } from '../../../../lib/native-client';
import {
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EntityStatusBadge,
  EvidenceDetails,
  NativeControlMenu,
  NativeRequestCard,
  computeNextTabIndex,
  type NativeWorkbenchViewProps,
} from '../shared';
import { SwarmActivityPanel } from './SwarmActivityPanel';
import { SwarmBoardPanel } from './SwarmBoardPanel';
import { SwarmWorkersPanel } from './SwarmWorkersPanel';
import {
  SWARM_OFFICIAL_CLI_BOARD_HINT,
  SWARM_OFFICIAL_CLI_LAUNCH_HINT,
  SWARM_OFFICIAL_DOC_URL,
  buildSwarmStudioViewModel,
  resolveSafeSwarmControlCapability,
  type SwarmStudioTab,
} from './swarm-view-model';

export interface SwarmStudioViewProps extends NativeWorkbenchViewProps {
  /** Optional initial tab for deterministic testing or deep-links (defaults to `'overview'`). */
  initialTab?: SwarmStudioTab;
}

const SWARM_TABS: ReadonlyArray<{ readonly id: SwarmStudioTab; readonly label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'workers', label: 'Workers' },
  { id: 'board', label: 'Board' },
  { id: 'activity', label: 'Activity' },
];

function StatTile({
  label,
  value,
  toneColor,
  hint,
}: {
  label: string;
  value: string | number;
  toneColor?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div
        className="mt-0.5 font-mono-code text-[14px] font-semibold"
        style={{ color: toneColor ?? 'var(--text-primary)' }}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[9.5px] text-[var(--text-muted)]">{hint}</div>}
    </div>
  );
}

/**
 * NP-08 Swarm Studio Workbench View.
 *
 * Implements 09_Frontend_Design.md & NP-08 requirements:
 * - Four explicit tabs: Overview, Workers, Board, Activity with provenance & unknown states.
 * - Uses real AGY Swarm projection as sole source of truth (never calls HM sub-sessions "Swarm").
 * - Shows honest "当前 ACP 未提供 Board" + official `/swarm board` / `Alt+S` guidance when Board feed is missing.
 * - Workers are NEVER fabricated from tool titles; `idle`/`unknown` workers NEVER count as succeeded progress
 *   and NO fake progress bar is rendered.
 * - Links confirmed worker approvals & jumps to independent subagent timelines without moving native context.
 * - Disables control actions whenever feed/connection/identity/capability preconditions are not met.
 */
export function SwarmStudioView({
  projection,
  syncState,
  capabilities,
  pendingApprovals,
  route,
  isNarrowViewport,
  onNavigate,
  onBackToChat,
  onRefresh,
  onResolveRequest,
  onDispatchControl,
  loadWorkflowResource,
  initialTab = 'overview',
}: SwarmStudioViewProps) {
  const [activeTab, setActiveTab] = useState<SwarmStudioTab>(initialTab);

  const model = useMemo(
    () =>
      buildSwarmStudioViewModel(
        projection,
        capabilities,
        pendingApprovals,
        route.selectedWorkflowId,
      ),
    [projection, capabilities, pendingApprovals, route.selectedWorkflowId],
  );

  const confirmedAgentIds = useMemo(() => {
    const set = new Set<NativeAgentId>();
    if (model.coordinator?.isConfirmed) set.add(model.coordinator.agent.id);
    for (const w of model.workers) set.add(w.agent.id);
    for (const v of model.verifiers) set.add(v.agent.id);
    return set;
  }, [model.coordinator, model.workers, model.verifiers]);

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIdx = SWARM_TABS.findIndex((t) => t.id === activeTab);
    const nextIdx = computeNextTabIndex(e.key, currentIdx, SWARM_TABS.length);
    if (nextIdx !== null) {
      e.preventDefault();
      setActiveTab(SWARM_TABS[nextIdx]!.id);
    }
  };

  if (!projection) {
    return (
      <div className="space-y-3" data-testid="np08-swarm-studio" data-swarm-empty="no_projection">
        <CapabilityUnavailable
          title="Swarm Studio 暂无原生投影"
          gate="unknown"
          capabilityId="AGY-W04"
          reason="当前会话尚未接收到原生运行时投影（或 native runtime 门控关闭）。不会将多个 HarnessMate 子会话伪装为原生 Swarm。"
          officialEntryHint={`${SWARM_OFFICIAL_CLI_LAUNCH_HINT} ${SWARM_OFFICIAL_CLI_BOARD_HINT}`}
          officialDocUrl={SWARM_OFFICIAL_DOC_URL}
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主 Agent 聊天"
        />
      </div>
    );
  }

  const wf = model.selectedWorkflow;
  const bindingKey = `${projection.binding.runtimeId}:${projection.binding.generation}`;

  if (!wf) {
    return (
      <div className="space-y-3" data-testid="np08-swarm-studio" data-swarm-empty="no_workflow">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBackToChat}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <ArrowLeft size={12} aria-hidden="true" />
            <span>返回主 Agent 聊天</span>
          </button>
          <EntityStatusBadge kind="runtime" status={projection.status} compact />
        </div>

        <CapabilityUnavailable
          title="尚未观察到原生 Swarm 工作流"
          gate={model.swarmCapability?.observe ?? 'upstream_limited'}
          capabilityId="AGY-W04"
          reason={`${EMPTY_STATE_COPY.noActivityObserved}。${EMPTY_STATE_COPY.emptyListNotStopped} 仅以真实 AGY /swarm 执行作为唯一来源，不本地编排或虚构 Swarm。`}
          officialEntryHint={`${SWARM_OFFICIAL_CLI_LAUNCH_HINT} ${SWARM_OFFICIAL_CLI_BOARD_HINT}`}
          officialDocUrl={SWARM_OFFICIAL_DOC_URL}
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天观察原始流"
        />
      </div>
    );
  }

  const safeWorkflowControl = resolveSafeSwarmControlCapability({
    runtimeStatus: projection.status,
    targetConfirmed: true,
    targetEvidence: model.workflowProvenance,
    capabilities,
    targetKind: 'workflow',
  });

  const handleJumpToWorker = (agentId: NativeAgentId) => {
    setActiveTab('workers');
    onNavigate({ selectedAgentId: agentId });
  };

  const handleJumpToSubagent = (agentId: NativeAgentId) => {
    onNavigate({ surface: 'subagents', selectedAgentId: agentId });
  };

  return (
    <div
      className="space-y-3"
      data-testid="np08-swarm-studio"
      data-workflow-id={wf.id}
      data-board-status={model.boardStatus.status}
    >
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="np08-back-to-chat"
            onClick={onBackToChat}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <ArrowLeft size={12} aria-hidden="true" />
            <span>返回主聊天</span>
          </button>

          {model.workflows.length > 1 && (
            <select
              aria-label="选择 Swarm 工作流"
              value={wf.id}
              onChange={(e) => onNavigate({ selectedWorkflowId: e.target.value as WorkflowId })}
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 font-mono-code text-[11px] text-[var(--text-primary)]"
            >
              {model.workflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <EntityStatusBadge kind="runtime" status={projection.status} compact />
          <EntityStatusBadge kind="work" observed={wf.state} compact />
          <button
            type="button"
            onClick={onRefresh}
            aria-label="刷新 Swarm 状态"
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <RefreshCw size={11} aria-hidden="true" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* Sync / Disconnect Banners */}
      {syncState?.phase === 'incomplete' && (
        <CapabilityUnavailable
          title="Swarm 投影未完成同步"
          gate="unknown"
          capabilityId="AGY-S03"
          reason={
            syncState.lastError ??
            '事件补缺未完成，当前 Swarm 状态可能滞后，已禁止依据不完整数据推断进度。'
          }
          onRefresh={onRefresh}
        />
      )}

      {projection.status !== 'attached' && (
        <CapabilityUnavailable
          title={projection.status === 'reconciling' ? 'Swarm 状态校准中' : '观测连接已断开'}
          gate={projection.status === 'reconciling' ? 'unknown' : 'unsupported'}
          capabilityId="AGY-S03"
          reason="连接未附着，无法确认原生 Swarm 是否已停止；保留只读轨迹与最后观测，所有控制动作已禁用。"
          onRefresh={onRefresh}
        />
      )}

      {/* Four Studio Tabs: Overview | Workers | Board | Activity */}
      <div
        role="tablist"
        aria-label="Swarm Studio 分区"
        onKeyDown={handleTabKeyDown}
        className="flex flex-wrap gap-1 border-b border-[var(--border-hairline)] pb-2"
      >
        {SWARM_TABS.map((tab) => {
          const isSelected = activeTab === tab.id;
          const badge =
            tab.id === 'workers'
              ? model.counts.totalConfirmedMembers
              : tab.id === 'activity'
                ? model.activities.length
                : null;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-testid={`np08-tab-${tab.id}`}
              aria-selected={isSelected}
              onClick={() => setActiveTab(tab.id)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors"
              style={{
                backgroundColor: isSelected ? 'var(--bg-active)' : 'var(--bg-surface)',
                borderColor: isSelected ? 'var(--border-focus)' : 'var(--border-hairline)',
                color: isSelected ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              }}
            >
              {tab.id === 'overview' && <LayoutDashboard size={12} aria-hidden="true" />}
              {tab.id === 'workers' && <Users size={12} aria-hidden="true" />}
              {tab.id === 'board' && <MessageSquare size={12} aria-hidden="true" />}
              {tab.id === 'activity' && <ActivityIcon size={12} aria-hidden="true" />}
              <span>{tab.label}</span>
              {badge !== null && (
                <span className="rounded-full bg-[var(--bg-elevated)] px-1.5 py-0.2 font-mono-code text-[10px] text-[var(--text-muted)]">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-3" data-testid="np08-tab-panel-overview">
          {/* Coordinator & Objective Card */}
          <section className="space-y-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    Swarm Coordinator
                  </h3>
                  <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                    {wf.id}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                  {wf.detail.objective ?? '目标待原生 Coordinator 帧确认（不从普通文本臆测）。'}
                </p>
              </div>
              <EntityStatusBadge kind="work" observed={wf.state} />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span>
                协调者 ID：
                <span className="font-mono-code text-[var(--text-secondary)]">
                  {wf.detail.coordinatorId ?? '待确认'}
                </span>
              </span>
              <span>·</span>
              <span>
                起始活动：
                <span className="font-mono-code text-[var(--text-secondary)]">
                  {wf.originActivityId}
                </span>
              </span>
            </div>
          </section>

          {/* Honest Member Counters (NO fake progress bar!) */}
          <div
            data-testid="np08-honest-counts"
            className={isNarrowViewport ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6'}
          >
            <StatTile
              label="已证实成员"
              value={model.counts.totalConfirmedMembers}
              hint={`Worker ${model.workers.length} · Verifier ${model.verifiers.length}`}
            />
            <StatTile
              label="运行中"
              value={model.counts.runningCount}
              toneColor="var(--accent-indigo)"
            />
            <StatTile
              label="空闲 (可再唤醒)"
              value={model.counts.idleCount}
              toneColor="var(--text-secondary)"
              hint="不计入成功进度"
            />
            <StatTile
              label="需操作"
              value={model.counts.requiresActionCount}
              toneColor="var(--accent-star)"
            />
            <StatTile
              label="失败"
              value={model.counts.failedCount}
              toneColor="var(--accent-rose)"
            />
            <StatTile
              label="未知 / 过期"
              value={model.counts.unknownOrStaleCount}
              toneColor="var(--accent-clay)"
            />
          </div>

          {/* Board Boundary Summary */}
          {model.boardStatus.status !== 'available' ? (
            <CapabilityUnavailable
              title={model.boardStatus.title}
              gate={model.boardStatus.status === 'upstream_limited' ? 'upstream_limited' : 'unknown'}
              capabilityId="AGY-W05"
              reason={model.boardStatus.reason}
              officialEntryHint={SWARM_OFFICIAL_CLI_BOARD_HINT}
              officialDocUrl={SWARM_OFFICIAL_DOC_URL}
              onRefresh={onRefresh}
              onReadOnlyFallback={() => setActiveTab('activity')}
              readOnlyFallbackLabel="查看 Coordinator 观测轨迹"
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[11.5px]">
              <span className="text-[var(--text-secondary)]">
                已观测到结构化 Board 源（只读），可切换至 Board 页查看线程与稳定 ID 分页帖子。
              </span>
              <button
                type="button"
                onClick={() => setActiveTab('board')}
                className="cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
              >
                打开 Board
              </button>
            </div>
          )}

          {/* Scoped Pending Approvals for Confirmed Swarm Members */}
          {(model.linkedApprovals.length > 0 || model.unconfirmedApprovalCount > 0) && (
            <section className="space-y-2" aria-label="Swarm 关联原生请求">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-star)]">
                  <ShieldAlert size={12} aria-hidden="true" />
                  <span>已确证成员待处理审批 ({model.linkedApprovals.length})</span>
                </h4>
                {model.unconfirmedApprovalCount > 0 && (
                  <span className="text-[10.5px] text-[var(--accent-clay)]">
                    另有 {model.unconfirmedApprovalCount} 条来源未确认请求未挂接到 Worker
                  </span>
                )}
              </div>
              {model.linkedApprovals.map((appr) => {
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
                    onJumpToAgent={handleJumpToSubagent}
                  />
                );
              })}
            </section>
          )}

          {/* Strictly Gated Workflow Control Menu */}
          <div className="space-y-1">
            <NativeControlMenu
              target={{ type: 'workflow', id: wf.id }}
              targetLabel={`Swarm ${wf.id}`}
              expectedRevision={wf.revision}
              binding={projection.binding}
              capability={safeWorkflowControl.capability}
              disabled={!safeWorkflowControl.capability}
              onDispatchControl={safeWorkflowControl.capability ? onDispatchControl : undefined}
            />
            {safeWorkflowControl.blockReason && (
              <p
                data-testid="np08-workflow-control-guard"
                className="text-[10.5px] text-[var(--text-muted)]"
              >
                控制门控：{safeWorkflowControl.blockReason}
              </p>
            )}
          </div>

          <EvidenceDetails
            evidence={model.workflowProvenance}
            reasonCode={wf.state.kind !== 'known' ? wf.state.reasonCode : undefined}
            evidenceRefs={['AGY-W04', 'AGY-W05']}
            label="Swarm 工作流观测证据"
          />
        </div>
      )}

      {activeTab === 'workers' && (
        <SwarmWorkersPanel
          projection={projection}
          model={model}
          capabilities={capabilities}
          selectedAgentId={route.selectedAgentId}
          onSelectAgent={(agentId) => onNavigate({ selectedAgentId: agentId })}
          onJumpToSubagent={handleJumpToSubagent}
          onResolveRequest={onResolveRequest}
          onDispatchControl={onDispatchControl}
        />
      )}

      {activeTab === 'board' && (
        <SwarmBoardPanel
          workflow={wf}
          bindingKey={bindingKey}
          boardCapability={model.boardCapability}
          confirmedAgentIds={confirmedAgentIds}
          loadWorkflowResource={loadWorkflowResource}
          onJumpToWorker={handleJumpToWorker}
          onRefresh={onRefresh}
          onBackToChat={onBackToChat}
        />
      )}

      {activeTab === 'activity' && (
        <SwarmActivityPanel
          workflow={wf}
          bindingKey={bindingKey}
          activities={model.activities}
          loadWorkflowResource={loadWorkflowResource}
        />
      )}
    </div>
  );
}
