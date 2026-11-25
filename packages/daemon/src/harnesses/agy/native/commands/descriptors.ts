import type {
  CapabilityDescriptor,
  CapabilitySurface,
  CommandLane,
  GateState,
  PermissionMode,
  ReasoningEffort,
} from '@harnessmate/protocol';

export interface NativeCommandArgSpec {
  readonly name: string;
  readonly required?: boolean;
  readonly type: 'string' | 'boolean' | 'string_array';
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly description: string;
}

export interface NativeCommandActionMetadata {
  readonly key: string;
  readonly lane: CommandLane;
  readonly label: string;
  readonly slashCommand?: string;
  readonly argumentHint?: string;
  readonly officialEntry: string;
  readonly description: string;
  readonly requiresLiveSession?: boolean;
  readonly requiresRuntimeAdvertisement?: boolean;
  readonly requiresAuthenticatedProfile?: boolean;
  readonly disallowAgyDesktopSource?: boolean;
  readonly eligibleTiers?: readonly string[];
  readonly disallowedPermissionModes?: readonly PermissionMode[];
  readonly supportsAttachments?: boolean;
  readonly args?: readonly NativeCommandArgSpec[];
}

export interface NativeCapabilityDefinition {
  readonly id: string;
  /** Optional NP-02 dotted alias (e.g. `agy.workflow.swarm` <-> `AGY-W04`). */
  readonly aliasIds?: readonly string[];
  readonly slashName?: string;
  readonly title: string;
  readonly description: string;
  readonly surfaces: readonly CapabilitySurface[];
  readonly tierHint?: string;
  readonly versionNote?: string;
  readonly officialEntry: string;
  readonly defaultEvidenceRefs: readonly string[];
  readonly verifiedLevel: CapabilityDescriptor['verifiedLevel'];
  /** Base gates before per-binding runtime observations are merged. */
  readonly baseLaunch: GateState;
  readonly baseObserve: GateState;
  readonly baseControl: GateState;
  readonly baseLocalRead: GateState;
  readonly actions: readonly NativeCommandActionMetadata[];
}

/**
 * Extensible contribution contract for NP-08..NP-12 workflow modules.
 * Workflow owners contribute ONLY descriptors & metadata; they MUST NOT create
 * separate global command executors.
 */
export interface NativeWorkflowDescriptorContribution {
  readonly contributorId: string;
  readonly capabilityId: string;
  readonly aliasIds?: readonly string[];
  readonly slashName?: string;
  readonly title?: string;
  readonly description?: string;
  readonly surfaces?: readonly CapabilitySurface[];
  readonly tierHint?: string;
  readonly versionNote?: string;
  readonly officialEntry?: string;
  readonly evidenceRefs?: readonly string[];
  readonly verifiedLevel?: CapabilityDescriptor['verifiedLevel'];
  readonly launchGateOverride?: GateState;
  readonly observeGateOverride?: GateState;
  readonly controlGateOverride?: GateState;
  readonly localReadGateOverride?: GateState;
  readonly actions?: readonly NativeCommandActionMetadata[];
}

export interface ObservedAcpCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

export interface ObservedAcpConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly currentValue?: string;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly name?: string }>;
}

export interface ObservedRuntimeSignals {
  readonly cliVersion?: string | null;
  readonly protocolVersion?: 1 | 2 | null;
  readonly profileRef: string;
  readonly authMethod?: string | null;
  readonly profileVerified: boolean;
  readonly source?: 'agy_cli' | 'agy_desktop' | 'agy_ide' | 'acp' | string | null;
  readonly tierName?: string | null;
  readonly effectiveModel?: string | null;
  readonly effectivePermissionMode?: PermissionMode;
  readonly effectiveEnforcement?: 'native' | 'client_guard';
  readonly advertisedModes?: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
  /**
   * `undefined` / `null` means no `available_commands_update` has been observed yet for this binding.
   * An empty array `[]` means an explicit broadcast revoking all dynamically advertised commands.
   */
  readonly advertisedCommands?: readonly ObservedAcpCommand[] | null;
  readonly configOptions?: readonly ObservedAcpConfigOption[];
  readonly observedModels?: ReadonlyArray<{
    readonly id: string;
    readonly displayName?: string;
    readonly group?: string;
    readonly supportedEfforts?: readonly ReasoningEffort[];
  }>;
  readonly observedEffortsByModel?: Readonly<Record<string, readonly ReasoningEffort[]>>;
  readonly supportsActiveSteering?: boolean;
  readonly hasLiveConnection?: boolean;
}

/**
 * Interactive workflow slash commands that MUST execute through the live ACP session
 * rather than spawning a final-only auxiliary CLI process.
 */
export const LIVE_ONLY_INTERACTIVE_WORKFLOW_COMMANDS = new Set<string>([
  'swarm',
  'boost',
  'teamwork',
  'run-workflow',
  'schedule',
  'grill-me',
]);

/**
 * Built-in catalog aligned with `02_Capability_Matrix.md` (AGY-R/W/S/E IDs)
 * and NP-02 dotted aliases (`agy.*`).
 */
export const BUILTIN_AGY_CAPABILITY_DEFINITIONS: readonly NativeCapabilityDefinition[] = [
  {
    id: 'AGY-R01',
    aliasIds: ['agy.acp.v1'],
    title: 'ACP v1 运行时握手',
    description: 'Antigravity ACP v1 stdio 协议握手与基础会话控制边界（v2 Preview 默认关闭）。',
    surfaces: ['cli', 'acp'],
    versionNote: 'Default v1 handshake; v2 Preview disabled',
    officialEntry: 'agy acp --stdio',
    defaultEvidenceRefs: ['E02', 'E03'],
    verifiedLevel: 1,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'unknown',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'cancel',
        lane: 'live_workflow',
        label: '原生取消 (Stop)',
        officialEntry: 'ACP session/cancel · Esc',
        description: '向当前 live ACP 根会话发送 session/cancel，区分已请求与原生确认。',
        requiresLiveSession: true,
      },
    ],
  },
  {
    id: 'AGY-R10',
    aliasIds: ['agy.reactive.background'],
    title: 'Stop 与安全收尾',
    description: '对正在运行的当前 live 根活动发送原生 session/cancel，不伪造立即生效。',
    surfaces: ['desktop', 'cli', 'acp'],
    officialEntry: 'Esc / ACP session/cancel',
    defaultEvidenceRefs: ['E05', 'S04'],
    verifiedLevel: null,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'unknown',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'cancel',
        lane: 'live_workflow',
        label: '停止当前原生会话',
        officialEntry: 'ACP session/cancel',
        description: '向当前 live ACP 连接发送取消通知并等待原生终态确认。',
        requiresLiveSession: true,
      },
    ],
  },
  {
    id: 'AGY-S15',
    slashName: 'usage',
    title: 'Usage 用量与额度查询',
    description: '在当前 Profile 隔离上下文中通过官方独立只读查询查看模型配额与窗口，不写入 conversation。',
    surfaces: ['desktop', 'cli', 'acp'],
    officialEntry: 'agy -p /usage --output-format json',
    defaultEvidenceRefs: ['S12', 'E01'],
    verifiedLevel: null,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'unsupported',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'query_usage',
        lane: 'query',
        label: '查询 AGY 额度 (/usage)',
        slashCommand: '/usage',
        officialEntry: '官方 CLI /usage',
        description: '按当前绑定 Profile 独立查询额度，超时不影响主 ACP 连接。',
        requiresAuthenticatedProfile: true,
      },
    ],
  },
  {
    id: 'AGY-E01',
    slashName: 'skills',
    title: 'Skills 原生技能查询与调用',
    description: '按当前绑定 Profile 列出可用原生技能（不写入 conversation），并可在 live 会话中调用已验证技能。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /skills · /<skill-name>',
    defaultEvidenceRefs: ['S12', 'S13'],
    verifiedLevel: null,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'unsupported',
    baseLocalRead: 'available',
    actions: [
      {
        key: 'query_skills',
        lane: 'query',
        label: '列出原生技能 (/skills)',
        slashCommand: '/skills',
        officialEntry: '官方 CLI /skills',
        description: '按当前会话所属 Profile 只读查询工作区和全局可用技能。',
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
      },
      {
        key: 'invoke_skill',
        lane: 'live_workflow',
        label: '调用原生技能 (/skill)',
        slashCommand: '/skill',
        argumentHint: '<名称> [参数]',
        officialEntry: '官方 CLI /<skill-name> [args]',
        description: '在同一 live ACP 会话中发送已验证的原生技能调用，保留附件顺序。',
        requiresLiveSession: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
        supportsAttachments: true,
        args: [
          {
            name: 'name',
            required: true,
            type: 'string',
            maxLength: 80,
            pattern: /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/,
            description: '技能名称',
          },
          {
            name: 'text',
            required: false,
            type: 'string',
            maxLength: 1000,
            description: '附加参数文本',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-S10',
    slashName: 'model',
    title: '模型列表与会话模型切换',
    description: '查看当前绑定实际观测到的可用模型或切换会话模型（不自动降级模型或轮换账号）。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /model · ACP set_config_option(model)',
    defaultEvidenceRefs: ['E04', 'E05'],
    verifiedLevel: 1,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'available',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'inspect_models',
        lane: 'config',
        label: '查看可用模型 (/model)',
        slashCommand: '/model',
        officialEntry: '官方 CLI /model · agy models',
        description: '读取当前绑定观测到的实际模型选项与分组。',
      },
      {
        key: 'set_model',
        lane: 'config',
        label: '切换会话模型 (/model <id>)',
        slashCommand: '/model',
        argumentHint: '<模型 ID | default>',
        officialEntry: '官方 CLI /model <id>',
        description: '通过原生配置路径切换模型，校验实际可用选项且不自动回退低配模型。',
        requiresAuthenticatedProfile: true,
        args: [
          {
            name: 'modelId',
            required: true,
            type: 'string',
            maxLength: 160,
            pattern: /^[a-zA-Z0-9][a-zA-Z0-9_.:/[\]-]*$/,
            description: '目标模型 ID 或 default',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-S12',
    slashName: 'effort',
    title: '思考强度 (Thinking Level / Effort)',
    description: '按当前模型实际返回的 thought_level 选项切换思考强度，未观测选项不虚构。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /effort · ACP set_config_option(thought_level)',
    defaultEvidenceRefs: ['E05', 'S11'],
    verifiedLevel: 1,
    baseLaunch: 'unknown',
    baseObserve: 'available',
    baseControl: 'unknown',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'set_effort',
        lane: 'config',
        label: '设置思考强度 (/effort)',
        slashCommand: '/effort',
        argumentHint: '<low | medium | high | xhigh | max>',
        officialEntry: '官方 CLI /effort <level>',
        description: '仅允许切换到当前模型实际广告的 thought_level 档位。',
        requiresAuthenticatedProfile: true,
        args: [
          {
            name: 'effort',
            required: true,
            type: 'string',
            maxLength: 24,
            pattern: /^(low|medium|high|xhigh|max)$/,
            description: '思考强度档位',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-S13',
    slashName: 'permissions',
    title: '权限模式 (Permission Mode)',
    description: '查看或切换 default/plan/accept-edits/auto，未广告原生 auto 时诚实标记 client_guard。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /permissions · ACP session/set_mode',
    defaultEvidenceRefs: ['E05', 'S08'],
    verifiedLevel: 1,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'available',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'set_permission_mode',
        lane: 'config',
        label: '切换权限模式 (/permissions)',
        slashCommand: '/permissions',
        argumentHint: '<manual | plan | accept_edits | auto>',
        officialEntry: '官方 CLI /permissions',
        description: '按服务端实际广告模式切换，不伪造未广告的原生 auto。',
        requiresAuthenticatedProfile: true,
        args: [
          {
            name: 'mode',
            required: true,
            type: 'string',
            maxLength: 32,
            pattern: /^(default|manual|plan|accept-edits|accept_edits|auto)$/,
            description: '目标权限模式',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-W13',
    slashName: 'plan',
    title: 'Plan 计划模式',
    description: '进入或退出原生计划模式；带任务文本时在同一 live ACP 会话中提交。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /plan [task | off]',
    defaultEvidenceRefs: ['E05', 'S12'],
    verifiedLevel: null,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'available',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'set_plan_mode',
        lane: 'config',
        label: '切换计划模式 (/plan)',
        slashCommand: '/plan',
        argumentHint: '[任务 | off]',
        officialEntry: '官方 CLI /plan',
        description: '启用/退出计划模式，或在 live 会话中进入计划模式并发送任务。',
        requiresAuthenticatedProfile: true,
        supportsAttachments: true,
        args: [
          {
            name: 'text',
            required: false,
            type: 'string',
            maxLength: 1000,
            description: '任务描述或 off',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-S09',
    slashName: 'compact',
    title: '原生上下文压缩 (/compact)',
    description: '在已验证/广告的 live 会话中触发原生上下文压缩，与 HarnessMate 本地压缩分轨。',
    surfaces: ['desktop', 'cli', 'acp'],
    officialEntry: '官方 CLI /compact',
    defaultEvidenceRefs: ['S12'],
    verifiedLevel: null,
    baseLaunch: 'unknown',
    baseObserve: 'unknown',
    baseControl: 'unsupported',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'run_compact',
        lane: 'live_workflow',
        label: '原生压缩上下文 (/compact)',
        slashCommand: '/compact',
        officialEntry: '官方 CLI /compact',
        description: '在同一 live ACP 会话内触发原生 /compact，不脱离当前会话。',
        requiresLiveSession: true,
        requiresRuntimeAdvertisement: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
      },
    ],
  },
  {
    id: 'AGY-W01',
    aliasIds: ['agy.subagents'],
    title: '子 Agent 委派',
    description: '通过原生 Agent 委派执行独立子任务，保持原生编排权与已证实亲缘关系。',
    surfaces: ['desktop', 'cli', 'acp'],
    officialEntry: '官方 CLI /agents · @agent',
    defaultEvidenceRefs: ['E05', 'E06'],
    verifiedLevel: 1,
    baseLaunch: 'unknown',
    baseObserve: 'unknown',
    baseControl: 'upstream_limited',
    baseLocalRead: 'unknown',
    actions: [],
  },
  {
    id: 'AGY-W04',
    aliasIds: ['agy.workflow.swarm'],
    slashName: 'swarm',
    title: 'Swarm 协作工作流',
    description: '由原生 Coordinator 协调实名 Workers 与 Verifier，在当前 live ACP 会话单次发送。',
    surfaces: ['desktop', 'cli', 'acp'],
    tierHint: 'Preview',
    officialEntry: '官方 CLI /swarm <task>',
    defaultEvidenceRefs: ['E01'],
    verifiedLevel: null,
    baseLaunch: 'unknown',
    baseObserve: 'upstream_limited',
    baseControl: 'upstream_limited',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'launch_swarm',
        lane: 'live_workflow',
        label: '发起 Swarm (/swarm)',
        slashCommand: '/swarm',
        argumentHint: '<协作目标>',
        officialEntry: '官方 CLI /swarm <task>',
        description: '在当前 live ACP 会话中发送 /swarm <task>，绝不落入 final-only 辅助进程。',
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
    id: 'AGY-W05',
    slashName: 'swarm-board',
    title: 'Swarm Board 管理入口',
    description: '查看当前运行已观测到的 Swarm Board 摘要或官方 /swarm board 操作指引。',
    surfaces: ['desktop', 'cli'],
    officialEntry: '官方 CLI /swarm board · Alt+S',
    defaultEvidenceRefs: ['E01'],
    verifiedLevel: null,
    baseLaunch: 'upstream_limited',
    baseObserve: 'upstream_limited',
    baseControl: 'upstream_limited',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'open_swarm_board',
        lane: 'manager',
        label: '查看 Swarm Board (/swarm board)',
        slashCommand: '/swarm board',
        officialEntry: '官方 CLI /swarm board · Alt+S',
        description: '基于当前运行投影展示已观测 Swarm 状态；缺原生 feed 时给出官方入口说明。',
      },
    ],
  },
  {
    id: 'AGY-W06',
    aliasIds: ['agy.workflow.boost'],
    slashName: 'boost',
    title: 'Boost 深度验证工作流',
    description: '触发原生实现、挑战、修复与验证流程（受账号计划/广告资格限制，走 live ACP 会话）。',
    surfaces: ['desktop', 'cli', 'acp'],
    tierHint: 'Pro/Ultra',
    officialEntry: '官方 CLI /boost <task>',
    defaultEvidenceRefs: ['E01'],
    verifiedLevel: null,
    baseLaunch: 'not_tested',
    baseObserve: 'upstream_limited',
    baseControl: 'unknown',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'launch_boost',
        lane: 'live_workflow',
        label: '发起 Boost (/boost)',
        slashCommand: '/boost',
        argumentHint: '<深度任务>',
        officialEntry: '官方 CLI /boost <task>',
        description: '按实际广告与计划资格在当前 live ACP 会话发送 /boost <task>。',
        requiresLiveSession: true,
        requiresRuntimeAdvertisement: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
        eligibleTiers: ['pro', 'ultra', 'enterprise', 'business'],
        supportsAttachments: true,
        args: [
          {
            name: 'task',
            required: true,
            type: 'string',
            maxLength: 1000,
            description: 'Boost 任务目标',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-W07',
    aliasIds: ['agy.workflow.teamwork'],
    slashName: 'teamwork',
    title: 'Teamwork 项目工作流',
    description: '启动原生访谈、Prompt Artifact 审阅与多阶段项目推进（受计划资格限制，走 live ACP）。',
    surfaces: ['desktop', 'cli', 'acp'],
    tierHint: 'Pro/Ultra',
    officialEntry: '官方 App / CLI /teamwork <goal>',
    defaultEvidenceRefs: ['E01'],
    verifiedLevel: null,
    baseLaunch: 'not_tested',
    baseObserve: 'upstream_limited',
    baseControl: 'upstream_limited',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'launch_teamwork',
        lane: 'live_workflow',
        label: '发起 Teamwork (/teamwork)',
        slashCommand: '/teamwork',
        argumentHint: '<项目目标>',
        officialEntry: '官方 App / CLI /teamwork <goal>',
        description: '在当前 live ACP 会话中发送 /teamwork <goal>，不落入辅助进程。',
        requiresLiveSession: true,
        requiresRuntimeAdvertisement: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
        eligibleTiers: ['pro', 'ultra', 'enterprise', 'business'],
        supportsAttachments: true,
        args: [
          {
            name: 'goal',
            required: true,
            type: 'string',
            maxLength: 1000,
            description: 'Teamwork 项目愿景或目标',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-W08',
    aliasIds: ['agy.workflow.dynamic'],
    slashName: 'run-workflow',
    title: 'Dynamic Workflow 动态工作流',
    description: '在当前 live ACP 会话中发起原生动态工作流脚本审阅与多阶段执行。',
    surfaces: ['desktop', 'cli', 'acp'],
    officialEntry: '官方 App / CLI /run-workflow <task>',
    defaultEvidenceRefs: ['E01'],
    verifiedLevel: null,
    baseLaunch: 'not_tested',
    baseObserve: 'upstream_limited',
    baseControl: 'unknown',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'launch_dynamic_workflow',
        lane: 'live_workflow',
        label: '发起动态工作流 (/run-workflow)',
        slashCommand: '/run-workflow',
        argumentHint: '<工作流任务>',
        officialEntry: '官方 App / CLI /run-workflow <task>',
        description: '在同一 live ACP 会话中发送 /run-workflow <task>，由原生端管理脚本审批与执行。',
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
            description: '动态工作流任务描述',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-W09',
    aliasIds: ['agy.workflow.goal'],
    slashName: 'goal',
    title: 'Goal 目标驱动工作流',
    description: '在当前 live ACP 会话内设置原生 Goal，阻止回落到 final-only 辅助进程。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /goal <objective>',
    defaultEvidenceRefs: ['E05', 'S12'],
    verifiedLevel: null,
    baseLaunch: 'unknown',
    baseObserve: 'unknown',
    baseControl: 'unknown',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'launch_goal',
        lane: 'live_workflow',
        label: '发起 Goal (/goal)',
        slashCommand: '/goal',
        argumentHint: '<目标描述>',
        officialEntry: '官方 CLI /goal <objective>',
        description: '在当前 live ACP 会话内单次发送 /goal <objective>，保留实时工具与唤醒信号。',
        requiresLiveSession: true,
        requiresRuntimeAdvertisement: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
        supportsAttachments: true,
        args: [
          {
            name: 'objective',
            required: true,
            type: 'string',
            maxLength: 1000,
            description: '原生 Goal 目标描述',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-W10',
    aliasIds: ['agy.workflow.schedule'],
    slashName: 'schedule',
    title: 'Schedule 定时唤醒',
    description: '在当前 live ACP 会话中设置原生单次或 cron 定时唤醒，不用 HM 调度器替代。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /schedule <when> <task>',
    defaultEvidenceRefs: ['E05'],
    verifiedLevel: null,
    baseLaunch: 'unknown',
    baseObserve: 'unknown',
    baseControl: 'upstream_limited',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'launch_schedule',
        lane: 'live_workflow',
        label: '创建定时唤醒 (/schedule)',
        slashCommand: '/schedule',
        argumentHint: '<时间/cron> <任务>',
        officialEntry: '官方 CLI /schedule <when> <task>',
        description: '在当前 live ACP 会话中发送 /schedule <when> <task>。',
        requiresLiveSession: true,
        requiresRuntimeAdvertisement: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
        supportsAttachments: true,
        args: [
          {
            name: 'when',
            required: true,
            type: 'string',
            maxLength: 120,
            description: '触发时间或 cron 表达式',
          },
          {
            name: 'task',
            required: true,
            type: 'string',
            maxLength: 1000,
            description: '触发时执行的任务',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-W17',
    slashName: 'grill-me',
    title: 'Grill Me 设计访谈',
    description: '在当前 live ACP 会话中发起交互式设计访谈。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /grill-me [topic]',
    defaultEvidenceRefs: ['E01'],
    verifiedLevel: null,
    baseLaunch: 'unknown',
    baseObserve: 'unknown',
    baseControl: 'unsupported',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'launch_grill_me',
        lane: 'live_workflow',
        label: '发起设计访谈 (/grill-me)',
        slashCommand: '/grill-me',
        argumentHint: '[主题]',
        officialEntry: '官方 CLI /grill-me',
        description: '在同一 live ACP 会话中启动 /grill-me 逐题访谈。',
        requiresLiveSession: true,
        requiresRuntimeAdvertisement: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
        supportsAttachments: true,
        args: [
          {
            name: 'topic',
            required: false,
            type: 'string',
            maxLength: 1000,
            description: '访谈主题',
          },
        ],
      },
    ],
  },
  {
    id: 'AGY-W02',
    slashName: 'agents',
    title: 'Native Agent Manager (/agents)',
    description: '使用当前投影或只读自定义 Agent 摘要展示原生 Agents，无原生控制时提供官方指引。',
    surfaces: ['desktop', 'cli', 'acp'],
    officialEntry: '官方 CLI /agents · agy agents',
    defaultEvidenceRefs: ['E01', 'E04', 'E06'],
    verifiedLevel: 1,
    baseLaunch: 'available',
    baseObserve: 'upstream_limited',
    baseControl: 'upstream_limited',
    baseLocalRead: 'unknown',
    actions: [
      {
        key: 'inspect_agents',
        lane: 'manager',
        label: '查看原生 Agents (/agents)',
        slashCommand: '/agents',
        officialEntry: '官方 CLI /agents · agy agents',
        description: '查看当前运行已观测到的原生 Agent 列表与官方切换说明（不新开竞争会话）。',
      },
    ],
  },
  {
    id: 'AGY-W11',
    slashName: 'tasks',
    title: 'Native Tasks 管理入口 (/tasks)',
    description: '使用当前运行投影展示有限后台、daemon 与调度任务摘要，并附官方 /tasks 说明。',
    surfaces: ['desktop', 'cli'],
    officialEntry: '官方 CLI /tasks · Ctrl+T',
    defaultEvidenceRefs: ['E01', 'E06'],
    verifiedLevel: 1,
    baseLaunch: 'available',
    baseObserve: 'upstream_limited',
    baseControl: 'upstream_limited',
    baseLocalRead: 'unknown',
    actions: [
      {
        key: 'inspect_tasks',
        lane: 'manager',
        label: '查看原生任务 (/tasks)',
        slashCommand: '/tasks',
        officialEntry: '官方 CLI /tasks · Ctrl+T',
        description: '使用当前绑定已观测的后台任务投影，绝不另开进程抢占原 conversation。',
      },
    ],
  },
  {
    id: 'AGY-E05',
    slashName: 'mcp',
    title: 'MCP 管理入口 (/mcp)',
    description: '查看当前 Profile 生态快照中的 MCP 配置摘要与官方 /mcp 入口指引。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /mcp · agy mcp',
    defaultEvidenceRefs: ['E02', 'S21'],
    verifiedLevel: 1,
    baseLaunch: 'available',
    baseObserve: 'available',
    baseControl: 'upstream_limited',
    baseLocalRead: 'available',
    actions: [
      {
        key: 'inspect_mcp',
        lane: 'manager',
        label: '查看 MCP 摘要 (/mcp)',
        slashCommand: '/mcp',
        officialEntry: '官方 CLI /mcp · agy mcp',
        description: '只读展示全局 AGY MCP 与会话级 HarnessMate MCP 边界说明。',
      },
    ],
  },
  {
    id: 'AGY-S16',
    slashName: 'credits',
    title: 'Credits 与账号计划入口 (/credits)',
    description: '查看当前观测到的计划/Tier 摘要并提供官方账单与计划管理入口。',
    surfaces: ['desktop', 'cli'],
    officialEntry: '官方 CLI /credits · antigravity.google',
    defaultEvidenceRefs: ['E01'],
    verifiedLevel: null,
    baseLaunch: 'upstream_limited',
    baseObserve: 'upstream_limited',
    baseControl: 'unsupported',
    baseLocalRead: 'not_tested',
    actions: [
      {
        key: 'inspect_credits',
        lane: 'manager',
        label: '查看计划与官方入口 (/credits)',
        slashCommand: '/credits',
        officialEntry: '官方 CLI /credits · https://antigravity.google/docs/plans/',
        description: '仅展示当前只读计划摘要与官方链接，不代理交易或计费操作。',
      },
    ],
  },
];

export function buildCapabilityAliasMap(
  definitions: readonly NativeCapabilityDefinition[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const def of definitions) {
    map.set(def.id, def.id);
    for (const alias of def.aliasIds ?? []) {
      map.set(alias, def.id);
    }
  }
  return map;
}
