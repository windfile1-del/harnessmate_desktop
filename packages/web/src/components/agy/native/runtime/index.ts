import { createElement } from 'react';
import {
  agyWorkbenchRegistry,
  type AgyWorkbenchRegistry,
} from '../shared';
import { AgyNativeRuntimeCenter } from './AgyNativeRuntimeCenter';

export { AgyNativeRuntimeCenter } from './AgyNativeRuntimeCenter';
export { RuntimeStatusBanner, type RuntimeStatusBannerProps } from './RuntimeStatusBanner';
export { RuntimeStopPanel, type RuntimeStopPanelProps } from './RuntimeStopPanel';
export {
  deriveRuntimeBannerModel,
  deriveStopStatusSummary,
  deriveStopTargetCandidates,
  extractLeaseReasons,
  findStopCapabilityAction,
  formatHonestWorkOutcome,
  type HonestOutcomeDisplay,
  type RuntimeBannerModel,
  type RuntimeBannerPhase,
  type StopInteractionPhase,
  type StopStatusSummary,
  type StopTargetCandidate,
} from './runtime-view-model';

/**
 * Registers the NP-04 Native Runtime Center domain view into the frozen NP-03 Workbench Registry
 * (`order: 100` overrides the built-in `order: 900` degraded shell without editing ChatStage/store).
 */
export function registerAgyNativeRuntimeView(
  registry: AgyWorkbenchRegistry = agyWorkbenchRegistry,
): () => void {
  return registry.registerView({
    id: 'runtime',
    owner: 'np-04.runtime-center',
    title: 'Native Runtime Center',
    shortTitle: 'Runtime',
    description: '实时原生连接、有限后台任务、常驻 Daemon、唤醒分段与停止控制',
    capabilityIds: ['AGY-R03', 'AGY-R04', 'AGY-R05', 'AGY-R10', 'AGY-W11'],
    order: 100,
    badgeCount: (projection, pendingApprovals) => {
      if (!projection) return pendingApprovals.length;
      const activeBlocking = projection.work.filter(
        (w) =>
          w.blocking === 'confirmed_blocking' &&
          w.state.kind === 'known' &&
          (w.state.value === 'running' ||
            w.state.value === 'queued' ||
            w.state.value === 'waiting' ||
            w.state.value === 'requires_action'),
      ).length;
      return activeBlocking + pendingApprovals.length;
    },
    render: (props) => createElement(AgyNativeRuntimeCenter, props),
  });
}
