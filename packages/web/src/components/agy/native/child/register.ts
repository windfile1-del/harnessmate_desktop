import { createElement } from 'react';
import {
  agyWorkbenchRegistry,
  type AgyWorkbenchRegistry,
} from '../shared/workbench-registry';
import { SubagentManagerView } from './SubagentManagerView';

/**
 * Registers the NP-05 Subagent Manager view on `agyWorkbenchRegistry` at order `200`,
 * overriding the built-in `order: 900` degraded shell without modifying shared files.
 */
export function registerSubagentManagerView(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
): () => void {
  return registry.registerView({
    id: 'subagents',
    owner: 'np-05',
    title: 'Subagent Manager',
    shortTitle: 'Subagents',
    description: '原生子 Agent 父子树、委派批次、独立子时间线与权限作用域管理',
    capabilityIds: ['agy.subagents', 'AGY-W01', 'AGY-W02'],
    order: 200,
    preferredLayout: 'split',
    badgeCount: (projection, pendingApprovals) => {
      if (!projection) return 0;
      const childCount = projection.agents.filter((a) => a.lineage === 'confirmed').length;
      const pendingForAgents = pendingApprovals.filter(
        (appr) => Boolean(projection.receipts?.[appr.id]?.agentId),
      ).length;
      return pendingForAgents > 0 ? pendingForAgents : Math.max(0, childCount - 1);
    },
    render: (props) => createElement(SubagentManagerView, props),
  });
}
