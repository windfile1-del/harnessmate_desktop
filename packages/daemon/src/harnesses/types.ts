import type {
  ApprovalDecision,
  Attachment,
  ContextInjectionDriver,
  DiscoveredCliSession,
  HarnessCapabilities,
  HarnessHealth,
  HarnessInfo,
  HarnessKind,
  HarnessModelInfo,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  TokenUsage,
  ToolKind,
} from '@harnessmate/protocol';

export interface ContextSyncPayload {
  deltaMarkdown: string;
  codexInjectItems: Array<{
    type: 'message';
    role: 'user' | 'assistant';
    content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
  }>;
  objective?: string;
  isWarmBinding: boolean;
  onDispatch?: (driver: ContextInjectionDriver, content: string | ContextSyncPayload['codexInjectItems']) => void;
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
  | { type: 'turn.started'; turnId: string; continuation?: boolean }
  | { type: 'turn.completed'; turnId: string; stopReason?: string }
  | { type: 'turn.failed'; turnId: string; message: string; code?: string }
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
      toolName: string;
      toolKind: ToolKind;
      summary: string;
      input: unknown;
      diffPreview?: string;
      riskLevel: RiskLevel;
    }
  | { type: 'usage.updated'; turnId: string | null; usage: TokenUsage }
  | { type: 'diagnostic.log'; level: 'info' | 'warn' | 'error'; stream: 'stdout' | 'stderr' | 'protocol'; message: string };

export interface AdapterSessionHandle {
  readonly nativeSessionId: string | null;
  readonly pluginMcpAvailable?: boolean;
  sendTurn(input: TurnInput): Promise<{ driverUsed?: ContextInjectionDriver } | void>;
  listSkills?(): Promise<NativeSkill[]>;
  runCodexGoal?(args: string): Promise<string>;
  injectContext?(payload: ContextSyncPayload): Promise<ContextInjectionDriver>;
  interrupt(): Promise<void>;
  resolveApproval(nativeRequestId: string, decision: ApprovalDecision, comment?: string): Promise<void>;
  updateConfig?(patch: Partial<AdapterSessionConfig>): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: NormalizedAdapterEvent) => void): () => void;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly kind: HarnessKind;
  readonly displayName: string;
  readonly description: string;
  readonly protocolLabel: string;
  readonly capabilities: HarnessCapabilities;
  readonly isCustom?: boolean;
  readonly pluginMcpTransport?: 'http' | 'acp';

  probe(): Promise<HarnessInfo>;
  createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle>;
}
