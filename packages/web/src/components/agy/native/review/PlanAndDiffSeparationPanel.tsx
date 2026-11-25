import { FileDiff, GitBranch, ListChecks, ShieldCheck } from 'lucide-react';
import { EntityStatusBadge, EvidenceDetails, toneStyle } from '../shared';
import { formatSafeUnifiedDiffLines } from './safe-content';
import type { PlanSnapshotView, ToolDiffView } from './types';

export interface PlanAndDiffSeparationPanelProps {
  readonly planSnapshot?: PlanSnapshotView | null;
  readonly toolDiffs: readonly ToolDiffView[];
}

export function PlanAndDiffSeparationPanel({
  planSnapshot,
  toolDiffs,
}: PlanAndDiffSeparationPanelProps) {
  return (
    <div data-testid="np14-plan-diff-separation" className="space-y-3 text-[12px]">
      <section
        data-testid="np14-plan-section"
        aria-label="AGY Plan 与执行步骤"
        className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <ListChecks size={14} className="text-[var(--accent-indigo)]" aria-hidden="true" />
            <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              Plan 计划与执行步骤 (AGY-W13)
            </h3>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="rounded-full border px-2 py-0.5 text-[10.5px]"
              style={toneStyle(planSnapshot?.planModeActive ? 'indigo' : 'muted')}
            >
              {planSnapshot?.planModeActive ? 'Plan 模式激活中' : '非 Plan 模式'}
            </span>
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
              enforcement: {planSnapshot?.enforcement ?? 'unknown'}
            </span>
          </div>
        </div>

        <p className="text-[11px] text-[var(--text-muted)]">
          标准 ACP Plan / AGY `update_steps` 与 AGY Artifact Review 独立呈现，仅反映原生计划步骤与模式状态。
        </p>

        {!planSnapshot || planSnapshot.steps.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px] text-[var(--text-muted)]">
            尚未观察到原生 Plan 步骤。
          </div>
        ) : (
          <ul className="space-y-1.5">
            {planSnapshot.steps.map((step) => (
              <li
                key={step.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] font-medium text-[var(--text-primary)]">
                    {step.title}
                  </div>
                  <div className="mt-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                    来源: {step.source === 'acp_agent_plan' ? 'ACP plan' : 'AGY update_steps'}
                    {step.priority ? ` · priority=${step.priority}` : ''}
                  </div>
                </div>
                <span
                  className="rounded-full border px-2 py-0.5 text-[10.5px]"
                  style={toneStyle(
                    step.status === 'completed'
                      ? 'emerald'
                      : step.status === 'in_progress'
                        ? 'indigo'
                        : step.status === 'failed'
                          ? 'rose'
                          : 'muted',
                  )}
                >
                  {step.status}
                </span>
              </li>
            ))}
          </ul>
        )}

        {planSnapshot?.provenance && (
          <EvidenceDetails
            evidence={planSnapshot.provenance}
            label="Plan 信号来源"
          />
        )}
      </section>

      <section
        data-testid="np14-diff-section"
        aria-label="ACP 工具变更 Diff"
        className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <FileDiff size={14} className="text-[var(--accent-emerald)]" aria-hidden="true" />
            <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              ACP 工具变更 Diff (AGY-W15)
            </h3>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]">
            <GitBranch size={10.5} aria-hidden="true" />
            <span>独立于 Artifact Review 与工作区 Git Diff</span>
          </span>
        </div>

        {toolDiffs.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px] text-[var(--text-muted)]">
            当前会话尚未观察到 ACP 工具 Diff；工作区 Git 变更请使用标准 Diff 面板。
          </div>
        ) : (
          <div className="space-y-2.5">
            {toolDiffs.map((diff) => {
              const lines = formatSafeUnifiedDiffLines(diff.unifiedDiff);
              return (
                <article
                  key={diff.diffId}
                  className="space-y-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono-code text-[11px] font-medium text-[var(--text-primary)]">
                      {diff.relativeDisplayPath}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                        <ShieldCheck size={11} aria-hidden="true" />
                        <span>归属: {diff.ownerAgentId ?? diff.ownerLineage}</span>
                      </span>
                      <EntityStatusBadge
                        kind="gate"
                        gate={diff.approvalState === 'approved' ? 'available' : 'upstream_limited'}
                      />
                    </div>
                  </div>
                  <div className="max-h-44 overflow-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-1.5 font-mono-code text-[10.5px]">
                    {lines.map((row) => (
                      <div
                        key={row.lineNo}
                        className="flex items-start gap-2 px-1"
                        style={{
                          color:
                            row.kind === 'add'
                              ? 'var(--accent-emerald)'
                              : row.kind === 'del'
                                ? 'var(--accent-rose)'
                                : row.kind === 'hunk'
                                  ? 'var(--accent-indigo)'
                                  : 'var(--text-secondary)',
                        }}
                      >
                        <span className="w-6 shrink-0 select-none text-right text-[9.5px] text-[var(--text-muted)]">
                          {row.lineNo}
                        </span>
                        <span className="flex-1 whitespace-pre-wrap break-all">
                          {row.text || ' '}
                        </span>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
