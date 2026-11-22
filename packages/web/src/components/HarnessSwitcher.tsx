import type { HarnessInfo, Session } from '@harnessmate/protocol';
import { Check, ChevronDown, Layers, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HARNESS_META } from '../lib/harness-meta';

interface HarnessSwitcherProps {
  session: Session;
  harnesses: HarnessInfo[];
  disabled?: boolean;
  placement?: 'top' | 'bottom';
  onSwitch: (targetHarnessId: string) => void;
}

export function HarnessSwitcher({
  session,
  harnesses,
  disabled = false,
  placement = 'top',
  onSwitch,
}: HarnessSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const activeHarness = harnesses.find((h) => h.id === session.harnessId);
  const activeMeta = HARNESS_META[session.harnessKind] ?? HARNESS_META.acp;
  const bindingMap = new Map((session.bindings ?? []).map((b) => [b.harnessId, b]));

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="在同一会话内无缝切换执行引擎（自动同步增量上下文与任务状态）"
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-all hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: `1px solid ${open ? 'var(--border-focus)' : 'color-mix(in srgb, ' + activeMeta.accentColor + ' 38%, var(--border-hairline))'}`,
          color: 'var(--text-primary)',
        }}
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: activeMeta.accentColor }}
        />
        <span className="max-w-[92px] truncate">
          {activeHarness?.displayName ?? activeMeta.shortLabel}
        </span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className={`animate-fade-up absolute left-0 z-50 w-[290px] overflow-hidden rounded-2xl p-1.5 ${
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow-float)',
          }}
        >
          <div
            className="mb-1 flex items-center justify-between px-2.5 py-1.5 text-[10.5px] font-medium text-[var(--text-muted)]"
            style={{ borderBottom: '1px solid var(--border-hairline)' }}
          >
            <span className="inline-flex items-center gap-1.5">
              <Layers size={11.5} className="text-[var(--accent-indigo)]" />
              会话内无缝切换引擎
            </span>
            <span className="font-mono-code text-[10px]">seq #{session.lastSeq}</span>
          </div>

          <div className="max-h-[280px] space-y-1 overflow-y-auto py-0.5">
            {harnesses.map((h) => {
              const isActive = h.id === session.harnessId;
              const meta = HARNESS_META[h.kind] ?? HARNESS_META.acp;
              const binding = bindingMap.get(h.id);
              const syncedSeq = binding?.syncedUpToSeq ?? 0;
              const isWarm = Boolean(binding && syncedSeq > 0);
              const upToDate = isWarm && syncedSeq >= session.lastSeq;
              const ready = h.health === 'ready';

              return (
                <button
                  key={h.id}
                  type="button"
                  disabled={!ready && !isActive}
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) onSwitch(h.id);
                  }}
                  className="flex w-full cursor-pointer items-start justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                  style={{
                    backgroundColor: isActive ? 'var(--bg-active)' : 'transparent',
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: meta.accentColor }}
                      />
                      <span className="truncate text-[12.2px] font-medium text-[var(--text-primary)]">
                        {h.displayName}
                      </span>
                      {!ready && (
                        <span className="rounded px-1 py-0.2 text-[9.5px] text-[var(--accent-rose)]">
                          不可用
                        </span>
                      )}
                    </div>

                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-3.5 text-[10.5px] text-[var(--text-muted)]">
                      {isActive ? (
                        <span style={{ color: 'var(--accent-indigo)' }}>当前执笔引擎</span>
                      ) : upToDate ? (
                        <span style={{ color: 'var(--accent-emerald)' }}>已同步最新上下文</span>
                      ) : isWarm ? (
                        <span className="inline-flex items-center gap-0.5 text-[var(--accent-star)]">
                          <Sparkles size={10} />
                          热记忆 · 增量同步 #{syncedSeq}→#{session.lastSeq}
                        </span>
                      ) : session.lastSeq > 1 ? (
                        <span>自动同步完整上下文 + 任务账本</span>
                      ) : (
                        <span>{h.models.length} 个实时模型</span>
                      )}
                    </div>
                  </div>

                  {isActive && (
                    <Check size={14} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
