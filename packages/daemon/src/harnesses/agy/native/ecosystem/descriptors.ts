import {
  CapabilityDescriptorSchema,
  type CapabilityDescriptor,
  type GateState,
} from '@harnessmate/protocol';
import type { AgyNativeCommandCatalogService } from '../commands/catalog.js';
import type { NativeWorkflowDescriptorContribution } from '../commands/descriptors.js';
import {
  DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
  type AgyEcosystemFeatureGates,
} from './types.js';

/**
 * Capability IDs in NP-13 scope that have NO live native ACP feed in AGY 1.5.16.
 * UI and callers must present them honestly with official entry hints rather than
 * fabricating live control state.
 */
export const NP13_NO_NATIVE_FEED_CAPABILITY_IDS: readonly string[] = Object.freeze([
  'AGY-W03',
  'AGY-S07',
  'AGY-S16',
  'AGY-E02',
  'AGY-E03',
  'AGY-E04',
  'AGY-E06',
  'AGY-E07',
  'AGY-E08',
  'AGY-E09',
  'AGY-E10',
  'AGY-X01',
  'AGY-X02',
  'AGY-X03',
]);

/**
 * Contributes NP-13 ecosystem & configuration capability descriptors to NP-06's
 * catalog without replacing NP-06's built-in executable actions (`AGY-E01`, `AGY-E05`, `AGY-S16`).
 */
export function buildEcosystemDescriptorContributions(
  gates: AgyEcosystemFeatureGates = DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
): readonly NativeWorkflowDescriptorContribution[] {
  const localReadGate = (enabled: boolean): GateState =>
    gates.ecosystemReadEnabled && enabled ? 'available' : 'not_tested';

  return [
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-W03',
      slashName: 'agents',
      title: 'Custom Agents 自定义角色发现',
      description:
        '只读发现工作区与 Profile 下的 Custom Agents Markdown 定义；切换主 Agent 可能需要新建会话或原生 Fork。',
      surfaces: ['desktop', 'cli', 'ide'],
      versionNote: 'ACP 切换 RPC 未验证；支持 --agent 启动参数与只读目录发现',
      officialEntry: 'agy agents · agy --agent <name> · /agents',
      evidenceRefs: ['E01', 'E04'],
      verifiedLevel: 1,
      launchGateOverride: 'unknown',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: localReadGate(gates.customAgentsLocalScanEnabled),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-S07',
      slashName: 'projects',
      title: 'Projects 与工作区设置',
      description: '展示已验证工作区根与 Profile 边界，不向原生私有 project files 写入或混同远端项目。',
      surfaces: ['desktop', 'cli', 'ide'],
      versionNote: 'ACP project 对象未暴露',
      officialEntry: '/projects · --project · --new-project',
      evidenceRefs: ['E01'],
      verifiedLevel: 1,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: localReadGate(true),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-S08',
      title: 'Additional Directories 多根授权',
      description: '校验并展示账号默认附加目录，拒绝越界路径或跳出授权根的符号链接。',
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      officialEntry: '--add-dir <dir>',
      evidenceRefs: ['E01', 'E02'],
      verifiedLevel: 1,
      launchGateOverride: 'available',
      observeGateOverride: 'available',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: localReadGate(true),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-S11',
      title: 'Native Orchestrator 模型角色',
      description: '区分 Planner/Executor 原生角色与账户计划约束；缺实证字段时保持只读说明。',
      surfaces: ['desktop', 'cli'],
      tierHint: 'Pro / Ultra / Enterprise',
      officialEntry: '/model · 原生 Orchestrator 设置',
      evidenceRefs: ['S20'],
      verifiedLevel: null,
      launchGateOverride: 'unknown',
      observeGateOverride: 'unknown',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: 'not_tested',
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-S14',
      title: '认证、Profile 隔离与手动账户生态',
      description: '保留手动登录/登出/切换与文件隔离，标注 #1610 企业并发约束，禁止自动轮换或读凭据。',
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      officialEntry: '官方 Google OAuth / API Key 手动设置',
      evidenceRefs: ['E02', 'S11'],
      verifiedLevel: 1,
      launchGateOverride: 'available',
      observeGateOverride: 'available',
      controlGateOverride: 'available',
      localReadGateOverride: 'available',
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E01',
      versionNote: 'AGY 1.5.16 优先级：工作区 > ~/.gemini > ~/.agents/skills',
      evidenceRefs: ['E01', 'S12', 'S13'],
      localReadGateOverride: localReadGate(gates.skillsDeepDiscoveryEnabled),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E02',
      title: 'Rules 与 AGENTS.md / GEMINI.md',
      description: '只读发现按路径去重的规则文件，提示 #1540 运行时复验状态，严禁注入 System Prompt。',
      surfaces: ['desktop', 'cli', 'ide'],
      versionNote: '受上游 CLI #1540 影响，本机 ACP 是否应用 Rules 待真机复验',
      officialEntry: 'AGENTS.md · GEMINI.md · .agents/rules/*.md',
      evidenceRefs: ['E01'],
      verifiedLevel: 0,
      launchGateOverride: 'unknown',
      observeGateOverride: 'unknown',
      controlGateOverride: 'unsupported',
      localReadGateOverride: localReadGate(gates.rulesVerificationEnabled),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E03',
      slashName: 'hooks',
      title: 'AGY Hooks 生命周期配置',
      description: '只读展示 hooks.json 事件名与组织禁用状态，绝不自行执行或与 HarnessMate V5 插件混用。',
      surfaces: ['desktop', 'cli'],
      officialEntry: '官方 CLI /hooks · hooks.json',
      evidenceRefs: ['E01', 'S21'],
      verifiedLevel: 0,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'unsupported',
      localReadGateOverride: localReadGate(gates.hooksMetadataReadEnabled),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E04',
      slashName: 'plugin',
      title: 'AGY Plugins（与 HM Plugins 双轨独立）',
      description: '只读展示 AGY 原生插件元数据与管理员禁用策略，与 HarnessMate 插件目录与权限完全隔离。',
      surfaces: ['desktop', 'cli', 'ide'],
      versionNote: 'AGY 1.5.16 含 managed plugin controls',
      officialEntry: '官方 CLI /plugin · agy plugin',
      evidenceRefs: ['E01', 'S21'],
      verifiedLevel: 1,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: localReadGate(gates.pluginsAndMcpMetadataEnabled),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E05',
      versionNote: 'AGY 全局 mcp_config.json（秘钥脱敏）与 HM 会话级 MCP 严格隔离',
      evidenceRefs: ['E02', 'S21'],
      localReadGateOverride: localReadGate(gates.pluginsAndMcpMetadataEnabled),
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E06',
      title: 'AGY MCP Apps',
      description: '无原生 ACP iframe schema；不混用 HarnessMate 沙箱预览。',
      surfaces: ['desktop'],
      officialEntry: 'Antigravity App MCP Apps',
      evidenceRefs: ['E01'],
      verifiedLevel: 0,
      launchGateOverride: 'unsupported',
      observeGateOverride: 'unsupported',
      controlGateOverride: 'unsupported',
      localReadGateOverride: 'unsupported',
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E07',
      slashName: 'learn',
      title: 'Learn 与配置发现 (/learn)',
      description: '仅提供官方入口说明；不自动修改用户私有规则或技能文件。',
      surfaces: ['desktop', 'cli', 'ide'],
      officialEntry: '官方 CLI /learn · /agy-customizations',
      evidenceRefs: ['E01'],
      verifiedLevel: 0,
      launchGateOverride: 'not_tested',
      observeGateOverride: 'not_tested',
      controlGateOverride: 'unsupported',
      localReadGateOverride: 'not_tested',
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E08',
      title: 'App Sidecars 与 agentapi',
      description: '仅作边界说明；HarnessMate 不启动、不接入也不代理原生 Sidecar。',
      surfaces: ['desktop'],
      officialEntry: 'Antigravity App Sidecars',
      evidenceRefs: ['E01'],
      verifiedLevel: 0,
      launchGateOverride: 'unsupported',
      observeGateOverride: 'unsupported',
      controlGateOverride: 'unsupported',
      localReadGateOverride: 'unsupported',
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E09',
      title: 'Antigravity SDK / IDE 旁系入口',
      description: '记录 SDK/IDE 与 ACP 边界差异，不引入第二套非官方运行时。',
      surfaces: ['ide'],
      officialEntry: 'https://antigravity.google/docs/sdk/overview/',
      evidenceRefs: ['E01'],
      verifiedLevel: 0,
      launchGateOverride: 'unsupported',
      observeGateOverride: 'unsupported',
      controlGateOverride: 'unsupported',
      localReadGateOverride: 'unsupported',
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-E10',
      title: 'AGY Marketplace',
      description: '原生市场无 ACP 列表协议，与 HarnessMate 插件商店完全分轨。',
      surfaces: ['desktop', 'cli', 'ide'],
      officialEntry: 'Antigravity App Marketplace',
      evidenceRefs: ['E01'],
      verifiedLevel: 0,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'unsupported',
      localReadGateOverride: 'unsupported',
    },
    {
      contributorId: 'np-13-ecosystem',
      capabilityId: 'AGY-X01',
      slashName: 'remote-control',
      title: 'AGY Remote Control',
      description: '独立于 HM-Remote；无 ACP 控制接口，HM 不代为启用原生远控。',
      surfaces: ['desktop', 'cli'],
      officialEntry: '官方 CLI /remote-control · agy remote-control',
      evidenceRefs: ['E01'],
      verifiedLevel: 1,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: 'unsupported',
    },
    {
      capabilityId: 'AGY-X02',
      contributorId: 'np-13-ecosystem',
      title: 'AGY Remote Agents',
      description: 'Google 托管远端会话；当前缺 ACP 作用域证据，不做本地推断。',
      surfaces: ['desktop', 'cli'],
      officialEntry: 'agy --remote-agent',
      evidenceRefs: ['E01'],
      verifiedLevel: 1,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'upstream_limited',
      localReadGateOverride: 'unsupported',
    },
    {
      capabilityId: 'AGY-X03',
      contributorId: 'np-13-ecosystem',
      title: 'AGY SSH Workspace',
      description: 'App SSH 远端项目；不复用或跨边界传递 SSH 凭据。',
      surfaces: ['desktop', 'ide'],
      officialEntry: 'Antigravity App SSH 新建项目',
      evidenceRefs: ['E01'],
      verifiedLevel: 0,
      launchGateOverride: 'upstream_limited',
      observeGateOverride: 'upstream_limited',
      controlGateOverride: 'unsupported',
      localReadGateOverride: 'unsupported',
    },
  ];
}

export function registerEcosystemCapabilityDescriptors(
  catalog: AgyNativeCommandCatalogService,
  gates: AgyEcosystemFeatureGates = DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
): () => void {
  const disposers = buildEcosystemDescriptorContributions(gates).map((contrib) =>
    catalog.registerWorkflowDescriptor(contrib),
  );
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

export function buildEcosystemCapabilityDescriptors(
  snapshotRevision: number,
  gates: AgyEcosystemFeatureGates = DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
  context?: {
    readonly profileVerified?: boolean;
    readonly source?: string | null;
    readonly tierName?: string | null;
  },
): CapabilityDescriptor[] {
  const contribs = buildEcosystemDescriptorContributions(gates);
  const optInQueryGate: GateState =
    gates.officialOptInQueryEnabled && context?.profileVerified && context?.source !== 'agy_desktop'
      ? 'available'
      : 'not_tested';

  return contribs.map((contrib) => {
    const actions: CapabilityDescriptor['actions'] = [];
    if (contrib.capabilityId === 'AGY-E01') {
      actions.push({
        key: 'query_skills',
        lane: 'query',
        gate: optInQueryGate,
        label: '官方 Opt-in 查询 Skills (/skills)',
        ...(optInQueryGate !== 'available'
          ? {
              reasonCode: !gates.officialOptInQueryEnabled
                ? 'opt_in_query_gate_disabled'
                : context?.source === 'agy_desktop'
                  ? 'desktop_source_unsupported'
                  : 'profile_unauthenticated',
            }
          : {}),
      });
    } else if (contrib.capabilityId === 'AGY-W03') {
      actions.push({
        key: 'query_agents',
        lane: 'query',
        gate: optInQueryGate,
        label: '官方 Opt-in 查询 Custom Agents (agy agents)',
        ...(optInQueryGate !== 'available'
          ? {
              reasonCode: !gates.officialOptInQueryEnabled
                ? 'opt_in_query_gate_disabled'
                : context?.source === 'agy_desktop'
                  ? 'desktop_source_unsupported'
                  : 'profile_unauthenticated',
            }
          : {}),
      });
    } else if (contrib.capabilityId === 'AGY-E05') {
      actions.push({
        key: 'inspect_mcp',
        lane: 'manager',
        gate: gates.ecosystemReadEnabled && gates.pluginsAndMcpMetadataEnabled ? 'available' : 'not_tested',
        label: '查看脱敏 MCP 作用域摘要',
      });
    }

    return CapabilityDescriptorSchema.parse({
      id: contrib.capabilityId,
      snapshotRevision,
      surfaces: contrib.surfaces ?? ['cli', 'acp'],
      ...(contrib.tierHint ? { tierHint: contrib.tierHint } : {}),
      ...(contrib.versionNote ? { versionNote: contrib.versionNote } : {}),
      advertised: null,
      launch: contrib.launchGateOverride ?? 'not_tested',
      observe: contrib.observeGateOverride ?? 'not_tested',
      control: contrib.controlGateOverride ?? 'upstream_limited',
      localRead: contrib.localReadGateOverride ?? 'not_tested',
      actions,
      evidenceRefs: [...(contrib.evidenceRefs ?? [])],
      verifiedLevel: contrib.verifiedLevel ?? null,
    });
  });
}
