import type { TerminalContextChip } from '@harnessmate/protocol';
import { ChevronDown, ChevronRight, Terminal, X } from 'lucide-react';
import { useState } from 'react';

export interface TerminalContextInlineChipProps {
  chip: TerminalContextChip;
  onRemove: (chipId: string) => void;
  defaultExpanded?: boolean;
}

export function TerminalContextInlineChip({
  chip,
  onRemove,
  defaultExpanded = false,
}: TerminalContextInlineChipProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const lineSummary = `${chip.terminalTitle} · lines ${chip.lineStart}–${chip.lineEnd}`;
  const exitBadge =
    chip.exitCode !== null && chip.exitCode !== undefined ? `exit ${chip.exitCode}` : null;

  return (
    <div
      data-testid={`terminal-context-chip-${chip.id}`}
      className="flex flex-col rounded-xl text-[11.5px]"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid color-mix(in srgb, var(--accent-indigo) 36%, var(--border-hairline))',
      }}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1">
        <Terminal size={12.5} className="shrink-0 text-[var(--accent-indigo)]" />
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          title={`${chip.cwd} — 点击展开或收起纯文本预览`}
          className="inline-flex cursor-pointer items-center gap-1 font-mono-code text-[11px] font-medium text-[var(--text-primary)] hover:text-[var(--accent-indigo)]"
        >
          <span>{lineSummary}</span>
          {exitBadge && (
            <span
              className="rounded px-1 py-0.2 text-[9.5px]"
              style={{
                backgroundColor:
                  chip.exitCode === 0 ? 'var(--accent-emerald-soft)' : 'var(--accent-rose-soft)',
                color: chip.exitCode === 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)',
              }}
            >
              {exitBadge}
            </span>
          )}
          {chip.truncated && (
            <span
              className="rounded px-1 py-0.2 text-[9.5px]"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                color: 'var(--accent-star)',
              }}
            >
              截断 ≤16KB
            </span>
          )}
          {expanded ? <ChevronDown size={11.5} /> : <ChevronRight size={11.5} />}
        </button>
        <button
          type="button"
          aria-label={`移除终端上下文 ${chip.terminalTitle}`}
          onClick={() => onRemove(chip.id)}
          className="cursor-pointer rounded-full p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-rose)]"
        >
          <X size={12} />
        </button>
      </div>

      {expanded && (
        <div
          data-testid={`terminal-context-chip-preview-${chip.id}`}
          className="border-t border-[var(--border-hairline)] px-2.5 py-2"
        >
          <div className="mb-1 truncate font-mono-code text-[10px] text-[var(--text-muted)]">
            CWD: {chip.cwd}
          </div>
          <pre
            className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 font-mono-code text-[10.5px] leading-relaxed text-[var(--text-secondary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            {chip.cleanText}
          </pre>
        </div>
      )}
    </div>
  );
}

export interface ComposerPendingTerminalContextsProps {
  chips: readonly TerminalContextChip[];
  onRemove: (chipId: string) => void;
  defaultExpandedIds?: readonly string[];
}

export function ComposerPendingTerminalContexts({
  chips,
  onRemove,
  defaultExpandedIds,
}: ComposerPendingTerminalContextsProps) {
  if (chips.length === 0) return null;

  return (
    <div
      data-testid="composer-terminal-chips"
      className="mb-2 flex flex-wrap items-start gap-2 px-2 pt-1"
    >
      {chips.map((chip) => (
        <TerminalContextInlineChip
          key={chip.id}
          chip={chip}
          onRemove={onRemove}
          defaultExpanded={Boolean(defaultExpandedIds?.includes(chip.id))}
        />
      ))}
    </div>
  );
}
