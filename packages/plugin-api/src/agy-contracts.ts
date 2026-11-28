import type { ServiceMethodResult } from './context.js';

export const AGY_RUNTIME_CONTRACT = 'agy.runtime.v1';
export const AGY_RUNTIME_CONTRACT_VERSION = '1.0.0';

export const AGY_ACCOUNTS_CONTRACT = 'agy.accounts.v1';
export const AGY_ACCOUNTS_CONTRACT_VERSION = '1.0.0';

export const AGY_WORKBENCH_CONTRACT = 'agy.workbench.v1';
export const AGY_WORKBENCH_CONTRACT_VERSION = '1.0.0';

/**
 * Distinct identity tuple separating plugin package/instance/run generation from legacy AGY profile IDs
 * and native runtime bindings. Never conflate `pluginInstanceId` with legacy `profileInstanceId`.
 */
export interface AgyProviderIdentity {
  /** Plugin package ID (e.g. `core.harness.agy`, `hm.plugin.agy-driver-lite`). */
  pluginId: string;
  /** Installed/configured plugin instance ID (e.g. `harness-agy`, `harness-agy-work`). */
  pluginInstanceId: string;
  /** Driver provider plugin instance ID (equals `pluginInstanceId` for driver-owning instances). */
  driverProviderInstanceId: string;
  /** Plugin activation/process run generation ID. */
  runId: string;
  /** Legacy AGY profile ID (e.g. `agy`, `agy-work`), preserved for backward compatibility. */
  profileInstanceId: string;
  /** Logical harness ID stored on sessions (e.g. `agy`, `agy-work`, `hm.plugin.agy-driver-lite:agy`). */
  harnessId: string;
  /** Optional native CLI/ACP session ID bound to this provider. */
  nativeSessionId?: string | null;
  /** Optional native runtime binding ID. */
  runtimeId?: string | null;
  /** Optional native runtime binding generation token. */
  generation?: string | null;
}

/**
 * Authoritative stream identity for native runtime event feeds and cursors.
 * Cross-instance or cross-generation sequence numbers must never be compared as one linear stream.
 */
export interface AgyRuntimeStreamIdentity {
  providerInstanceId: string;
  runId: string;
  runtimeId: string;
  generation: string;
  sessionId: string;
  harnessId: string;
}

export interface AgyRuntimeCursor {
  stream: AgyRuntimeStreamIdentity;
  seq: number;
  cursor?: string | null;
}

export function agyRuntimeStreamKey(stream: AgyRuntimeStreamIdentity): string {
  return `${stream.providerInstanceId}::${stream.runId}::${stream.runtimeId}::${stream.generation}::${stream.sessionId}`;
}

export function isSameAgyRuntimeStream(
  a: AgyRuntimeStreamIdentity | null | undefined,
  b: AgyRuntimeStreamIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.providerInstanceId === b.providerInstanceId &&
    a.runId === b.runId &&
    a.runtimeId === b.runtimeId &&
    a.generation === b.generation &&
    a.sessionId === b.sessionId
  );
}

/**
 * Compares two native runtime cursors. Returns `null` if they belong to different provider instances,
 * plugin runs, runtime bindings, or generations so callers always trigger resync instead of reusing seqs.
 */
export function compareAgyRuntimeCursors(
  a: AgyRuntimeCursor | null | undefined,
  b: AgyRuntimeCursor | null | undefined,
): -1 | 0 | 1 | null {
  if (!a || !b || !isSameAgyRuntimeStream(a.stream, b.stream)) {
    return null;
  }
  if (a.seq < b.seq) return -1;
  if (a.seq > b.seq) return 1;
  return 0;
}

export interface AgyRuntimeFeatureFlagsDto {
  enabled: boolean;
  observatoryTap: boolean;
  nativeLifecycle: boolean;
  nativePermissions: boolean;
  nativeCommands: boolean;
  nativeWorkflowObservation: boolean;
  nativeTasksObservation: boolean;
  acpV2Preview: boolean;
}

export interface AgyRuntimeSchemaStatusDto {
  component: string;
  supportedVersion: number;
  storedVersion: number;
  compatible: boolean;
}

export interface AgyRuntimeBindingDto {
  runtimeId: string;
  sessionId: string;
  instanceId: string;
  generation: string;
  driverProviderInstanceId?: string;
  runtimeProviderInstanceId?: string;
  runtimeRunId?: string;
  bindingRevision?: number;
}

export type AgyTurnSettlementAction = 'hold' | 'settle' | 'ignore';

/**
 * Serializable turn settlement decision exchanged across runtime boundaries without passing
 * internal classes or in-process callback functions.
 */
export interface AgyTurnSettlementDecisionDto {
  action: AgyTurnSettlementAction;
  turnId: string;
  binding: AgyRuntimeBindingDto | null;
  reason?: string;
  /** Opaque serializable resource reference for acknowledging/settling a held turn once. */
  settlementRef?: string | null;
  providerInstanceId?: string;
  providerRunId?: string;
}

export interface AgyDispatchProvenanceDto {
  channel:
    | 'human_direct'
    | 'manual_user_switch'
    | 'agy_native_internal'
    | 'hm_orchestrator_delegation'
    | 'hm_orchestrator_wakeup'
    | 'auto_failover'
    | 'plugin_automated';
  actor: 'desktop' | 'mobile' | 'system' | 'plugin';
  issuedAt: number;
  reason?: string;
  /** Opaque kernel-verified marker indicating the caller identity was verified by the host boundary. */
  verifiedByHost?: boolean;
}

export interface AgyProvenanceCheckResultDto {
  allowed: boolean;
  code?: 'CONSUMER_PROVENANCE_BLOCKED';
  reason?: string;
  policyMode: 'strict_consumer_oauth' | 'permissive' | 'custom';
  channel: string;
}

/**
 * W1 temporary narrow legacy approval bridge DTOs.
 * W1 owns native wire protocol, options, bindingRevision, and execution receipts;
 * W2 takes over unified request state, decision truth, timers, and policy evaluation.
 */
export interface AgyNativeRequestOptionDto {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'accept' | 'decline' | 'cancel' | string;
}

export interface AgyLegacyApprovalBridgeRequestDto {
  approvalId: string;
  nativeRequestId: string;
  sessionId: string;
  harnessId: string;
  driverProviderInstanceId: string;
  runtimeProviderInstanceId: string;
  runtimeRunId: string;
  binding: AgyRuntimeBindingDto;
  bindingRevision: number;
  kind: 'command_approval' | 'file_approval' | 'user_question' | 'elicitation' | 'secret_request' | string;
  toolName: string;
  summary: string;
  options: AgyNativeRequestOptionDto[];
  deadlineAtMs: number;
  createdAtMs: number;
  receiptState: 'pending' | 'dispatching' | 'delivered' | 'expired' | 'cancelled' | 'failed' | 'unknown';
  settlementRef?: string | null;
}

export interface AgyLegacyApprovalBridgeResolveInputDto {
  approvalId: string;
  sessionId: string;
  decision?: 'allow' | 'deny' | 'allow_session' | 'cancel';
  selectedOptionId?: string | null;
  answers?: Record<string, unknown>;
  resolvedBy: 'desktop' | 'mobile' | 'policy' | 'timeout' | 'system';
  idempotencyKey: string;
  expectedBindingRevision?: number;
  expectedGeneration?: string;
}

export interface AgyLegacyApprovalBridgeResolveResultDto {
  approvalId: string;
  accepted: boolean;
  conflict?: boolean;
  staleGeneration?: boolean;
  receiptState: 'delivered' | 'cancelled' | 'expired' | 'failed' | 'unknown' | 'already_settled';
  bindingRevision: number;
  generation: string;
  deliveredAtMs?: number | null;
  settlementRef?: string | null;
  note?: string;
}

export interface AgyLegacyApprovalBridgeInfoDto {
  mode: 'w1_temporary_narrow_adapter' | 'unified_requests';
  owner: 'agy.runtime.v1';
  handoffTarget: 'runtime.requests.v1';
  supportsCasResolution: boolean;
  supportsNativeOptions: boolean;
  supportsDeadlines: boolean;
}

export interface AgyRuntimeProviderInfoDto {
  pluginId: string;
  instanceId: string;
  driverProviderInstanceId: string;
  runId: string;
  acceptingCommands: boolean;
  featureFlags: AgyRuntimeFeatureFlagsDto;
  schemaStatus: AgyRuntimeSchemaStatusDto;
  provenancePolicy: 'strict_consumer_oauth' | 'permissive' | 'custom';
  legacyApprovalBridge: AgyLegacyApprovalBridgeInfoDto;
}

export interface AgyPrepareBindingRequest {
  sessionId: string;
  harnessId: string;
  nativeSessionId?: string | null;
  sourceRef: string;
  driverProviderInstanceId?: string;
}

export interface AgyPrepareBindingResponse {
  binding: AgyRuntimeBindingDto;
  /** Serializable reference identifying the prepared runtime hooks/attachment inside the owning plugin. */
  bindingRef: string;
  stream: AgyRuntimeStreamIdentity;
}

/**
 * Public peer service contract (`agy.runtime.v1`) owned by AGY runtime plugins (default or external).
 */
export interface AgyRuntimeServiceV1 {
  getProviderInfo(): Promise<ServiceMethodResult<AgyRuntimeProviderInfoDto>>;

  getSnapshot(request: {
    sessionId: string;
    harnessId?: string;
  }): Promise<ServiceMethodResult<{ snapshot: Record<string, unknown>; provider: AgyProviderIdentity; stream: AgyRuntimeStreamIdentity | null }>>;

  getCapabilities(request: {
    sessionId: string;
    harnessId?: string;
  }): Promise<ServiceMethodResult<{ capabilities: Record<string, unknown>; provider: AgyProviderIdentity }>>;

  readEvents(request: {
    sessionId: string;
    harnessId?: string;
    afterSeq?: number;
    limit?: number;
    cursor?: string;
    generation?: string;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;

  readTimeline(request: {
    sessionId: string;
    scopeKind: 'activity' | 'agent';
    scopeId: string;
    pageToken?: string;
    limit?: number;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;

  readWorkflowResource(request: {
    sessionId: string;
    workflowId: string;
    resource: 'board' | 'phases' | 'logs' | 'artifacts' | string;
    pageToken?: string;
    limit?: number;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;

  submitCommand(request: {
    sessionId: string;
    body: Record<string, unknown>;
    provenance?: AgyDispatchProvenanceDto;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;

  dispatchControl(request: {
    sessionId: string;
    body: Record<string, unknown>;
    provenance?: AgyDispatchProvenanceDto;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;

  getRequestDetails(request: {
    sessionId: string;
    requestId: string;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;

  resolveNativeRequest(request: {
    sessionId: string;
    requestId: string;
    body: Record<string, unknown>;
  }): Promise<ServiceMethodResult<Record<string, unknown>>>;

  listSubagents?(request: {
    sessionId: string;
  }): Promise<ServiceMethodResult<{ subagents: Array<Record<string, unknown>> }>>;

  readSubagentDetail?(request: {
    sessionId: string;
    subagentId: string;
  }): Promise<ServiceMethodResult<{ subagent: Record<string, unknown> | null }>>;

  listArtifacts?(request: {
    sessionId: string;
  }): Promise<ServiceMethodResult<{ artifacts: Array<Record<string, unknown>> }>>;

  readArtifact?(request: {
    sessionId: string;
    name: string;
  }): Promise<ServiceMethodResult<{ artifact: Record<string, unknown> | null }>>;

  getEcosystem?(request: {
    sessionId: string;
  }): Promise<ServiceMethodResult<{ ecosystem: Record<string, unknown> }>>;

  // ── Serializable Runtime Lifecycle & Settlement Seams (no callbacks/classes across processes) ──

  prepareSessionBinding(request: AgyPrepareBindingRequest): Promise<ServiceMethodResult<AgyPrepareBindingResponse>>;

  notifyReconnect(request: {
    binding: AgyRuntimeBindingDto;
    mode: 'resume' | 'fresh';
  }): Promise<ServiceMethodResult<{ ok: true }>>;

  notifyCancelRequested(request: {
    binding: AgyRuntimeBindingDto;
    target?: { type: 'runtime' | 'activity' | 'work' | 'agent' | 'workflow'; id: string };
  }): Promise<ServiceMethodResult<{ ok: true }>>;

  decideTurnSettlement(request: {
    turnId: string;
    binding: AgyRuntimeBindingDto | null;
  }): Promise<ServiceMethodResult<AgyTurnSettlementDecisionDto>>;

  getActiveBinding(request: {
    sessionId: string;
    harnessId?: string;
  }): Promise<ServiceMethodResult<{ binding: AgyRuntimeBindingDto | null }>>;

  acknowledgeSettlement?(request: {
    settlementRef: string;
    turnId: string;
    outcome: 'settled' | 'cancelled' | 'failed';
  }): Promise<ServiceMethodResult<{ acknowledged: boolean }>>;

  verifyDispatchProvenance?(request: {
    harnessId: string;
    driverId: string;
    provenance?: AgyDispatchProvenanceDto | null;
  }): Promise<ServiceMethodResult<AgyProvenanceCheckResultDto>>;
}

// ── Accounts & Auth Service Contract (`agy.accounts.v1`) ────────────────

/**
 * Public auth status DTO. Credentials/tokens/secrets are NEVER returned as plain DTO fields.
 */
export interface AgyAccountAuthStateDto {
  instanceId: string;
  profileInstanceId?: string;
  pluginInstanceId?: string;
  phase: 'idle' | 'starting' | 'awaiting_code' | 'completing' | 'authenticated' | 'error' | 'cancelled' | string;
  flowId?: string | null;
  authUrl?: string | null;
  message?: string | null;
  error?: string | null;
  updatedAt: number;
}

export interface AgyAccountProfileSummaryDto {
  /** Legacy AGY profile ID (e.g. `agy`, `agy-work`). */
  instanceId: string;
  displayName: string;
  description?: string;
  isolationMode: 'official_default' | 'profile_isolated' | string;
  authMethod: string;
  geminiDir?: string;
  appDataDirName?: string;
  binaryPath?: string;
  gcpProject?: string;
  gcpLocation?: string;
  enabled: boolean;
  identity?: Record<string, unknown> | null;
  defaults?: Record<string, unknown>;
}

export interface AgyAccountInstanceDto {
  /** Explicit plugin & profile identity mapping. */
  identity: AgyProviderIdentity;
  profile: AgyAccountProfileSummaryDto;
  authState: AgyAccountAuthStateDto;
  configRevision: number;
}

export interface AgyAccountsServiceV1 {
  getProviderInfo(): Promise<
    ServiceMethodResult<{
      pluginId: string;
      instanceId: string;
      runId: string;
      configRevision: number;
      provenancePolicy: 'strict_consumer_oauth' | 'permissive' | 'custom';
      managedHarnessIds: string[];
    }>
  >;

  listInstances(): Promise<
    ServiceMethodResult<{
      instances: AgyAccountInstanceDto[];
      configRevision: number;
    }>
  >;

  upsertInstance(request: {
    profile: Record<string, unknown>;
  }): Promise<
    ServiceMethodResult<{
      profile: AgyAccountProfileSummaryDto;
      authState: AgyAccountAuthStateDto;
      identity: AgyProviderIdentity;
      configRevision: number;
    }>
  >;

  deleteInstance(request: {
    profileInstanceId: string;
    purgeData?: boolean;
  }): Promise<
    ServiceMethodResult<{
      deleted: boolean;
      instanceId: string;
      configRevision: number;
    }>
  >;

  getAuthState(request: {
    profileInstanceId: string;
  }): Promise<ServiceMethodResult<{ state: AgyAccountAuthStateDto }>>;

  startLogin(request: {
    profileInstanceId: string;
  }): Promise<ServiceMethodResult<{ state: AgyAccountAuthStateDto }>>;

  respondLogin(request: {
    profileInstanceId: string;
    flowId: string;
    codeOrUrl: string;
  }): Promise<ServiceMethodResult<{ state: AgyAccountAuthStateDto }>>;

  cancelLogin(request: {
    profileInstanceId: string;
    flowId?: string;
  }): Promise<ServiceMethodResult<{ state: AgyAccountAuthStateDto }>>;

  logout(request: {
    profileInstanceId: string;
    confirmSharedKeyring?: boolean;
  }): Promise<ServiceMethodResult<{ state: AgyAccountAuthStateDto }>>;
}

// ── Workbench UI Contribution Service Contract (`agy.workbench.v1`) ─────

export type AgyWorkbenchSurfaceId =
  | 'chat'
  | 'runtime'
  | 'subagents'
  | 'swarm'
  | 'boost'
  | 'teamwork'
  | 'dynamic'
  | 'tasks';

export type AgyWorkbenchLayoutMode = 'split' | 'full';

export interface AgyWorkbenchViewStateDto {
  surface: AgyWorkbenchSurfaceId;
  layout: AgyWorkbenchLayoutMode;
  selectedActivityId?: string | null;
  selectedWorkId?: string | null;
  selectedAgentId?: string | null;
  selectedWorkflowId?: string | null;
  revision?: number;
}

export interface AgyWorkbenchEmbeddedRegionDto {
  region: 'session.stage.embedded' | 'composer.actions' | 'inspector.tabs' | 'chat.block' | 'harness.settings' | 'session.sidebar.badge' | 'workspace.pages';
  slotId: string;
  title: string;
  ui: string;
}

export interface AgyWorkbenchServiceV1 {
  getProviderInfo(): Promise<
    ServiceMethodResult<{
      pluginId: string;
      instanceId: string;
      runId: string;
      surfaces: AgyWorkbenchSurfaceId[];
      embeddedRegions: AgyWorkbenchEmbeddedRegionDto[];
    }>
  >;

  readWorkbenchState(request: {
    sessionId: string;
  }): Promise<ServiceMethodResult<{ state: AgyWorkbenchViewStateDto }>>;

  writeWorkbenchState(request: {
    sessionId: string;
    patch: Partial<AgyWorkbenchViewStateDto>;
    sourceId?: string;
  }): Promise<ServiceMethodResult<{ state: AgyWorkbenchViewStateDto }>>;
}
