import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ApprovalDecision,
  HarnessCapabilities,
  HarnessCapabilitiesV2,
  HarnessInfo,
  HarnessModelInfo,
  HarnessPresentationMeta,
  PermissionMode,
  ProviderOptionDescriptor,
  ReasoningEffort,
  RiskLevel,
  ToolKind,
} from '@harnessmate/protocol';
import { buildPromptWithFileAttachments } from './codex-adapter.js';
import {
  DEFAULT_STRIP_ENV_KEYS,
  ResilientJsonLineParser,
  execCliQuick,
  killProcessTree,
  resolveBinary,
  spawnCliProcess,
} from './process.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  AdapterUsageLimitResult,
  HarnessAdapter,
  NativeSkill,
  NormalizedAdapterEvent,
  TurnInput,
} from './types.js';
import { handoffContinuityNotice, pluginMcpServerName, pluginMcpTokenEnv } from './types.js';

export const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;
const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLAUDE_LARGE_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_CACHE_5M_TTL_MS = 300_000;
const CLAUDE_CACHE_1H_TTL_MS = 3_600_000;

const RESERVED_ENV_SET = new Set<string>(DEFAULT_STRIP_ENV_KEYS);

const FALLBACK_CLAUDE_MODELS: HarnessModelInfo[] = [
  { id: 'sonnet', displayName: 'Claude Sonnet (Default)', group: 'Anthropic Claude', isDefault: true, supportedEfforts: ['low', 'medium', 'high', 'max'] },
  { id: 'opus', displayName: 'Claude Opus (Latest)', group: 'Anthropic Claude', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', displayName: 'Claude Haiku (Fast)', group: 'Anthropic Claude', supportedEfforts: ['low', 'medium'] },
];

export type ClaudeErrorCode =
  | 'conversation_not_found'
  | 'usage_limit'
  | 'root_bypass_refused'
  | 'refused_before_prompt'
  | 'provider_error';

export interface ClaudeModelGroupRule {
  prefix: string;
  groupLabel: string;
}

export interface ClaudeAdapterInstanceOptions {
  instanceId?: string;
  displayName?: string;
  description?: string;
  configDir?: string;
  continuationKey?: string;
  apiBaseUrl?: string;
  authToken?: string;
  modelGroupRules?: ClaudeModelGroupRule[];
  mcpRegistrationTimeoutMs?: number;
  envWhitelist?: Record<string, string>;
}

export interface ClaudeLocalSettingsProbe {
  models: HarnessModelInfo[];
  defaultModelId: string | null;
  gatewayUrl: string | null;
}

export interface ClaudeSessionExtendedConfig extends AdapterSessionConfig {
  forkSession?: boolean;
  thinking?: boolean;
  contextWindow?: '200k' | '1m';
  fastMode?: boolean;
}

export interface ClaudeRawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface ClaudeTurnTokenUsageResult {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  cacheCreationInputTokens: number;
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
  promptCacheTtlMs?: number;
  promptCacheExpiresAt?: number;
  contextWindow: number;
  autoCompactThreshold: number;
}

export function buildClaudeOptionDescriptors(defaults?: {
  effort?: ReasoningEffort;
  thinking?: boolean;
  contextWindow?: '200k' | '1m';
  fastMode?: boolean;
}): ProviderOptionDescriptor[] {
  return [
    {
      key: 'effort',
      label: 'Reasoning Effort',
      description: 'Controls Claude thinking & effort budget',
      kind: 'select',
      defaultValue: defaults?.effort ?? 'medium',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra High' },
        { value: 'max', label: 'Max' },
      ],
    },
    {
      key: 'thinking',
      label: 'Extended Thinking',
      description: 'Enable extended thinking blocks',
      kind: 'boolean',
      defaultValue: defaults?.thinking ?? true,
    },
    {
      key: 'contextWindow',
      label: 'Context Window',
      description: 'Target Claude model context window size',
      kind: 'select',
      defaultValue: defaults?.contextWindow ?? '200k',
      options: [
        { value: '200k', label: '200K' },
        { value: '1m', label: '1M' },
      ],
    },
    {
      key: 'fastMode',
      label: 'Fast Mode',
      description: 'Prefer lower-latency inference when supported',
      kind: 'boolean',
      defaultValue: defaults?.fastMode ?? false,
    },
  ];
}

export function mergeClaudeStreamUsage(
  acc: ClaudeRawUsage,
  incoming?: ClaudeRawUsage | Record<string, unknown> | null,
): ClaudeRawUsage {
  if (!incoming || typeof incoming !== 'object') return acc;
  const inc = incoming as ClaudeRawUsage;
  const incCache = inc.cache_creation;
  const accCache = acc.cache_creation;
  const e5m = Math.max(
    Number(accCache?.ephemeral_5m_input_tokens ?? 0),
    Number(incCache?.ephemeral_5m_input_tokens ?? 0),
  );
  const e1h = Math.max(
    Number(accCache?.ephemeral_1h_input_tokens ?? 0),
    Number(incCache?.ephemeral_1h_input_tokens ?? 0),
  );
  return {
    input_tokens: Math.max(Number(acc.input_tokens ?? 0), Number(inc.input_tokens ?? 0)),
    output_tokens: Math.max(Number(acc.output_tokens ?? 0), Number(inc.output_tokens ?? 0)),
    cache_read_input_tokens: Math.max(
      Number(acc.cache_read_input_tokens ?? 0),
      Number(inc.cache_read_input_tokens ?? 0),
    ),
    cache_creation_input_tokens: Math.max(
      Number(acc.cache_creation_input_tokens ?? 0),
      Number(inc.cache_creation_input_tokens ?? 0),
    ),
    ...(e5m > 0 || e1h > 0
      ? {
          cache_creation: {
            ...(e5m > 0 ? { ephemeral_5m_input_tokens: e5m } : {}),
            ...(e1h > 0 ? { ephemeral_1h_input_tokens: e1h } : {}),
          },
        }
      : {}),
  };
}

export function claudeProviderTurnTokenUsage(
  rawUsage: ClaudeRawUsage | Record<string, unknown>,
  options?: {
    model?: string | null;
    contextWindowTokens?: number;
    totalCostUsd?: number;
    nowMs?: number;
  },
): ClaudeTurnTokenUsageResult {
  const usage = rawUsage as ClaudeRawUsage;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cachedTokens = Number(usage.cache_read_input_tokens ?? 0) || undefined;
  const ephemeral5mInputTokens = Number(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0);
  const ephemeral1hInputTokens = Number(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const cacheCreationInputTokens =
    Number(usage.cache_creation_input_tokens ?? 0) ||
    ephemeral5mInputTokens + ephemeral1hInputTokens;

  let promptCacheTtlMs: number | undefined;
  if (ephemeral1hInputTokens > 0) {
    promptCacheTtlMs = CLAUDE_CACHE_1H_TTL_MS;
  } else if (
    ephemeral5mInputTokens > 0 ||
    cacheCreationInputTokens > 0 ||
    (cachedTokens ?? 0) > 0
  ) {
    promptCacheTtlMs = CLAUDE_CACHE_5M_TTL_MS;
  }

  const nowMs = options?.nowMs ?? Date.now();
  const promptCacheExpiresAt =
    promptCacheTtlMs !== undefined ? nowMs + promptCacheTtlMs : undefined;
  const contextWindow =
    options?.contextWindowTokens ??
    (/\[1m\]/i.test(options?.model ?? '')
      ? CLAUDE_LARGE_CONTEXT_WINDOW
      : CLAUDE_DEFAULT_CONTEXT_WINDOW);
  const autoCompactThreshold = Math.max(0, contextWindow - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS);

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd: typeof options?.totalCostUsd === 'number' ? options.totalCostUsd : undefined,
    cacheCreationInputTokens,
    ephemeral5mInputTokens,
    ephemeral1hInputTokens,
    promptCacheTtlMs,
    promptCacheExpiresAt,
    contextWindow,
    autoCompactThreshold,
  };
}

export function classifyClaudeError(message: string): ClaudeErrorCode {
  if (/no conversation found|session.*not found|conversation_not_found/i.test(message)) {
    return 'conversation_not_found';
  }
  if (/dangerously-skip-permissions.*root|cannot be used with root|root.*bypass/i.test(message)) {
    return 'root_bypass_refused';
  }
  if (/rate.?limit|usage.?limit|quota|429|overloaded/i.test(message)) {
    return 'usage_limit';
  }
  if (/refused.?before.?prompt/i.test(message)) {
    return 'refused_before_prompt';
  }
  return 'provider_error';
}

export class ClaudeStreamJsonAdapter implements HarnessAdapter {
  readonly id: string;
  readonly driverId = 'claude' as const;
  readonly continuationKey: string;
  readonly pluginMcpTransport = 'http' as const;
  readonly kind = 'claude' as const;
  readonly displayName: string;
  readonly description: string;
  readonly protocolLabel = 'claude stream-json + control_request';
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    interactiveApproval: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: ['plan', 'manual', 'accept_edits', 'auto'],
    sessionResume: true,
    sessionFork: true,
    imageInput: true,
    subagents: true,
  };
  readonly presentation: HarnessPresentationMeta = {
    shortLabel: 'Claude',
    accentColor: 'var(--accent-clay)',
    softBg: 'var(--accent-clay-soft)',
    tagline: 'Claude Code · Stream JSON',
  };
  readonly optionDescriptors: ProviderOptionDescriptor[] = buildClaudeOptionDescriptors();
  readonly capabilitiesV2: HarnessCapabilitiesV2 = {
    ...this.capabilities,
    transport: 'stream_json',
    historyInjectionMode: 'sysfile_delta',
    supportsNativeRollback: false,
    supportsActiveSteering: false,
    supportsUsageLimits: true,
    supportsDynamicOptions: true,
    nativeCommands: ['compact', 'usage', 'plugin', 'skills', 'skill', 'fork'],
    optionDescriptors: this.optionDescriptors,
  };

  private readonly configDir?: string;
  private readonly apiBaseUrl?: string;
  private readonly authToken?: string;
  private readonly modelGroupRules?: ClaudeModelGroupRule[];
  private readonly mcpRegistrationTimeoutMs: number;
  private readonly envWhitelist?: Record<string, string>;
  private readonly snapshotSupportCache = new Map<string, boolean>();

  constructor(
    private readonly binaryOverride?: string,
    instanceOpts?: ClaudeAdapterInstanceOptions,
  ) {
    this.id = instanceOpts?.instanceId ?? 'claude';
    this.displayName = instanceOpts?.displayName ?? 'Claude Code';
    this.description =
      instanceOpts?.description ??
      'Anthropic Claude Code CLI via bidirectional stream-json control protocol';
    this.configDir = instanceOpts?.configDir?.trim()
      ? path.resolve(instanceOpts.configDir.trim())
      : undefined;
    this.apiBaseUrl = instanceOpts?.apiBaseUrl?.trim() || undefined;
    this.authToken = instanceOpts?.authToken?.trim() || undefined;
    this.modelGroupRules = instanceOpts?.modelGroupRules;
    this.mcpRegistrationTimeoutMs = instanceOpts?.mcpRegistrationTimeoutMs ?? 90_000;
    this.envWhitelist = instanceOpts?.envWhitelist;
    this.continuationKey =
      instanceOpts?.continuationKey ??
      (this.configDir ? `claude:home:${this.configDir}` : `claude:instance:${this.id}`);
  }

  private get isIsolated(): boolean {
    return Boolean(this.configDir || this.apiBaseUrl || this.authToken || this.envWhitelist);
  }

  private buildUnsetEnv(): string[] {
    if (!this.isIsolated) return [];
    return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'];
  }

  private buildIsolatedEnv(
    extraEnv?: Record<string, string | undefined>,
  ): Record<string, string | undefined> | undefined {
    const clean: Record<string, string | undefined> = {};
    let hasEntries = false;
    if (this.envWhitelist) {
      for (const [k, v] of Object.entries(this.envWhitelist)) {
        if (!k || RESERVED_ENV_SET.has(k)) continue;
        clean[k] = v;
        hasEntries = true;
      }
    }
    if (this.configDir) {
      clean.CLAUDE_CONFIG_DIR = this.configDir;
      hasEntries = true;
    }
    if (this.apiBaseUrl) {
      clean.ANTHROPIC_BASE_URL = this.apiBaseUrl;
      hasEntries = true;
    }
    if (this.authToken) {
      clean.ANTHROPIC_AUTH_TOKEN = this.authToken;
      hasEntries = true;
    }
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) {
        clean[k] = v;
        hasEntries = true;
      }
    }
    return hasEntries ? clean : undefined;
  }

  private async checkSupportsSystemPromptSnapshot(
    binaryPath: string,
    env?: Record<string, string | undefined>,
    unsetEnv?: string[],
  ): Promise<boolean> {
    const cached = this.snapshotSupportCache.get(binaryPath);
    if (cached !== undefined) return cached;

    const helpRes = await execCliQuick(binaryPath, ['--help'], 4000, {
      env,
      unsetEnv,
      input: '',
    });
    const combined = `${helpRes.stdout}\n${helpRes.stderr}`.trim();
    // Only omit --system-prompt-snapshot when --help succeeds with non-empty output lacking the flag
    const supported = !(
      helpRes.exitCode === 0 &&
      combined.length > 0 &&
      !combined.includes('--system-prompt-snapshot')
    );
    this.snapshotSupportCache.set(binaryPath, supported);
    return supported;
  }

  async probePassive(): Promise<HarnessInfo> {
    const binaryPath = await resolveBinary('claude', this.binaryOverride);
    const settingsInfo = readClaudeLocalSettings(this.configDir, this.modelGroupRules);

    if (!binaryPath) {
      return {
        id: this.id,
        kind: this.kind,
        driverId: this.driverId,
        instanceId: this.id,
        continuationKey: this.continuationKey,
        displayName: this.displayName,
        description: this.description,
        protocolLabel: this.protocolLabel,
        binaryPath: null,
        version: null,
        health: 'unavailable',
        healthMessage: 'claude CLI not found in PATH',
        capabilities: this.capabilities,
        capabilitiesV2: this.capabilitiesV2,
        presentation: this.presentation,
        optionDescriptors: this.optionDescriptors,
        models: settingsInfo.models,
        defaultModelId: settingsInfo.defaultModelId,
        accountSummary: null,
      };
    }

    const env = this.buildIsolatedEnv();
    const unsetEnv = this.buildUnsetEnv();

    const [verRes, authRes] = await Promise.all([
      execCliQuick(binaryPath, ['--version'], 10_000, { env, unsetEnv, input: '' }),
      execCliQuick(binaryPath, ['auth', 'status'], 10_000, { env, unsetEnv, input: '' }),
      this.checkSupportsSystemPromptSnapshot(binaryPath, env, unsetEnv),
    ]);
    const text = `${verRes.stdout}\n${verRes.stderr}`.trim();
    const version = text.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? null;

    const effectiveGatewayUrl = this.apiBaseUrl ?? settingsInfo.gatewayUrl;
    const hasConfiguredApiAuth = Boolean(
      this.authToken ||
        effectiveGatewayUrl ||
        this.envWhitelist?.ANTHROPIC_API_KEY ||
        this.envWhitelist?.ANTHROPIC_AUTH_TOKEN,
    );

    let accountSummary: string | null = null;
    let explicitlyLoggedOut = false;
    try {
      const authJson = JSON.parse(authRes.stdout.trim()) as {
        loggedIn?: boolean;
        authMethod?: string;
        apiProvider?: string;
      };
      if (authJson.loggedIn) {
        accountSummary = effectiveGatewayUrl
          ? `${authJson.authMethod ?? 'loggedIn'} · Gateway ${effectiveGatewayUrl}`
          : `${authJson.authMethod ?? 'loggedIn'} (${authJson.apiProvider ?? 'firstParty'})`;
      } else if (authJson.loggedIn === false) {
        explicitlyLoggedOut = true;
      }
    } catch {
      if (effectiveGatewayUrl) {
        accountSummary = `Gateway ${effectiveGatewayUrl}`;
      }
    }

    const health =
      verRes.exitCode !== 0
        ? 'degraded'
        : explicitlyLoggedOut && !hasConfiguredApiAuth
          ? 'unauthenticated'
          : 'ready';
    const healthMessage =
      health === 'unauthenticated'
        ? 'Claude CLI is not authenticated'
        : verRes.exitCode !== 0
          ? text.slice(0, 200)
          : undefined;

    return {
      id: this.id,
      kind: this.kind,
      driverId: this.driverId,
      instanceId: this.id,
      continuationKey: this.continuationKey,
      displayName: this.displayName,
      description: this.description,
      protocolLabel: this.protocolLabel,
      binaryPath,
      version,
      health,
      healthMessage,
      capabilities: this.capabilities,
      capabilitiesV2: this.capabilitiesV2,
      presentation: this.presentation,
      optionDescriptors: this.optionDescriptors,
      models: settingsInfo.models,
      defaultModelId: settingsInfo.defaultModelId,
      accountSummary,
    };
  }

  async probe(): Promise<HarnessInfo> {
    return this.probePassive();
  }

  /**
   * Standard V2 usage & auth probe delegated from `UsageService`.
   * Respects this instance's isolated `configDir`, `apiBaseUrl`, and `binaryOverride`.
   */
  async readUsageLimits(): Promise<AdapterUsageLimitResult> {
    const localSettings = readClaudeLocalSettings(this.configDir, this.modelGroupRules);
    const gatewayUrl = this.apiBaseUrl ?? localSettings.gatewayUrl;
    const base: AdapterUsageLimitResult = {
      loggedIn: false,
      accountLabel: null,
      planType: null,
      authMethod: null,
      billingTier: gatewayUrl || this.authToken ? 'api_payg' : 'subscription',
      gatewayUrl,
      rateLimits: [],
      dailyBuckets: [],
    };
    const bin = await resolveBinary('claude', this.binaryOverride);
    if (!bin) {
      base.error = 'claude CLI not found';
      return base;
    }
    try {
      const res = await execCliQuick(bin, ['auth', 'status'], 6000, {
        env: this.buildIsolatedEnv(),
        unsetEnv: this.buildUnsetEnv(),
        input: '',
      });
      const parsed = JSON.parse(res.stdout.trim()) as {
        loggedIn?: boolean;
        authMethod?: string;
        apiProvider?: string;
        email?: string;
      };
      base.loggedIn = Boolean(parsed.loggedIn);
      base.authMethod = parsed.authMethod ?? null;
      base.planType = gatewayUrl ? 'Custom Gateway' : parsed.apiProvider ?? null;
      base.billingTier =
        gatewayUrl || parsed.authMethod === 'api_key' ? 'api_payg' : 'subscription';
      base.accountLabel =
        parsed.email ??
        (gatewayUrl
          ? `Gateway · ${gatewayUrl}`
          : parsed.loggedIn
            ? 'Anthropic Account'
            : null);
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
    return base;
  }

  async createSession(config: ClaudeSessionExtendedConfig): Promise<AdapterSessionHandle> {
    const binaryPath = await resolveBinary('claude', this.binaryOverride);
    if (!binaryPath) {
      throw new Error('Claude Code CLI binary not found. Please install claude or configure binary path.');
    }

    const baseEnv = this.buildIsolatedEnv();
    const unsetEnv = this.buildUnsetEnv();
    const supportsSnapshot = await this.checkSupportsSystemPromptSnapshot(
      binaryPath,
      baseEnv,
      unsetEnv,
    );

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--forward-subagent-text',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      mapPermissionModeToClaude(config.permissionMode),
    ];

    const effectiveModel = resolveClaudeModelWithContextWindow(config.model, config.contextWindow);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }
    if (config.reasoningEffort && config.reasoningEffort !== 'disabled' && config.reasoningEffort !== 'none') {
      args.push('--effort', config.reasoningEffort);
    }
    if (config.thinking === false) {
      args.push('--max-thinking-tokens', '0');
    }
    if (config.fastMode) {
      args.push('--settings', JSON.stringify({ fastMode: true }));
    }
    if (config.nativeSessionId) {
      args.push('--resume', config.nativeSessionId);
      if (config.forkSession) {
        args.push('--fork-session');
      }
    }
    if (config.handoffContinuity) {
      if (supportsSnapshot) {
        args.push('--system-prompt-snapshot', 'off');
      }
      args.push('--append-system-prompt', handoffContinuityNotice);
      config.onContinuityNotice?.('system_append', handoffContinuityNotice);
    }

    const mcp = config.pluginMcp;
    if (mcp) {
      args.push('--mcp-config', JSON.stringify({
        mcpServers: {
          [pluginMcpServerName]: {
            type: 'http',
            url: mcp.url,
            headers: { Authorization: 'Bearer ${' + pluginMcpTokenEnv + '}' },
          },
        },
      }));
    }

    const spawnEnv = this.buildIsolatedEnv(mcp ? { [pluginMcpTokenEnv]: mcp.token } : undefined);
    const child = spawnCliProcess(binaryPath, args, {
      cwd: config.cwd,
      env: spawnEnv,
      unsetEnv,
    });
    return new ClaudeSessionHandle(child, config, {
      binaryPath,
      env: baseEnv,
      unsetEnv,
      mcpRegistrationTimeoutMs: this.mcpRegistrationTimeoutMs,
    });
  }
}

function resolveClaudeModelWithContextWindow(
  model: string | null | undefined,
  contextWindow?: '200k' | '1m',
): string | null {
  if (!model) return null;
  if (contextWindow === '1m' && !/\[1m\]$/i.test(model)) {
    return `${model}[1m]`;
  }
  return model;
}

export function readClaudeLocalSettings(
  configDir?: string,
  modelGroupRules?: ClaudeModelGroupRule[],
): ClaudeLocalSettingsProbe {
  const settingsDir = configDir?.trim()
    ? path.resolve(configDir.trim())
    : process.env.CLAUDE_CONFIG_DIR?.trim()
      ? path.resolve(process.env.CLAUDE_CONFIG_DIR.trim())
      : path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { models: FALLBACK_CLAUDE_MODELS, defaultModelId: 'sonnet', gatewayUrl: null };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      model?: string;
      modelPicker?: {
        options?: Array<{ model?: string; label?: string; description?: string }>;
      };
      env?: Record<string, string>;
    };

    const gatewayUrl = raw.env?.ANTHROPIC_BASE_URL ?? null;
    const capMap = parseClaudeModelCapabilities(raw.env?.CLAUDE_CODE_MODEL_CAPABILITIES ?? '');
    const configuredDefault =
      raw.env?.ANTHROPIC_DEFAULT_SONNET_MODEL || raw.model || 'sonnet';

    const options = raw.modelPicker?.options ?? [];
    const models: HarnessModelInfo[] = [];
    const seen = new Set<string>();

    for (const opt of options) {
      const id = opt.model?.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const cleanLabel = (opt.label ?? id).replace(/路/g, '·');
      const baseKey = id.replace(/\[[^\]]+\]$/, '').toLowerCase();
      const efforts = capMap.get(baseKey);
      const group = classifyClaudeModelGroup(id, cleanLabel, modelGroupRules);

      models.push({
        id,
        displayName: cleanLabel,
        description: opt.description?.replace(/路/g, '·'),
        group,
        isDefault: id === configuredDefault || id === raw.model,
        supportedEfforts: efforts,
        inputModalities: ['text', 'image'],
      });
    }

    if (models.length === 0) {
      return { models: FALLBACK_CLAUDE_MODELS, defaultModelId: configuredDefault, gatewayUrl };
    }

    return {
      models,
      defaultModelId: models.find((m) => m.isDefault)?.id ?? models[0]!.id,
      gatewayUrl,
    };
  } catch {
    return { models: FALLBACK_CLAUDE_MODELS, defaultModelId: 'sonnet', gatewayUrl: null };
  }
}

function parseClaudeModelCapabilities(raw: string): Map<string, ReasoningEffort[]> {
  const map = new Map<string, ReasoningEffort[]>();
  for (const part of raw.split(';')) {
    const [key, capsRaw] = part.split('=');
    if (!key || !capsRaw) continue;
    const caps = capsRaw.split(',').map((s) => s.trim());
    const efforts: ReasoningEffort[] = [];
    if (caps.includes('effort')) efforts.push('low', 'medium', 'high');
    if (caps.includes('xhigh_effort')) efforts.push('xhigh');
    if (caps.includes('max_effort')) efforts.push('max');
    if (efforts.length > 0) {
      map.set(key.trim().toLowerCase(), efforts);
    }
  }
  return map;
}

export function classifyClaudeModelGroup(
  id: string,
  label: string,
  rules?: ClaudeModelGroupRule[],
): string {
  if (rules) {
    for (const rule of rules) {
      if (id.startsWith(rule.prefix)) return rule.groupLabel;
    }
  }
  if (id.startsWith('auto/') || label.toLowerCase().includes('routing group')) {
    return 'Auto Routing';
  }
  if (id.includes('/')) return id.split('/')[0]!;
  return 'Anthropic Claude';
}

interface PendingClaudeApproval {
  requestId: string;
  toolInput: unknown;
  isAskUserQuestion?: boolean;
}

interface ClaudeRuntimeEnvContext {
  binaryPath: string;
  env?: Record<string, string | undefined>;
  unsetEnv?: string[];
  mcpRegistrationTimeoutMs: number;
}

export class ClaudeSessionHandle implements AdapterSessionHandle {
  get pluginMcpAvailable(): boolean { return Boolean(this.config.pluginMcp); }
  private readonly listeners = new Set<(event: NormalizedAdapterEvent) => void>();
  private readonly earlyBuffer: NormalizedAdapterEvent[] = [];
  private readonly parser: ResilientJsonLineParser;
  private readonly pendingApprovals = new Map<string, PendingClaudeApproval>();
  private readonly seenToolUseIds = new Set<string>();
  private readonly recentStderr: string[] = [];
  private _nativeSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private assistantAccum = '';
  private thinkingAccum = '';
  private streamedDeltaThisTurn = false;
  private streamedThinkingDeltaThisTurn = false;
  private sawThinkingSignatureThisTurn = false;
  private promptAcceptedThisTurn = false;
  private lastRefusedBeforePrompt = false;
  private lastRateLimitRejected = false;
  private streamUsageAccum: ClaudeRawUsage = {};
  private contextWindowMode: '200k' | '1m';
  private mcpRegistrationTimer?: NodeJS.Timeout;
  private disposed = false;
  private skillsRequest?: {
    id: string;
    resolve: (skills: NativeSkill[]) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };
  private skillCatalog?: NativeSkill[];

  constructor(
    private readonly child: ReturnType<typeof spawnCliProcess>,
    private readonly config: ClaudeSessionExtendedConfig,
    private readonly runtimeEnv?: ClaudeRuntimeEnvContext,
  ) {
    this._nativeSessionId = config.nativeSessionId ?? null;
    this.contextWindowMode =
      config.contextWindow ?? (/\[1m\]/i.test(config.model ?? '') ? '1m' : '200k');
    this.parser = new ResilientJsonLineParser(
      (msg) => this.handleMessage(msg),
      (noise) =>
        this.emit({ type: 'diagnostic.log', level: 'info', stream: 'stdout', message: noise }),
    );

    child.stdout?.on('data', (chunk: Buffer) => this.parser.feed(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) {
            this.recentStderr.push(trimmed);
            if (this.recentStderr.length > 20) this.recentStderr.shift();
            this.emit({
              type: 'diagnostic.log',
              level: 'info',
              stream: 'stderr',
              message: trimmed,
            });
          }
        }
      }
    });

    child.on('error', (err) => {
      this.clearMcpRegistrationTimer();
      this.emit({ type: 'diagnostic.log', level: 'error', stream: 'protocol', message: err.message });
      if (this.currentTurnId) {
        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        const stderrText = this.recentStderr.join('\n');
        let code = classifyClaudeError(`${err.message}\n${stderrText}`);
        if (code === 'provider_error' && !this.promptAcceptedThisTurn) {
          this.lastRefusedBeforePrompt = true;
          code = 'refused_before_prompt';
        }
        this.emit({ type: 'turn.failed', turnId, message: err.message, code });
      }
    });

    child.on('close', (code, signal) => {
      this.clearMcpRegistrationTimer();
      this.parser.flush();
      this.clearSkillsRequest(new Error('Claude CLI exited before returning its skill catalog'));
      if (this.currentTurnId && !this.disposed) {
        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        const stderrText = this.recentStderr.join('\n');
        const message = stderrText
          ? `Claude CLI exited unexpectedly (code=${code}, signal=${signal}): ${stderrText.slice(0, 300)}`
          : `Claude CLI exited unexpectedly (code=${code}, signal=${signal})`;
        let errorCode = classifyClaudeError(message);
        if (errorCode === 'provider_error' && this.lastRateLimitRejected) {
          errorCode = 'usage_limit';
        } else if (errorCode === 'provider_error' && !this.promptAcceptedThisTurn) {
          this.lastRefusedBeforePrompt = true;
          errorCode = 'refused_before_prompt';
        }
        this.emit({
          type: 'turn.failed',
          turnId,
          message,
          code: errorCode,
        });
      }
    });
  }

  get nativeSessionId(): string | null {
    return this._nativeSessionId;
  }

  getLastRefusedBeforePrompt(): boolean {
    return this.lastRefusedBeforePrompt;
  }

  private clearMcpRegistrationTimer(): void {
    if (this.mcpRegistrationTimer) {
      clearTimeout(this.mcpRegistrationTimer);
      this.mcpRegistrationTimer = undefined;
    }
  }

  async forkSession(): Promise<{ nativeSessionId: string }> {
    const sessionId = this._nativeSessionId;
    if (!sessionId) {
      throw new Error('Claude session has no nativeSessionId to fork');
    }
    const binaryPath = this.runtimeEnv?.binaryPath ?? (await resolveBinary('claude'));
    if (!binaryPath) {
      throw new Error('Claude Code CLI binary not found for forkSession');
    }
    const res = await execCliQuick(
      binaryPath,
      [
        '--resume',
        sessionId,
        '--fork-session',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '',
      ],
      15_000,
      {
        cwd: this.config.cwd,
        env: this.runtimeEnv?.env,
        unsetEnv: this.runtimeEnv?.unsetEnv,
        input: '',
      },
    );
    for (const line of `${res.stdout}\n${res.stderr}`.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed) as { session_id?: string };
        if (typeof parsed.session_id === 'string' && parsed.session_id) {
          return { nativeSessionId: parsed.session_id };
        }
      } catch {
        // ignore non-json lines
      }
    }
    throw new Error(res.stderr.trim() || 'Claude --fork-session did not return a forked session_id');
  }

  forkNativeSession(): Promise<{ nativeSessionId: string }> {
    return this.forkSession();
  }

  async runNativeCommand(command: string, args: string): Promise<string> {
    if (command === 'fork') {
      const forked = await this.forkSession();
      return forked.nativeSessionId;
    }
    if (command === 'skills') {
      const skills = await this.listSkills();
      return skills.map((s) => (s.description ? `${s.name}: ${s.description}` : s.name)).join('\n') || 'No skills available';
    }
    if (command === 'compact') {
      const turnId = `compact_${crypto.randomBytes(4).toString('hex')}`;
      await this.sendTurn({
        turnId,
        text: args ? `/compact ${args}` : '/compact',
        cliCommand: args ? `/compact ${args}` : '/compact',
      });
      return 'Requested Claude session compaction';
    }
    throw new Error(`Unsupported Claude native command: ${command}`);
  }

  async updateConfig(
    patch: Partial<ClaudeSessionExtendedConfig>,
  ): Promise<void> {
    if (patch.contextWindow !== undefined) {
      this.contextWindowMode = patch.contextWindow;
    }
    if (patch.model !== undefined) {
      this.config.model = patch.model;
      if (/\[1m\]$/i.test(patch.model ?? '')) {
        this.contextWindowMode = '1m';
      }
    }
    if (patch.reasoningEffort !== undefined) {
      this.config.reasoningEffort = patch.reasoningEffort;
    }
    if (patch.permissionMode !== undefined) {
      this.config.permissionMode = patch.permissionMode;
    }
  }

  async listSkills(): Promise<NativeSkill[]> {
    if (this.skillCatalog) return this.skillCatalog;
    if (this.disposed || this.child.stdin?.destroyed) throw new Error('Claude CLI is closed');
    const id = `skills_${crypto.randomBytes(5).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.clearSkillsRequest(new Error('Claude skill catalog timed out')), 10_000);
      this.skillsRequest = { id, resolve, reject, timer };
      this.writeJson({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
    });
  }

  private clearSkillsRequest(err: Error): void {
    if (!this.skillsRequest) return;
    const pending = this.skillsRequest;
    this.skillsRequest = undefined;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  async sendTurn(
    input: TurnInput,
  ): Promise<{ driverUsed?: import('@harnessmate/protocol').ContextInjectionDriver }> {
    if (this.disposed) {
      throw new Error('Claude session has been disposed');
    }
    this.currentTurnId = input.turnId;
    this.assistantAccum = '';
    this.thinkingAccum = '';
    this.streamedDeltaThisTurn = false;
    this.streamedThinkingDeltaThisTurn = false;
    this.sawThinkingSignatureThisTurn = false;
    this.promptAcceptedThisTurn = false;
    this.lastRefusedBeforePrompt = false;
    this.lastRateLimitRejected = false;
    this.streamUsageAccum = {};
    this.recentStderr.length = 0;

    if (this.config.pluginMcp && this.runtimeEnv?.mcpRegistrationTimeoutMs) {
      this.clearMcpRegistrationTimer();
      this.mcpRegistrationTimer = setTimeout(() => {
        if (this.currentTurnId === input.turnId && !this.promptAcceptedThisTurn && !this.disposed) {
          this.lastRefusedBeforePrompt = true;
          this.currentTurnId = null;
          this.emit({
            type: 'turn.failed',
            turnId: input.turnId,
            message: `Claude MCP registration timed out after ${this.runtimeEnv!.mcpRegistrationTimeoutMs}ms before prompt was accepted`,
            code: 'refused_before_prompt',
          });
        }
      }, this.runtimeEnv.mcpRegistrationTimeoutMs);
    }

    this.emit({ type: 'turn.started', turnId: input.turnId });

    const basePromptText = input.cliCommand ?? buildPromptWithFileAttachments(input.text, input.attachments);
    const promptText = input.contextSync
      ? `${input.contextSync.deltaMarkdown}\n\n---\n\n${basePromptText}`
      : basePromptText;
    const contentBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: promptText }];
    for (const att of input.attachments ?? []) {
      if (att.kind === 'image') {
        const base64 =
          att.dataBase64 ||
          (att.path && fs.existsSync(att.path) ? fs.readFileSync(att.path).toString('base64') : null);
        if (base64 && att.mimeType) {
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mimeType,
              data: base64,
            },
          });
        }
      }
    }

    if (input.contextSync) input.contextSync.onDispatch?.('claude_sysfile_delta', input.contextSync.deltaMarkdown);
    const wrote = this.writeJson({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks.length === 1 ? promptText : contentBlocks,
      },
    });
    if (!wrote) {
      this.clearMcpRegistrationTimer();
      this.lastRefusedBeforePrompt = true;
      this.currentTurnId = null;
      this.emit({
        type: 'turn.failed',
        turnId: input.turnId,
        message: 'Claude CLI stdin closed before prompt could be written',
        code: 'refused_before_prompt',
      });
    }

    return { driverUsed: input.contextSync ? 'claude_sysfile_delta' : undefined };
  }

  async interrupt(): Promise<void> {
    if (this.disposed) return;
    this.clearMcpRegistrationTimer();
    this.writeJson({
      type: 'control_request',
      request_id: `int_${crypto.randomBytes(6).toString('hex')}`,
      request: { subtype: 'interrupt' },
    });
    if (this.currentTurnId) {
      const turnId = this.currentTurnId;
      this.currentTurnId = null;
      this.emit({ type: 'turn.cancelled', turnId });
    }
  }

  async resolveApproval(
    nativeRequestId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(nativeRequestId);
    if (!pending) return;
    this.pendingApprovals.delete(nativeRequestId);

    const allowed = decision === 'allow_once' || decision === 'allow_session';
    let updatedInput: unknown =
      pending.toolInput && typeof pending.toolInput === 'object' ? pending.toolInput : {};

    if (pending.isAskUserQuestion && allowed) {
      const baseInput =
        pending.toolInput && typeof pending.toolInput === 'object'
          ? (pending.toolInput as Record<string, unknown>)
          : {};
      const answers = buildAskUserQuestionAnswers(baseInput, comment);
      updatedInput = { ...baseInput, answers };
      const turnId = this.currentTurnId ?? 'turn_bg';
      this.emit({
        type: 'turn_block.ext',
        turnId,
        itemId: `claude_q_${pending.requestId}`,
        blockType: 'ext:claude.user_question',
        title: 'Claude Question',
        fallbackSummary: `Answered: ${Object.values(answers).join(', ') || 'Confirmed'}`,
        status: 'completed',
        payload: { requestId: pending.requestId, answers, questions: baseInput.questions ?? [] },
      });
    } else if (pending.isAskUserQuestion && !allowed) {
      const turnId = this.currentTurnId ?? 'turn_bg';
      this.emit({
        type: 'turn_block.ext',
        turnId,
        itemId: `claude_q_${pending.requestId}`,
        blockType: 'ext:claude.user_question',
        title: 'Claude Question',
        fallbackSummary: comment || 'Question cancelled by user',
        status: 'failed',
        payload: { requestId: pending.requestId, cancelled: true },
      });
    }

    this.writeJson({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: pending.requestId,
        response: allowed
          ? {
              behavior: 'allow',
              updatedInput,
            }
          : {
              behavior: 'deny',
              message: comment || 'User rejected tool execution from HarnessMate.',
            },
      },
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearMcpRegistrationTimer();
    this.clearSkillsRequest(new Error('Claude session was closed'));
    this.pendingApprovals.clear();
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    await killProcessTree(this.child);
  }

  onEvent(listener: (event: NormalizedAdapterEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.earlyBuffer.length > 0) {
      const queued = this.earlyBuffer.splice(0, this.earlyBuffer.length);
      for (const ev of queued) {
        listener(ev);
      }
    }
    return () => this.listeners.delete(listener);
  }

  private writeJson(obj: Record<string, unknown>): boolean {
    if (!this.child.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      return false;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private emit(event: NormalizedAdapterEvent): void {
    if (this.listeners.size === 0) {
      this.earlyBuffer.push(event);
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private markPromptAccepted(): void {
    if (!this.promptAcceptedThisTurn) {
      this.promptAcceptedThisTurn = true;
      this.clearMcpRegistrationTimer();
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? '');
    const turnId = this.currentTurnId ?? 'turn_bg';
    if (type === 'control_response') {
      const pending = this.skillsRequest;
      const response = msg.response as { request_id?: string; subtype?: string; error?: string; response?: {
        commands?: Array<{ name?: string; description?: string; builtin?: boolean }>;
      } } | undefined;
      if (pending && response?.request_id === pending.id) {
        if (response.subtype !== 'success') {
          this.clearSkillsRequest(new Error(response.error ?? 'Claude skill catalog is unavailable'));
          return;
        }
        clearTimeout(pending.timer);
        this.skillsRequest = undefined;
        this.skillCatalog = (response.response?.commands ?? []).flatMap((command) =>
          command.name && !command.builtin ? [{ name: command.name, description: command.description }] : []);
        pending.resolve(this.skillCatalog);
      }
      return;
    }

    if (typeof msg.session_id === 'string' && msg.session_id && this._nativeSessionId !== msg.session_id) {
      this._nativeSessionId = msg.session_id;
      this.emit({ type: 'native_session_ready', nativeSessionId: msg.session_id });
    }

    switch (type) {
      case 'system': {
        if (typeof msg.model === 'string' && msg.model) {
          const requested = this.config.model;
          const mismatch =
            requested &&
            !msg.model.toLowerCase().includes(requested.replace(/\[[^\]]+\]$/, '').toLowerCase());
          this.emit({
            type: 'model.confirmed',
            actualModel: msg.model,
            ...(mismatch
              ? { reroutedFrom: requested, reason: 'Claude CLI initialized with a different model' }
              : {}),
          });
        }
        break;
      }

      case 'stream_event': {
        this.markPromptAccepted();
        const event = (msg.event ?? {}) as Record<string, unknown>;
        const evType = String(event.type ?? '');
        const parentToolUseId =
          typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined;

        if (evType === 'message_start') {
          const msgObj = (event.message ?? {}) as { usage?: ClaudeRawUsage };
          if (msgObj.usage) {
            this.streamUsageAccum = mergeClaudeStreamUsage(this.streamUsageAccum, msgObj.usage);
          }
        } else if (evType === 'message_delta') {
          const usage = event.usage as ClaudeRawUsage | undefined;
          if (usage) {
            this.streamUsageAccum = mergeClaudeStreamUsage(this.streamUsageAccum, usage);
          }
        } else if (evType === 'content_block_delta') {
          const delta = (event.delta ?? {}) as Record<string, unknown>;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            this.streamedDeltaThisTurn = true;
            this.assistantAccum += delta.text;
            this.emit({
              type: 'message.assistant.delta',
              turnId,
              text: delta.text,
              parentToolUseId,
            });
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            this.streamedThinkingDeltaThisTurn = true;
            this.thinkingAccum += delta.thinking;
            this.emit({ type: 'thinking.delta', turnId, text: delta.thinking });
          } else if (delta.type === 'signature_delta') {
            this.sawThinkingSignatureThisTurn = true;
          }
        } else if (evType === 'content_block_start') {
          const block = (event.content_block ?? {}) as Record<string, unknown>;
          if (block.type === 'tool_use' && typeof block.id === 'string') {
            this.seenToolUseIds.add(block.id);
            const toolName = String(block.name ?? 'Tool');
            this.emit({
              type: 'tool.call.started',
              turnId,
              toolCallId: block.id,
              toolName,
              toolKind: classifyClaudeToolKind(toolName),
              summary: toolName,
              input: block.input,
              parentToolUseId,
            });
          } else if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature) {
            this.sawThinkingSignatureThisTurn = true;
          }
        }
        break;
      }

      case 'assistant': {
        this.markPromptAccepted();
        const message = (msg.message ?? {}) as Record<string, unknown>;
        if (typeof message.model === 'string' && message.model) {
          this.emit({ type: 'model.confirmed', actualModel: message.model });
        }
        if (message.usage && typeof message.usage === 'object') {
          this.streamUsageAccum = mergeClaudeStreamUsage(
            this.streamUsageAccum,
            message.usage as ClaudeRawUsage,
          );
        }
        const content = Array.isArray(message.content) ? message.content : [];
        const parentToolUseId =
          typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined;

        for (const rawBlock of content) {
          if (!rawBlock || typeof rawBlock !== 'object') continue;
          const block = rawBlock as Record<string, unknown>;
          if (block.type === 'thinking') {
            if (typeof block.signature === 'string' && block.signature.length > 0) {
              this.sawThinkingSignatureThisTurn = true;
            }
            if (typeof block.thinking === 'string' && block.thinking && !this.streamedThinkingDeltaThisTurn) {
              this.thinkingAccum += block.thinking;
              this.emit({ type: 'thinking.delta', turnId, text: block.thinking });
            }
          } else if (block.type === 'text' && typeof block.text === 'string' && !this.streamedDeltaThisTurn) {
            this.assistantAccum += block.text;
            this.emit({
              type: 'message.assistant.delta',
              turnId,
              text: block.text,
              parentToolUseId,
            });
          } else if (block.type === 'tool_use' && typeof block.id === 'string') {
            const toolName = String(block.name ?? 'Tool');
            if (!this.seenToolUseIds.has(block.id)) {
              this.seenToolUseIds.add(block.id);
              this.emit({
                type: 'tool.call.started',
                turnId,
                toolCallId: block.id,
                toolName,
                toolKind: classifyClaudeToolKind(toolName),
                summary: summarizeClaudeTool(toolName, block.input),
                input: block.input,
                parentToolUseId,
              });
            }
          }
        }
        break;
      }

      case 'user': {
        const message = (msg.message ?? {}) as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const rawBlock of content) {
          if (!rawBlock || typeof rawBlock !== 'object') continue;
          const block = rawBlock as Record<string, unknown>;
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const output =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((c) => (c && typeof c === 'object' ? String((c as { text?: string }).text ?? '') : ''))
                      .join('\n')
                  : undefined;
            this.emit({
              type: 'tool.call.completed',
              turnId,
              toolCallId: block.tool_use_id,
              toolName: 'tool',
              status: block.is_error ? 'error' : 'success',
              output,
            });
          }
        }
        break;
      }

      case 'control_request': {
        this.markPromptAccepted();
        const requestId = String(msg.request_id ?? `claude_req_${Date.now()}`);
        const request = (msg.request ?? {}) as Record<string, unknown>;
        if (request.subtype === 'can_use_tool') {
          const toolName = String(request.tool_name ?? 'Tool');
          const toolInput = request.input ?? {};
          const isAskUserQuestion = toolName === 'AskUserQuestion';
          this.pendingApprovals.set(requestId, { requestId, toolInput, isAskUserQuestion });

          if (isAskUserQuestion) {
            const inputRec =
              toolInput && typeof toolInput === 'object'
                ? (toolInput as { questions?: Array<{ question?: string; header?: string; options?: unknown[] }> })
                : {};
            const questions = Array.isArray(inputRec.questions) ? inputRec.questions : [];
            const firstPrompt = questions[0]?.question ?? 'Claude is asking for user input';
            this.emit({
              type: 'turn_block.ext',
              turnId,
              itemId: `claude_q_${requestId}`,
              blockType: 'ext:claude.user_question',
              title: 'Claude Question',
              fallbackSummary: firstPrompt,
              status: 'pending',
              payload: { requestId, questions },
            });
            this.emit({
              type: 'approval.requested',
              turnId,
              nativeRequestId: requestId,
              toolName,
              toolKind: 'other',
              summary: firstPrompt,
              input: toolInput,
              riskLevel: 'low',
            });
          } else {
            this.emit({
              type: 'approval.requested',
              turnId,
              nativeRequestId: requestId,
              toolName,
              toolKind: classifyClaudeToolKind(toolName),
              summary: summarizeClaudeTool(toolName, toolInput),
              input: toolInput,
              riskLevel: classifyClaudeRisk(toolName, toolInput),
            });
          }
        }
        break;
      }

      case 'rate_limit_event': {
        const info = (msg.rate_limit_info ?? msg) as {
          status?: string;
          resetsAt?: number;
          rateLimitType?: string;
          utilization?: number;
        };
        const status = String(info.status ?? 'warning');
        if (status === 'rejected') {
          this.lastRateLimitRejected = true;
        }
        this.emit({
          type: 'diagnostic.log',
          level: status === 'rejected' ? 'error' : 'warn',
          stream: 'protocol',
          message: `Claude rate_limit_event (${status})${info.rateLimitType ? ` [${info.rateLimitType}]` : ''}${typeof info.utilization === 'number' ? ` utilization=${info.utilization}` : ''}`,
        });
        if (this.currentTurnId) {
          this.emit({
            type: 'turn_block.ext',
            turnId: this.currentTurnId,
            itemId: `claude_rl_${Date.now()}`,
            blockType: 'ext:claude.rate_limit',
            title: 'Claude Rate Limit',
            fallbackSummary: `Rate limit status: ${status}`,
            status: status === 'rejected' ? 'failed' : 'completed',
            payload: { ...info, status },
          });
        }
        break;
      }

      case 'result': {
        this.clearMcpRegistrationTimer();
        const activeTurnId = this.currentTurnId;
        this.currentTurnId = null;

        const mergedUsage = mergeClaudeStreamUsage(
          this.streamUsageAccum,
          (msg.usage ?? {}) as ClaudeRawUsage,
        );
        const contextWindowTokens =
          this.contextWindowMode === '1m' ? CLAUDE_LARGE_CONTEXT_WINDOW : undefined;
        const computed = claudeProviderTurnTokenUsage(mergedUsage, {
          model: this.config.model,
          contextWindowTokens,
          totalCostUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        });

        this.emit({
          type: 'usage.updated',
          turnId: activeTurnId,
          usage: {
            inputTokens: computed.inputTokens,
            outputTokens: computed.outputTokens,
            cachedTokens: computed.cachedTokens,
            costUsd: computed.costUsd,
          },
        });

        if (activeTurnId) {
          this.emit({
            type: 'turn_block.ext',
            turnId: activeTurnId,
            itemId: `claude_cache_${activeTurnId}`,
            blockType: 'ext:claude.cache_metrics',
            title: 'Claude Cache Metrics',
            fallbackSummary: `window=${computed.contextWindow}, autoCompact=${computed.autoCompactThreshold}`,
            status: 'completed',
            payload: {
              inputTokens: computed.inputTokens,
              outputTokens: computed.outputTokens,
              cachedTokens: computed.cachedTokens ?? 0,
              cacheCreationInputTokens: computed.cacheCreationInputTokens,
              ephemeral5mInputTokens: computed.ephemeral5mInputTokens,
              ephemeral1hInputTokens: computed.ephemeral1hInputTokens,
              ...(computed.promptCacheTtlMs !== undefined
                ? { promptCacheTtlMs: computed.promptCacheTtlMs }
                : {}),
              ...(computed.promptCacheExpiresAt !== undefined
                ? { promptCacheExpiresAt: computed.promptCacheExpiresAt }
                : {}),
              contextWindow: computed.contextWindow,
              autoCompactThreshold: computed.autoCompactThreshold,
            },
          });
        }

        if (!activeTurnId) break;

        if (this.sawThinkingSignatureThisTurn) {
          this.emit({
            type: 'turn_block.ext',
            turnId: activeTurnId,
            itemId: `claude_sig_${activeTurnId}`,
            blockType: 'ext:claude.thinking_signature',
            title: 'Redacted Thinking Signature',
            fallbackSummary: 'Thinking signature redacted',
            status: 'completed',
            payload: { redactedSignature: true },
          });
        }

        if (this.thinkingAccum) {
          this.emit({ type: 'thinking.completed', turnId: activeTurnId, text: this.thinkingAccum });
        }
        if (this.assistantAccum || (!msg.is_error && typeof msg.result === 'string')) {
          this.emit({
            type: 'message.assistant.completed',
            turnId: activeTurnId,
            text: this.assistantAccum || String(msg.result ?? ''),
          });
        }

        if (msg.is_error) {
          const errorsArr = Array.isArray(msg.errors) ? msg.errors.map(String) : [];
          const errMessage =
            (typeof msg.result === 'string' && msg.result) ||
            errorsArr.join('; ') ||
            'Claude turn returned error';
          const combinedForClassify = `${errMessage}\n${errorsArr.join('\n')}\n${this.recentStderr.join('\n')}`;
          let code = classifyClaudeError(combinedForClassify);
          if (code === 'provider_error' && this.lastRateLimitRejected) {
            code = 'usage_limit';
          } else if (code === 'provider_error' && !this.promptAcceptedThisTurn) {
            this.lastRefusedBeforePrompt = true;
            code = 'refused_before_prompt';
          }
          this.emit({
            type: 'turn.failed',
            turnId: activeTurnId,
            message: errMessage,
            code,
          });
        } else {
          this.markPromptAccepted();
          this.emit({
            type: 'turn.completed',
            turnId: activeTurnId,
            stopReason: String(msg.subtype ?? 'success'),
          });
        }
        break;
      }

      default:
        break;
    }
  }
}

function buildAskUserQuestionAnswers(
  toolInput: Record<string, unknown>,
  comment?: string,
): Record<string, string> {
  if (comment?.trim()) {
    try {
      const parsed = JSON.parse(comment) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        if (rec.answers && typeof rec.answers === 'object' && !Array.isArray(rec.answers)) {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(rec.answers as Record<string, unknown>)) {
            out[k] = String(v);
          }
          return out;
        }
      }
    } catch {
      // treat comment as plain text answer
    }
  }

  const questions = Array.isArray(toolInput.questions)
    ? (toolInput.questions as Array<{ question?: string; options?: Array<{ label?: string }> }>)
    : [];
  const answers: Record<string, string> = {};
  for (const q of questions) {
    if (!q.question) continue;
    answers[q.question] = comment?.trim() || q.options?.[0]?.label || 'Confirmed';
  }
  if (Object.keys(answers).length === 0 && comment?.trim()) {
    answers.answer = comment.trim();
  }
  return answers;
}

function mapPermissionModeToClaude(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'manual':
      return 'manual';
    case 'auto':
      return 'auto';
    case 'accept_edits':
    default:
      return 'acceptEdits';
  }
}

function classifyClaudeToolKind(toolName: string): ToolKind {
  const lower = toolName.toLowerCase();
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('powershell')) return 'shell';
  if (lower === 'read' || lower.includes('read_file')) return 'file_read';
  if (lower === 'edit' || lower === 'write' || lower.includes('multiedit') || lower.includes('notebookedit')) {
    return 'file_edit';
  }
  if (lower === 'grep' || lower === 'glob' || lower.includes('search')) return 'search';
  if (lower.includes('web')) return 'web';
  if (lower === 'agent' || lower === 'task') return 'subagent';
  if (lower.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function summarizeClaudeTool(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return toolName;
  const rec = input as Record<string, unknown>;
  if (typeof rec.command === 'string') return `${toolName}: ${rec.command}`;
  if (typeof rec.file_path === 'string') return `${toolName}: ${rec.file_path}`;
  if (typeof rec.pattern === 'string') return `${toolName}: ${rec.pattern}`;
  if (typeof rec.description === 'string') return `${toolName}: ${rec.description}`;
  return toolName;
}

function classifyClaudeRisk(toolName: string, input: unknown): RiskLevel {
  const kind = classifyClaudeToolKind(toolName);
  if (kind === 'shell') {
    const cmd = input && typeof input === 'object' ? String((input as { command?: string }).command ?? '') : '';
    if (/\b(rm\s+-rf|git\s+push\s+--force|git\s+reset\s+--hard|del\s+\/s)\b/i.test(cmd)) return 'high';
    return 'medium';
  }
  if (kind === 'file_edit') return 'medium';
  return 'low';
}
