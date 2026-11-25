import { createElement } from 'react';
import {
  agyWorkbenchRegistry,
  type AgyWorkbenchRegistry,
} from '../shared/workbench-registry';
import { TeamworkStudioView } from './TeamworkStudioView';
import type { TeamworkReviewControlProps } from './types';

export interface RegisterTeamworkStudioOptions {
  readonly teamworkFeatureEnabled?: boolean;
  readonly reviewControl?: TeamworkReviewControlProps;
}

/**
 * Registers the NP-10 Teamwork Studio full-width project page on `agyWorkbenchRegistry`
 * at order `200`, cleanly overriding the built-in `order: 900` degraded shell without
 * editing `AgyWorkbenchShell`, `ChatStage`, or shared stores.
 */
export function registerTeamworkStudioView(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
  options?: RegisterTeamworkStudioOptions,
): () => void {
  return registry.registerView({
    id: 'teamwork',
    owner: 'np-10.teamwork',
    title: 'Teamwork Studio',
    shortTitle: 'Teamwork',
    description: '官方 /teamwork 需求访谈、Prompt Artifact 批准门控、项目作用域、角色与里程碑',
    capabilityIds: ['AGY-W07', 'agy.workflow.teamwork'],
    order: 200,
    preferredLayout: 'full',
    badgeCount: (projection, pendingApprovals) => {
      if (!projection) return 0;
      const teamworkWorkflows = projection.workflows.filter(
        (wf) => wf.detail.kind === 'teamwork',
      );
      if (teamworkWorkflows.length === 0) return 0;
      const scopingIds = new Set(
        teamworkWorkflows
          .map((wf) => (wf.detail.kind === 'teamwork' ? wf.detail.scopingActivityId : undefined))
          .filter(Boolean),
      );
      const pendingTeamworkRequests = pendingApprovals.filter((appr) => {
        const receipt = projection.receipts?.[appr.id];
        return Boolean(receipt?.activityId && scopingIds.has(receipt.activityId));
      }).length;
      return pendingTeamworkRequests > 0 ? pendingTeamworkRequests : teamworkWorkflows.length;
    },
    render: (props) =>
      createElement(TeamworkStudioView, {
        ...props,
        ...(options?.teamworkFeatureEnabled !== undefined
          ? { teamworkFeatureEnabled: options.teamworkFeatureEnabled }
          : {}),
        ...(options?.reviewControl ? { reviewControl: options.reviewControl } : {}),
      }),
  });
}
