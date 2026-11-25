import { createElement } from 'react';
import {
  agyWorkbenchRegistry,
  type AgyWorkbenchRegistry,
} from '../shared';
import { DynamicWorkflowStudio } from './DynamicWorkflowStudio';

export { DynamicWorkflowStudio } from './DynamicWorkflowStudio';
export {
  DynamicWorkflowScriptReview,
  type DynamicWorkflowScriptReviewProps,
} from './DynamicWorkflowScriptReview';
export {
  DynamicWorkflowGraphOrTimeline,
  type DynamicWorkflowGraphOrTimelineProps,
} from './DynamicWorkflowGraphOrTimeline';
export {
  DynamicWorkflowResultsAndLogs,
  type DynamicWorkflowResultsAndLogsProps,
} from './DynamicWorkflowResultsAndLogs';

export {
  DYNAMIC_WORKFLOW_STUDIO_CONTRACT_REVISION,
  type DynamicScriptApprovalDisplayState,
  type DynamicScriptPreviewData,
  type DynamicResultPreviewData,
  type DynamicWorkflowStudioProps,
  type DynamicWorkflowBannerPhase,
  type DynamicWorkflowBannerModel,
  type DynamicDagEdge,
  type DynamicDagLayer,
  type DynamicDagUnavailableReason,
  type DynamicDagAnalysis,
  type DynamicSortableTimelineItem,
  type DynamicWorkflowResourceItemView,
  type DynamicWorkflowCapabilityContext,
} from './types';

export {
  selectDynamicWorkflows,
  findDynamicWorkflowCapability,
  analyzeDynamicDag,
  deriveScriptApprovalState,
  deriveDynamicWorkflowBanner,
  buildSortableWorkflowTimeline,
  formatSafeStructuredPreview,
  normalizeWorkflowResourceItems,
} from './view-model';

export {
  createDynamicParallelSerialFixture,
  createDynamicDegradedAndForwardedFixture,
  type DynamicWorkflowWebFixture,
} from './fixtures';

/**
 * Registers the NP-11 Dynamic Workflow Studio domain view into the frozen NP-03 Workbench Registry
 * (`order: 110` overrides NP-03's built-in `order: 900` degraded shell with zero edits to ChatStage/store).
 */
export function registerDynamicWorkflowStudioView(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
): () => void {
  return registry.registerView({
    id: 'dynamic',
    owner: 'np-11.dynamic-workflow-studio',
    title: 'Dynamic Workflow Studio',
    shortTitle: 'Workflows',
    description: '动态工作流脚本审阅、phase/DAG 或可排序时序、分页日志与结构化结果',
    capabilityIds: ['AGY-W08', 'agy.workflow.dynamic'],
    order: 110,
    badgeCount: (projection, pendingApprovals) => {
      if (!projection) return 0;
      const dynamicIds = new Set(
        projection.workflows
          .filter((wf) => wf.detail.kind === 'dynamic')
          .map((wf) => wf.id),
      );
      if (dynamicIds.size === 0) return 0;
      const activeDynamic = projection.workflows.filter(
        (wf) =>
          wf.detail.kind === 'dynamic' &&
          wf.state.kind === 'known' &&
          (wf.state.value === 'running' ||
            wf.state.value === 'queued' ||
            wf.state.value === 'waiting' ||
            wf.state.value === 'requires_action'),
      ).length;
      const dynamicPending = Object.values(projection.receipts ?? {}).filter(
        (r) =>
          r.receiptState === 'pending' &&
          pendingApprovals.some((a) => a.id === r.approvalId),
      ).length;
      return activeDynamic + dynamicPending;
    },
    render: (props) => createElement(DynamicWorkflowStudio, props),
  });
}
