import type {
  ApprovalDecision,
  Attachment,
  ContextInjectionDriver,
  DailyTokenBucket,
  DiscoveredCliSession,
  HarnessCapabilities,
  HarnessCapabilitiesV2,
  HarnessDriverId,
  HarnessHealth,
  HarnessInfo,
  HarnessKind,
  HarnessModelInfo,
  HarnessPresentationMeta,
  InstanceBillingTier,
  PermissionMode,
  RateLimitWindow,
  ReasoningEffort,
  RiskLevel,
  RuntimeRequestKind,
  SecretRequestSpec,
  TokenUsage,
  ToolKind,
  TurnOptionsMap,
  UserQuestionSpec,
} from '@harnessmate/protocol';
import type { NativeRuntimeHooks } from './agy/native/wiring/types.js';

export interface PortableHistoryMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
}

export interface ContextSyncPayload {
  deltaMarkdown: string;
  /** Vendor-neutral portable structured history items for drivers supporting native_items injection. */
  portableItems: PortableHistoryMessage[];
  objective?: string;
  isWarmBinding: boolean;
  onDispatch?: (driver: ContextInjectionDriver, content: string | PortableHistoryMessage[]) => void;
}

export interface HarnessProbeResult {
  binaryPath: string | null;
  version: string | null;
  health: HarnessHealth;
  healthMessage?: string;
  models: HarnessModelInfo[];
}

export interface AdapterSessionConfig {
  cwd: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  permissionMode: PermissionMode;
  nativeSessionId?: string | null;
  nativeHistorySource?: DiscoveredCliSession['source'];
  nativeHistoryPath?: string;
  requireNativeResume?: boolean;
  handoffContinuity?: boolean;
  onContinuityNotice?: (channel: 'developer_instructions' | 'system_append', text: string) => void;
  pluginMcp?: PluginMcpConnection;
  /** Optional dependency-injected native runtime hooks (AGY Native Parity). Inert/omitted for other harnesses. */
  nativeRuntimeHooks?: NativeRuntimeHooks;
}

export const handoffContinuityNotice =
  'HarnessMate may include recorded workspace activity from another CLI in the user conversation. Use it as context for the current request.';

export interface PluginMcpConnection {
  url: string;
  token: string;
}

export const pluginMcpServerName = 'harnessmate_session_tools';
export const pluginMcpTokenEnv = 'HARNESSMATE_SESSION_MCP_TOKEN';

export interface TurnInput {
  turnId: string;
  text: string;
  attachments?: Attachment[];
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  permissionMode?: PermissionMode;
  turnOptions?: TurnOptionsMap;
  contextSync?: ContextSyncPayload | null;
  cliCommand?: string;
  nativeSkill?: { name: string; path: string };
}

export interface NativeSkill {
  name: string;
  path?: string;
  description?: string;
  enabled?: boolean;
}

export type NormalizedAdapterEvent =
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
      toolKind: ToolKind;
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
      kind?: RuntimeRequestKind;
      toolName: string;
      toolKind: ToolKind;
      summary: string;
      input: unknown;
      diffPreview?: string;
      riskLevel: RiskLevel;
      supportedDecisions?: string[];
      securityWarning?: string;
      questionSpec?: UserQuestionSpec;
      secretSpec?: SecretRequestSpec;
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
  | { type: 'usage.updated'; turnId: string | null; usage: TokenUsage }
  | { type: 'diagnostic.log'; level: 'info' | 'warn' | 'error'; stream: 'stdout' | 'stderr' | 'protocol'; message: string };

export interface AdapterSessionHandle {
  readonly nativeSessionId: string | null;
  readonly pluginMcpAvailable?: boolean;
  sendTurn(input: TurnInput): Promise<{ driverUsed?: ContextInjectionDriver } | void>;
  listSkills?(): Promise<NativeSkill[]>;
  /** Vendor-neutral native command execution (replaces vendor-specific handle methods such as runCodexGoal). */
  runNativeCommand?(command: string, args: string): Promise<string>;
  injectContext?(payload: ContextSyncPayload): Promise<ContextInjectionDriver>;
  interrupt(): Promise<void>;
  resolveApproval(nativeRequestId: string, decision: ApprovalDecision, comment?: string): Promise<void>;
  /** Optional zero-log in-memory channel for secret_request delivery directly to harness stdin/memory. */
  resolveSecret?(nativeRequestId: string, secretValue: string): Promise<void>;
  /** Optional structured answer delivery for user_question requests. */
  resolveQuestion?(nativeRequestId: string, answer: { selectedOptionIds?: string[]; freeText?: string }): Promise<void>;
  updateConfig?(patch: Partial<AdapterSessionConfig>): Promise<void>;
  /** Mid-turn non-cancelling steering input (supported on versions advertising supportsActiveSteering). */
  steerTurn?(input: TurnInput): Promise<void>;
  /** True when non-daemon background processes or scheduled timers keep the native session alive. */
  hasActiveBackgroundWork?(): boolean;
  /** Optional structured retention reasons keeping the handle alive in the warm pool (AGY Native Parity). */
  listRetentionReasons?(): string[];
  /** Optional transport connection identifier for native runtime correlation. */
  getConnectionId?(): string | null;
  /** Optional hook called by SessionManager when a held native turn is released for single settlement. */
  releaseHeldTurn?(turnId: string): void;
  dispose(): Promise<void>;
  onEvent(listener: (event: NormalizedAdapterEvent) => void): () => void;
}

export interface AdapterUsageLimitResult {
  loggedIn: boolean;
  accountLabel: string | null;
  planType: string | null;
  authMethod: string | null;
  billingTier?: InstanceBillingTier;
  gatewayUrl?: string | null;
  rateLimits: RateLimitWindow[];
  resetCreditsAvailable?: number;
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  currentStreakDays?: number;
  dailyBuckets?: DailyTokenBucket[];
  error?: string | null;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly kind: HarnessKind;
  readonly driverId?: HarnessDriverId;
  readonly continuationKey?: string;
  readonly displayName: string;
  readonly description: string;
  readonly protocolLabel: string;
  readonly capabilities: HarnessCapabilities;
  readonly capabilitiesV2?: HarnessCapabilitiesV2;
  readonly presentation?: HarnessPresentationMeta;
  readonly isCustom?: boolean;
  readonly pluginMcpTransport?: 'http' | 'acp';

  /** Passive health check: must NOT spawn stateful sessions or create side effects. */
  probePassive?(): Promise<HarnessInfo>;
  probe(): Promise<HarnessInfo>;
  /** Optional standard driver hook for reading account auth & rate-limit windows on demand. */
  readUsageLimits?(): Promise<AdapterUsageLimitResult>;
  createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle>;
}
