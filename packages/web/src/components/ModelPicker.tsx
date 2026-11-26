import type { HarnessModelInfo } from '@harnessmate/protocol';
import { Check, ChevronDown, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { daemonApi } from '../api/client';
import { useAppStore } from '../stores/app-store';

export function ModelPicker({
  models: driverModels,
  value,
  defaultModelId: driverDefaultModelId,
  sessionId,
  harnessInstanceId,
  disabled,
  placement = 'top',
  onChange,
}: {
  models: HarnessModelInfo[];
  value: string | null;
  defaultModelId?: string | null;
  sessionId?: string;
  harnessInstanceId?: string;
  disabled?: boolean;
  placement?: 'top' | 'bottom';
  onChange: (modelId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof daemonApi.getModelCandidates>>>();
  const plugins = useAppStore((state) => state.plugins);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCatalog(undefined);
    if (!open || !sessionId || !harnessInstanceId) return;
    const controller = new AbortController();
    void daemonApi.getModelCandidates(sessionId, controller.signal).then((response) => {
      if (!controller.signal.aborted && response.harnessInstanceId === harnessInstanceId) setCatalog(response);
    }).catch(() => {});
    return () => controller.abort();
  }, [open, sessionId, harnessInstanceId, plugins]);

  const models = catalog?.models ?? driverModels;
  const defaultModelId = catalog ? catalog.defaultModelId : driverDefaultModelId;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === value) ?? null,
    [models, value],
  );

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q) ||
            (m.group ?? '').toLowerCase().includes(q) ||
            (m.description ?? '').toLowerCase().includes(q),
        )
      : models;

    const map = new Map<string, HarnessModelInfo[]>();
    for (const m of filtered) {
      const grp = m.group || '可用模型';
      const arr = map.get(grp) ?? [];
      arr.push(m);
      map.set(grp, arr);
    }
    return Array.from(map.entries());
  }, [models, query]);

  const buttonLabel = selectedModel
    ? selectedModel.displayName
    : value
      ? value
      : defaultModelId
        ? `默认 (${models.find((m) => m.id === defaultModelId)?.displayName ?? defaultModelId})`
        : 'CLI 默认模型';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          setQuery('');
        }}
        className="inline-flex max-w-[230px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: `1px solid ${open ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
        }}
      >
        <Sparkles size={11.5} className="shrink-0 text-[var(--accent-indigo)]" />
        <span className="truncate">{buttonLabel}</span>
        <ChevronDown size={11.5} className="shrink-0 text-[var(--text-muted)]" />
      </button>

      {open && (
        <div
          className={`animate-fade-up absolute left-0 z-50 w-[330px] overflow-hidden rounded-2xl ${
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-1.5'
          }`}
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow-float)',
          }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{ borderBottom: '1px solid var(--border-hairline)' }}
          >
            <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索 ${models.length} 个实时探测模型...`}
              autoFocus
              className="w-full bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
          </div>

          <div className="max-h-[300px] overflow-y-auto p-1.5">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
              style={{
                backgroundColor: value === null ? 'var(--bg-active)' : 'transparent',
                color: value === null ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              }}
            >
              <span>跟随 CLI 默认配置</span>
              {value === null && <Check size={13} />}
            </button>

            {grouped.length === 0 ? (
              <div className="py-6 text-center text-[11.5px] text-[var(--text-muted)]">
                无匹配模型
              </div>
            ) : (
              grouped.map(([groupName, items]) => (
                <div key={groupName} className="mt-2">
                  <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {groupName} ({items.length})
                  </div>
                  {items.map((m) => {
                    const active = value === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          onChange(m.id);
                          setOpen(false);
                        }}
                        className="flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                        style={{
                          backgroundColor: active ? 'var(--bg-active)' : 'transparent',
                        }}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="truncate text-[12.2px] font-medium"
                              style={{
                                color: active ? 'var(--accent-indigo)' : 'var(--text-primary)',
                              }}
                            >
                              {m.displayName}
                            </span>
                            {m.isDefault && (
                              <span
                                className="rounded px-1 py-0.2 text-[9.5px]"
                                style={{
                                  backgroundColor: 'var(--accent-emerald-soft)',
                                  color: 'var(--accent-emerald)',
                                }}
                              >
                                默认
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono-code text-[10.5px] text-[var(--text-muted)]">
                            {m.id}
                          </div>
                        </div>
                        {active && <Check size={13} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" />}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
