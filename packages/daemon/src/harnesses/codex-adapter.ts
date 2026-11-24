import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ApprovalDecision,
  Attachment,
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
import { JsonRpcResponseError, StdioJsonRpcClient, type JsonRpcServerRequest } from './jsonrpc.js';
import { getCodexRolloutStore } from './history-scanner.js';
import { DEFAULT_STRIP_ENV_KEYS, execCliQuick, resolveBinary, spawnCliProcess } from './process.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NativeSkill,
  NormalizedAdapterEvent,
  TurnInput,
} from './types.js';
import { handoffContinuityNotice, pluginMcpServerName, pluginMcpTokenEnv } from './types.js';

const VALID_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'disabled',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const RESERVED_ENV_SET = new Set<string>(DEFAULT_STRIP_ENV_KEYS);

export type CodexErrorCode =
  | 'invalid_encrypted_content'
  | 'usage_limit'
  | 'native_thread_in_use'
  | 'provider_error';

export interface CodexModelGroupRule {
  prefix: string;
  groupLabel: string;
}

export interface CodexLiveProbeSnapshot {
  models: HarnessModelInfo[];
  defaultModelId: string | null;
  account: {
    type?: string;
    email?: string;
    planType?: string;
  } | null;
  rateLimits: unknown;
  usage: unknown;
  mcpServers: unknown[];
}

export interface CodexAdapterInstanceOptions {
  instanceId?: string;
  displayName?: string;
  description?: string;
  codexHome?: string;
  continuationKey?: string;
  envWhitelist?: Record<string, string>;
  defaultServiceTier?: 'default' | 'fast';
  modelGroupRules?: CodexModelGroupRule[];
}

export function buildCodexOptionDescriptors(
  models: HarnessModelInfo[],
  defaultModelId?: string | null,
  defaultServiceTier: 'default' | 'fast' = 'default',
): ProviderOptionDescriptor[] {
  const defaultModel =
    models.find((m) => m.id === defaultModelId) ?? models.find((m) => m.isDefault) ?? models[0];
  const efforts: ReasoningEffort[] =
    defaultModel?.supportedEfforts && defaultModel.supportedEfforts.length > 0
      ? defaultModel.supportedEfforts
      : ['low', 'medium', 'high', 'xhigh'];
  const defaultEffort =
    defaultModel?.defaultEffort && efforts.includes(defaultModel.defaultEffort)
      ? defaultModel.defaultEffort
      : efforts.includes('medium')
        ? 'medium'
        : efforts[0]!;

  return [
    {
      key: 'reasoningEffort',
      label: 'Reasoning Effort',
      description: 'Controls reasoning depth for Codex turns',
      kind: 'select',
      defaultValue: defaultEffort,
      options: efforts.map((effort) => ({
        value: effort,
        label: effort.charAt(0).toUpperCase() + effort.slice(1),
      })),
    },
    {
      key: 'serviceTier',
      label: 'Service Tier',
      description: 'Execution priority tier for Codex turns',
      kind: 'select',
      defaultValue: defaultServiceTier,
      options: [
        { value: 'default', label: 'Standard' },
        { value: 'fast', label: 'Fast' },
      ],
    },
  ];
}

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly id: string;
  readonly driverId = 'codex' as const;
  readonly continuationKey: string;
  readonly pluginMcpTransport = 'http' as const;
  readonly kind = 'codex' as const;
  readonly displayName: string;
  readonly description: string;
  readonly protocolLabel = 'codex app-server (JSON-RPC 2.0)';
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    interactiveApproval: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    permissionModes: ['plan', 'manual', 'accept_edits', 'auto'],
    sessionResume: true,
    sessionFork: true,
    imageInput: true,
    subagents: true,
  };
  readonly presentation: HarnessPresentationMeta = {
    shortLabel: 'Codex',
    accentColor: 'var(--accent-emerald)',
    softBg: 'var(--accent-emerald-soft)',
    tagline: 'OpenAI Codex · App Server',
  };

  private readonly codexHome?: string;
  private readonly envWhitelist?: Record<string, string>;
  private readonly defaultServiceTier: 'default' | 'fast';
  private readonly modelGroupRules?: CodexModelGroupRule[];
  private cachedLiveProbe: CodexLiveProbeSnapshot | null = null;

  constructor(
    private readonly binaryOverride?: string,
    private readonly extraArgs: string[] = ['app-server', '--stdio'],
    instanceOpts?: CodexAdapterInstanceOptions,
  ) {
    this.id = instanceOpts?.instanceId ?? 'codex';
    this.displayName = instanceOpts?.displayName ?? 'Codex CLI';
    this.description =
      instanceOpts?.description ?? 'OpenAI Codex CLI via bidirectional app-server JSON-RPC 2.0';
    this.codexHome = instanceOpts?.codexHome?.trim()
      ? path.resolve(instanceOpts.codexHome.trim())
      : undefined;
    this.envWhitelist = instanceOpts?.envWhitelist;
    this.defaultServiceTier = instanceOpts?.defaultServiceTier ?? 'default';
    this.modelGroupRules = instanceOpts?.modelGroupRules;
    this.continuationKey =
      instanceOpts?.continuationKey ??
      (this.codexHome ? `codex:home:${this.codexHome}` : `codex:instance:${this.id}`);
  }

  get optionDescriptors(): ProviderOptionDescriptor[] {
    return buildCodexOptionDescriptors(
      this.cachedLiveProbe?.models ?? [],
      this.cachedLiveProbe?.defaultModelId,
      this.defaultServiceTier,
    );
  }

  get capabilitiesV2(): HarnessCapabilitiesV2 {
    return {
      ...this.capabilities,
      transport: 'jsonrpc_stdio',
      historyInjectionMode: 'native_items',
      supportsNativeRollback: true,
      supportsActiveSteering: true,
      supportsUsageLimits: true,
      supportsDynamicOptions: true,
      nativeCommands: ['goal', 'skills', 'compact', 'fork', 'rollback', 'steer'],
      optionDescriptors: this.optionDescriptors,
    };
  }

  private buildUnsetEnv(resolvedCodexHome?: string): string[] {
    if (!this.codexHome && !this.envWhitelist && !resolvedCodexHome) {
      return [];
    }
    return ['OPENAI_API_KEY', 'CODEX_HOME'];
  }

  private buildIsolatedEnv(
    resolvedCodexHome?: string,
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
    const targetHome = resolvedCodexHome ?? this.codexHome;
    if (targetHome) {
      clean.CODEX_HOME = targetHome;
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

  async probePassive(): Promise<HarnessInfo> {
    const binaryPath = await resolveBinary('codex', this.binaryOverride);
    const descriptors = this.optionDescriptors;
    const capsV2 = this.capabilitiesV2;
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
        healthMessage: 'codex CLI not found in PATH',
        capabilities: this.capabilities,
        capabilitiesV2: capsV2,
        presentation: this.presentation,
        optionDescriptors: descriptors,
        models: [],
        defaultModelId: null,
        accountSummary: null,
      };
    }

    const verRes = await execCliQuick(binaryPath, ['--version'], 10_000, {
      env: this.buildIsolatedEnv(),
      unsetEnv: this.buildUnsetEnv(),
      input: '',
    });
    const combined = `${verRes.stdout}\n${verRes.stderr}`.trim();
    const versionMatch =
      combined.match(/codex-cli\s+([\w.-]+)/i) ?? combined.match(/(\d+\.\d+\.\d+[\w.-]*)/);
    const version = versionMatch?.[1] ?? null;

    let models: HarnessModelInfo[] = [];
    let defaultModelId: string | null = null;
    let accountSummary: string | null = null;

    if (this.cachedLiveProbe) {
      models = this.cachedLiveProbe.models;
      defaultModelId = this.cachedLiveProbe.defaultModelId;
      accountSummary = formatCodexAccountSummary(this.cachedLiveProbe.account);
    } else {
      const configModel = readCodexConfigDefaultModel(this.codexHome);
      if (configModel) {
        defaultModelId = configModel;
        models = [
          {
            id: configModel,
            displayName: configModel,
            group: classifyCodexModelGroup(configModel, configModel, this.modelGroupRules),
            isDefault: true,
          },
        ];
      }
      accountSummary = readCodexAuthSummary(this.codexHome);
    }

    const passiveDescriptors = buildCodexOptionDescriptors(
      models,
      defaultModelId,
      this.defaultServiceTier,
    );

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
      health: verRes.exitCode === 0 ? 'ready' : 'degraded',
      healthMessage: verRes.exitCode === 0 ? undefined : combined.slice(0, 200),
      capabilities: this.capabilities,
      capabilitiesV2: {
        ...capsV2,
        optionDescriptors: passiveDescriptors,
      },
      presentation: this.presentation,
      optionDescriptors: passiveDescriptors,
      models,
      defaultModelId,
      accountSummary,
    };
  }

  async probe(): Promise<HarnessInfo> {
    return this.probePassive();
  }

  /**
   * Queries live codex app-server metadata (models, account, optionally rateLimits/usage/mcp).
   */
  async probeAppServerMetadata(
    binaryPathOverride?: string,
    includeTelemetry = true,
  ): Promise<CodexLiveProbeSnapshot> {
    const binaryPath = binaryPathOverride ?? (await resolveBinary('codex', this.binaryOverride));
    if (!binaryPath) {
      throw new Error('Codex CLI binary not found');
    }

    const child = spawnCliProcess(binaryPath, this.extraArgs, {
      cwd: process.cwd(),
      env: this.buildIsolatedEnv(),
      unsetEnv: this.buildUnsetEnv(),
    });
    const rpc = new StdioJsonRpcClient(child, {
      onNotification: () => {},
      onServerRequest: (req) => rpc.respondError(req.id, -32601, 'Not supported during probe'),
      onDiagnostic: () => {},
      onExit: () => {},
    });

    try {
      await rpc.request(
        'initialize',
        {
          clientInfo: { name: 'harnessmate-probe', version: '0.1.0' },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ['turn/diff/updated'],
          },
        },
        8000,
      );
      rpc.notify('initialized');

      const [modelRes, accountRes] = await Promise.all([
        rpc.request<{ data?: Array<Record<string, unknown>> }>('model/list', {}, 10_000).catch(() => ({ data: [] })),
        rpc
          .request<{ account?: { type?: string; email?: string; planType?: string } }>('account/read', {}, 8000)
          .catch(() => ({ account: undefined })),
      ]);

      let rateLimits: unknown = null;
      let usage: unknown = null;
      let mcpServers: unknown[] = [];

      if (includeTelemetry) {
        const [rlRes, uRes, mcpRes] = await Promise.all([
          rpc.request('account/rateLimits/read', undefined, 8000).catch(() => null),
          rpc.request('account/usage/read', undefined, 8000).catch(() => null),
          rpc
            .request<{ data?: unknown[] }>('mcpServerStatus/list', {}, 8000)
            .catch(() => ({ data: [] })),
        ]);
        rateLimits = rlRes;
        usage = uRes;
        mcpServers = Array.isArray(mcpRes?.data) ? mcpRes.data : [];
      }

      const rawModels = Array.isArray(modelRes?.data) ? modelRes.data : [];
      const models: HarnessModelInfo[] = [];
      let defaultModelId: string | null = null;

      for (const m of rawModels) {
        if (m.hidden === true) continue;
        const id = String(m.id ?? m.model ?? '').trim();
        if (!id) continue;
        const displayName = String(m.displayName ?? id).trim();
        const isDefault = m.isDefault === true;
        if (isDefault && !defaultModelId) defaultModelId = id;

        const rawEfforts = Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts
          : [];
        const supportedEfforts = rawEfforts
          .map((e) =>
            e && typeof e === 'object'
              ? String((e as { reasoningEffort?: string }).reasoningEffort ?? '')
              : String(e ?? ''),
          )
          .filter((e): e is ReasoningEffort => VALID_EFFORTS.has(e as ReasoningEffort));

        const defaultEffortRaw = String(m.defaultReasoningEffort ?? '');
        const defaultEffort = VALID_EFFORTS.has(defaultEffortRaw as ReasoningEffort)
          ? (defaultEffortRaw as ReasoningEffort)
          : undefined;

        models.push({
          id,
          displayName,
          description: typeof m.description === 'string' ? m.description : undefined,
          group: classifyCodexModelGroup(id, displayName, this.modelGroupRules),
          isDefault,
          defaultEffort,
          supportedEfforts: supportedEfforts.length > 0 ? supportedEfforts : undefined,
          inputModalities: Array.isArray(m.inputModalities)
            ? m.inputModalities.map(String)
            : undefined,
        });
      }

      if (!defaultModelId && models.length > 0) {
        defaultModelId = models[0]!.id;
      }

      const snapshot: CodexLiveProbeSnapshot = {
        models,
        defaultModelId,
        account: accountRes?.account ?? null,
        rateLimits,
        usage,
        mcpServers,
      };
      this.cachedLiveProbe = snapshot;
      return snapshot;
    } finally {
      await rpc.dispose();
    }
  }

  async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
    const binaryPath = await resolveBinary('codex', this.binaryOverride);
    if (!binaryPath) {
      throw new Error('Codex CLI binary not found. Please install codex or configure binary path.');
    }

    const store = config.nativeHistoryPath ? getCodexRolloutStore(config.nativeHistoryPath) : undefined;
    const resolvedCodexHome = store?.home ? path.resolve(store.home) : this.codexHome;
    const mcp = config.pluginMcp;
    const prefix = `mcp_servers.${pluginMcpServerName}`;
    const args = mcp ? [...this.extraArgs, '-c', `${prefix}.url=${mcp.url}`,
      '-c', `${prefix}.bearer_token_env_var=${pluginMcpTokenEnv}`, '-c', `${prefix}.startup_timeout_sec=3`] : this.extraArgs;
    const child = spawnCliProcess(binaryPath, args, {
      cwd: config.cwd,
      env: this.buildIsolatedEnv(
        resolvedCodexHome,
        mcp ? { [pluginMcpTokenEnv]: mcp.token } : undefined,
      ),
      unsetEnv: this.buildUnsetEnv(resolvedCodexHome),
    });
    const handle = new CodexSessionHandle(child, config, this.defaultServiceTier);
    try {
      await handle.initialize();
      return handle;
    } catch (err) {
      await handle.dispose();
      throw err;
    }
  }
}

export function classifyCodexModelGroup(
  id: string,
  displayName: string,
  rules?: CodexModelGroupRule[],
): string {
  if (rules) {
    for (const rule of rules) {
      if (id.startsWith(rule.prefix)) return rule.groupLabel;
    }
  }
  if (id.startsWith('auto/') || displayName.toLowerCase().includes('routing group')) {
    return 'Auto Routing';
  }
  if (!id.includes('/')) return 'OpenAI Codex';
  const prefix = id.split('/')[0]!;
  return prefix;
}

export function readCodexConfigDefaultModel(codexHome?: string): string | null {
  const candidates = codexHome?.trim()
    ? [path.join(path.resolve(codexHome.trim()), 'config.toml')]
    : [
        process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'config.toml') : '',
        path.join(os.homedir(), '.codex', 'config.toml'),
      ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const m = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (m?.[1]) return m[1];
    } catch {
      // ignore
    }
  }
  return null;
}

function readCodexAuthSummary(codexHome?: string): string | null {
  const candidates = codexHome?.trim()
    ? [path.join(path.resolve(codexHome.trim()), 'auth.json')]
    : [
        process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : '',
        path.join(os.homedir(), '.codex', 'auth.json'),
      ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        email?: string;
        auth_mode?: string;
        planType?: string;
        plan_type?: string;
        OPENAI_API_KEY?: string;
      };
      if (raw.email) {
        const plan = raw.planType ?? raw.plan_type;
        return `${raw.email}${plan ? ` · ${plan}` : ''}`;
      }
      if (raw.auth_mode) return raw.auth_mode;
      if (raw.OPENAI_API_KEY) return 'API Key';
    } catch {
      // ignore
    }
  }
  return null;
}

function formatCodexAccountSummary(account: CodexLiveProbeSnapshot['account']): string | null {
  if (!account) return null;
  if (account.email) {
    return `${account.email}${account.planType ? ` · ${account.planType}` : ''}`;
  }
  if (account.type) {
    return `${account.type}${account.planType ? ` · ${account.planType}` : ''}`;
  }
  return null;
}

export function classifyCodexError(message: string, rawCode?: unknown): CodexErrorCode {
  const combined = `${rawCode !== undefined ? String(rawCode) : ''} ${message}`.toLowerCase();
  if (
    combined.includes('invalid_encrypted_content') ||
    combined.includes('encrypted_content') ||
    /corrupt.*encrypted|invalid.*encrypted/i.test(combined)
  ) {
    return 'invalid_encrypted_content';
  }
  if (
    combined.includes('e_native_thread_in_use') ||
    combined.includes('native_thread_in_use') ||
    /thread.*in use|rollout.*locked|already locked/i.test(combined)
  ) {
    return 'native_thread_in_use';
  }
  if (
    combined.includes('usage_limit') ||
    combined.includes('insufficient_quota') ||
    /rate.?limit|usage.?limit|quota|429/i.test(combined)
  ) {
    return 'usage_limit';
  }
  return 'provider_error';
}

export function normalizeCodexPatchDiff(patch: string, filePath?: string): string {
  const normalized = patch.replace(/\r\n/g, '\n');
  if (!normalized.trim()) return patch;
  if (/^diff --git\s+/m.test(normalized)) {
    // Ensure every `--- a/...` section in a multi-file patch has a `diff --git` header
    const lines = normalized.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const prev = out.at(-1) ?? '';
      if (line.startsWith('--- a/') && !prev.startsWith('diff --git ') && !prev.startsWith('index ')) {
        const p = line.slice('--- a/'.length).trim();
        if (p) out.push(`diff --git a/${p} b/${p}`);
      }
      out.push(line);
    }
    return out.join('\n');
  }

  const lines = normalized.split('\n');
  const out: string[] = [];
  let insertedAny = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      const rawA = line.slice(4).trim().replace(/^a\//, '');
      const rawB = next.startsWith('+++ ') ? next.slice(4).trim().replace(/^b\//, '') : rawA;
      const target = (rawB && rawB !== '/dev/null' ? rawB : rawA) || filePath?.replace(/\\/g, '/') || 'file';
      out.push(`diff --git a/${target} b/${target}`);
      insertedAny = true;
    }
    out.push(line);
  }
  if (!insertedAny && filePath) {
    const clean = filePath.replace(/\\/g, '/').replace(/^a\//, '');
    return `diff --git a/${clean} b/${clean}\n--- a/${clean}\n+++ b/${clean}\n${normalized}`;
  }
  return out.join('\n');
}

interface PendingCodexApproval {
  rpcId: string | number;
  method: string;
}

interface CodexGoalResult {
  goal?: { objective: string; status: string; tokensUsed?: number; tokenBudget?: number | null };
}

export class CodexSessionHandle implements AdapterSessionHandle {
  private readonly listeners = new Set<(event: NormalizedAdapterEvent) => void>();
  private readonly earlyBuffer: NormalizedAdapterEvent[] = [];
  private readonly rpc: StdioJsonRpcClient;
  private readonly pendingApprovals = new Map<string, PendingCodexApproval>();
  private readonly activeBackgroundProcessIds = new Map<string, string>();
  private _nativeSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private currentNativeTurnId: string | null = null;
  private pendingEarlyInterrupt = false;
  private activeModel: string | null = null;
  private confirmedSessionModel: string | null = null;
  private usedPlanMode = false;
  private activeEffort: ReasoningEffort | null = null;
  private activePermissionMode: PermissionMode;
  private activeServiceTier: 'default' | 'fast';
  private assistantAccum = '';
  private thinkingAccum = '';

  constructor(
    child: ReturnType<typeof spawnCliProcess>,
    private readonly config: AdapterSessionConfig,
    defaultServiceTier: 'default' | 'fast' = 'default',
  ) {
    this.activeModel = config.model ?? null;
    this.activeEffort = config.reasoningEffort ?? null;
    this.activePermissionMode = config.permissionMode;
    this.activeServiceTier = defaultServiceTier;

    this.rpc = new StdioJsonRpcClient(child, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (req) => this.handleServerRequest(req),
      onDiagnostic: (stream, message) =>
        this.emit({ type: 'diagnostic.log', level: 'info', stream, message }),
      onExit: (code, signal) => {
        if (this.currentTurnId) {
          const message = `Codex app-server exited unexpectedly (code=${code}, signal=${signal})`;
          this.emit({
            type: 'turn.failed',
            turnId: this.currentTurnId,
            message,
            code: classifyCodexError(message),
          });
          this.currentTurnId = null;
          this.currentNativeTurnId = null;
          this.pendingEarlyInterrupt = false;
        }
      },
    });
  }

  get nativeSessionId(): string | null {
    return this._nativeSessionId;
  }

  get pluginMcpAvailable(): boolean { return Boolean(this.config.pluginMcp); }

  async initialize(): Promise<void> {
    await this.rpc.request('initialize', {
      clientInfo: { name: 'harnessmate-desktop', version: '0.3.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['turn/diff/updated'],
      },
    });
    this.rpc.notify('initialized');

    const { approvalPolicy, sandbox } = mapPermissionModeToCodex(this.activePermissionMode);

    let resumedOk = false;
    if (this.config.nativeSessionId) {
      try {
        const resumed = (await this.rpc.request('thread/resume', {
          threadId: this.config.nativeSessionId,
          cwd: this.config.cwd,
          excludeTurns: true,
          ...(this.config.nativeHistoryPath && getCodexRolloutStore(this.config.nativeHistoryPath)?.archived
            && fs.existsSync(this.config.nativeHistoryPath) ? { path: this.config.nativeHistoryPath } : {}),
          model: this.activeModel,
          approvalPolicy,
          sandbox,
        })) as { thread?: { id?: string; model?: string }; threadId?: string; model?: string };
        this._nativeSessionId = resumed?.thread?.id ?? resumed?.threadId ?? this.config.nativeSessionId;
        const confirmedModel = resumed?.model ?? resumed?.thread?.model ?? this.activeModel;
        this.confirmedSessionModel = confirmedModel;
        if (confirmedModel) {
          this.emit({ type: 'model.confirmed', actualModel: confirmedModel });
        }
        resumedOk = true;
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const errCode = err instanceof JsonRpcResponseError ? err.code : undefined;
        const classified = classifyCodexError(errMessage, errCode);
        if (classified === 'native_thread_in_use') {
          const lockErr = new Error(`E_NATIVE_THREAD_IN_USE: ${errMessage}`) as Error & { code?: string };
          lockErr.code = 'E_NATIVE_THREAD_IN_USE';
          throw lockErr;
        }
        if (this.config.requireNativeResume) {
          if (err instanceof Error) {
            (err as Error & { code?: string }).code ??= classified;
          }
          throw err;
        }
        this.emit({
          type: 'diagnostic.log',
          level: 'warn',
          stream: 'protocol',
          message: `Codex thread/resume fallback to thread/start: ${errMessage}`,
        });
      }
    }

    if (!resumedOk) {
      const startParams: Record<string, unknown> = {
        cwd: this.config.cwd,
        model: this.activeModel,
        approvalPolicy,
        sandbox,
      };
      if (this.activeServiceTier !== 'default') {
        startParams.serviceTier = this.activeServiceTier;
      }
      if (this.config.handoffContinuity) {
        startParams.developerInstructions = handoffContinuityNotice;
        this.config.onContinuityNotice?.('developer_instructions', handoffContinuityNotice);
      }
      const started = (await this.rpc.request('thread/start', startParams)) as {
        thread?: { id?: string; model?: string };
        threadId?: string;
        model?: string;
      };
      this._nativeSessionId = started?.thread?.id ?? started?.threadId ?? null;
      const confirmedModel = started?.model ?? started?.thread?.model ?? this.activeModel;
      this.confirmedSessionModel = confirmedModel;
      if (confirmedModel) {
        this.emit({ type: 'model.confirmed', actualModel: confirmedModel });
      }
    }

    if (this._nativeSessionId) {
      this.emit({ type: 'native_session_ready', nativeSessionId: this._nativeSessionId });
    }
  }

  async injectContext(payload: import('./types.js').ContextSyncPayload): Promise<import('@harnessmate/protocol').ContextInjectionDriver> {
    if (!this._nativeSessionId || payload.portableItems.length === 0) {
      return 'prompt_envelope';
    }
    payload.onDispatch?.('codex_inject_items', payload.portableItems);
    try {
      await this.rpc.request(
        'thread/inject_items',
        {
          threadId: this._nativeSessionId,
          items: payload.portableItems,
        },
        10_000,
      );
      this.emit({
        type: 'diagnostic.log',
        level: 'info',
        stream: 'protocol',
        message: `Codex native thread/inject_items succeeded (${payload.portableItems.length} items)`,
      });
      return 'codex_inject_items';
    } catch (err) {
      this.emit({
        type: 'diagnostic.log',
        level: 'warn',
        stream: 'protocol',
        message: `Codex thread/inject_items unavailable, falling back to envelope: ${err instanceof Error ? err.message : String(err)}`,
      });
      return 'prompt_envelope';
    }
  }

  async listSkills(): Promise<NativeSkill[]> {
    const result = await this.rpc.request<{ data?: Array<{ skills?: NativeSkill[] }> }>(
      'skills/list', { cwds: [this.config.cwd], forceReload: true }, 15_000);
    return (result.data ?? []).flatMap((entry) => entry.skills ?? []);
  }

  async steerTurn(input: string | { text: string; turnId?: string }): Promise<void> {
    const threadId = this._nativeSessionId;
    if (!threadId) throw new Error('Codex thread is not initialized');
    const text = typeof input === 'string' ? input : input.text;
    const nativeTurnId = (typeof input === 'object' ? input.turnId : undefined) ?? this.currentNativeTurnId;
    if (!nativeTurnId) throw new Error('No active Codex turn to steer');
    await this.rpc.request(
      'turn/steer',
      {
        threadId,
        turnId: nativeTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
      },
      15_000,
    );
  }

  async forkNativeSession(): Promise<{ nativeSessionId: string }> {
    const threadId = this._nativeSessionId;
    if (!threadId) throw new Error('Codex thread is not initialized');
    const result = (await this.rpc.request(
      'thread/fork',
      { threadId, cwd: this.config.cwd },
      15_000,
    )) as { thread?: { id?: string }; threadId?: string };
    const forkedId = result?.thread?.id ?? result?.threadId;
    if (!forkedId) {
      throw new Error('Codex thread/fork did not return a new thread ID');
    }
    return { nativeSessionId: forkedId };
  }

  forkThread(): Promise<{ nativeSessionId: string }> {
    return this.forkNativeSession();
  }

  async rollbackNativeSession(numTurns = 1): Promise<void> {
    const threadId = this._nativeSessionId;
    if (!threadId) throw new Error('Codex thread is not initialized');
    await this.rpc.request(
      'thread/rollback',
      { threadId, numTurns: Math.max(1, numTurns) },
      15_000,
    );
  }

  rollbackThread(numTurns = 1): Promise<void> {
    return this.rollbackNativeSession(numTurns);
  }

  setServiceTier(tier: 'default' | 'fast'): void {
    this.activeServiceTier = tier;
  }

  async runNativeCommand(command: string, args: string): Promise<string> {
    const threadId = this._nativeSessionId;
    if (!threadId) throw new Error('Codex thread is not initialized');
    switch (command) {
      case 'compact': {
        await this.rpc.request('thread/compact/start', { threadId }, 20_000);
        return 'Started Codex thread compaction';
      }
      case 'skills': {
        const skills = await this.listSkills();
        return skills.map((s) => (s.description ? `${s.name}: ${s.description}` : s.name)).join('\n') || 'No skills available';
      }
      case 'steer': {
        await this.steerTurn(args);
        return 'Steered active Codex turn';
      }
      case 'fork': {
        const forked = await this.forkNativeSession();
        return forked.nativeSessionId;
      }
      case 'rollback': {
        const parsed = Number.parseInt(args.trim() || '1', 10);
        const numTurns = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        await this.rollbackNativeSession(numTurns);
        return `Rolled back ${numTurns} turn(s)`;
      }
      case 'goal': {
        if (args === 'clear') {
          await this.rpc.request('thread/goal/clear', { threadId }, 15_000);
          return '已清除 Codex 目标';
        }
        const result = !args || args === 'status'
          ? await this.rpc.request<CodexGoalResult>('thread/goal/get', { threadId }, 15_000)
          : await this.rpc.request<CodexGoalResult>('thread/goal/set', {
              threadId,
              ...(args === 'pause' ? { status: 'paused' }
                : args === 'resume' ? { status: 'active' }
                  : { objective: args, status: 'active' }),
            }, 15_000);
        if (!result.goal) return '当前没有 Codex 目标';
        const { objective, status, tokensUsed, tokenBudget } = result.goal;
        return `${objective}\n状态 ${status}${tokensUsed !== undefined ? ` · ${tokensUsed}${tokenBudget ? ` / ${tokenBudget}` : ''} tokens` : ''}`;
      }
      default:
        throw new Error(`Unsupported Codex native command: ${command}`);
    }
  }

  async updateConfig(patch: Partial<AdapterSessionConfig> & { serviceTier?: 'default' | 'fast' }): Promise<void> {
    if (patch.model !== undefined) this.activeModel = patch.model;
    if (patch.reasoningEffort !== undefined) this.activeEffort = patch.reasoningEffort;
    if (patch.permissionMode !== undefined) this.activePermissionMode = patch.permissionMode;
    if (patch.serviceTier !== undefined) this.activeServiceTier = patch.serviceTier;
  }

  async sendTurn(input: TurnInput): Promise<{ driverUsed?: import('@harnessmate/protocol').ContextInjectionDriver }> {
    if (!this._nativeSessionId) {
      throw new Error('Codex thread is not initialized');
    }
    this.pendingEarlyInterrupt = false;
    if (input.cliCommand === '/compact') {
      this.currentTurnId = input.turnId;
      this.currentNativeTurnId = null;
      this.assistantAccum = '';
      this.thinkingAccum = '';
      try {
        await this.rpc.request('thread/compact/start', { threadId: this._nativeSessionId }, 20_000);
      } catch (err) {
        this.currentTurnId = null;
        this.currentNativeTurnId = null;
        throw err;
      }
      return {};
    }
    this.currentNativeTurnId = null;
    this.assistantAccum = '';
    this.thinkingAccum = '';
    this.emit({ type: 'turn.started', turnId: input.turnId });

    const effectiveModel = input.model !== undefined ? input.model : this.activeModel;
    const effectiveEffort =
      input.reasoningEffort !== undefined ? input.reasoningEffort : this.activeEffort;
    const effectiveMode = input.permissionMode ?? this.activePermissionMode;

    const skillInput = input.nativeSkill;
    const basePromptText = buildPromptWithFileAttachments(
      skillInput ? `$${skillInput.name} ${input.text}`.trim() : input.text, input.attachments);
    const promptText = input.contextSync
      ? `${input.contextSync.deltaMarkdown}\n\n---\n\n${basePromptText}`
      : basePromptText;
    const userInput: Array<Record<string, unknown>> = [
      { type: 'text', text: promptText, text_elements: [] },
    ];
    if (skillInput) userInput.push({ type: 'skill', ...skillInput });
    for (const att of input.attachments ?? []) {
      if (att.kind === 'image' && att.path) {
        userInput.push({ type: 'localImage', path: att.path });
      } else if (att.kind === 'file_ref' && att.path) {
        userInput.push({ type: 'mention', name: att.name, path: att.path });
      }
    }

    const { approvalPolicy, sandbox } = mapPermissionModeToCodex(effectiveMode);

    const turnParams: Record<string, unknown> = {
      threadId: this._nativeSessionId,
      input: userInput,
      cwd: this.config.cwd,
      approvalPolicy,
    };
    if (effectiveModel) turnParams.model = effectiveModel;
    if (effectiveEffort && effectiveEffort !== 'disabled') turnParams.effort = effectiveEffort;
    if (this.activeServiceTier !== 'default') turnParams.serviceTier = this.activeServiceTier;
    if (effectiveMode === 'plan' || this.usedPlanMode) {
      turnParams.sandboxPolicy = { type: sandbox === 'read-only' ? 'readOnly'
        : sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' };
      const mode = effectiveMode === 'plan' ? 'plan' : 'default';
      const result = await this.rpc.request<{ data?: Array<{
        mode: string; model?: string | null; reasoning_effort?: string | null;
      }> }>('collaborationMode/list', {}, 12_000);
      const preset = result.data?.find((entry) => entry.mode === mode);
      const model = effectiveModel || preset?.model || this.confirmedSessionModel;
      if (!model) throw new Error('无法确定 Codex 模型，请先使用 /model 选择模型');
      turnParams.collaborationMode = {
        mode,
        settings: {
          model,
          reasoning_effort: effectiveEffort && effectiveEffort !== 'disabled' ? effectiveEffort : preset?.reasoning_effort ?? null,
          developer_instructions: null,
        },
      };
    }

    this.currentTurnId = input.turnId;
    let res: { turn?: { id?: string; model?: string }; turnId?: string } | undefined;
    try {
      if (input.contextSync) input.contextSync.onDispatch?.('prompt_envelope', input.contextSync.deltaMarkdown);
      res = await this.rpc.request('turn/start', turnParams);
    } catch (err) {
      this.currentTurnId = null;
      this.currentNativeTurnId = null;
      this.pendingEarlyInterrupt = false;
      if (err instanceof Error) {
        const rawCode = err instanceof JsonRpcResponseError ? err.code : undefined;
        (err as Error & { code?: string }).code ??= classifyCodexError(err.message, rawCode);
      }
      throw err;
    }
    const returnedTurnId = res?.turn?.id ?? res?.turnId;
    if (returnedTurnId) {
      this.currentNativeTurnId = returnedTurnId;
    }
    if (this.pendingEarlyInterrupt && this.currentNativeTurnId) {
      this.pendingEarlyInterrupt = false;
      await this.dispatchTurnInterrupt(this.currentNativeTurnId);
      return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
    }
    this.usedPlanMode = effectiveMode === 'plan';
    const confirmed = res?.turn?.model ?? effectiveModel;
    if (confirmed) {
      this.emit({ type: 'model.confirmed', actualModel: confirmed });
    }
    return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
  }

  private async dispatchTurnInterrupt(nativeTurnId: string): Promise<void> {
    if (!this._nativeSessionId) return;
    const processIds = Array.from(new Set(this.activeBackgroundProcessIds.values()));
    await Promise.all([
      this.rpc
        .request('turn/interrupt', { threadId: this._nativeSessionId, turnId: nativeTurnId }, 5000)
        .catch((err) => {
          this.emit({
            type: 'diagnostic.log',
            level: 'warn',
            stream: 'protocol',
            message: `turn/interrupt error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }),
      this.rpc
        .request(
          'thread/backgroundTerminals/terminate',
          {
            threadId: this._nativeSessionId,
            ...(processIds.length > 0 ? { processIds } : {}),
          },
          1500,
        )
        .catch(() => {}),
    ]);
  }

  async interrupt(): Promise<void> {
    if (!this._nativeSessionId) return;
    if (this.currentNativeTurnId) {
      await this.dispatchTurnInterrupt(this.currentNativeTurnId);
    } else if (this.currentTurnId) {
      this.pendingEarlyInterrupt = true;
      const processIds = Array.from(new Set(this.activeBackgroundProcessIds.values()));
      if (processIds.length > 0) {
        this.rpc
          .request(
            'thread/backgroundTerminals/terminate',
            { threadId: this._nativeSessionId, processIds },
            1500,
          )
          .catch(() => {});
      }
    }
    if (this.currentTurnId) {
      const cancelledId = this.currentTurnId;
      this.currentTurnId = null;
      this.emit({ type: 'turn.cancelled', turnId: cancelledId });
    }
  }

  async resolveApproval(nativeRequestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(nativeRequestId);
    if (!pending) return;
    this.pendingApprovals.delete(nativeRequestId);

    const codexDecision =
      decision === 'allow_once'
        ? 'accept'
        : decision === 'allow_session'
          ? 'acceptForSession'
          : 'decline';

    this.rpc.respond(pending.rpcId, { decision: codexDecision });
  }

  async dispose(): Promise<void> {
    this.pendingApprovals.clear();
    this.activeBackgroundProcessIds.clear();
    this.pendingEarlyInterrupt = false;
    await this.rpc.dispose();
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

  private emit(event: NormalizedAdapterEvent): void {
    if (this.listeners.size === 0) {
      this.earlyBuffer.push(event);
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private handleServerRequest(req: JsonRpcServerRequest): void {
    const turnId = this.currentTurnId ?? 'turn_unknown';
    const nativeRequestId = `codex_req_${String(req.id)}`;
    const params = (req.params ?? {}) as Record<string, unknown>;

    if (
      req.method === 'item/commandExecution/requestApproval' ||
      req.method === 'execCommandApproval'
    ) {
      const cmd =
        (typeof params.command === 'string'
          ? params.command
          : Array.isArray(params.command)
            ? params.command.join(' ')
            : undefined) ??
        (typeof params.parsedCmd === 'string' ? params.parsedCmd : 'Shell command');

      this.pendingApprovals.set(nativeRequestId, { rpcId: req.id, method: req.method });
      this.emit({
        type: 'approval.requested',
        turnId,
        nativeRequestId,
        toolName: 'CommandExecution',
        toolKind: 'shell',
        summary: `Run shell command: ${cmd}`,
        input: params,
        riskLevel: classifyCommandRisk(cmd),
      });
      return;
    }

    if (
      req.method === 'item/fileChange/requestApproval' ||
      req.method === 'applyPatchApproval'
    ) {
      const reason = typeof params.reason === 'string' ? params.reason : 'Modify workspace files';
      const rawPatch = typeof params.patch === 'string' ? params.patch : undefined;
      const diffPreview = rawPatch
        ? normalizeCodexPatchDiff(rawPatch, typeof params.path === 'string' ? params.path : undefined)
        : undefined;
      this.pendingApprovals.set(nativeRequestId, { rpcId: req.id, method: req.method });
      this.emit({
        type: 'approval.requested',
        turnId,
        nativeRequestId,
        toolName: 'FileChange',
        toolKind: 'file_edit',
        summary: reason,
        input: params,
        diffPreview,
        riskLevel: 'medium',
      });
      return;
    }

    if (req.method === 'item/permissions/requestApproval') {
      this.pendingApprovals.set(nativeRequestId, { rpcId: req.id, method: req.method });
      this.emit({
        type: 'approval.requested',
        turnId,
        nativeRequestId,
        toolName: 'Permissions',
        toolKind: 'other',
        summary: typeof params.reason === 'string' ? params.reason : 'Additional permissions requested',
        input: params,
        riskLevel: 'high',
      });
      return;
    }

    this.emit({
      type: 'diagnostic.log',
      level: 'warn',
      stream: 'protocol',
      message: `Unhandled Codex server request: ${req.method}`,
    });
    this.rpc.respondError(req.id, -32601, `Unsupported client method: ${req.method}`);
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const turnId = this.currentTurnId ?? 'turn_bg';

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string; model?: string } | undefined;
        if (thread?.id && !this._nativeSessionId) {
          this._nativeSessionId = thread.id;
          this.emit({ type: 'native_session_ready', nativeSessionId: thread.id });
        }
        const m = typeof params.model === 'string' ? params.model : thread?.model;
        if (m) this.emit({ type: 'model.confirmed', actualModel: m });
        break;
      }

      case 'model/rerouted': {
        const toModel = String(params.toModel ?? params.to_model ?? '');
        const fromModel = String(params.fromModel ?? params.from_model ?? '');
        const reason = String(params.reason ?? 'Model rerouted by Codex');
        if (toModel) {
          this.confirmedSessionModel = toModel;
          this.emit({
            type: 'model.confirmed',
            actualModel: toModel,
            reroutedFrom: fromModel || undefined,
            reason,
          });
          this.emit({
            type: 'diagnostic.log',
            level: 'warn',
            stream: 'protocol',
            message: `Codex rerouted model ${fromModel} -> ${toModel}: ${reason}`,
          });
        }
        break;
      }

      case 'turn/started': {
        const turn = params.turn as { id?: string } | undefined;
        if (!turn?.id) break;
        this.currentNativeTurnId = turn.id;
        if (this.pendingEarlyInterrupt) {
          this.pendingEarlyInterrupt = false;
          void this.dispatchTurnInterrupt(turn.id);
          break;
        }
        if (!this.currentTurnId && params.threadId === this._nativeSessionId) {
          this.currentTurnId = `codex_${turn.id}`;
          this.assistantAccum = '';
          this.thinkingAccum = '';
          this.emit({ type: 'turn.started', turnId: this.currentTurnId, continuation: true });
        }
        break;
      }

      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) {
          this.assistantAccum += delta;
          this.emit({
            type: 'message.assistant.delta',
            turnId,
            text: delta,
            messageId: typeof params.itemId === 'string' ? params.itemId : undefined,
          });
        }
        break;
      }

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) {
          this.thinkingAccum += delta;
          this.emit({ type: 'thinking.delta', turnId, text: delta });
        }
        break;
      }

      case 'item/started': {
        const item = (params.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? '');
        const itemId = String(item.id ?? `item_${Date.now()}`);
        if (itemType === 'commandExecution') {
          const processId = item.processId ?? item.process_id;
          if (typeof processId === 'string' || typeof processId === 'number') {
            this.activeBackgroundProcessIds.set(itemId, String(processId));
          }
          const cmd =
            typeof item.command === 'string'
              ? item.command
              : Array.isArray(item.command)
                ? item.command.join(' ')
                : 'Shell command';
          this.emit({
            type: 'tool.call.started',
            turnId,
            toolCallId: itemId,
            toolName: 'CommandExecution',
            toolKind: 'shell',
            summary: cmd,
            input: item,
          });
        } else if (itemType === 'fileChange') {
          this.emit({
            type: 'tool.call.started',
            turnId,
            toolCallId: itemId,
            toolName: 'FileChange',
            toolKind: 'file_edit',
            summary: summarizeFileChange(item),
            input: item,
          });
        } else if (itemType === 'mcpToolCall' || itemType === 'webSearch') {
          const toolName = String(item.tool ?? item.name ?? itemType);
          const toolKind: ToolKind = itemType === 'webSearch' ? 'web' : 'mcp';
          this.emit({
            type: 'tool.call.started',
            turnId,
            toolCallId: itemId,
            toolName,
            toolKind,
            summary: `${toolName}`,
            input: item,
          });
        }
        break;
      }

      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const itemId = String(params.itemId ?? '');
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (itemId && delta) {
          this.emit({
            type: 'tool.call.delta',
            turnId,
            toolCallId: itemId,
            outputDelta: delta,
          });
        }
        break;
      }

      case 'item/fileChange/patchUpdated': {
        const itemId = String(params.itemId ?? '');
        const rawPatch = typeof params.patch === 'string' ? params.patch : '';
        if (itemId && rawPatch) {
          const filePath = typeof params.path === 'string' ? params.path : undefined;
          this.emit({
            type: 'tool.call.delta',
            turnId,
            toolCallId: itemId,
            outputDelta: '',
            diffDelta: normalizeCodexPatchDiff(rawPatch, filePath),
          });
        }
        break;
      }

      case 'item/completed': {
        const item = (params.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? '');
        const itemId = String(item.id ?? '');
        if (itemType === 'commandExecution' && itemId) {
          this.activeBackgroundProcessIds.delete(itemId);
        }
        if (itemType === 'agentMessage') {
          const text = typeof item.text === 'string' ? item.text : this.assistantAccum;
          this.emit({
            type: 'message.assistant.completed',
            turnId,
            text,
            messageId: itemId || undefined,
          });
        } else if (itemType === 'reasoning' && this.thinkingAccum) {
          this.emit({ type: 'thinking.completed', turnId, text: this.thinkingAccum });
        } else if (
          itemType === 'commandExecution' ||
          itemType === 'fileChange' ||
          itemType === 'mcpToolCall' ||
          itemType === 'webSearch'
        ) {
          const statusRaw = String(item.status ?? 'completed');
          const mcpResult = itemType === 'mcpToolCall' ? item.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined : undefined;
          const status =
            statusRaw === 'failed' || statusRaw === 'declined' || mcpResult?.isError
              ? 'error'
              : statusRaw === 'cancelled'
                ? 'cancelled'
                : 'success';
          const output =
            typeof item.aggregatedOutput === 'string'
              ? item.aggregatedOutput
              : typeof item.output === 'string'
                ? item.output
                : mcpResult?.content?.filter(({ type }) => type === 'text').map(({ text }) => text ?? '').join('\n');
          const rawDiff = typeof item.patch === 'string' ? item.patch : undefined;
          const diff = rawDiff ? normalizeCodexPatchDiff(rawDiff) : undefined;
          this.emit({
            type: 'tool.call.completed',
            turnId,
            toolCallId: itemId,
            toolName: String(item.tool ?? itemType),
            status,
            output,
            ...(diff ? { diff } : {}),
          });
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const usage = (params.tokenUsage ?? params.usage ?? params) as Record<string, unknown>;
        const last = (usage.last ?? usage.total ?? usage) as Record<string, unknown>;
        const inputTokens = Number(last.inputTokens ?? last.input_tokens ?? 0);
        const outputTokens = Number(last.outputTokens ?? last.output_tokens ?? 0);
        const cachedInputTokens = Number(last.cachedInputTokens ?? last.cached_input_tokens ?? 0) || undefined;
        const reasoningOutputTokens =
          Number(last.reasoningOutputTokens ?? last.reasoning_output_tokens ?? 0) || undefined;
        const totalTokens = Number(last.totalTokens ?? last.total_tokens ?? 0) || undefined;
        const rawWindow =
          usage.modelContextWindow ??
          usage.model_context_window ??
          last.modelContextWindow ??
          last.model_context_window ??
          params.modelContextWindow;
        const modelContextWindow = typeof rawWindow === 'number' && rawWindow > 0 ? rawWindow : undefined;

        this.emit({
          type: 'usage.updated',
          turnId: this.currentTurnId,
          usage: {
            inputTokens,
            outputTokens,
            cachedTokens: cachedInputTokens,
          },
        });

        if (modelContextWindow !== undefined || reasoningOutputTokens !== undefined || cachedInputTokens !== undefined) {
          const summaryParts: string[] = [];
          if (modelContextWindow !== undefined) summaryParts.push(`window=${modelContextWindow}`);
          if (cachedInputTokens !== undefined) summaryParts.push(`cached=${cachedInputTokens}`);
          if (reasoningOutputTokens !== undefined) summaryParts.push(`reasoning=${reasoningOutputTokens}`);
          this.emit({
            type: 'turn_block.ext',
            turnId,
            itemId: `codex_ctx_${turnId}`,
            blockType: 'ext:codex.context_telemetry',
            title: 'Codex Context Telemetry',
            fallbackSummary: summaryParts.join(', ') || 'Codex token telemetry',
            status: 'completed',
            payload: {
              inputTokens,
              outputTokens,
              ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
              ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
              ...(totalTokens !== undefined ? { totalTokens } : {}),
              ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
            },
          });
        }
        break;
      }

      case 'turn/completed': {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        const status = String(turn.status ?? 'completed');
        const activeTurnId = this.currentTurnId;
        this.currentTurnId = null;
        this.currentNativeTurnId = null;
        this.pendingEarlyInterrupt = false;
        this.activeBackgroundProcessIds.clear();
        if (!activeTurnId) break;

        if (status === 'interrupted' || status === 'cancelled') {
          this.emit({ type: 'turn.cancelled', turnId: activeTurnId });
        } else if (status === 'failed') {
          const turnErr = (turn.error ?? {}) as { message?: string; code?: unknown; codexErrorInfo?: unknown };
          const errMsg =
            typeof turnErr.message === 'string' ? turnErr.message : 'Codex turn failed';
          const rawCode = turnErr.code ?? turnErr.codexErrorInfo;
          this.emit({
            type: 'turn.failed',
            turnId: activeTurnId,
            message: errMsg,
            code: classifyCodexError(errMsg, rawCode),
          });
        } else {
          this.emit({ type: 'turn.completed', turnId: activeTurnId, stopReason: status });
        }
        break;
      }

      case 'error': {
        const errObj = (params.error ?? params) as { message?: string; code?: unknown; codexErrorInfo?: unknown };
        const message = errObj.message ?? 'Unknown Codex error';
        const classified = classifyCodexError(message, errObj.code ?? errObj.codexErrorInfo);
        this.emit({
          type: 'diagnostic.log',
          level: 'error',
          stream: 'protocol',
          message: `[${classified}] ${message}`,
        });
        break;
      }

      default:
        break;
    }
  }
}

export function buildPromptWithFileAttachments(text: string, attachments?: Attachment[]): string {
  const fileRefs = (attachments ?? []).filter((a) => a.kind === 'file_ref' && (a.path || a.relativePath));
  if (fileRefs.length === 0) return text;
  const header = fileRefs
    .map((f) => `[Attached file: ${f.relativePath || f.path}]`)
    .join('\n');
  return `${header}\n\n${text}`;
}

function mapPermissionModeToCodex(mode: PermissionMode): {
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
} {
  switch (mode) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'manual':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'accept_edits':
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

function summarizeFileChange(item: Record<string, unknown>): string {
  const changes = item.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    const paths = changes
      .map((c) => (c && typeof c === 'object' ? String((c as { path?: string }).path ?? '') : ''))
      .filter(Boolean);
    if (paths.length > 0) {
      return `Edit ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` (+${paths.length - 3})` : ''}`;
    }
  }
  return 'Modify files';
}

function classifyCommandRisk(cmd: string): RiskLevel {
  if (/\b(rm\s+-rf|del\s+\/s|format|shutdown|git\s+push\s+--force|git\s+reset\s+--hard|drop\s+table)\b/i.test(cmd)) {
    return 'high';
  }
  if (/\b(git\s+status|git\s+diff|ls|dir|cat|type|head|tail|rg|grep|pwd)\b/i.test(cmd)) {
    return 'low';
  }
  return 'medium';
}
