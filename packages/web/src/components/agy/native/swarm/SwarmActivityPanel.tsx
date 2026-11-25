import { Loader2, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Activity,
  EvidenceSourceKind,
  NativeWorkflowResourcePageResponse,
  WorkflowId,
} from '../../../../lib/native-client';
import {
  ACTIVITY_ORIGIN_LABELS,
  EMPTY_STATE_COPY,
  EVIDENCE_SOURCE_LABELS,
  EntityStatusBadge,
} from '../shared';
import {
  filterEntriesBySource,
  parseSwarmLogEntries,
  type SwarmLogEntryDto,
  type SwarmWorkflowEntity,
} from './swarm-view-model';

export interface SwarmActivityPanelProps {
  workflow: SwarmWorkflowEntity;
  bindingKey: string;
  activities: readonly Activity[];
  loadWorkflowResource?: (
    workflowId: WorkflowId,
    resource: string,
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeWorkflowResourcePageResponse>;
}

interface TraceFetchState {
  scopeKey: string;
  entries: SwarmLogEntryDto[];
  loading: boolean;
  nextPageToken: string | null;
  hasMore: boolean;
  sourceUnavailableReason?: string;
}

const SOURCE_FILTERS: ReadonlyArray<{ readonly key: 'all' | EvidenceSourceKind; readonly label: string }> = [
  { key: 'all', label: '全部来源' },
  { key: 'live_protocol', label: 'Live ACP' },
  { key: 'host_observation', label: '宿主观测' },
  { key: 'native_snapshot', label: '只读快照' },
  { key: 'replay', label: '回放样本' },
];

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

/**
 * NP-08 Swarm Activity & Coordinator Trace Panel.
 *
 * - Displays Swarm activities AND paginated Coordinator trace entries (`resource: 'logs'`)
 *   filterable by provenance source (`live_protocol`, `host_observation`, `native_snapshot`, `replay`).
 * - Remains readable even when Board feed is `upstream_limited` or Board/Swarm gates are turned off.
 */
export function SwarmActivityPanel({
  workflow,
  bindingKey,
  activities,
  loadWorkflowResource,
}: SwarmActivityPanelProps) {
  const [sourceFilter, setSourceFilter] = useState<'all' | EvidenceSourceKind>('all');
  const scopeKey = `${bindingKey}:${workflow.id}:logs`;
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<TraceFetchState>({
    scopeKey,
    entries: [],
    loading: false,
    nextPageToken: null,
    hasMore: false,
  });

  useEffect(() => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

    if (!loadWorkflowResource) {
      setState({
        scopeKey,
        entries: [],
        loading: false,
        nextPageToken: null,
        hasMore: false,
      });
      return;
    }

    const requestScope = scopeKey;
    const controller = new AbortController();
    setState({
      scopeKey: requestScope,
      entries: [],
      loading: true,
      nextPageToken: null,
      hasMore: false,
    });

    void loadWorkflowResource(workflow.id, 'logs', null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState({
          scopeKey: requestScope,
          entries: parseSwarmLogEntries(page),
          loading: false,
          nextPageToken: page.nextPageToken,
          hasMore: page.hasMore,
          sourceUnavailableReason: page.sourceUnavailableReason,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState({
          scopeKey: requestScope,
          entries: [],
          loading: false,
          nextPageToken: null,
          hasMore: false,
          sourceUnavailableReason: 'coordinator_trace_read_failed',
        });
      });

    return () => {
      controller.abort();
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [scopeKey, loadWorkflowResource, workflow.id]);

  const handleLoadMore = useCallback(() => {
    if (!loadWorkflowResource || !state.nextPageToken || state.loading || state.scopeKey !== scopeKey) {
      return;
    }
    const requestScope = scopeKey;
    const token = state.nextPageToken;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setState((prev) => (prev.scopeKey === requestScope ? { ...prev, loading: true } : prev));
    void loadWorkflowResource(workflow.id, 'logs', token, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState((prev) => {
          if (prev.scopeKey !== requestScope) return prev;
          return {
            ...prev,
            entries: parseSwarmLogEntries(page, prev.entries),
            loading: false,
            nextPageToken: page.nextPageToken,
            hasMore: page.hasMore,
          };
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState((prev) => (prev.scopeKey === requestScope ? { ...prev, loading: false } : prev));
      });
  }, [loadWorkflowResource, state.nextPageToken, state.loading, state.scopeKey, scopeKey, workflow.id]);

  const matchesScope = state.scopeKey === scopeKey;
  const traceEntries = matchesScope ? state.entries : [];
  const loading = matchesScope ? state.loading : Boolean(loadWorkflowResource);

  const filteredActivities = useMemo(
    () => filterEntriesBySource(activities, sourceFilter),
    [activities, sourceFilter],
  );
  const filteredTraces = useMemo(
    () => filterEntriesBySource(traceEntries, sourceFilter),
    [traceEntries, sourceFilter],
  );

  return (
    <div className="space-y-3" data-testid="np08-activity-panel">
      {/* Source Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <ScrollText size={12} aria-hidden="true" />
          <span>按来源筛选轨迹</span>
        </span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="按来源筛选 Swarm 活动">
          {SOURCE_FILTERS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              aria-pressed={sourceFilter === opt.key}
              onClick={() => setSourceFilter(opt.key)}
              className="cursor-pointer rounded-lg border px-2 py-0.5 text-[10.5px]"
              style={{
                backgroundColor: sourceFilter === opt.key ? 'var(--bg-active)' : 'var(--bg-surface)',
                borderColor: sourceFilter === opt.key ? 'var(--border-focus)' : 'var(--border-hairline)',
                color: sourceFilter === opt.key ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Associated Native Activities */}
      <section className="space-y-1.5" aria-label="关联原生活动">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          关联原生活动 ({filteredActivities.length})
        </h4>
        {filteredActivities.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11px] text-[var(--text-muted)]">
            {EMPTY_STATE_COPY.noActivityObserved}
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredActivities.map((act) => (
              <div
                key={act.id}
                data-testid="np08-activity-row"
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-2 text-[11.5px]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-[var(--text-primary)]">
                      {ACTIVITY_ORIGIN_LABELS[act.origin]}
                    </span>
                    <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                      {act.id}
                    </span>
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-muted)]">
                      {act.evidence ? EVIDENCE_SOURCE_LABELS[act.evidence.sourceKind] : '来源未知'}
                    </span>
                  </div>
                  {act.summary && (
                    <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{act.summary}</p>
                  )}
                </div>
                <EntityStatusBadge kind="activity" status={act.state} compact />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Coordinator Trajectory (Preserved even when Board feed is unavailable or gated) */}
      <section className="space-y-1.5" aria-label="Coordinator 观测轨迹">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Coordinator 轨迹 ({filteredTraces.length})
          </h4>
          {loading && <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" aria-hidden="true" />}
        </div>

        {filteredTraces.length === 0 && !loading ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11px] text-[var(--text-muted)]">
            <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
            <p className="mt-0.5 text-[10.5px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
          </div>
        ) : (
          <div className="space-y-1.5" data-testid="np08-coordinator-trace-list">
            {filteredTraces.map((entry) => (
              <article
                key={entry.entryId}
                data-testid="np08-coordinator-trace-item"
                className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-2 text-[11.5px]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono-code">#{entry.seq}</span>
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-secondary)]">
                      {EVIDENCE_SOURCE_LABELS[entry.evidence.sourceKind]}
                    </span>
                    {entry.level !== 'info' && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[9.5px] font-medium"
                        style={{
                          color: entry.level === 'error' ? 'var(--accent-rose)' : 'var(--accent-star)',
                          backgroundColor:
                            entry.level === 'error' ? 'var(--accent-rose-soft)' : 'var(--accent-star-soft)',
                        }}
                      >
                        {entry.level.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span className="font-mono-code">{formatTime(entry.createdAt)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                  {entry.summary}
                </p>
              </article>
            ))}

            {matchesScope && state.hasMore && state.nextPageToken && (
              <div className="text-center">
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleLoadMore}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                >
                  <span>加载更多 Coordinator 轨迹</span>
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
