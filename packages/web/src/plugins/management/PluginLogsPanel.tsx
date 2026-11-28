import type { InstalledPluginInfo, PluginLogEntryDto } from '@harnessmate/protocol';
import { Copy, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { daemonApi } from '../../api/client';
import { useManagementStore as useAppStore } from './store';

const LEVEL_COLORS: Record<PluginLogEntryDto['level'], string> = {
  debug: 'var(--text-muted)',
  info: 'var(--accent-indigo)',
  warn: 'var(--accent-star)',
  error: 'var(--accent-rose)',
};

export function PluginLogsPanel({
  plugins,
  initialPluginId,
}: {
  plugins: InstalledPluginInfo[];
  initialPluginId?: string;
}) {
  const { pushToast } = useAppStore();
  const [selectedPluginId, setSelectedPluginId] = useState<string>(initialPluginId ?? '');
  const [levelFilter, setLevelFilter] = useState<'all' | PluginLogEntryDto['level']>('all');
  const [query, setQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<PluginLogEntryDto[]>([]);

  useEffect(() => {
    if (initialPluginId !== undefined) setSelectedPluginId(initialPluginId);
  }, [initialPluginId]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await daemonApi.getPluginLogs(selectedPluginId || undefined);
      setLogs(res.logs);
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '无法读取插件日志',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [selectedPluginId, pushToast]);

  useEffect(() => {
    void loadLogs();
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void loadLogs();
    }, 2500);
    return () => clearInterval(timer);
  }, [loadLogs, autoRefresh]);

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((entry) => {
      if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
      if (!q) return true;
      return (
        entry.message.toLowerCase().includes(q) ||
        entry.pluginId.toLowerCase().includes(q) ||
        (entry.meta && JSON.stringify(entry.meta).toLowerCase().includes(q))
      );
    });
  }, [logs, levelFilter, query]);

  const handleClear = async () => {
    try {
      await daemonApi.clearPluginLogs(selectedPluginId || undefined);
      setLogs([]);
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '清空日志失败',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleCopy = async () => {
    const text = filteredLogs
      .map(
        (entry) =>
          `${new Date(entry.timestamp).toISOString()} [${entry.level.toUpperCase()}] [${entry.pluginId}/${entry.runId.slice(0, 8)}] ${entry.message}${entry.meta ? ` ${JSON.stringify(entry.meta)}` : ''}`,
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ kind: 'success', title: `已复制 ${filteredLogs.length} 条插件日志` });
    } catch (err) {
      pushToast({ kind: 'error', title: '复制失败', body: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="筛选插件日志"
          value={selectedPluginId}
          onChange={(e) => setSelectedPluginId(e.target.value)}
          className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1.5 text-[11.5px] text-[var(--text-primary)]"
        >
          <option value="">全部插件</option>
          {plugins
            .filter((p) => !p.builtin)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
        </select>

        <select
          aria-label="筛选日志级别"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as typeof levelFilter)}
          className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1.5 text-[11.5px] text-[var(--text-primary)]"
        >
          <option value="all">全部级别</option>
          <option value="debug">DEBUG</option>
          <option value="info">INFO</option>
          <option value="warn">WARN</option>
          <option value="error">ERROR</option>
        </select>

        <div className="flex min-w-[160px] flex-1 items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1">
          <Search size={12} className="text-[var(--text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="过滤日志关键词..."
            className="w-full bg-transparent text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>

        <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          自动刷新
        </label>

        <button
          type="button"
          onClick={() => void loadLogs()}
          disabled={loading}
          title="手动刷新"
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          <RefreshCw size={11.5} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={filteredLogs.length === 0}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
        >
          <Copy size={11.5} />
          复制
        </button>
        <button
          type="button"
          onClick={() => void handleClear()}
          disabled={logs.length === 0}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--accent-rose)] hover:bg-[var(--accent-rose-soft)] disabled:opacity-40"
        >
          <Trash2 size={11.5} />
          清空
        </button>
      </div>

      <div
        className="max-h-[360px] space-y-1.5 overflow-y-auto rounded-xl p-2.5 font-mono-code text-[11px]"
        style={{
          backgroundColor: 'var(--code-bg)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        {filteredLogs.length === 0 ? (
          <p className="py-8 text-center font-sans text-[12px] text-[var(--text-muted)]">
            暂无插件日志（隔离插件通过 ctx.logger 或宿主热重载产生日志）
          </p>
        ) : (
          [...filteredLogs].reverse().map((entry, idx) => (
            <div
              key={`${entry.timestamp}:${entry.pluginId}:${idx}`}
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="text-[var(--text-muted)]">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className="rounded px-1 py-0.5 font-semibold uppercase"
                  style={{ color: LEVEL_COLORS[entry.level], backgroundColor: 'var(--bg-elevated)' }}
                >
                  {entry.level}
                </span>
                <span className="text-[var(--text-secondary)]">{entry.pluginId}</span>
                <span className="rounded bg-[var(--bg-elevated)] px-1 py-0.5 text-[var(--text-muted)]">
                  {entry.source === 'host' ? '宿主' : `run:${entry.runId.slice(0, 8)}`}
                </span>
              </div>
              <div className="mt-1 break-words whitespace-pre-wrap text-[11.5px] text-[var(--text-primary)]">
                {entry.message}
              </div>
              {entry.meta && Object.keys(entry.meta).length > 0 && (
                <pre className="mt-1 overflow-x-auto text-[10px] text-[var(--text-muted)]">
                  {JSON.stringify(entry.meta, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
