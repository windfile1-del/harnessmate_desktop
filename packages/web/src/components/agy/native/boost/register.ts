import { createElement } from 'react';
import {
  agyWorkbenchRegistry,
  type AgyWorkbenchRegistry,
} from '../shared';
import { BoostStudioView } from './BoostStudioView';

/**
 * Registers the NP-09 Boost Studio domain view into the frozen NP-03 Workbench Registry
 * (`order: 200` overrides the built-in `order: 900` degraded shell without editing ChatStage/store).
 */
export function registerBoostStudioView(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
): () => void {
  return registry.registerView({
    id: 'boost',
    owner: 'np-09.boost-studio',
    title: 'Boost Studio',
    shortTitle: 'Boost',
    description: '多段深度推理与独立验证工作台：按实证呈现阶段、验证线索、可观察活动与停止边界',
    capabilityIds: ['AGY-W06', 'agy.workflow.boost'],
    order: 200,
    badgeCount: (projection, pendingApprovals) => {
      if (!projection) return 0;
      const boostWorkflows = projection.workflows.filter((wf) => wf.detail.kind === 'boost');
      const activeRuns = boostWorkflows.filter(
        (wf) =>
          wf.state.kind === 'known' &&
          (wf.state.value === 'running' ||
            wf.state.value === 'queued' ||
            wf.state.value === 'waiting' ||
            wf.state.value === 'requires_action'),
      ).length;
      const boostActivityIds = new Set(boostWorkflows.map((wf) => wf.originActivityId));
      const boostApprovals = pendingApprovals.filter((appr) => {
        const receipt = projection.receipts?.[appr.id];
        return Boolean(receipt?.activityId && boostActivityIds.has(receipt.activityId));
      }).length;
      return activeRuns + boostApprovals;
    },
    render: (props) => createElement(BoostStudioView, props),
  });
}
