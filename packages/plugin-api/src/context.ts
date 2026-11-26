import type {
  ApprovalAnnotateEvent,
  HandoffComposeEvent,
  HandoffComposeSection,
  HandoffOfferDecision,
  HandoffRedactEvent,
  HandoffRedactResult,
  HandoffShouldOfferEvent,
  PluginEventName,
  PluginEventV4,
} from './events.js';
import type { PLUGIN_API_VERSION } from './manifest.js';
import type { PublicSlotRegistration } from './slots.js';
import type { FilePreviewRenderer } from './file-preview.js';

export const pluginErrorCodes = [
  'E_PERMISSION_DENIED', 'E_SERVICE_UNAVAILABLE', 'E_NOT_SUPPORTED', 'E_TIMEOUT',
  'E_INVALID_INPUT', 'E_LIMIT_EXCEEDED', 'E_CONFLICT', 'E_STALE_RUN',
  'E_CIRCULAR_DEPENDENCY',
] as const;
export type PluginErrorCode = typeof pluginErrorCodes[number];

export class PluginApiError extends Error {
  constructor(readonly code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginApiError';
  }
}

export type Disposer = () => void;

export interface PublicSession {
  id: string;
  workspaceId: string;
  harnessId: string;
  harnessKind: string;
  title: string;
  status: string;
  model: string | null;
  permissionMode: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicSessionCapabilities {
  harnessId: string;
  harnessKind: string;
  supportsAttachments: boolean;
  supportsNativeCommands: boolean;
  supportsModelTools: boolean;
}

export interface PublicTaskLedger {
  sessionId: string;
  objective: string;
  steps: Array<{ id: string; title: string; status: string }>;
  decisions: string[];
  touchedFiles: string[];
  blockers: string[];
  pinnedFacts: string[];
  version: number;
  updatedAt: number;
}

export interface PublicTaskLedgerAppend {
  objective?: string;
  decision?: string;
  blocker?: string;
  pinnedFact?: string;
  step?: { title: string; status?: 'pending' | 'in_progress' | 'done' | 'blocked' };
}

export interface PublicHandoffSection {
  id: string;
  order?: number;
  text: string;
}

export interface PublicComposerSuggestion {
  text?: string;
  parts?: Array<{ label: string; text: string }>;
  mode?: 'replace' | 'append';
}

export interface PublicApprovalAnnotationInput {
  risk?: 'low' | 'medium' | 'high';
  label: string;
  detail?: string;
}

export interface PublicCommandInvocation {
  sessionId: string;
  workspaceId: string;
  harnessId: string;
  args: string;
}

export type PublicCommandResult =
  | { kind: 'message'; text: string }
  | { kind: 'compose'; text: string; parts?: Array<{ label: string; text: string }> }
  | { kind: 'native'; command: string; args?: string }
  | { kind: 'none' };

export interface PublicModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  handler: (
    input: Record<string, unknown>,
    meta: { sessionId: string; workspaceId: string },
  ) => Promise<string> | string;
}

export interface PublicFsEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

export interface PublicFsStat {
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

export interface PublicNetInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface PublicNetResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

export interface PublicNetStreamInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  connectTimeoutMs?: number;
  workspaceId?: string;
}

export interface PublicNetStreamHandle {
  readonly streamId: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  onChunk(listener: (chunk: string) => void): Disposer;
  onEnd(listener: () => void): Disposer;
  onError(listener: (message: string) => void): Disposer;
  close(): Promise<void>;
}

export interface PluginEventQuery {
  sessionId: string;
  types?: PluginEventName[];
  afterSeq?: number;
  limit?: number;
}

export interface PluginLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type ServiceImplementation = Record<string, (...args: unknown[]) => unknown>;

export interface PluginContext {
  readonly api: { readonly version: typeof PLUGIN_API_VERSION; has(feature: string): boolean };
  get<Service = unknown>(name: string): Service | undefined;
  on<Name extends PluginEventName>(name: Name, listener: (event: PluginEventV4<Name>) => void | Promise<void>): Disposer;
  effect(activate: () => Disposer): Disposer;
}

export interface IsolatedPluginContext extends PluginContext {
  readonly runId: string;
  readonly pluginId: string;
  readonly logger: PluginLogger;
  provide(name: string, service: ServiceImplementation): Disposer;
  readonly commands: {
    register(command: string, handler: (input: PublicCommandInvocation) => Promise<PublicCommandResult> | PublicCommandResult): Disposer;
  };
  readonly events: {
    on<Name extends PluginEventName>(name: Name, listener: (event: PluginEventV4<Name>) => void | Promise<void>): Disposer;
    query(filter: PluginEventQuery): Promise<PluginEventV4[]>;
  };
  readonly sessions: {
    list(filter?: { workspaceId?: string; harnessId?: string }): Promise<PublicSession[]>;
    get(sessionId: string): Promise<PublicSession | null>;
    capabilities(sessionId: string): Promise<PublicSessionCapabilities | null>;
    prepareTurn(sessionId: string, input: { text: string; parts?: Array<{ label: string; text: string }> }): Promise<{ accepted: boolean }>;
    runNative(sessionId: string, command: string, args?: string): Promise<{ output?: string; notice?: string }>;
  };
  readonly ledger: {
    get(sessionId: string): Promise<PublicTaskLedger | null>;
    append(sessionId: string, entry: PublicTaskLedgerAppend): Promise<PublicTaskLedger>;
  };
  readonly handoff: {
    section(def: PublicHandoffSection): Disposer;
    onCompose(listener: (event: HandoffComposeEvent) => Promise<HandoffComposeSection | HandoffComposeSection[] | void> | HandoffComposeSection | HandoffComposeSection[] | void): Disposer;
    onShouldOffer(listener: (event: HandoffShouldOfferEvent) => Promise<HandoffOfferDecision | boolean | undefined> | HandoffOfferDecision | boolean | undefined): Disposer;
  };
  readonly composer: {
    suggest(sessionId: string, suggestion: PublicComposerSuggestion): Promise<void>;
  };
  readonly approvals: {
    annotate(approvalId: string, note: PublicApprovalAnnotationInput): Promise<void>;
    onAnnotate(listener: (event: ApprovalAnnotateEvent) => Promise<PublicApprovalAnnotationInput | void> | PublicApprovalAnnotationInput | void): Disposer;
  };
  readonly tools: {
    register(tool: PublicModelTool): Disposer;
  };
  readonly slots: {
    register(def: PublicSlotRegistration): Disposer;
  };
  readonly storage: {
    readonly plugin: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
      keys(): Promise<string[]>;
    };
    readonly workspace: {
      get<T = unknown>(workspaceId: string, key: string): Promise<T | undefined>;
      set(workspaceId: string, key: string, value: unknown): Promise<void>;
      delete(workspaceId: string, key: string): Promise<void>;
      keys(workspaceId: string): Promise<string[]>;
    };
  };
  readonly fs: {
    read(workspaceId: string, relativePath: string): Promise<string>;
    list(workspaceId: string, relativePath?: string): Promise<PublicFsEntry[]>;
    stat(workspaceId: string, relativePath: string): Promise<PublicFsStat>;
    write(workspaceId: string, relativePath: string, content: string): Promise<void>;
  };
  readonly net: {
    fetch(url: string, init?: PublicNetInit): Promise<PublicNetResponse>;
  };
  readonly notify: {
    send(input: { title: string; body?: string; level?: 'info' | 'warn' | 'error'; workspaceId?: string }): Promise<void>;
  };
  readonly clipboard: {
    writeText(text: string, workspaceId?: string): Promise<void>;
  };
  onConfigUpdated?(listener: (config: Readonly<Record<string, unknown>>) => void | Promise<void>): Disposer;
}

export type PublicReasoningEffort = 'none' | 'disabled' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type PublicPermissionMode = 'plan' | 'accept_edits' | 'auto' | 'manual';
export type PublicToolKind = 'shell' | 'file_read' | 'file_edit' | 'search' | 'mcp' | 'subagent' | 'web' | 'other';
export type PublicRiskLevel = 'low' | 'medium' | 'high';
export type PublicApprovalDecision = 'allow_once' | 'allow_session' | 'deny';
export type PublicContextInjectionDriver = 'codex_inject_items' | 'acp_embedded_context' | 'claude_sysfile_delta' | 'prompt_envelope' | 'native_warm';
export type PublicHarnessHealth = 'ready' | 'degraded' | 'unavailable' | 'unauthenticated';
export type PublicHarnessTransportKind = 'jsonrpc_stdio' | 'stream_json' | 'acp_stdio' | 'http_sse' | 'sdk' | 'custom';
export type PublicHarnessHistoryInjectionMode = 'native_items' | 'embedded_context' | 'sysfile_delta' | 'inline';

export type PublicProviderOptionDescriptor =
  | {
      key: string;
      label: string;
      description?: string;
      kind: 'select';
      defaultValue?: string;
      options: Array<{ value: string; label: string; description?: string }>;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: 'boolean';
      defaultValue?: boolean;
    }
  | {
      key: string;
      label: string;
      description?: string;
      kind: 'number';
      min?: number;
      max?: number;
      step?: number;
      defaultValue?: number;
    };

export interface PublicHarnessPresentationMeta {
  shortLabel: string;
  accentColor: string;
  softBg: string;
  tagline: string;
  iconSvg?: string;
}

export interface PublicHarnessCapabilities {
  streaming: boolean;
  interactiveApproval: boolean;
  reasoningEfforts: PublicReasoningEffort[];
  permissionModes: PublicPermissionMode[];
  sessionResume: boolean;
  sessionFork: boolean;
  imageInput: boolean;
  subagents: boolean;
}

export interface PublicHarnessCapabilitiesV2 extends PublicHarnessCapabilities {
  transport: PublicHarnessTransportKind;
  historyInjectionMode: PublicHarnessHistoryInjectionMode;
  supportsNativeRollback: boolean;
  supportsActiveSteering: boolean;
  supportsUsageLimits: boolean;
  supportsDynamicOptions: boolean;
  nativeCommands: string[];
  optionDescriptors: PublicProviderOptionDescriptor[];
}

export interface PublicHarnessModelInfo {
  id: string;
  displayName: string;
  description?: string;
  group?: string;
  isDefault?: boolean;
  defaultEffort?: PublicReasoningEffort;
  supportedEfforts?: PublicReasoningEffort[];
  inputModalities?: string[];
}

export interface PublicHarnessDriverDescriptor {
  driverId: string;
  displayName: string;
  description: string;
  protocolLabel: string;
  capabilities: PublicHarnessCapabilities;
  capabilitiesV2?: PublicHarnessCapabilitiesV2;
  presentation?: PublicHarnessPresentationMeta;
  pluginMcpTransport?: 'http' | 'acp';
}

export interface PublicHarnessInstanceInfo {
  id: string;
  driverId: string;
  displayName: string;
  description: string;
  protocolLabel: string;
  enabled: boolean;
  isCustom?: boolean;
}

export interface PublicAdapterSessionConfig {
  cwd: string;
  model?: string | null;
  reasoningEffort?: PublicReasoningEffort | null;
  permissionMode: PublicPermissionMode;
  nativeSessionId?: string | null;
  requireNativeResume?: boolean;
  handoffContinuity?: boolean;
  pluginMcp?: { url: string; token: string };
}

export interface PublicHarnessProbeResult {
  binaryPath: string | null;
  version: string | null;
  health: PublicHarnessHealth;
  healthMessage?: string;
  models: PublicHarnessModelInfo[];
  defaultModelId?: string | null;
  accountSummary?: string | null;
  capabilitiesV2?: PublicHarnessCapabilitiesV2;
  presentation?: PublicHarnessPresentationMeta;
}

export interface PublicPortableHistoryMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
}

export interface PublicDriverContextSyncPayload {
  deltaMarkdown: string;
  portableItems: PublicPortableHistoryMessage[];
  objective?: string;
  isWarmBinding: boolean;
}

export interface PublicDriverTurnInput {
  turnId: string;
  text: string;
  attachments?: Array<{
    id: string;
    kind: 'file_ref' | 'image';
    name: string;
    path?: string;
    relativePath?: string;
    mimeType?: string;
    sizeBytes?: number;
  }>;
  model?: string | null;
  reasoningEffort?: PublicReasoningEffort | null;
  permissionMode?: PublicPermissionMode;
  turnOptions?: Record<string, string | number | boolean>;
  contextSync?: PublicDriverContextSyncPayload | null;
  cliCommand?: string;
  nativeSkill?: { name: string; path: string };
}

export type PublicNormalizedAdapterEvent =
  | { type: 'native_session_ready'; nativeSessionId: string }
  | { type: 'model.confirmed'; actualModel: string; reroutedFrom?: string; reason?: string }
  | { type: 'turn.started'; turnId: string; continuation?: boolean }
  | { type: 'turn.completed'; turnId: string; stopReason?: string }
  | { type: 'turn.failed'; turnId: string; message: string; code?: string; failureClass?: string; resetAt?: number | null }
  | { type: 'turn.cancelled'; turnId: string }
  | { type: 'message.assistant.delta'; turnId: string; text: string; messageId?: string; parentToolUseId?: string }
  | { type: 'message.assistant.completed'; turnId: string; text: string; messageId?: string; parentToolUseId?: string }
  | { type: 'thinking.delta'; turnId: string; text: string }
  | { type: 'thinking.completed'; turnId: string; text: string }
  | {
      type: 'tool.call.started';
      turnId: string;
      toolCallId: string;
      toolName: string;
      toolKind: PublicToolKind;
      summary: string;
      input?: unknown;
      parentToolUseId?: string;
    }
  | {
      type: 'tool.call.delta';
      turnId: string;
      toolCallId: string;
      outputDelta: string;
      diffDelta?: string;
    }
  | {
      type: 'tool.call.completed';
      turnId: string;
      toolCallId: string;
      toolName: string;
      status: 'success' | 'error' | 'cancelled';
      output?: string;
      diff?: string;
    }
  | {
      type: 'approval.requested';
      turnId: string;
      nativeRequestId: string;
      toolName: string;
      toolKind: PublicToolKind;
      summary: string;
      input: unknown;
      diffPreview?: string;
      riskLevel: PublicRiskLevel;
    }
  | {
      type: 'command.output.delta';
      turnId: string;
      toolCallId: string;
      chunk: string;
      stream?: 'stdout' | 'stderr';
    }
  | {
      type: 'turn_block.ext';
      turnId: string;
      itemId: string;
      blockType: `ext:${string}`;
      title: string;
      fallbackSummary: string;
      status?: 'pending' | 'running' | 'completed' | 'failed';
      payload: Record<string, unknown>;
    }
  | {
      type: 'usage.updated';
      turnId: string | null;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens?: number;
        reasoningTokens?: number;
        modelContextWindow?: number;
        costUsd?: number;
      };
    }
  | { type: 'diagnostic.log'; level: 'info' | 'warn' | 'error'; stream: 'stdout' | 'stderr' | 'protocol'; message: string };

export interface PublicRateLimitWindow {
  label: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: number | null;
}

export interface PublicAdapterUsageLimitResult {
  loggedIn: boolean;
  accountLabel: string | null;
  planType: string | null;
  authMethod: string | null;
  billingTier?: 'subscription' | 'api_payg' | 'local_free' | 'unknown';
  gatewayUrl?: string | null;
  rateLimits: PublicRateLimitWindow[];
  error?: string | null;
}

export interface PluginHarnessSessionHandle {
  readonly nativeSessionId?: string | null;
  readonly pluginMcpAvailable?: boolean;
  sendTurn(input: PublicDriverTurnInput): Promise<{ driverUsed?: PublicContextInjectionDriver } | void>;
  listSkills?(): Promise<Array<{ name: string; path?: string; description?: string; enabled?: boolean }>>;
  runNativeCommand?(command: string, args: string): Promise<string>;
  injectContext?(payload: PublicDriverContextSyncPayload): Promise<PublicContextInjectionDriver>;
  interrupt(): Promise<void>;
  resolveApproval(nativeRequestId: string, decision: PublicApprovalDecision, comment?: string): Promise<void>;
  updateConfig?(patch: Partial<PublicAdapterSessionConfig>): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: PublicNormalizedAdapterEvent) => void): Disposer;
}

export interface PluginHarnessDriverRegistration extends PublicHarnessDriverDescriptor {
  probe(): Promise<PublicHarnessProbeResult> | PublicHarnessProbeResult;
  probePassive?(): Promise<PublicHarnessProbeResult> | PublicHarnessProbeResult;
  readUsageLimits?(): Promise<PublicAdapterUsageLimitResult> | PublicAdapterUsageLimitResult;
  createSession(config: PublicAdapterSessionConfig): Promise<PluginHarnessSessionHandle> | PluginHarnessSessionHandle;
}

export interface SpawnCliSpec {
  command: string;
  args: string[];
  cwdWorkspaceId?: string;
  cwdRelativePath?: string;
  cwd?: string;
  extraEnv?: Record<string, string>;
  unsetEnv?: string[];
  timeoutMs?: number;
}

export interface ManagedCliProcessHandle {
  readonly processId: string;
  readonly pid: number;
  writeStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  onStdout(listener: (chunk: string) => void): Disposer;
  onStderr(listener: (chunk: string) => void): Disposer;
  onExit(listener: (info: { code: number | null; signal: string | null }) => void): Disposer;
  wait(): Promise<{ code: number | null; signal: string | null }>;
}

export interface PublicTurnBlock {
  itemId: string;
  schemaVersion: number;
  sessionId: string;
  turnId: string | null;
  seq: number;
  instanceId: string;
  driverId: string;
  blockType: string;
  status: string;
  title: string;
  textBody: string;
  payload: Record<string, unknown>;
  outputOmitted: boolean;
  omittedBytes: number;
  rawRef?: { eventSeq: number; vendorType: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicHarnessBinding {
  sessionId: string;
  harnessId: string;
  harnessKind: string;
  nativeSessionId: string | null;
  lastModel?: string | null;
  lastActualModel?: string | null;
  lastEffort?: string | null;
  syncedUpToSeq: number;
  driverUsed?: string | null;
  updatedAt: number;
}

export interface ListSessionItemsOptions {
  afterSeq?: number;
  beforeSeq?: number;
  types?: string[];
  limit?: number;
  includeOmittedBodies?: boolean;
}

export interface GetSessionItemOptions {
  textOffset?: number;
  maxChars?: number;
}

export interface ForkSessionOptions {
  targetInstanceId?: string;
  title?: string;
  createWorktree?: boolean;
}

export interface SwitchSessionInstanceOptions {
  targetInstanceId: string;
  forceFreshNativeSession?: boolean;
}

export interface PublicSessionNotice {
  level: 'info' | 'warn' | 'error';
  message: string;
  code?: string;
}

export interface ContextHandoffPreviewV2 {
  sessionId: string;
  mode: 'full_session_summary' | 'delta_since_target_last_seen';
  deliveryChannel: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  coveredSeqRange: { fromSeq: number; toSeq: number };
  unsyncedTurnCount: number;
  estimatedChars: number;
  estimatedTokens: number;
  budgetTokens: number;
  syncNeeded: boolean;
  redactionSummary?: { categories: string[]; redactedCount: number };
  renderedPayload: string;
}

export interface ServiceProvideMeta {
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface ServiceProviderDescriptor {
  pluginId: string;
  instanceId: string;
  contract: string;
  version: string;
  metadata?: Record<string, unknown>;
}

export interface PluginRouteRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

export interface PluginRouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ApprovalPolicyRequest {
  sessionId: string;
  workspaceId: string;
  pluginId: string;
  instanceId: string;
  toolName: string;
  readOnly: boolean;
  args: Record<string, unknown>;
}

export interface ApprovalPolicyDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

export interface IsolatedPluginContextV5 extends IsolatedPluginContext {
  readonly instanceId: string;
  provide(name: string, service: ServiceImplementation, meta?: ServiceProvideMeta): Disposer;
  readonly services: {
    list(contract?: string): Promise<ServiceProviderDescriptor[]>;
    call<T = unknown>(contract: string, method: string, args?: unknown[], opts?: { instanceId?: string }): Promise<T>;
  };
  readonly routes: {
    register(
      pathPrefix: string,
      handler: (req: PluginRouteRequest) => Promise<PluginRouteResponse> | PluginRouteResponse,
    ): Disposer;
  };
  readonly harnesses: {
    registerDriver(driver: PluginHarnessDriverRegistration): Disposer;
    listInstances(): Promise<ReadonlyArray<PublicHarnessInstanceInfo>>;
  };
  readonly runtime: {
    /** Whether the user authorized direct system access for this development instance. */
    readonly trustedLocal?: boolean;
    spawnCli(spec: SpawnCliSpec): Promise<ManagedCliProcessHandle>;
  };
  readonly sessions: IsolatedPluginContext['sessions'] & {
    listItems(sessionId: string, opts?: ListSessionItemsOptions): Promise<{ items: PublicTurnBlock[]; nextSeq: number | null }>;
    getItem(sessionId: string, itemId: string, opts?: GetSessionItemOptions): Promise<{
      item: PublicTurnBlock;
      bodyChunk?: string;
      nextTextOffset?: number | null;
    } | null>;
    getBindings(sessionId: string): Promise<ReadonlyArray<PublicHarnessBinding>>;
    fork(sessionId: string, opts?: ForkSessionOptions): Promise<PublicSession>;
    switchInstance(sessionId: string, opts: SwitchSessionInstanceOptions): Promise<void>;
    postNotice(sessionId: string, notice: PublicSessionNotice): Promise<void>;
  };
  readonly handoff: IsolatedPluginContext['handoff'] & {
    onRedact(listener: (input: HandoffRedactEvent) => Promise<HandoffRedactResult> | HandoffRedactResult): Disposer;
    preview(sessionId: string, targetInstanceId: string): Promise<ContextHandoffPreviewV2>;
  };
  readonly net: IsolatedPluginContext['net'] & {
    openStream(url: string, init?: PublicNetStreamInit): Promise<PublicNetStreamHandle>;
  };
  readonly secrets: {
    resolve(secretRef: string): Promise<string | null>;
  };
}

export type Context = IsolatedPluginContextV5;

export interface PluginModule<Ctx extends IsolatedPluginContext = IsolatedPluginContextV5> {
  readonly name?: string;
  readonly inject?: readonly string[];
  readonly optional?: readonly string[];
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  readonly renderFilePreview?: FilePreviewRenderer;
  apply(ctx: Ctx, config: Readonly<Record<string, unknown>>): void | Promise<void>;
}
