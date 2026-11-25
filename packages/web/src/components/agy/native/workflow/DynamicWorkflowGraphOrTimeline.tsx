import { ArrowUpDown, Bot, GitBranch, ListOrdered } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  NativeAgentId,
  NativeStage,
  NativeWork,
  NativeWorkflow,
} from '../../../../lib/native-client';
import type { NativeRequestViewItem } from '../requests/types';
import {
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EntityStatusBadge,
  EvidenceDetails,
} from '../shared';
import type { DynamicWorkflowResourceItemView } from './types';
import {
  analyzeDynamicDag,
  buildSortableWorkflowTimeline,
} from './view-model';

export interface DynamicWorkflowGraphOrTimelineProps {
  readonly workflow: NativeWorkflow;
  readonly works: readonly NativeWork[];
  readonly requests: readonly NativeRequestViewItem[];
  readonly logItems?: readonly DynamicWorkflowResourceItemView[];
  readonly selectedStepId: string | null;
  readonly stepErrorByStepId?: Readonly<Record<string, string>>;
  readonly onSelectStep: (stepId: string) => void;
  readonly onJumpToAgent?: (agentId: NativeAgentId) => void;
}

function getDagFallbackReasonText(reason?: string): string {
  switch (reason) {
    case 'cyclic_dependency_edges_detected':
      return '检测到非无环依赖边，已自动回退为可排序时间线视图，不展示伪造 DAG。';
    case 'no_steps_observed':
      return '当前尚未收到结构化阶段/节点数据，仅展示已观测到的工作项与时间线。';
    default:
      return '未收到真实依赖边（after），已展示可排序执行时间线；绝不根据模型输出或 Python 文本推测 DAG。';
  }
}

/**
 * Renders verified DAG layers (parallel vs serial) when explicit `after` edges exist,
 * and honestly degrades to a sortable chronological timeline when edges/steps are absent.
 */
export function DynamicWorkflowGraphOrTimeline({
  workflow,
  works,
  requests,
  logItems,
  selectedStepId,
  stepErrorByStepId = {},
  onSelectStep,
  onJumpToAgent,
}: DynamicWorkflowGraphOrTimelineProps) {
  const steps: readonly NativeStage[] =
    workflow.detail.kind === 'dynamic' ? (workflow.detail.steps ?? []) : [];
  const dag = useMemo(() => analyzeDynamicDag(steps), [steps]);

  const [preferredMode, setPreferredMode] = useState<'dag' | 'timeline'>('dag');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const activeMode: 'dag' | 'timeline' =
    dag.hasVerifiedDag && preferredMode === 'dag' ? 'dag' : 'timeline';

  const timelineItems = useMemo(
    () =>
      buildSortableWorkflowTimeline({
        workflow,
        works,
        requests,
        logItems,
        sortOrder,
        stepErrorByStepId,
      }),
    [workflow, works, requests, logItems, sortOrder, stepErrorByStepId],
  );

  const selectedStep =
    steps.find((s) => s.id === selectedStepId) ?? steps[0] ?? null;

  return (
    <section
      data-testid="np11-graph-or-timeline"
      aria-label="动态工作流节点与执行时序"
      className="space-y-3 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <GitBranch size={14} className="text-[var(--accent-indigo)]" aria-hidden="true" />
          <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
            执行阶段与时序轨迹 ({steps.length} 节点)
          </h3>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-[var(--border-hairline)] p-0.5 text-[11px]" role="group" aria-label="视图模式">
            <button
              type="button"
              data-testid="np11-mode-dag"
              disabled={!dag.hasVerifiedDag}
              aria-pressed={activeMode === 'dag'}
              onClick={() => setPreferredMode('dag')}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-45"
              style={{
                backgroundColor: activeMode === 'dag' ? 'var(--bg-active)' : 'transparent',
                color: activeMode === 'dag' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              }}
            >
              <GitBranch size={11} aria-hidden="true" />
              <span>DAG 依赖图</span>
            </button>
            <button
              type="button"
              data-testid="np11-mode-timeline"
              aria-pressed={activeMode === 'timeline'}
              onClick={() => setPreferredMode('timeline')}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5"
              style={{
                backgroundColor: activeMode === 'timeline' ? 'var(--bg-active)' : 'transparent',
                color: activeMode === 'timeline' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              }}
            >
              <ListOrdered size={11} aria-hidden="true" />
              <span>可排序时间线</span>
            </button>
          </div>

          {activeMode === 'timeline' && (
            <button
              type="button"
              data-testid="np11-timeline-sort-toggle"
              onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <ArrowUpDown size={11} aria-hidden="true" />
              <span>{sortOrder === 'asc' ? '正序' : '倒序'}</span>
            </button>
          )}
        </div>
      </div>

      {!dag.hasVerifiedDag && (
        <div data-testid="np11-no-dag-notice">
          <CapabilityUnavailable
            title="未获得实际依赖图 (DAG)"
            gate="upstream_limited"
            capabilityId="AGY-W08"
            reason={getDagFallbackReasonText(dag.unavailableReason)}
            officialEntryHint="在官方 CLI 中使用 /tasks 可查看原生阶段树；当前时间线仅按实际观测顺序排列。"
            officialDocUrl="https://antigravity.google/docs/dynamic-workflows/"
          />
        </div>
      )}

      {activeMode === 'dag' ? (
        <div data-testid="np11-dag-layers" className="space-y-2.5">
          {dag.layers.map((layer) => (
            <div
              key={layer.depth}
              data-testid={`np11-dag-layer-${layer.depth}`}
              className="space-y-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5"
            >
              <div className="flex items-center justify-between text-[10.5px] font-medium text-[var(--text-muted)]">
                <span>
                  Phase {layer.depth + 1} · {layer.steps.length > 1 ? '并发分支' : '串行阶段'}
                </span>
                <span>{layer.steps.length} 个节点</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {layer.steps.map((step) => {
                  const selected = selectedStep?.id === step.id;
                  const err = stepErrorByStepId[step.id];
                  return (
                    <button
                      key={step.id}
                      type="button"
                      data-testid={`np11-step-card-${step.id}`}
                      onClick={() => onSelectStep(step.id)}
                      className="flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border p-2.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                      style={{
                        backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-surface)',
                        borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                      }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="font-medium text-[var(--text-primary)]">{step.label}</span>
                        <EntityStatusBadge kind="work" observed={step.state} compact />
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                        <span>{step.id}</span>
                        {step.after && step.after.length > 0 && (
                          <span>← {step.after.join(', ')}</span>
                        )}
                      </div>
                      {err && (
                        <div className="text-[10.5px] text-[var(--accent-rose)]">{err}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : timelineItems.length === 0 ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px] text-[var(--text-muted)]">
          <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
          <p className="mt-0.5 text-[10.5px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
        </div>
      ) : (
        <ol data-testid="np11-sortable-timeline" className="space-y-1.5">
          {timelineItems.map((item) => {
            const isSelectedStep = Boolean(item.stepId && selectedStep?.id === item.stepId);
            return (
              <li
                key={item.itemId}
                data-testid={`np11-timeline-item-${item.itemId}`}
                className="rounded-xl border p-2.5 text-[11.5px]"
                style={{
                  backgroundColor: isSelectedStep ? 'var(--bg-active)' : 'var(--bg-elevated)',
                  borderColor: isSelectedStep ? 'var(--border-focus)' : 'var(--border-hairline)',
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                      #{item.sortSeq}
                    </span>
                    {item.stepId ? (
                      <button
                        type="button"
                        onClick={() => onSelectStep(item.stepId!)}
                        className="cursor-pointer truncate font-medium text-[var(--text-primary)] hover:underline"
                      >
                        {item.title}
                      </button>
                    ) : (
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {item.title}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1">
                    {item.blocking && (
                      <EntityStatusBadge kind="blocking" blocking={item.blocking} compact />
                    )}
                    {item.observedState && (
                      <EntityStatusBadge kind="work" observed={item.observedState} compact />
                    )}
                    {item.receiptState && (
                      <EntityStatusBadge kind="receipt" state={item.receiptState} compact />
                    )}
                  </div>
                </div>
                {item.detail && (
                  <div className="mt-1 text-[11px] text-[var(--text-secondary)]">{item.detail}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {selectedStep && (
        <div
          data-testid="np11-selected-step-inspector"
          className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-[var(--text-primary)]">
                节点详情：{selectedStep.label}
              </span>
              <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                {selectedStep.id}
              </span>
            </div>
            <EntityStatusBadge kind="work" observed={selectedStep.state} compact />
          </div>

          {stepErrorByStepId[selectedStep.id] && (
            <div
              role="alert"
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--accent-rose-soft)] px-2.5 py-1.5 text-[11px] text-[var(--accent-rose)]"
            >
              节点失败详情：{stepErrorByStepId[selectedStep.id]}
            </div>
          )}

          {selectedStep.agentIds && selectedStep.agentIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--text-muted)]">已证实关联 Agent：</span>
              {selectedStep.agentIds.map((agentId) => (
                <button
                  key={agentId}
                  type="button"
                  disabled={!onJumpToAgent}
                  onClick={() => onJumpToAgent?.(agentId)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:cursor-default"
                >
                  <Bot size={10.5} aria-hidden="true" />
                  <span>{agentId}</span>
                </button>
              ))}
            </div>
          )}

          <EvidenceDetails
            evidence={
              selectedStep.state.kind === 'known'
                ? selectedStep.state.evidence
                : selectedStep.state.kind === 'stale'
                  ? selectedStep.state.evidence
                  : null
            }
            reasonCode={
              selectedStep.state.kind !== 'known' ? selectedStep.state.reasonCode : undefined
            }
            label={`节点 ${selectedStep.id} 观测证据`}
          />
        </div>
      )}
    </section>
  );
}
