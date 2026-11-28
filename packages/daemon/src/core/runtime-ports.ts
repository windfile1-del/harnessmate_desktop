import type {
  AgyRuntimeBindingDto,
  RequestResolveDto, RequestDelivery, RequestModeReceiptDto, ServiceMethodResult,
  AgyTurnSettlementDecisionDto,
} from '@harnessmate/plugin-api';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CanonicalEvent,
  CanonicalEventType,
  ContextSyncMode,
  PermissionMode,
  ReasoningEffort,
  RuntimeBinding,
  Session,
  TerminalContextChip,
  TurnOptionsMap,
} from '@harnessmate/protocol';
import type { AgyDispatchProvenance } from '../harnesses/agy/native/wiring/provenance.js';
import type { NativeTurnSettlementSink, TurnSettlement } from '../harnesses/agy/native/wiring/types.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  TurnInput,
} from '../harnesses/types.js';
import type { PluginCapabilities, PluginToolLease } from '../plugins/plugin-capabilities.js';
import type { CompiledContextPacket } from './context-compiler.js';

/**
 * Narrow driver port separating concrete harness adapters/drivers (rewritten in W2)
 * from the generic session runtime (`hm.plugin.session-runtime-default`).
 */
export interface DriverResolutionScope {
  sessionId?: string;
  workspaceId?: string;
  driverProviderInstanceId?: string | null;
}

export interface RuntimeDriverPort {
  getAdapter(harnessId: string, scope?: DriverResolutionScope): HarnessAdapter | undefined;
  assertDispatchTarget(
    instanceId: string,
    fallbackKind: string,
    provenance?: AgyDispatchProvenance,
    scope?: DriverResolutionScope,
  ): void;
  openSession(
    harnessId: string,
    config: AdapterSessionConfig,
    scope?: DriverResolutionScope,
  ): Promise<AdapterSessionHandle>;
}

/**
 * Narrow client over public `agy.runtime.v1` DTOs and serializable resource references.
 * Never passes vendor classes or `instanceof` checks across plugin boundaries;
 * in-process hook attachment is resolved strictly inside the owning AGY plugin via `bindingRef`.
 */
export interface NativeRuntimePort {
  isEnabled(scope?: DriverResolutionScope): boolean;
  isNativeLifecycleEnabled(scope?: DriverResolutionScope): boolean;
  hasCancelHook?(scope?: DriverResolutionScope): boolean;
  isNativePermissionsEnabled(scope?: DriverResolutionScope): boolean;
  isObservatoryTapEnabled(scope?: DriverResolutionScope): boolean;
  isSchemaCompatible(scope?: DriverResolutionScope): boolean;
  prepareSessionBinding(params: {
    sessionId: string;
    workspaceId?: string;
    instanceId: string;
    driverProviderInstanceId?: string | null;
    nativeSessionId: string | null;
    sourceRef: string;
  }): {
    binding: RuntimeBinding;
    bindingDto?: AgyRuntimeBindingDto;
    bindingRef?: string;
    providerInstanceId?: string;
    hooks: AdapterSessionConfig['nativeRuntimeHooks'];
  } | null;
  createObservatoryHooks(
    sessionId: string,
    harnessId: string,
    scope?: DriverResolutionScope,
  ): AdapterSessionConfig['nativeRuntimeHooks'] | undefined;
  notifyReconnect(binding: RuntimeBinding, mode: 'resume' | 'fresh', scope?: DriverResolutionScope): void;
  notifyCancelRequested(binding: RuntimeBinding, scope?: DriverResolutionScope): void;
  decideTurnSettlement(
    turnId: string,
    binding: RuntimeBinding | null,
    scope?: DriverResolutionScope,
  ): TurnSettlement | null;
  decideTurnSettlementDto?(
    turnId: string,
    binding: AgyRuntimeBindingDto | null,
    scope?: DriverResolutionScope,
  ): Promise<AgyTurnSettlementDecisionDto | null>;
  getActiveBinding(sessionId: string, scope?: DriverResolutionScope): RuntimeBinding | null;
  bindTurnSettlementSink(sink: NativeTurnSettlementSink): void;
}

/**
 * Narrow bridge for approvals, user questions, and zero-disk secret requests
 * (full migration deferred to Batch 4).
 */
export interface RuntimeRequestPort {
  createAndEmitApproval(params: {
    session: Session;
    harnessId: string;
    turnId: string | null;
    nativeRequestId: string;
    kind: NonNullable<ApprovalRequest['kind']>;
    toolName: string;
    toolKind: ApprovalRequest['toolKind'];
    summary: string;
    input?: Record<string, unknown>;
    diffPreview?: string;
    riskLevel: ApprovalRequest['riskLevel'];
    supportedDecisions?: ApprovalDecision[];
    questionSpec?: ApprovalRequest['questionSpec'];
    secretSpec?: ApprovalRequest['secretSpec'];
    driverGeneration: string;
    providerInstanceId?: string;
    deliver: (input: RequestResolveDto) => Promise<RequestDelivery>;
    onTimeoutDeny?: (approval: ApprovalRequest) => void;
  }): ApprovalRequest;
  expireSessionApprovals(sessionId?: string, onDenied?: (approval: ApprovalRequest) => void): void;
  cancelSessionApprovals(sessionId: string, reason: string, onDenied?: (approval: ApprovalRequest) => void, generation?: string): void;
  countPendingApprovals(sessionId: string): number;
  recordMode(receipt: RequestModeReceiptDto): Promise<ServiceMethodResult<RequestModeReceiptDto>>;
}

/**
 * Narrow bridge for cross-harness collaboration features (task ledger, handoff,
 * checkpoints, failover, orchestrator, and plugin model-tool leases).
 */
export interface CollaborationBridgePort {
  prepareModelTools(
    session: Session,
    harnessId: string,
    adapter: HarnessAdapter,
  ): {
    pluginToolKey: string;
    lease?: PluginToolLease;
    isLeaseActive(lease: PluginToolLease): boolean;
  };
  isOrchestratorEnabled(): boolean;
  prepareTurnText(params: {
    text: string;
    literalText?: boolean;
    mode?: 'plugin_development';
    cliCommand?: string;
    nativeSkill?: { name: string; path: string };
    terminalContexts?: TerminalContextChip[];
  }): {
    effectiveText: string;
    expandedCommand?: string;
    compactTerminalChips?: Array<{
      id: string;
      terminalId: string;
      terminalTitle: string;
      cwd: string;
      lineStart: number;
      lineEnd: number;
      truncated: boolean;
      exitCode: number | null;
    }>;
  };
  prepareTurnHandoff(params: {
    session: Session;
    harnessId: string;
    harnessKind: string;
    binding: Parameters<NonNullable<CollaborationBridgePort['compileContext']>>[0]['binding'];
    upToSeq: number;
    excludeTurnId: string;
    omitHandoff?: boolean;
  }): Promise<CompiledContextPacket | null>;
  compileContext?(params: {
    session: Session;
    targetHarnessId: string;
    targetHarnessKind: string;
    binding: import('@harnessmate/protocol').SessionHarnessBinding | null;
    upToSeq?: number;
    excludeTurnId?: string;
    syncMode?: ContextSyncMode;
  }): Promise<CompiledContextPacket>;
  capturePreTurnCheckpoint(params: {
    sessionId: string;
    workspaceId: string;
    cwd: string;
    turnSeq: number;
  }): Promise<{ treeSha: string; skippedLargeFiles: string[] } | null>;
  capturePostTurnCheckpoint(params: {
    session: Session;
    turnSeq?: number;
    preTurnTreeSha?: string | null;
    maintenance?: boolean;
  }): Promise<{
    checkpointId: string;
    turnSeq: number;
    phase: string;
    treeSha: string;
    gitRef: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
  } | null>;
  syncTaskLedger(session: Session): void;
  notifyOrchestratorTurnCompleted(sessionId: string): void;
  notifyOrchestratorParentIdle(sessionId: string): void;
  notifyOrchestratorTurnCancelled(sessionId: string): void;
  notifyOrchestratorChildApproval(sessionId: string, approvalId: string, toolName: string): void;
  recordFailoverFailure(sessionId: string, harnessId: string, failureClass: string, resetAt?: number): number | null;
  notifyAttention(event: {
    kind: 'session_updated' | 'approval_needed' | 'turn_completed';
    sessionId: string;
    sessionTitle: string;
    harnessId: string;
    summary: string;
    approvalId?: string;
    timestamp: number;
  }): void;
  publishCanonicalEvent(ev: CanonicalEvent): void;
  emitPluginLifecycleEvent(type: 'session.created' | 'session.closing', session: Session): Promise<void>;
}

export interface LegacyRuntimeTurnOptions {
  requestId?: string;
  harnessId?: string;
  model?: string | null;
  turnOptions?: TurnOptionsMap;
  omitHandoff?: boolean;
  literalText?: boolean;
  mode?: 'plugin_development';
  terminalContexts?: TerminalContextChip[];
  dispatchProvenance?: AgyDispatchProvenance;
  expectedNativeHandle?: AdapterSessionHandle;
  verifyNativeDispatch?: () => void;
  nativeSkill?: { name: string; path: string };
  cliCommand?: string;
}

export type TurnEventPublisher = (
  type: CanonicalEventType,
  payload: Record<string, unknown>,
  turnId?: string | null,
) => Promise<void>;

export type { AdapterSessionConfig, AdapterSessionHandle, Attachment, PermissionMode, ReasoningEffort, TurnInput, PluginCapabilities };
