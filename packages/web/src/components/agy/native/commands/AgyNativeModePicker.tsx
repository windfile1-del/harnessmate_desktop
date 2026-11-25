import { ChevronDown, Info, Lock, Sparkles } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CapabilityDescriptor } from '../../../../lib/native-client';
import { EntityStatusBadge } from '../shared/EntityStatusBadge';
import { buildNativeModeItems, type NativeModePickerItem } from './command-catalog';

export interface AgyNativeModePickerProps {
  readonly selectedModeId: string;
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly profileVerified?: boolean;
  readonly disabled?: boolean;
  readonly defaultOpen?: boolean;
  readonly onSelectMode: (mode: NativeModePickerItem) => void;
}

/**
 * Descriptor-unified AGY Native Mode Picker (NP-06).
 * - Consumes the EXACT same `buildNativeModeItems(descriptors)` projection as `AgyNativeCommandPalette`.
 * - Displays disabled reasons, tier hints, revision metadata, and official CLI/App entry guidance.
 * - Switching modes preserves draft text & attachments; NEVER executes on select.
 */
export function AgyNativeModePicker({
  selectedModeId,
  descriptors,
  profileVerified = false,
  disabled = false,
  defaultOpen = false,
  onSelectMode,
}: AgyNativeModePickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedInfoId, setExpandedInfoId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const modes = useMemo(
    () => buildNativeModeItems(descriptors, { profileVerified }),
    [descriptors, profileVerified],
  );
  const activeMode = modes.find((m) => m.id === selectedModeId) ?? modes[0]!;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative inline-flex" data-testid="agy-native-mode-picker">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)] disabled:opacity-45"
      >
        <Sparkles size={11.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
        <span>模式: {activeMode.label}</span>
        {!activeMode.runnable && (
          <Lock size={10} className="text-[var(--accent-clay)]" aria-hidden="true" />
        )}
        <ChevronDown size={11} className="text-[var(--text-muted)]" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label="选择 AGY 原生工作模式"
          className="animate-fade-up absolute bottom-full left-0 z-50 mb-2 w-[330px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl p-1.5"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow-float)',
          }}
        >
          <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <span>AGY 工作模式（同源目录 · 保留草稿）</span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              className="cursor-pointer text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              关闭
            </button>
          </div>
          <div className="max-h-[300px] space-y-1 overflow-y-auto p-0.5">
            {modes.map((opt) => {
              const selected = opt.id === activeMode.id;
              const infoExpanded = expandedInfoId === opt.id;
              return (
                <div
                  key={opt.id}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!opt.runnable}
                  data-mode-id={opt.id}
                  className="rounded-xl border p-2 text-[11.5px]"
                  style={{
                    backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                  }}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <button
                      type="button"
                      disabled={!opt.runnable}
                      onClick={() => {
                        if (!opt.runnable) return;
                        onSelectMode(opt);
                        setOpen(false);
                        buttonRef.current?.focus();
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left disabled:cursor-not-allowed disabled:opacity-65"
                    >
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {opt.label}
                      </span>
                      {opt.commandPrefix && (
                        <span className="shrink-0 font-mono-code text-[10px] text-[var(--text-muted)]">
                          {opt.commandPrefix}
                        </span>
                      )}
                      {opt.tierHint && (
                        <span className="shrink-0 rounded bg-[var(--bg-surface)] px-1 py-0.2 font-mono-code text-[9.5px] text-[var(--text-muted)]">
                          {opt.tierHint}
                        </span>
                      )}
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <EntityStatusBadge kind="gate" gate={opt.gate} compact />
                      <button
                        type="button"
                        aria-label={`展开 ${opt.label} 说明`}
                        aria-expanded={infoExpanded}
                        onClick={() => setExpandedInfoId(infoExpanded ? null : opt.id)}
                        className="cursor-pointer rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Info size={12} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">{opt.sourceNote}</div>
                  {opt.disabledReason && (
                    <div className="mt-1 text-[10.5px] text-[var(--accent-clay)]">
                      {opt.disabledReason}
                    </div>
                  )}
                  {infoExpanded && (
                    <div className="mt-1.5 space-y-1 border-t border-[var(--border-hairline)] pt-1.5 text-[11px] text-[var(--text-secondary)]">
                      <p>{opt.description}</p>
                      <p className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                        官方入口：{opt.officialEntry}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
