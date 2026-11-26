import type {
  HarnessInfo,
  Session,
} from '@harnessmate/protocol';
import {
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  Globe,
  Layers,
  Loader2,
  Puzzle,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { daemonApi } from '../api/client';
import {
  formatByteSize,
  resolveHarnessMeta,
} from '../lib/harness-meta';
import type { ProjectedToolCall } from '../lib/projector';
import type {
  ExtensionTurnBlock,
  TimelineMinimapEntry,
  TurnBlock,
  UnknownTurnBlock,
  WorkGroupProjection,
  WorkStepBlock,
} from '../lib/work-groups';
import { Slot } from '../slots';
import { useAppStore } from '../stores/app-store';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── 1. Collapsible WorkGroup Row ───────────────────────────────────────

export function WorkGroupRow({
  session,
  group,
}: {
  session: Session;
  group: WorkGroupProjection;
}) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? !group.collapsedByDefault;

  return (
    <div
      data-testid="work-group-row"
      data-group-status={group.status}
      className="overflow-hidden rounded-xl"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: `1px solid ${
          group.hasErrors
            ? 'color-mix(in srgb, var(--accent-rose) 38%, transparent)'
            : group.status === 'running'
              ? 'color-mix(in srgb, var(--accent-indigo) 38%, transparent)'
              : 'var(--border-hairline)'
        }`,
      }}
    >
      <button
        type="button"
        onClick={() => setUserExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          {group.status === 'running' ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-[var(--accent-indigo)]" />
          ) : group.status === 'failed' ? (
            <XCircle size={13} className="shrink-0 text-[var(--accent-rose)]" />
          ) : (
            <Layers size={13} className="shrink-0 text-[var(--accent-emerald)]" />
          )}
          <span className="truncate font-medium text-[var(--text-primary)]">{group.summaryText}</span>
          {group.activeStepTitle && group.status === 'running' && !expanded && (
            <span className="truncate font-mono-code text-[11px] text-[var(--text-muted)]">
              · {group.activeStepTitle}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[11px] text-[var(--text-muted)]">
          {group.durationMs > 0 && (
            <span className="font-mono-code">{formatDurationMs(group.durationMs)}</span>
          )}
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
      </button>

      {expanded && (
        <div
          className="space-y-2 p-2.5"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          {group.blocks.map((step) => (
            <WorkStepCard key={step.blockId} session={session} block={step} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 2. Tool / Command / Reasoning Step Inspector with On-Demand Pull & WS Side-Channel ──

function WorkStepCard({ session, block }: { session: Session; block: WorkStepBlock }) {
  if (block.type === 'reasoning') {
    return <ReasoningStepCard block={block} />;
  }
  return <ToolBlockInspector session={session} block={block} />;
}

function ReasoningStepCard({ block }: { block: Extract<WorkStepBlock, { type: 'reasoning' }> }) {
  const [open, setOpen] = useState(block.streaming);
  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      >
        <span className="inline-flex items-center gap-1.5">
          <Brain size={12.5} className="text-[var(--accent-indigo)]" />
          <span>{block.streaming ? '深度思考中...' : '查看思考轨迹'}</span>
        </span>
        {open ? <ChevronDown size={12.5} /> : <ChevronRight size={12.5} />}
      </button>
      {open && (
        <div
          className="max-h-[240px] overflow-y-auto px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          {block.text}
        </div>
      )}
    </div>
  );
}

export function ToolBlockInspector({
  session,
  block,
}: {
  session: Session;
  block: Extract<WorkStepBlock, { type: 'command_execution' | 'tool_call' | 'file_change' }>;
}) {
  const subscribeCommandOutput = useAppStore((s) => s.subscribeCommandOutput);
  const liveChunkState = useAppStore((s) => {
    const callId =
      block.type === 'command_execution' || block.type === 'tool_call'
        ? block.toolCallId
        : block.toolCallId;
    return callId ? s.liveCommandOutputByKey[`${session.id}::${callId}`] : undefined;
  });

  const isRunning = block.status === 'running' || block.status === 'pending';
  const [expanded, setExpanded] = useState(block.status === 'failed');
  const [loadedOutput, setLoadedOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalChars, setTotalChars] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [copied, setCopied] = useState(false);

  const toolCallId =
    block.type === 'command_execution' || block.type === 'tool_call'
      ? block.toolCallId
      : block.toolCallId;

  const isStreamableCommand =
    Boolean(toolCallId) &&
    (block.type === 'command_execution' ||
      (block.type === 'tool_call' && block.toolKind === 'shell'));

  // Subscribe to CommandOutputHub side-channel ONLY when card is expanded (or actively running while expanded)
  useEffect(() => {
    if (!isStreamableCommand || !toolCallId || !expanded) return;
    if (!isRunning && liveChunkState?.done) return;
    const unsubscribe = subscribeCommandOutput(session.id, toolCallId);
    return unsubscribe;
  }, [isStreamableCommand, toolCallId, expanded, isRunning, liveChunkState?.done, session.id, subscribeCommandOutput]);

  const handleLoadFullOutput = useCallback(
    async (offset = 0, append = false) => {
      setLoadingFull(true);
      setLoadError(null);
      try {
        const res = await daemonApi.getSessionTurnItem(session.id, block.blockId, {
          textOffset: offset,
          maxChars: 65_536,
        });
        setLoadedOutput((prev) => (append && prev ? prev + res.text : res.text));
        setNextOffset(res.nextTextOffset);
        setTotalChars(res.totalChars);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingFull(false);
      }
    },
    [session.id, block.blockId],
  );

  const summary =
    block.type === 'command_execution'
      ? block.command
      : block.type === 'file_change'
        ? block.summary
        : block.summary;

  const toolName =
    block.type === 'command_execution'
      ? 'Bash'
      : block.type === 'file_change'
        ? 'FileChange'
        : block.toolName;

  const toolKind =
    block.type === 'command_execution'
      ? 'shell'
      : block.type === 'file_change'
        ? 'file_edit'
        : block.toolKind;

  const Icon =
    toolKind === 'shell'
      ? Terminal
      : toolKind === 'file_edit' || toolKind === 'file_read'
        ? FileCode2
        : toolKind === 'search'
          ? Search
          : toolKind === 'web'
            ? Globe
            : Wrench;

  const baseOutput =
    block.type === 'command_execution' || block.type === 'tool_call'
      ? block.outputPreview ?? ''
      : '';
  const liveText = liveChunkState?.text ?? '';
  const effectiveOutput = loadedOutput ?? (liveText.length > baseOutput.length ? liveText : baseOutput);
  const diffText = block.diff ?? '';
  const inputVal = block.type === 'command_execution' || block.type === 'tool_call' ? block.input : undefined;
  const outputOmitted = Boolean(block.outputOmitted && loadedOutput === null);
  const omittedBytes = block.omittedBytes ?? 0;

  const cleanedOutput = useMemo(() => stripAnsi(effectiveOutput), [effectiveOutput]);
  const filteredLines = useMemo(() => {
    const q = searchTerm.trim();
    if (!q || !cleanedOutput) return null;
    try {
      const re = new RegExp(q, 'i');
      return cleanedOutput.split('\n').filter((line) => re.test(line));
    } catch {
      const lower = q.toLowerCase();
      return cleanedOutput.split('\n').filter((line) => line.toLowerCase().includes(lower));
    }
  }, [cleanedOutput, searchTerm]);

  const hasDetails = Boolean(
    effectiveOutput || diffText || inputVal != null || outputOmitted || isStreamableCommand,
  );

  const projectedToolCompat: ProjectedToolCall = {
    toolCallId: toolCallId ?? block.blockId,
    toolName,
    toolKind,
    summary,
    input: inputVal ?? null,
    output: effectiveOutput,
    diff: diffText,
    outputOmitted: block.outputOmitted,
    omittedBytes: block.omittedBytes,
    status:
      block.status === 'failed'
        ? 'error'
        : block.status === 'cancelled' || block.status === 'interrupted'
          ? 'cancelled'
          : isRunning
            ? 'running'
            : 'success',
    startedAt: block.createdAt,
    completedAt: isRunning ? undefined : block.updatedAt,
  };

  return (
    <div
      data-testid="tool-block-inspector"
      data-block-type={block.type}
      className="overflow-hidden rounded-lg"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-default"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={12.5} className="shrink-0 text-[var(--text-secondary)]" />
          <span className="font-mono-code truncate text-[11.5px] text-[var(--text-primary)]">
            {summary}
          </span>
          {outputOmitted && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 font-mono-code text-[9.5px]"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                color: 'var(--accent-star)',
              }}
            >
              已省略{omittedBytes > 0 ? ` ${formatByteSize(omittedBytes)}` : ''}
            </span>
          )}
          {isRunning && isStreamableCommand && expanded && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 font-mono-code text-[9.5px]"
              style={{
                backgroundColor: 'var(--accent-indigo-soft)',
                color: 'var(--accent-indigo)',
              }}
            >
              LIVE
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isRunning && <Loader2 size={12} className="animate-spin text-[var(--accent-indigo)]" />}
          {block.status === 'completed' && (
            <CheckCircle2 size={12} className="text-[var(--accent-emerald)]" />
          )}
          {block.status === 'failed' && <XCircle size={12} className="text-[var(--accent-rose)]" />}
          {hasDetails && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </div>
      </button>

      {expanded && hasDetails && (
        <div
          className="space-y-2 p-2.5 font-mono-code text-[11px]"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--code-bg)',
          }}
        >
          {/* On-demand pull bar & search toolbar for large / omitted outputs */}
          {(outputOmitted || cleanedOutput.length > 240) && (
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                {outputOmitted && (
                  <button
                    type="button"
                    disabled={loadingFull}
                    onClick={() => void handleLoadFullOutput(0, false)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                    style={{
                      backgroundColor: 'var(--accent-indigo-soft)',
                      border: '1px solid var(--border-focus)',
                    }}
                  >
                    {loadingFull ? <Loader2 size={10.5} className="animate-spin" /> : <Sparkles size={10.5} />}
                    <span>展开完整输出{omittedBytes > 0 ? ` (${formatByteSize(omittedBytes)})` : ''}</span>
                  </button>
                )}
                {nextOffset !== null && (
                  <button
                    type="button"
                    disabled={loadingFull}
                    onClick={() => void handleLoadFullOutput(nextOffset, true)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                    style={{ border: '1px solid var(--border-hairline)' }}
                  >
                    加载更多 ({loadedOutput?.length ?? 0}/{totalChars ?? '?'})
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <div
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  <Search size={10.5} className="text-[var(--text-muted)]" />
                  <input
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="过滤 / 正则..."
                    className="w-28 bg-transparent text-[10.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                  {filteredLines && (
                    <span className="text-[9.5px] text-[var(--accent-indigo)]">
                      {filteredLines.length} 行
                    </span>
                  )}
                </div>
                {cleanedOutput && (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(cleanedOutput);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    {copied ? <Check size={10.5} className="text-[var(--accent-emerald)]" /> : <Copy size={10.5} />}
                    <span>{copied ? '已复制' : '复制'}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {loadError && <div className="text-[11px] text-[var(--accent-rose)]">{loadError}</div>}

          <Slot
            name="tool.result"
            matchKey={toolName}
            slotProps={{ session, tool: projectedToolCompat }}
            fallback={
              <>
                {diffText && (
                  <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap text-[var(--accent-emerald)]">
                    {diffText}
                  </pre>
                )}
                {cleanedOutput && (
                  <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap text-[var(--text-secondary)]">
                    {filteredLines ? filteredLines.join('\n') || '(无匹配行)' : cleanedOutput}
                  </pre>
                )}
                {!cleanedOutput && !diffText && inputVal != null && (
                  <pre className="m-0 max-h-[180px] overflow-auto whitespace-pre-wrap text-[var(--text-muted)]">
                    {JSON.stringify(inputVal, null, 2)}
                  </pre>
                )}
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

// ── 3. Generic Fallback Card for Unknown / `ext:*` Blocks ──────────────

export function GenericExtBlockCard({
  block,
}: {
  block: ExtensionTurnBlock | UnknownTurnBlock;
}) {
  const [open, setOpen] = useState(false);
  const displayType = block.type === 'unknown_block' ? block.originalType : block.type;

  const safeJson = useMemo(() => {
    try {
      return JSON.stringify(block.payload ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [block.payload]);

  return (
    <div
      data-testid="generic-ext-fallback-card"
      data-block-type={displayType}
      className="overflow-hidden rounded-xl"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-[12px] hover:bg-[var(--bg-hover)]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Puzzle size={13} className="shrink-0 text-[var(--accent-star)]" />
          <span className="truncate font-medium text-[var(--text-primary)]">
            {block.title || displayType}
          </span>
          <span
            className="shrink-0 rounded px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]"
            style={{ backgroundColor: 'var(--bg-elevated)' }}
          >
            {displayType}
          </span>
          <span className="shrink-0 font-mono-code text-[10px] text-[var(--text-muted)]">
            · {block.driverId}
          </span>
        </div>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>

      {block.fallbackSummary && (
        <div
          className="px-3 py-2 text-[12px] text-[var(--text-secondary)]"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          {block.fallbackSummary}
        </div>
      )}

      {open && (
        <pre
          className="m-0 max-h-[240px] overflow-auto px-3 py-2 font-mono-code text-[11px] text-[var(--text-muted)]"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--code-bg)',
          }}
        >
          {safeJson}
        </pre>
      )}
    </div>
  );
}

export { FailoverInlineBanner } from './FailoverInlineBanner';

// ── 5. Lightweight Turn Minimap ────────────────────────────────────────

export function TimelineMinimap({
  entries,
  harnesses,
  activeTurnId,
  onJump,
}: {
  entries: readonly TimelineMinimapEntry[];
  harnesses: readonly HarnessInfo[];
  activeTurnId?: string | null;
  onJump: (entry: TimelineMinimapEntry) => void;
}) {
  if (entries.length < 3) return null;

  return (
    <nav
      aria-label="对话轮次小地图"
      data-testid="timeline-minimap"
      className="hidden shrink-0 flex-col items-center gap-1.5 overflow-y-auto px-1.5 py-4 xl:flex"
      style={{
        width: 24,
        borderLeft: '1px solid var(--border-hairline)',
        backgroundColor: 'color-mix(in srgb, var(--bg-rail) 45%, transparent)',
      }}
    >
      {entries.map((entry) => {
        const meta = resolveHarnessMeta(
          { harnessId: entry.harnessId, harnessKind: entry.harnessKind },
          harnesses,
        );
        const isActive = activeTurnId === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            title={`${entry.label}${entry.hasFileChanges ? ' · 有文件改动' : ''}${entry.failed ? ' · 失败' : ''}`}
            onClick={() => onJump(entry)}
            className="group relative flex h-3 w-3 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-125"
          >
            <span
              className={entry.kind === 'switch' ? 'h-1 w-3 rounded-full' : 'h-2 w-2 rounded-full'}
              style={{
                backgroundColor: entry.failed
                  ? 'var(--accent-rose)'
                  : entry.kind === 'switch'
                    ? 'var(--accent-star)'
                    : meta.accentColor,
                opacity: isActive ? 1 : 0.72,
                boxShadow: isActive ? `0 0 0 2px ${meta.softBg}` : undefined,
              }}
            />
          </button>
        );
      })}
    </nav>
  );
}

export type { TurnBlock };
