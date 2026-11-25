import {
  AlertTriangle,
  Compass,
  Lock,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CapabilityDescriptor, CommandLane } from '../../../../lib/native-client';
import { EntityStatusBadge } from '../shared/EntityStatusBadge';
import {
  COMMAND_LANE_META,
  buildNativeCommandItems,
  searchNativeCommandItems,
  type NativeCommandPaletteItem,
} from './command-catalog';

export interface AgyNativeCommandPaletteProps {
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly catalogRevision: number;
  readonly profileVerified?: boolean;
  readonly initialQuery?: string;
  readonly preservedDraftText?: string;
  readonly preservedAttachmentCount?: number;
  readonly conflictMessage?: string;
  readonly onSelectCommand: (item: NativeCommandPaletteItem) => void;
  readonly onRefreshCapabilities?: () => void;
  readonly onClose?: () => void;
}

function LaneIcon({ lane }: { lane: CommandLane }) {
  switch (lane) {
    case 'query':
      return <Search size={12} className="text-[var(--accent-indigo)]" aria-hidden="true" />;
    case 'config':
      return <SlidersHorizontal size={12} className="text-[var(--accent-emerald)]" aria-hidden="true" />;
    case 'live_workflow':
      return <Sparkles size={12} className="text-[var(--accent-indigo)]" aria-hidden="true" />;
    case 'manager':
      return <Compass size={12} className="text-[var(--text-secondary)]" aria-hidden="true" />;
  }
}

/**
 * AGY Native Command Palette (NP-06).
 * - Driven by the exact same `CapabilityDescriptor[]` source as `AgyNativeModePicker`.
 * - Supports `/` search, lane filters, parameter hints, disabled reasons, and official entry hints.
 * - Selecting an item stages it into the Composer draft; NEVER executes immediately on click
 *   and NEVER forwards raw user input to a shell.
 * - Preserves draft text & attachments across catalog revision refreshes and 409 conflicts.
 */
export function AgyNativeCommandPalette({
  descriptors,
  catalogRevision,
  profileVerified = false,
  initialQuery = '',
  preservedDraftText,
  preservedAttachmentCount = 0,
  conflictMessage,
  onSelectCommand,
  onRefreshCapabilities,
  onClose,
}: AgyNativeCommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [laneFilter, setLaneFilter] = useState<CommandLane | 'all'>('all');
  const [activeIndex, setActiveIndex] = useState(0);

  const allItems = useMemo(
    () => buildNativeCommandItems(descriptors, { profileVerified }),
    [descriptors, profileVerified],
  );
  const filtered = useMemo(
    () => searchNativeCommandItems(allItems, query, laneFilter),
    [allItems, query, laneFilter],
  );
  const safeIndex = filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1);

  return (
    <section
      aria-label="AGY 原生命令目录"
      data-testid="agy-native-command-palette"
      className="w-full max-w-[460px] overflow-hidden rounded-2xl border p-2 text-[12px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-strong)',
        boxShadow: 'var(--shadow-float)',
      }}
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
          <Terminal size={12.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
          <span>AGY 原生命令目录</span>
          <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.2 font-mono-code text-[10px] text-[var(--text-muted)]">
            rev #{catalogRevision}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {onRefreshCapabilities && (
            <button
              type="button"
              onClick={onRefreshCapabilities}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <RefreshCw size={10.5} aria-hidden="true" />
              刷新目录
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              关闭
            </button>
          )}
        </div>
      </div>

      {conflictMessage && (
        <div
          role="status"
          data-testid="agy-command-conflict-banner"
          className="mb-2 flex items-start gap-2 rounded-xl border px-2.5 py-2 text-[11px]"
          style={{
            backgroundColor: 'var(--accent-star-soft)',
            borderColor: 'var(--accent-star)',
            color: 'var(--text-primary)',
          }}
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--accent-star)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div>{conflictMessage}</div>
            {(preservedDraftText || preservedAttachmentCount > 0) && (
              <div className="mt-0.5 text-[10.5px] text-[var(--text-secondary)]">
                草稿已保留{preservedDraftText ? `（${preservedDraftText.length} 字符` : '（'}
                {preservedAttachmentCount > 0 ? `${preservedDraftText ? ' · ' : ''}${preservedAttachmentCount} 个附件` : ''}
                ）
              </div>
            )}
          </div>
        </div>
      )}

      <div className="relative mb-2">
        <Search
          size={13}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          aria-label="搜索原生命令"
          placeholder="输入 / 命令、模式或能力编号检索（选择仅填充草稿）…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && filtered.length > 0) {
              e.preventDefault();
              setActiveIndex((prev) => (prev + 1) % filtered.length);
            } else if (e.key === 'ArrowUp' && filtered.length > 0) {
              e.preventDefault();
              setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
            } else if (e.key === 'Enter' && safeIndex >= 0) {
              const target = filtered[safeIndex];
              if (target?.runnable) {
                e.preventDefault();
                onSelectCommand(target);
              }
            } else if (e.key === 'Escape' && onClose) {
              e.preventDefault();
              onClose();
            }
          }}
          className="h-8 w-full rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] pr-2.5 pl-8 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
        />
      </div>

      <div className="mb-2 flex flex-wrap gap-1 px-0.5" role="tablist" aria-label="按命令通道筛选">
        {(['all', 'live_workflow', 'config', 'query', 'manager'] as const).map((lane) => {
          const active = laneFilter === lane;
          const label = lane === 'all' ? '全部' : COMMAND_LANE_META[lane].shortLabel;
          return (
            <button
              key={lane}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setLaneFilter(lane);
                setActiveIndex(0);
              }}
              className="cursor-pointer rounded-lg border px-2 py-0.5 text-[10.5px] font-medium transition-colors"
              style={{
                backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                borderColor: active ? 'var(--border-focus)' : 'var(--border-hairline)',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div role="listbox" aria-label="匹配的原生命令" className="max-h-[300px] space-y-1 overflow-y-auto pr-0.5">
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-4 text-center text-[11px] text-[var(--text-muted)]">
            未找到匹配的 AGY 原生命令（未知 slash 不会直接发送到 shell）
          </div>
        ) : (
          filtered.map((item, idx) => {
            const focused = idx === safeIndex;
            const laneMeta = COMMAND_LANE_META[item.lane];
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={focused}
                aria-disabled={!item.runnable}
                data-command-id={item.id}
                className="rounded-xl border p-2 transition-colors"
                style={{
                  backgroundColor: focused ? 'var(--bg-active)' : 'var(--bg-elevated)',
                  borderColor: focused ? 'var(--border-focus)' : 'var(--border-hairline)',
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    disabled={!item.runnable}
                    onClick={() => {
                      if (!item.runnable) return;
                      onSelectCommand(item);
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col text-left disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <LaneIcon lane={item.lane} />
                      <span className="font-mono-code text-[11.5px] font-semibold text-[var(--text-primary)]">
                        {item.command}
                      </span>
                      {item.argumentHint && (
                        <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                          {item.argumentHint}
                        </span>
                      )}
                      <span className="rounded bg-[var(--bg-surface)] px-1 py-0.2 text-[9.5px] text-[var(--text-muted)]">
                        {laneMeta.shortLabel}
                      </span>
                      {item.tierHint && (
                        <span className="rounded bg-[var(--bg-surface)] px-1 py-0.2 font-mono-code text-[9.5px] text-[var(--text-muted)]">
                          {item.tierHint}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                      {item.title} · {item.description}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {!item.runnable && (
                      <Lock size={10.5} className="text-[var(--accent-clay)]" aria-hidden="true" />
                    )}
                    <EntityStatusBadge kind="gate" gate={item.gate} compact />
                  </div>
                </div>

                {item.disabledReason && (
                  <div
                    data-testid={`disabled-reason-${item.id}`}
                    className="mt-1 rounded-lg bg-[var(--bg-surface)] px-2 py-1 text-[10.5px] text-[var(--accent-clay)]"
                  >
                    禁用原因：{item.disabledReason}
                  </div>
                )}

                <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                  <span>{item.officialEntry}</span>
                  <span className="font-mono-code">
                    {item.capabilityId} · rev #{item.snapshotRevision}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-[var(--border-hairline)] px-1 pt-1.5 text-[10px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <Settings2 size={10.5} aria-hidden="true" />
          选择命令仅填充输入草稿，发送时经原生命令路由校验
        </span>
      </div>
    </section>
  );
}
