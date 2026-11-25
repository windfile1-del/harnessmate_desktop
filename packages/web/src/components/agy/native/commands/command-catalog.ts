import type { HarnessModelInfo, ReasoningEffort } from '@harnessmate/protocol';
import type {
  CapabilityActionDescriptor,
  CapabilityDescriptor,
  CommandLane,
  GateState,
} from '../../../../lib/native-client';

export interface NativeCommandPaletteItem {
  readonly id: string;
  readonly capabilityId: string;
  readonly actionKey: string;
  readonly lane: CommandLane;
  readonly command: string;
  readonly title: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly officialEntry: string;
  readonly tierHint?: string;
  readonly gate: GateState;
  readonly advertised: boolean | null;
  readonly snapshotRevision: number;
  readonly runnable: boolean;
  readonly disabledReason?: string;
  readonly keywords: readonly string[];
}

export interface NativeModePickerItem {
  readonly id: string;
  readonly label: string;
  readonly capabilityId?: string;
  readonly actionKey?: string;
  readonly commandPrefix?: string;
  readonly placeholder: string;
  readonly description: string;
  readonly officialEntry: string;
  readonly tierHint?: string;
  readonly gate: GateState;
  readonly advertised: boolean | null;
  readonly snapshotRevision: number;
  readonly runnable: boolean;
  readonly disabledReason?: string;
  readonly sourceNote: string;
}

export interface ObservedConfigOptionLite {
  readonly id: string;
  readonly category?: string;
  readonly currentValue?: string;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly name?: string }>;
}

export interface ActualModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly group: string;
  readonly supportedEfforts: readonly ReasoningEffort[];
  readonly isCurrent: boolean;
}

export interface ActualModelEffortOptions {
  readonly currentModelId: string | null;
  readonly models: readonly ActualModelOption[];
  readonly currentEffort: ReasoningEffort | null;
  readonly availableEfforts: readonly ReasoningEffort[];
  readonly effortObserved: boolean;
  readonly effortUnavailableReason?: string;
}

export const COMMAND_LANE_META: Readonly<
  Record<CommandLane, { readonly label: string; readonly shortLabel: string; readonly hint: string }>
> = {
  query: {
    label: '只读查询',
    shortLabel: '查询',
    hint: '当前 Profile 隔离只读查询，不写入会话历史',
  },
  config: {
    label: '会话配置',
    shortLabel: '配置',
    hint: '校验实际可用选项后应用至当前会话',
  },
  live_workflow: {
    label: '原生工作流',
    shortLabel: '工作流',
    hint: '经同一 live ACP 会话单次发送，不落入辅助进程',
  },
  manager: {
    label: '管理入口',
    shortLabel: '管理',
    hint: '基于现有投影数据或官方 CLI/App 入口说明',
  },
};

const CAPABILITY_ID_ALIASES: Readonly<Record<string, string>> = {
  'agy.acp.v1': 'AGY-R01',
  'agy.reactive.background': 'AGY-R10',
  'agy.subagents': 'AGY-W01',
  'agy.workflow.swarm': 'AGY-W04',
  'agy.workflow.boost': 'AGY-W06',
  'agy.workflow.teamwork': 'AGY-W07',
  'agy.workflow.dynamic': 'AGY-W08',
  'agy.workflow.goal': 'AGY-W09',
  'agy.workflow.schedule': 'AGY-W10',
};

interface StaticCommandMeta {
  readonly capabilityId: string;
  readonly actionKey: string;
  readonly command: string;
  readonly title: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly officialEntry: string;
  readonly keywords: readonly string[];
  readonly mode?: {
    readonly id: string;
    readonly label: string;
    readonly placeholder: string;
  };
}

const STATIC_COMMAND_METADATA: readonly StaticCommandMeta[] = [
  {
    capabilityId: 'AGY-S15',
    actionKey: 'query_usage',
    command: '/usage',
    title: '查询 AGY 额度',
    description: '按当前绑定 Profile 只读查询订阅/配额窗口，不写入 conversation。',
    officialEntry: '官方 CLI /usage',
    keywords: ['usage', 'quota', '额度', '用量', '配额'],
  },
  {
    capabilityId: 'AGY-E01',
    actionKey: 'query_skills',
    command: '/skills',
    title: '列出原生技能',
    description: '按当前会话所属 Profile 查询工作区与全局可调用技能。',
    officialEntry: '官方 CLI /skills',
    keywords: ['skills', '技能', 'list'],
  },
  {
    capabilityId: 'AGY-E01',
    actionKey: 'invoke_skill',
    command: '/skill',
    title: '调用原生技能',
    description: '在当前 live ACP 会话中发送已验证技能调用，保留附件顺序。',
    argumentHint: '<名称> [参数]',
    officialEntry: '官方 CLI /<skill-name> [args]',
    keywords: ['skill', '技能', 'run'],
  },
  {
    capabilityId: 'AGY-S10',
    actionKey: 'inspect_models',
    command: '/model',
    title: '查看可用模型',
    description: '列出当前绑定实际观测到的可用模型及分组。',
    officialEntry: '官方 CLI /model · agy models',
    keywords: ['model', 'models', '模型', '列表'],
  },
  {
    capabilityId: 'AGY-S10',
    actionKey: 'set_model',
    command: '/model',
    title: '切换会话模型',
    description: '校验实际可用模型后切换当前会话模型，不自动降级或换号。',
    argumentHint: '<模型 ID | default>',
    officialEntry: '官方 CLI /model <id>',
    keywords: ['model', '模型', '切换', 'orchestrator', 'gemini'],
  },
  {
    capabilityId: 'AGY-S12',
    actionKey: 'set_effort',
    command: '/effort',
    title: '设置思考强度',
    description: '按当前模型实际返回的 thought_level 档位切换思考强度。',
    argumentHint: '<low | medium | high | xhigh | max>',
    officialEntry: '官方 CLI /effort <level>',
    keywords: ['effort', 'thinking', 'thought', '思考', '强度'],
  },
  {
    capabilityId: 'AGY-S13',
    actionKey: 'set_permission_mode',
    command: '/permissions',
    title: '切换权限模式',
    description: '按服务端实际广告权限切换，未广告原生 auto 时保持 client_guard。',
    argumentHint: '<manual | plan | accept_edits | auto>',
    officialEntry: '官方 CLI /permissions',
    keywords: ['permissions', 'mode', '权限', '审批'],
  },
  {
    capabilityId: 'AGY-W13',
    actionKey: 'set_plan_mode',
    command: '/plan',
    title: '计划模式',
    description: '进入/退出原生计划模式，带任务时在同一 live 会话中提交。',
    argumentHint: '[任务 | off]',
    officialEntry: '官方 CLI /plan [task | off]',
    keywords: ['plan', '计划', '规划'],
  },
  {
    capabilityId: 'AGY-W04',
    actionKey: 'launch_swarm',
    command: '/swarm',
    title: 'Swarm 协作',
    description: '由原生 Coordinator 协调实名 Workers 与 Verifier 并行推进。',
    argumentHint: '<协作目标>',
    officialEntry: '官方 CLI /swarm <task> · /swarm board',
    keywords: ['swarm', '协作', '多代理', 'workers'],
    mode: {
      id: 'swarm',
      label: 'Swarm 协作',
      placeholder: '输入 Swarm 协作目标（点击发送后经原生路由单次提交）…',
    },
  },
  {
    capabilityId: 'AGY-W06',
    actionKey: 'launch_boost',
    command: '/boost',
    title: 'Boost 深度验证',
    description: '按需触发原生实现、挑战、修复与独立验证流程。',
    argumentHint: '<深度任务>',
    officialEntry: '官方 CLI /boost <task>',
    keywords: ['boost', '深度验证', 'pro', 'ultra'],
    mode: {
      id: 'boost',
      label: 'Boost 深度验证',
      placeholder: '输入需要深度实现、挑战与验证的任务目标…',
    },
  },
  {
    capabilityId: 'AGY-W07',
    actionKey: 'launch_teamwork',
    command: '/teamwork',
    title: 'Teamwork 项目',
    description: '通过原生访谈、Prompt Artifact 审阅与多阶段里程碑推进项目。',
    argumentHint: '<项目目标>',
    officialEntry: '官方 App / CLI /teamwork <goal>',
    keywords: ['teamwork', '项目', '访谈', '里程碑'],
    mode: {
      id: 'teamwork',
      label: 'Teamwork 项目',
      placeholder: '输入 Teamwork 项目愿景，原生端将进入访谈与审阅…',
    },
  },
  {
    capabilityId: 'AGY-W08',
    actionKey: 'launch_dynamic_workflow',
    command: '/run-workflow',
    title: 'Dynamic Workflow',
    description: '在当前 live 会话中发起原生动态工作流脚本审阅与多阶段执行。',
    argumentHint: '<工作流任务>',
    officialEntry: '官方 App / CLI /run-workflow <task>',
    keywords: ['run-workflow', 'workflow', '动态工作流', 'dynamic'],
    mode: {
      id: 'dynamic',
      label: 'Dynamic Workflow',
      placeholder: '输入需由原生动态工作流编排的多阶段任务…',
    },
  },
  {
    capabilityId: 'AGY-W09',
    actionKey: 'launch_goal',
    command: '/goal',
    title: 'Goal 持续推进',
    description: '在目标验证达成前持续推进，复用同一 live ACP runtime。',
    argumentHint: '<目标描述>',
    officialEntry: '官方 CLI /goal <objective>',
    keywords: ['goal', '目标', '持续'],
    mode: {
      id: 'goal',
      label: 'Goal 持续推进',
      placeholder: '输入需持续核验直至达成的 Goal 目标…',
    },
  },
  {
    capabilityId: 'AGY-W10',
    actionKey: 'launch_schedule',
    command: '/schedule',
    title: 'Schedule 定时唤醒',
    description: '由 AGY 原生在同会话按时唤醒并记录每次 occurrence。',
    argumentHint: '<时间/cron> <任务>',
    officialEntry: '官方 CLI /schedule <when> <task>',
    keywords: ['schedule', 'cron', '定时', '唤醒'],
    mode: {
      id: 'schedule',
      label: 'Schedule 定时唤醒',
      placeholder: '输入时间与任务，例如：5m 复查构建状态…',
    },
  },
  {
    capabilityId: 'AGY-W17',
    actionKey: 'launch_grill_me',
    command: '/grill-me',
    title: 'Grill Me 设计访谈',
    description: '在当前 live ACP 会话中逐题对齐方案与设计决策。',
    argumentHint: '[主题]',
    officialEntry: '官方 CLI /grill-me [topic]',
    keywords: ['grill-me', '访谈', 'interview', '设计'],
  },
  {
    capabilityId: 'AGY-S09',
    actionKey: 'run_compact',
    command: '/compact',
    title: '原生上下文压缩',
    description: '在当前 live ACP 会话内执行原生 /compact 压缩。',
    officialEntry: '官方 CLI /compact',
    keywords: ['compact', '压缩', '上下文'],
  },
  {
    capabilityId: 'AGY-W02',
    actionKey: 'inspect_agents',
    command: '/agents',
    title: '原生 Agents 管理',
    description: '查看当前运行已观测的原生 Agents 与官方切换指引。',
    officialEntry: '官方 CLI /agents · agy agents',
    keywords: ['agents', 'subagent', '子代理', '管理'],
  },
  {
    capabilityId: 'AGY-W11',
    actionKey: 'inspect_tasks',
    command: '/tasks',
    title: '原生任务管理',
    description: '查看当前投影中的有限后台、daemon 与定时任务摘要。',
    officialEntry: '官方 CLI /tasks · Ctrl+T',
    keywords: ['tasks', '任务', '后台', 'daemon'],
  },
  {
    capabilityId: 'AGY-W05',
    actionKey: 'open_swarm_board',
    command: '/swarm board',
    title: 'Swarm Board 入口',
    description: '查看已观测 Swarm Board 数据或官方 /swarm board 操作说明。',
    officialEntry: '官方 CLI /swarm board · Alt+S',
    keywords: ['swarm', 'board', '协作板'],
  },
  {
    capabilityId: 'AGY-E05',
    actionKey: 'inspect_mcp',
    command: '/mcp',
    title: 'MCP 配置摘要',
    description: '只读展示全局 AGY MCP 与会话级 HarnessMate MCP 边界。',
    officialEntry: '官方 CLI /mcp · agy mcp',
    keywords: ['mcp', 'tools', '服务器'],
  },
  {
    capabilityId: 'AGY-S16',
    actionKey: 'inspect_credits',
    command: '/credits',
    title: '计划与 Credits 入口',
    description: '查看当前计划摘要与官方账单页面链接。',
    officialEntry: '官方 CLI /credits · antigravity.google',
    keywords: ['credits', 'billing', '计划', '账单'],
  },
];

export function resolveCanonicalCapabilityId(id: string): string {
  return CAPABILITY_ID_ALIASES[id] ?? id;
}

export function describeDisabledReason(params: {
  readonly gate: GateState;
  readonly reasonCode?: string;
  readonly advertised: boolean | null;
  readonly profileVerified: boolean;
  readonly tierHint?: string;
}): string | undefined {
  if (params.gate === 'available' && params.profileVerified) {
    return undefined;
  }
  switch (params.reasonCode) {
    case 'profile_unauthenticated':
      return '当前 Profile 尚未通过官方登录验证（仅可查看说明）';
    case 'unknown_dynamic_slash_disabled':
      return '未验证的动态 slash 命令，已关闭运行操作';
    case 'command_not_advertised_or_revoked':
      return '当前绑定未广告或已撤销该命令，已降级关闭';
    case 'advertisement_not_observed':
      return '尚未收到当前绑定的运行时命令广告（状态未知）';
    case 'tier_ineligible':
      return `当前账号计划不支持此模式${params.tierHint ? `（需 ${params.tierHint}）` : ''}`;
    case 'effort_options_not_observed':
      return '当前模型尚未返回实际 thought_level 选项';
    case 'agy_desktop_source_unsupported':
      return '当前会话来源于 AGY Desktop 只读历史，未开放此 CLI 命令';
    case 'no_live_connection':
      return '当前未建立 live ACP 连接，无法发起原生工作流';
    case 'permission_mode_restricted':
      return '当前权限模式限制了此命令的执行';
    default:
      break;
  }
  if (!params.profileVerified) {
    return '当前 Profile 尚未验证登录状态（可浏览说明，暂不可运行）';
  }
  if (params.advertised === false) {
    return '当前会话未广告或已撤销此能力';
  }
  switch (params.gate) {
    case 'unsupported':
      return '当前绑定不支持该操作';
    case 'upstream_limited':
      return '上游 ACP 暂未暴露此控制能力，请使用官方入口';
    case 'not_tested':
      return '尚未在本绑定完成实机/资格验证';
    case 'unknown':
      return '能力状态未知，等待运行时发现结果';
    default:
      return undefined;
  }
}

function indexDescriptorsByCanonicalId(
  descriptors: readonly CapabilityDescriptor[],
): Map<string, CapabilityDescriptor> {
  const map = new Map<string, CapabilityDescriptor>();
  for (const desc of descriptors) {
    const canonical = resolveCanonicalCapabilityId(desc.id);
    if (!map.has(canonical)) {
      map.set(canonical, desc);
    }
    if (!map.has(desc.id)) {
      map.set(desc.id, desc);
    }
  }
  return map;
}

/**
 * Single descriptor-driven projection used by BOTH `AgyNativeCommandPalette` and
 * `AgyNativeModePicker` so search, gates, disabled reasons, and revision metadata stay 100% in sync.
 */
export function buildNativeCommandItems(
  descriptors: readonly CapabilityDescriptor[],
  opts?: { readonly profileVerified?: boolean },
): NativeCommandPaletteItem[] {
  const profileVerified = opts?.profileVerified ?? false;
  const byId = indexDescriptorsByCanonicalId(descriptors);
  const items: NativeCommandPaletteItem[] = [];
  const handledUnknownIds = new Set<string>();

  for (const meta of STATIC_COMMAND_METADATA) {
    const desc = byId.get(meta.capabilityId);
    const action: CapabilityActionDescriptor | undefined = desc?.actions.find(
      (a) => a.key === meta.actionKey,
    );
    const lane: CommandLane = action?.lane ?? 'live_workflow';
    const rawGate: GateState = action?.gate ?? desc?.launch ?? 'unknown';
    const advertised = desc ? desc.advertised : null;
    const effectiveGate: GateState =
      !profileVerified && lane !== 'manager' && meta.actionKey !== 'inspect_models'
        ? rawGate === 'unsupported'
          ? 'unsupported'
          : 'not_tested'
        : rawGate;
    const runnable = effectiveGate === 'available';
    const disabledReason = runnable
      ? undefined
      : describeDisabledReason({
          gate: effectiveGate,
          reasonCode: action?.reasonCode,
          advertised,
          profileVerified,
          tierHint: desc?.tierHint,
        });

    items.push({
      id: `${meta.capabilityId}:${meta.actionKey}`,
      capabilityId: desc?.id ?? meta.capabilityId,
      actionKey: meta.actionKey,
      lane,
      command: meta.command,
      title: action?.label ?? meta.title,
      description: meta.description,
      ...(meta.argumentHint ? { argumentHint: meta.argumentHint } : {}),
      officialEntry: meta.officialEntry,
      ...(desc?.tierHint ? { tierHint: desc.tierHint } : {}),
      gate: effectiveGate,
      advertised,
      snapshotRevision: desc?.snapshotRevision ?? 0,
      runnable,
      ...(disabledReason ? { disabledReason } : {}),
      keywords: [...meta.keywords, meta.capabilityId, meta.actionKey, lane],
    });
  }

  // Also project unknown dynamically advertised slash commands as visible but strictly non-runnable
  for (const desc of descriptors) {
    if (!desc.id.startsWith('AGY-DYN-') || handledUnknownIds.has(desc.id)) continue;
    handledUnknownIds.add(desc.id);
    const act = desc.actions[0];
    const rawName = desc.id.replace(/^AGY-DYN-/, '');
    items.push({
      id: `${desc.id}:${act?.key ?? 'run_unknown_dynamic'}`,
      capabilityId: desc.id,
      actionKey: act?.key ?? 'run_unknown_dynamic',
      lane: act?.lane ?? 'live_workflow',
      command: `/${rawName}`,
      title: act?.label ?? `/${rawName}（未验证动态命令）`,
      description: desc.versionNote ?? `运行时广告的未验证命令 /${rawName}`,
      officialEntry: `官方 CLI /${rawName}`,
      gate: 'unsupported',
      advertised: desc.advertised,
      snapshotRevision: desc.snapshotRevision,
      runnable: false,
      disabledReason: describeDisabledReason({
        gate: 'unsupported',
        reasonCode: act?.reasonCode ?? 'unknown_dynamic_slash_disabled',
        advertised: desc.advertised,
        profileVerified,
      }),
      keywords: [rawName, desc.id, 'dynamic', 'unverified'],
    });
  }

  return items;
}

/**
 * Projects the exact same descriptor list into Mode Picker options, guaranteeing parity between
 * `AgyNativeCommandPalette` and `AgyNativeModePicker`.
 */
export function buildNativeModeItems(
  descriptors: readonly CapabilityDescriptor[],
  opts?: { readonly profileVerified?: boolean },
): NativeModePickerItem[] {
  const profileVerified = opts?.profileVerified ?? false;
  const commandItems = buildNativeCommandItems(descriptors, { profileVerified });
  const byCapAction = new Map(commandItems.map((item) => [`${item.capabilityId}:${item.actionKey}`, item]));
  const byId = indexDescriptorsByCanonicalId(descriptors);

  const modes: NativeModePickerItem[] = [
    {
      id: 'normal',
      label: '普通对话',
      placeholder: '向 Antigravity 发送普通指令 · / 原生命令 · @ 引用文件',
      description: '标准 AGY 单轮与原生后台续跑对话模式，保持原生 Agent 自主编排。',
      officialEntry: '直接输入并发送',
      gate: 'available',
      advertised: true,
      snapshotRevision: descriptors[0]?.snapshotRevision ?? 0,
      runnable: true,
      sourceNote: 'ACP v1 基础能力',
    },
  ];

  // Subagent reference mode from AGY-W01 descriptor
  const subagentDesc = byId.get('AGY-W01');
  const subagentGate: GateState = !profileVerified
    ? 'not_tested'
    : subagentDesc?.launch ?? 'unknown';
  const subagentRunnable = subagentGate === 'available';
  modes.push({
    id: 'subagent',
    label: '子 Agent 委派',
    capabilityId: subagentDesc?.id ?? 'AGY-W01',
    commandPrefix: '@agent',
    placeholder: '描述需要原生子 Agent 协作的子任务…',
    description: '经原生 Agent 委派或自定义角色执行独立子任务，身份以协议或版本化记录确证。',
    officialEntry: '官方 CLI /agents 或 @agent',
    tierHint: subagentDesc?.tierHint,
    gate: subagentGate,
    advertised: subagentDesc?.advertised ?? null,
    snapshotRevision: subagentDesc?.snapshotRevision ?? 0,
    runnable: subagentRunnable,
    disabledReason: subagentRunnable
      ? undefined
      : describeDisabledReason({
          gate: subagentGate,
          advertised: subagentDesc?.advertised ?? null,
          profileVerified,
          tierHint: subagentDesc?.tierHint,
        }),
    sourceNote: subagentDesc
      ? subagentDesc.advertised === true
        ? `当前会话已广告 · rev #${subagentDesc.snapshotRevision}`
        : `状态来自能力目录 · rev #${subagentDesc.snapshotRevision}`
      : '当前绑定尚未收到该模式的能力描述',
  });

  for (const meta of STATIC_COMMAND_METADATA) {
    if (!meta.mode) continue;
    const desc = byId.get(meta.capabilityId);
    const matched = byCapAction.get(`${desc?.id ?? meta.capabilityId}:${meta.actionKey}`);
    const gate = matched?.gate ?? 'unknown';
    const advertised = matched?.advertised ?? null;
    const rev = matched?.snapshotRevision ?? 0;
    const sourceNote = !profileVerified
      ? '当前 Profile 尚未通过官方登录验证（可浏览说明，暂不可运行）'
      : advertised === true
        ? `当前会话已广告 · rev #${rev}`
        : advertised === false
          ? `当前会话未广告或已撤销 · rev #${rev}`
          : `等待运行时命令广告 · rev #${rev}`;

    modes.push({
      id: meta.mode.id,
      label: meta.mode.label,
      capabilityId: matched?.capabilityId ?? meta.capabilityId,
      actionKey: meta.actionKey,
      commandPrefix: meta.command,
      placeholder: meta.mode.placeholder,
      description: meta.description,
      officialEntry: meta.officialEntry,
      tierHint: matched?.tierHint,
      gate,
      advertised,
      snapshotRevision: rev,
      runnable: matched?.runnable ?? false,
      disabledReason: matched?.disabledReason,
      sourceNote,
    });
  }

  return modes;
}

const normalize = (value: string) => value.normalize('NFKC').toLowerCase();

/**
 * Searches native command items by `/command`, title, capability ID, lane, or description.
 */
export function searchNativeCommandItems(
  items: readonly NativeCommandPaletteItem[],
  query: string,
  laneFilter?: CommandLane | 'all',
): NativeCommandPaletteItem[] {
  const filteredByLane =
    laneFilter && laneFilter !== 'all' ? items.filter((item) => item.lane === laneFilter) : items;
  const trimmed = normalize(query).trim().replace(/^\/+/, '');
  if (!trimmed) {
    // Runnable items appear before gated/disabled ones when browsing without a query
    return [...filteredByLane].sort((a, b) => Number(b.runnable) - Number(a.runnable));
  }

  const terms = trimmed.split(/\s+/).filter(Boolean);
  const scored: Array<{ item: NativeCommandPaletteItem; score: number }> = [];

  for (const item of filteredByLane) {
    const cmdBare = normalize(item.command).replace(/^\/+/, '');
    const haystack = [
      cmdBare,
      normalize(item.title),
      normalize(item.capabilityId),
      normalize(item.description),
      ...item.keywords.map(normalize),
    ];

    let total = 0;
    let allMatched = true;
    for (const term of terms) {
      let best = 0;
      if (cmdBare === term) best = 120;
      else if (cmdBare.startsWith(term)) best = 95;
      else {
        for (const field of haystack) {
          const idx = field.indexOf(term);
          if (idx === 0) best = Math.max(best, 80);
          else if (idx > 0) best = Math.max(best, 60);
        }
      }
      if (best === 0) {
        allMatched = false;
        break;
      }
      total += best;
    }
    if (allMatched) {
      scored.push({ item, score: total + (item.runnable ? 10 : 0) });
    }
  }

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.item);
}

const KNOWN_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

function classifyModelGroup(modelId: string): string {
  if (modelId.startsWith('gemini-pro-orchestrator')) return 'Orchestrator (Planner + Executor)';
  if (modelId.startsWith('gemini-')) return 'Google Gemini';
  if (modelId.startsWith('claude-')) return 'Anthropic Claude (via AGY)';
  if (modelId.startsWith('gpt-')) return 'OpenAI (via AGY)';
  return 'Other Models';
}

/**
 * Resolves actual available model and thought_level/effort options strictly from
 * observed runtime config options and harness metadata — never invents fake effort levels.
 */
export function resolveActualModelEffortOptions(params: {
  readonly harnessModels?: readonly HarnessModelInfo[];
  readonly activeModelId?: string | null;
  readonly activeEffort?: ReasoningEffort | null;
  readonly observedConfigOptions?: readonly ObservedConfigOptionLite[];
}): ActualModelEffortOptions {
  const configOpts = params.observedConfigOptions ?? [];
  const modelOpt = configOpts.find((o) => o.id === 'model' || o.category === 'model');
  const effortOpt = configOpts.find(
    (o) => o.id === 'thought_level' || o.category === 'thought_level',
  );

  const currentModelId = modelOpt?.currentValue ?? params.activeModelId ?? null;
  const byModel = new Map<string, ActualModelOption>();

  for (const hm of params.harnessModels ?? []) {
    const supported = (hm.supportedEfforts ?? []).filter((e): e is ReasoningEffort =>
      KNOWN_EFFORTS.has(e),
    );
    byModel.set(hm.id, {
      id: hm.id,
      displayName: hm.displayName || hm.id,
      group: hm.group || classifyModelGroup(hm.id),
      supportedEfforts: supported,
      isCurrent: hm.id === currentModelId,
    });
  }

  for (const choice of modelOpt?.options ?? []) {
    const existing = byModel.get(choice.value);
    byModel.set(choice.value, {
      id: choice.value,
      displayName: choice.name?.trim() || existing?.displayName || choice.value,
      group: existing?.group || classifyModelGroup(choice.value),
      supportedEfforts: existing?.supportedEfforts ?? [],
      isCurrent: choice.value === currentModelId,
    });
  }

  const runtimeEfforts: ReasoningEffort[] = [];
  for (const choice of effortOpt?.options ?? []) {
    const val = choice.value as ReasoningEffort;
    if (KNOWN_EFFORTS.has(val) && !runtimeEfforts.includes(val)) {
      runtimeEfforts.push(val);
    }
  }

  const currentModelMeta = currentModelId ? byModel.get(currentModelId) : undefined;
  const availableEfforts =
    runtimeEfforts.length > 0
      ? runtimeEfforts
      : currentModelMeta?.supportedEfforts ?? [];

  if (currentModelId && runtimeEfforts.length > 0 && currentModelMeta) {
    byModel.set(currentModelId, {
      ...currentModelMeta,
      supportedEfforts: runtimeEfforts,
    });
  }

  const rawEffort = (effortOpt?.currentValue ?? params.activeEffort ?? null) as ReasoningEffort | null;
  const currentEffort = rawEffort && KNOWN_EFFORTS.has(rawEffort) ? rawEffort : null;
  const effortObserved = availableEfforts.length > 0;

  return {
    currentModelId,
    models: [...byModel.values()],
    currentEffort,
    availableEfforts,
    effortObserved,
    ...(!effortObserved
      ? {
          effortUnavailableReason:
            '当前模型尚未返回实际 thought_level 选项（不虚构思考强度档位）',
        }
      : {}),
  };
}
