import { FileJson, FileText, Loader2, ShieldAlert, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NativeWorkflow,
  NativeWorkflowResourcePageResponse,
  WorkflowId,
} from '../../../../lib/native-client';
import { EMPTY_STATE_COPY, EvidenceDetails } from '../shared';
import type {
  DynamicResultPreviewData,
  DynamicWorkflowResourceItemView,
} from './types';
import { normalizeWorkflowResourceItems } from './view-model';

export interface DynamicWorkflowResultsAndLogsProps {
  readonly workflow: NativeWorkflow;
  readonly bindingKey: string | null;
  readonly resultPreviewByArtifactId?: Readonly<Record<string, DynamicResultPreviewData>>;
  readonly loadWorkflowResource?: (
    workflowId: WorkflowId,
    resource: string,
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeWorkflowResourcePageResponse>;
  readonly onLogsLoaded?: (items: readonly DynamicWorkflowResourceItemView[]) => void;
}

interface ResourcePageState {
  readonly scopeKey: string;
  readonly items: readonly DynamicWorkflowResourceItemView[];
  readonly loading: boolean;
  readonly nextPageToken: string | null;
  readonly hasMore: boolean;
  readonly sourceUnavailable: boolean;
  readonly sourceUnavailableReason?: string;
}

function useScopedWorkflowResource(
  workflowId: WorkflowId,
  resource: 'logs' | 'artifacts',
  bindingKey: string | null,
  loadWorkflowResource?: DynamicWorkflowResultsAndLogsProps['loadWorkflowResource'],
) {
  const scopeKey = bindingKey ? `${bindingKey}:${workflowId}:${resource}` : '';
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<ResourcePageState>({
    scopeKey,
    items: [],
    loading: false,
    nextPageToken: null,
    hasMore: false,
    sourceUnavailable: false,
  });

  useEffect(() => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

    if (!bindingKey || !loadWorkflowResource) {
      setState({
        scopeKey,
        items: [],
        loading: false,
        nextPageToken: null,
        hasMore: false,
        sourceUnavailable: false,
      });
      return;
    }

    const reqKey = scopeKey;
    const controller = new AbortController();
    setState({
      scopeKey: reqKey,
      items: [],
      loading: true,
      nextPageToken: null,
      hasMore: false,
      sourceUnavailable: false,
    });

    void loadWorkflowResource(workflowId, resource, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeRef.current !== reqKey) return;
        const normalized = normalizeWorkflowResourceItems(page.items, workflowId);
        setState({
          scopeKey: reqKey,
          items: normalized,
          loading: false,
          nextPageToken: page.nextPageToken,
          hasMore: page.hasMore,
          sourceUnavailable: Boolean(page.sourceUnavailableReason),
          sourceUnavailableReason: page.sourceUnavailableReason,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeRef.current !== reqKey) return;
        setState({
          scopeKey: reqKey,
          items: [],
          loading: false,
          nextPageToken: null,
          hasMore: false,
          sourceUnavailable: true,
          sourceUnavailableReason: 'workflow_resource_fetch_failed',
        });
      });

    return () => {
      controller.abort();
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [workflowId, resource, bindingKey, scopeKey, loadWorkflowResource]);

  const loadMore = useCallback(() => {
    if (!bindingKey || !loadWorkflowResource) return;
    if (state.scopeKey !== scopeKey || !state.nextPageToken || state.loading) return;
    const reqKey = scopeKey;
    const token = state.nextPageToken;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: true } : prev));
    void loadWorkflowResource(workflowId, resource, token, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeRef.current !== reqKey) return;
        const nextItems = normalizeWorkflowResourceItems(page.items, workflowId);
        setState((prev) => {
          if (prev.scopeKey !== reqKey) return prev;
          const seen = new Set(prev.items.map((item) => item.id));
          const merged = [
            ...prev.items,
            ...nextItems.filter((item) => !seen.has(item.id)),
          ];
          return {
            ...prev,
            items: merged,
            nextPageToken: page.nextPageToken,
            hasMore: page.hasMore,
            loading: false,
          };
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeRef.current !== reqKey) return;
        setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: false } : prev));
      });
  }, [
    workflowId,
    resource,
    bindingKey,
    loadWorkflowResource,
    state.scopeKey,
    state.nextPageToken,
    state.loading,
    scopeKey,
  ]);

  const matches = state.scopeKey === scopeKey;
  return {
    items: matches ? state.items : [],
    loading: matches ? state.loading : Boolean(bindingKey && loadWorkflowResource),
    hasMore: matches && Boolean(state.nextPageToken && state.hasMore),
    sourceUnavailable: matches && state.sourceUnavailable,
    sourceUnavailableReason: matches ? state.sourceUnavailableReason : undefined,
    loadMore: matches && state.nextPageToken ? loadMore : undefined,
  };
}

/**
 * Paginated browser for Dynamic Workflow execution logs & structured result artifacts.
 * Strictly renders plain text / JSON previews (never trusts embedded HTML).
 */
export function DynamicWorkflowResultsAndLogs({
  workflow,
  bindingKey,
  resultPreviewByArtifactId = {},
  loadWorkflowResource,
  onLogsLoaded,
}: DynamicWorkflowResultsAndLogsProps) {
  const [activeTab, setActiveTab] = useState<'results' | 'logs'>('results');
  const logsPage = useScopedWorkflowResource(
    workflow.id,
    'logs',
    bindingKey,
    loadWorkflowResource,
  );
  const artifactsPage = useScopedWorkflowResource(
    workflow.id,
    'artifacts',
    bindingKey,
    loadWorkflowResource,
  );

  useEffect(() => {
    onLogsLoaded?.(logsPage.items);
  }, [logsPage.items, onLogsLoaded]);

  const detail = workflow.detail.kind === 'dynamic' ? workflow.detail : null;
  const declaredResultIds = detail?.resultArtifactIds ?? [];

  const artifactPreviews: DynamicResultPreviewData[] = [];
  const seenArtIds = new Set<string>();
  for (const id of declaredResultIds) {
    seenArtIds.add(id);
    if (resultPreviewByArtifactId[id]) {
      artifactPreviews.push(resultPreviewByArtifactId[id]);
    }
  }
  for (const [id, preview] of Object.entries(resultPreviewByArtifactId)) {
    if (!seenArtIds.has(id)) {
      artifactPreviews.push(preview);
    }
  }

  return (
    <section
      data-testid="np11-results-and-logs"
      aria-label="结果产物与分页日志"
      className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <FileJson size={14} className="text-[var(--accent-emerald)]" aria-hidden="true" />
          <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
            结果产物与运行日志
          </h3>
        </div>

        <div className="flex items-center gap-1 text-[11px]" role="tablist" aria-label="产物与日志切换">
          <button
            type="button"
            role="tab"
            data-testid="np11-tab-results"
            aria-selected={activeTab === 'results'}
            onClick={() => setActiveTab('results')}
            className="cursor-pointer rounded-lg px-2 py-0.5 font-medium"
            style={{
              backgroundColor: activeTab === 'results' ? 'var(--bg-active)' : 'transparent',
              color: activeTab === 'results' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            结果与产物 ({Math.max(declaredResultIds.length, artifactsPage.items.length)})
          </button>
          <button
            type="button"
            role="tab"
            data-testid="np11-tab-logs"
            aria-selected={activeTab === 'logs'}
            onClick={() => setActiveTab('logs')}
            className="cursor-pointer rounded-lg px-2 py-0.5 font-medium"
            style={{
              backgroundColor: activeTab === 'logs' ? 'var(--bg-active)' : 'transparent',
              color: activeTab === 'logs' ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            执行日志 ({logsPage.items.length})
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
        <ShieldAlert size={11} aria-hidden="true" />
        <span>所有外部结果均按安全纯文本/JSON 边界分页展示，不信任或渲染产物内嵌 HTML。</span>
      </div>

      {activeTab === 'results' ? (
        <div data-testid="np11-results-panel" className="space-y-2">
          {artifactPreviews.map((res) => (
            <div
              key={res.artifactId}
              data-testid={`np11-result-card-${res.artifactId}`}
              className="space-y-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-[var(--text-primary)]">
                  {res.title ?? `结构化结果 ${res.artifactId}`}
                </span>
                <div className="flex flex-wrap items-center gap-1.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                  <span>{res.format}</span>
                  {res.totalItems !== undefined && <span>{res.totalItems} 项</span>}
                  {res.truncated && (
                    <span className="rounded bg-[var(--accent-star-soft)] px-1 text-[var(--accent-star)]">
                      分页截断
                    </span>
                  )}
                </div>
              </div>

              {res.topLevelKeys && res.topLevelKeys.length > 0 && (
                <div className="flex flex-wrap gap-1 text-[10px] text-[var(--text-secondary)]">
                  <span className="text-[var(--text-muted)]">字段:</span>
                  {res.topLevelKeys.map((k) => (
                    <span
                      key={k}
                      className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1 font-mono-code"
                    >
                      {k}
                    </span>
                  ))}
                </div>
              )}

              <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono-code text-[10.5px] text-[var(--text-primary)]">
                <code>{res.previewText}</code>
              </pre>

              {res.provenance && (
                <EvidenceDetails
                  evidence={res.provenance}
                  label={`产物 ${res.artifactId} 来源`}
                />
              )}
            </div>
          ))}

          {artifactsPage.items.length > 0 && (
            <div className="space-y-1.5">
              {artifactsPage.items.map((art) => (
                <div
                  key={art.id}
                  data-testid={`np11-artifact-ref-${art.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11px]"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <FileText size={12} className="shrink-0 text-[var(--accent-emerald)]" aria-hidden="true" />
                    <span className="truncate font-medium text-[var(--text-primary)]">{art.title}</span>
                    <span className="font-mono-code text-[10px] text-[var(--text-muted)]">{art.id}</span>
                  </div>
                  <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                    {art.artifactKind ?? 'unknown'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {artifactPreviews.length === 0 &&
            artifactsPage.items.length === 0 &&
            declaredResultIds.length > 0 && (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px] text-[var(--text-secondary)]">
                已记录 {declaredResultIds.length} 个结果产物引用（{declaredResultIds.join(', ')}），等待通过 NP-14 安全 Artifact 接口读取分页内容。
              </div>
            )}

          {artifactPreviews.length === 0 &&
            artifactsPage.items.length === 0 &&
            declaredResultIds.length === 0 && (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px] text-[var(--text-muted)]">
                {artifactsPage.loading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    <span>正在加载受控产物列表…</span>
                  </span>
                ) : artifactsPage.sourceUnavailable ? (
                  <span>
                    {EMPTY_STATE_COPY.sourceNotProvided}（{artifactsPage.sourceUnavailableReason}）
                  </span>
                ) : (
                  <span>{EMPTY_STATE_COPY.noActivityObserved}</span>
                )}
              </div>
            )}

          {artifactsPage.hasMore && artifactsPage.loadMore && (
            <button
              type="button"
              disabled={artifactsPage.loading}
              onClick={artifactsPage.loadMore}
              className="cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {artifactsPage.loading ? '加载中…' : '加载更多结果产物'}
            </button>
          )}
        </div>
      ) : (
        <div data-testid="np11-logs-panel" className="space-y-1.5">
          {logsPage.loading && logsPage.items.length === 0 ? (
            <div className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              <span>正在分页加载运行日志…</span>
            </div>
          ) : logsPage.items.length === 0 ? (
            <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px] text-[var(--text-muted)]">
              {logsPage.sourceUnavailable
                ? `${EMPTY_STATE_COPY.sourceNotProvided}（${logsPage.sourceUnavailableReason}）`
                : EMPTY_STATE_COPY.noActivityObserved}
            </div>
          ) : (
            logsPage.items.map((log) => (
              <div
                key={log.id}
                data-testid={`np11-log-entry-${log.id}`}
                className="space-y-1 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2 text-[11px]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-mono-code text-[10.5px] text-[var(--text-primary)]">
                    <Terminal size={11} aria-hidden="true" />
                    <span>{log.title}</span>
                  </span>
                  <div className="flex items-center gap-1.5 font-mono-code text-[10px]">
                    <span
                      className={
                        log.level === 'error'
                          ? 'text-[var(--accent-rose)]'
                          : log.level === 'warn'
                            ? 'text-[var(--accent-star)]'
                            : 'text-[var(--text-muted)]'
                      }
                    >
                      {log.level?.toUpperCase() ?? 'INFO'}
                    </span>
                    {log.truncated && (
                      <span className="rounded bg-[var(--accent-star-soft)] px-1 text-[var(--accent-star)]">
                        已截断
                      </span>
                    )}
                  </div>
                </div>
                {log.summary && (
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono-code text-[10.5px] text-[var(--text-secondary)]">
                    {log.summary}
                  </pre>
                )}
              </div>
            ))
          )}

          {logsPage.hasMore && logsPage.loadMore && (
            <button
              type="button"
              data-testid="np11-load-more-logs"
              disabled={logsPage.loading}
              onClick={logsPage.loadMore}
              className="cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {logsPage.loading ? '加载中…' : '加载更多日志'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
