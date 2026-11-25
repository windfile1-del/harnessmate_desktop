import { ArrowUpRight, CalendarClock, Clock, Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  ActivityId,
  CapabilityDescriptor,
  NativeControlRequest,
  NativeWorkflowResourcePageResponse,
  RuntimeBinding,
  WorkflowId,
} from '../../../../lib/native-client';
import { EntityStatusBadge, EvidenceDetails, NativeControlMenu } from '../shared';
import type { ScheduleCardModel } from './types';
import { formatNativeTime, resolveTasksControlGate } from './view-model';

export interface ScheduleDetailPanelProps {
  readonly schedules: readonly ScheduleCardModel[];
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
  readonly loadWorkflowResource?: (
    workflowId: WorkflowId,
    resource: string,
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeWorkflowResourcePageResponse>;
}

const SCHEDULE_KIND_LABELS: Record<ScheduleCardModel['scheduleKind'], string> = {
  one_shot: '单次定时 (One-shot)',
  cron: '周期 Cron',
  unknown: '定时类型未确认',
};

const RECOVERY_STATE_LABELS: Record<string, string> = {
  live: '实时在线',
  reconciling: '重启校准中',
  preserved_read_only: '到期/终态只读保留',
  stale_unconfirmed: '观测已过期',
};

/**
 * Independent Schedule & Occurrence panel.
 * - Keeps Goal and Schedule next-events & controls completely separate.
 * - Uses authoritative native `nextAt` and explicit native timezone (or `原生时区未知`).
 * - Enables wake jump ONLY when a wake ActivityId is actually observed.
 */
export function ScheduleDetailPanel({
  schedules,
  binding,
  capabilities,
  runtimeDisconnected,
  readOnlyDisabledMode = false,
  onJumpToActivity,
  onDispatchControl,
  loadWorkflowResource,
}: ScheduleDetailPanelProps) {
  const [logsByWorkflow, setLogsByWorkflow] = useState<
    Record<string, { items: readonly Record<string, unknown>[]; loading: boolean }>
  >({});
  const abortRef = useRef<AbortController | null>(null);
  const bindingKey = `${binding.runtimeId}:${binding.generation}`;
  const bindingKeyRef = useRef(bindingKey);
  bindingKeyRef.current = bindingKey;

  useEffect(() => {
    abortRef.current?.abort();
    setLogsByWorkflow({});
    return () => abortRef.current?.abort();
  }, [bindingKey]);

  const scheduleGate = resolveTasksControlGate(
    capabilities,
    ['AGY-W10', 'agy.workflow.schedule'],
    readOnlyDisabledMode || runtimeDisconnected,
  );

  const handleLoadLogs = (workflowId: WorkflowId) => {
    if (!loadWorkflowResource) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reqBindingKey = bindingKey;
    setLogsByWorkflow((prev) => ({
      ...prev,
      [workflowId]: { items: prev[workflowId]?.items ?? [], loading: true },
    }));
    void loadWorkflowResource(workflowId, 'logs', null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || bindingKeyRef.current !== reqBindingKey) return;
        setLogsByWorkflow((prev) => ({
          ...prev,
          [workflowId]: { items: page.items, loading: false },
        }));
      })
      .catch(() => {
        if (controller.signal.aborted || bindingKeyRef.current !== reqBindingKey) return;
        setLogsByWorkflow((prev) => ({
          ...prev,
          [workflowId]: { items: prev[workflowId]?.items ?? [], loading: false },
        }));
      });
  };

  return (
    <section
      data-testid="np12-schedule-section"
      aria-label="Schedule 原生定时计划与唤醒"
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          <CalendarClock size={12.5} className="text-[var(--accent-star)]" aria-hidden="true" />
          <span>Schedule 定时与 Occurrence ({schedules.length})</span>
        </h3>
        <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
          官方入口：/schedule &lt;when&gt; &lt;task&gt;
        </span>
      </div>

      {schedules.length === 0 ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]">
          尚未观察到会话内 Schedule；HarnessMate 不运行自有调度器，请在官方 CLI 使用{' '}
          <span className="font-mono-code">/schedule</span>。
        </div>
      ) : (
        <div className="space-y-2.5">
          {schedules.map((card) => {
            const { workflow, scheduleLabel, scheduleKind, formattedNextAt, occurrences } = card;
            const logState = logsByWorkflow[workflow.id];

            return (
              <article
                key={workflow.id}
                data-testid={`np12-schedule-card-${workflow.id}`}
                className="space-y-2.5 rounded-2xl border p-3 text-[12px]"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-[var(--text-primary)]">
                        {scheduleLabel}
                      </span>
                      <span
                        data-testid={`np12-schedule-kind-${workflow.id}`}
                        className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]"
                      >
                        {SCHEDULE_KIND_LABELS[scheduleKind]}
                      </span>
                      <span className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--accent-indigo)]">
                        不阻塞当前轮次
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                      {card.cronExpression && (
                        <span className="font-mono-code text-[10.5px]">
                          cron: {card.cronExpression}
                        </span>
                      )}
                      {card.durationSeconds !== undefined && (
                        <span className="font-mono-code text-[10.5px]">
                          DurationSeconds: {card.durationSeconds}s
                        </span>
                      )}
                      {card.timerCondition && (
                        <span className="font-mono-code text-[10.5px]">
                          TimerCondition: {card.timerCondition}
                        </span>
                      )}
                    </div>
                  </div>
                  <EntityStatusBadge kind="work" observed={workflow.state} compact />
                </div>

                {/* Authoritative Native Next Event & Explicit Native Timezone */}
                <div
                  data-testid={`np12-schedule-timing-${workflow.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[11px]"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Clock size={12} className="text-[var(--accent-star)]" aria-hidden="true" />
                    <span className="font-medium text-[var(--text-primary)]">下一触发：</span>
                    <span className="text-[var(--text-secondary)]">{formattedNextAt.text}</span>
                  </div>
                  <span
                    data-testid={`np12-schedule-tz-${workflow.id}`}
                    className="rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]"
                  >
                    {formattedNextAt.timezoneLabel}
                  </span>
                </div>

                {/* Independent Schedule Controls + Honest Native Deletion Notice */}
                <div
                  data-testid={`np12-schedule-controls-${workflow.id}`}
                  className="space-y-1.5"
                >
                  <NativeControlMenu
                    target={{ type: 'workflow', id: workflow.id }}
                    targetLabel={`Schedule · ${scheduleLabel}`}
                    expectedRevision={workflow.revision}
                    binding={binding}
                    capability={scheduleGate.capability}
                    disabled={!scheduleGate.controlAvailable}
                    onDispatchControl={onDispatchControl}
                  />
                  <p className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                    <Info size={11} aria-hidden="true" />
                    <span>真实已有计划的删除、暂停或编辑仍由用户经原生端（CLI /tasks 或官方 App）完成。</span>
                  </p>
                </div>

                {/* Occurrences & Wake Jumps */}
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-[var(--text-primary)]">
                      触发记录 Occurrences ({occurrences.length})
                    </span>
                    {loadWorkflowResource && (
                      <button
                        type="button"
                        data-testid={`np12-schedule-load-logs-${workflow.id}`}
                        onClick={() => handleLoadLogs(workflow.id)}
                        className="cursor-pointer rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      >
                        {logState?.loading ? '加载日志中…' : '查看定时日志'}
                      </button>
                    )}
                  </div>

                  {occurrences.length === 0 ? (
                    <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[11px] text-[var(--text-muted)]">
                      尚无已触发的 occurrence（计划中或尚未到点）。
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {occurrences.map((occ) => {
                        const actualTime = formatNativeTime(
                          occ.actualTriggeredAt,
                          occ.timezone ?? card.timezone,
                        );
                        return (
                          <li
                            key={occ.workId}
                            data-testid={`np12-occurrence-row-${occ.workId}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[11px]"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-[var(--text-primary)]">
                                  #{occ.occurrenceIndex}
                                </span>
                                <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                                  {occ.workId}
                                </span>
                                <span className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-muted)]">
                                  {RECOVERY_STATE_LABELS[occ.recoveryState] ?? occ.recoveryState}
                                </span>
                              </div>
                              <div className="text-[10.5px] text-[var(--text-secondary)]">
                                {occ.summary ? `${occ.summary} · ` : ''}
                                {occ.actualTriggeredAt ? `实际触发：${actualTime.text}` : '尚未观察到触发时间戳'}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <EntityStatusBadge kind="work" observed={occ.state} compact />
                              {occ.outcome && (
                                <EntityStatusBadge kind="outcome" observed={occ.outcome} compact />
                              )}
                              {occ.hasObservedWake && occ.latestWakeActivityId ? (
                                <button
                                  type="button"
                                  data-testid={`np12-jump-wake-${occ.workId}`}
                                  onClick={() => onJumpToActivity(occ.latestWakeActivityId!)}
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-focus)] bg-[var(--bg-active)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                                >
                                  <span>跳转唤醒 ({occ.latestWakeActivityId})</span>
                                  <ArrowUpRight size={10.5} aria-hidden="true" />
                                </button>
                              ) : (
                                <span className="text-[10px] text-[var(--text-muted)]">
                                  未观察到 wake
                                </span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {logState && logState.items.length > 0 && (
                    <div
                      data-testid={`np12-schedule-logs-${workflow.id}`}
                      className="space-y-1 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2 text-[10.5px]"
                    >
                      {logState.items.map((item, idx) =>
                        item.kind === 'log_entry' ? (
                          <div key={String(item.entryId ?? idx)} className="text-[var(--text-secondary)]">
                            <span className="font-mono-code text-[var(--text-muted)]">
                              [{String(item.level ?? 'info')}]
                            </span>{' '}
                            {String(item.summary ?? '')}
                          </div>
                        ) : null,
                      )}
                    </div>
                  )}
                </div>

                <EvidenceDetails
                  evidence={
                    workflow.state.kind === 'known'
                      ? workflow.state.evidence
                      : workflow.state.kind === 'stale'
                        ? workflow.state.evidence
                        : null
                  }
                  reasonCode={workflow.state.kind !== 'known' ? workflow.state.reasonCode : undefined}
                  label={`Schedule ${workflow.id} 观测证据`}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
