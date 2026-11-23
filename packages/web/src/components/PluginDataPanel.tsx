import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PluginDataPanel as PanelDefinition, PluginPanelField, PluginPanelQuery, PluginPanelSnapshot, PluginTurnEvent, PluginTurnRow } from '@harnessmate/protocol';
import { daemonApi } from '../api/client';
import { formatPluginSummary, pluginEventLabels, type ActivePluginPanel } from '../lib/plugin-panels';
import { useAppStore } from '../stores/app-store';

const inputClass = 'min-w-0 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1';
const buttonClass = `${inputClass} hover:bg-[var(--bg-hover)] disabled:opacity-40`;
const results = { pass: '通过', fail: '失败', unknown: '待确认' };

function renderField(field: PluginPanelField, row: PluginTurnRow) {
  switch (field) {
    case 'time': return new Date(row.timestamp).toLocaleString();
    case 'session': return row.sessionTitle;
    case 'harness': return row.harnessId ?? '未知';
    case 'status': return `${pluginEventLabels[row.event]}${row.imported ? ' · 已导入' : ''}`;
    case 'changed_files': return row.files?.length ? row.files.map((file) => <code className="block break-all" key={file}>{file}</code>) : '暂无记录';
    case 'verifications': return row.verifications?.length ? row.verifications.map(({ command, status }, index) => (
      <div key={index}>{results[status]} · <code className="break-words">{command}</code></div>
    )) : '待确认';
  }
}

export function PluginDataPanel({ sessionId, contribution }: { sessionId: string; contribution: ActivePluginPanel }) {
  const { pluginId, panel } = contribution;
  const { selectSession, focusTurn, pushToast } = useAppStore();
  const loadSnapshot = useCallback((query: PluginPanelQuery, signal: AbortSignal) =>
    daemonApi.getPluginPanel(sessionId, pluginId, panel.id, query, signal), [sessionId, pluginId, panel.id]);
  const onOpenTurn = async (row: PluginTurnRow) => {
    if (row.sessionId !== sessionId) await selectSession(row.sessionId);
    if (useAppStore.getState().selectedSessionId === row.sessionId) focusTurn(row);
  };
  const copySummary = async (data: PluginPanelSnapshot) => {
    try {
      await navigator.clipboard.writeText(formatPluginSummary(panel.title, data));
      pushToast({ kind: 'success', title: '已复制轮次摘要' });
    } catch (err) {
      pushToast({ kind: 'error', title: '复制失败', body: err instanceof Error ? err.message : String(err) });
    }
  };
  return <PluginPanelView panel={panel} loadSnapshot={loadSnapshot} refreshInterval={4_000}
    onOpenTurn={onOpenTurn} onCopySummary={copySummary} />;
}

export function PluginPanelView({ panel, loadSnapshot, refreshInterval, onOpenTurn, onCopySummary }: {
  panel: PanelDefinition;
  loadSnapshot: (query: PluginPanelQuery, signal: AbortSignal) => Promise<PluginPanelSnapshot>;
  refreshInterval?: number;
  onOpenTurn?: (row: PluginTurnRow) => Promise<void>;
  onCopySummary?: (data: PluginPanelSnapshot) => Promise<void>;
}) {
  const [harnessId, setHarnessId] = useState('');
  const [event, setEvent] = useState<PluginTurnEvent | ''>(panel.defaultEvent ?? '');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<PluginPanelSnapshot>();
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(undefined);
    setError('');
    const query: PluginPanelQuery = { harnessId: harnessId || undefined, event: event || undefined, offset };
    const refresh = async () => {
      try {
        const result = await loadSnapshot(query, controller.signal);
        if (controller.signal.aborted) return;
        if (query.offset > 0 && query.offset >= result.total) setOffset(0);
        setData(result);
        setError('');
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted && refreshInterval) timer = setTimeout(() => void refresh(), refreshInterval);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loadSnapshot, refreshInterval, harnessId, event, offset]);

  const harnesses = [...new Set(data?.counts.flatMap((row) => row.harnessId ? [row.harnessId] : []))].sort();
  if (harnessId && !harnesses.includes(harnessId)) harnesses.push(harnessId);

  return (
    <section className="space-y-3 text-[12px] text-[var(--text-primary)]">
      {panel.description && <p className="text-[var(--text-secondary)]">{panel.description}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {panel.filters?.includes('harness') && <select aria-label="筛选 Harness" className={inputClass} value={harnessId}
          onChange={(change) => { setHarnessId(change.target.value); setOffset(0); }}>
          <option value="">所有 Harness</option>
          {harnesses.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>}
        {panel.filters?.includes('status') && <select aria-label="筛选轮次状态" className={inputClass} value={event}
          onChange={(change) => { setEvent(change.target.value as PluginTurnEvent | ''); setOffset(0); }}>
          <option value="">所有状态</option>
          {Object.entries(pluginEventLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>}
        {panel.copySummary && <button type="button" className={buttonClass} disabled={!data || !onCopySummary}
          onClick={() => { if (data) void onCopySummary?.(data); }}>{panel.copySummary.label}</button>}
      </div>
      {panel.counts && data && <p className="whitespace-pre-line text-[var(--text-secondary)]">
        {formatPluginSummary(data.scope === 'workspace' ? '工作区轮次统计' : '会话轮次统计', data)}
      </p>}
      {error && <p role="alert" className="text-[var(--accent-rose)]">{error}</p>}
      {!data && !error && <p role="status">正在读取插件数据…</p>}
      {data && data.rows.length === 0 && <p>暂无符合条件的轮次。</p>}
      {data && data.rows.map((row) => (
        <article key={`${row.sessionId}:${row.turnId}`} className="space-y-2 rounded-lg border border-[var(--border-hairline)] p-2.5">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {panel.columns.map(({ field, label }) => <Field key={field} label={label}>{renderField(field, row)}</Field>)}
          </dl>
          {panel.openTurn && <button type="button" className={buttonClass} disabled={!onOpenTurn}
            onClick={() => void onOpenTurn?.(row)}>定位到轮次</button>}
        </article>
      ))}
      {data && data.total > data.pageSize && <div className="flex items-center justify-between gap-2" aria-label="插件数据分页">
        <button type="button" className={buttonClass} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}>上一页</button>
        <span>{offset + 1}–{Math.min(offset + data.pageSize, data.total)} / {data.total}</span>
        <button type="button" className={buttonClass} disabled={offset + data.pageSize >= data.total} onClick={() => setOffset(offset + data.pageSize)}>下一页</button>
      </div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-[var(--text-secondary)]">{label}</dt><dd className="min-w-0 break-words">{children}</dd></>;
}
