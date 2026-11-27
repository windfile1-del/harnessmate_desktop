import type {
  PublicPortableSessionBundleV2,
  ServiceMethodResult,
} from './context.js';
import type {
  SessionHarnessBindingDto,
  SessionRecordDto,
} from './session-contracts.js';

export const SESSION_HANDOFF_CONTRACT = 'session.handoff.v1';
export const SESSION_HANDOFF_CONTRACT_VERSION = '1.0.0';

export const SESSION_COMPRESSION_CONTRACT = 'session.compression.v1';
export const SESSION_COMPRESSION_CONTRACT_VERSION = '1.0.0';

export const SESSION_COLLABORATION_CONTRACT = 'session.collaboration.v1';
export const SESSION_COLLABORATION_CONTRACT_VERSION = '1.0.0';

export const SESSION_ORCHESTRATION_CONTRACT = 'session.orchestration.v1';
export const SESSION_ORCHESTRATION_CONTRACT_VERSION = '1.0.0';

// ── Handoff Contract (`session.handoff.v1`) ───────────────────────────────

export type HandoffDeliveryStateDto = 'pending' | 'confirmed' | 'failed' | 'uncertain';

export interface HandoffRecordDto {
  handoffId: string;
  sessionId: string;
  turnId: string | null;
  fromInstanceId: string | null;
  toInstanceId: string;
  mode: string;
  deliveryChannel: string;
  deliveryStatus: HandoffDeliveryStateDto;
  coveredUpToSeq: number;
  estimatedChars: number;
  redactedCount: number;
  forceFreshReason?: string | null;
  snapshot?: Record<string, unknown> | null;
  createdAt: number;
  deliveredAt?: number | null;
}

export interface CompiledHandoffPacketDto {
  preview: {
    sessionId: string;
    targetHarnessId: string;
    targetHarnessKind: string;
    syncedUpToSeq: number;
    currentLastSeq: number;
    unsyncedTurnCount: number;
    estimatedTokens: number;
    budgetTokens: number;
    driverPlanned: string;
    isWarmBinding: boolean;
    syncNeeded: boolean;
    compiledMarkdown: string;
    ledgerMarkdown: string;
    deltaTurnSummary: Array<{
      turnId: string;
      harnessId: string;
      model?: string | null;
      userPreview: string;
    }>;
  };
  snapshot: Record<string, unknown>;
  deltaMarkdown: string;
  portableItems: Array<{
    type: 'message';
    role: 'user' | 'assistant';
    content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
  }>;
  objective: string;
  coveredUpToSeq: number;
  syncNeeded: boolean;
  forceFreshNativeSession?: boolean;
  forceFreshReason?: 'uncertain_previous_delivery' | 'context_budget_overflow' | null;
  redaction?: {
    redactedCount: number;
    categories: string[];
  };
  omitted?: {
    count: number;
    itemIds: string[];
    mcpPullAvailable: boolean;
    mcpPullInstruction?: string;
  };
  workspaceAnchor?: {
    workspaceDigest: string;
    mutatedSinceTargetLastTurn: boolean;
    mutatedFiles: string[];
  };
}

export interface SessionHandoffServiceV1 {
  getProviderInfo(): Promise<ServiceMethodResult<{ instanceId: string; runId: string; autoAttach: boolean; budgetTokens: number }>>;
  preview(request: {
    sessionId: string;
    targetHarnessId?: string;
    syncMode?: 'auto' | 'full_ledger' | 'delta_only';
  }): Promise<ServiceMethodResult<{ preview: Record<string, unknown> }>>;
  compile(request: {
    sessionId: string;
    targetHarnessId: string;
    targetHarnessKind: string;
    binding?: SessionHarnessBindingDto | null;
    syncMode?: 'auto' | 'full_ledger' | 'delta_only';
    excludeTurnId?: string;
    upToSeq?: number;
    budgetTokens?: number;
    modelContextWindow?: number;
    nativeUsedTokens?: number;
    currentUserText?: string;
  }): Promise<ServiceMethodResult<{ packet: CompiledHandoffPacketDto }>>;
  stagePending(request: {
    sessionId: string;
    targetHarnessId: string;
    turnId?: string | null;
    driver: string;
    fromInstanceId?: string | null;
    coveredUpToSeq: number;
    estimatedChars: number;
    redactedCount: number;
    isWarmBinding: boolean;
    forceFreshNativeSession?: boolean;
    forceFreshReason?: string | null;
    snapshot: Record<string, unknown>;
  }): Promise<ServiceMethodResult<{ handoffId: string }>>;
  confirmDelivery(request: { handoffId: string }): Promise<ServiceMethodResult<{ ok: boolean }>>;
  failDelivery(request: {
    handoffId: string;
    sessionId: string;
    targetHarnessId: string;
    resetBinding?: boolean;
    uncertain?: boolean;
  }): Promise<ServiceMethodResult<{ deliveryStatus: HandoffDeliveryStateDto }>>;
  listHandoffs(request: { sessionId: string; limit?: number }): Promise<ServiceMethodResult<{ handoffs: HandoffRecordDto[] }>>;
  evaluateOffer?(request: {
    sessionId: string;
    harnessId: string;
    message?: string | null;
  }): Promise<ServiceMethodResult<{ decision: unknown }>>;
}

// ── Compression Contract (`session.compression.v1`) ───────────────────────

export interface SessionCompressionServiceV1 {
  isEnabled(): boolean;
  getConfig(): Promise<ServiceMethodResult<{ enabled: boolean; config: Record<string, unknown> }>>;
  updateConfig(patch: Record<string, unknown>): Promise<ServiceMethodResult<{ enabled: boolean; config: Record<string, unknown> }>>;
  getStatus(request: { sessionId: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  compressRange(request: {
    sessionId: string;
    fromSeq?: number;
    toSeq?: number;
    budgetChars?: number;
    forceRecompute?: boolean;
    includeSymbolOutline?: boolean;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  clearCache(request: { sessionId: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  buildSymbolOutline?(request: {
    workspacePath: string;
    filePaths: string[];
    maxChars: number;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;
}

// ── Collaboration Contract (`session.collaboration.v1`) ───────────────────

export interface SideChatMessageDto {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  harnessId: string;
  model?: string | null;
  createdAt: number;
}

export interface SessionCollaborationServiceV1 {
  forkSession(request: {
    sessionId: string;
    targetHarnessId?: string;
    fromTurnSeq?: number;
    title?: string;
    mode?: 'with_context' | 'clean_fork';
    createWorktree?: boolean;
    worktreeBranch?: string;
  }): Promise<ServiceMethodResult<{ session: SessionRecordDto; forkMode: string; handoffPreview?: Record<string, unknown> }>>;
  mergeBack(request: {
    childSessionId: string;
    summary?: string;
    decision?: string;
    pinnedFacts?: string[];
    archiveChild?: boolean;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  getSideChat(request: { sessionId: string }): Promise<ServiceMethodResult<{ messages: SideChatMessageDto[] }>>;
  clearSideChat(request: { sessionId: string }): Promise<ServiceMethodResult<{ ok: boolean }>>;
  sendSideChat(request: {
    sessionId: string;
    text: string;
    harnessId?: string;
    model?: string | null;
  }): Promise<ServiceMethodResult<{ messages: SideChatMessageDto[]; reply: SideChatMessageDto }>>;
  promoteSideChatToFork(request: {
    sessionId: string;
    title?: string;
    targetHarnessId?: string;
    createWorktree?: boolean;
  }): Promise<ServiceMethodResult<{ session: SessionRecordDto; forkMode: string }>>;
  exportSession(request: {
    sessionId: string;
    format: 'markdown' | 'json_bundle';
    redact?: boolean;
  }): Promise<ServiceMethodResult<{
    format: 'markdown' | 'json_bundle';
    filename: string;
    contentType: string;
    content: string | PublicPortableSessionBundleV2;
  }>>;
  importSessionBundle(request: {
    bundle: PublicPortableSessionBundleV2;
    workspaceId?: string;
    titleOverride?: string;
  }): Promise<ServiceMethodResult<{ session: SessionRecordDto }>>;
}

// ── Orchestration Contract (`session.orchestration.v1`) ───────────────────

export interface OrchestratorPolicyDto {
  maxDepth: number;
  maxConcurrent: number;
  defaultTimeoutMs: number;
  worktreePolicy?: 'required_for_write' | 'optional' | 'always';
}

export interface SessionOrchestrationServiceV1 {
  getLimits(): Promise<ServiceMethodResult<OrchestratorPolicyDto>>;
  getBoard(request: { parentSessionId: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  listSubagents(request: {
    parentSessionId: string;
    cohortId?: string;
    status?: string;
  }): Promise<ServiceMethodResult<{ subagents: Array<Record<string, unknown>> }>>;
  getSubagentResult(request: { subagentId: string }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  delegateTask(request: {
    parentSessionId: string;
    targetInstanceId: string;
    roleTitle: string;
    prompt: string;
    isolation?: 'read_only' | 'worktree_write';
    cohortId?: string;
    requestedApprovalPolicy?: string;
    model?: string | null;
    timeoutMs?: number;
    failFast?: boolean;
    baseBranch?: string;
  }): Promise<ServiceMethodResult<{ subagent: Record<string, unknown> }>>;
  sendToSubagent(request: {
    subagentId: string;
    text: string;
  }): Promise<ServiceMethodResult<{ subagent: Record<string, unknown>; turnId: string }>>;
  stopSubagent(request: {
    subagentId: string;
    reason?: string;
    suppressWakeup?: boolean;
  }): Promise<ServiceMethodResult<{ subagent: Record<string, unknown> }>>;
  dryRunMergeSubagent(request: {
    subagentId: string;
    baseBranch?: string;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  mergeSubagent(request: {
    subagentId: string;
    baseBranch?: string;
    confirmMerge: boolean;
    cleanupWorktree?: boolean;
    deleteBranch?: boolean;
    commitMessage?: string;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  cleanupSubagentWorktree(request: {
    subagentId: string;
    deleteBranch?: boolean;
    force?: boolean;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;
  notifyChildTurnCompleted?(childSessionId: string): Promise<void>;
  notifyChildTurnCancelled?(childSessionId: string): Promise<void>;
  notifyChildTurnFailed?(childSessionId: string, message: string): Promise<void>;
  notifyParentSessionIdle?(parentSessionId: string): void;
  notifyChildApproval?(childSessionId: string, approvalId: string, toolName: string): void;
  recoverOrphanedRuns?(): Promise<ServiceMethodResult<{ settledCount: number }>>;
}
