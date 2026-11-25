import type { NativeWorkflowDescriptorContribution } from '../commands/descriptors.js';

/**
 * NP-14 Capability Descriptor Contributions for AGY-W13, AGY-W14, AGY-W15, and AGY-W16.
 * Strictly honors 02_Capability_Matrix.md gates: unverified live protocol controls
 * remain `upstream_limited` / `unsupported` / `not_tested`.
 */
export const NP14_CAPABILITY_CONTRIBUTIONS: readonly NativeWorkflowDescriptorContribution[] =
  Object.freeze<readonly NativeWorkflowDescriptorContribution[]>([
    {
      contributorId: 'np-14.plan',
      capabilityId: 'AGY-W13',
      slashName: 'plan',
      title: 'Plan 与执行步骤',
      description: '区分标准 ACP plan、AGY update_steps 与权限模式状态；不与 Artifact Review 混淆。',
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      officialEntry: '官方 CLI /plan · ACP session/update(plan)',
      evidenceRefs: ['E05', 'S06', 'S20', 'T16-synthetic'],
      verifiedLevel: null,
      launchGateOverride: 'available',
      observeGateOverride: 'available',
      controlGateOverride: 'available',
      localReadGateOverride: 'not_tested',
    },
    {
      contributorId: 'np-14.artifacts',
      capabilityId: 'AGY-W14',
      aliasIds: ['agy.artifacts.review'],
      slashName: 'artifact',
      title: 'Artifacts、审阅与行级反馈',
      description:
        '受控白名单只读产物预览、脱敏与 XSS 防御；原生行级评论与批准需先获真实 ACP wire 证据并受独立门控。',
      surfaces: ['desktop', 'cli', 'ide'],
      officialEntry: '官方 App Artifact tab · CLI /artifact',
      evidenceRefs: ['E01', 'E06', 'S21', 'T12-synthetic', 'T13-synthetic', 'T16-synthetic'],
      verifiedLevel: null,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'available',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: 'available',
    },
    {
      contributorId: 'np-14.diff',
      capabilityId: 'AGY-W15',
      slashName: 'diff',
      title: 'Diff 与变更审阅',
      description: '只读呈现 ACP 工具 Diff 与工作区变更，明确区分于 AGY 原生 Artifact Review。',
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      officialEntry: '官方 App Diff 面板 · CLI /diff',
      evidenceRefs: ['E05', 'S20', 'T16-synthetic'],
      verifiedLevel: null,
      launchGateOverride: 'available',
      observeGateOverride: 'available',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: 'available',
    },
    {
      contributorId: 'np-14.browser',
      capabilityId: 'AGY-W16',
      aliasIds: ['agy.browser.agent'],
      slashName: 'browser',
      title: 'Browser Agent 观测',
      description:
        '仅观测真实 Browser Agent 角色、脱敏日志与受门控截图/录像元数据；区分 App 内嵌（App-only）与 CLI/企业 Chrome MCP，不复刻内嵌浏览器控制。',
      surfaces: ['desktop', 'cli', 'ide'],
      officialEntry: '官方 App 内嵌浏览器 (v2.30+) · Chrome 144+ MCP',
      evidenceRefs: ['E01', 'T16-synthetic'],
      verifiedLevel: null,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'unsupported',
      localReadGateOverride: 'not_tested',
    },
  ]);
