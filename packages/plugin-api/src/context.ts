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
import {
  LEGACY_SESSION_DATA_CONTRACT_VERSION,
  SESSION_DATA_CONTRACT_VERSION,
  SESSION_RUNTIME_CONTRACT_VERSION,
} from './session-contracts.js';
import {
  HARNESS_DRIVER_CONTRACT_VERSION,
  type DriverCommandCapability,
  type DriverCommandReceipt,
  type DriverConfigReceipt,
} from './driver-contracts.js';
import {
  SESSION_COLLABORATION_CONTRACT_VERSION,
  SESSION_COMPRESSION_CONTRACT_VERSION,
  SESSION_HANDOFF_CONTRACT_VERSION,
  SESSION_ORCHESTRATION_CONTRACT_VERSION,
} from './collaboration-contracts.js';

export const pluginErrorCodes = [
  'E_PERMISSION_DENIED', 'E_SERVICE_UNAVAILABLE', 'E_NOT_SUPPORTED', 'E_TIMEOUT',
  'E_INVALID_INPUT', 'E_LIMIT_EXCEEDED', 'E_CONFLICT', 'E_STALE_RUN',
  'E_CIRCULAR_DEPENDENCY', 'E_PLUGIN_DISABLED',
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
  harnessId?: string;
  instanceId?: string;
  pluginId?: string;
  displayName: string;
  description: string;
  protocolLabel: string;
  capabilities: PublicHarnessCapabilities;
  capabilitiesV2?: PublicHarnessCapabilitiesV2;
  presentation?: PublicHarnessPresentationMeta;
  pluginMcpTransport?: 'http' | 'acp';
  supportedCommands?: DriverCommandCapability[];
}

export interface PublicHarnessInstanceInfo {
  id: string;
  driverId: string;
  pluginId?: string;
  providerInstanceId?: string;
  runId?: string;
  isDefault?: boolean;
  displayName: string;
  description: string;
  protocolLabel: string;
  enabled: boolean;
  isCustom?: boolean;
  supportedCommands?: DriverCommandCapability[];
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
  | {
      type: 'config.confirmed';
      model?: string | null;
      thoughtLevel?: string | null;
      availableThoughtLevels?: string[];
      modeId?: string | null;
      permissionEnforcement?: 'native' | 'client_guard';
      tierName?: string | null;
    }
  | {
      type: 'commands.updated';
      commands: Array<{ name: string; description?: string; argumentHint?: string }>;
    }
  | { type: 'session.title_updated'; title: string }
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
  steerTurn?(input: PublicDriverTurnInput): Promise<void>;
  listSkills?(): Promise<Array<{ name: string; path?: string; description?: string; enabled?: boolean }>>;
  runNativeCommand?(command: string, args: string): Promise<string | DriverCommandReceipt>;
  injectContext?(payload: PublicDriverContextSyncPayload): Promise<PublicContextInjectionDriver>;
  interrupt(): Promise<void>;
  resolveApproval(nativeRequestId: string, decision: PublicApprovalDecision, comment?: string): Promise<void>;
  updateConfig?(patch: Partial<PublicAdapterSessionConfig>): Promise<DriverConfigReceipt | void>;
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

export type SelectionSource =
  | 'explicit'
  | 'session'
  | 'workspace'
  | 'dependency'
  | 'composition'
  | 'single'
  | 'none';

export interface ServiceCandidate {
  instanceId: string;
  pluginId: string;
  version: string;
}

export type ServiceResolutionV1 = {
  contract: string;
  versionRange: string;
  candidates: ServiceCandidate[];
} & (
  | { instanceId: string; source: Exclude<SelectionSource, 'none'>; status: 'ready' }
  | {
      instanceId: string;
      source: Exclude<SelectionSource, 'none' | 'single'>;
      status: 'disabled' | 'unavailable' | 'incompatible';
    }
  | { instanceId: null; source: 'none'; status: 'unconfigured' | 'selection_required' }
);

export interface ResolveServiceSelectionOptions {
  versionRange?: string;
  sessionId?: string;
  workspaceId?: string;
  callerInstanceId?: string;
  explicitInstanceId?: string;
  allowSingleCandidate?: boolean;
}

export interface ServiceCallOptions {
  instanceId?: string;
  versionRange?: string;
  sessionId?: string;
  workspaceId?: string;
  allowSingleCandidate?: boolean;
}

export function serviceResolutionErrorCode(
  status: Exclude<ServiceResolutionV1['status'], 'ready'>,
): PluginErrorCode {
  switch (status) {
    case 'selection_required':
      return 'E_CONFLICT';
    case 'incompatible':
      return 'E_NOT_SUPPORTED';
    case 'unconfigured':
    case 'disabled':
    case 'unavailable':
      return 'E_SERVICE_UNAVAILABLE';
  }
}

export const HISTORY_SOURCE_CONTRACT_VERSION = '1.0.0';
export const HISTORY_IMPORT_CONTRACT_VERSION = '1.0.0';
export const SESSION_SEARCH_CONTRACT_VERSION = '1.0.0';
export const GIT_WORKSPACE_CONTRACT_VERSION = '1.0.0';
export const GIT_CHECKPOINT_CONTRACT_VERSION = '1.0.0';
export const TERMINAL_WORKSPACE_CONTRACT_VERSION = '1.0.0';
export const TERMINAL_RUNNER_CONTRACT_VERSION = '1.0.0';
export const WORKSPACE_FILES_CONTRACT_VERSION = '1.0.0';
export const SESSION_ATTACHMENTS_CONTRACT_VERSION = '1.0.0';
export const WORKSPACE_RULES_CONTRACT_VERSION = '1.0.0';

export const PEER_CONTRACT_VERSIONS = {
  'history.source.v1': HISTORY_SOURCE_CONTRACT_VERSION,
  'history.import.v1': HISTORY_IMPORT_CONTRACT_VERSION,
  'session.search.v1': SESSION_SEARCH_CONTRACT_VERSION,
  'git.workspace.v1': GIT_WORKSPACE_CONTRACT_VERSION,
  'git.checkpoint.v1': GIT_CHECKPOINT_CONTRACT_VERSION,
  'terminal.workspace.v1': TERMINAL_WORKSPACE_CONTRACT_VERSION,
  'terminal.runner.v1': TERMINAL_RUNNER_CONTRACT_VERSION,
  'workspace.files.v1': WORKSPACE_FILES_CONTRACT_VERSION,
  'session.attachments.v1': SESSION_ATTACHMENTS_CONTRACT_VERSION,
  'workspace.rules.v1': WORKSPACE_RULES_CONTRACT_VERSION,
  'session.data.v1': SESSION_DATA_CONTRACT_VERSION,
  'session.runtime.v1': SESSION_RUNTIME_CONTRACT_VERSION,
  'hm.session-data.v1': LEGACY_SESSION_DATA_CONTRACT_VERSION,
  'harness.driver.v1': HARNESS_DRIVER_CONTRACT_VERSION,
  'harness.driver.codex.v1': HARNESS_DRIVER_CONTRACT_VERSION,
  'harness.driver.claude.v1': HARNESS_DRIVER_CONTRACT_VERSION,
  'harness.driver.acp.v1': HARNESS_DRIVER_CONTRACT_VERSION,
  'harness.driver.agy.v1': HARNESS_DRIVER_CONTRACT_VERSION,
  'session.handoff.v1': SESSION_HANDOFF_CONTRACT_VERSION,
  'session.compression.v1': SESSION_COMPRESSION_CONTRACT_VERSION,
  'session.collaboration.v1': SESSION_COLLABORATION_CONTRACT_VERSION,
  'session.orchestration.v1': SESSION_ORCHESTRATION_CONTRACT_VERSION,
} as const;

export interface ServiceChannelEvent<T = Record<string, unknown>> {
  contract: string;
  instanceId: string;
  runId?: string;
  seq: number;
  emittedAt: number;
  payload: T;
}

export type PeerServiceErrorCode =
  | 'invalid_request'
  | 'source_unreadable'
  | 'not_importable'
  | 'cancelled'
  | 'conflict'
  | 'not_found'
  | 'busy'
  | 'plugin_disabled'
  | 'permission_denied'
  | 'git_required'
  | 'not_supported';

export interface PeerServiceError<Code extends string = PeerServiceErrorCode | (string & {})> {
  code: Code;
  message: string;
}

export type ServiceMethodResult<T, Code extends string = PeerServiceErrorCode | (string & {})> =
  | { ok: true; value: T }
  | { ok: false; error: PeerServiceError<Code> };

export interface HistoryRef {
  sourceInstanceId: string;
  sourceId: string;
  nativeSessionId: string;
}

export interface HistoryWorkspaceHint {
  cwd?: string;
  label?: string;
}

export interface HistorySummary {
  ref: HistoryRef;
  title: string;
  harnessKind: string;
  updatedAt: number;
  workspaceHint?: HistoryWorkspaceHint;
}

export interface HistoryItem {
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

export interface HistorySourceDiscoverRequest {
  query?: string;
  workspaceId?: string;
  fromTs?: number;
  toTs?: number;
  cursor?: string;
  limit?: number;
  refresh?: boolean;
  operationId?: string;
}

export interface HistorySourceDiscoverResponse {
  sessions: HistorySummary[];
  nextCursor: string | null;
}

export interface HistorySourceReadRequest {
  ref: HistoryRef;
  cursor?: string;
  limit?: number;
  operationId?: string;
}

export interface HistorySourceReadResponse {
  ref: HistoryRef;
  items: HistoryItem[];
  nextCursor: string | null;
  readStatus: 'complete' | 'partial';
  warnings: string[];
}

export interface HistorySourceCancelRequest {
  operationId: string;
}

export interface HistorySourceCancelResponse {
  cancelled: boolean;
}

export interface HistorySourceServiceV1 {
  discover(request: HistorySourceDiscoverRequest): Promise<ServiceMethodResult<HistorySourceDiscoverResponse>>;
  read(request: HistorySourceReadRequest): Promise<ServiceMethodResult<HistorySourceReadResponse>>;
  cancel?(request: HistorySourceCancelRequest): Promise<ServiceMethodResult<HistorySourceCancelResponse>>;
}

export interface PublicPortableSessionBundleV2 {
  bundleVersion: 2;
  exportedAt: number;
  redacted: boolean;
  redactionCategories: string[];
  redactedCount: number;
  session: {
    originalId: string;
    title: string;
    harnessId: string;
    harnessKind: string;
    model?: string | null;
    actualModel?: string | null;
    reasoningEffort?: PublicReasoningEffort | null;
    permissionMode: PublicPermissionMode;
    cwd: string;
    participatingHarnesses: string[];
    createdAt: number;
    updatedAt: number;
  };
  taskState?: {
    objective: string;
    steps: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'done' | 'blocked'; ownerHarnessId?: string | null; updatedAt: number }>;
    decisions: string[];
    touchedFiles: string[];
    verifications: Array<{ command: string; status: 'pass' | 'fail' | 'unknown'; summary?: string; harnessId?: string | null; timestamp: number }>;
    blockers: string[];
    pinnedFacts: string[];
    failedAttempts?: Array<{ id: string; summary: string; failureReason: string; relatedFiles?: string[]; harnessInstanceId?: string | null; recordedAt: number }>;
    rollingSummary: string;
    summarizedUpToSeq: number;
    version: number;
    ledgerFilePath?: string | null;
    updatedAt: number;
  } | null;
  items: PublicTurnBlock[];
  events: Array<{
    seq: number;
    type: string;
    turnId: string | null;
    createdAt: number;
    payload: Record<string, unknown>;
  }>;
}

export type ImportInput =
  | { kind: 'native'; ref: HistoryRef; mode: 'attach' | 'mirror' }
  | { kind: 'bundle'; bundle: PublicPortableSessionBundleV2; titleOverride?: string };

export interface HistoryImportPreviewRequest {
  input: ImportInput;
  workspaceId?: string;
  operationId?: string;
}

export interface HistoryImportPreviewResponse {
  input: ImportInput;
  existingSessionId: string | null;
  targetWorkspaceId: string | null;
  importable: boolean;
  items: HistoryItem[];
  readStatus: 'complete' | 'partial';
  warnings: string[];
}

export interface HistoryImportExecuteRequest {
  input: ImportInput;
  workspaceId?: string;
  requestId: string;
  operationId?: string;
}

export interface HistoryImportExecuteResponse {
  sessionId: string;
  disposition: 'created' | 'reused';
  partial: boolean;
  warnings: string[];
}

export interface HistoryImportCancelRequest {
  operationId?: string;
  requestId?: string;
}

export interface HistoryImportServiceV1 {
  preview(request: HistoryImportPreviewRequest): Promise<ServiceMethodResult<HistoryImportPreviewResponse>>;
  import(request: HistoryImportExecuteRequest): Promise<ServiceMethodResult<HistoryImportExecuteResponse>>;
  cancel?(request: HistoryImportCancelRequest): Promise<ServiceMethodResult<{ cancelled: boolean }>>;
}

export interface PublicSessionSearchHighlight {
  start: number;
  end: number;
}

export interface PublicSessionSearchHit {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  turnId: string;
  turnSeq: number;
  itemId: string;
  blockType: string;
  snippetText: string;
  snippetHtmlSafe: string;
  highlights: PublicSessionSearchHighlight[];
  driverId: string;
  createdAt: number;
}

export interface SessionSearchQueryRequest {
  q: string;
  workspaceId?: string;
  driverId?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
  offset?: number;
}

export interface SessionSearchQueryResponse {
  hits: PublicSessionSearchHit[];
  nextOffset: number | null;
  fallbackUsed: boolean;
  tookMs: number;
}

export interface SessionSearchReindexRequest {
  mode?: 'full' | 'incremental' | 'resume';
  jobId?: string;
  workspaceId?: string;
}

export interface SessionSearchReindexResponse {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  indexedCount?: number;
  totalCount?: number;
  cursorSeq?: number;
  snapshotWatermark?: number;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
}

export interface SessionSearchStatusResponse {
  instanceId: string;
  engineKind: string;
  state: 'idle' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  cursorSeq: number;
  latestSourceSeq?: number;
  indexedItems: number;
  indexedSessions: number;
  activeJob: SessionSearchReindexResponse | null;
  lastJob: SessionSearchReindexResponse | null;
  lastError?: string;
}

export interface SessionSearchServiceV1 {
  query(request: SessionSearchQueryRequest): Promise<ServiceMethodResult<SessionSearchQueryResponse>>;
  reindex(request: SessionSearchReindexRequest): Promise<ServiceMethodResult<SessionSearchReindexResponse>>;
  getStatus?(request?: Record<string, never>): Promise<ServiceMethodResult<SessionSearchStatusResponse>>;
  cancelReindex?(request?: { jobId?: string }): Promise<ServiceMethodResult<SessionSearchReindexResponse>>;
  resumeReindex?(request?: { jobId?: string }): Promise<ServiceMethodResult<SessionSearchReindexResponse>>;
}

// ── Batch 2 W1 Workspace Tools Contracts ─────────────────────────────────

export interface PublicGitChangeEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
}

export interface PublicGitStatusSummary {
  isGitRepo: boolean;
  repoRoot: string | null;
  gitCommonDir?: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: PublicGitChangeEntry[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  totalChanged: number;
}

export interface WorkspaceGitStatusLookupRequest {
  workspaceId: string;
  sessionId?: string;
  cwd?: string;
}

export interface WorkspaceGitStatusLookupResult {
  available: boolean;
  reason?: 'disabled' | 'unavailable' | 'unconfigured' | 'not_git_repo';
  instanceId: string | null;
  status: PublicGitStatusSummary | null;
}

export interface NavigateToFileRequest {
  workspaceId?: string;
  sessionId?: string;
  path: string;
  line?: number;
  openInspector?: boolean;
  preserveSession?: boolean;
}

export interface NavigateToFileResult {
  opened: boolean;
  sessionId: string | null;
  workspaceId?: string | null;
  path: string;
  line?: number;
  errorCode?: string;
  message?: string;
}

export interface GitWorktreeEntryDto {
  path: string;
  branch: string | null;
  headSha: string;
  isMain: boolean;
  dirtyCount: number;
  isLocked: boolean;
}

export interface SetupScriptInfoDto {
  exists: boolean;
  relativePath: string | null;
  scriptPath?: string | null;
  sha256: string | null;
  trusted: boolean;
  trustedAt?: number | null;
  content?: string | null;
}

export interface GitWorkspaceServiceV1 {
  getStatus(request: WorkspaceGitStatusLookupRequest): Promise<ServiceMethodResult<WorkspaceGitStatusLookupResult>>;
  inspect(request: { cwd: string; workspaceId?: string }): Promise<
    ServiceMethodResult<{ isGitRepo: boolean; branch: string | null; repoRoot: string | null; gitCommonDir?: string | null }>
  >;
  getFileDiff(request: { cwd: string; filePath: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  getTruthDigest(request: { cwd: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  initRepo(request: { cwd: string; initialCommit?: boolean }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  discardFile(request: { cwd: string; filePath: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  commit(request: { cwd: string; message: string; stageAll?: boolean; files?: string[] }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  push(request: { cwd: string; remote?: string; branch?: string; setUpstream?: boolean }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  pull(request: { cwd: string; remote?: string; branch?: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  createPr(request: { cwd: string; title: string; body?: string; baseBranch?: string; draft?: boolean }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  listWorktrees(request: { repoRoot: string; workspaceId?: string }): Promise<ServiceMethodResult<{ worktrees: GitWorktreeEntryDto[] }>>;
  createWorktree(request: { repoRoot: string; branchName: string; baseBranch?: string; workspaceId?: string }): Promise<ServiceMethodResult<{ worktreePath: string; branch: string }>>;
  removeWorktree(request: { repoRoot: string; worktreePath: string; force?: boolean; prune?: boolean; deleteBranch?: boolean; releaseTerminals?: boolean }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  dryRunMerge(request: { repoRoot: string; sourceBranch: string; targetBranch?: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  getSetupScriptInfo(request: { repoRoot: string }): Promise<ServiceMethodResult<SetupScriptInfoDto>>;
  setSetupScriptTrust(request: { repoRoot: string; trusted: boolean }): Promise<ServiceMethodResult<SetupScriptInfoDto>>;
  runSetupScript(request: { repoRoot: string; targetDir: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
}

export interface GitCheckpointServiceV1 {
  list(request: { sessionId: string; limit?: number }): Promise<ServiceMethodResult<{ checkpoints: Record<string, unknown>[] }>>;
  get(request: { checkpointId: string }): Promise<ServiceMethodResult<{ checkpoint: Record<string, unknown> | null }>>;
  capture(request: { sessionId: string; cwd: string; turnSeq: number; phase: string }): Promise<ServiceMethodResult<{ checkpoint: Record<string, unknown> | null }>>;
  diff(request: { sessionId: string; cwd: string; fromCheckpointId: string; toCheckpointId?: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  revert(request: { sessionId: string; cwd: string; checkpointId: string; mode: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  gc(request: { sessionId: string; cwd: string; keepLatestTurns?: number }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  deleteSession(request: { sessionId: string; cwd?: string }): Promise<ServiceMethodResult<{ removed: number }>>;
}

export interface TerminalPathUsageEntry {
  terminalId: string;
  title: string;
  cwd: string;
  pid?: number;
  instanceId?: string;
}

export interface TerminalPathUsageResult {
  busy: boolean;
  terminals: TerminalPathUsageEntry[];
}

export interface TerminalWorkspaceServiceV1 {
  listTerminals(request: { workspaceId: string; cwd?: string }): Promise<ServiceMethodResult<{ terminals: Record<string, unknown>[]; ptyAvailable: boolean }>>;
  openTerminal(request: { workspaceId: string; cwd: string; sessionId?: string; cols?: number; rows?: number; shell?: string; title?: string }): Promise<ServiceMethodResult<{ terminal: Record<string, unknown> }>>;
  writeInput(request: { terminalId: string; data: string }): Promise<ServiceMethodResult<{ ok: boolean }>>;
  resizeTerminal(request: { terminalId: string; cols: number; rows: number }): Promise<ServiceMethodResult<{ ok: boolean }>>;
  interruptTerminal(request: { terminalId: string }): Promise<ServiceMethodResult<{ ok: boolean }>>;
  restartTerminal(request: { terminalId: string }): Promise<ServiceMethodResult<{ terminal: Record<string, unknown> }>>;
  closeTerminal(request: { terminalId: string }): Promise<ServiceMethodResult<{ closed: boolean }>>;
  buildContextChip(request: { terminalId: string; selectedText?: string; lineStart?: number; lineEnd?: number; recentLines?: number }): Promise<ServiceMethodResult<{ chip: Record<string, unknown> }>>;
  pathUsage(request: { targetPath: string }): Promise<ServiceMethodResult<TerminalPathUsageResult>>;
  releasePath(request: { targetPath: string; workspaceId?: string }): Promise<ServiceMethodResult<{ closedCount: number; terminalIds: string[] }>>;
  getOutputSnapshot(request: { terminalId: string }): Promise<ServiceMethodResult<{ snapshot: string; truncated: boolean; status: string; exitCode: number | null }>>;
}

export interface TerminalRunnerServiceV1 {
  run(request: { sessionId?: string; workspaceId?: string; cwd: string; command: string; timeoutMs?: number; toolCallId?: string }): Promise<
    ServiceMethodResult<{ exitCode: number; stdout: string; stderr: string; output: string; durationMs: number; timedOut?: boolean; backend?: string }>
  >;
}

export interface WorkspaceFilesServiceV1 {
  search(request: { workspaceId?: string; cwd: string; query?: string; limit?: number }): Promise<
    ServiceMethodResult<{ files: Array<{ path?: string; fullPath?: string; name?: string; relativePath: string; sizeBytes: number }> }>
  >;
  read(request: { workspaceId?: string; cwd: string; path: string; line?: number }): Promise<
    ServiceMethodResult<{
      path?: string;
      relativePath: string;
      sizeBytes: number;
      lineCount?: number;
      content: string;
      truncated: boolean;
      isBinary?: boolean;
      previewable?: boolean;
    }>
  >;
}

export interface SessionAttachmentsServiceV1 {
  save(request: { sessionId: string; workspaceId?: string; name: string; mimeType: string; base64: string }): Promise<
    ServiceMethodResult<{ attachment: Record<string, unknown> }>
  >;
  resolveRead(request: { sessionId: string; filename: string }): Promise<
    ServiceMethodResult<{ filePath: string; mimeType: string; sizeBytes: number; legacy?: boolean }>
  >;
}

export interface WorkspaceRulesServiceV1 {
  discover(request: { workspaceId?: string; cwd: string; sessionId?: string }): Promise<
    ServiceMethodResult<{ instructions: Array<Record<string, unknown>> }>
  >;
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
    resolve(contract: string, opts?: ResolveServiceSelectionOptions): Promise<ServiceResolutionV1>;
    call<T = unknown>(contract: string, method: string, args?: unknown[], opts?: ServiceCallOptions): Promise<T>;
    publish?(contract: string, payload: Record<string, unknown>): void;
    subscribe?(contract: string, listener: (event: ServiceChannelEvent) => void): Disposer;
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
    openSession?(harnessId: string, config: PublicAdapterSessionConfig): Promise<PluginHarnessSessionHandle>;
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
