import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ApprovalDecision,
  HarnessCapabilities,
  HarnessInfo,
  HarnessModelInfo,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  ToolKind,
} from '@harnessmate/protocol';
import { buildPromptWithFileAttachments } from './codex-adapter.js';
import {
  ResilientJsonLineParser,
  execCliQuick,
  killProcessTree,
  resolveBinary,
  spawnCliProcess,
} from './process.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NativeSkill,
  NormalizedAdapterEvent,
  TurnInput,
} from './types.js';
import { pluginMcpServerName, pluginMcpTokenEnv } from './types.js';

const FALLBACK_CLAUDE_MODELS: HarnessModelInfo[] = [
  { id: 'sonnet', displayName: 'Claude Sonnet (Default)', group: 'Anthropic Claude', isDefault: true, supportedEfforts: ['low', 'medium', 'high', 'max'] },
  { id: 'opus', displayName: 'Claude Opus (Latest)', group: 'Anthropic Claude', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', displayName: 'Claude Haiku (Fast)', group: 'Anthropic Claude', supportedEfforts: ['low', 'medium'] },
];

export interface ClaudeLocalSettingsProbe {
  models: HarnessModelInfo[];
  defaultModelId: string | null;
  gatewayUrl: string | null;
}

export class ClaudeStreamJsonAdapter implements HarnessAdapter {
  readonly id = 'claude';
  readonly pluginMcpTransport = 'http' as const;
  readonly kind = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly description = 'Anthropic Claude Code CLI via bidirectional stream-json control protocol';
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

  constructor(private readonly binaryOverride?: string) {}

  async probe(): Promise<HarnessInfo> {
    const binaryPath = await resolveBinary('claude', this.binaryOverride);
    const settingsInfo = readClaudeLocalSettings();

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
        healthMessage: 'claude CLI not found in PATH',
        capabilities: this.capabilities,
        models: settingsInfo.models,
        defaultModelId: settingsInfo.defaultModelId,
        accountSummary: null,
      };
    }

    const [verRes, authRes] = await Promise.all([
      execCliQuick(binaryPath, ['--version'], 6000),
      execCliQuick(binaryPath, ['auth', 'status'], 6000),
    ]);
    const text = `${verRes.stdout}\n${verRes.stderr}`.trim();
    const version = text.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? null;

    let accountSummary: string | null = null;
    try {
      const authJson = JSON.parse(authRes.stdout.trim()) as {
        loggedIn?: boolean;
        authMethod?: string;
        apiProvider?: string;
      };
      if (authJson.loggedIn) {
        accountSummary = settingsInfo.gatewayUrl
          ? `${authJson.authMethod ?? 'loggedIn'} · 网关 ${settingsInfo.gatewayUrl}`
          : `${authJson.authMethod ?? 'loggedIn'} (${authJson.apiProvider ?? 'firstParty'})`;
      }
    } catch {
      if (settingsInfo.gatewayUrl) {
        accountSummary = `网关 ${settingsInfo.gatewayUrl}`;
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
      healthMessage: verRes.exitCode === 0 ? undefined : text.slice(0, 200),
      capabilities: this.capabilities,
      models: settingsInfo.models,
      defaultModelId: settingsInfo.defaultModelId,
      accountSummary,
    };
  }

  async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
    const binaryPath = await resolveBinary('claude', this.binaryOverride);
    if (!binaryPath) {
      throw new Error('Claude Code CLI binary not found. Please install claude or configure binary path.');
    }

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

    if (config.model) {
      args.push('--model', config.model);
    }
    if (config.reasoningEffort && config.reasoningEffort !== 'disabled' && config.reasoningEffort !== 'none') {
      args.push('--effort', config.reasoningEffort);
    }
    if (config.nativeSessionId) {
      args.push('--resume', config.nativeSessionId);
    }
    // Always disable static system-prompt snapshotting & inject lightweight continuity rules
    // (safe well under Windows 32KB CreateProcess arg limit; full delta travels cleanly over stdin)
    args.push(
      '--system-prompt-snapshot',
      'off',
      '--append-system-prompt',
      'You are participating in a unified multi-harness session orchestrated by HarnessMate Desktop. Prior turns may have been completed by Codex, AGY, or Claude on the same workspace. Treat any <harnessmate_context_sync> block and .harnessmate/task-ledger.md as authoritative shared memory and task state. Never ask the user to repeat prior context that is already provided.',
    );

    const mcp = config.pluginMcp;
    if (mcp) args.push('--mcp-config', JSON.stringify({ mcpServers: {
      [pluginMcpServerName]: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer ${' + pluginMcpTokenEnv + '}' } },
    } }));
    const child = spawnCliProcess(binaryPath, args, { cwd: config.cwd, env: mcp ? { [pluginMcpTokenEnv]: mcp.token } : undefined });
    return new ClaudeSessionHandle(child, config);
  }
}

export function readClaudeLocalSettings(): ClaudeLocalSettingsProbe {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
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
      const group = classifyClaudeModelGroup(id, cleanLabel);

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

function classifyClaudeModelGroup(id: string, label: string): string {
  if (id.startsWith('auto/') || label.includes('routing group')) return '路由组 (Magpie)';
  if (id.startsWith('codex/')) return 'Codex (via Magpie)';
  if (id.startsWith('workbuddy')) return 'WorkBuddy';
  if (id.startsWith('our-free-model/')) return '免费模型池';
  if (id.includes('/')) return id.split('/')[0]!;
  return 'Anthropic Claude';
}

interface PendingClaudeApproval {
  requestId: string;
  toolInput: unknown;
}

class ClaudeSessionHandle implements AdapterSessionHandle {
  get pluginMcpAvailable(): boolean { return Boolean(this.config.pluginMcp); }
  private readonly listeners = new Set<(event: NormalizedAdapterEvent) => void>();
  private readonly earlyBuffer: NormalizedAdapterEvent[] = [];
  private readonly parser: ResilientJsonLineParser;
  private readonly pendingApprovals = new Map<string, PendingClaudeApproval>();
  private readonly seenToolUseIds = new Set<string>();
  private _nativeSessionId: string | null = null;
  private currentTurnId: string | null = null;
  private assistantAccum = '';
  private thinkingAccum = '';
  private streamedDeltaThisTurn = false;
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
    private readonly config: AdapterSessionConfig,
  ) {
    this._nativeSessionId = config.nativeSessionId ?? null;
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
          if (line.trim()) {
            this.emit({
              type: 'diagnostic.log',
              level: 'info',
              stream: 'stderr',
              message: line.trim(),
            });
          }
        }
      }
    });

    child.on('error', (err) => {
      this.emit({ type: 'diagnostic.log', level: 'error', stream: 'protocol', message: err.message });
      if (this.currentTurnId) {
        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.emit({ type: 'turn.failed', turnId, message: err.message });
      }
    });

    child.on('close', (code, signal) => {
      this.parser.flush();
      this.clearSkillsRequest(new Error('Claude CLI exited before returning its skill catalog'));
      if (this.currentTurnId && !this.disposed) {
        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.emit({
          type: 'turn.failed',
          turnId,
          message: `Claude CLI exited unexpectedly (code=${code}, signal=${signal})`,
        });
      }
    });
  }

  get nativeSessionId(): string | null {
    return this._nativeSessionId;
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

    this.writeJson({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks.length === 1 ? promptText : contentBlocks,
      },
    });

    return { driverUsed: input.contextSync ? 'claude_sysfile_delta' : undefined };
  }

  async interrupt(): Promise<void> {
    if (this.disposed) return;
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
    this.writeJson({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: pending.requestId,
        response: allowed
          ? {
              behavior: 'allow',
              updatedInput:
                pending.toolInput && typeof pending.toolInput === 'object' ? pending.toolInput : {},
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

  private writeJson(obj: Record<string, unknown>): void {
    if (!this.child.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(obj)}\n`, 'utf8');
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
        const event = (msg.event ?? {}) as Record<string, unknown>;
        const evType = String(event.type ?? '');
        const parentToolUseId =
          typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined;

        if (evType === 'content_block_delta') {
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
            this.thinkingAccum += delta.thinking;
            this.emit({ type: 'thinking.delta', turnId, text: delta.thinking });
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
          }
        }
        break;
      }

      case 'assistant': {
        const message = (msg.message ?? {}) as Record<string, unknown>;
        if (typeof message.model === 'string' && message.model) {
          this.emit({ type: 'model.confirmed', actualModel: message.model });
        }
        const content = Array.isArray(message.content) ? message.content : [];
        const parentToolUseId =
          typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined;

        for (const rawBlock of content) {
          if (!rawBlock || typeof rawBlock !== 'object') continue;
          const block = rawBlock as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string' && !this.streamedDeltaThisTurn) {
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
        const requestId = String(msg.request_id ?? `claude_req_${Date.now()}`);
        const request = (msg.request ?? {}) as Record<string, unknown>;
        if (request.subtype === 'can_use_tool') {
          const toolName = String(request.tool_name ?? 'Tool');
          const toolInput = request.input ?? {};
          this.pendingApprovals.set(requestId, { requestId, toolInput });
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
        break;
      }

      case 'result': {
        const activeTurnId = this.currentTurnId;
        this.currentTurnId = null;

        const usage = (msg.usage ?? {}) as Record<string, unknown>;
        this.emit({
          type: 'usage.updated',
          turnId: activeTurnId,
          usage: {
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            cachedTokens: Number(usage.cache_read_input_tokens ?? 0) || undefined,
            costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
          },
        });

        if (!activeTurnId) break;

        if (this.thinkingAccum) {
          this.emit({ type: 'thinking.completed', turnId: activeTurnId, text: this.thinkingAccum });
        }
        if (this.assistantAccum || typeof msg.result === 'string') {
          this.emit({
            type: 'message.assistant.completed',
            turnId: activeTurnId,
            text: this.assistantAccum || String(msg.result ?? ''),
          });
        }

        if (msg.is_error) {
          this.emit({
            type: 'turn.failed',
            turnId: activeTurnId,
            message: typeof msg.result === 'string' ? msg.result : 'Claude turn returned error',
          });
        } else {
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
