import type {
  HistoryImportExecuteRequest,
  HistoryImportExecuteResponse,
  HistoryRef,
  PublicDriverTurnInput,
  PublicPermissionMode,
  PublicPortableSessionBundleV2,
  PublicReasoningEffort,
  PublicTurnBlock,
  ServiceMethodResult,
} from './context.js';

export const SESSION_DATA_CONTRACT = 'session.data.v1';
export const SESSION_DATA_CONTRACT_VERSION = '1.0.0';

export const SESSION_RUNTIME_CONTRACT = 'session.runtime.v1';
export const SESSION_RUNTIME_CONTRACT_VERSION = '1.0.0';

export const LEGACY_SESSION_DATA_CONTRACT = 'hm.session-data.v1';
export const LEGACY_SESSION_DATA_CONTRACT_VERSION = '1.0.0';

/**
 * Identifies a concrete data stream owned by a specific `session.data.v1` provider instance.
 * Sequence numbers (`seq`, `changeSeq`, `watermarkSeq`) are ONLY comparable within the same stream.
 */
export interface SessionDataStreamIdentity {
  providerInstanceId: string;
  streamId: string;
  runId?: string;
}

export interface SessionDataCursor {
  providerInstanceId: string;
  streamId: string;
  seq: number;
}

export function sessionDataStreamKey(stream: SessionDataStreamIdentity): string {
  return `${stream.providerInstanceId}::${stream.streamId}`;
}

export function isSameSessionDataStream(
  a: SessionDataStreamIdentity,
  b: SessionDataStreamIdentity,
): boolean {
  return a.providerInstanceId === b.providerInstanceId && a.streamId === b.streamId;
}

/**
 * Compares two cursors if and only if they belong to the same provider instance & stream.
 * Returns `null` when cursors come from different streams so callers never compare foreign seqs.
 */
export function compareSessionDataCursors(
  a: SessionDataCursor,
  b: SessionDataCursor,
): number | null {
  if (!isSameSessionDataStream(a, b)) return null;
  return a.seq - b.seq;
}

export interface SessionRuntimeGenerationRef {
  runtimeInstanceId: string;
  runtimeRunId: string;
  dataInstanceId: string;
  dataStreamId?: string;
  driverProviderInstanceId?: string;
  harnessId: string;
  turnGeneration: number;
}

// ── Session Data DTOs ───────────────────────────────────────────────────

export interface SessionWorkspaceDto {
  id: string;
  name: string;
  rootPath: string;
  isGitRepo: boolean;
  gitBranch?: string | null;
  createdAt: number;
}

export interface SessionTokenUsageDto {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  contextTokens?: number;
  modelContextWindow?: number;
  cacheReadTokens?: number;
}

export interface SessionRecordDto {
  id: string;
  workspaceId: string;
  harnessId: string;
  harnessKind: string;
  nativeSessionId: string | null;
  parentSessionId?: string | null;
  forkedFromTurnSeq?: number | null;
  forkMode?: 'with_context' | 'clean_fork' | null;
  importMode?: 'attach' | 'mirror' | null;
  importSource?: string | null;
  participatingHarnesses?: string[];
  contextSyncMode?: 'auto' | 'full_ledger' | 'delta_only';
  cwd: string;
  worktreeBranch?: string | null;
  title: string;
  status: string;
  model: string | null;
  actualModel?: string | null;
  modelReroutedReason?: string | null;
  reasoningEffort: PublicReasoningEffort | null;
  permissionMode: PublicPermissionMode;
  lastSeq: number;
  usage: SessionTokenUsageDto | null;
  pendingApprovalCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionCanonicalEventDto {
  sessionId: string;
  seq: number;
  type: string;
  turnId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SessionRunRecordDto {
  runId: string;
  sessionId: string;
  turnId: string;
  instanceId: string;
  driverId: string;
  model?: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  failureClass?: string | null;
  usage?: SessionTokenUsageDto | null;
  startedAt: number;
  endedAt?: number | null;
}

export interface SessionHarnessBindingDto {
  sessionId: string;
  harnessId: string;
  harnessKind: string;
  nativeSessionId: string | null;
  lastModel?: string | null;
  lastActualModel?: string | null;
  lastEffort?: PublicReasoningEffort | null;
  syncedUpToSeq: number;
  driverUsed?: string | null;
  updatedAt: number;
}

export interface SessionTurnReceiptDto {
  sessionId: string;
  requestId: string;
  requestHash: string;
  turnId: string;
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  runtimeInstanceId: string;
  runtimeRunId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionUsageAggregateDto {
  harnessId: string;
  instanceId: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  dailyBuckets: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  }>;
}

export type SessionChangeKindV1 = 'upsert_item' | 'upsert_session' | 'delete_session' | 'delete_item';

export interface SessionSearchSnapshotItemDto {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  itemId: string;
  turnId: string;
  turnSeq: number;
  driverId: string;
  blockType: string;
  textBody: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionCommittedSummaryDto {
  id: string;
  workspaceId: string;
  title: string;
  harnessId: string;
  harnessKind: string;
  status: string;
  updatedAt: number;
}

export interface SessionCommittedChangeDto {
  changeSeq: number;
  kind: SessionChangeKindV1;
  sessionId: string;
  workspaceId: string;
  itemId: string | null;
  committedAt: number;
  item?: SessionSearchSnapshotItemDto | null;
  session?: SessionCommittedSummaryDto | null;
}

export interface SessionSearchSnapshotResponseV1 {
  snapshotId: string;
  stream: SessionDataStreamIdentity;
  watermarkSeq: number;
  cursor: SessionDataCursor;
  items: SessionSearchSnapshotItemDto[];
  nextCursor: string | null;
}

export interface SessionCommittedChangesResponseV1 {
  stream: SessionDataStreamIdentity;
  changes: SessionCommittedChangeDto[];
  latestSeq: number;
  cursor: SessionDataCursor;
  hasMore: boolean;
}

export interface SessionEventsPageResponseV1 {
  sessionId: string;
  stream: SessionDataStreamIdentity;
  events: SessionCanonicalEventDto[];
  lastSeq: number;
  nextAfterSeq: number | null;
  hasMore: boolean;
}

export interface SessionUpdatePatchDto {
  title?: string;
  harnessId?: string;
  harnessKind?: string;
  nativeSessionId?: string | null;
  participatingHarnesses?: string[];
  contextSyncMode?: 'auto' | 'full_ledger' | 'delta_only';
  status?: string;
  model?: string | null;
  actualModel?: string | null;
  modelReroutedReason?: string | null;
  reasoningEffort?: PublicReasoningEffort | null;
  permissionMode?: PublicPermissionMode;
  usage?: SessionTokenUsageDto | null;
  worktreeBranch?: string | null;
  cwd?: string;
}

export interface SessionDataCommitBatchRequest {
  sessionId: string;
  sessionPatch?: SessionUpdatePatchDto;
  events?: Array<{
    type: string;
    turnId?: string | null;
    payload: Record<string, unknown>;
    createdAt?: number;
  }>;
  turnItems?: Array<
    Omit<PublicTurnBlock, 'sessionId' | 'seq'> & {
      seq?: number;
    }
  >;
  runStart?: SessionRunRecordDto;
  runFinish?: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    failureClass?: string | null;
    usage?: SessionTokenUsageDto | null;
    endedAt?: number;
  };
  bindingUpsert?: SessionHarnessBindingDto;
  settleRunningItemsStatus?: 'completed' | 'interrupted' | 'cancelled';
  turnReceipt?: SessionTurnReceiptDto;
}

export interface SessionDataCommitBatchResult {
  stream: SessionDataStreamIdentity;
  session: SessionRecordDto | null;
  committedEvents: SessionCanonicalEventDto[];
  latestSeq: number;
  changeSeq: number;
}

export interface SessionDataChannelEvent {
  kind: 'events_committed' | 'session_changed' | 'session_deleted' | 'workspace_changed';
  stream: SessionDataStreamIdentity;
  changeSeq: number;
  sessionId?: string;
  workspaceId?: string;
  events?: SessionCanonicalEventDto[];
}

export interface SessionDataServiceV1 {
  getStreamInfo(): Promise<
    ServiceMethodResult<{
      stream: SessionDataStreamIdentity;
      latestChangeSeq: number;
      writable: boolean;
    }>
  >;

  // Workspaces
  listWorkspaces(): Promise<ServiceMethodResult<{ workspaces: SessionWorkspaceDto[]; stream: SessionDataStreamIdentity }>>;
  getWorkspace(req: { workspaceId: string }): Promise<ServiceMethodResult<{ workspace: SessionWorkspaceDto | null }>>;
  getWorkspaceByPath(req: { rootPath: string }): Promise<ServiceMethodResult<{ workspace: SessionWorkspaceDto | null }>>;
  createWorkspace(req: {
    id?: string;
    name: string;
    rootPath: string;
    isGitRepo?: boolean;
    gitBranch?: string | null;
    createdAt?: number;
  }): Promise<ServiceMethodResult<{ workspace: SessionWorkspaceDto; created: boolean }>>;
  updateWorkspaceGit(req: {
    workspaceId: string;
    isGitRepo: boolean;
    gitBranch: string | null;
  }): Promise<ServiceMethodResult<{ workspace: SessionWorkspaceDto | null }>>;
  deleteWorkspace(req: { workspaceId: string }): Promise<ServiceMethodResult<{ deleted: boolean }>>;

  // Sessions
  listSessions(req?: {
    workspaceId?: string;
    harnessId?: string;
    includeArchived?: boolean;
  }): Promise<ServiceMethodResult<{ sessions: SessionRecordDto[]; stream: SessionDataStreamIdentity }>>;
  getSession(req: { sessionId: string }): Promise<ServiceMethodResult<{ session: SessionRecordDto | null }>>;
  createSession(req: {
    session: Omit<SessionRecordDto, 'id' | 'lastSeq' | 'usage' | 'pendingApprovalCount' | 'createdAt' | 'updatedAt'> & {
      id?: string;
      lastSeq?: number;
      usage?: SessionTokenUsageDto | null;
      pendingApprovalCount?: number;
      createdAt?: number;
      updatedAt?: number;
    };
  }): Promise<ServiceMethodResult<{ session: SessionRecordDto; stream: SessionDataStreamIdentity }>>;
  updateSession(req: {
    sessionId: string;
    patch: SessionUpdatePatchDto;
  }): Promise<ServiceMethodResult<{ session: SessionRecordDto | null }>>;
  deleteSession(req: { sessionId: string }): Promise<ServiceMethodResult<{ deleted: boolean }>>;

  // Events & Turn Blocks & Atomic Commits
  listEvents(req: {
    sessionId: string;
    afterSeq?: number;
    throughSeq?: number;
    turnId?: string;
    limit?: number;
  }): Promise<ServiceMethodResult<SessionEventsPageResponseV1>>;
  appendEvent(req: {
    sessionId: string;
    type: string;
    turnId?: string | null;
    payload: Record<string, unknown>;
    createdAt?: number;
  }): Promise<ServiceMethodResult<{ event: SessionCanonicalEventDto; stream: SessionDataStreamIdentity }>>;
  listTurnItems(req: {
    sessionId: string;
    afterSeq?: number;
    beforeSeq?: number;
    turnId?: string;
    blockTypes?: string[];
    limit?: number;
  }): Promise<ServiceMethodResult<{ items: PublicTurnBlock[]; nextSeq: number | null; stream: SessionDataStreamIdentity }>>;
  getTurnItem(req: {
    sessionId: string;
    itemId: string;
    textOffset?: number;
    maxChars?: number;
  }): Promise<
    ServiceMethodResult<{
      item: PublicTurnBlock;
      text: string;
      totalChars: number;
      textOffset: number;
      nextTextOffset: number | null;
      hasMore: boolean;
    } | null>
  >;
  upsertTurnItem(req: { item: PublicTurnBlock }): Promise<ServiceMethodResult<{ item: PublicTurnBlock }>>;
  settleRunningTurnItems(req: {
    sessionId?: string;
    status: 'completed' | 'interrupted' | 'cancelled';
  }): Promise<ServiceMethodResult<{ settledCount: number }>>;
  commitBatch(req: SessionDataCommitBatchRequest): Promise<ServiceMethodResult<SessionDataCommitBatchResult>>;

  // Runs, Idempotency Receipts & Harness Bindings
  listSessionRuns(req: { sessionId: string; limit?: number }): Promise<ServiceMethodResult<{ runs: SessionRunRecordDto[] }>>;
  startSessionRun(req: { run: SessionRunRecordDto }): Promise<ServiceMethodResult<{ run: SessionRunRecordDto }>>;
  finishSessionRun(req: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    failureClass?: string | null;
    usage?: SessionTokenUsageDto | null;
    endedAt?: number;
  }): Promise<ServiceMethodResult<{ updated: boolean }>>;
  getTurnReceipt(req: {
    sessionId: string;
    requestId: string;
  }): Promise<ServiceMethodResult<{ receipt: SessionTurnReceiptDto | null }>>;
  recordTurnReceipt(req: {
    receipt: SessionTurnReceiptDto;
  }): Promise<ServiceMethodResult<{ receipt: SessionTurnReceiptDto; conflict?: boolean }>>;
  getHarnessBinding(req: {
    sessionId: string;
    harnessId: string;
  }): Promise<ServiceMethodResult<{ binding: SessionHarnessBindingDto | null }>>;
  listHarnessBindings(req: {
    sessionId: string;
  }): Promise<ServiceMethodResult<{ bindings: SessionHarnessBindingDto[] }>>;
  upsertHarnessBinding(req: {
    binding: SessionHarnessBindingDto;
  }): Promise<ServiceMethodResult<{ binding: SessionHarnessBindingDto }>>;

  // Snapshots, Committed Changes & Consumer Projections
  readSearchSnapshot(req?: {
    snapshotId?: string;
    cursor?: string | null;
    limit?: number;
    workspaceId?: string;
  }): Promise<ServiceMethodResult<SessionSearchSnapshotResponseV1>>;
  readCommittedChanges(req?: {
    afterSeq?: number;
    limit?: number;
    workspaceId?: string;
  }): Promise<ServiceMethodResult<SessionCommittedChangesResponseV1>>;
  getUsageAggregatesByInstance(): Promise<ServiceMethodResult<{ aggregates: SessionUsageAggregateDto[] }>>;
  getLatestCompletedTurnSeq(req: { sessionId: string }): Promise<ServiceMethodResult<{ seq: number }>>;

  // History Import Transactions
  lookupNativeMapping(req: {
    sourceId: string;
    nativeSessionId: string;
    compatLegacySources?: string[];
  }): Promise<ServiceMethodResult<{ existingSessionId: string | null; matchedVia: 'mapping' | 'legacy' | null }>>;
  lookupReceipt(req: {
    requestId: string;
    requestHash: string;
  }): Promise<
    ServiceMethodResult<
      | { found: false }
      | { found: true; conflict: true }
      | {
          found: true;
          conflict: false;
          result: {
            sessionId: string;
            disposition: 'created' | 'reused';
            partial: boolean;
            warnings: string[];
            mode: 'attach' | 'mirror';
          };
        }
    >
  >;
  resolveTargetWorkspace(req: {
    kind: 'native' | 'bundle';
    workspaceId?: string;
    cwd?: string | null;
    bundleCwd?: string | null;
  }): Promise<
    ServiceMethodResult<{
      targetWorkspaceId: string | null;
      targetWorkspacePath: string | null;
      hasLocalCwd: boolean;
      importable: boolean;
      reason?: string;
    }>
  >;
  commitNativeImport(req: {
    requestId: string;
    requestHash: string;
    ref: HistoryRef;
    mode: 'attach' | 'mirror';
    compatLegacySources?: string[];
    legacySource?: string;
    sourcePath?: string;
    title?: string;
    harnessKind?: string;
    cwd?: string | null;
    workspaceId?: string;
    updatedAt?: number;
    items: Array<{ itemId?: string; role: 'user' | 'assistant'; text: string; timestamp?: number }>;
    partial?: boolean;
    warnings?: string[];
    lockWarning?: string;
    truncatedReason?: string;
  }): Promise<ServiceMethodResult<HistoryImportExecuteResponse & { lockWarning?: string; mode: 'attach' | 'mirror' }>>;
  commitBundleImport(req: {
    requestId: string;
    requestHash: string;
    bundle: PublicPortableSessionBundleV2;
    workspaceId?: string;
    titleOverride?: string;
  }): Promise<ServiceMethodResult<HistoryImportExecuteResponse & { mode: 'attach' | 'mirror' }>>;

  recoverCrashState(): Promise<ServiceMethodResult<{ recoveredRuns: number; recoveredItems: number }>>;
}

/**
 * Legacy Batch 1 `hm.session-data.v1` compatibility service interface.
 */
export interface LegacySessionDataCompatServiceV1 {
  lookupNativeMapping(params: {
    sourceId: string;
    nativeSessionId: string;
    compatLegacySources?: string[];
  }): Promise<{ existingSessionId: string | null; matchedVia: 'mapping' | 'legacy' | null }> | { existingSessionId: string | null; matchedVia: 'mapping' | 'legacy' | null };
  lookupReceipt(params: { requestId: string; requestHash: string }): unknown;
  resolveTargetWorkspace(params: {
    kind: 'native' | 'bundle';
    workspaceId?: string;
    cwd?: string | null;
    bundleCwd?: string | null;
  }): unknown;
  listWorkspaces(): Promise<SessionWorkspaceDto[]> | SessionWorkspaceDto[];
  commitNativeImport(params: Record<string, unknown>): Promise<unknown>;
  commitBundleImport(params: Record<string, unknown>): Promise<unknown> | unknown;
  readSearchSnapshot(req?: {
    snapshotId?: string;
    cursor?: string | null;
    limit?: number;
    workspaceId?: string;
  }): Promise<SessionSearchSnapshotResponseV1> | SessionSearchSnapshotResponseV1;
  readCommittedChanges(req?: {
    afterSeq?: number;
    limit?: number;
    workspaceId?: string;
  }): Promise<SessionCommittedChangesResponseV1> | SessionCommittedChangesResponseV1;
}

// ── Session Runtime DTOs & Service ──────────────────────────────────────

export type SessionConfigApplyStatus = 'applied' | 'pending_next_session' | 'unsupported' | 'rejected';

export interface SessionConfigReceiptDto {
  sessionId: string;
  harnessId: string;
  requested: {
    model?: string | null;
    reasoningEffort?: PublicReasoningEffort | null;
    permissionMode?: PublicPermissionMode;
  };
  confirmed: {
    model?: string | null;
    actualModel?: string | null;
    reasoningEffort?: PublicReasoningEffort | null;
    permissionMode?: PublicPermissionMode | null;
    permissionEnforcement?: 'native' | 'client_guard' | null;
  };
  status: SessionConfigApplyStatus;
  note?: string;
}

export interface SendTurnRuntimeRequest {
  sessionId: string;
  text: string;
  requestId?: string;
  attachments?: PublicDriverTurnInput['attachments'];
  terminalContexts?: Array<{
    id: string;
    terminalId: string;
    terminalTitle: string;
    cwd: string;
    lineStart: number;
    lineEnd: number;
    cleanText: string;
    truncated?: boolean;
    exitCode?: number | null;
  }>;
  harnessId?: string;
  model?: string | null;
  turnOptions?: Record<string, string | number | boolean>;
  omitHandoff?: boolean;
  literalText?: boolean;
  mode?: 'plugin_development';
  cliCommand?: string;
  nativeSkill?: { name: string; path: string };
  dataInstanceId?: string;
  driverProviderInstanceId?: string;
}

export interface SendTurnRuntimeReceipt {
  sessionId: string;
  turnId: string;
  runId: string;
  requestId?: string;
  disposition: 'started' | 'reused' | 'steered';
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  runtimeInstanceId: string;
  runtimeRunId: string;
  dataInstanceId: string;
  harnessId: string;
  driverProviderInstanceId?: string;
  turnGeneration: number;
}

export interface RuntimeActiveTurnStateDto {
  sessionId: string;
  turnId: string;
  runId: string;
  requestId?: string;
  runtimeInstanceId: string;
  runtimeRunId: string;
  dataInstanceId: string;
  harnessId: string;
  harnessKind: string;
  model: string | null;
  actualModel: string | null;
  turnGeneration: number;
  startedAt: number;
}

export interface RuntimePendingRecoveryDto {
  sessionId: string;
  turnId: string;
  runId: string;
  dataInstanceId: string;
  reason: string;
  recordedAt: number;
}

export interface SessionRuntimeServiceV1 {
  getRuntimeInfo(): Promise<
    ServiceMethodResult<{
      runtimeInstanceId: string;
      runtimeRunId: string;
      acceptingTurns: boolean;
      activeTurnCount: number;
      liveHandleCount: number;
      pendingRecoveryCount: number;
    }>
  >;
  sendTurn(req: SendTurnRuntimeRequest): Promise<ServiceMethodResult<SendTurnRuntimeReceipt>>;
  getTurnStatus(req: {
    sessionId: string;
    turnId?: string;
    requestId?: string;
  }): Promise<
    ServiceMethodResult<{
      active: RuntimeActiveTurnStateDto | null;
      receipt: SessionTurnReceiptDto | null;
      pendingRecovery: RuntimePendingRecoveryDto | null;
    }>
  >;
  interrupt(req: { sessionId: string; reason?: string }): Promise<ServiceMethodResult<{ interrupted: boolean }>>;
  applyConfig(req: {
    sessionId: string;
    patch: {
      model?: string | null;
      reasoningEffort?: PublicReasoningEffort | null;
      permissionMode?: PublicPermissionMode;
    };
    configAlreadyApplied?: boolean;
  }): Promise<ServiceMethodResult<SessionConfigReceiptDto>>;
  closeSession(req: { sessionId: string; reason?: string }): Promise<ServiceMethodResult<{ closedHandles: number }>>;
  closeHarnessSessions(req: { harnessId: string; reason?: string }): Promise<ServiceMethodResult<{ closedHandles: number }>>;
  listActiveTurns(req?: { workspaceId?: string }): Promise<ServiceMethodResult<{ turns: RuntimeActiveTurnStateDto[] }>>;
  listPendingRecoveries(): Promise<ServiceMethodResult<{ recoveries: RuntimePendingRecoveryDto[] }>>;
  recoverStaleRuns(req?: { dataInstanceId?: string }): Promise<ServiceMethodResult<{ recoveredCount: number }>>;
  drainAndStop(req?: { reason?: string }): Promise<ServiceMethodResult<{ drainedTurns: number; closedHandles: number }>>;
}

export type HistoryImportSessionCommitResult = HistoryImportExecuteRequest | HistoryImportExecuteResponse;
