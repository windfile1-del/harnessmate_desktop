import { createElement } from 'react';
import {
  agyWorkbenchRegistry,
  type AgyWorkbenchRegistry,
} from '../shared/workbench-registry';
import { SwarmStudioView } from './SwarmStudioView';

/**
 * Registers the NP-08 Swarm Studio view on `agyWorkbenchRegistry` at order `200`,
 * overriding the built-in `order: 900` degraded shell without modifying shared files.
 *
 * Badge count reflects ONLY confirmed pending approvals on Swarm members or active running
 * confirmed workers (NEVER counting `idle` or `unknown` workers as completed progress).
 */
export function registerSwarmStudioView(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
): () => void {
  return registry.registerView({
    id: 'swarm',
    owner: 'np-08',
    title: 'Swarm Studio',
    shortTitle: 'Swarm',
    description: '原生 AGY Swarm Coordinator、实名 Workers/Verifier、只读共享 Board 与轨迹视图',
    capabilityIds: ['agy.workflow.swarm', 'AGY-W04', 'AGY-W05'],
    order: 200,
    preferredLayout: 'split',
    badgeCount: (projection, pendingApprovals) => {
      if (!projection) return 0;
      const swarmWorkflows = projection.workflows.filter((w) => w.detail.kind === 'swarm');
      if (swarmWorkflows.length === 0) return 0;

      const memberIds = new Set<string>();
      for (const wf of swarmWorkflows) {
        if (wf.detail.kind !== 'swarm') continue;
        if (wf.detail.coordinatorId) memberIds.add(wf.detail.coordinatorId);
        for (const wid of wf.detail.workerIds) memberIds.add(wid);
      }

      const pendingForSwarm = pendingApprovals.filter((appr) => {
        const receipt = projection.receipts?.[appr.id];
        return Boolean(
          receipt?.agentId &&
            receipt.targetLineage === 'confirmed' &&
            memberIds.has(receipt.agentId),
        );
      }).length;
      if (pendingForSwarm > 0) return pendingForSwarm;

      return projection.agents.filter(
        (a) =>
          memberIds.has(a.id) &&
          a.lineage === 'confirmed' &&
          a.foreground.kind === 'known' &&
          a.foreground.value === 'running',
      ).length;
    },
    render: (props) => createElement(SwarmStudioView, props),
  });
}
