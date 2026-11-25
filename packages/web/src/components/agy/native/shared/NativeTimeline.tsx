import { Bot, Brain, ChevronUp, FileDiff, Loader2, ShieldAlert, Terminal, User } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NativeTimelineEntry } from '../../../../lib/native-client';
import { EMPTY_STATE_COPY } from './status-dictionary';

export interface NativeTimelineProps {
  entries: readonly NativeTimelineEntry[];
  scopeLabel?: string;
  loading?: boolean;
  hasMore?: boolean;
  sourceNotProvided?: boolean;
  sourceUnavailableReason?: string;
  onLoadMore?: () => void;
  /** Estimated row height for virtualized windowing (default 74px). */
  rowHeightPx?: number;
  /** Viewport height in pixels (default 360px). */
  viewportHeightPx?: number;
  /** Number of overscan rows above/below viewport (default 6). */
  overscan?: number;
}

export interface VirtualWindowRange {
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  renderedCount: number;
}

/**
 * Pure virtual-window calculation exported for deterministic unit & 10k-item stress tests.
 */
export function computeVirtualWindow(
  totalCount: number,
  scrollTop: number,
  viewportHeightPx: number,
  rowHeightPx: number,
  overscan: number,
): VirtualWindowRange {
  if (totalCount <= 0) {
    return { startIndex: 0, endIndex: 0, topSpacerPx: 0, bottomSpacerPx: 0, renderedCount: 0 };
  }
  const safeRow = Math.max(24, rowHeightPx);
  const safeViewport = Math.max(safeRow, viewportHeightPx);
  const visibleCount = Math.ceil(safeViewport / safeRow);
  const rawStart = Math.floor(Math.max(0, scrollTop) / safeRow);
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(totalCount, rawStart + visibleCount + overscan);
  return {
    startIndex,
    endIndex,
    topSpacerPx: startIndex * safeRow,
    bottomSpacerPx: Math.max(0, totalCount - endIndex) * safeRow,
    renderedCount: endIndex - startIndex,
  };
}

function EntryIcon({ kind, actorKind }: { kind: NativeTimelineEntry['kind']; actorKind: NativeTimelineEntry['actorKind'] }) {
  if (kind === 'thinking') return <Brain size={12.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />;
  if (kind === 'tool') return <Terminal size={12.5} className="text-[var(--accent-star)]" aria-hidden="true" />;
  if (kind === 'diff') return <FileDiff size={12.5} className="text-[var(--accent-emerald)]" aria-hidden="true" />;
  if (kind === 'request') return <ShieldAlert size={12.5} className="text-[var(--accent-star)]" aria-hidden="true" />;
  if (actorKind === 'user') return <User size={12.5} className="text-[var(--text-secondary)]" aria-hidden="true" />;
  return <Bot size={12.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />;
}

/**
 * Virtualized, paginated native activity/agent timeline.
 * Renders only the visible window + overscan so 10,000+ entries remain responsive
 * while preserving scroll anchor and keyboard navigation.
 */
export function NativeTimeline({
  entries,
  scopeLabel,
  loading = false,
  hasMore = false,
  sourceNotProvided = false,
  sourceUnavailableReason,
  onLoadMore,
  rowHeightPx = 76,
  viewportHeightPx = 360,
  overscan = 6,
}: NativeTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  const windowRange = useMemo(
    () => computeVirtualWindow(entries.length, scrollTop, viewportHeightPx, rowHeightPx, overscan),
    [entries.length, scrollTop, viewportHeightPx, rowHeightPx, overscan],
  );

  const visibleSlice = useMemo(
    () => entries.slice(windowRange.startIndex, windowRange.endIndex),
    [entries, windowRange.startIndex, windowRange.endIndex],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (entries.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(entries.length - 1, focusedIndex < 0 ? 0 : focusedIndex + 1);
        setFocusedIndex(next);
        if (scrollRef.current) {
          const targetTop = next * rowHeightPx;
          if (targetTop + rowHeightPx > scrollRef.current.scrollTop + viewportHeightPx) {
            scrollRef.current.scrollTop = targetTop - viewportHeightPx + rowHeightPx;
            setScrollTop(scrollRef.current.scrollTop);
          }
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = Math.max(0, focusedIndex <= 0 ? 0 : focusedIndex - 1);
        setFocusedIndex(next);
        if (scrollRef.current) {
          const targetTop = next * rowHeightPx;
          if (targetTop < scrollRef.current.scrollTop) {
            scrollRef.current.scrollTop = targetTop;
            setScrollTop(scrollRef.current.scrollTop);
          }
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        setFocusedIndex(0);
        if (scrollRef.current) {
          scrollRef.current.scrollTop = 0;
          setScrollTop(0);
        }
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = entries.length - 1;
        setFocusedIndex(last);
        if (scrollRef.current) {
          scrollRef.current.scrollTop = Math.max(0, last * rowHeightPx - viewportHeightPx + rowHeightPx);
          setScrollTop(scrollRef.current.scrollTop);
        }
      }
    },
    [entries.length, focusedIndex, rowHeightPx, viewportHeightPx],
  );

  if (sourceNotProvided) {
    return (
      <div
        data-testid="native-timeline-empty"
        data-empty-kind="source_not_provided"
        className="rounded-xl p-4 text-center text-[12px] text-[var(--text-muted)]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="font-medium text-[var(--text-secondary)]">{EMPTY_STATE_COPY.sourceNotProvided}</div>
        {sourceUnavailableReason && <p className="mt-1 text-[11px]">{sourceUnavailableReason}</p>}
      </div>
    );
  }

  if (entries.length === 0 && !loading) {
    return (
      <div
        data-testid="native-timeline-empty"
        data-empty-kind="no_activity"
        className="rounded-xl p-4 text-center text-[12px] text-[var(--text-muted)]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="font-medium text-[var(--text-secondary)]">{EMPTY_STATE_COPY.noActivityObserved}</div>
        <p className="mt-1 text-[11px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
      </div>
    );
  }

  return (
    <div
      data-testid="native-timeline"
      data-total-entries={entries.length}
      data-rendered-entries={visibleSlice.length}
      className="flex flex-col overflow-hidden rounded-xl"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-[var(--text-muted)]"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <span className="truncate font-medium text-[var(--text-secondary)]">
          {scopeLabel ?? '原生时间线'}
        </span>
        <span className="shrink-0 font-mono-code text-[10px]">
          共 {entries.length} 条{loading ? ' · 加载中…' : ''}
        </span>
      </div>

      {hasMore && onLoadMore && (
        <div className="px-3 py-1.5 text-center" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <button
            type="button"
            disabled={loading}
            onClick={onLoadMore}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <ChevronUp size={11} />}
            <span>加载更早分页</span>
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        role="feed"
        aria-label={scopeLabel ?? '原生事件时间线'}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="overflow-y-auto px-2.5 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
        style={{ height: viewportHeightPx, overflowAnchor: 'none' }}
      >
        {windowRange.topSpacerPx > 0 && (
          <div aria-hidden="true" style={{ height: windowRange.topSpacerPx }} />
        )}

        <div className="space-y-1.5">
          {visibleSlice.map((entry, offset) => {
            const actualIndex = windowRange.startIndex + offset;
            const isFocused = actualIndex === focusedIndex;
            return (
              <article
                key={entry.entryId}
                data-testid="native-timeline-item"
                data-entry-seq={entry.seq}
                aria-posinset={actualIndex + 1}
                aria-setsize={entries.length}
                className="rounded-lg px-2.5 py-2 text-[11.5px]"
                style={{
                  minHeight: Math.max(48, rowHeightPx - 8),
                  backgroundColor: isFocused ? 'var(--bg-active)' : 'var(--bg-elevated)',
                  border: `1px solid ${isFocused ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                }}
              >
                <div className="flex items-center justify-between gap-2 text-[10.5px] text-[var(--text-muted)]">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <EntryIcon kind={entry.kind} actorKind={entry.actorKind} />
                    <span className="truncate font-medium text-[var(--text-primary)]">
                      {entry.title ?? entry.actorLabel ?? entry.kind}
                    </span>
                    {entry.actorLabel && entry.title && (
                      <span className="truncate font-mono-code text-[10px]">· {entry.actorLabel}</span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono-code text-[10px]">#{entry.seq}</span>
                </div>
                {entry.text && (
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                    {entry.text}
                  </p>
                )}
                {entry.diff && (
                  <pre className="mt-1 max-h-24 overflow-auto rounded bg-[var(--code-bg)] p-1.5 font-mono-code text-[10.5px] text-[var(--accent-emerald)]">
                    {entry.diff}
                  </pre>
                )}
              </article>
            );
          })}
        </div>

        {windowRange.bottomSpacerPx > 0 && (
          <div aria-hidden="true" style={{ height: windowRange.bottomSpacerPx }} />
        )}
      </div>
    </div>
  );
}
