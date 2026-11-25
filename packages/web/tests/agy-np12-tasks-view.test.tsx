import type { Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AgyWorkbenchRegistry,
  AgyWorkbenchShell,
  DEFAULT_WORKBENCH_ROUTE,
  registerDefaultWorkbenchViews,
} from '../src/components/agy/native/shared';
import {
  NativeTasksView,
  buildCategorizedTasks,
  createGoalAndScheduleTasksFixture,
  formatNativeTime,
  registerNativeTasksView,
  selectScheduleCards,
} from '../src/components/agy/native/tasks';
import type { ActivityId, Observed } from '../src/lib/native-client';

const sampleSession: Session = {
  id: 'sess_np12_web',
  workspaceId: 'ws_np12',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'NP-12 Native Tasks Test',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 5,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

describe('NP-12 Native Tasks, Goal & Schedule Frontend View', () => {
  it('registers into AgyWorkbenchRegistry (order=120) and overrides NP-03 default tasks shell', () => {
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);
    const dispose = registerNativeTasksView(registry);

    const view = registry.getView('tasks');
    expect(view?.owner).toBe('np-12.native-tasks');
    expect(view?.order).toBe(120);

    const fixture = createGoalAndScheduleTasksFixture(sampleSession.id, 'live_wake_and_cron');
    const html = renderToStaticMarkup(
      <AgyWorkbenchShell
        registry={registry}
        session={sampleSession}
        projection={fixture.projection}
        capabilities={fixture.capabilities}
        pendingApprovals={fixture.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'tasks' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        loadWorkflowResource={fixture.loadWorkflowResource}
      />,
    );

    expect(html).toContain('np12-native-tasks-view');
    expect(html).toContain('np12-goal-section');
    expect(html).toContain('np12-schedule-section');
    expect(html).toContain('np12-app-automations-closure');

    dispose();
    expect(registry.getView('tasks')?.owner).not.toBe('np-12.native-tasks');
  });

  it('renders separate Goal/Schedule controls, explicit native timezone vs unknown, and wake jump availability', () => {
    const fixture = createGoalAndScheduleTasksFixture(sampleSession.id, 'live_wake_and_cron');
    const onJumpToActivity = vi.fn();

    const html = renderToStaticMarkup(
      <NativeTasksView
        session={sampleSession}
        projection={fixture.projection}
        capabilities={fixture.capabilities}
        pendingApprovals={fixture.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'tasks' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        goalMetaByWorkflowId={fixture.goalMetaByWorkflowId}
        scheduleMetaByWorkflowId={fixture.scheduleMetaByWorkflowId}
        onJumpToActivity={onJumpToActivity}
      />,
    );

    // Goal replacement & artifacts
    expect(html).toContain('已被新 Goal 替换（历史只读保留）');
    expect(html).toContain('art_goal_verify_1');

    // One-shot schedule with explicit native timezone & observed wake jump button
    expect(html).toContain('单次定时 (One-shot)');
    expect(html).toContain('原生时区：Asia/Shanghai');
    expect(html).toContain('np12-jump-wake-wrk_occ_1');

    // Simulated cron with missing nextAt & unknown native timezone (never guessed locally)
    expect(html).toContain('周期 Cron');
    expect(html).toContain('未由原生端提供（不本地猜测）');
    expect(html).toContain('原生时区未知');
    expect(html).toContain('np12-jump-wake-wrk_occ_2');
    expect(html).not.toContain('np12-jump-wake-wrk_occ_3');
    expect(html).toContain('未观察到 wake');

    // Categorization & Runtime Center aggregation + App Automations closure
    expect(html).toContain('np12-filter-finite_command');
    expect(html).toContain('np12-filter-daemon');
    expect(html).toContain('pnpm test (finite)');
    expect(html).toContain('dev-server (IsDaemon)');
    expect(html).toContain('AGY-W12 · AGY-E08');
    expect(html).toContain('真实已有计划的删除、暂停或编辑仍由用户经原生端');

    // Unit checks on view-model categorization & timezone formatter
    const categorized = buildCategorizedTasks(fixture.projection);
    expect(categorized.countsByCategory.goal).toBe(2);
    expect(categorized.countsByCategory.schedule).toBe(5); // 2 schedule workflows + 3 occurrence works
    expect(categorized.items.filter((i) => i.category === 'schedule' && !i.workId)).toHaveLength(2);
    expect(categorized.items.filter((i) => i.category === 'schedule' && Boolean(i.workId))).toHaveLength(3);
    expect(categorized.countsByCategory.finite_command).toBe(1);
    expect(categorized.countsByCategory.daemon).toBe(1);

    const unknownTzFormat = formatNativeTime(
      {
        kind: 'known',
        value: 1_764_100_025_000,
        evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 1_764_100_025_000 },
      },
      { kind: 'unknown', reasonCode: 'native_timezone_not_exposed' } satisfies Observed<string>,
    );
    expect(unknownTzFormat.timezoneLabel).toBe('原生时区未知');
    expect(unknownTzFormat.text).toContain('UTC');

    const missingNextAt = formatNativeTime(
      { kind: 'unknown', reasonCode: 'not_exposed' },
      { kind: 'unknown', reasonCode: 'not_exposed' },
    );
    expect(missingNextAt.nextAtKnown).toBe(false);
    expect(missingNextAt.text).toContain('未由原生端提供');

    const scheduleCards = selectScheduleCards(fixture.projection, fixture.scheduleMetaByWorkflowId);
    expect(scheduleCards[0]?.occurrences[0]?.hasObservedWake).toBe(true);
    expect(scheduleCards[0]?.occurrences[0]?.latestWakeActivityId).toBe('act_wake_oneshot_1');
    expect(scheduleCards[1]?.occurrences[0]?.latestWakeActivityId).toBe('act_wake_cron_1');
    expect(scheduleCards[1]?.occurrences[1]?.hasObservedWake).toBe(false);
  });

  it('supports read-only disabled mode preserving expired history, disconnected recovery notice, empty honesty, and 480px narrow sheet', () => {
    const fixture = createGoalAndScheduleTasksFixture(
      sampleSession.id,
      'disconnected_expired_readonly',
    );
    const html = renderToStaticMarkup(
      <NativeTasksView
        session={sampleSession}
        projection={fixture.projection}
        capabilities={fixture.capabilities}
        pendingApprovals={fixture.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'tasks' }}
        isNarrowViewport={true}
        readOnlyDisabledMode={true}
        goalMetaByWorkflowId={fixture.goalMetaByWorkflowId}
        scheduleMetaByWorkflowId={fixture.scheduleMetaByWorkflowId}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );

    expect(html).toContain('data-narrow="true"');
    expect(html).toContain('data-readonly="true"');
    expect(html).toContain('np12-readonly-banner');
    expect(html).toContain('np12-recovery-banner');
    expect(html).toContain('到期/终态只读保留');
    expect(html).toContain('wrk_occ_1');

    // Null projection falls back honestly with CapabilityUnavailable + App Automations closure
    const noProjHtml = renderToStaticMarkup(
      <NativeTasksView
        session={sampleSession}
        projection={null}
        capabilities={fixture.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'tasks' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(noProjHtml).toContain('Native Tasks · 原生运行时尚未连接');
    expect(noProjHtml).toContain('np12-app-automations-closure');

    // Empty projection shows honest empty state copy
    const emptyProjHtml = renderToStaticMarkup(
      <NativeTasksView
        session={sampleSession}
        projection={{
          ...fixture.projection,
          status: 'attached',
          workflows: [],
          work: [],
          activities: [],
        }}
        capabilities={fixture.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'tasks' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(emptyProjHtml).toContain('尚未观察到活动');
    expect(emptyProjHtml).toContain('空列表仅表示当前未观察到条目，不能证明后台任务已停止');
    expect(onJumpToActivityCheck(('act_wake_oneshot_1' as ActivityId))).toBe('act_wake_oneshot_1');
  });
});

function onJumpToActivityCheck(id: ActivityId): ActivityId {
  return id;
}
