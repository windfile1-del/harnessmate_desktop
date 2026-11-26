import type {
  DiscoveredCliSession,
  HarnessInfo,
  PortableSessionBundleV2,
  Session,
  SessionSearchHit,
  Workspace,
} from '@harnessmate/protocol';
import {
  Archive,
  Download,
  FileJson,
  FolderSearch,
  History,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { daemonApi } from '../api/client';
import { formatRelativeTime } from '../lib/harness-meta';
import { useAppStore } from '../stores/app-store';

type ExplorerTab = 'search' | 'import' | 'bundle';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders highlighted search snippets safely via React text nodes (ZERO dangerouslySetInnerHTML).
 */
export function SafeHighlightedSnippet({
  text,
  highlights,
}: {
  text: string;
  highlights?: Array<{ start: number; end: number }>;
}) {
  if (!highlights || highlights.length === 0) {
    return <span>{text}</span>;
  }
  const parts: Array<{ key: string; content: string; match: boolean }> = [];
  let cursor = 0;
  for (const span of highlights) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) {
      parts.push({ key: `t-${cursor}`, content: text.slice(cursor, start), match: false });
    }
    if (end > start) {
      parts.push({ key: `m-${start}`, content: text.slice(start, end), match: true });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push({ key: `t-${cursor}`, content: text.slice(cursor), match: false });
  }
  return (
    <span>
      {parts.map((part) =>
        part.match ? (
          <mark
            key={part.key}
            className="rounded px-0.5 font-medium"
            style={{
              backgroundColor: 'var(--accent-star-soft)',
              color: 'var(--accent-star)',
            }}
          >
            {part.content}
          </mark>
        ) : (
          <span key={part.key}>{part.content}</span>
        ),
      )}
    </span>
  );
}

export function SessionExplorerView({
  workspaces,
  harnesses,
  sessions,
  selectedSession,
  initialTab = 'search',
  initialQuery = '',
  initialHits = [],
  initialDiscovered = [],
  onJumpToHit,
  onImportNative,
  onImportBundle,
  onClose,
}: {
  workspaces: Workspace[];
  harnesses: HarnessInfo[];
  sessions: Session[];
  selectedSession: Session | null;
  initialTab?: ExplorerTab;
  initialQuery?: string;
  initialHits?: SessionSearchHit[];
  initialDiscovered?: DiscoveredCliSession[];
  onJumpToHit: (hit: SessionSearchHit) => void;
  onImportNative: (
    item: DiscoveredCliSession,
    mode: 'mirror' | 'attach',
    workspaceId?: string,
  ) => Promise<void>;
  onImportBundle: (bundle: PortableSessionBundleV2, workspaceId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ExplorerTab>(initialTab);
  const [query, setQuery] = useState(initialQuery);
  const searchRequest = useRef(0);
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SessionSearchHit[]>(initialHits);
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [reindexing, setReindexing] = useState(false);

  const [discovered, setDiscovered] = useState<DiscoveredCliSession[]>(initialDiscovered);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [importMode, setImportMode] = useState<'mirror' | 'attach'>('mirror');
  const [importWorkspaceId, setImportWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [importingId, setImportingId] = useState<string | null>(null);

  const [redactExport, setRedactExport] = useState(true);
  const [bundleJsonInput, setBundleJsonInput] = useState('');
  const [bundleStatus, setBundleStatus] = useState<string | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);

  const runSearch = async (qStr = query) => {
    const request = ++searchRequest.current;
    const trimmed = qStr.trim();
    if (!trimmed) {
      setHits([]);
      setTookMs(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const res = await daemonApi.searchSessions({
        q: trimmed,
        workspaceId: workspaceFilter || undefined,
        driverId: driverFilter || undefined,
        limit: 40,
      });
      if (request !== searchRequest.current) return;
      setHits(res.hits);
      setFallbackUsed(res.fallbackUsed);
      setTookMs(res.tookMs);
    } catch {
      if (request === searchRequest.current) setHits([]);
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  };

  useEffect(() => {
    if (initialQuery.trim()) void runSearch(initialQuery);
    return () => { searchRequest.current++; };
  }, [initialQuery]);

  const refreshDiscovered = async (forceRefresh = false) => {
    setDiscoverLoading(true);
    try {
      const res = await daemonApi.discoverLocalCliSessions(40, forceRefresh);
      setDiscovered(res.sessions);
    } finally {
      setDiscoverLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'import' && discovered.length === 0) {
      void refreshDiscovered(false);
    }
  }, [tab]);

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
      await onImportBundle(parsed, importWorkspaceId || undefined);
      setBundleJsonInput('');
      setBundleStatus('已从 Portable JSON Bundle v2 完整还原会话');
    } catch (err) {
      setBundleStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBundleBusy(false);
    }
  };

  return (
    <div className="flex max-h-[82vh] flex-col">
      {/* Header */}
      <div
        className="flex items-start justify-between gap-3 px-5 py-4"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div>
          <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-[var(--text-primary)]">
            <FolderSearch size={16} className="text-[var(--accent-indigo)]" />
            <span>Session Explorer · 检索、CLI 导入与便携 Bundle</span>
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            跨工作区 SQLite FTS5 全文搜索、GiB 级安全原生 CLI 导入（支持 .jsonl.zst）与脱敏 JSON 还原
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭 Session Explorer"
          className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div
        className="flex items-center gap-1.5 px-5 py-2.5"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <TabButton
          active={tab === 'search'}
          icon={<Search size={13} />}
          label="FTS5 全文检索"
          onClick={() => setTab('search')}
        />
        <TabButton
          active={tab === 'import'}
          icon={<History size={13} />}
          label="从本机 CLI 导入"
          onClick={() => setTab('import')}
        />
        <TabButton
          active={tab === 'bundle'}
          icon={<FileJson size={13} />}
          label="JSON Bundle v2"
          onClick={() => setTab('bundle')}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'search' && (
          <div className="space-y-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl px-3 py-2"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-strong)',
                }}
              >
                <Search size={14} className="text-[var(--text-muted)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch();
                  }}
                  placeholder="搜索任意历史对话、工具输出、错误信息（自动安全转义 FTS5）..."
                  className="w-full bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                />
              </div>
              <select
                aria-label="按工作区筛选"
                value={workspaceFilter}
                onChange={(e) => setWorkspaceFilter(e.target.value)}
                className="rounded-xl px-2.5 py-2 text-[12px] text-[var(--text-primary)]"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <option value="">全部工作区</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="按引擎筛选"
                value={driverFilter}
                onChange={(e) => setDriverFilter(e.target.value)}
                className="rounded-xl px-2.5 py-2 text-[12px] text-[var(--text-primary)]"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <option value="">全部引擎</option>
                {harnesses.map((h) => (
                  <option key={h.id} value={h.kind}>
                    {h.displayName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={searching}
                onClick={() => void runSearch()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12px] font-medium text-white"
                style={{ backgroundColor: 'var(--accent-indigo)' }}
              >
                {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                <span>检索</span>
              </button>
            </div>

            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>
                {tookMs !== null
                  ? `命中 ${hits.length} 条记录（${tookMs}ms${fallbackUsed ? ' · LIKE 降级' : ' · FTS5'}）`
                  : `共 ${sessions.length} 个已索引逻辑会话`}
              </span>
              <button
                type="button"
                disabled={reindexing}
                onClick={async () => {
                  setReindexing(true);
                  try {
                    await daemonApi.rebuildSearchIndex();
                  } finally {
                    setReindexing(false);
                  }
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 hover:bg-[var(--bg-hover)]"
              >
                <RefreshCw size={11} className={reindexing ? 'animate-spin' : ''} />
                <span>补建索引</span>
              </button>
            </div>

            <div className="space-y-2">
              {hits.length === 0 ? (
                <div className="rounded-xl border border-[var(--border-hairline)] p-6 text-center text-[12px] text-[var(--text-muted)]">
                  输入关键词并回车即可跨工作区全文检索，点击结果直达目标会话与轮次。
                </div>
              ) : (
                hits.map((hit) => (
                  <button
                    key={`${hit.sessionId}:${hit.itemId}`}
                    type="button"
                    onClick={() => onJumpToHit(hit)}
                    className="block w-full cursor-pointer rounded-xl p-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="truncate font-semibold text-[var(--text-primary)]">
                        {hit.sessionTitle}
                      </span>
                      <span className="shrink-0 font-mono-code text-[10.5px] text-[var(--text-muted)]">
                        {hit.driverId} · seq #{hit.turnSeq}
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                      <SafeHighlightedSnippet text={hit.snippetText} highlights={hit.highlights} />
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'import' && (
          <div className="space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[12px]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-[var(--text-primary)]">导入模式：</span>
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={importMode === 'mirror'}
                    onChange={() => setImportMode('mirror')}
                  />
                  <span>只读镜像（安全复刻，不改动原生会话）</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={importMode === 'attach'}
                    onChange={() => setImportMode('attach')}
                  />
                  <span>直接接管续跑（Attach）</span>
                </label>
              </div>
              <button
                type="button"
                disabled={discoverLoading}
                onClick={() => void refreshDiscovered(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                style={{ border: '1px solid var(--border-hairline)' }}
              >
                <RefreshCw size={12} className={discoverLoading ? 'animate-spin' : ''} />
                <span>强制扫描</span>
              </button>
            </div>

            {workspaces.length > 0 && (
              <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
                <span>原目录不可用时的回退工作区：</span>
                <select
                  value={importWorkspaceId}
                  onChange={(e) => setImportWorkspaceId(e.target.value)}
                  className="rounded-lg px-2 py-1 text-[11.5px] text-[var(--text-primary)]"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  {workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-2">
              {discoverLoading && discovered.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-[var(--text-muted)]">
                  <Loader2 size={14} className="animate-spin" />
                  <span>正在以只读模式扫描本机 Codex / Claude / Antigravity 会话...</span>
                </div>
              ) : discovered.length === 0 ? (
                <div className="rounded-xl border border-[var(--border-hairline)] p-6 text-center text-[12px] text-[var(--text-muted)]">
                  未发现可导入的本机外部 CLI 会话。
                </div>
              ) : (
                discovered.map((item) => {
                  const key = `${item.source ?? item.harnessKind}:${item.nativeSessionId}`;
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3 rounded-xl p-3"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
                            {item.title}
                          </span>
                          <span className="rounded-md bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-secondary)]">
                            {item.scannerId ?? item.source ?? item.harnessKind}
                          </span>
                          {item.compressed && (
                            <span
                              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono-code text-[10px]"
                              style={{
                                backgroundColor: 'var(--accent-indigo-soft)',
                                color: 'var(--accent-indigo)',
                              }}
                            >
                              <Archive size={10} />
                              zstd 归档
                            </span>
                          )}
                          {item.alreadyImportedSessionId && (
                            <span
                              className="rounded-md px-1.5 py-0.5 text-[10px]"
                              style={{
                                backgroundColor: 'var(--accent-emerald-soft)',
                                color: 'var(--accent-emerald)',
                              }}
                            >
                              已导入
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono-code text-[10.5px] text-[var(--text-muted)]">
                          <span>{formatBytes(item.fileSizeBytes)}</span>
                          <span>·</span>
                          <span>{formatRelativeTime(item.updatedAt)}</span>
                          {item.cwd && (
                            <>
                              <span>·</span>
                              <span className="truncate">{item.cwd}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={importingId === key}
                        onClick={async () => {
                          setImportingId(key);
                          try {
                            await onImportNative(item, importMode, importWorkspaceId || undefined);
                          } finally {
                            setImportingId(null);
                          }
                        }}
                        className="shrink-0 cursor-pointer rounded-xl px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-50"
                        style={{ backgroundColor: 'var(--accent-indigo)' }}
                      >
                        {importingId === key
                          ? '导入中...'
                          : importMode === 'mirror'
                            ? '镜像导入'
                            : '接管导入'}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {tab === 'bundle' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5">
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

            <div className="space-y-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5">
              <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                <Upload size={14} className="text-[var(--accent-indigo)]" />
                <span>从 Portable JSON Bundle v2 还原会话</span>
              </h4>
              <textarea
                rows={6}
                value={bundleJsonInput}
                onChange={(e) => setBundleJsonInput(e.target.value)}
                placeholder='粘贴导出的 PortableSessionBundleV2 JSON 内容（"bundleVersion": 2）...'
                className="w-full rounded-xl p-2.5 font-mono-code text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] text-[var(--text-secondary)]">{bundleStatus ?? ''}</span>
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

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
      style={{
        backgroundColor: active ? 'var(--bg-active)' : 'transparent',
        color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function SessionExplorerModal({ onClose }: { onClose: () => void }) {
  const {
    workspaces,
    harnesses,
    sessions,
    explorerInitialQuery,
    selectedSessionId,
    selectSession,
    focusTurn,
    importNativeSession,
    importSessionBundle,
    openSessionSearchPage,
    openHistoryImportPage,
    pushToast,
  } = useAppStore();

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  return (
    <div className="flex max-h-[82vh] flex-col">
      <div
        className="flex flex-wrap items-center justify-end gap-2 px-5 py-2 text-[11.5px]"
        style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--bg-elevated)' }}
      >
        <button
          type="button"
          onClick={() => openSessionSearchPage({ query: explorerInitialQuery })}
          className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
        >
          在独立搜索工作页中打开
        </button>
        <button
          type="button"
          onClick={() => openHistoryImportPage()}
          className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
        >
          在独立导入工作页中打开
        </button>
      </div>
      <SessionExplorerView
        workspaces={workspaces}
        harnesses={harnesses}
        sessions={sessions}
        initialQuery={explorerInitialQuery}
        selectedSession={selectedSession}
        onJumpToHit={(hit) => {
          onClose();
          void selectSession(hit.sessionId).then(() => {
            if (hit.turnId) {
              focusTurn({ sessionId: hit.sessionId, turnId: hit.turnId, itemId: hit.itemId });
            }
          });
        }}
      onImportNative={async (item, mode, workspaceId) => {
        try {
          await importNativeSession({
            source: item.source ?? 'custom',
            scannerId: item.scannerId,
            nativeSessionId: item.nativeSessionId,
            workspaceId,
            mode,
          });
          onClose();
        } catch (err) {
          pushToast({
            kind: 'error',
            title: '导入原生会话失败',
            body: err instanceof Error ? err.message : String(err),
          });
        }
      }}
      onImportBundle={async (bundle, workspaceId) => {
        await importSessionBundle({ bundle, workspaceId });
        onClose();
      }}
      onClose={onClose}
    />
    </div>
  );
}
