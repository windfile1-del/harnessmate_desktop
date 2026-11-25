import { Cpu, Layers, Server, Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coalesceTimelineEntries,
  type NativeTimelineEntry,
  type NativeWork,
} from '../../../../lib/native-client';
import {
  ACTIVITY_ORIGIN_LABELS,
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EntityStatusBadge,
  EvidenceDetails,
  NativeRequestCard,
  NativeTimeline,
  WORK_KIND_LABELS,
  toneStyle,
  type NativeWorkbenchViewProps,
} from '../shared';
import { RuntimeStatusBanner } from './RuntimeStatusBanner';
import { RuntimeStopPanel } from './RuntimeStopPanel';
import {
  deriveRuntimeBannerModel,
  deriveStopTargetCandidates,
  formatHonestWorkOutcome,
} from './runtime-view-model';

type WorkFilterKey = 'all' | 'finite_command' | 'daemon' | 'schedule' | 'unknown';

interface TimelineViewState {
  scopeKey: string;
  entries: NativeTimelineEntry[];
  loading: boolean;
  nextPageToken: string | null;
  sourceUnavailable: boolean;
  sourceUnavailableReason?: string;
}

function useRuntimeActivityTimeline(
  activityId: string | null,
  bindingKey: string | null,
  loadTimeline?: NativeWorkbenchViewProps['loadTimeline'],
) {
  const scopeKey = activityId && bindingKey ? `${bindingKey}:activity:${activityId}` : '';
  const activeKeyRef = useRef(scopeKey);
  activeKeyRef.current = scopeKey;
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<TimelineViewState>({
    scopeKey,
    entries: [],
    loading: false,
    nextPageToken: null,
    sourceUnavailable: false,
  });

  useEffect(() => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

    if (!activityId || !bindingKey || !loadTimeline) {
      setState({
        scopeKey,
        entries: [],
        loading: false,
        nextPageToken: null,
        sourceUnavailable: false,
      });
      return;
    }

    const reqKey = scopeKey;
    const controller = new AbortController();
    setState({
      scopeKey: reqKey,
      entries: [],
      loading: true,
      nextPageToken: null,
      sourceUnavailable: false,
    });

    void loadTimeline({ kind: 'activity', id: activityId }, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
        setState({
          scopeKey: reqKey,
          entries: coalesceTimelineEntries([], page.items),
          loading: false,
          nextPageToken: page.nextPageToken,
          sourceUnavailable: Boolean(page.sourceUnavailableReason),
          sourceUnavailableReason: page.sourceUnavailableReason,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
        setState({
          scopeKey: reqKey,
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
  }, [activityId, bindingKey, scopeKey, loadTimeline]);

  const loadMore = useCallback(() => {
    if (!activityId || !bindingKey || !loadTimeline) return;
    if (state.scopeKey !== scopeKey || !state.nextPageToken || state.loading) return;
    const reqKey = scopeKey;
    const token = state.nextPageToken;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: true } : prev));
    void loadTimeline({ kind: 'activity', id: activityId }, token, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
        setState((prev) =>
          prev.scopeKey === reqKey
            ? {
                ...prev,
                entries: coalesceTimelineEntries(prev.entries, page.items),
                nextPageToken: page.nextPageToken,
                loading: false,
              }
            : prev,
        );
      })
      .catch(() => {
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
        setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: false } : prev));
      });
  }, [activityId, bindingKey, loadTimeline, state.scopeKey, state.nextPageToken, state.loading, scopeKey]);

  const matches = state.scopeKey === scopeKey;
  return {
    entries: matches ? state.entries : [],
    loading: matches ? state.loading : Boolean(activityId && bindingKey && loadTimeline),
    hasMore: matches && Boolean(state.nextPageToken),
    sourceUnavailable: matches && state.sourceUnavailable,
    sourceUnavailableReason: matches ? state.sourceUnavailableReason : undefined,
    loadMore: matches && state.nextPageToken ? loadMore : undefined,
  };
}

function WorkKindPill({ work }: { work: NativeWork }) {
  if (work.kind === 'finite_command') {
    return (
      <span
        data-testid={`np04-work-kind-finite-${work.id}`}
        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold"
        style={{
          backgroundColor: 'var(--accent-star-soft)',
          color: 'var(--accent-star)',
          borderColor: 'color-mix(in srgb, var(--accent-star) 35%, transparent)',
        }}
      >
        <Terminal size={10} aria-hidden="true" />
        <span>有限命令</span>
      </span>
    );
  }
  if (work.kind === 'daemon') {
    return (
      <span
        data-testid={`np04-work-kind-daemon-${work.id}`}
        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold"
        style={{
          backgroundColor: 'var(--accent-indigo-soft)',
          color: 'var(--accent-indigo)',
          borderColor: 'color-mix(in srgb, var(--accent-indigo) 35%, transparent)',
        }}
      >
        <Server size={10} aria-hidden="true" />
        <span>常驻 Daemon</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
      <Cpu size={10} aria-hidden="true" />
      <span>{WORK_KIND_LABELS[work.kind]}</span>
    </span>
  );
}

/**
 * NP-04 Domain Workbench View for Native Runtime & Background Keep-Alive (`surface: 'runtime'`).
 *
 * Overrides NP-03's built-in order=900 degraded shell via `agyWorkbenchRegistry.registerView`
 * with zero edits to `ChatStage.tsx`, `AgyWorkbenchShell.tsx`, or `app-store.ts`.
 */
export function AgyNativeRuntimeCenter({
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
  const [workFilter, setWorkFilter] = useState<WorkFilterKey>('all');

  const activities = projection?.activities ?? [];
  const workItems = projection?.work ?? [];

  const filteredWork = useMemo(() => {
    if (workFilter === 'all') return workItems;
    if (workFilter === 'unknown') {
      return workItems.filter(
        (w) => w.kind === 'unknown' || w.state.kind === 'unknown' || w.state.kind === 'stale',
      );
    }
    return workItems.filter((w) => w.kind === workFilter);
  }, [workItems, workFilter]);

  const selectedWork =
    filteredWork.find((w) => w.id === route.selectedWorkId) ?? filteredWork[0] ?? null;
  const selectedActivity =
    activities.find((a) => a.id === route.selectedActivityId) ?? activities[0] ?? null;

  const bindingKey = projection
    ? `${projection.binding.runtimeId}:${projection.binding.generation}`
    : null;
  const timeline = useRuntimeActivityTimeline(
    selectedActivity?.id ?? null,
    bindingKey,
    loadTimeline,
  );

  if (!projection) {
    return (
      <CapabilityUnavailable
        title="原生运行时尚未连接"
        gate="unknown"
        capabilityId="AGY-R03"
        reason="当前会话尚未收到原生运行时快照（或 native runtime 门控未开启）。现有聊天与传统回合流不受影响。"
        officialEntryHint="在官方 CLI 中使用 /tasks 查看后台命令与状态。"
        officialDocUrl="https://antigravity.google/docs/cli/reference/"
        onRefresh={onRefresh}
      />
    );
  }

  const banner = deriveRuntimeBannerModel(projection, syncState, pendingApprovals);
  const stopCandidates = deriveStopTargetCandidates(projection, selectedWork, selectedActivity);
  const receiptsList = Object.values(projection.receipts ?? {});

  return (
    <div className="space-y-4" data-testid="np04-native-runtime-center">
      {/* 1. Top Waiting / Requires User / Reconnecting Status Banner */}
      <RuntimeStatusBanner
        runtimeStatus={projection.status}
        banner={banner}
        onRefresh={onRefresh}
      />

      {/* 2. Pending User Requests & Read-Only Receipts */}
      {(pendingApprovals.length > 0 || receiptsList.length > 0) && (
        <section className="space-y-2" aria-label="原生待处理请求与收据">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            需要用户确认 ({pendingApprovals.length} 待处理 · {receiptsList.length} 收据)
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
            {receiptsList
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

      {/* 3. Finite Background Commands vs Detached Daemons vs Schedules / Unknown */}
      <section className="space-y-2" aria-label="有限任务与常驻 Daemon">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            有限后台 / 常驻 Daemon / 未知工作项 ({filteredWork.length})
          </h3>
          <div className="flex flex-wrap gap-1" role="group" aria-label="按工作类别筛选">
            {(
              [
                ['all', '全部'],
                ['finite_command', '有限命令'],
                ['daemon', '常驻 Daemon'],
                ['schedule', '定时'],
                ['unknown', '未确认'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={workFilter === key}
                data-testid={`np04-filter-${key}`}
                onClick={() => setWorkFilter(key)}
                className="cursor-pointer rounded-lg border px-2 py-0.5 text-[10.5px]"
                style={{
                  backgroundColor: workFilter === key ? 'var(--bg-active)' : 'var(--bg-surface)',
                  borderColor: workFilter === key ? 'var(--border-focus)' : 'var(--border-hairline)',
                  color: workFilter === key ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                }}
              >
                {label}
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
              const isSelected = selectedWork?.id === work.id;
              const honestOutcome = formatHonestWorkOutcome(work);
              const outcomeTone = toneStyle(honestOutcome.tone);
              return (
                <button
                  key={work.id}
                  type="button"
                  data-testid={`np04-work-row-${work.id}`}
                  onClick={() => onNavigate({ selectedWorkId: work.id })}
                  className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-xl border p-2.5 text-left text-[11.5px] transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    backgroundColor: isSelected ? 'var(--bg-active)' : 'var(--bg-surface)',
                    borderColor: isSelected ? 'var(--border-focus)' : 'var(--border-hairline)',
                  }}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <WorkKindPill work={work} />
                      <span className="truncate font-medium text-[var(--text-primary)]">
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
                    <span
                      data-testid={`np04-work-outcome-${work.id}`}
                      className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        color: outcomeTone.color,
                        backgroundColor: outcomeTone.backgroundColor,
                        borderColor: outcomeTone.borderColor,
                      }}
                    >
                      {honestOutcome.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selectedWork && (
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
        )}
      </section>

      {/* 4. Stop Target / Waiting / Result Control Panel */}
      <RuntimeStopPanel
        projection={projection}
        candidates={stopCandidates}
        capabilities={capabilities}
        onDispatchControl={onDispatchControl}
      />

      {/* 5. Activities (User Turn vs Native Wake Continuation) & Paginated Timeline */}
      <section className="space-y-2" aria-label="原生活动与唤醒分段">
        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <Layers size={12} aria-hidden="true" />
          <span>活动与原生唤醒分段 ({activities.length})</span>
        </div>

        {activities.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]">
            {EMPTY_STATE_COPY.noActivityObserved}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {activities.map((act) => {
              const isSelected = selectedActivity?.id === act.id;
              return (
                <button
                  key={act.id}
                  type="button"
                  data-testid={`np04-activity-pill-${act.id}`}
                  onClick={() => onNavigate({ selectedActivityId: act.id })}
                  className="inline-flex cursor-pointer flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
                  style={{
                    backgroundColor: isSelected ? 'var(--bg-active)' : 'var(--bg-surface)',
                    borderColor: isSelected ? 'var(--border-focus)' : 'var(--border-hairline)',
                  }}
                >
                  <span className="font-medium text-[var(--text-primary)]">
                    {ACTIVITY_ORIGIN_LABELS[act.origin]}
                  </span>
                  <span className="font-mono-code text-[9.5px] text-[var(--text-muted)]">
                    {act.turnId ? `turn:${act.turnId}` : 'native-only'}
                  </span>
                  {act.priorActivityId && (
                    <span className="font-mono-code text-[9.5px] text-[var(--text-muted)]">
                      ← {act.priorActivityId}
                    </span>
                  )}
                  <EntityStatusBadge kind="activity" status={act.state} compact />
                </button>
              );
            })}
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
