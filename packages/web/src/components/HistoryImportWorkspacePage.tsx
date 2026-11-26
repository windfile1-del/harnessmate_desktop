import type { PortableSessionBundleV2, Session, Workspace } from '@harnessmate/protocol';
import {
  AlertCircle,
  Archive,
  Ban,
  CheckCircle2,
  Download,
  ExternalLink,
  FileJson,
  FolderOpen,
  History,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { daemonApi } from '../api/client';
import {
  HISTORY_IMPORT_CONTRACT,
  HISTORY_SOURCE_CONTRACT,
  LEGACY_EXPLORER_PLUGIN_ID,
  getPluginInstanceId,
  isPluginInstanceReady,
  pluginProvidesContract,
  type HistorySummary,
  type ImportInput,
  type ServiceResolutionV1,
} from '../api/peer-contracts';
import {
  defaultPeerWorkspaceTransport,
  type PeerWorkspaceTransport,
} from '../api/peer-workspace-client';
import { formatRelativeTime } from '../lib/harness-meta';
import { HistoryImportController } from '../lib/peer-workspace-controllers';
import { useAppStore } from '../stores/app-store';
import { ServiceResolutionBanner } from './ServiceResolutionBanner';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function itemKey(item: HistorySummary): string {
  return `${item.ref.sourceInstanceId}::${item.ref.sourceId}::${item.ref.nativeSessionId}`;
}

export interface HistoryImportWorkspacePageProps {
  instanceId?: string | null;
  initialTab?: 'native' | 'bundle';
  transport?: PeerWorkspaceTransport;
  controller?: HistoryImportController;
  onOpenSession?: (sessionId: string) => Promise<void> | void;
  onClose?: () => void;
}

export function HistoryImportWorkspacePage({
  instanceId,
  initialTab = 'native',
  transport = defaultPeerWorkspaceTransport,
  controller: injectedController,
  onOpenSession,
  onClose,
}: HistoryImportWorkspacePageProps) {
  const {
    plugins,
    workspaces,
    sessions,
    selectedWorkspaceId,
    selectedSessionId,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
    importPageInitialTab,
    addWorkspace,
    setWorkspaceBinding,
    openArchivedSession,
    syncImportedSession,
    importSessionBundle,
    pushToast,
  } = useAppStore(
    useShallow((state) => ({
      plugins: state.plugins,
      workspaces: state.workspaces,
      sessions: state.sessions,
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      workspaceBindingsByWorkspace: state.workspaceBindingsByWorkspace,
      compositionBindings: state.compositionBindings,
      compositionEntries: state.compositionEntries,
      importPageInitialTab: state.importPageInitialTab,
      addWorkspace: state.addWorkspace,
      setWorkspaceBinding: state.setWorkspaceBinding,
      openArchivedSession: state.openArchivedSession,
      syncImportedSession: state.syncImportedSession,
      importSessionBundle: state.importSessionBundle,
      pushToast: state.pushToast,
    })),
  );

  const controller = useMemo(
    () => injectedController ?? new HistoryImportController(transport),
    [injectedController, transport],
  );

  useEffect(() => {
    if (injectedController) return;
    return () => controller.dispose();
  }, [controller, injectedController]);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const selectedSession = useMemo<Session | null>(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const currentWorkspace = useMemo<Workspace | null>(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId],
  );

  const [tab, setTab] = useState<'native' | 'bundle'>(
    initialTab ?? importPageInitialTab ?? 'native',
  );
  const [explicitImportInstanceId, setExplicitImportInstanceId] = useState<string | null>(
    instanceId ?? null,
  );
  const [resolution, setResolution] = useState<ServiceResolutionV1>({
    contract: HISTORY_IMPORT_CONTRACT,
    versionRange: '^1.0.0',
    candidates: [],
    instanceId: null,
    source: 'none',
    status: 'unconfigured',
  });

  const [sourceQuery, setSourceQuery] = useState('');
  const [importMode, setImportMode] = useState<'mirror' | 'attach'>('mirror');
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string>(
    selectedWorkspaceId ?? workspaces[0]?.id ?? '',
  );

  const [redactExport, setRedactExport] = useState(true);
  const [bundleJsonInput, setBundleJsonInput] = useState('');
  const [bundleStatus, setBundleStatus] = useState<string | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);

  useEffect(() => {
    setExplicitImportInstanceId(instanceId ?? null);
  }, [instanceId]);

  useEffect(() => {
    if (!targetWorkspaceId && workspaces[0]?.id) {
      setTargetWorkspaceId(selectedWorkspaceId ?? workspaces[0].id);
    }
  }, [workspaces, selectedWorkspaceId, targetWorkspaceId]);

  const sourcePlugins = useMemo(
    () =>
      plugins
        .filter((p) => pluginProvidesContract(p, HISTORY_SOURCE_CONTRACT))
        .sort((a, b) => getPluginInstanceId(a).localeCompare(getPluginInstanceId(b))),
    [plugins],
  );

  const hasLegacyExplorerFallback = useMemo(
    () =>
      sourcePlugins.length === 0 &&
      plugins.some((p) => p.id === LEGACY_EXPLORER_PLUGIN_ID && isPluginInstanceReady(p)),
    [sourcePlugins.length, plugins],
  );

  useEffect(() => {
    const abortCtrl = new AbortController();
    void transport
      .resolveServiceSelection(HISTORY_IMPORT_CONTRACT, {
        versionRange: '^1.0.0',
        workspaceId: targetWorkspaceId || undefined,
        explicitInstanceId: explicitImportInstanceId ?? undefined,
        allowSingleCandidate: true,
        plugins,
        workspaceBindings: targetWorkspaceId
          ? workspaceBindingsByWorkspace[targetWorkspaceId]
          : undefined,
        compositionBindings,
        compositionEntries,
        signal: abortCtrl.signal,
      })
      .then((res) => {
        if (abortCtrl.signal.aborted) return;
        setResolution(res);
        controller.setActiveImportInstance(res.status === 'ready' ? res.instanceId : null);
      })
      .catch(() => {});
    return () => abortCtrl.abort();
  }, [
    transport,
    controller,
    targetWorkspaceId,
    explicitImportInstanceId,
    plugins,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
  ]);

  useEffect(() => {
    controller.syncSources(sourcePlugins, hasLegacyExplorerFallback, {
      query: sourceQuery,
      workspaceId: targetWorkspaceId || undefined,
    });
  }, [controller, sourcePlugins, hasLegacyExplorerFallback, sourceQuery, targetWorkspaceId]);

  const activeImportInstanceId = state.activeImportInstanceId;

  const refreshAllSources = useCallback(
    (refresh = true) => {
      for (const slice of Object.values(state.sourcesMap)) {
        if (slice.ready) {
          void controller.discoverSource(slice.instanceId, {
            refresh,
            query: sourceQuery,
            workspaceId: targetWorkspaceId || undefined,
          });
        }
      }
    },
    [state.sourcesMap, controller, sourceQuery, targetWorkspaceId],
  );

  const openSessionTarget = useCallback(
    async (sessionId: string) => {
      if (onOpenSession) {
        await onOpenSession(sessionId);
        return;
      }
      await openArchivedSession(sessionId);
    },
    [onOpenSession, openArchivedSession],
  );

  const runPreview = useCallback(
    async (summary: HistorySummary, mode: 'mirror' | 'attach', workspaceId: string) => {
      const preview = await controller.preview(
        summary,
        mode,
        workspaceId,
        hasLegacyExplorerFallback,
      );
      if (preview?.targetWorkspaceId && !workspaceId) {
        setTargetWorkspaceId(preview.targetWorkspaceId);
      }
    },
    [controller, hasLegacyExplorerFallback],
  );

  const handleCommitImport = useCallback(async () => {
    const res = await controller.commit(importMode, targetWorkspaceId, hasLegacyExplorerFallback);
    if (res) {
      await syncImportedSession(res.sessionId).catch(() => null);
      pushToast({
        kind: 'success',
        title:
          res.disposition === 'reused'
            ? `已复用既有归档会话 (${res.sessionId})`
            : `已导入历史会话 (${res.sessionId})`,
      });
    } else if (controller.getSnapshot().importError) {
      pushToast({
        kind: 'error',
        title: '导入失败（可保留请求标识重试）',
        body: controller.getSnapshot().importError ?? undefined,
      });
    }
  }, [controller, importMode, targetWorkspaceId, hasLegacyExplorerFallback, syncImportedSession, pushToast]);

  const handlePickFolder = async () => {
    const picked = await window.harnessMateBridge?.pickDirectory();
    if (picked) {
      const ws = await addWorkspace(picked);
      setTargetWorkspaceId(ws.id);
    }
  };

  const handleExportBundle = async () => {
    if (!selectedSession) return;
    setBundleBusy(true);
    setBundleStatus(null);
    try {
      const res = await daemonApi.exportSessionBundle(selectedSession.id, redactExport);
      const blob = new Blob([JSON.stringify(res.bundle, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      setBundleStatus(
        `已导出 ${res.filename}${res.bundle.redacted ? `（已脱敏 ${res.bundle.redactedCount} 处敏感信息）` : ''}`,
      );
    } catch (err) {
      setBundleStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBundleBusy(false);
    }
  };

  const handleImportBundleSubmit = async () => {
    if (!bundleJsonInput.trim()) return;
    setBundleBusy(true);
    setBundleStatus(null);
    try {
      const parsed = JSON.parse(bundleJsonInput) as PortableSessionBundleV2;
      if (activeImportInstanceId) {
        const input: ImportInput = { kind: 'bundle', bundle: parsed };
        const requestId = controller.requestIdTracker.getOrCreate(
          input,
          targetWorkspaceId || undefined,
        );
        const result = await transport.commitImport(activeImportInstanceId, {
          input,
          workspaceId: targetWorkspaceId || undefined,
          requestId,
        });
        await syncImportedSession(result.sessionId).catch(() => null);
        setBundleJsonInput('');
        setBundleStatus(
          `已通过 ${activeImportInstanceId} 还原会话 ${result.sessionId}（${result.disposition}）`,
        );
        await openSessionTarget(result.sessionId);
      } else {
        await importSessionBundle({
          bundle: parsed,
          workspaceId: targetWorkspaceId || undefined,
        });
        setBundleJsonInput('');
        setBundleStatus('已从 Portable JSON Bundle v2 完整还原会话');
      }
    } catch (err) {
      setBundleStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBundleBusy(false);
    }
  };

  const sourceList = useMemo(() => Object.values(state.sourcesMap), [state.sourcesMap]);

  return (
    <div
      data-testid="history-import-workspace-page"
      data-instance-id={activeImportInstanceId ?? ''}
      className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)] text-[var(--text-primary)]"
    >
      {/* Top Bar */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <History size={16} className="text-[var(--accent-indigo)]" />
            <span>历史发现与导入工作页</span>
          </h2>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
            按独立来源并行发现、预览与去重导入（支持只读镜像、接管续跑与 Portable Bundle v2）
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTab('native')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium"
            style={{
              backgroundColor: tab === 'native' ? 'var(--bg-active)' : 'transparent',
              color: tab === 'native' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              border: `1px solid ${tab === 'native' ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
            }}
          >
            <History size={13} />
            <span>来源发现与导入</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('bundle')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium"
            style={{
              backgroundColor: tab === 'bundle' ? 'var(--bg-active)' : 'transparent',
              color: tab === 'bundle' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              border: `1px solid ${tab === 'bundle' ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
            }}
          >
            <FileJson size={13} />
            <span>JSON Bundle v2</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭导入工作页"
              className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Resolution Banner */}
      <div className="px-5 pt-3">
        <ServiceResolutionBanner
          title="导入服务实例"
          resolution={resolution}
          plugins={plugins}
          selectedInstanceId={explicitImportInstanceId}
          onSelectInstance={(nextId) => setExplicitImportInstanceId(nextId)}
          workspaceName={currentWorkspace?.name ?? null}
          onBindWorkspace={
            currentWorkspace
              ? (instId) =>
                  void setWorkspaceBinding(currentWorkspace.id, HISTORY_IMPORT_CONTRACT, instId)
              : undefined
          }
        />
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'native' ? (
          <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-12">
            {/* Left: Multi-source Discovery */}
            <div className="space-y-3 lg:col-span-7">
              <div className="flex flex-wrap items-center gap-2">
                <div
                  className="flex min-w-[200px] flex-1 items-center gap-2 rounded-xl px-3 py-1.5"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  <Search size={13.5} className="text-[var(--text-muted)]" />
                  <input
                    aria-label="筛选历史来源会话"
                    value={sourceQuery}
                    onChange={(e) => setSourceQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') refreshAllSources(true);
                    }}
                    placeholder="按标题或工作区筛选原生历史..."
                    className="w-full bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => refreshAllSources(true)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <RefreshCw size={12.5} />
                  <span>刷新全部来源</span>
                </button>
              </div>

              {sourceList.length === 0 ? (
                <div className="rounded-xl border border-[var(--border-hairline)] p-6 text-center text-[12px] text-[var(--text-muted)]">
                  当前组合未配置历史来源插件（history.source.v1）。
                </div>
              ) : (
                <div className="space-y-3">
                  {sourceList.map((slice) => (
                    <section
                      key={slice.instanceId}
                      data-testid={`history-source-card-${slice.instanceId}`}
                      data-source-ready={slice.ready ? 'true' : 'false'}
                      className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                            {slice.name}
                          </span>
                          <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                            {slice.instanceId}
                          </span>
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: slice.error
                                ? 'var(--accent-rose-soft)'
                                : slice.ready
                                  ? 'var(--accent-emerald-soft)'
                                  : 'var(--accent-star-soft)',
                              color: slice.error
                                ? 'var(--accent-rose)'
                                : slice.ready
                                  ? 'var(--accent-emerald)'
                                  : 'var(--accent-star)',
                            }}
                          >
                            {slice.error ? '读取异常' : slice.statusText}
                          </span>
                        </div>

                        <button
                          type="button"
                          disabled={!slice.ready || slice.loading}
                          onClick={() =>
                            void controller.discoverSource(slice.instanceId, {
                              refresh: true,
                              query: sourceQuery,
                              workspaceId: targetWorkspaceId || undefined,
                            })
                          }
                          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                        >
                          <RefreshCw size={11} className={slice.loading ? 'animate-spin' : ''} />
                          <span>刷新此来源</span>
                        </button>
                      </div>

                      {!slice.ready ? (
                        <p className="text-[11.5px] text-[var(--text-muted)]">
                          来源实例 {slice.instanceId} 当前{slice.statusText}，其余来源仍可正常操作。
                        </p>
                      ) : slice.error ? (
                        <div
                          role="alert"
                          className="flex items-start gap-2 rounded-lg p-2.5 text-[11.5px] text-[var(--accent-rose)]"
                          style={{ backgroundColor: 'var(--accent-rose-soft)' }}
                        >
                          <AlertCircle size={13.5} className="mt-0.5 shrink-0" />
                          <span>{slice.error}</span>
                        </div>
                      ) : slice.loading && slice.sessions.length === 0 ? (
                        <div className="flex items-center gap-2 py-4 text-[11.5px] text-[var(--text-muted)]">
                          <Loader2 size={13} className="animate-spin" />
                          <span>正在扫描 {slice.name}...</span>
                        </div>
                      ) : slice.sessions.length === 0 ? (
                        <p className="py-2 text-[11.5px] text-[var(--text-muted)]">
                          此来源下未发现匹配的历史会话。
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {slice.sessions.map((item) => {
                            const key = itemKey(item);
                            const active =
                              state.selectedSummary && itemKey(state.selectedSummary) === key;
                            return (
                              <div
                                key={key}
                                className="flex items-center justify-between gap-2.5 rounded-lg p-2.5 transition-colors"
                                style={{
                                  backgroundColor: active
                                    ? 'var(--bg-active)'
                                    : 'var(--bg-surface)',
                                  border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                                }}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                                      {item.title}
                                    </span>
                                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-secondary)]">
                                      {item.harnessKind}
                                    </span>
                                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                                      {item.ref.sourceId}
                                    </span>
                                    {item.compressed && (
                                      <span
                                        className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono-code text-[10px]"
                                        style={{
                                          backgroundColor: 'var(--accent-indigo-soft)',
                                          color: 'var(--accent-indigo)',
                                        }}
                                      >
                                        <Archive size={10} />
                                        zstd
                                      </span>
                                    )}
                                    {item.alreadyImportedSessionId && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void openSessionTarget(item.alreadyImportedSessionId!)
                                        }
                                        className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:underline"
                                        style={{
                                          backgroundColor: 'var(--accent-emerald-soft)',
                                          color: 'var(--accent-emerald)',
                                        }}
                                      >
                                        <span>已归档 · 打开</span>
                                        <ExternalLink size={9.5} />
                                      </button>
                                    )}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-2 font-mono-code text-[10.5px] text-[var(--text-muted)]">
                                    <span>{item.ref.nativeSessionId}</span>
                                    <span>·</span>
                                    <span>{formatRelativeTime(item.updatedAt)}</span>
                                    {item.fileSizeBytes !== undefined && (
                                      <>
                                        <span>·</span>
                                        <span>{formatBytes(item.fileSizeBytes)}</span>
                                      </>
                                    )}
                                    {(item.workspaceHint?.cwd || item.workspaceHint?.label) && (
                                      <>
                                        <span>·</span>
                                        <span className="truncate">
                                          {item.workspaceHint.cwd ?? item.workspaceHint.label}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void runPreview(item, importMode, targetWorkspaceId)
                                  }
                                  className="shrink-0 cursor-pointer rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium text-white"
                                  style={{ backgroundColor: 'var(--accent-indigo)' }}
                                >
                                  预览与导入
                                </button>
                              </div>
                            );
                          })}
                          {slice.nextCursor && (
                            <button
                              type="button"
                              disabled={slice.loadingMore}
                              onClick={() =>
                                void controller.discoverSource(slice.instanceId, {
                                  cursor: slice.nextCursor,
                                  append: true,
                                  query: sourceQuery,
                                  workspaceId: targetWorkspaceId || undefined,
                                })
                              }
                              className="w-full cursor-pointer rounded-lg py-1.5 text-[11.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                            >
                              {slice.loadingMore ? '加载中...' : '加载更多此来源历史'}
                            </button>
                          )}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              )}
            </div>

            {/* Right: Preview & Commit Pane */}
            <div className="space-y-3 lg:col-span-5">
              <div className="space-y-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-4">
                <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                  导入预览与参数配置
                </h3>

                {/* Import Mode */}
                <div className="space-y-1.5 text-[12px]">
                  <span className="font-medium text-[var(--text-secondary)]">导入模式</span>
                  <div className="flex flex-wrap gap-3">
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name="workspace-import-mode"
                        checked={importMode === 'mirror'}
                        onChange={() => {
                          setImportMode('mirror');
                          if (state.selectedSummary) {
                            void runPreview(state.selectedSummary, 'mirror', targetWorkspaceId);
                          }
                        }}
                      />
                      <span>只读镜像（Mirror）</span>
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name="workspace-import-mode"
                        checked={importMode === 'attach'}
                        onChange={() => {
                          setImportMode('attach');
                          if (state.selectedSummary) {
                            void runPreview(state.selectedSummary, 'attach', targetWorkspaceId);
                          }
                        }}
                      />
                      <span>直接接管续跑（Attach）</span>
                    </label>
                  </div>
                </div>

                {/* Target Workspace */}
                <div className="space-y-1.5 text-[12px]">
                  <span className="font-medium text-[var(--text-secondary)]">目标工作区</span>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="选择导入目标工作区"
                      value={targetWorkspaceId}
                      onChange={(e) => setTargetWorkspaceId(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
                    >
                      <option value="">自动匹配原目录 / 选定工作区</option>
                      {workspaces.map((ws) => (
                        <option key={ws.id} value={ws.id}>
                          {ws.name} — {ws.rootPath}
                        </option>
                      ))}
                    </select>
                    {window.harnessMateBridge && (
                      <button
                        type="button"
                        onClick={() => void handlePickFolder()}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      >
                        <FolderOpen size={13} />
                        <span>选择目录</span>
                      </button>
                    )}
                  </div>
                </div>

                {!state.selectedSummary ? (
                  <div className="rounded-lg border border-dashed border-[var(--border-hairline)] p-6 text-center text-[12px] text-[var(--text-muted)]">
                    从左侧任一来源选择会话，即可实时预览条目、检查既有归档并执行提交或取消。
                  </div>
                ) : (
                  <div className="space-y-3 border-t border-[var(--border-hairline)] pt-3">
                    <div className="space-y-1 text-[12px]">
                      <div className="font-semibold text-[var(--text-primary)]">
                        {state.selectedSummary.title}
                      </div>
                      <div className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                        来源 {state.selectedSummary.ref.sourceInstanceId} ·{' '}
                        {state.selectedSummary.ref.sourceId} ·{' '}
                        {state.selectedSummary.ref.nativeSessionId}
                      </div>
                    </div>

                    {state.previewLoading && (
                      <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--bg-surface)] p-2.5 text-[12px] text-[var(--text-secondary)]">
                        <span className="inline-flex items-center gap-2">
                          <Loader2 size={13} className="animate-spin text-[var(--accent-indigo)]" />
                          <span>正在读取预览内容...</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => controller.cancelActiveOp()}
                          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] px-2 py-0.5 text-[11px] text-[var(--accent-rose)] hover:bg-[var(--bg-hover)]"
                        >
                          <Ban size={11} />
                          <span>取消</span>
                        </button>
                      </div>
                    )}

                    {state.previewError && (
                      <div
                        role="alert"
                        className="rounded-lg p-2.5 text-[11.5px] text-[var(--accent-rose)]"
                        style={{ backgroundColor: 'var(--accent-rose-soft)' }}
                      >
                        预览失败：{state.previewError}
                      </div>
                    )}

                    {state.previewData && (
                      <div className="space-y-2.5">
                        {state.previewData.existingSessionId && (
                          <div
                            className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[11.5px]"
                            style={{
                              backgroundColor: 'var(--accent-emerald-soft)',
                              color: 'var(--accent-emerald)',
                            }}
                          >
                            <span>
                              检测到既有归档会话：{state.previewData.existingSessionId}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                void openSessionTarget(state.previewData!.existingSessionId!)
                              }
                              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-[var(--bg-surface)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                            >
                              <span>打开既有归档</span>
                              <ExternalLink size={11} />
                            </button>
                          </div>
                        )}

                        {state.previewData.warnings.length > 0 && (
                          <div
                            className="space-y-1 rounded-lg p-2.5 text-[11px]"
                            style={{
                              backgroundColor: 'var(--accent-star-soft)',
                              color: 'var(--accent-star)',
                            }}
                          >
                            {state.previewData.warnings.map((w, idx) => (
                              <div key={idx}>• {w}</div>
                            ))}
                          </div>
                        )}

                        <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                          <span>
                            读取状态：
                            {state.previewData.readStatus === 'complete'
                              ? '完整'
                              : '部分（partial）'}{' '}
                            · {state.previewData.items.length} 条预览消息
                          </span>
                          <span>{state.previewData.importable ? '可导入' : '不可导入'}</span>
                        </div>

                        <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5">
                          {state.previewData.items.length === 0 ? (
                            <p className="text-[11.5px] text-[var(--text-muted)]">
                              暂无预览文本条目。
                            </p>
                          ) : (
                            state.previewData.items.map((msg) => (
                              <div
                                key={msg.itemId}
                                className="rounded-md bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11.5px]"
                              >
                                <div className="mb-0.5 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                                  <span className="font-semibold uppercase">{msg.role}</span>
                                  {msg.timestamp && <span>{formatRelativeTime(msg.timestamp)}</span>}
                                </div>
                                <p className="line-clamp-3 whitespace-pre-wrap text-[var(--text-secondary)]">
                                  {msg.text}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}

                    {state.importStatusNote && (
                      <div className="rounded-lg bg-[var(--bg-surface)] px-3 py-2 text-[11.5px] text-[var(--text-secondary)]">
                        {state.importStatusNote}
                      </div>
                    )}

                    {state.importError && (
                      <div
                        role="alert"
                        className="rounded-lg p-2.5 text-[11.5px] text-[var(--accent-rose)]"
                        style={{ backgroundColor: 'var(--accent-rose-soft)' }}
                      >
                        导入出错：{state.importError}
                      </div>
                    )}

                    {state.commitResult && (
                      <div
                        data-testid="import-commit-result"
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-[12px]"
                        style={{
                          backgroundColor: 'var(--accent-emerald-soft)',
                          color: 'var(--accent-emerald)',
                        }}
                      >
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 size={14} />
                          <span>
                            {state.commitResult.disposition === 'reused'
                              ? '已复用归档'
                              : '已新建归档'}
                            ：
                            <code className="ml-1 font-mono-code">
                              {state.commitResult.sessionId}
                            </code>
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void openSessionTarget(state.commitResult!.sessionId)}
                          className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-[var(--bg-surface)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                        >
                          <span>打开会话</span>
                          <ExternalLink size={11} />
                        </button>
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                      {state.importing ? (
                        <button
                          type="button"
                          onClick={() => controller.cancelActiveOp()}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] px-3.5 py-2 text-[12px] font-medium text-[var(--accent-rose)] hover:bg-[var(--bg-hover)]"
                        >
                          <Ban size={13} />
                          <span>取消提交</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            state.previewLoading ||
                            (state.previewData ? !state.previewData.importable : false) ||
                            (!activeImportInstanceId && !hasLegacyExplorerFallback)
                          }
                          onClick={() => void handleCommitImport()}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-medium text-white disabled:opacity-40"
                          style={{ backgroundColor: 'var(--accent-indigo)' }}
                        >
                          <Upload size={13} />
                          <span>
                            {state.importError
                              ? '重试导入'
                              : importMode === 'mirror'
                                ? '提交镜像导入'
                                : '提交接管导入'}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    导出当前会话为 Portable JSON Bundle v2
                  </h4>
                  <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                    {selectedSession
                      ? `当前会话：${selectedSession.title}`
                      : '请先选中一个会话后再执行导出'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!selectedSession || bundleBusy}
                  onClick={() => void handleExportBundle()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12px] font-medium text-white disabled:opacity-40"
                  style={{ backgroundColor: 'var(--accent-indigo)' }}
                >
                  <Download size={13} />
                  <span>导出 Bundle</span>
                </button>
              </div>
              <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={redactExport}
                  onChange={(e) => setRedactExport(e.target.checked)}
                />
                <ShieldCheck size={13.5} className="text-[var(--accent-emerald)]" />
                <span>启用隐私脱敏（自动屏蔽 API 密钥、Token 与本机用户名绝对路径）</span>
              </label>
            </div>

            <div className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-4">
              <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                <Upload size={14} className="text-[var(--accent-indigo)]" />
                <span>从 Portable JSON Bundle v2 还原会话</span>
              </h4>
              <textarea
                rows={7}
                value={bundleJsonInput}
                onChange={(e) => setBundleJsonInput(e.target.value)}
                placeholder='粘贴导出的 PortableSessionBundleV2 JSON 内容（"bundleVersion": 2）...'
                className="w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 font-mono-code text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-[var(--text-secondary)]">
                  {bundleStatus ?? ''}
                </span>
                <button
                  type="button"
                  disabled={!bundleJsonInput.trim() || bundleBusy}
                  onClick={() => void handleImportBundleSubmit()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                  style={{ backgroundColor: 'var(--accent-emerald)' }}
                >
                  <Upload size={13} />
                  <span>完整还原会话</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
