import { createElement } from 'react';
import { agyWorkbenchRegistry, type AgyWorkbenchRegistry } from '../shared';
import { NativeTasksView } from './NativeTasksView';

/**
 * Registers the NP-12 Native Tasks (Goal & Schedule) view into `AgyWorkbenchRegistry`
 * (`order: 120` overrides NP-03's built-in `order: 900` degraded shell cleanly).
 */
export function registerNativeTasksView(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
): () => void {
  return registry.registerView({
    id: 'tasks',
    owner: 'np-12.native-tasks',
    title: 'Native Tasks · Goal & Schedule',
    shortTitle: 'Native Tasks',
    description: 'Goal 目标验证、Schedule 定时唤醒与 Runtime Center 分类任务（App Automations 另列）',
    capabilityIds: ['AGY-W09', 'AGY-W10', 'AGY-W11', 'AGY-W12'],
    order: 120,
    badgeCount: (projection) => {
      if (!projection) return 0;
      const activeWorkflows = projection.workflows.filter(
        (wf) =>
          (wf.detail.kind === 'goal' || wf.detail.kind === 'schedule') &&
          wf.state.kind === 'known' &&
          (wf.state.value === 'running' ||
            wf.state.value === 'waiting' ||
            wf.state.value === 'queued' ||
            wf.state.value === 'requires_action'),
      ).length;
      const activeScheduleOccurrences = projection.work.filter(
        (w) =>
          w.kind === 'schedule' &&
          w.state.kind === 'known' &&
          (w.state.value === 'running' || w.state.value === 'waiting'),
      ).length;
      return activeWorkflows + activeScheduleOccurrences;
    },
    render: (props) => createElement(NativeTasksView, props),
  });
}
