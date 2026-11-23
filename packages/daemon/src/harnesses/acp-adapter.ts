import fs from 'node:fs';
import type {
  ApprovalDecision,
  DiscoveredCliSession,
  HarnessCapabilities,
  HarnessInfo,
  HarnessKind,
  HarnessModelInfo,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  ToolKind,
} from '@harnessmate/protocol';
import { buildPromptWithFileAttachments } from './codex-adapter.js';
import { runAgyCommand } from './agy-commands.js';
import { agyDataDirectory, readAgyIndexedHistory, type HistoryMessage } from './history-scanner.js';
import { StdioJsonRpcClient, type JsonRpcServerRequest } from './jsonrpc.js';
import { execCliQuick, resolveBinary, spawnCliProcess } from './process.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from './types.js';
import { pluginMcpServerName } from './types.js';
import { pluginMcpStdioConfig } from './plugin-mcp-stdio.js';

export interface AcpAdapterOptions {
  id: string;
  kind: HarnessKind;
  displayName: string;
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  binaryOverride?: string;
  isCustom?: boolean;
}

interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

interface AcpSessionNewResult {
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
  _meta?: {
    antigravity?: {
      tier?: { name?: string; id?: string };
    };
  };
}

export interface AcpLiveProbeSnapshot {
  models: HarnessModelInfo[];
  defaultModelId: string | null;
  tierName: string | null;
  serverVersion: string | null;
}

const VALID_ACP_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

export class AcpAdapter implements HarnessAdapter {
  readonly pluginMcpTransport = 'acp' as const;
  readonly id: string;
  readonly kind: HarnessKind;
  readonly displayName: string;
  readonly description: string;
  readonly protocolLabel = 'Agent Client Protocol (ACP JSON-RPC 2.0)';
  readonly isCustom?: boolean;
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    interactiveApproval: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    permissionModes: ['plan', 'accept_edits', 'auto'],
    sessionResume: true,
    sessionFork: false,
    imageInput: true,
    subagents: true,
  };

  private readonly command: string;
  private readonly args: string[];
  private readonly env?: Record<string, string>;
  private readonly binaryOverride?: string;
  private cachedSessionProbe: { snapshot: AcpLiveProbeSnapshot; fetchedAt: number } | null = null;

  constructor(opts: AcpAdapterOptions) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.displayName = opts.displayName;
    this.description = opts.description;
    this.command = opts.command;
    this.args = opts.args ?? ['acp', '--stdio'];
    this.env = opts.env;
    this.binaryOverride = opts.binaryOverride;
    this.isCustom = opts.isCustom;
  }

  async probe(): Promise<HarnessInfo> {
    const binaryPath = await resolveBinary(this.command, this.binaryOverride);
    if (!binaryPath) {
      return {
        id: this.id,
        kind: this.kind,
        displayName: this.displayName,
        description: this.description,
        protocolLabel: this.protocolLabel,
        binaryPath: null,
        version: null,
        health: 'unavailable',
        healthMessage: `${this.command} not found in PATH`,
        capabilities: this.capabilities,
        models: [],
        defaultModelId: null,
        accountSummary: null,
        isCustom: this.isCustom,
      };
    }

    const verRes = await execCliQuick(binaryPath, ['--version'], 6000);
    const verText = `${verRes.stdout}\n${verRes.stderr}`.trim();
    let version = verText.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? (verText.split(/\r?\n/)[0] || null);

    let models: HarnessModelInfo[] = [];
    let defaultModelId: string | null = null;
    let accountSummary: string | null = null;

    if (this.kind === 'agy') {
      try {
        const live = await this.probeAcpSessionMetadata(binaryPath);
        models = live.models;
        defaultModelId = live.defaultModelId;
        accountSummary = live.tierName;
        if (!version && live.serverVersion) version = live.serverVersion;
      } catch {
        models = await probeAgyModelsCli(binaryPath);
        defaultModelId = models[0]?.id ?? null;
      }
    }

    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      description: this.description,
      protocolLabel: this.protocolLabel,
      binaryPath,
      version,
      health: verRes.exitCode === 0 ? 'ready' : 'degraded',
      healthMessage: verRes.exitCode === 0 ? undefined : verText.slice(0, 200),
      capabilities: this.capabilities,
      models,
      defaultModelId,
      accountSummary,
      isCustom: this.isCustom,
    };
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

    const child = spawnCliProcess(binaryPath, this.args, { cwd: process.cwd(), env: this.env });
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
      )) as { agentInfo?: { version?: string } };

      const sessRes = (await rpc.request(
        'session/new',
        { cwd: process.cwd(), mcpServers: [] },
        20_000,
      )) as AcpSessionNewResult;

      const parsed = parseAcpModelCatalog(sessRes);
      const snapshot: AcpLiveProbeSnapshot = {
        models: parsed.models,
        defaultModelId: parsed.defaultModelId,
        tierName: sessRes?._meta?.antigravity?.tier?.name ?? null,
        serverVersion: initRes?.agentInfo?.version ?? null,
      };
      this.cachedSessionProbe = { snapshot, fetchedAt: Date.now() };
      return snapshot;
    } finally {
      await rpc.dispose();
    }
  }

  async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
    const binaryPath = await resolveBinary(this.command, this.binaryOverride);
    if (!binaryPath) {
      throw new Error(`ACP CLI binary "${this.command}" not found.`);
    }

    const launchArgs = [...this.args];
    const dataDirectory = agyDataDirectory(config.nativeHistorySource);
    if (this.kind === 'agy' && dataDirectory) launchArgs.push('--app-data-dir', dataDirectory);
    if (
      this.kind === 'agy' &&
      config.permissionMode === 'auto' &&
      !launchArgs.includes('--dangerously-skip-permissions')
    ) {
      launchArgs.push('--dangerously-skip-permissions');
    }

    const child = spawnCliProcess(binaryPath, launchArgs, { cwd: config.cwd, env: this.env });
    const handle = new AcpSessionHandle(child, config, this.kind === 'agy' ? binaryPath : undefined);
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
      const indexed = readAgyIndexedHistory(session);
      if (indexed.length) return indexed;
      throw new Error(`ACP CLI binary "${this.command}" not found.`);
    }
    const args = [...this.args];
    const dataDirectory = agyDataDirectory(session.source);
    if (dataDirectory) args.push('--app-data-dir', dataDirectory);
    const messages: HistoryMessage[] = [];
    let separated = false;
    const rpc = new StdioJsonRpcClient(spawnCliProcess(binary, args, { cwd, env: this.env }), {
      onNotification(method, params) {
        if (method !== 'session/update') return;
        const { sessionId, update } = params as {
          sessionId?: string;
          update?: { sessionUpdate?: string; content?: { type?: string; text?: string } };
        };
        if (sessionId !== session.nativeSessionId || !update) return;
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
    });
    try {
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 15_000);
      await rpc.request('session/load', { sessionId: session.nativeSessionId, cwd, mcpServers: [] }, 45_000);
      if (messages.some((message) => message.role === 'user') && messages.some((message) => message.role === 'assistant')) {
        return messages;
      }
      const indexed = readAgyIndexedHistory(session);
      return indexed.length > messages.length ? indexed : messages;
    } catch (err) {
      const indexed = readAgyIndexedHistory(session);
      if (indexed.length) return indexed;
      throw err;
    } finally {
      await rpc.dispose();
    }
  }
}

function parseAcpModelCatalog(sessRes: AcpSessionNewResult): {
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
        group: classifyAgyModelGroup(opt.value),
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
    group: classifyAgyModelGroup(m.modelId),
    isDefault: m.modelId === defaultModelId,
    inputModalities: ['text', 'image'],
  }));
  return { models, defaultModelId };
}

function classifyAgyModelGroup(modelId: string): string {
  if (modelId.startsWith('gemini-')) return 'Google Gemini';
  if (modelId.startsWith('claude-')) return 'Anthropic Claude (via AGY)';
  return 'Other Models';
}

async function probeAgyModelsCli(binaryPath: string): Promise<HarnessModelInfo[]> {
  const res = await execCliQuick(binaryPath, ['models'], 8000);
  const models: HarnessModelInfo[] = [];
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Fetching')) continue;
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      models.push({
        id: parts[0].trim(),
        displayName: parts[1].trim(),
        group: classifyAgyModelGroup(parts[0].trim()),
        isDefault: models.length === 0,
      });
    }
  }
  return models;
}

interface PendingAcpApproval {
  rpcId: string | number;
  options: AcpPermissionOption[];
}

class AcpSessionHandle implements AdapterSessionHandle {
  pluginMcpAvailable = false;
  private readonly listeners = new Set<(event: NormalizedAdapterEvent) => void>();
  private readonly earlyBuffer: NormalizedAdapterEvent[] = [];
  private readonly rpc: StdioJsonRpcClient;
  private readonly pendingApprovals = new Map<string, PendingAcpApproval>();
  private _nativeSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private assistantAccum = '';
  private thinkingAccum = '';
  private nativeCommandAbort?: AbortController;
  private nativeCommandTask?: Promise<void>;
  private hasAcpTurn = false;

  // Authoritative server-side model/config state tracked from session/new + set_config_option
  private configOptions: AcpConfigOption[] = [];
  private availableVariantIds = new Set<string>();
  private activeConfirmedModel: string | null = null;
  private activeConfirmedEffort: string | null = null;
  private supportsEmbeddedContext = false;
  private supportsSystemPromptAppend = false;

  constructor(
    child: ReturnType<typeof spawnCliProcess>,
    private readonly config: AdapterSessionConfig,
    private readonly agyBinary?: string,
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

  async initialize(): Promise<void> {
    const initRes = (await this.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'harnessmate-desktop', version: '0.3.0' },
    })) as {
      agentCapabilities?: {
        mcpCapabilities?: { http?: boolean };
        promptCapabilities?: { embeddedContext?: boolean };
        _meta?: { antigravity?: { systemPrompt?: { append?: boolean } } };
      };
    };

    this.supportsEmbeddedContext = Boolean(
      initRes?.agentCapabilities?.promptCapabilities?.embeddedContext,
    );
    this.supportsSystemPromptAppend = Boolean(
      initRes?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append,
    );

    const mcp = this.config.pluginMcp;
    const server = mcp && (initRes?.agentCapabilities?.mcpCapabilities?.http ? {
      type: 'http', name: pluginMcpServerName, url: mcp.url,
      headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }],
    } : pluginMcpStdioConfig(mcp));
    this.pluginMcpAvailable = Boolean(server);
    const requestSession = async (method: string, params: Record<string, unknown>) => {
      if (server && this.pluginMcpAvailable) {
        try {
          return await this.rpc.request<AcpSessionNewResult>(method, { ...params, mcpServers: [server] }, 25_000);
        } catch {
          this.pluginMcpAvailable = false;
          this.emit({ type: 'diagnostic.log', level: 'warn', stream: 'protocol', message: 'ACP 无法挂载会话插件工具，使用原会话能力重试' });
        }
      }
      return this.rpc.request<AcpSessionNewResult>(method, params, 25_000);
    };

    const buildSessionNewParams = (withSystemAppend: boolean): Record<string, unknown> => {
      const base: Record<string, unknown> = {
        cwd: this.config.cwd,
        mcpServers: [],
      };
      if (withSystemAppend && this.supportsSystemPromptAppend && this.config.systemContextPrompt) {
        base._meta = {
          antigravity: {
            systemPrompt: {
              append: this.config.systemContextPrompt.slice(0, 8000),
            },
          },
        };
      }
      return base;
    };

    const createFreshAcpSession = async (): Promise<AcpSessionNewResult | undefined> => {
      if (this.supportsSystemPromptAppend && this.config.systemContextPrompt) {
        try {
          return await requestSession('session/new', buildSessionNewParams(true));
        } catch (err) {
          this.emit({
            type: 'diagnostic.log',
            level: 'warn',
            stream: 'protocol',
            message: `ACP session/new with systemPrompt.append fell back to standard session/new: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      return requestSession('session/new', buildSessionNewParams(false));
    };

    let sessRes: AcpSessionNewResult | undefined;
    if (this.config.nativeSessionId) {
      try {
        const params = {
            sessionId: this.config.nativeSessionId,
            cwd: this.config.cwd,
            mcpServers: [],
        };
        const supportsResume = (initRes.agentCapabilities as {
          sessionCapabilities?: { resume?: unknown };
        } | undefined)?.sessionCapabilities?.resume;
        sessRes = await requestSession(supportsResume ? 'session/resume' : 'session/load', params);
        this._nativeSessionId = this.config.nativeSessionId;
      } catch (err) {
        if (this.config.requireNativeResume) throw err;
        sessRes = await createFreshAcpSession();
        this._nativeSessionId = sessRes?.sessionId ?? null;
      }
    } else {
      sessRes = await createFreshAcpSession();
      this._nativeSessionId = sessRes?.sessionId ?? null;
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

  async updateConfig(patch: Partial<AdapterSessionConfig>): Promise<void> {
    await this.applyRuntimeConfig(patch);
  }

  private ingestSessionMetadata(res: AcpSessionNewResult | undefined): void {
    if (!res) return;
    if (Array.isArray(res.configOptions)) {
      this.configOptions = res.configOptions;
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
  }

  /**
   * Explicitly switches model, thought_level, and mode using ACP's authoritative
   * session/set_config_option (and session/set_model when given a full variant ID),
   * and verifies the server-confirmed value instead of silently ignoring failures.
   */
  private async applyRuntimeConfig(patch: Partial<AdapterSessionConfig>): Promise<void> {
    if (!this._nativeSessionId) return;

    const requestedModel = patch.model ?? undefined;
    const requestedEffort = patch.reasoningEffort ?? undefined;

    if (requestedModel) {
      const modelOpt = this.configOptions.find((c) => c.id === 'model' || c.category === 'model');
      const optionValues = new Set((modelOpt?.options ?? []).map((o) => o.value));

      // Split variant ID (e.g. "gemini-3.8-flash-low") into base model + effort if needed
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
        // Fallback: try session/set_model (for ACP servers that don't expose configOptions or use full variant IDs)
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
        // Apply thought_level if supported for the newly selected model
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

    if (patch.permissionMode) {
      const acpMode = mapPermissionModeToAcpMode(patch.permissionMode);
      if (acpMode) {
        try {
          await this.rpc.request(
            'session/set_mode',
            { sessionId: this._nativeSessionId, modeId: acpMode },
            4000,
          );
        } catch (err) {
          if (this.agyBinary && patch.permissionMode === 'plan') throw err;
          // Older custom ACP servers can omit mode switching.
        }
      }
    }
  }

  private async applyEffortOption(effort: string): Promise<void> {
    if (!this._nativeSessionId) return;
    const effortOpt = this.configOptions.find(
      (c) => c.id === 'thought_level' || c.category === 'thought_level',
    );
    if (!effortOpt) return;
    const allowed = new Set((effortOpt.options ?? []).map((o) => o.value));
    if (allowed.size > 0 && !allowed.has(effort)) return;
    try {
      const res = (await this.rpc.request(
        'session/set_config_option',
        { sessionId: this._nativeSessionId, configId: effortOpt.id, value: effort },
        4000,
      )) as { configOptions?: AcpConfigOption[] };
      if (Array.isArray(res?.configOptions)) {
        this.configOptions = res.configOptions;
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

  async sendTurn(
    input: TurnInput,
  ): Promise<{ driverUsed?: import('@harnessmate/protocol').ContextInjectionDriver }> {
    if (!this._nativeSessionId) {
      throw new Error('ACP session is not initialized');
    }
    if (input.cliCommand && this.agyBinary) {
      const binary = this.agyBinary;
      const command = input.cliCommand;
      const nativeId = this.config.nativeSessionId || this.hasAcpTurn ? this._nativeSessionId : null;
      if (command === '/compact' && !nativeId) throw new Error('当前 AGY 会话还没有可以压缩的上下文');
      const abort = new AbortController();
      this.nativeCommandAbort = abort;
      this.currentTurnId = input.turnId;
      this.emit({ type: 'turn.started', turnId: input.turnId });
      this.nativeCommandTask = runAgyCommand(binary, {
        ...this.config,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode ?? this.config.permissionMode,
      }, command, nativeId, abort.signal).then((result) => {
        if (this.currentTurnId !== input.turnId) return;
        if (nativeId && result.conversation_id && result.conversation_id !== nativeId) {
          throw new Error('AGY 命令返回了不同的原生会话');
        }
        if (result.conversation_id && result.conversation_id !== this._nativeSessionId) {
          this._nativeSessionId = result.conversation_id;
          this.emit({ type: 'native_session_ready', nativeSessionId: result.conversation_id });
        }
        if (result.response) this.emit({ type: 'message.assistant.completed', turnId: input.turnId, text: result.response });
        this.currentTurnId = null;
        this.emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'native_command' });
      }).catch((err: Error) => {
        if (this.currentTurnId !== input.turnId) return;
        this.currentTurnId = null;
        if (abort.signal.aborted) this.emit({ type: 'turn.cancelled', turnId: input.turnId });
        else this.emit({ type: 'turn.failed', turnId: input.turnId, message: err.message });
      }).finally(() => {
        this.nativeCommandAbort = undefined;
        this.nativeCommandTask = undefined;
      });
      return {};
    }

    // Ensure requested model/effort/mode is synced before sending turn
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
    const promptBlocks: Array<Record<string, unknown>> = [];
    let driverUsed: import('@harnessmate/protocol').ContextInjectionDriver | undefined;

    if (input.contextSync) {
      if (this.supportsEmbeddedContext) {
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

    void this.rpc
      .request<{ stopReason?: string }>(
        'session/prompt',
        {
          sessionId: this._nativeSessionId,
          prompt: promptBlocks,
        },
        15 * 60_000,
      )
      .then((res) => {
        this.hasAcpTurn = true;
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
          this.emit({ type: 'turn.completed', turnId, stopReason });
        }
      })
      .catch((err: Error) => {
        const turnId = this.currentTurnId;
        if (!turnId) return;
        this.currentTurnId = null;
        this.emit({ type: 'turn.failed', turnId, message: err.message });
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

      const toolName = String(toolCall.title ?? toolCall.kind ?? 'Tool Permission');
      const toolKind = mapAcpToolKind(String(toolCall.kind ?? ''));
      const diffPreview = extractAcpDiff(toolCall);

      this.pendingApprovals.set(nativeRequestId, { rpcId: req.id, options: rawOptions });
      this.emit({
        type: 'approval.requested',
        turnId,
        nativeRequestId,
        toolName,
        toolKind,
        summary: String(toolCall.title ?? 'Permission requested by ACP agent'),
        input: toolCall.rawInput ?? toolCall,
        diffPreview,
        riskLevel: classifyAcpRisk(toolKind),
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
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const update = (params.update ?? params) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    const turnId = this.currentTurnId ?? 'turn_bg';

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

      default:
        break;
    }
  }
}

function mapPermissionModeToAcpMode(mode: PermissionMode): string | null {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'accept_edits':
      return 'accept-edits';
    case 'manual':
      return 'default';
    case 'auto':
      return 'accept-edits';
    default:
      return null;
  }
}

function mapAcpToolKind(kind: string): ToolKind {
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

function classifyAcpRisk(kind: ToolKind): RiskLevel {
  if (kind === 'shell') return 'high';
  if (kind === 'file_edit') return 'medium';
  return 'low';
}

function pickAcpOption(
  options: AcpPermissionOption[],
  decision: ApprovalDecision,
): AcpPermissionOption | undefined {
  if (options.length === 0) return undefined;
  const preferredKinds =
    decision === 'allow_once'
      ? ['allow_once', 'allow_always']
      : decision === 'allow_session'
        ? ['allow_always', 'allow_once']
        : ['reject_once', 'reject_always'];

  for (const kind of preferredKinds) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match;
  }
  return decision === 'deny' ? options[options.length - 1] : options[0];
}

function extractAcpToolOutput(obj: Record<string, unknown>): string | undefined {
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

function extractAcpDiff(obj: Record<string, unknown>): string | undefined {
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
