import type { SessionSearchHit, Workspace } from '@harnessmate/protocol';
import {
  AlertCircle,
  Ban,
  ChevronLeft,
  ChevronRight,
  Database,
  Loader2,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  LEGACY_EXPLORER_PLUGIN_ID,
  SESSION_SEARCH_CONTRACT,
  isPluginInstanceReady,
  pluginProvidesContract,
  type SearchReindexJob,
  type ServiceResolutionV1,
} from '../api/peer-contracts';
import {
  defaultPeerWorkspaceTransport,
  type PeerWorkspaceTransport,
} from '../api/peer-workspace-client';
import { formatRelativeTime } from '../lib/harness-meta';
import { isImeComposing } from '../lib/ime';
import {
  SessionSearchController,
  createEmptySearchSlice,
} from '../lib/peer-workspace-controllers';
import { useAppStore } from '../stores/app-store';
import { SafeHighlightedSnippet } from './SessionExplorerModal';
import { ServiceResolutionBanner } from './ServiceResolutionBanner';

const JOB_STATUS_LABELS: Record<SearchReindexJob['status'], string> = {
  queued: '排队中',
  running: '重建中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

function parseDateInputToTs(value: string, endOfDay = false): number | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(endOfDay ? `${value}T23:59:59.999` : `${value}T00:00:00.000`);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export interface SessionSearchWorkspacePageProps {
  instanceId?: string | null;
  initialQuery?: string;
  transport?: PeerWorkspaceTransport;
  controller?: SessionSearchController;
  onJumpToHit?: (hit: SessionSearchHit) => void;
  onClose?: () => void;
}

export function SessionSearchWorkspacePage({
  instanceId,
  initialQuery,
  transport = defaultPeerWorkspaceTransport,
  controller: injectedController,
  onJumpToHit,
  onClose,
}: SessionSearchWorkspacePageProps) {
  const {
    plugins,
    workspaces,
    harnesses,
    sessions,
    selectedWorkspaceId,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
    searchPageInitialQuery,
    setWorkspaceBinding,
    selectSession,
    focusTurn,
    setActivePluginPage,
  } = useAppStore(
    useShallow((state) => ({
      plugins: state.plugins,
      workspaces: state.workspaces,
      harnesses: state.harnesses,
      sessions: state.sessions,
      selectedWorkspaceId: state.selectedWorkspaceId,
      workspaceBindingsByWorkspace: state.workspaceBindingsByWorkspace,
      compositionBindings: state.compositionBindings,
      compositionEntries: state.compositionEntries,
      searchPageInitialQuery: state.searchPageInitialQuery,
      setWorkspaceBinding: state.setWorkspaceBinding,
      selectSession: state.selectSession,
      focusTurn: state.focusTurn,
      setActivePluginPage: state.setActivePluginPage,
    })),
  );

  const controller = useMemo(
    () => injectedController ?? new SessionSearchController(transport),
    [injectedController, transport],
  );

  useEffect(() => {
    if (injectedController) return;
    return () => controller.dispose();
  }, [controller, injectedController]);

  const controllerState = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const effectiveInitialQuery = initialQuery ?? searchPageInitialQuery ?? '';
  const [explicitInstanceId, setExplicitInstanceId] = useState<string | null>(instanceId ?? null);
  const [query, setQuery] = useState(effectiveInitialQuery);
  const [workspaceFilter, setWorkspaceFilter] = useState(selectedWorkspaceId ?? '');
  const [driverFilter, setDriverFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const limit = 20;

  const [resolution, setResolution] = useState<ServiceResolutionV1>({
    contract: SESSION_SEARCH_CONTRACT,
    versionRange: '^1.0.0',
    candidates: [],
    instanceId: null,
    source: 'none',
    status: 'unconfigured',
  });

  const composingRef = useRef(false);

  useEffect(() => {
    setExplicitInstanceId(instanceId ?? null);
  }, [instanceId]);

  useEffect(() => {
    if (effectiveInitialQuery) {
      setQuery(effectiveInitialQuery);
    }
  }, [effectiveInitialQuery]);

  const hasLegacyExplorerFallback = useMemo(
    () =>
      !plugins.some((p) => pluginProvidesContract(p, SESSION_SEARCH_CONTRACT)) &&
      plugins.some((p) => p.id === LEGACY_EXPLORER_PLUGIN_ID && isPluginInstanceReady(p)),
    [plugins],
  );

  const resolutionWorkspaceId = workspaceFilter || selectedWorkspaceId || undefined;
  const currentWorkspace = useMemo<Workspace | null>(
    () => workspaces.find((w) => w.id === resolutionWorkspaceId) ?? null,
    [workspaces, resolutionWorkspaceId],
  );

  // Resolve active session.search.v1 instance
  useEffect(() => {
    const abortCtrl = new AbortController();
    void transport
      .resolveServiceSelection(SESSION_SEARCH_CONTRACT, {
        versionRange: '^1.0.0',
        workspaceId: resolutionWorkspaceId,
        explicitInstanceId: explicitInstanceId ?? undefined,
        allowSingleCandidate: true,
        plugins,
        workspaceBindings: resolutionWorkspaceId
          ? workspaceBindingsByWorkspace[resolutionWorkspaceId]
          : undefined,
        compositionBindings,
        compositionEntries,
        signal: abortCtrl.signal,
      })
      .then((res) => {
        if (abortCtrl.signal.aborted) return;
        setResolution(res);
        const nextActive =
          res.status === 'ready'
            ? res.instanceId
            : hasLegacyExplorerFallback
              ? LEGACY_EXPLORER_PLUGIN_ID
              : null;
        controller.setActiveInstance(nextActive);
      })
      .catch(() => {});
    return () => abortCtrl.abort();
  }, [
    transport,
    controller,
    resolutionWorkspaceId,
    explicitInstanceId,
    plugins,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
    hasLegacyExplorerFallback,
  ]);

  const activeInstanceId = controllerState.activeInstanceId;
  const sliceKey = activeInstanceId ?? resolution.instanceId ?? '__none__';
  const currentSlice = controllerState.slices[sliceKey] ?? createEmptySearchSlice();

  const runSearch = useCallback(
    async (opts?: { qOverride?: string; nextOffset?: number }) => {
      if (!activeInstanceId) return;
      await controller.runSearch(activeInstanceId, {
        q: opts?.qOverride ?? query,
        workspaceId: workspaceFilter || undefined,
        driverId: driverFilter || undefined,
        fromTs: parseDateInputToTs(fromDate, false),
        toTs: parseDateInputToTs(toDate, true),
        limit,
        offset: opts?.nextOffset ?? 0,
      });
    },
    [controller, activeInstanceId, query, workspaceFilter, driverFilter, fromDate, toDate],
  );

  const autoRanKeyRef = useRef<string>('');
  useEffect(() => {
    const trimmed = effectiveInitialQuery.trim();
    if (!trimmed || !activeInstanceId) return;
    const key = `${activeInstanceId}:${trimmed}`;
    if (autoRanKeyRef.current === key) return;
    autoRanKeyRef.current = key;
    void runSearch({ qOverride: trimmed, nextOffset: 0 });
  }, [effectiveInitialQuery, activeInstanceId, runSearch]);

  const handleJump = useCallback(
    (hit: SessionSearchHit) => {
      if (onJumpToHit) {
        onJumpToHit(hit);
        return;
      }
      setActivePluginPage(null);
      void selectSession(hit.sessionId).then(() => {
        if (hit.turnId) {
          focusTurn({ sessionId: hit.sessionId, turnId: hit.turnId, itemId: hit.itemId });
        }
      });
    },
    [onJumpToHit, setActivePluginPage, selectSession, focusTurn],
  );

  const driverOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const h of harnesses) {
      seen.set(h.kind, h.displayName);
    }
    for (const fallback of [
      ['codex', 'Codex'],
      ['claude', 'Claude'],
      ['agy', 'Antigravity (AGY)'],
      ['acp', 'Custom ACP'],
    ] as const) {
      if (!seen.has(fallback[0])) seen.set(fallback[0], fallback[1]);
    }
    return [...seen.entries()];
  }, [harnesses]);

  const activeJob = currentSlice.status?.activeJob ?? null;
  const lastJob = currentSlice.status?.lastJob ?? null;
  const displayJob = activeJob ?? lastJob;
  const isJobRunning = Boolean(
    activeJob && (activeJob.status === 'queued' || activeJob.status === 'running'),
  );
  const canResumeJob = Boolean(
    !isJobRunning &&
      displayJob &&
      (displayJob.status === 'cancelled' || displayJob.status === 'failed'),
  );

  return (
    <div
      data-testid="session-search-workspace-page"
      data-instance-id={activeInstanceId ?? ''}
      className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)] text-[var(--text-primary)]"
    >
      {/* Top Bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <Search size={16} className="text-[var(--accent-indigo)]" />
            <span>会话全文检索工作页</span>
          </h2>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
            支持多检索实例切换与工作区绑定、工作区/驱动/时间范围筛选、索引重建控制与轮次直达
          </p>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭搜索工作页"
            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* Resolution Banner */}
      <div className="px-5 pt-3">
        <ServiceResolutionBanner
          title="检索服务实例"
          resolution={resolution}
          plugins={plugins}
          selectedInstanceId={explicitInstanceId}
          onSelectInstance={(nextId) => setExplicitInstanceId(nextId)}
          workspaceName={currentWorkspace?.name ?? null}
          onBindWorkspace={
            currentWorkspace
              ? (instId) =>
                  void setWorkspaceBinding(currentWorkspace.id, SESSION_SEARCH_CONTRACT, instId)
              : undefined
          }
        />
      </div>

      {/* Main Content */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {/* Search & Filters */}
        <div className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl px-3 py-2"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)',
              }}
            >
              <Search size={14} className="text-[var(--text-muted)]" />
              <input
                aria-label="全文搜索关键词"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isImeComposing(e, composingRef.current)) {
                    void runSearch({ nextOffset: 0 });
                  }
                }}
                placeholder="输入中文或英文关键词搜索历史对话、工具输出、错误信息..."
                className="w-full bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>

            <button
              type="button"
              disabled={!activeInstanceId || currentSlice.searching}
              onClick={() => void runSearch({ nextOffset: 0 })}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-medium text-white disabled:opacity-40"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {currentSlice.searching ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Search size={13} />
              )}
              <span>检索</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <select
              aria-label="按工作区筛选"
              value={workspaceFilter}
              onChange={(e) => setWorkspaceFilter(e.target.value)}
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[var(--text-primary)]"
            >
              <option value="">全部工作区</option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
            </select>

            <select
              aria-label="按驱动筛选"
              value={driverFilter}
              onChange={(e) => setDriverFilter(e.target.value)}
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[var(--text-primary)]"
            >
              <option value="">全部驱动</option>
              {driverOptions.map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label} ({kind})
                </option>
              ))}
            </select>

            <label className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
              <span>起</span>
              <input
                aria-label="起始日期"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11.5px] text-[var(--text-primary)]"
              />
            </label>

            <label className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
              <span>止</span>
              <input
                aria-label="结束日期"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11.5px] text-[var(--text-primary)]"
              />
            </label>

            {(workspaceFilter || driverFilter || fromDate || toDate) && (
              <button
                type="button"
                onClick={() => {
                  setWorkspaceFilter('');
                  setDriverFilter('');
                  setFromDate('');
                  setToDate('');
                }}
                className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                清除筛选
              </button>
            )}
          </div>
        </div>

        {/* Index Status & Reindex Controls */}
        <div
          data-testid="search-index-status-panel"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3.5 py-2.5 text-[11.5px]"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Database size={13} className="text-[var(--accent-indigo)]" />
              <span className="font-medium text-[var(--text-primary)]">
                {currentSlice.status
                  ? `${currentSlice.status.engineKind} · 已索引 ${currentSlice.status.indexedItems} 条 / ${currentSlice.status.indexedSessions} 会话`
                  : `共 ${sessions.length} 个逻辑会话`}
              </span>
              {currentSlice.status && (
                <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                  cursor #{currentSlice.status.cursorSeq}
                  {currentSlice.status.latestSourceSeq !== undefined
                    ? ` / latest #${currentSlice.status.latestSourceSeq}`
                    : ''}
                </span>
              )}
              {displayJob && (
                <span
                  className="rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                  style={{
                    backgroundColor:
                      displayJob.status === 'failed'
                        ? 'var(--accent-rose-soft)'
                        : displayJob.status === 'cancelled'
                          ? 'var(--accent-star-soft)'
                          : 'var(--accent-indigo-soft)',
                    color:
                      displayJob.status === 'failed'
                        ? 'var(--accent-rose)'
                        : displayJob.status === 'cancelled'
                          ? 'var(--accent-star)'
                          : 'var(--accent-indigo)',
                  }}
                >
                  任务 {displayJob.jobId} · {JOB_STATUS_LABELS[displayJob.status]}（
                  {displayJob.indexedCount}
                  {displayJob.totalCount !== undefined ? `/${displayJob.totalCount}` : ''}）
                </span>
              )}
            </div>
            {(currentSlice.statusError ||
              currentSlice.reindexError ||
              currentSlice.status?.lastError) && (
              <p className="text-[11px] text-[var(--accent-rose)]">
                {currentSlice.reindexError ??
                  currentSlice.statusError ??
                  currentSlice.status?.lastError}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {activeInstanceId && activeInstanceId !== LEGACY_EXPLORER_PLUGIN_ID && (
              <button
                type="button"
                onClick={() => void controller.fetchStatus(activeInstanceId)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                <RefreshCw size={11} />
                <span>刷新状态</span>
              </button>
            )}
            {isJobRunning ? (
              <button
                type="button"
                onClick={() =>
                  activeInstanceId && void controller.cancelReindex(activeInstanceId, activeJob?.jobId)
                }
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent-rose)] hover:bg-[var(--bg-hover)]"
              >
                <Ban size={11} />
                <span>取消重建</span>
              </button>
            ) : (
              <>
                {canResumeJob && (
                  <button
                    type="button"
                    onClick={() =>
                      activeInstanceId &&
                      void controller.resumeReindex(activeInstanceId, displayJob?.jobId)
                    }
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-focus)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-active)]"
                  >
                    <Play size={11} />
                    <span>续跑重建</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={!activeInstanceId || currentSlice.reindexing}
                  onClick={() =>
                    activeInstanceId &&
                    void controller.reindex(
                      activeInstanceId,
                      'incremental',
                      workspaceFilter || undefined,
                    )
                  }
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  <RefreshCw size={11} className={currentSlice.reindexing ? 'animate-spin' : ''} />
                  <span>补建索引</span>
                </button>
                <button
                  type="button"
                  disabled={!activeInstanceId || currentSlice.reindexing}
                  onClick={() =>
                    activeInstanceId &&
                    void controller.reindex(
                      activeInstanceId,
                      'full',
                      workspaceFilter || undefined,
                    )
                  }
                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  <span>全量重建</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Query Error (isolated per instance) */}
        {currentSlice.queryError && (
          <div
            role="alert"
            data-testid="search-instance-error"
            className="flex items-start gap-2 rounded-xl p-3 text-[12px] text-[var(--accent-rose)]"
            style={{ backgroundColor: 'var(--accent-rose-soft)' }}
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              检索出错（{activeInstanceId ?? resolution.instanceId}）：{currentSlice.queryError}
            </span>
          </div>
        )}

        {/* Query Summary */}
        {currentSlice.tookMs !== null && (
          <div className="flex items-center justify-between text-[11.5px] text-[var(--text-muted)]">
            <span>
              实例 {activeInstanceId} 命中 {currentSlice.hits.length} 条记录（offset{' '}
              {currentSlice.offset} · {currentSlice.tookMs}ms ·{' '}
              {currentSlice.fallbackUsed ? 'LIKE 降级' : '全文索引'}）
            </span>
          </div>
        )}

        {/* Results */}
        <div className="space-y-2">
          {!activeInstanceId ? (
            <div className="rounded-xl border border-[var(--border-hairline)] p-6 text-center text-[12px] text-[var(--text-muted)]">
              当前选择的搜索实例不可用或待选择，请先在上方切换候选实例或启用插件。
            </div>
          ) : currentSlice.hits.length === 0 ? (
            <div className="rounded-xl border border-[var(--border-hairline)] p-6 text-center text-[12px] text-[var(--text-muted)]">
              {currentSlice.hasSearched
                ? '未找到匹配的会话内容，请尝试更换关键词、切换检索实例或放宽筛选条件。'
                : '输入关键词并回车即可跨工作区全文检索，点击结果直达目标会话、轮次与条目。'}
            </div>
          ) : (
            currentSlice.hits.map((hit) => (
              <button
                key={`${hit.sessionId}:${hit.itemId}`}
                data-testid={`search-hit-${hit.sessionId}-${hit.turnId}`}
                type="button"
                onClick={() => handleJump(hit)}
                className="block w-full cursor-pointer rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                  <span className="truncate font-semibold text-[var(--text-primary)]">
                    {hit.sessionTitle}
                  </span>
                  <span className="shrink-0 font-mono-code text-[10.5px] text-[var(--text-muted)]">
                    {hit.driverId} · seq #{hit.turnSeq} · {hit.turnId} · {hit.itemId} ·{' '}
                    {formatRelativeTime(hit.createdAt)}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  <SafeHighlightedSnippet text={hit.snippetText} highlights={hit.highlights} />
                </p>
              </button>
            ))
          )}
        </div>

        {/* Pagination */}
        {(currentSlice.offset > 0 || currentSlice.nextOffset !== null) && (
          <div className="flex items-center justify-between pt-1 text-[12px]">
            <button
              type="button"
              disabled={currentSlice.offset <= 0 || currentSlice.searching}
              onClick={() =>
                void runSearch({ nextOffset: Math.max(0, currentSlice.offset - limit) })
              }
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-3 py-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
            >
              <ChevronLeft size={13} />
              <span>上一页</span>
            </button>
            <span className="font-mono-code text-[11px] text-[var(--text-muted)]">
              偏移 {currentSlice.offset}
            </span>
            <button
              type="button"
              disabled={currentSlice.nextOffset === null || currentSlice.searching}
              onClick={() => {
                if (currentSlice.nextOffset !== null) {
                  void runSearch({ nextOffset: currentSlice.nextOffset });
                }
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-3 py-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
            >
              <span>下一页</span>
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
