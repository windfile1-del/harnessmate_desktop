import {
  asBindingGeneration,
  asRuntimeId,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import type {
  ObservedAcpCommand,
  ObservedAcpConfigOption,
  ObservedRuntimeSignals,
} from './descriptors.js';

/**
 * Deterministic synthetic fixtures for NP-06 command catalog & router tests.
 * Explicitly marked as `synthetic` — never elevates real capability verification levels.
 */
export const NP06_SYNTHETIC_FIXTURE_SOURCE = 'synthetic' as const;

export function makeSyntheticBinding(params?: {
  runtimeId?: string;
  sessionId?: string;
  instanceId?: string;
  generation?: string;
}): RuntimeBinding {
  return {
    runtimeId: asRuntimeId(params?.runtimeId ?? 'nrt_np06_synth_1'),
    sessionId: params?.sessionId ?? 'sess_np06_synth_1',
    instanceId: params?.instanceId ?? 'agy-personal-a',
    generation: asBindingGeneration(params?.generation ?? 'gen_1'),
  };
}

export const SYNTHETIC_ACP_COMMANDS_FULL: readonly ObservedAcpCommand[] = [
  { name: 'plan', description: 'Enter or exit plan mode', argumentHint: '[task | off]' },
  { name: 'goal', description: 'Work toward an objective until verified', argumentHint: '<objective>' },
  { name: 'swarm', description: 'Coordinate named workers', argumentHint: '<task>' },
  { name: 'boost', description: 'Deep implementation and verification', argumentHint: '<task>' },
  { name: 'teamwork', description: 'Multi-stage project workflow', argumentHint: '<goal>' },
  { name: 'run-workflow', description: 'Run dynamic workflow script', argumentHint: '<task>' },
  { name: 'schedule', description: 'Schedule wake task', argumentHint: '<when> <task>' },
  { name: 'grill-me', description: 'Interactive design interview', argumentHint: '[topic]' },
  { name: 'compact', description: 'Compact native context' },
];

export const SYNTHETIC_ACP_COMMANDS_WITH_UNKNOWN: readonly ObservedAcpCommand[] = [
  ...SYNTHETIC_ACP_COMMANDS_FULL.slice(0, 3),
  { name: 'mystery-tui-slash', description: 'Unverified experimental slash command' },
];

export const SYNTHETIC_CONFIG_OPTIONS_FLASH: readonly ObservedAcpConfigOption[] = [
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
  {
    id: 'mode',
    category: 'mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
      { value: 'accept-edits', name: 'Accept Edits' },
    ],
  },
];

export function makeSyntheticVerifiedSignals(
  overrides?: Partial<ObservedRuntimeSignals>,
): ObservedRuntimeSignals {
  return {
    cliVersion: '1.5.16',
    protocolVersion: 1,
    profileRef: 'agy:profile:personal-a',
    authMethod: 'oauth-personal',
    profileVerified: true,
    source: 'agy_cli',
    tierName: 'Pro',
    effectiveModel: 'gemini-3.8-flash',
    effectivePermissionMode: 'manual',
    effectiveEnforcement: 'native',
    advertisedModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
      { id: 'accept-edits', name: 'Accept Edits' },
    ],
    advertisedCommands: SYNTHETIC_ACP_COMMANDS_FULL,
    configOptions: SYNTHETIC_CONFIG_OPTIONS_FLASH,
    observedModels: [
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
    ],
    supportsActiveSteering: true,
    hasLiveConnection: true,
    ...overrides,
  };
}
