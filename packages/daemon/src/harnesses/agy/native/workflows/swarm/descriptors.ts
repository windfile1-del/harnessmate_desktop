import type { GateState } from '@harnessmate/protocol';
import type { AgyNativeCommandCatalogService } from '../../commands/catalog.js';
import type { NativeWorkflowDescriptorContribution } from '../../commands/descriptors.js';
import {
  DEFAULT_SWARM_OBSERVER_GATES,
  SWARM_OFFICIAL_BOARD_HINT,
  SWARM_OFFICIAL_CLI_LAUNCH_HINT,
  type SwarmObserverGateConfig,
} from './contracts.js';

/**
 * Capability descriptor contributions for NP-08 Swarm (`AGY-W04` / `agy.workflow.swarm`)
 * and Swarm Board (`AGY-W05`).
 *
 * Follows NP-06 ownership rules:
 * - Workflow domains contribute ONLY descriptors & metadata via `registerWorkflowDescriptor`.
 * - Never creates a separate global command executor.
 * - Keeps `live_workflow` launch gated by runtime advertisement + feature gates, and keeps
 *   Board/member control `upstream_limited` until verified live ACP protocol support exists.
 */
export function buildSwarmDescriptorContributions(
  gates: SwarmObserverGateConfig = DEFAULT_SWARM_OBSERVER_GATES,
): readonly NativeWorkflowDescriptorContribution[] {
  const swarmLaunchGate: GateState =
    gates.swarmEnabled && gates.liveLaunchEnabled ? 'unknown' : 'not_tested';
  const swarmObserveGate: GateState = gates.swarmEnabled ? 'upstream_limited' : 'not_tested';
  const boardObserveGate: GateState =
    gates.swarmEnabled && gates.boardFeedEnabled ? 'upstream_limited' : 'upstream_limited';
  const boardLocalReadGate: GateState =
    gates.localBoardSnapshotEnabled ? 'unknown' : 'not_tested';

  return [
    {
      contributorId: 'np-08-swarm',
      capabilityId: 'AGY-W04',
      aliasIds: ['agy.workflow.swarm'],
      slashName: 'swarm',
      title: 'Swarm 协作工作流',
      description:
        '以真实 AGY Swarm 执行为唯一来源，分开投影 Coordinator、实名 Workers/Verifier 与共享 Board；不伪造本地编排或从工具标题生成 worker。',
      surfaces: ['desktop', 'cli', 'acp'],
      tierHint: 'Preview',
      versionNote: 'Coordinator 通用流可观察；worker/Board 结构化 feed 依上游 ACP 实证门控',
      officialEntry: SWARM_OFFICIAL_CLI_LAUNCH_HINT,
      evidenceRefs: ['E01', 'T10-OFFLINE-SYNTHETIC'],
      verifiedLevel: null,
      launchGateOverride: swarmLaunchGate,
      observeGateOverride: swarmObserveGate,
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: boardLocalReadGate,
      actions: [
        {
          key: 'launch_swarm',
          lane: 'live_workflow',
          label: '发起 Swarm (/swarm)',
          slashCommand: '/swarm',
          argumentHint: '<协作目标>',
          officialEntry: SWARM_OFFICIAL_CLI_LAUNCH_HINT,
          description: '在当前 live ACP 会话中单次发送 /swarm <task>，等待真实原生确认。',
          requiresLiveSession: true,
          requiresRuntimeAdvertisement: true,
          requiresAuthenticatedProfile: true,
          disallowAgyDesktopSource: true,
          supportsAttachments: true,
          args: [
            {
              name: 'task',
              required: true,
              type: 'string',
              maxLength: 1000,
              description: 'Swarm 协作任务目标',
            },
          ],
        },
      ],
    },
    {
      contributorId: 'np-08-swarm',
      capabilityId: 'AGY-W05',
      slashName: 'swarm-board',
      title: 'Swarm Board 共享协作板',
      description:
        '只读呈现已验证的同作用域 Board 帖子、线程与真实 @mention 唤醒；缺原生 feed 时展示官方入口说明，禁止自动发送 mention 或生成假帖子。',
      surfaces: ['desktop', 'cli'],
      versionNote: 'AGY 1.5.16 修复了系统 attribution，但 ACP 尚未公开标准 Board feed',
      officialEntry: SWARM_OFFICIAL_BOARD_HINT,
      evidenceRefs: ['E01', 'T10-OFFLINE-SYNTHETIC'],
      verifiedLevel: null,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: boardObserveGate,
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: boardLocalReadGate,
      actions: [
        {
          key: 'open_swarm_board',
          lane: 'manager',
          label: '查看 Swarm Board (/swarm board)',
          slashCommand: '/swarm board',
          officialEntry: SWARM_OFFICIAL_BOARD_HINT,
          description: '基于已验证的 Board resource 稳定 ID 分页展示帖子；缺源时提供官方 /swarm board 与 Alt+S 指引。',
        },
      ],
    },
  ];
}

/**
 * Registers NP-08 Swarm & Board capability descriptor contributions into NP-06's catalog service.
 * Returns a disposer that cleanly removes both contributions on teardown/rollback.
 */
export function registerSwarmCapabilityDescriptors(
  catalog: AgyNativeCommandCatalogService,
  gates: SwarmObserverGateConfig = DEFAULT_SWARM_OBSERVER_GATES,
): () => void {
  const disposers = buildSwarmDescriptorContributions(gates).map((contrib) =>
    catalog.registerWorkflowDescriptor(contrib),
  );
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
