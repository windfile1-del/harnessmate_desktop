import fs from 'node:fs';
import type {
  ApprovalDecision,
  DiscoveredCliSession,
  HarnessCapabilities,
  HarnessCapabilitiesV2,
  HarnessDriverId,
  HarnessInfo,
  HarnessKind,
  HarnessModelInfo,
  HarnessPresentationMeta,
  PermissionMode,
  ProviderOptionDescriptor,
  ReasoningEffort,
  RiskLevel,
  ToolKind,
} from '@harnessmate/protocol';
import { buildPromptWithFileAttachments } from '../codex-adapter.js';
import type { HistoryMessage } from '../history-scanner.js';
import { JsonRpcResponseError, StdioJsonRpcClient, type JsonRpcServerRequest } from '../jsonrpc.js';
import { DEFAULT_STRIP_ENV_KEYS, execCliQuick, resolveBinary, spawnCliProcess } from '../process.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  AdapterUsageLimitResult,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../types.js';
import { pluginMcpServerName } from '../types.js';
import { pluginMcpStdioConfig } from '../plugin-mcp-stdio.js';

export type AcpFlavor = 'strict_acp' | (string & {});

const flavorPolicyFactories = new Map<string, () => AcpFlavorPolicy>();

/**
 * Registers a policy factory for a custom ACP dialect (by flavor or driver key)
 * without coupling the core strict-ACP engine to vendor-specific logic.
 */
export function registerAcpFlavorPolicyFactory(
  key: string,
  factory: () => AcpFlavorPolicy,
): void {
  flavorPolicyFactories.set(key, factory);
}

export interface AcpAdapterOptions {
  id: string;
  kind: HarnessKind;
  displayName: string;
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  unsetEnv?: readonly string[];
  binaryOverride?: string;
  isCustom?: boolean;
  flavor?: AcpFlavor;
  flavorPolicy?: AcpFlavorPolicy;
  driverId?: HarnessDriverId;
  continuationKey?: string;
  registryAgentId?: string;
  appDataDir?: string;
  authMethodId?: string;
  authenticateEagerly?: boolean;
  sessionLoadReplayIdleMs?: number;
  envWhitelist?: Record<string, string>;
  presentation?: Partial<HarnessPresentationMeta>;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
  _meta?: Record<string, unknown>;
}

export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

export interface AcpSessionNewResult {
  sessionId?: string;
  models?: {
    currentModelId?: string;
    availableModels?: Array<{ modelId: string; name?: string }>;
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{ id: string; name?: string }>;
  };
  configOptions?: AcpConfigOption[];
  _meta?: Record<string, unknown>;
}

export interface AcpLiveProbeSnapshot {
  models: HarnessModelInfo[];
  defaultModelId: string | null;
  tierName: string | null;
  serverVersion: string | null;
  configOptions?: AcpConfigOption[];
}

const VALID_ACP_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_SESSION_LOAD_REPLAY_IDLE_MS = 2000;
const RESERVED_ENV_SET = new Set<string>(DEFAULT_STRIP_ENV_KEYS);

export function isAcpAuthRequiredError(err: unknown): boolean {
  if (err instanceof JsonRpcResponseError && err.code === -32000) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /auth.?required|unauthenticated|authentication required|not authenticated|login required/i.test(
    msg,
  );
}

export function mapAcpConfigOptionsToDescriptors(
  configOptions: readonly AcpConfigOption[],
): ProviderOptionDescriptor[] {
  const descriptors: ProviderOptionDescriptor[] = [];
  for (const opt of configOptions) {
    const key = opt.id?.trim();
    if (!key) continue;
    const label = opt.name?.trim() || key;
    if (opt.type === 'boolean') {
      descriptors.push({
        key,
        label,
        kind: 'boolean',
        defaultValue: opt.currentValue === 'true',
      });
      continue;
    }
    const choices = Array.isArray(opt.options)
      ? opt.options
          .filter((o) => o && typeof o.value === 'string')
          .map((o) => ({
            value: o.value,
            label: o.name?.trim() || o.value,
            ...(o.description ? { description: o.description } : {}),
          }))
      : [];
    if (choices.length > 0 || opt.type === 'select' || !opt.type) {
      descriptors.push({
        key,
        label,
        kind: 'select',
        ...(opt.currentValue !== undefined ? { defaultValue: opt.currentValue } : {}),
        options: choices,
      });
    }
  }
  return descriptors;
}

export interface AcpFlavorPolicy {
  readonly flavor: AcpFlavor;
  readonly defaultDriverId?: HarnessDriverId;
  readonly permissionModes: PermissionMode[];
  readonly presentation: HarnessPresentationMeta;
  readonly defaultNativeCommands: string[];
  resolveContinuationKey?(opts: AcpAdapterOptions): string | undefined;
  shouldEmitAvailableCommandsAsBlock?(): boolean;
  extractPermissionSecurityWarning?(options: AcpPermissionOption[]): string | undefined;
  resolveModeWithEnforcement?(
    requested: string,
    advertised: Array<{ id: string; name?: string }> | undefined,
    permissionMode: PermissionMode,
  ): { modeId: string; enforcement: 'native' | 'client_guard' };
  onSessionUpdate?(
    update: Record<string, unknown>,
    ctx: {
      turnId: string;
      emit: (ev: NormalizedAdapterEvent) => void;
      markBackgroundWork?: (active: boolean) => void;
    },
  ): boolean;
  onPermissionRequest?(
    reqId: string | number,
    params: Record<string, unknown>,
    options: AcpPermissionOption[],
    ctx: {
      turnId: string;
      nativeRequestId: string;
      emit: (ev: NormalizedAdapterEvent) => void;
      registerPending: (nativeRequestId: string, rpcId: string | number, options: AcpPermissionOption[]) => void;
    },
  ): boolean;
  beforeTurnPrompt?(nativeSessionId: string): unknown;
  afterTurnPrompt?(
    nativeSessionId: string,
    beforeToken: unknown,
    turnId: string,
    emit: (ev: NormalizedAdapterEvent) => void,
  ): {
    failed: boolean;
    message?: string;
    code?: string;
    failureClass?: string;
    resetAt?: number | null;
  } | null;
  buildLaunchArgs(
    baseArgs: readonly string[],
    source?: DiscoveredCliSession['source'],
    appDataDir?: string,
  ): string[];
  probeCliModels(
    binaryPath: string,
    env?: Record<string, string | undefined>,
    unsetEnv?: readonly string[],
  ): Promise<HarnessModelInfo[]>;
  readIndexedHistory(session: DiscoveredCliSession): HistoryMessage[];
  classifyModelGroup(modelId: string): string;
  extractTierName(sessRes: AcpSessionNewResult): string | null;
  resolveModeId(
    requested: string,
    advertised: Array<{ id: string; name?: string }> | undefined,
    permissionMode: PermissionMode,
  ): string;
  shouldThrowOnModeError(permissionMode: PermissionMode, appliedModeId?: string): boolean;
  canRunNativeCliCommand(): boolean;
  executeNativeCliCommand(
    binaryPath: string,
    config: AdapterSessionConfig,
    command: string,
    nativeSessionId: string | null,
    signal: AbortSignal,
    envOpts?: { env?: Record<string, string | undefined>; unsetEnv?: readonly string[]; appDataDir?: string },
  ): Promise<{ conversation_id?: string; response?: string }>;
  evaluatePermissionPolicy(
    params: Record<string, unknown>,
    options: AcpPermissionOption[],
    permissionMode: PermissionMode,
    currentTurnId: string | null,
    nativeSessionId: string | null,
  ): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } | null;
}

export class StrictAcpFlavorPolicy implements AcpFlavorPolicy {
  readonly flavor = 'strict_acp' as const;
  readonly permissionModes: PermissionMode[] = ['plan', 'accept_edits', 'auto'];
  readonly presentation: HarnessPresentationMeta = {
    shortLabel: 'ACP',
    accentColor: 'var(--accent-star)',
    softBg: 'var(--accent-star-soft)',
    tagline: 'Custom ACP Agent',
  };
  readonly defaultNativeCommands: string[] = [];

  buildLaunchArgs(baseArgs: readonly string[]): string[] {
    return [...baseArgs];
  }

  async probeCliModels(): Promise<HarnessModelInfo[]> {
    return [];
  }

  readIndexedHistory(): HistoryMessage[] {
    return [];
  }

  classifyModelGroup(modelId: string): string {
    return defaultAcpModelGroup(modelId);
  }

  extractTierName(): string | null {
    return null;
  }

  resolveModeId(requested: string): string {
    return requested;
  }

  shouldThrowOnModeError(): boolean {
    return false;
  }

  canRunNativeCliCommand(): boolean {
    return false;
  }

  async executeNativeCliCommand(): Promise<{ conversation_id?: string; response?: string }> {
    throw new Error('Strict ACP flavor does not support vendor CLI subcommands');
  }

  evaluatePermissionPolicy(): null {
    // Strict ACP forwards all permission requests honestly without client-side spoofing
    return null;
  }
}

export class AcpAdapter implements HarnessAdapter {
  readonly pluginMcpTransport = 'acp' as const;
  readonly id: string;
  readonly kind: HarnessKind;
  readonly driverId: HarnessDriverId;
  readonly continuationKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly protocolLabel = 'Agent Client Protocol (ACP JSON-RPC 2.0)';
  readonly isCustom?: boolean;
  readonly flavor: AcpFlavor;
  readonly presentation: HarnessPresentationMeta;
  readonly capabilities: HarnessCapabilities;

  protected readonly command: string;
  protected readonly args: string[];
  protected readonly env?: Record<string, string>;
  protected readonly unsetEnv?: readonly string[];
  protected readonly envWhitelist?: Record<string, string>;
  protected readonly binaryOverride?: string;
  protected readonly appDataDir?: string;
  protected readonly authMethodId?: string;
  protected readonly authenticateEagerly: boolean;
  protected readonly sessionLoadReplayIdleMs: number;
  protected readonly flavorPolicy: AcpFlavorPolicy;
  protected cachedSessionProbe: { snapshot: AcpLiveProbeSnapshot; fetchedAt: number } | null = null;
  protected liveConfigOptions: AcpConfigOption[] = [];
  protected liveNativeCommands: string[] | null = null;
  protected lastSupportsEmbeddedContext: boolean | null = null;
  protected authRequired = false;
  protected readonly onConfigOptionsObserved?: (opts: AcpConfigOption[]) => void;
  protected readonly onDetailedCommandsObserved?: (
    commands: Array<{ name: string; description?: string; argumentHint?: string }>,
  ) => void;
  protected readonly onVersionObservedCallback?: (version: string) => void;

  constructor(opts: AcpAdapterOptions) {
    this.id = opts.id;
    this.kind = opts.kind;
    const lookupKey = opts.flavor ?? opts.kind;
    const policyFactory = lookupKey ? flavorPolicyFactories.get(lookupKey) : undefined;
    this.flavorPolicy = opts.flavorPolicy ?? policyFactory?.() ?? new StrictAcpFlavorPolicy();
    this.flavor = opts.flavor ?? this.flavorPolicy.flavor;
    this.driverId = opts.driverId ?? this.flavorPolicy.defaultDriverId ?? 'acp';
    this.appDataDir = opts.appDataDir?.trim() || undefined;
    this.continuationKey =
      opts.continuationKey ??
      this.flavorPolicy.resolveContinuationKey?.(opts) ??
      `${this.driverId}:instance:${this.id}`;
    this.displayName = opts.displayName;
    this.description = opts.description;
    this.command = opts.command;
    this.args = opts.args ?? ['acp', '--stdio'];
    this.env = opts.env;
    this.unsetEnv = opts.unsetEnv;
    this.envWhitelist = opts.envWhitelist;
    this.binaryOverride = opts.binaryOverride;
    this.isCustom = opts.isCustom;
    this.authMethodId = opts.authMethodId;
    this.authenticateEagerly = opts.authenticateEagerly ?? false;
    this.sessionLoadReplayIdleMs =
      opts.sessionLoadReplayIdleMs ?? DEFAULT_SESSION_LOAD_REPLAY_IDLE_MS;

    this.presentation = {
      ...this.flavorPolicy.presentation,
      ...(opts.presentation ?? {}),
    };
    this.capabilities = {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      permissionModes: [...this.flavorPolicy.permissionModes],
      sessionResume: true,
      sessionFork: false,
      imageInput: true,
      subagents: true,
    };
  }

  get optionDescriptors(): ProviderOptionDescriptor[] {
    return mapAcpConfigOptionsToDescriptors(this.liveConfigOptions);
  }

  get capabilitiesV2(): HarnessCapabilitiesV2 {
    return {
      ...this.capabilities,
      transport: 'acp_stdio',
      historyInjectionMode:
        this.lastSupportsEmbeddedContext === false ? 'inline' : 'embedded_context',
      supportsNativeRollback: false,
      supportsActiveSteering: false,
      supportsUsageLimits: false,
      supportsDynamicOptions: true,
      nativeCommands: this.liveNativeCommands ?? [...this.flavorPolicy.defaultNativeCommands],
      optionDescriptors: this.optionDescriptors,
    };
  }

  protected buildSpawnEnv(): Record<string, string | undefined> | undefined {
    const merged: Record<string, string | undefined> = {};
    let hasEntries = false;
    for (const src of [this.env, this.envWhitelist]) {
      if (!src) continue;
      for (const [k, v] of Object.entries(src)) {
        if (!k || RESERVED_ENV_SET.has(k)) continue;
        merged[k] = v;
        hasEntries = true;
      }
    }
    return hasEntries ? merged : undefined;
  }

  protected getUnsetEnv(): readonly string[] | undefined {
    return this.unsetEnv;
  }

  protected buildLaunchArgs(source?: DiscoveredCliSession['source']): string[] {
    return this.flavorPolicy.buildLaunchArgs(this.args, source, this.appDataDir);
  }

  /**
   * Passive probe: checks binary availability and `--version` (plus cached or CLI-only model list)
   * without ever spawning a stateful `session/new` RPC session.
   */
  async probePassive(): Promise<HarnessInfo> {
    const binaryPath = await resolveBinary(this.command, this.binaryOverride);
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
        healthMessage: `${this.command} not found in PATH`,
        capabilities: this.capabilities,
        capabilitiesV2: capsV2,
        presentation: this.presentation,
        optionDescriptors: descriptors,
        models: [],
        defaultModelId: null,
        accountSummary: null,
        isCustom: this.isCustom,
      };
    }

    const env = this.buildSpawnEnv();
    const unsetEnv = this.getUnsetEnv();
    const verRes = await execCliQuick(binaryPath, ['--version'], 10_000, { env, unsetEnv, input: '' });
    const verText = `${verRes.stdout}\n${verRes.stderr}`.trim();
    let version = verText.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? (verText.split(/\r?\n/)[0] || null);
    if (version) {
      this.onVersionObservedCallback?.(version);
    }

    let models: HarnessModelInfo[] = [];
    let defaultModelId: string | null = null;
    let accountSummary: string | null = null;

    if (this.cachedSessionProbe) {
      models = this.cachedSessionProbe.snapshot.models;
      defaultModelId = this.cachedSessionProbe.snapshot.defaultModelId;
      accountSummary = this.cachedSessionProbe.snapshot.tierName;
      if (!version && this.cachedSessionProbe.snapshot.serverVersion) {
        version = this.cachedSessionProbe.snapshot.serverVersion;
      }
    } else {
      models = await this.flavorPolicy.probeCliModels(binaryPath, env, unsetEnv);
      defaultModelId = models[0]?.id ?? null;
    }

    const health =
      verRes.exitCode !== 0
        ? 'degraded'
        : this.authRequired
          ? 'unauthenticated'
          : 'ready';
    const healthMessage =
      health === 'unauthenticated'
        ? 'ACP agent requires authentication'
        : verRes.exitCode !== 0
          ? verText.slice(0, 200)
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
      capabilitiesV2: capsV2,
      presentation: this.presentation,
      optionDescriptors: descriptors,
      models,
      defaultModelId,
      accountSummary,
      isCustom: this.isCustom,
    };
  }

  async probe(): Promise<HarnessInfo> {
    return this.probePassive();
  }

  /**
   * Standard V2 usage & account probe delegated from `UsageService`.
   */
  async readUsageLimits(): Promise<AdapterUsageLimitResult> {
    const base: AdapterUsageLimitResult = {
      loggedIn: false,
      accountLabel: null,
      planType: null,
      authMethod: 'ACP Auth',
      billingTier: 'subscription',
      rateLimits: [],
      dailyBuckets: [],
    };
    try {
      const snap = await this.probeAcpSessionMetadata();
      base.loggedIn = snap.models.length > 0 || Boolean(snap.tierName);
      base.planType = snap.tierName;
      base.accountLabel = snap.tierName
        ? `${this.displayName} (${snap.tierName})`
        : base.loggedIn
          ? this.displayName
          : null;
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
    return base;
  }

  async probeAcpSessionMetadata(
    binaryPathOverride?: string,
    forceRefresh = false,
  ): Promise<AcpLiveProbeSnapshot> {
    if (
      !forceRefresh &&
      this.cachedSessionProbe &&
      Date.now() - this.cachedSessionProbe.fetchedAt < 60_000
    ) {
      return this.cachedSessionProbe.snapshot;
    }

    const binaryPath = binaryPathOverride ?? (await resolveBinary(this.command, this.binaryOverride));
    if (!binaryPath) {
      throw new Error(`ACP binary "${this.command}" not found`);
    }

    const launchArgs = this.buildLaunchArgs(undefined);
    const child = spawnCliProcess(binaryPath, launchArgs, {
      cwd: process.cwd(),
      env: this.buildSpawnEnv(),
      unsetEnv: this.getUnsetEnv(),
    });
    const rpc = new StdioJsonRpcClient(child, {
      onNotification: () => {},
      onServerRequest: (req) => rpc.respondError(req.id, -32601, 'Not supported during probe'),
      onDiagnostic: () => {},
      onExit: () => {},
    });

    try {
      const initRes = (await rpc.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'harnessmate-probe', version: '0.1.0' },
        },
        12_000,
      )) as {
        agentInfo?: { version?: string };
        agentCapabilities?: { promptCapabilities?: { embeddedContext?: boolean } };
        authMethods?: Array<{ id?: string }>;
      };

      if (initRes?.agentCapabilities?.promptCapabilities?.embeddedContext !== undefined) {
        this.lastSupportsEmbeddedContext = Boolean(
          initRes.agentCapabilities.promptCapabilities.embeddedContext,
        );
      }

      if (this.authenticateEagerly) {
        const methodId = this.authMethodId ?? initRes?.authMethods?.[0]?.id;
        if (methodId) {
          await rpc.request('authenticate', { methodId }, 12_000);
        }
      }

      const sessRes = (await rpc.request(
        'session/new',
        { cwd: process.cwd(), mcpServers: [] },
        20_000,
      )) as AcpSessionNewResult;

      this.authRequired = false;
      const parsed = parseAcpModelCatalog(sessRes, (id) =>
        this.flavorPolicy.classifyModelGroup(id),
      );
      if (Array.isArray(sessRes?.configOptions)) {
        this.liveConfigOptions = sessRes.configOptions;
        this.onConfigOptionsObserved?.(sessRes.configOptions);
      }
      if (initRes?.agentInfo?.version) {
        this.onVersionObservedCallback?.(initRes.agentInfo.version);
      }
      const snapshot: AcpLiveProbeSnapshot = {
        models: parsed.models,
        defaultModelId: parsed.defaultModelId,
        tierName: this.flavorPolicy.extractTierName(sessRes),
        serverVersion: initRes?.agentInfo?.version ?? null,
        ...(Array.isArray(sessRes?.configOptions) ? { configOptions: sessRes.configOptions } : {}),
      };
      this.cachedSessionProbe = { snapshot, fetchedAt: Date.now() };
      return snapshot;
    } catch (err) {
      if (isAcpAuthRequiredError(err)) {
        this.authRequired = true;
      }
      throw err;
    } finally {
      await rpc.dispose();
    }
  }

  async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
    const binaryPath = await resolveBinary(this.command, this.binaryOverride);
    if (!binaryPath) {
      throw new Error(`ACP CLI binary "${this.command}" not found.`);
    }

    const launchArgs = this.buildLaunchArgs(config.nativeHistorySource);
    const spawnEnv = this.buildSpawnEnv();
    const unsetEnv = this.getUnsetEnv();
    const child = spawnCliProcess(binaryPath, launchArgs, {
      cwd: config.cwd,
      env: spawnEnv,
      unsetEnv,
    });
    const handle = new AcpSessionHandle(child, config, {
      flavorPolicy: this.flavorPolicy,
      cliBinary: this.flavorPolicy.canRunNativeCliCommand() ? binaryPath : undefined,
      appDataDir: this.appDataDir,
      spawnEnv,
      unsetEnv,
      authMethodId: this.authMethodId,
      authenticateEagerly: this.authenticateEagerly,
      sessionLoadReplayIdleMs: this.sessionLoadReplayIdleMs,
      onAuthRequired: () => {
        this.authRequired = true;
      },
      onAuthenticated: () => {
        this.authRequired = false;
      },
      onConfigOptionsUpdated: (opts) => {
        this.liveConfigOptions = opts;
        this.onConfigOptionsObserved?.(opts);
      },
      onAvailableCommandsUpdated: (cmds) => {
        this.liveNativeCommands = cmds;
      },
      onDetailedCommandsUpdated: (cmds) => {
        this.onDetailedCommandsObserved?.(cmds);
      },
      onVersionObserved: (version) => {
        this.onVersionObservedCallback?.(version);
      },
      onEmbeddedContextSupportChanged: (supported) => {
        this.lastSupportsEmbeddedContext = supported;
      },
    });
    try {
      await handle.initialize();
      return handle;
    } catch (err) {
      await handle.dispose();
      throw err;
    }
  }

  async readHistory(session: DiscoveredCliSession, cwd: string): Promise<HistoryMessage[]> {
    const binary = await resolveBinary(this.command, this.binaryOverride);
    if (!binary) {
      const indexed = this.flavorPolicy.readIndexedHistory(session);
      if (indexed.length) return indexed;
      throw new Error(`ACP CLI binary "${this.command}" not found.`);
    }
    const args = this.buildLaunchArgs(session.source);
    const messages: HistoryMessage[] = [];
    let separated = false;
    let replayTracker: { notifyUpdate: () => void } | undefined;

    const rpc = new StdioJsonRpcClient(
      spawnCliProcess(binary, args, {
        cwd,
        env: this.buildSpawnEnv(),
        unsetEnv: this.getUnsetEnv(),
      }),
      {
        onNotification(method, params) {
          if (method !== 'session/update') return;
          const { sessionId, update } = params as {
            sessionId?: string;
            update?: { sessionUpdate?: string; content?: { type?: string; text?: string } };
          };
          if ((sessionId && sessionId !== session.nativeSessionId) || !update) return;
          replayTracker?.notifyUpdate();
          if (update.sessionUpdate === 'tool_call') {
            separated = true;
            return;
          }
          if (update.content?.type !== 'text') return;
          const role = update.sessionUpdate === 'user_message_chunk' ? 'user'
            : update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : undefined;
          const text = update.content.text;
          if (!role || !text) return;
          const last = messages.at(-1);
          if (last?.role === role && !separated) last.text += text;
          else messages.push({ role, text });
          separated = false;
        },
        onServerRequest: ({ id }) => rpc.respondError(id, -32601, 'History replay only'),
        onDiagnostic: () => {},
        onExit: () => {},
      },
    );
    try {
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 15_000);
      await requestSessionLoadWithIdleGap(
        rpc,
        { sessionId: session.nativeSessionId, cwd, mcpServers: [] },
        this.sessionLoadReplayIdleMs,
        (tracker) => {
          replayTracker = tracker;
        },
      );
      if (messages.some((message) => message.role === 'user') && messages.some((message) => message.role === 'assistant')) {
        return messages;
      }
      const indexed = this.flavorPolicy.readIndexedHistory(session);
      return indexed.length > messages.length ? indexed : messages;
    } catch (err) {
      const indexed = this.flavorPolicy.readIndexedHistory(session);
      if (indexed.length) return indexed;
      throw err;
    } finally {
      await rpc.dispose();
    }
  }
}

function defaultAcpModelGroup(modelId: string): string {
  if (modelId.includes('/')) return modelId.split('/')[0]!;
  return 'ACP Models';
}

export function parseAcpModelCatalog(
  sessRes: AcpSessionNewResult,
  classifyGroup: (modelId: string) => string = defaultAcpModelGroup,
): {
  models: HarnessModelInfo[];
  defaultModelId: string | null;
} {
  const availableVariants = sessRes?.models?.availableModels ?? [];
  const configOptions = sessRes?.configOptions ?? [];
  const modelOpt = configOptions.find((c) => c.id === 'model' || c.category === 'model');

  // Prefer clean base models from configOptions (paired with supported efforts derived from availableModels)
  if (modelOpt?.options && modelOpt.options.length > 0) {
    const defaultModelId = modelOpt.currentValue ?? modelOpt.options[0]!.value;
    const models: HarnessModelInfo[] = modelOpt.options.map((opt) => {
      const efforts: ReasoningEffort[] = [];
      for (const v of availableVariants) {
        if (v.modelId.startsWith(`${opt.value}-`)) {
          const suffix = v.modelId.slice(opt.value.length + 1) as ReasoningEffort;
          if (VALID_ACP_EFFORTS.has(suffix) && !efforts.includes(suffix)) {
            efforts.push(suffix);
          }
        }
      }
      return {
        id: opt.value,
        displayName: opt.name ?? opt.value,
        group: classifyGroup(opt.value),
        isDefault: opt.value === defaultModelId,
        supportedEfforts: efforts.length > 0 ? efforts : undefined,
        inputModalities: ['text', 'image'],
      };
    });
    return { models, defaultModelId };
  }

  // Fallback to flat availableModels
  const defaultModelId = sessRes?.models?.currentModelId ?? availableVariants[0]?.modelId ?? null;
  const models: HarnessModelInfo[] = availableVariants.map((m) => ({
    id: m.modelId,
    displayName: m.name ?? m.modelId,
    group: classifyGroup(m.modelId),
    isDefault: m.modelId === defaultModelId,
    inputModalities: ['text', 'image'],
  }));
  return { models, defaultModelId };
}

export async function requestSessionLoadWithIdleGap(
  rpc: StdioJsonRpcClient,
  params: Record<string, unknown>,
  idleGapMs: number,
  attachTracker: (tracker: { notifyUpdate: () => void } | undefined) => void,
  onIdleResolved?: () => void,
): Promise<AcpSessionNewResult> {
  const sessionId = String(params.sessionId ?? '');
  return new Promise<AcpSessionNewResult>((resolve, reject) => {
    let settled = false;
    let sawReplayUpdate = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      attachTracker(undefined);
    };

    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || !sawReplayUpdate) return;
        settled = true;
        cleanup();
        onIdleResolved?.();
        resolve({ sessionId });
      }, Math.max(50, idleGapMs));
    };

    attachTracker({
      notifyUpdate: () => {
        if (settled) return;
        sawReplayUpdate = true;
        scheduleIdleCheck();
      },
    });

    rpc
      .request<AcpSessionNewResult>('session/load', params, 45_000)
      .then((res) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
  });
}

interface PendingAcpApproval {
  rpcId: string | number;
  options: AcpPermissionOption[];
}

export interface AcpSessionRuntimeOptions {
  flavorPolicy: AcpFlavorPolicy;
  cliBinary?: string;
  appDataDir?: string;
  additionalDirectories?: string[];
  spawnEnv?: Record<string, string | undefined>;
  unsetEnv?: readonly string[];
  authMethodId?: string;
  authenticateEagerly: boolean;
  sessionLoadReplayIdleMs: number;
  onAuthRequired?: () => void;
  onAuthenticated?: () => void;
  onConfigOptionsUpdated?: (configOptions: AcpConfigOption[]) => void;
  onAvailableCommandsUpdated?: (commands: string[]) => void;
  onDetailedCommandsUpdated?: (
    commands: Array<{ name: string; description?: string; argumentHint?: string }>,
  ) => void;
  onVersionObserved?: (version: string) => void;
  onEmbeddedContextSupportChanged?: (supported: boolean) => void;
}

export class AcpSessionHandle implements AdapterSessionHandle {
  pluginMcpAvailable = false;
  private readonly listeners = new Set<(event: NormalizedAdapterEvent) => void>();
  private readonly earlyBuffer: NormalizedAdapterEvent[] = [];
  private readonly rpc: StdioJsonRpcClient;
  private readonly pendingApprovals = new Map<string, PendingAcpApproval>();
  private permissionMode: PermissionMode = 'manual';
  private permissionModeConfigured = false;
  private availableModes: AcpSessionNewResult['modes'];
  private appliedModeId?: string;
  private _nativeSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private assistantAccum = '';
  private thinkingAccum = '';
  private nativeCommandAbort?: AbortController;
  private nativeCommandTask?: Promise<void>;
  private hasAcpTurn = false;
  private sessionLoadTracker?: { notifyUpdate: () => void };
  private advertisedCommands: string[] = [];

  // Authoritative server-side model/config state tracked from session/new + set_config_option
  private configOptions: AcpConfigOption[] = [];
  private availableVariantIds = new Set<string>();
  private activeConfirmedModel: string | null = null;
  private activeConfirmedEffort: string | null = null;
  private permissionEnforcement: 'native' | 'client_guard' = 'native';
  private observedTierName: string | null = null;
  private backgroundWorkUntilMs = 0;
  private supportsEmbeddedContext = false;

  constructor(
    child: ReturnType<typeof spawnCliProcess>,
    private readonly config: AdapterSessionConfig,
    private readonly runtimeOpts: AcpSessionRuntimeOptions,
  ) {
    this.rpc = new StdioJsonRpcClient(child, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (req) => this.handleServerRequest(req),
      onDiagnostic: (stream, message) =>
        this.emit({ type: 'diagnostic.log', level: 'info', stream, message }),
      onExit: (code, signal) => {
        if (this.currentTurnId && !this.nativeCommandAbort) {
          this.emit({
            type: 'turn.failed',
            turnId: this.currentTurnId,
            message: `ACP server exited unexpectedly (code=${code}, signal=${signal})`,
          });
          this.currentTurnId = null;
        }
      },
    });
  }

  get nativeSessionId(): string | null {
    return this._nativeSessionId;
  }

  getConfigOptions(): AcpConfigOption[] {
    return this.configOptions;
  }

  getAvailableCommands(): string[] {
    return this.advertisedCommands;
  }

  async initialize(): Promise<void> {
    let initRes: {
      agentCapabilities?: {
        mcpCapabilities?: { http?: boolean };
        promptCapabilities?: { embeddedContext?: boolean };
        sessionCapabilities?: { resume?: unknown };
      };
      authMethods?: Array<{ id?: string; name?: string }>;
    };
    try {
      initRes = (await this.rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'harnessmate-desktop', version: '0.3.0' },
      })) as typeof initRes;
    } catch (err) {
      if (isAcpAuthRequiredError(err)) {
        this.runtimeOpts.onAuthRequired?.();
      }
      throw err;
    }

    const versionStr = (initRes as { agentInfo?: { version?: string } })?.agentInfo?.version;
    if (typeof versionStr === 'string' && versionStr.trim()) {
      this.runtimeOpts.onVersionObserved?.(versionStr.trim());
    }

    this.supportsEmbeddedContext = Boolean(
      initRes?.agentCapabilities?.promptCapabilities?.embeddedContext,
    );
    this.runtimeOpts.onEmbeddedContextSupportChanged?.(this.supportsEmbeddedContext);

    if (this.runtimeOpts.authenticateEagerly) {
      const methodId = this.runtimeOpts.authMethodId ?? initRes?.authMethods?.[0]?.id;
      if (methodId) {
        try {
          await this.rpc.request('authenticate', { methodId }, 15_000);
          this.runtimeOpts.onAuthenticated?.();
        } catch (err) {
          if (isAcpAuthRequiredError(err)) {
            this.runtimeOpts.onAuthRequired?.();
          }
          throw err;
        }
      }
    }

    const mcp = this.config.pluginMcp;
    const server = mcp && (initRes?.agentCapabilities?.mcpCapabilities?.http ? {
      type: 'http', name: pluginMcpServerName, url: mcp.url,
      headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }],
    } : pluginMcpStdioConfig(mcp));
    this.pluginMcpAvailable = Boolean(server);
    const requestSession = async (method: string, params: Record<string, unknown>) => {
      const callMethod = async (callParams: Record<string, unknown>) => {
        if (method === 'session/load') {
          return requestSessionLoadWithIdleGap(
            this.rpc,
            callParams,
            this.runtimeOpts.sessionLoadReplayIdleMs,
            (tracker) => {
              this.sessionLoadTracker = tracker;
            },
            () => {
              this.emit({
                type: 'diagnostic.log',
                level: 'info',
                stream: 'protocol',
                message: `ACP session/load resolved via replay idle gap (${this.runtimeOpts.sessionLoadReplayIdleMs}ms)`,
              });
            },
          );
        }
        return this.rpc.request<AcpSessionNewResult>(method, callParams, 25_000);
      };

      if (server && this.pluginMcpAvailable) {
        try {
          return await callMethod({ ...params, mcpServers: [server] });
        } catch (err) {
          if (isAcpAuthRequiredError(err)) {
            this.runtimeOpts.onAuthRequired?.();
            throw err;
          }
          this.pluginMcpAvailable = false;
          this.emit({ type: 'diagnostic.log', level: 'warn', stream: 'protocol', message: 'ACP 无法挂载会话插件工具，使用原会话能力重试' });
        }
      }
      return callMethod(params);
    };

    const createFreshAcpSession = () =>
      requestSession('session/new', { cwd: this.config.cwd, mcpServers: [] });

    let sessRes: AcpSessionNewResult | undefined;
    try {
      if (this.config.nativeSessionId) {
        try {
          const params = {
            sessionId: this.config.nativeSessionId,
            cwd: this.config.cwd,
            mcpServers: [],
          };
          const supportsResume = initRes.agentCapabilities?.sessionCapabilities?.resume;
          sessRes = await requestSession(supportsResume ? 'session/resume' : 'session/load', params);
          this._nativeSessionId = this.config.nativeSessionId;
        } catch (err) {
          if (isAcpAuthRequiredError(err)) {
            this.runtimeOpts.onAuthRequired?.();
            throw err;
          }
          if (this.config.requireNativeResume) throw err;
          sessRes = await createFreshAcpSession();
          this._nativeSessionId = sessRes?.sessionId ?? null;
        }
      } else {
        sessRes = await createFreshAcpSession();
        this._nativeSessionId = sessRes?.sessionId ?? null;
      }
      this.runtimeOpts.onAuthenticated?.();
    } catch (err) {
      if (isAcpAuthRequiredError(err)) {
        this.runtimeOpts.onAuthRequired?.();
      }
      throw err;
    }

    this.ingestSessionMetadata(sessRes);

    if (this._nativeSessionId) {
      this.emit({ type: 'native_session_ready', nativeSessionId: this._nativeSessionId });

      await this.applyRuntimeConfig({
        model: this.config.model,
        reasoningEffort: this.config.reasoningEffort,
        permissionMode: this.config.permissionMode,
      });
    }
  }

  async updateConfig(
    patch: Partial<AdapterSessionConfig> & { configOptions?: Record<string, string> },
  ): Promise<void> {
    await this.applyRuntimeConfig(patch);
  }

  async setConfigOption(configId: string, value: string): Promise<boolean> {
    if (!this._nativeSessionId) return false;
    const opt = this.configOptions.find((c) => c.id === configId || c.category === configId);
    if (!opt) {
      this.emit({
        type: 'diagnostic.log',
        level: 'warn',
        stream: 'protocol',
        message: `ACP config option "${configId}" is not advertised; skipping stale/unknown key`,
      });
      return false;
    }
    const allowed = new Set((opt.options ?? []).map((o) => o.value));
    if (allowed.size > 0 && !allowed.has(value)) {
      this.emit({
        type: 'diagnostic.log',
        level: 'warn',
        stream: 'protocol',
        message: `ACP config option "${configId}" value "${value}" is not in advertised choices; skipping`,
      });
      return false;
    }
    try {
      const res = (await this.rpc.request(
        'session/set_config_option',
        { sessionId: this._nativeSessionId, configId: opt.id, value },
        6000,
      )) as { configOptions?: AcpConfigOption[] };
      if (Array.isArray(res?.configOptions)) {
        this.configOptions = res.configOptions;
        this.runtimeOpts.onConfigOptionsUpdated?.(this.configOptions);
      }
      return true;
    } catch (err) {
      this.emit({
        type: 'diagnostic.log',
        level: 'warn',
        stream: 'protocol',
        message: `ACP set_config_option "${configId}=${value}" failed and was skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  }

  private ingestSessionMetadata(res: AcpSessionNewResult | undefined): void {
    if (!res) return;
    this.availableModes = res.modes;
    this.appliedModeId = res.modes?.currentModeId;
    if (Array.isArray(res.configOptions)) {
      this.configOptions = res.configOptions;
      this.runtimeOpts.onConfigOptionsUpdated?.(this.configOptions);
    }
    if (Array.isArray(res.models?.availableModels)) {
      this.availableVariantIds = new Set(res.models.availableModels.map((m) => m.modelId));
    }
    const modelOpt = this.configOptions.find((c) => c.id === 'model' || c.category === 'model');
    const effortOpt = this.configOptions.find(
      (c) => c.id === 'thought_level' || c.category === 'thought_level',
    );
    this.activeConfirmedModel = modelOpt?.currentValue ?? res.models?.currentModelId ?? this.activeConfirmedModel;
    this.activeConfirmedEffort = effortOpt?.currentValue ?? this.activeConfirmedEffort;
    const tier = this.runtimeOpts.flavorPolicy.extractTierName(res);
    if (tier) {
      this.observedTierName = tier;
    }
  }

  private async applyRuntimeConfig(
    patch: Partial<AdapterSessionConfig> & { configOptions?: Record<string, string> },
  ): Promise<void> {
    if (!this._nativeSessionId) return;

    if (patch.configOptions) {
      for (const [k, v] of Object.entries(patch.configOptions)) {
        await this.setConfigOption(k, v);
      }
    }

    const requestedModel = patch.model ?? undefined;
    const requestedEffort = patch.reasoningEffort ?? undefined;

    if (requestedModel) {
      const modelOpt = this.configOptions.find((c) => c.id === 'model' || c.category === 'model');
      const optionValues = new Set((modelOpt?.options ?? []).map((o) => o.value));

      let targetBaseModel = requestedModel;
      let inferredEffort: string | undefined;
      if (!optionValues.has(requestedModel) && optionValues.size > 0) {
        for (const baseVal of optionValues) {
          if (requestedModel.startsWith(`${baseVal}-`)) {
            targetBaseModel = baseVal;
            inferredEffort = requestedModel.slice(baseVal.length + 1);
            break;
          }
        }
      }

      let switched = false;
      let lastError = '';

      if (optionValues.has(targetBaseModel)) {
        try {
          const res = (await this.rpc.request(
            'session/set_config_option',
            { sessionId: this._nativeSessionId, configId: modelOpt!.id, value: targetBaseModel },
            6000,
          )) as { configOptions?: AcpConfigOption[] };
          if (Array.isArray(res?.configOptions)) {
            this.configOptions = res.configOptions;
            this.runtimeOpts.onConfigOptionsUpdated?.(this.configOptions);
          }
          const updatedModelOpt = this.configOptions.find(
            (c) => c.id === 'model' || c.category === 'model',
          );
          this.activeConfirmedModel = updatedModelOpt?.currentValue ?? targetBaseModel;
          switched = this.activeConfirmedModel === targetBaseModel;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (!switched) {
        const variantTarget =
          requestedEffort && this.availableVariantIds.has(`${targetBaseModel}-${requestedEffort}`)
            ? `${targetBaseModel}-${requestedEffort}`
            : requestedModel;
        try {
          await this.rpc.request(
            'session/set_model',
            { sessionId: this._nativeSessionId, modelId: variantTarget },
            6000,
          );
          this.activeConfirmedModel = variantTarget;
          switched = true;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (switched) {
        const desiredEffort = requestedEffort ?? inferredEffort;
        if (desiredEffort) {
          await this.applyEffortOption(desiredEffort);
        }
        const confirmedDisplay =
          this.activeConfirmedEffort &&
          this.activeConfirmedModel &&
          !this.activeConfirmedModel.endsWith(`-${this.activeConfirmedEffort}`)
            ? `${this.activeConfirmedModel} (${this.activeConfirmedEffort})`
            : this.activeConfirmedModel ?? requestedModel;
        this.emit({ type: 'model.confirmed', actualModel: confirmedDisplay });
      } else {
        const fallbackActual = this.activeConfirmedModel ?? 'unknown';
        this.emit({
          type: 'diagnostic.log',
          level: 'warn',
          stream: 'protocol',
          message: `ACP rejected model "${requestedModel}" (active remains "${fallbackActual}"): ${lastError}`,
        });
        this.emit({
          type: 'model.confirmed',
          actualModel: fallbackActual,
          reroutedFrom: requestedModel,
          reason: lastError || 'ACP server does not offer requested model',
        });
      }
    } else if (requestedEffort) {
      await this.applyEffortOption(requestedEffort);
      if (this.activeConfirmedModel) {
        this.emit({
          type: 'model.confirmed',
          actualModel: this.activeConfirmedEffort
            ? `${this.activeConfirmedModel} (${this.activeConfirmedEffort})`
            : this.activeConfirmedModel,
        });
      }
    } else if (this.activeConfirmedModel) {
      this.emit({ type: 'model.confirmed', actualModel: this.activeConfirmedModel });
    }

    if (patch.permissionMode && (!this.permissionModeConfigured || patch.permissionMode !== this.permissionMode)) {
      const requested = mapPermissionModeToAcpMode(patch.permissionMode);
      const advertised = this.availableModes?.availableModes;
      const modeResolution = this.runtimeOpts.flavorPolicy.resolveModeWithEnforcement
        ? this.runtimeOpts.flavorPolicy.resolveModeWithEnforcement(
            requested,
            advertised,
            patch.permissionMode,
          )
        : {
            modeId: this.runtimeOpts.flavorPolicy.resolveModeId(
              requested,
              advertised,
              patch.permissionMode,
            ),
            enforcement: 'native' as const,
          };
      const acpMode = modeResolution.modeId;
      this.permissionEnforcement = modeResolution.enforcement;
      if (acpMode !== this.appliedModeId) {
        try {
          await this.rpc.request(
            'session/set_mode',
            { sessionId: this._nativeSessionId, modeId: acpMode },
            4000,
          );
          this.appliedModeId = acpMode;
        } catch (err) {
          if (this.runtimeOpts.flavorPolicy.shouldThrowOnModeError(patch.permissionMode, this.appliedModeId)) {
            throw err;
          }
          this.permissionEnforcement = 'client_guard';
          this.emit({
            type: 'diagnostic.log',
            level: 'warn',
            stream: 'protocol',
            message: `ACP session/set_mode "${acpMode}" unsupported; enforcing client_guard for ${patch.permissionMode}`,
          });
        }
      }
      this.permissionMode = patch.permissionMode;
      this.permissionModeConfigured = true;
    }

    const effortOptAfter = this.configOptions.find(
      (c) => c.id === 'thought_level' || c.category === 'thought_level',
    );
    const availableThoughtLevels = (effortOptAfter?.options ?? [])
      .map((o) => o.value)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    this.emit({
      type: 'config.confirmed',
      model: this.activeConfirmedModel,
      thoughtLevel: this.activeConfirmedEffort,
      availableThoughtLevels,
      modeId: this.appliedModeId ?? null,
      permissionEnforcement: this.permissionEnforcement,
      tierName: this.observedTierName,
    });
  }

  private async applyEffortOption(effort: string): Promise<void> {
    if (!this._nativeSessionId) return;
    const effortOpt = this.configOptions.find(
      (c) => c.id === 'thought_level' || c.category === 'thought_level',
    );
    if (!effortOpt) {
      this.emit({
        type: 'diagnostic.log',
        level: 'warn',
        stream: 'protocol',
        message: `ACP thought_level "${effort}" skipped: option not advertised by agent`,
      });
      return;
    }
    const allowed = new Set((effortOpt.options ?? []).map((o) => o.value));
    if (allowed.size > 0 && !allowed.has(effort)) {
      this.emit({
        type: 'diagnostic.log',
        level: 'warn',
        stream: 'protocol',
        message: `ACP thought_level "${effort}" skipped: not in advertised choices`,
      });
      return;
    }
    try {
      const res = (await this.rpc.request(
        'session/set_config_option',
        { sessionId: this._nativeSessionId, configId: effortOpt.id, value: effort },
        4000,
      )) as { configOptions?: AcpConfigOption[] };
      if (Array.isArray(res?.configOptions)) {
        this.configOptions = res.configOptions;
        this.runtimeOpts.onConfigOptionsUpdated?.(this.configOptions);
      }
      const updated = this.configOptions.find(
        (c) => c.id === 'thought_level' || c.category === 'thought_level',
      );
      this.activeConfirmedEffort = updated?.currentValue ?? effort;
    } catch (err) {
      this.emit({
        type: 'diagnostic.log',
        level: 'warn',
        stream: 'protocol',
        message: `ACP thought_level "${effort}" not applied: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private buildPromptBlocks(
    input: TurnInput,
    basePromptText: string,
    useEmbeddedContext: boolean,
  ): {
    promptBlocks: Array<Record<string, unknown>>;
    driverUsed?: import('@harnessmate/protocol').ContextInjectionDriver;
  } {
    const promptBlocks: Array<Record<string, unknown>> = [];
    let driverUsed: import('@harnessmate/protocol').ContextInjectionDriver | undefined;

    if (input.contextSync) {
      if (useEmbeddedContext) {
        promptBlocks.push({
          type: 'resource',
          resource: {
            uri: 'harnessmate://context/sync-delta.md',
            mimeType: 'text/markdown',
            text: input.contextSync.deltaMarkdown,
          },
        });
        promptBlocks.push({ type: 'text', text: basePromptText });
        driverUsed = 'acp_embedded_context';
        this.emit({
          type: 'diagnostic.log',
          level: 'info',
          stream: 'protocol',
          message: `ACP native embeddedContext resource block attached (${input.contextSync.deltaMarkdown.length} chars)`,
        });
      } else {
        promptBlocks.push({
          type: 'text',
          text: `${input.contextSync.deltaMarkdown}\n\n---\n\n${basePromptText}`,
        });
        driverUsed = 'prompt_envelope';
      }
    } else {
      promptBlocks.push({ type: 'text', text: basePromptText });
    }

    for (const att of input.attachments ?? []) {
      if (att.kind === 'image') {
        const base64 =
          att.dataBase64 ||
          (att.path && fs.existsSync(att.path) ? fs.readFileSync(att.path).toString('base64') : null);
        if (base64 && att.mimeType) {
          promptBlocks.push({
            type: 'image',
            mimeType: att.mimeType,
            data: base64,
          });
        }
      }
    }

    return { promptBlocks, driverUsed };
  }

  async sendTurn(
    input: TurnInput,
  ): Promise<{ driverUsed?: import('@harnessmate/protocol').ContextInjectionDriver }> {
    if (!this._nativeSessionId) {
      throw new Error('ACP session is not initialized');
    }
    if (input.cliCommand && this.runtimeOpts.cliBinary && this.runtimeOpts.flavorPolicy.canRunNativeCliCommand()) {
      const binary = this.runtimeOpts.cliBinary;
      const command = input.cliCommand;
      const nativeId = this.config.nativeSessionId || this.hasAcpTurn ? this._nativeSessionId : null;
      if (command === '/compact' && !nativeId) throw new Error('当前会话还没有可以压缩的上下文');
      const abort = new AbortController();
      this.nativeCommandAbort = abort;
      this.currentTurnId = input.turnId;
      this.emit({ type: 'turn.started', turnId: input.turnId });
      this.nativeCommandTask = this.runtimeOpts.flavorPolicy
        .executeNativeCliCommand(
          binary,
          {
            ...this.config,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            permissionMode: input.permissionMode ?? this.config.permissionMode,
          },
          command,
          nativeId,
          abort.signal,
          {
            env: this.runtimeOpts.spawnEnv,
            unsetEnv: this.runtimeOpts.unsetEnv,
            appDataDir: this.runtimeOpts.appDataDir,
          },
        )
        .then((result) => {
          if (this.currentTurnId !== input.turnId) return;
          if (nativeId && result.conversation_id && result.conversation_id !== nativeId) {
            throw new Error('原生命令返回了不同的原生会话');
          }
          if (result.conversation_id && result.conversation_id !== this._nativeSessionId) {
            this._nativeSessionId = result.conversation_id;
            this.emit({ type: 'native_session_ready', nativeSessionId: result.conversation_id });
          }
          if (result.response) {
            this.emit({ type: 'message.assistant.completed', turnId: input.turnId, text: result.response });
          }
          this.currentTurnId = null;
          this.emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'native_command' });
        })
        .catch((err: Error) => {
          if (this.currentTurnId !== input.turnId) return;
          this.currentTurnId = null;
          if (abort.signal.aborted) this.emit({ type: 'turn.cancelled', turnId: input.turnId });
          else {
            const authErr = isAcpAuthRequiredError(err);
            if (authErr) this.runtimeOpts.onAuthRequired?.();
            this.emit({
              type: 'turn.failed',
              turnId: input.turnId,
              message: err.message,
              ...(authErr ? { code: 'unauthenticated' } : {}),
            });
          }
        })
        .finally(() => {
          this.nativeCommandAbort = undefined;
          this.nativeCommandTask = undefined;
        });
      return {};
    }

    if (input.model || input.reasoningEffort || input.permissionMode) {
      await this.applyRuntimeConfig({
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
      });
    }

    this.currentTurnId = input.turnId;
    this.assistantAccum = '';
    this.thinkingAccum = '';
    this.emit({ type: 'turn.started', turnId: input.turnId });

    const basePromptText = buildPromptWithFileAttachments(input.text, input.attachments);
    const { promptBlocks, driverUsed } = this.buildPromptBlocks(
      input,
      basePromptText,
      this.supportsEmbeddedContext,
    );

    if (driverUsed && input.contextSync) {
      input.contextSync.onDispatch?.(driverUsed, input.contextSync.deltaMarkdown);
    }

    const sessionId = this._nativeSessionId;
    const beforeToken =
      sessionId && this.runtimeOpts.flavorPolicy.beforeTurnPrompt
        ? this.runtimeOpts.flavorPolicy.beforeTurnPrompt(sessionId)
        : undefined;
    const runPrompt = async () => {
      try {
        return await this.rpc.request<{ stopReason?: string }>(
          'session/prompt',
          {
            sessionId,
            prompt: promptBlocks,
          },
          15 * 60_000,
        );
      } catch (err) {
        if (driverUsed === 'acp_embedded_context' && isEmbeddedContextRejectionError(err)) {
          this.supportsEmbeddedContext = false;
          this.runtimeOpts.onEmbeddedContextSupportChanged?.(false);
          this.emit({
            type: 'diagnostic.log',
            level: 'warn',
            stream: 'protocol',
            message: `ACP server rejected embeddedContext resource block (${err instanceof Error ? err.message : String(err)}); retrying inline`,
          });
          const fallback = this.buildPromptBlocks(input, basePromptText, false);
          if (input.contextSync && fallback.driverUsed) {
            input.contextSync.onDispatch?.(fallback.driverUsed, input.contextSync.deltaMarkdown);
          }
          return await this.rpc.request<{ stopReason?: string }>(
            'session/prompt',
            {
              sessionId,
              prompt: fallback.promptBlocks,
            },
            15 * 60_000,
          );
        }
        throw err;
      }
    };

    void runPrompt()
      .then((res) => {
        this.hasAcpTurn = true;
        this.runtimeOpts.onAuthenticated?.();
        const turnId = this.currentTurnId;
        if (!turnId) return;
        this.currentTurnId = null;

        if (this.thinkingAccum) {
          this.emit({ type: 'thinking.completed', turnId, text: this.thinkingAccum });
        }
        if (this.assistantAccum) {
          this.emit({ type: 'message.assistant.completed', turnId, text: this.assistantAccum });
        }

        const stopReason = res?.stopReason ?? 'end_turn';
        if (stopReason === 'cancelled') {
          this.emit({ type: 'turn.cancelled', turnId });
        } else {
          const outcome =
            sessionId && this.runtimeOpts.flavorPolicy.afterTurnPrompt
              ? this.runtimeOpts.flavorPolicy.afterTurnPrompt(
                  sessionId,
                  beforeToken,
                  turnId,
                  (ev) => this.emit(ev),
                )
              : null;
          if (outcome?.failed) {
            this.emit({
              type: 'turn.failed',
              turnId,
              message: outcome.message || 'Agent turn failed silently',
              ...(outcome.code ? { code: outcome.code } : {}),
              ...(outcome.failureClass ? { failureClass: outcome.failureClass } : {}),
              ...(outcome.resetAt !== undefined ? { resetAt: outcome.resetAt } : {}),
            });
          } else {
            this.emit({ type: 'turn.completed', turnId, stopReason });
          }
        }
      })
      .catch((err: Error) => {
        const turnId = this.currentTurnId;
        if (!turnId) return;
        this.currentTurnId = null;
        const authErr = isAcpAuthRequiredError(err);
        if (authErr) {
          this.runtimeOpts.onAuthRequired?.();
        }
        this.emit({
          type: 'turn.failed',
          turnId,
          message: err.message,
          ...(authErr ? { code: 'unauthenticated' } : {}),
        });
      });

    return { driverUsed };
  }

  async interrupt(): Promise<void> {
    if (this.nativeCommandAbort) {
      this.nativeCommandAbort.abort();
      await this.nativeCommandTask;
      return;
    }
    if (!this._nativeSessionId) return;
    this.rpc.notify('session/cancel', { sessionId: this._nativeSessionId });
    if (this.currentTurnId) {
      const turnId = this.currentTurnId;
      this.currentTurnId = null;
      this.emit({ type: 'turn.cancelled', turnId });
    }
  }

  async steerTurn(input: TurnInput): Promise<void> {
    if (!this._nativeSessionId) {
      throw new Error('ACP session is not initialized');
    }
    const basePromptText = buildPromptWithFileAttachments(input.text, input.attachments);
    const { promptBlocks } = this.buildPromptBlocks(
      input,
      basePromptText,
      this.supportsEmbeddedContext,
    );
    await this.rpc.request(
      'session/prompt',
      {
        sessionId: this._nativeSessionId,
        prompt: promptBlocks,
      },
      15 * 60_000,
    );
  }

  hasActiveBackgroundWork(): boolean {
    return Date.now() < this.backgroundWorkUntilMs;
  }

  async resolveQuestion(
    nativeRequestId: string,
    answer: { selectedOptionIds?: string[]; freeText?: string },
  ): Promise<void> {
    const pending = this.pendingApprovals.get(nativeRequestId);
    if (!pending) return;
    this.pendingApprovals.delete(nativeRequestId);

    const wanted = answer.selectedOptionIds?.[0]?.trim() || answer.freeText?.trim();
    const matched = wanted
      ? pending.options.find(
          (o) =>
            o.optionId === wanted ||
            o.name?.toLowerCase() === wanted.toLowerCase(),
        )
      : undefined;
    if (matched) {
      this.rpc.respond(pending.rpcId, {
        outcome: { outcome: 'selected', optionId: matched.optionId },
      });
    } else if (wanted && pending.options[0]?.optionId) {
      this.rpc.respond(pending.rpcId, {
        outcome: { outcome: 'selected', optionId: pending.options[0].optionId },
      });
    } else {
      this.rpc.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } });
    }
  }

  async resolveApproval(nativeRequestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(nativeRequestId);
    if (!pending) return;
    this.pendingApprovals.delete(nativeRequestId);

    const chosen = pickAcpOption(pending.options, decision);
    if (chosen) {
      this.rpc.respond(pending.rpcId, {
        outcome: { outcome: 'selected', optionId: chosen.optionId },
      });
    } else {
      this.rpc.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } });
    }
  }

  async dispose(): Promise<void> {
    this.nativeCommandAbort?.abort();
    this.pendingApprovals.clear();
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
    const params = (req.params ?? {}) as Record<string, unknown>;

    if (req.method === 'session/request_permission') {
      const nativeRequestId = `acp_req_${String(req.id)}`;
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      const rawOptions = Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : [];

      const policyOutcome = this.runtimeOpts.flavorPolicy.evaluatePermissionPolicy(
        params,
        rawOptions,
        this.permissionMode,
        this.currentTurnId,
        this._nativeSessionId,
      );
      if (policyOutcome) {
        this.rpc.respond(req.id, policyOutcome);
        return;
      }

      const policyHandled = this.runtimeOpts.flavorPolicy.onPermissionRequest?.(
        req.id,
        params,
        rawOptions,
        {
          turnId,
          nativeRequestId,
          emit: (ev) => this.emit(ev),
          registerPending: (reqKey, rpcId, optsList) => {
            this.pendingApprovals.set(reqKey, { rpcId, options: optsList });
          },
        },
      );
      if (policyHandled) {
        return;
      }

      const toolName = String(toolCall.title ?? toolCall.kind ?? 'Tool Permission');
      const toolKind = mapAcpToolKind(String(toolCall.kind ?? ''));
      const diffPreview = extractAcpDiff(toolCall);
      const securityWarning =
        this.runtimeOpts.flavorPolicy.extractPermissionSecurityWarning?.(rawOptions);
      const baseSummary = String(toolCall.title ?? 'Permission requested by ACP agent');
      const summary = securityWarning ? `${baseSummary} · ⚠️ ${securityWarning}` : baseSummary;

      this.pendingApprovals.set(nativeRequestId, { rpcId: req.id, options: rawOptions });
      this.emit({
        type: 'approval.requested',
        turnId,
        nativeRequestId,
        toolName,
        toolKind,
        summary,
        input: toolCall.rawInput ?? toolCall,
        diffPreview,
        riskLevel: classifyAcpRisk(toolKind),
        ...(securityWarning ? { securityWarning } : {}),
      });
      return;
    }

    this.emit({
      type: 'diagnostic.log',
      level: 'warn',
      stream: 'protocol',
      message: `Unhandled ACP client request: ${req.method}`,
    });
    this.rpc.respondError(req.id, -32601, `Unsupported ACP client method: ${req.method}`);
  }

  private handleNotification(method: string, rawParams: unknown): void {
    if (method !== 'session/update') return;
    this.sessionLoadTracker?.notifyUpdate();
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const update = (params.update ?? params) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    const turnId = this.currentTurnId ?? 'turn_bg';

    const intercepted = this.runtimeOpts.flavorPolicy.onSessionUpdate?.(update, {
      turnId,
      emit: (ev) => this.emit(ev),
      markBackgroundWork: (active) => {
        this.backgroundWorkUntilMs = active ? Date.now() + 30 * 60_000 : 0;
      },
    });
    if (intercepted) return;

    switch (kind) {
      case 'agent_message_chunk': {
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = typeof content.text === 'string' ? content.text : '';
        if (text) {
          this.assistantAccum += text;
          this.emit({ type: 'message.assistant.delta', turnId, text });
        }
        break;
      }

      case 'agent_thought_chunk': {
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = typeof content.text === 'string' ? content.text : '';
        if (text) {
          this.thinkingAccum += text;
          this.emit({ type: 'thinking.delta', turnId, text });
        }
        break;
      }

      case 'tool_call': {
        const toolCallId = String(update.toolCallId ?? `acp_tc_${Date.now()}`);
        const toolName = String(update.title ?? update.kind ?? 'tool');
        const toolKind = mapAcpToolKind(String(update.kind ?? ''));
        this.emit({
          type: 'tool.call.started',
          turnId,
          toolCallId,
          toolName,
          toolKind,
          summary: String(update.title ?? toolName),
          input: update.rawInput,
        });
        break;
      }

      case 'tool_call_update': {
        const toolCallId = String(update.toolCallId ?? '');
        const status = String(update.status ?? '');
        const outputText = extractAcpToolOutput(update);
        const diffText = extractAcpDiff(update);

        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          this.emit({
            type: 'tool.call.completed',
            turnId,
            toolCallId,
            toolName: String(update.title ?? 'tool'),
            status: status === 'completed' ? 'success' : status === 'cancelled' ? 'cancelled' : 'error',
            output: outputText,
            diff: diffText,
          });
        } else if (outputText || diffText) {
          this.emit({
            type: 'tool.call.delta',
            turnId,
            toolCallId,
            outputDelta: outputText ?? '',
            diffDelta: diffText,
          });
        }
        break;
      }

      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        const summaryLines = entries
          .map((e) => {
            if (!e || typeof e !== 'object') return '';
            const rec = e as { content?: string; status?: string };
            return rec.content ? `[${rec.status ?? 'pending'}] ${rec.content}` : '';
          })
          .filter(Boolean);
        this.emit({
          type: 'turn_block.ext',
          turnId,
          itemId: `acp_plan_${turnId}`,
          blockType: 'ext:acp.plan',
          title: 'Plan',
          fallbackSummary: summaryLines.join('\n') || `${entries.length} plan entries`,
          status: 'completed',
          payload: { entries },
        });
        break;
      }

      case 'available_commands_update': {
        const rawCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        const detailedCommands = rawCommands
          .map((c) => {
            if (c && typeof c === 'object') {
              const rec = c as {
                name?: unknown;
                description?: unknown;
                argumentHint?: unknown;
                input?: { hint?: unknown };
              };
              const name = typeof rec.name === 'string' ? rec.name.replace(/^\//, '').trim() : '';
              if (!name) return null;
              return {
                name,
                ...(typeof rec.description === 'string' && rec.description.trim()
                  ? { description: rec.description.trim() }
                  : {}),
                ...((typeof rec.argumentHint === 'string' && rec.argumentHint.trim()) ||
                (typeof rec.input?.hint === 'string' && rec.input.hint.trim())
                  ? {
                      argumentHint: String(rec.argumentHint ?? rec.input?.hint).trim(),
                    }
                  : {}),
              };
            }
            const name = String(c ?? '').replace(/^\//, '').trim();
            return name ? { name } : null;
          })
          .filter((c): c is { name: string; description?: string; argumentHint?: string } => c !== null);
        const commandNames = detailedCommands.map((c) => c.name);
        this.advertisedCommands = commandNames;
        this.runtimeOpts.onAvailableCommandsUpdated?.(commandNames);
        this.runtimeOpts.onDetailedCommandsUpdated?.(detailedCommands);
        this.emit({ type: 'commands.updated', commands: detailedCommands });
        if (this.runtimeOpts.flavorPolicy.shouldEmitAvailableCommandsAsBlock?.() !== false) {
          this.emit({
            type: 'turn_block.ext',
            turnId,
            itemId: `acp_cmds_${Date.now()}`,
            blockType: 'ext:acp.available_commands',
            title: 'Available Commands',
            fallbackSummary: commandNames.join(', ') || 'No commands advertised',
            status: 'completed',
            payload: { commands: rawCommands },
          });
        }
        break;
      }

      case 'config_option_update': {
        if (Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions as AcpConfigOption[];
        } else if (typeof update.configId === 'string') {
          const idx = this.configOptions.findIndex((c) => c.id === update.configId);
          if (idx >= 0) {
            this.configOptions[idx] = {
              ...this.configOptions[idx]!,
              ...(typeof update.value === 'string' ? { currentValue: update.value } : {}),
              ...(Array.isArray(update.options)
                ? { options: update.options as AcpConfigOption['options'] }
                : {}),
            };
          } else {
            this.configOptions.push({
              id: update.configId,
              name: typeof update.name === 'string' ? update.name : update.configId,
              type: typeof update.optionType === 'string' ? update.optionType : 'select',
              currentValue: typeof update.value === 'string' ? update.value : undefined,
              options: Array.isArray(update.options)
                ? (update.options as AcpConfigOption['options'])
                : undefined,
            });
          }
        }
        this.runtimeOpts.onConfigOptionsUpdated?.([...this.configOptions]);
        break;
      }

      default:
        break;
    }
  }
}

function isEmbeddedContextRejectionError(err: unknown): boolean {
  if (err instanceof JsonRpcResponseError && (err.code === -32602 || err.code === -32600)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /embedded.?context|resource|unsupported.*block|invalid params|unknown.*content.*type/i.test(
    msg,
  );
}

export function mapPermissionModeToAcpMode(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'accept_edits':
      return 'accept-edits';
    case 'manual':
      return 'default';
    case 'auto':
      return 'auto';
  }
}

export function mapAcpToolKind(kind: string): ToolKind {
  switch (kind.toLowerCase()) {
    case 'execute':
    case 'shell':
    case 'terminal':
      return 'shell';
    case 'read':
      return 'file_read';
    case 'edit':
    case 'write':
    case 'delete':
      return 'file_edit';
    case 'search':
      return 'search';
    case 'fetch':
    case 'web':
      return 'web';
    default:
      return 'other';
  }
}

export function classifyAcpRisk(kind: ToolKind): RiskLevel {
  if (kind === 'shell') return 'high';
  if (kind === 'file_edit') return 'medium';
  return 'low';
}

export function pickAcpOption(
  options: AcpPermissionOption[],
  decision: ApprovalDecision,
  strict = false,
): AcpPermissionOption | undefined {
  if (options.length === 0) return undefined;
  const preferredKinds =
    decision === 'allow_once'
      ? ['allow_once']
      : decision === 'allow_session'
        ? ['allow_always', 'allow_once']
        : ['reject_once', 'reject_always'];

  for (const kind of preferredKinds) {
    const match = options.find((o) => o?.kind === kind && typeof o.optionId === 'string');
    if (match) return match;
  }
  return !strict && decision !== 'deny' && options.every((option) => !option?.kind)
    ? options.find((option) => typeof option?.optionId === 'string') : undefined;
}

export function extractAcpToolOutput(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.rawOutput === 'string') return obj.rawOutput;
  if (obj.rawOutput && typeof obj.rawOutput === 'object') {
    return JSON.stringify(obj.rawOutput, null, 2);
  }
  if (Array.isArray(obj.content)) {
    const chunks = obj.content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const rec = item as Record<string, unknown>;
        if (rec.type === 'content' && rec.content && typeof rec.content === 'object') {
          return String((rec.content as { text?: string }).text ?? '');
        }
        return typeof rec.text === 'string' ? rec.text : '';
      })
      .filter(Boolean);
    if (chunks.length > 0) return chunks.join('\n');
  }
  return undefined;
}

export function extractAcpDiff(obj: Record<string, unknown>): string | undefined {
  if (!Array.isArray(obj.content)) return undefined;
  const diffs: string[] = [];
  for (const item of obj.content) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === 'diff' && typeof rec.path === 'string') {
      diffs.push(`--- ${rec.path}\n+++ ${rec.path}\n${String(rec.newText ?? '')}`);
    }
  }
  return diffs.length > 0 ? diffs.join('\n') : undefined;
}
