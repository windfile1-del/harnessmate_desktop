import type { Session } from '@harnessmate/protocol';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Clock, FileText, ListChecks, Target } from 'lucide-react';
import { useState } from 'react';
import { daemonApi, type AgySubagentDetailDto } from '../../api/client';
import type { TurnBlock } from '../../lib/work-groups';

type ExtBlock = Extract<TurnBlock, { type: `ext:${string}` }>;

export function AgyStudioBlockCard({
  session,
  block,
}: {
  session: Session;
  block: ExtBlock;
}) {
  const [expanded, setExpanded] = useState(block.type === 'ext:agy.plan');
  const [subagentDetail, setSubagentDetail] = useState<AgySubagentDetailDto | null>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);

  const payload = block.payload ?? {};

  if (block.type === 'ext:agy.plan') {
    const steps = Array.isArray(payload.steps)
      ? (payload.steps as Array<{ title?: string; status?: string }>)
      : [];
    return (
      <div
        className="rounded-xl p-3 text-[12px]"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
        >
          <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <ListChecks size={13} className="text-[var(--accent-indigo)]" />
            {block.title}
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">{steps.length} 项</span>
        </button>
        {expanded && (
          <ul className="mt-2 space-y-1 pl-5">
            {steps.length > 0 ? (
              steps.map((step, idx) => (
                <li key={idx} className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                  <CheckCircle2
                    size={12}
                    style={{
                      color:
                        step.status === 'done'
                          ? 'var(--accent-emerald)'
                          : step.status === 'in_progress'
                            ? 'var(--accent-indigo)'
                            : 'var(--text-muted)',
                    }}
                  />
                  <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                    [{step.status ?? 'pending'}]
                  </span>
                  <span>{step.title}</span>
                </li>
              ))
            ) : (
              <li className="text-[11.5px] text-[var(--text-muted)]">{block.fallbackSummary}</li>
            )}
          </ul>
        )}
      </div>
    );
  }

  if (block.type === 'ext:agy.subagent_batch') {
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
    const loadTrace = async () => {
      if (!toolCallId || subagentDetail) {
        setExpanded((v) => !v);
        return;
      }
      setLoadingTrace(true);
      try {
        const res = await daemonApi.readAgySubagent(session.id, toolCallId);
        setSubagentDetail(res.subagent);
        setExpanded(true);
      } catch {
        setExpanded((v) => !v);
      } finally {
        setLoadingTrace(false);
      }
    };

    return (
      <div
        className="rounded-xl p-3 text-[12px]"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
            <Bot size={13} className="text-[var(--accent-indigo)]" />
            {block.title}
          </span>
          {toolCallId && (
            <button
              type="button"
              onClick={() => void loadTrace()}
              className="cursor-pointer rounded border border-[var(--border-hairline)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              {loadingTrace ? '读取中…' : expanded ? '收起轨迹' : '查看只读轨迹'}
            </button>
          )}
        </div>
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">{block.fallbackSummary}</div>
        {expanded && subagentDetail && (
          <pre className="font-mono-code mt-2 max-h-40 overflow-auto rounded bg-[var(--bg-surface)] p-2 text-[10.5px] text-[var(--text-secondary)]">
            {subagentDetail.transcriptLines.join('\n') || subagentDetail.summary || '(无轨迹行)'}
          </pre>
        )}
      </div>
    );
  }

  if (block.type === 'ext:agy.background_task') {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11.5px]"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
          <Clock size={12.5} className="text-[var(--accent-star)]" />
          {block.title}
        </span>
        <span className="truncate text-[var(--text-secondary)]">{block.fallbackSummary}</span>
      </div>
    );
  }

  if (block.type === 'ext:agy.artifact_card') {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11.5px]"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
          <FileText size={12.5} className="text-[var(--accent-emerald)]" />
          {block.title}
        </span>
        <span className="truncate text-[var(--text-secondary)]">{block.fallbackSummary}</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11.5px]"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
        <Target size={12.5} className="text-[var(--accent-indigo)]" />
        {block.title}
      </span>
      <span className="truncate text-[var(--text-secondary)]">{block.fallbackSummary}</span>
    </div>
  );
}
