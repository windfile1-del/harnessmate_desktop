import type { HarnessModelInfo } from '@harnessmate/protocol';
import type { CapabilityDescriptor } from '../../../../lib/native-client';
import type { ObservedConfigOptionLite } from './command-catalog';

/**
 * Deterministic synthetic frontend fixtures for NP-06 command palette, mode picker,
 * and model/effort picker tests. Explicitly marked synthetic.
 */
export const NP06_WEB_FIXTURE_SOURCE = 'synthetic' as const;

export function makeNp06CommandDescriptorsFixture(opts?: {
  readonly snapshotRevision?: number;
  readonly swarmAdvertised?: boolean | null;
  readonly boostAdvertised?: boolean | null;
  readonly effortObserved?: boolean;
  readonly includeUnknownSlash?: boolean;
}): CapabilityDescriptor[] {
  const rev = opts?.snapshotRevision ?? 4;
  const swarmAdvertised = opts?.swarmAdvertised === undefined ? true : opts.swarmAdvertised;
  const boostAdvertised = opts?.boostAdvertised === undefined ? false : opts.boostAdvertised;
  const effortObserved = opts?.effortObserved ?? true;

  const descriptors: CapabilityDescriptor[] = [
    {
      id: 'AGY-S15',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'unsupported',
      localRead: 'not_tested',
      actions: [{ key: 'query_usage', lane: 'query', gate: 'available', label: '查询 AGY 额度 (/usage)' }],
      evidenceRefs: ['SYNTH-NP06-USAGE'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-E01',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'unsupported',
      localRead: 'available',
      actions: [
        { key: 'query_skills', lane: 'query', gate: 'available', label: '列出原生技能 (/skills)' },
        { key: 'invoke_skill', lane: 'live_workflow', gate: 'available', label: '调用原生技能 (/skill)' },
      ],
      evidenceRefs: ['SYNTH-NP06-SKILLS'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-S10',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'not_tested',
      actions: [
        { key: 'inspect_models', lane: 'config', gate: 'available', label: '查看可用模型 (/model)' },
        { key: 'set_model', lane: 'config', gate: 'available', label: '切换会话模型 (/model <id>)' },
      ],
      evidenceRefs: ['SYNTH-NP06-MODEL'],
      verifiedLevel: 1,
    },
    {
      id: 'AGY-S12',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      advertised: effortObserved ? true : null,
      launch: effortObserved ? 'available' : 'unknown',
      observe: 'available',
      control: effortObserved ? 'available' : 'unknown',
      localRead: 'not_tested',
      actions: [
        {
          key: 'set_effort',
          lane: 'config',
          gate: effortObserved ? 'available' : 'unknown',
          ...(effortObserved ? {} : { reasonCode: 'effort_options_not_observed' }),
          label: '设置思考强度 (/effort)',
        },
      ],
      evidenceRefs: ['SYNTH-NP06-EFFORT'],
      verifiedLevel: 1,
    },
    {
      id: 'AGY-S13',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'not_tested',
      actions: [{ key: 'set_permission_mode', lane: 'config', gate: 'available', label: '切换权限模式 (/permissions)' }],
      evidenceRefs: ['SYNTH-NP06-PERMS'],
      verifiedLevel: 1,
    },
    {
      id: 'AGY-W04',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'acp'],
      tierHint: 'Preview',
      advertised: swarmAdvertised,
      launch: swarmAdvertised === true ? 'available' : swarmAdvertised === false ? 'unsupported' : 'unknown',
      observe: 'upstream_limited',
      control: 'upstream_limited',
      localRead: 'not_tested',
      actions: [
        {
          key: 'launch_swarm',
          lane: 'live_workflow',
          gate: swarmAdvertised === true ? 'available' : swarmAdvertised === false ? 'unsupported' : 'unknown',
          ...(swarmAdvertised === false
            ? { reasonCode: 'command_not_advertised_or_revoked' }
            : swarmAdvertised === null
              ? { reasonCode: 'advertisement_not_observed' }
              : {}),
          label: '发起 Swarm (/swarm)',
        },
      ],
      evidenceRefs: ['SYNTH-NP06-SWARM'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W06',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'acp'],
      tierHint: 'Pro/Ultra',
      advertised: boostAdvertised,
      launch: boostAdvertised === true ? 'available' : 'unsupported',
      observe: 'upstream_limited',
      control: 'unknown',
      localRead: 'not_tested',
      actions: [
        {
          key: 'launch_boost',
          lane: 'live_workflow',
          gate: boostAdvertised === true ? 'available' : 'unsupported',
          ...(boostAdvertised === true ? {} : { reasonCode: 'tier_ineligible' }),
          label: '发起 Boost (/boost)',
        },
      ],
      evidenceRefs: ['SYNTH-NP06-BOOST'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W09',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli', 'ide', 'acp'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'not_tested',
      actions: [{ key: 'launch_goal', lane: 'live_workflow', gate: 'available', label: '发起 Goal (/goal)' }],
      evidenceRefs: ['SYNTH-NP06-GOAL'],
      verifiedLevel: null,
    },
    {
      id: 'AGY-W11',
      snapshotRevision: rev,
      surfaces: ['desktop', 'cli'],
      advertised: null,
      launch: 'available',
      observe: 'upstream_limited',
      control: 'upstream_limited',
      localRead: 'unknown',
      actions: [{ key: 'inspect_tasks', lane: 'manager', gate: 'available', label: '查看原生任务 (/tasks)' }],
      evidenceRefs: ['SYNTH-NP06-TASKS'],
      verifiedLevel: 1,
    },
  ];

  if (opts?.includeUnknownSlash) {
    descriptors.push({
      id: 'AGY-DYN-experimental_tui',
      snapshotRevision: rev,
      surfaces: ['cli', 'acp'],
      versionNote: '未验证动态命令 /experimental_tui',
      advertised: true,
      launch: 'unsupported',
      observe: 'unknown',
      control: 'unsupported',
      localRead: 'not_tested',
      actions: [
        {
          key: 'run_unknown_dynamic',
          lane: 'live_workflow',
          gate: 'unsupported',
          reasonCode: 'unknown_dynamic_slash_disabled',
          label: '/experimental_tui（未验证，已禁用运行）',
        },
      ],
      evidenceRefs: ['RUNTIME_ADVERTISED_UNVERIFIED'],
      verifiedLevel: null,
    });
  }

  return descriptors;
}

export const SYNTHETIC_HARNESS_MODELS: readonly HarnessModelInfo[] = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    group: 'Google Gemini',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-pro-orchestrator',
    displayName: 'Gemini Pro Orchestrator',
    group: 'Orchestrator (Planner + Executor)',
    supportedEfforts: ['medium', 'high', 'max'],
  },
];

export const SYNTHETIC_OBSERVED_CONFIG_OPTIONS: readonly ObservedConfigOptionLite[] = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'gemini-3.8-flash',
    options: [
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'gemini-pro-orchestrator', name: 'Gemini Pro Orchestrator' },
    ],
  },
  {
    id: 'thought_level',
    category: 'thought_level',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];
