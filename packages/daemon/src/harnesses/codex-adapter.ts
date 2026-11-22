import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ApprovalDecision,
  Attachment,
  HarnessCapabilities,
  HarnessInfo,
  HarnessModelInfo,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  ToolKind,
} from '@harnessmate/protocol';
import { StdioJsonRpcClient, type JsonRpcServerRequest } from './jsonrpc.js';
import { execCliQuick, resolveBinary, spawnCliProcess } from './process.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from './types.js';

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

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly id = 'codex';
  readonly kind = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly description = 'OpenAI Codex CLI via bidirectional app-server JSON-RPC 2.0';
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

  constructor(
    private readonly binaryOverride?: string,
    private readonly extraArgs: string[] = ['app-server', '--stdio'],
  ) {}

  async probe(): Promise<HarnessInfo> {
    const binaryPath = await resolveBinary('codex', this.binaryOverride);
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
        healthMessage: 'codex CLI not found in PATH',
        capabilities: this.capabilities,
        models: [],
        defaultModelId: null,
        accountSummary: null,
      };
    }

    const verRes = await execCliQuick(binaryPath, ['--version'], 6000);
    const combined = `${verRes.stdout}\n${verRes.stderr}`.trim();
    const versionMatch =
      combined.match(/codex-cli\s+([\w.-]+)/i) ?? combined.match(/(\d+\.\d+\.\d+[\w.-]*)/);
    const version = versionMatch?.[1] ?? null;

    let models: HarnessModelInfo[] = [];
    let defaultModelId: string | null = null;
    let accountSummary: string | null = null;

    try {
      const live = await this.probeAppServerMetadata(binaryPath, false);
      models = live.models;
      defaultModelId = live.defaultModelId;
      if (live.account?.email) {
        accountSummary = `${live.account.email}${live.account.planType ? ` · ${live.account.planType}` : ''}`;
      } else if (live.account?.type) {
        accountSummary = `${live.account.type}${live.account.planType ? ` · ${live.account.planType}` : ''}`;
      }
    } catch {
      // Fallback: try reading local config.toml default model if app-server quick probe failed
      const fallbackModel = readCodexConfigDefaultModel();
      if (fallbackModel) {
        defaultModelId = fallbackModel;
        models = [{ id: fallbackModel, displayName: fallbackModel, isDefault: true }];
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
      healthMessage: verRes.exitCode === 0 ? undefined : combined.slice(0, 200),
      capabilities: this.capabilities,
      models,
      defaultModelId,
      accountSummary,
    };
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

    const child = spawnCliProcess(binaryPath, this.extraArgs, { cwd: process.cwd() });
    const rpc = new StdioJsonRpcClient(child, {
      onNotification: () => {},
      onServerRequest: (req) => rpc.respondError(req.id, -32601, 'Not supported during probe'),
      onDiagnostic: () => {},
      onExit: () => {},
    });

    try {
      await rpc.request(
        'initialize',
        { clientInfo: { name: 'harnessmate-probe', version: '0.1.0' }, capabilities: null },
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
          group: classifyCodexModelGroup(id, displayName),
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

      return {
        models,
        defaultModelId,
        account: accountRes?.account ?? null,
        rateLimits,
        usage,
        mcpServers,
      };
    } finally {
      await rpc.dispose();
    }
  }

  async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
    const binaryPath = await resolveBinary('codex', this.binaryOverride);
    if (!binaryPath) {
      throw new Error('Codex CLI binary not found. Please install codex or configure binary path.');
    }

    const child = spawnCliProcess(binaryPath, this.extraArgs, { cwd: config.cwd });
    const handle = new CodexSessionHandle(child, config);
    await handle.initialize();
    return handle;
  }
}

function classifyCodexModelGroup(id: string, displayName: string): string {
  if (id.startsWith('auto/') || displayName.includes('routing group')) return '路由组 (Magpie)';
  if (!id.includes('/')) return 'OpenAI Codex 原生';
  const prefix = id.split('/')[0]!;
  return `第三方 / ${prefix}`;
}

function readCodexConfigDefaultModel(): string | null {
  const candidates = [
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

interface PendingCodexApproval {
  rpcId: string | number;
  method: string;
}

class CodexSessionHandle implements AdapterSessionHandle {
  private readonly listeners = new Set<(event: NormalizedAdapterEvent) => void>();
  private readonly earlyBuffer: NormalizedAdapterEvent[] = [];
  private readonly rpc: StdioJsonRpcClient;
  private readonly pendingApprovals = new Map<string, PendingCodexApproval>();
  private _nativeSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private currentNativeTurnId: string | null = null;
  private activeModel: string | null = null;
  private activeEffort: ReasoningEffort | null = null;
  private activePermissionMode: PermissionMode;
  private assistantAccum = '';
  private thinkingAccum = '';

  constructor(
    child: ReturnType<typeof spawnCliProcess>,
    private readonly config: AdapterSessionConfig,
  ) {
    this.activeModel = config.model ?? null;
    this.activeEffort = config.reasoningEffort ?? null;
    this.activePermissionMode = config.permissionMode;

    this.rpc = new StdioJsonRpcClient(child, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (req) => this.handleServerRequest(req),
      onDiagnostic: (stream, message) =>
        this.emit({ type: 'diagnostic.log', level: 'info', stream, message }),
      onExit: (code, signal) => {
        if (this.currentTurnId) {
          this.emit({
            type: 'turn.failed',
            turnId: this.currentTurnId,
            message: `Codex app-server exited unexpectedly (code=${code}, signal=${signal})`,
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
    await this.rpc.request('initialize', {
      clientInfo: { name: 'harnessmate-desktop', version: '0.3.0' },
      capabilities: { experimentalApi: true },
    });
    this.rpc.notify('initialized');

    const { approvalPolicy, sandbox } = mapPermissionModeToCodex(this.activePermissionMode);

    let resumedOk = false;
    if (this.config.nativeSessionId) {
      try {
        const resumed = (await this.rpc.request('thread/resume', {
          threadId: this.config.nativeSessionId,
          cwd: this.config.cwd,
          model: this.activeModel,
          approvalPolicy,
          sandbox,
        })) as { thread?: { id?: string; model?: string }; threadId?: string; model?: string };
        this._nativeSessionId = resumed?.thread?.id ?? resumed?.threadId ?? this.config.nativeSessionId;
        const confirmedModel = resumed?.model ?? resumed?.thread?.model ?? this.activeModel;
        if (confirmedModel) {
          this.emit({ type: 'model.confirmed', actualModel: confirmedModel });
        }
        resumedOk = true;
      } catch (err) {
        this.emit({
          type: 'diagnostic.log',
          level: 'warn',
          stream: 'protocol',
          message: `Codex thread/resume fallback to thread/start: ${err instanceof Error ? err.message : String(err)}`,
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
      if (this.config.systemContextPrompt) {
        startParams.developerInstructions = this.config.systemContextPrompt;
      }
      const started = (await this.rpc.request('thread/start', startParams)) as {
        thread?: { id?: string; model?: string };
        threadId?: string;
        model?: string;
      };
      this._nativeSessionId = started?.thread?.id ?? started?.threadId ?? null;
      const confirmedModel = started?.model ?? started?.thread?.model ?? this.activeModel;
      if (confirmedModel) {
        this.emit({ type: 'model.confirmed', actualModel: confirmedModel });
      }
    }

    if (this._nativeSessionId) {
      this.emit({ type: 'native_session_ready', nativeSessionId: this._nativeSessionId });
    }
  }

  async injectContext(payload: import('./types.js').ContextSyncPayload): Promise<import('@harnessmate/protocol').ContextInjectionDriver> {
    if (!this._nativeSessionId || payload.codexInjectItems.length === 0) {
      return 'prompt_envelope';
    }
    try {
      await this.rpc.request(
        'thread/inject_items',
        {
          threadId: this._nativeSessionId,
          items: payload.codexInjectItems,
        },
        10_000,
      );
      if (payload.objective) {
        try {
          await this.rpc.request(
            'thread/goal/set',
            {
              threadId: this._nativeSessionId,
              objective: payload.objective.slice(0, 400),
              status: 'active',
            },
            4_000,
          );
        } catch {
          // thread/goal/set is optional enhancement
        }
      }
      this.emit({
        type: 'diagnostic.log',
        level: 'info',
        stream: 'protocol',
        message: `Codex native thread/inject_items succeeded (${payload.codexInjectItems.length} items)`,
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

  async updateConfig(patch: Partial<AdapterSessionConfig>): Promise<void> {
    if (patch.model !== undefined) this.activeModel = patch.model;
    if (patch.reasoningEffort !== undefined) this.activeEffort = patch.reasoningEffort;
    if (patch.permissionMode !== undefined) this.activePermissionMode = patch.permissionMode;
  }

  async sendTurn(input: TurnInput): Promise<{ driverUsed?: import('@harnessmate/protocol').ContextInjectionDriver }> {
    if (!this._nativeSessionId) {
      throw new Error('Codex thread is not initialized');
    }
    this.currentTurnId = input.turnId;
    this.currentNativeTurnId = null;
    this.assistantAccum = '';
    this.thinkingAccum = '';
    this.emit({ type: 'turn.started', turnId: input.turnId });

    const effectiveModel = input.model !== undefined ? input.model : this.activeModel;
    const effectiveEffort =
      input.reasoningEffort !== undefined ? input.reasoningEffort : this.activeEffort;
    const effectiveMode = input.permissionMode ?? this.activePermissionMode;

    const basePromptText = buildPromptWithFileAttachments(input.text, input.attachments);
    const promptText = input.contextSync
      ? `${input.contextSync.deltaMarkdown}\n\n---\n\n${basePromptText}`
      : basePromptText;
    const userInput: Array<Record<string, unknown>> = [
      { type: 'text', text: promptText, text_elements: [] },
    ];
    for (const att of input.attachments ?? []) {
      if (att.kind === 'image' && att.path) {
        userInput.push({ type: 'localImage', path: att.path });
      } else if (att.kind === 'file_ref' && att.path) {
        userInput.push({ type: 'mention', name: att.name, path: att.path });
      }
    }

    const { approvalPolicy } = mapPermissionModeToCodex(effectiveMode);

    const turnParams: Record<string, unknown> = {
      threadId: this._nativeSessionId,
      input: userInput,
      cwd: this.config.cwd,
      approvalPolicy,
    };
    if (effectiveModel) turnParams.model = effectiveModel;
    if (effectiveEffort && effectiveEffort !== 'disabled') turnParams.effort = effectiveEffort;

    const res = (await this.rpc.request('turn/start', turnParams)) as
      | { turn?: { id?: string; model?: string }; turnId?: string }
      | undefined;

    this.currentNativeTurnId = res?.turn?.id ?? res?.turnId ?? null;
    const confirmed = res?.turn?.model ?? effectiveModel;
    if (confirmed) {
      this.emit({ type: 'model.confirmed', actualModel: confirmed });
    }
    return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
  }

  async interrupt(): Promise<void> {
    if (!this._nativeSessionId) return;
    if (this.currentNativeTurnId) {
      try {
        await this.rpc.request(
          'turn/interrupt',
          { threadId: this._nativeSessionId, turnId: this.currentNativeTurnId },
          5000,
        );
      } catch (err) {
        this.emit({
          type: 'diagnostic.log',
          level: 'warn',
          stream: 'protocol',
          message: `turn/interrupt error: ${err instanceof Error ? err.message : String(err)}`,
        });
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
      const diffPreview = typeof params.patch === 'string' ? params.patch : undefined;
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
        if (turn?.id) this.currentNativeTurnId = turn.id;
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
        const patch = typeof params.patch === 'string' ? params.patch : '';
        if (itemId && patch) {
          this.emit({
            type: 'tool.call.delta',
            turnId,
            toolCallId: itemId,
            outputDelta: '',
            diffDelta: patch,
          });
        }
        break;
      }

      case 'item/completed': {
        const item = (params.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? '');
        const itemId = String(item.id ?? '');
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
          const status =
            statusRaw === 'failed' || statusRaw === 'declined'
              ? 'error'
              : statusRaw === 'cancelled'
                ? 'cancelled'
                : 'success';
          const output =
            typeof item.aggregatedOutput === 'string'
              ? item.aggregatedOutput
              : typeof item.output === 'string'
                ? item.output
                : undefined;
          this.emit({
            type: 'tool.call.completed',
            turnId,
            toolCallId: itemId,
            toolName: String(item.tool ?? itemType),
            status,
            output,
          });
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const usage = (params.tokenUsage ?? params.usage ?? params) as Record<string, unknown>;
        const last = (usage.last ?? usage.total ?? usage) as Record<string, unknown>;
        this.emit({
          type: 'usage.updated',
          turnId: this.currentTurnId,
          usage: {
            inputTokens: Number(last.inputTokens ?? last.input_tokens ?? 0),
            outputTokens: Number(last.outputTokens ?? last.output_tokens ?? 0),
            cachedTokens: Number(last.cachedInputTokens ?? last.cached_input_tokens ?? 0) || undefined,
          },
        });
        break;
      }

      case 'turn/completed': {
        const turn = (params.turn ?? {}) as Record<string, unknown>;
        const status = String(turn.status ?? 'completed');
        const activeTurnId = this.currentTurnId;
        this.currentTurnId = null;
        this.currentNativeTurnId = null;
        if (!activeTurnId) break;

        if (status === 'interrupted' || status === 'cancelled') {
          this.emit({ type: 'turn.cancelled', turnId: activeTurnId });
        } else if (status === 'failed') {
          const errMsg =
            typeof (turn.error as { message?: string } | undefined)?.message === 'string'
              ? (turn.error as { message: string }).message
              : 'Codex turn failed';
          this.emit({ type: 'turn.failed', turnId: activeTurnId, message: errMsg });
        } else {
          this.emit({ type: 'turn.completed', turnId: activeTurnId, stopReason: status });
        }
        break;
      }

      case 'error': {
        const errObj = (params.error ?? params) as { message?: string };
        const message = errObj.message ?? 'Unknown Codex error';
        this.emit({ type: 'diagnostic.log', level: 'error', stream: 'protocol', message });
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
