import { ArrowUpRight, FileCheck2, Target } from 'lucide-react';
import type {
  ActivityId,
  CapabilityDescriptor,
  NativeControlRequest,
  RuntimeBinding,
} from '../../../../lib/native-client';
import { EntityStatusBadge, EvidenceDetails, NativeControlMenu } from '../shared';
import type { GoalCardModel } from './types';
import { resolveTasksControlGate } from './view-model';

export interface GoalDetailPanelProps {
  readonly goals: readonly GoalCardModel[];
  readonly binding: RuntimeBinding;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly runtimeDisconnected: boolean;
  readonly readOnlyDisabledMode?: boolean;
  readonly onJumpToActivity: (activityId: ActivityId) => void;
  readonly onDispatchControl?: (
    req: Omit<NativeControlRequest, 'generation' | 'idempotencyKey'> & {
      expectedBinding?: RuntimeBinding;
    },
  ) => Promise<void>;
}

/**
 * Independent Goal panel (separate controls & verification evidence from Schedule).
 */
export function GoalDetailPanel({
  goals,
  binding,
  capabilities,
  runtimeDisconnected,
  readOnlyDisabledMode = false,
  onJumpToActivity,
  onDispatchControl,
}: GoalDetailPanelProps) {
  const goalGate = resolveTasksControlGate(
    capabilities,
    ['AGY-W09', 'agy.workflow.goal'],
    readOnlyDisabledMode || runtimeDisconnected,
  );

  return (
    <section
      data-testid="np12-goal-section"
      aria-label="Goal 目标推进"
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <Target size={12.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
          <span>Goal 目标推进 ({goals.length})</span>
        </h3>
        <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
          官方入口：/goal &lt;objective&gt;
        </span>
      </div>

      {goals.length === 0 ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]">
          尚未观察到原生 Goal；发起新 Goal 或查看历史请使用官方 CLI <span className="font-mono-code">/goal</span>。
        </div>
      ) : (
        <div className="space-y-2.5">
          {goals.map((item) => {
            const { workflow, objective, verificationArtifactIds, meta } = item;
            const isSuperseded = Boolean(meta?.supersededByGoalId || meta?.lifecyclePhase === 'superseded');
            const isTerminal =
              workflow.state.kind === 'known' &&
              (workflow.state.value === 'finished' ||
                workflow.state.value === 'failed' ||
                workflow.state.value === 'cancelled');

            return (
              <article
                key={workflow.id}
                data-testid={`np12-goal-card-${workflow.id}`}
                className="space-y-2 rounded-2xl border p-3 text-[12px]"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-[var(--text-primary)]">{objective}</span>
                      <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                        {workflow.id}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                      {meta?.replacedGoalId && (
                        <span className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px]">
                          已替换旧目标 {meta.replacedGoalId}
                        </span>
                      )}
                      {isSuperseded && (
                        <span
                          data-testid={`np12-goal-superseded-${workflow.id}`}
                          className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--accent-clay)]"
                        >
                          已被新 Goal 替换（历史只读保留）{meta?.supersededByGoalId ? `→ ${meta.supersededByGoalId}` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <EntityStatusBadge kind="work" observed={workflow.state} compact />
                    <button
                      type="button"
                      data-testid={`np12-goal-jump-${workflow.id}`}
                      onClick={() => onJumpToActivity(workflow.originActivityId)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    >
                      <span>起源活动</span>
                      <ArrowUpRight size={10.5} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {(verificationArtifactIds.length > 0 || (meta?.verifications?.length ?? 0) > 0) && (
                  <div className="space-y-1 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2">
                    <div className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[var(--text-primary)]">
                      <FileCheck2 size={11.5} className="text-[var(--accent-emerald)]" aria-hidden="true" />
                      <span>目标核验记录与产物 ({meta?.verifications?.length ?? verificationArtifactIds.length})</span>
                    </div>
                    {meta?.verifications?.map((v) => (
                      <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-[var(--text-secondary)]">
                          {v.label}
                          {v.summary ? ` · ${v.summary}` : ''}
                        </span>
                        <div className="flex items-center gap-1">
                          <EntityStatusBadge kind="work" observed={v.state} compact />
                          {v.outcome && <EntityStatusBadge kind="outcome" observed={v.outcome} compact />}
                        </div>
                      </div>
                    ))}
                    {verificationArtifactIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {verificationArtifactIds.map((artId) => (
                          <span
                            key={artId}
                            className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]"
                          >
                            {artId}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {!isTerminal && !isSuperseded && (
                  <div data-testid={`np12-goal-controls-${workflow.id}`}>
                    <NativeControlMenu
                      target={{ type: 'workflow', id: workflow.id }}
                      targetLabel={`Goal · ${objective}`}
                      expectedRevision={workflow.revision}
                      binding={binding}
                      capability={goalGate.capability}
                      disabled={!goalGate.controlAvailable}
                      onDispatchControl={onDispatchControl}
                    />
                  </div>
                )}

                <EvidenceDetails
                  evidence={
                    workflow.state.kind === 'known'
                      ? workflow.state.evidence
                      : workflow.state.kind === 'stale'
                        ? workflow.state.evidence
                        : null
                  }
                  reasonCode={workflow.state.kind !== 'known' ? workflow.state.reasonCode : undefined}
                  label={`Goal ${workflow.id} 观测证据`}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
