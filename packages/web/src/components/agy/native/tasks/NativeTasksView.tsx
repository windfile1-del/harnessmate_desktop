import { ArrowUpRight, ListTodo, ShieldAlert, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ActivityId, NativeWork } from '../../../../lib/native-client';
import {
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EntityStatusBadge,
  toneStyle,
} from '../shared';
import { AppAutomationsClosureCard } from './AppAutomationsClosureCard';
import { GoalDetailPanel } from './GoalDetailPanel';
import { ScheduleDetailPanel } from './ScheduleDetailPanel';
import type { NativeTasksViewProps, TaskCategoryFilter } from './types';
import {
  buildCategorizedTasks,
  selectGoalCards,
  selectScheduleCards,
} from './view-model';

const CATEGORY_FILTER_OPTIONS: ReadonlyArray<{
  readonly key: TaskCategoryFilter;
  readonly label: string;
}> = [
  { key: 'all', label: '全部' },
  { key: 'goal', label: 'Goal' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'finite_command', label: '有限命令' },
  { key: 'daemon', label: '常驻 Daemon' },
  { key: 'workflow_step', label: '工作流步骤' },
  { key: 'unknown', label: '未确认' },
];

function categoryMatches(
  filter: TaskCategoryFilter,
  category: Exclude<TaskCategoryFilter, 'all'>,
  stateKind: 'known' | 'stale' | 'unknown',
): boolean {
  if (filter === 'all') return true;
  if (filter === 'unknown') {
    return category === 'unknown' || stateKind === 'unknown' || stateKind === 'stale';
  }
  return category === filter;
}

/**
 * NP-12 Native Tasks · Goal, Schedule & Background Aggregation Workbench View (`surface: 'tasks'`).
 *
 * Overrides NP-03's built-in order=900 degraded shell via `registerNativeTasksView` (`order: 120`)
 * with zero modifications to `ChatStage.tsx`, `App.tsx`, or `app-store.ts`.
 */
export function NativeTasksView({
  projection,
  capabilities,
  route,
  isNarrowViewport,
  onNavigate,
  onBackToChat,
  onRefresh,
  onDispatchControl,
  loadWorkflowResource,
  goalMetaByWorkflowId,
  scheduleMetaByWorkflowId,
  readOnlyDisabledMode = false,
  onJumpToActivity,
}: NativeTasksViewProps) {
  const [categoryFilter, setCategoryFilter] = useState<TaskCategoryFilter>('all');

  const goals = useMemo(
    () => (projection ? selectGoalCards(projection, goalMetaByWorkflowId) : []),
    [projection, goalMetaByWorkflowId],
  );
  const schedules = useMemo(
    () => (projection ? selectScheduleCards(projection, scheduleMetaByWorkflowId) : []),
    [projection, scheduleMetaByWorkflowId],
  );
  const categorized = useMemo(
    () =>
      projection
        ? buildCategorizedTasks(projection)
        : {
            items: [],
            countsByCategory: {
              all: 0,
              goal: 0,
              schedule: 0,
              finite_command: 0,
              daemon: 0,
              workflow_step: 0,
              subagent: 0,
              unknown: 0,
            },
          },
    [projection],
  );

  const filteredTasks = useMemo(
    () =>
      categorized.items.filter((item) =>
        categoryMatches(categoryFilter, item.category, item.state.kind),
      ),
    [categorized.items, categoryFilter],
  );

  if (!projection) {
    return (
      <div data-testid="np12-native-tasks-view" className="space-y-3">
        <CapabilityUnavailable
          title="Native Tasks · 原生运行时尚未连接"
          gate="unknown"
          capabilityId="AGY-W11"
          reason="当前会话尚未接收到原生运行时快照（或 native runtime 门控未开启）。现有对话与历史任务记录不受影响。"
          officialEntryHint="在官方 CLI 中使用 /tasks (Ctrl+T)、/goal 或 /schedule 查看原生任务。"
          officialDocUrl="https://antigravity.google/docs/cli/reference/"
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天"
        />
        <AppAutomationsClosureCard />
      </div>
    );
  }

  const runtimeDisconnected =
    projection.status === 'disconnected' || projection.status === 'reconciling';

  const jumpToActivity = (activityId: ActivityId) => {
    if (onJumpToActivity) {
      onJumpToActivity(activityId);
      return;
    }
    onNavigate({ surface: 'runtime', selectedActivityId: activityId });
  };

  const showGoals = categoryFilter === 'all' || categoryFilter === 'goal';
  const showSchedules = categoryFilter === 'all' || categoryFilter === 'schedule';

  const statusTone = toneStyle(
    projection.status === 'disconnected'
      ? 'rose'
      : projection.status === 'reconciling'
        ? 'star'
        : 'indigo',
  );

  return (
    <div
      data-testid="np12-native-tasks-view"
      data-narrow={isNarrowViewport ? 'true' : 'false'}
      data-readonly={readOnlyDisabledMode ? 'true' : 'false'}
      className="space-y-4"
    >
      {/* Top Read-only / Disconnected / Reconciling Notice */}
      {readOnlyDisabledMode && (
        <div
          data-testid="np12-readonly-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 text-[11.5px]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-strong)',
          }}
        >
          <div className="flex items-start gap-2">
            <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--accent-clay)]" aria-hidden="true" />
            <div>
              <div className="font-semibold text-[var(--text-primary)]">
                写入与控制动作已关闭（只读历史保留模式）
              </div>
              <p className="mt-0.5 text-[var(--text-secondary)]">
                已到期或已观测的 Goal / Schedule occurrence 历史保持只读可见；真实已有计划的删除仍由用户经原生端完成。
              </p>
            </div>
          </div>
          <EntityStatusBadge kind="gate" gate="unsupported" compact />
        </div>
      )}

      {runtimeDisconnected && (
        <div
          data-testid="np12-recovery-banner"
          className="rounded-2xl border p-3 text-[11.5px]"
          style={{
            backgroundColor: statusTone.backgroundColor,
            borderColor: statusTone.borderColor,
            color: statusTone.color,
          }}
        >
          {projection.status === 'disconnected'
            ? '观测连接已断开：未结束的 Goal、Schedule 与任务保持过期/未确认状态，已到期历史只读保留，不制造原生成功或取消。'
            : '正在校准恢复状态：按 scope 校验与跨代去重对齐，未获新实时帧前不恢复租约。'}
        </div>
      )}

      {/* Category Filter Bar */}
      <section className="space-y-2" aria-label="任务类别筛选">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <ListTodo size={12.5} aria-hidden="true" />
            <span>Native Tasks 分类视图 ({filteredTasks.length})</span>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="按原生任务类别筛选">
            {CATEGORY_FILTER_OPTIONS.map((opt) => {
              const active = categoryFilter === opt.key;
              const count = categorized.countsByCategory[opt.key] ?? 0;
              return (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={active}
                  data-testid={`np12-filter-${opt.key}`}
                  onClick={() => setCategoryFilter(opt.key)}
                  className="cursor-pointer rounded-lg border px-2 py-0.5 text-[10.5px]"
                  style={{
                    backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-surface)',
                    borderColor: active ? 'var(--border-focus)' : 'var(--border-hairline)',
                    color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                  }}
                >
                  {opt.label} ({count})
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Independent Goal Panel */}
      {showGoals && (
        <GoalDetailPanel
          goals={goals}
          binding={projection.binding}
          capabilities={capabilities}
          runtimeDisconnected={runtimeDisconnected}
          readOnlyDisabledMode={readOnlyDisabledMode}
          onJumpToActivity={jumpToActivity}
          onDispatchControl={onDispatchControl}
        />
      )}

      {/* Independent Schedule & Occurrence Panel */}
      {showSchedules && (
        <ScheduleDetailPanel
          schedules={schedules}
          binding={projection.binding}
          capabilities={capabilities}
          runtimeDisconnected={runtimeDisconnected}
          readOnlyDisabledMode={readOnlyDisabledMode}
          onJumpToActivity={jumpToActivity}
          onDispatchControl={onDispatchControl}
          loadWorkflowResource={loadWorkflowResource}
        />
      )}

      {/* Aggregated Runtime Tasks (Finite Commands, Daemons, Steps, Unknown) */}
      <section
        data-testid="np12-aggregated-tasks-section"
        aria-label="Runtime Center 聚合任务列表"
        className="space-y-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <Terminal size={12.5} aria-hidden="true" />
            <span>Runtime Center 聚合条目 ({filteredTasks.length})</span>
          </h3>
          <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
            官方管理：/tasks · Ctrl+T
          </span>
        </div>

        {filteredTasks.length === 0 ? (
          <div
            data-testid="np12-empty-tasks"
            className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]"
          >
            <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
            <p className="mt-0.5 text-[10.5px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredTasks.map((item) => {
              const selected =
                (item.workId && route.selectedWorkId === item.workId) ||
                (item.workflowId && route.selectedWorkflowId === item.workflowId);
              return (
                <div
                  key={`${item.category}:${item.id}`}
                  data-testid={`np12-task-row-${item.id}`}
                  data-task-category={item.category}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11.5px]"
                  style={{
                    backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-surface)',
                    borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                  }}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-primary)]">
                        {item.kindLabel}
                      </span>
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {item.title}
                      </span>
                      <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                        {item.id}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <EntityStatusBadge
                      kind="blocking"
                      blocking={item.blocking as NativeWork['blocking']}
                      compact
                    />
                    <EntityStatusBadge kind="work" observed={item.state} compact />
                    {item.outcome && <EntityStatusBadge kind="outcome" observed={item.outcome} compact />}
                    {item.workId && (
                      <button
                        type="button"
                        data-testid={`np12-open-runtime-${item.id}`}
                        onClick={() =>
                          onNavigate({
                            surface: 'runtime',
                            selectedWorkId: item.workId,
                            ...(item.originActivityId
                              ? { selectedActivityId: item.originActivityId }
                              : {}),
                          })
                        }
                        className="inline-flex cursor-pointer items-center gap-0.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      >
                        <span>Runtime</span>
                        <ArrowUpRight size={10} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <CapabilityUnavailable
          title="/tasks 协议暴露评估（只读聚合视图）"
          gate="upstream_limited"
          capabilityId="AGY-W11"
          reason="当前 ACP v1 未暴露结构化 /tasks 列表、直接 killTask 或 sendInput RPC；本视图聚合 live 工具流与运行时工作投影。真实已有计划的删除与后台交互请使用官方 /tasks。"
          officialEntryHint="官方 CLI 中使用 /tasks 或按 Ctrl+T；仅根会话支持 ACP session/cancel。"
          officialDocUrl="https://antigravity.google/docs/cli/reference/"
          onRefresh={onRefresh}
        />
      </section>

      {/* App-Only Automations & Sidecars Evidence Closure */}
      <AppAutomationsClosureCard />
    </div>
  );
}
