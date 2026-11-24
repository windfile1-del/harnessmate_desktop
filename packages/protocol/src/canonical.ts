import { z } from 'zod';
import { PluginContributesSchema, PluginManifestSchema, PluginSlotContributionSchema } from '@harnessmate/plugin-api';

export const BuiltinHarnessKindSchema = z.enum(['codex', 'agy', 'claude', 'acp']);
export type BuiltinHarnessKind = z.infer<typeof BuiltinHarnessKindSchema>;

/** Open driver identifier: supports built-in ('codex'|'agy'|'claude'|'acp') and third-party plugin drivers. */
export const HarnessDriverIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/i, 'Invalid harness driver id');
export type HarnessDriverId = z.infer<typeof HarnessDriverIdSchema>;

export const HarnessKindSchema = HarnessDriverIdSchema;
export type HarnessKind = HarnessDriverId;

export const PermissionModeSchema = z.enum(['plan', 'accept_edits', 'auto', 'manual']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ReasoningEffortSchema = z.enum([
  'none',
  'disabled',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const SessionStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_approval',
  'error',
  'archived',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ApprovalDecisionSchema = z.enum(['allow_once', 'allow_session', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ToolKindSchema = z.enum([
  'shell',
  'file_read',
  'file_edit',
  'search',
  'mcp',
  'subagent',
  'web',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const HarnessModelInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  group: z.string().optional(),
  isDefault: z.boolean().optional(),
  defaultEffort: ReasoningEffortSchema.optional(),
  supportedEfforts: z.array(ReasoningEffortSchema).optional(),
  inputModalities: z.array(z.string()).optional(),
});
export type HarnessModelInfo = z.infer<typeof HarnessModelInfoSchema>;

export const HarnessCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  interactiveApproval: z.boolean(),
  reasoningEfforts: z.array(ReasoningEffortSchema),
  permissionModes: z.array(PermissionModeSchema),
  sessionResume: z.boolean(),
  sessionFork: z.boolean(),
  imageInput: z.boolean(),
  subagents: z.boolean(),
});
export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;

export const HarnessHistoryInjectionModeSchema = z.enum([
  'native_items',
  'embedded_context',
  'sysfile_delta',
  'inline',
]);
export type HarnessHistoryInjectionMode = z.infer<typeof HarnessHistoryInjectionModeSchema>;

export const HarnessTransportKindSchema = z.enum([
  'jsonrpc_stdio',
  'stream_json',
  'acp_stdio',
  'http_sse',
  'sdk',
  'custom',
]);
export type HarnessTransportKind = z.infer<typeof HarnessTransportKindSchema>;

export const ProviderOptionDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    kind: z.literal('select'),
    defaultValue: z.string().optional(),
    options: z.array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
  z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    kind: z.literal('boolean'),
    defaultValue: z.boolean().optional(),
  }),
  z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    kind: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    defaultValue: z.number().optional(),
  }),
]);
export type ProviderOptionDescriptor = z.infer<typeof ProviderOptionDescriptorSchema>;

export const HarnessPresentationMetaSchema = z.object({
  shortLabel: z.string().min(1).max(32),
  accentColor: z.string().min(1),
  softBg: z.string().min(1),
  tagline: z.string().max(160),
  iconSvg: z.string().optional(),
});
export type HarnessPresentationMeta = z.infer<typeof HarnessPresentationMetaSchema>;

export const HarnessCapabilitiesV2Schema = HarnessCapabilitiesSchema.extend({
  transport: HarnessTransportKindSchema.default('custom'),
  historyInjectionMode: HarnessHistoryInjectionModeSchema.default('inline'),
  supportsNativeRollback: z.boolean().default(false),
  supportsActiveSteering: z.boolean().default(false),
  supportsUsageLimits: z.boolean().default(false),
  supportsDynamicOptions: z.boolean().default(false),
  nativeCommands: z.array(z.string()).default([]),
  optionDescriptors: z.array(ProviderOptionDescriptorSchema).default([]),
});
export type HarnessCapabilitiesV2 = z.infer<typeof HarnessCapabilitiesV2Schema>;

export const HarnessInstanceConfigSchema = z.object({
  instanceId: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_.:-]*$/i),
  driverId: HarnessDriverIdSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  continuationKey: z.string().trim().min(1).max(200).optional(),
  binaryPath: z.string().optional(),
  homeDir: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  envWhitelist: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});
export type HarnessInstanceConfig = z.infer<typeof HarnessInstanceConfigSchema>;

export const HarnessHealthSchema = z.enum(['ready', 'degraded', 'unavailable', 'unauthenticated']);
export type HarnessHealth = z.infer<typeof HarnessHealthSchema>;

export const HarnessInfoSchema = z.object({
  id: z.string(),
  kind: HarnessKindSchema,
  driverId: HarnessDriverIdSchema.optional(),
  instanceId: z.string().optional(),
  continuationKey: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  protocolLabel: z.string(),
  binaryPath: z.string().nullable(),
  version: z.string().nullable(),
  health: HarnessHealthSchema,
  healthMessage: z.string().optional(),
  capabilities: HarnessCapabilitiesSchema,
  capabilitiesV2: HarnessCapabilitiesV2Schema.optional(),
  presentation: HarnessPresentationMetaSchema.optional(),
  optionDescriptors: z.array(ProviderOptionDescriptorSchema).optional(),
  models: z.array(HarnessModelInfoSchema),
  defaultModelId: z.string().nullable().optional(),
  accountSummary: z.string().nullable().optional(),
  isCustom: z.boolean().optional(),
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  isGitRepo: z.boolean(),
  gitBranch: z.string().nullable().optional(),
  createdAt: z.number(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cachedTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ContextSyncModeSchema = z.enum(['auto', 'full_ledger', 'delta_only']);
export type ContextSyncMode = z.infer<typeof ContextSyncModeSchema>;

export const ContextInjectionDriverSchema = z.enum([
  'codex_inject_items',
  'acp_embedded_context',
  'claude_sysfile_delta',
  'prompt_envelope',
  'native_warm',
]);
export type ContextInjectionDriver = z.infer<typeof ContextInjectionDriverSchema>;

export const SessionHarnessBindingSchema = z.object({
  sessionId: z.string(),
  harnessId: z.string(),
  harnessKind: HarnessKindSchema,
  nativeSessionId: z.string().nullable(),
  lastModel: z.string().nullable().optional(),
  lastActualModel: z.string().nullable().optional(),
  lastEffort: ReasoningEffortSchema.nullable().optional(),
  syncedUpToSeq: z.number().int().nonnegative().default(0),
  driverUsed: ContextInjectionDriverSchema.nullable().optional(),
  updatedAt: z.number(),
});
export type SessionHarnessBinding = z.infer<typeof SessionHarnessBindingSchema>;

export const TaskStepStatusSchema = z.enum(['pending', 'in_progress', 'done', 'blocked']);
export type TaskStepStatus = z.infer<typeof TaskStepStatusSchema>;

export const TaskStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStepStatusSchema,
  ownerHarnessId: z.string().nullable().optional(),
  updatedAt: z.number(),
});
export type TaskStep = z.infer<typeof TaskStepSchema>;

export const TaskVerificationSchema = z.object({
  command: z.string(),
  status: z.enum(['pass', 'fail', 'unknown']),
  summary: z.string().optional(),
  harnessId: z.string().nullable().optional(),
  timestamp: z.number(),
});
export type TaskVerification = z.infer<typeof TaskVerificationSchema>;

export const TaskFailedAttemptSchema = z.object({
  id: z.string(),
  summary: z.string().max(300),
  failureReason: z.string().max(500),
  relatedFiles: z.array(z.string()).optional(),
  harnessInstanceId: z.string().nullable().optional(),
  recordedAt: z.number(),
});
export type TaskFailedAttempt = z.infer<typeof TaskFailedAttemptSchema>;

export const SessionTaskStateSchema = z.object({
  sessionId: z.string(),
  objective: z.string().default(''),
  steps: z.array(TaskStepSchema).default([]),
  decisions: z.array(z.string()).default([]),
  touchedFiles: z.array(z.string()).default([]),
  verifications: z.array(TaskVerificationSchema).default([]),
  blockers: z.array(z.string()).default([]),
  pinnedFacts: z.array(z.string()).default([]),
  failedAttempts: z.array(TaskFailedAttemptSchema).optional(),
  rollingSummary: z.string().default(''),
  summarizedUpToSeq: z.number().int().nonnegative().default(0),
  version: z.number().int().positive().default(1),
  ledgerFilePath: z.string().nullable().optional(),
  updatedAt: z.number(),
});
export type SessionTaskState = z.infer<typeof SessionTaskStateSchema>;

export const ContextPreviewSchema = z.object({
  sessionId: z.string(),
  targetHarnessId: z.string(),
  targetHarnessKind: HarnessKindSchema,
  syncedUpToSeq: z.number().int().nonnegative(),
  currentLastSeq: z.number().int().nonnegative(),
  unsyncedTurnCount: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  budgetTokens: z.number().int().positive(),
  driverPlanned: ContextInjectionDriverSchema,
  isWarmBinding: z.boolean(),
  syncNeeded: z.boolean(),
  compiledMarkdown: z.string(),
  ledgerMarkdown: z.string(),
  deltaTurnSummary: z.array(
    z.object({
      turnId: z.string(),
      harnessId: z.string(),
      model: z.string().nullable().optional(),
      userPreview: z.string(),
    }),
  ),
});
export type ContextPreview = z.infer<typeof ContextPreviewSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  harnessId: z.string(),
  harnessKind: HarnessKindSchema,
  nativeSessionId: z.string().nullable(),
  participatingHarnesses: z.array(z.string()).default([]),
  contextSyncMode: ContextSyncModeSchema.default('auto'),
  bindings: z.array(SessionHarnessBindingSchema).optional(),
  cwd: z.string(),
  worktreeBranch: z.string().nullable().optional(),
  title: z.string(),
  status: SessionStatusSchema,
  model: z.string().nullable(),
  actualModel: z.string().nullable().optional(),
  modelReroutedReason: z.string().nullable().optional(),
  reasoningEffort: ReasoningEffortSchema.nullable(),
  permissionMode: PermissionModeSchema,
  lastSeq: z.number().int().nonnegative(),
  usage: TokenUsageSchema.nullable(),
  pendingApprovalCount: z.number().int().nonnegative().default(0),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

export const ApprovalAnnotationSchema = z.object({
  pluginId: z.string(),
  risk: RiskLevelSchema.optional(),
  label: z.string(),
  detail: z.string().optional(),
});
export type ApprovalAnnotationDto = z.infer<typeof ApprovalAnnotationSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  nativeRequestId: z.string(),
  toolName: z.string(),
  toolKind: ToolKindSchema.default('other'),
  summary: z.string(),
  input: z.unknown(),
  diffPreview: z.string().nullable().optional(),
  riskLevel: RiskLevelSchema,
  status: ApprovalStatusSchema,
  resolvedBy: z.enum(['desktop', 'mobile', 'auto']).nullable().optional(),
  decision: ApprovalDecisionSchema.nullable().optional(),
  comment: z.string().nullable().optional(),
  annotations: z.array(ApprovalAnnotationSchema).optional(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['file_ref', 'image']),
  name: z.string(),
  path: z.string().optional(),
  relativePath: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  previewUrl: z.string().optional(),
  dataBase64: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const CanonicalEventTypeSchema = z.enum([
  'session.status',
  'session.model_confirmed',
  'session.harness_switched',
  'task.state_updated',
  'handoff.snapshot',
  'handoff.snapshot_delivered',
  'handoff.system_notice',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'message.user',
  'message.assistant.delta',
  'message.assistant.completed',
  'thinking.delta',
  'thinking.completed',
  'tool.call.started',
  'tool.call.delta',
  'tool.call.completed',
  'approval.requested',
  'approval.resolved',
  'usage.updated',
  'diagnostic.log',
]);
export type CanonicalEventType = z.infer<typeof CanonicalEventTypeSchema>;

export const CanonicalEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().positive(),
  type: CanonicalEventTypeSchema,
  turnId: z.string().nullable(),
  createdAt: z.number(),
  payload: z.record(z.unknown()),
});
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;

export const GitFileChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']),
  staged: z.boolean(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

export const GitStatusSummarySchema = z.object({
  isGitRepo: z.boolean(),
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  changes: z.array(GitFileChangeSchema),
  diff: z.string(),
});
export type GitStatusSummary = z.infer<typeof GitStatusSummarySchema>;

export const NativeHistorySourceSchema = z.enum([
  'codex_cli', 'codex_desktop', 'claude_cli', 'agy_cli', 'agy_desktop',
]);

export const DiscoveredCliSessionSchema = z.object({
  harnessKind: HarnessKindSchema,
  source: NativeHistorySourceSchema.optional(),
  nativeSessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  updatedAt: z.number(),
  sourcePath: z.string().optional(),
});
export type DiscoveredCliSession = z.infer<typeof DiscoveredCliSessionSchema>;

export const WorkspaceFileEntrySchema = z.object({
  relativePath: z.string(),
  fullPath: z.string(),
  name: z.string(),
  sizeBytes: z.number().nonnegative(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>;

// ── Modular Plugin System Schemas ──────────────────────────────────────

export const GeneratedPluginManifestSchema = PluginManifestSchema
  .omit({ entry: true, main: true, provides: true, permissions: true, activationEvents: true, contributes: true }).extend({
    contributes: PluginContributesSchema.pick({ slashCommands: true, panels: true, projections: true, dataPanels: true,
      programs: true, actions: true }).strict(),
  }).strict();

export const InstalledPluginInfoSchema = PluginManifestSchema.extend({
  builtin: z.boolean(),
  enabled: z.boolean(),
  sourcePath: z.string().nullable().optional(),
  hasRuntimeHook: z.boolean().optional(),
  loadError: z.string().nullable().optional(),
  canRollback: z.boolean().optional(),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  runtimeState: z.enum(['PENDING', 'LOADING', 'ACTIVE', 'UNLOADING', 'DISPOSED', 'FAILED']).optional(),
  missingServices: z.array(z.string()).optional(),
  runId: z.string().optional(),
  runtimeMode: z.enum(['kernel', 'isolated', 'declarative']).optional(),
  runtimeSlots: z.array(PluginSlotContributionSchema).optional(),
  devMode: z.boolean().optional(),
  devSourceDir: z.string().nullable().optional(),
});
export type InstalledPluginInfo = z.infer<typeof InstalledPluginInfoSchema>;

export const PluginCatalogItemSchema = PluginManifestSchema.extend({
  installed: z.boolean(),
  tags: z.array(z.string()).default([]),
  source: z.enum(['builtin', 'remote']).optional(),
  registryUrl: z.string().optional(),
  publisherId: z.string().optional(),
  publisherName: z.string().optional(),
  packageDigest: z.string().optional(),
  signatureStatus: z.enum(['verified', 'untrusted_publisher', 'invalid', 'unsigned']).optional(),
  compatible: z.boolean().optional(),
  incompatibleReason: z.string().nullable().optional(),
});
export type PluginCatalogItem = z.infer<typeof PluginCatalogItemSchema>;

// ── Cross-CLI MCP Hub Schemas ──────────────────────────────────────────

export const McpServerEntrySchema = z.object({
  id: z.string(),
  harnessId: z.string(),
  harnessKind: HarnessKindSchema,
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse', 'unknown']),
  status: z.enum(['enabled', 'disabled', 'connected', 'auth_required', 'error', 'unknown']),
  commandOrUrl: z.string(),
  args: z.array(z.string()).optional(),
  toolCount: z.number().int().nonnegative().optional(),
  authStatus: z.string().optional(),
});
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

// ── Multi-Account & Quota / Usage Schemas ──────────────────────────────

export const RateLimitWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().nonnegative(),
  resetsAt: z.number().nullable().optional(),
});
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

export const DailyTokenBucketSchema = z.object({
  date: z.string(),
  tokens: z.number().nonnegative(),
});
export type DailyTokenBucket = z.infer<typeof DailyTokenBucketSchema>;

export const HarnessAccountUsageSchema = z.object({
  harnessId: z.string(),
  harnessKind: HarnessKindSchema,
  displayName: z.string(),
  loggedIn: z.boolean(),
  accountLabel: z.string().nullable(),
  planType: z.string().nullable(),
  authMethod: z.string().nullable(),
  gatewayUrl: z.string().nullable().optional(),
  rateLimits: z.array(RateLimitWindowSchema).default([]),
  resetCreditsAvailable: z.number().int().nonnegative().optional(),
  lifetimeTokens: z.number().nonnegative().optional(),
  peakDailyTokens: z.number().nonnegative().optional(),
  currentStreakDays: z.number().int().nonnegative().optional(),
  dailyBuckets: z.array(DailyTokenBucketSchema).default([]),
  localSessionCount: z.number().int().nonnegative().default(0),
  localInputTokens: z.number().nonnegative().default(0),
  localOutputTokens: z.number().nonnegative().default(0),
  localCachedTokens: z.number().nonnegative().default(0),
  localCostUsd: z.number().nonnegative().default(0),
  error: z.string().nullable().optional(),
});
export type HarnessAccountUsage = z.infer<typeof HarnessAccountUsageSchema>;

// ── V2 Materialized TurnBlock, Runs, Outbox, Handoff & Checkpoint Schemas ─

export const TurnBlockStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TurnBlockStatus = z.infer<typeof TurnBlockStatusSchema>;

export const TurnBlockRawRefSchema = z.object({
  eventSeq: z.number().int().nonnegative(),
  vendorType: z.string(),
});
export type TurnBlockRawRef = z.infer<typeof TurnBlockRawRefSchema>;

export const TurnBlockRecordSchema = z.object({
  itemId: z.string(),
  schemaVersion: z.literal(2).default(2),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  instanceId: z.string(),
  driverId: HarnessDriverIdSchema,
  blockType: z.string().min(1),
  status: TurnBlockStatusSchema,
  title: z.string().default(''),
  textBody: z.string().default(''),
  payload: z.record(z.unknown()).default({}),
  outputOmitted: z.boolean().default(false),
  omittedBytes: z.number().int().nonnegative().default(0),
  rawRef: TurnBlockRawRefSchema.nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TurnBlockRecord = z.infer<typeof TurnBlockRecordSchema>;

export const SessionRunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type SessionRunStatus = z.infer<typeof SessionRunStatusSchema>;

export const SessionRunRecordSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  instanceId: z.string(),
  driverId: HarnessDriverIdSchema,
  model: z.string().nullable().optional(),
  status: SessionRunStatusSchema,
  failureClass: z.string().nullable().optional(),
  usage: TokenUsageSchema.nullable().optional(),
  startedAt: z.number(),
  endedAt: z.number().nullable().optional(),
});
export type SessionRunRecord = z.infer<typeof SessionRunRecordSchema>;

export const EffectOutboxDurabilitySchema = z.enum(['REPLAY_SAFE', 'PROCESS_BOUND']);
export type EffectOutboxDurability = z.infer<typeof EffectOutboxDurabilitySchema>;

export const EffectOutboxStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type EffectOutboxStatus = z.infer<typeof EffectOutboxStatusSchema>;

export const EffectOutboxRecordSchema = z.object({
  effectId: z.string(),
  sessionId: z.string(),
  effectType: z.string(),
  durability: EffectOutboxDurabilitySchema,
  payload: z.record(z.unknown()),
  status: EffectOutboxStatusSchema,
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type EffectOutboxRecord = z.infer<typeof EffectOutboxRecordSchema>;

export const HandoffDeliveryStatusSchema = z.enum(['pending', 'confirmed', 'failed']);
export type HandoffDeliveryStatus = z.infer<typeof HandoffDeliveryStatusSchema>;

export const SessionHandoffRecordSchema = z.object({
  handoffId: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable().optional(),
  fromInstanceId: z.string().nullable().optional(),
  toInstanceId: z.string(),
  mode: z.enum(['full_session_summary', 'delta_since_target_last_seen']),
  deliveryChannel: HarnessHistoryInjectionModeSchema,
  deliveryStatus: HandoffDeliveryStatusSchema,
  coveredUpToSeq: z.number().int().nonnegative(),
  estimatedChars: z.number().int().nonnegative().default(0),
  redactedCount: z.number().int().nonnegative().default(0),
  forceFreshReason: z.string().nullable().optional(),
  snapshot: z.record(z.unknown()).default({}),
  createdAt: z.number(),
  confirmedAt: z.number().nullable().optional(),
});
export type SessionHandoffRecord = z.infer<typeof SessionHandoffRecordSchema>;

export const SessionCheckpointRecordSchema = z.object({
  checkpointId: z.string(),
  sessionId: z.string(),
  turnSeq: z.number().int().nonnegative(),
  phase: z.enum(['turn_pre', 'turn_post', 'pre_revert', 'manual']),
  gitRef: z.string(),
  treeSha: z.string(),
  baseHeadSha: z.string().nullable().optional(),
  filesChanged: z.number().int().nonnegative().default(0),
  insertions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  skippedLargeFiles: z.array(z.string()).default([]),
  createdAt: z.number(),
});
export type SessionCheckpointRecord = z.infer<typeof SessionCheckpointRecordSchema>;
