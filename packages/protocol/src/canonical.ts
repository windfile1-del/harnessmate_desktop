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

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'resolved',
  'expired',
  'cancelled',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskAnnotationSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type RiskAnnotationSeverity = z.infer<typeof RiskAnnotationSeveritySchema>;

export const RuntimeRequestKindSchema = z.enum([
  'command_approval',
  'file_change_approval',
  'mcp_tool_approval',
  'user_question',
  'secret_request',
]);
export type RuntimeRequestKind = z.infer<typeof RuntimeRequestKindSchema>;

export const UserQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type UserQuestionOption = z.infer<typeof UserQuestionOptionSchema>;

export const UserQuestionSpecSchema = z.object({
  question: z.string().min(1),
  selectionMode: z.enum(['single', 'multiple', 'free_text']).default('single'),
  allowFreeText: z.boolean().optional(),
  options: z.array(UserQuestionOptionSchema).optional(),
  placeholder: z.string().optional(),
});
export type UserQuestionSpec = z.infer<typeof UserQuestionSpecSchema>;

export const UserQuestionAnswerSchema = z.object({
  selectedOptionIds: z.array(z.string()).optional(),
  freeText: z.string().max(4000).optional(),
});
export type UserQuestionAnswer = z.infer<typeof UserQuestionAnswerSchema>;

export const SecretRequestSpecSchema = z.object({
  prompt: z.string().min(1),
  fieldLabel: z.string().optional(),
  targetEnvKey: z.string().optional(),
  description: z.string().optional(),
});
export type SecretRequestSpec = z.infer<typeof SecretRequestSpecSchema>;

export const CustomRiskRuleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  pattern: z.string().min(1).max(300),
  severity: z.enum(['info', 'medium', 'high', 'critical']),
  target: z.enum(['command', 'file_path', 'mcp', 'any']).default('any'),
  reason: z.string().min(1).max(300),
  enabled: z.boolean().default(true),
  builtin: z.boolean().optional(),
});
export type CustomRiskRule = z.infer<typeof CustomRiskRuleSchema>;

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
  supportsNativeFork: z.boolean().optional(),
  supportsActiveSteering: z.boolean().default(false),
  supportsUsageLimits: z.boolean().default(false),
  supportsDynamicOptions: z.boolean().default(false),
  supportedApprovalDecisions: z.array(z.string()).optional(),
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
  contextTokens: z.number().nonnegative().optional(),
  modelContextWindow: z.number().positive().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
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
  parentSessionId: z.string().nullable().optional(),
  forkedFromTurnSeq: z.number().int().nonnegative().nullable().optional(),
  forkMode: z.enum(['native', 'portable']).nullable().optional(),
  importMode: z.enum(['mirror', 'attach']).nullable().optional(),
  importSource: z.string().nullable().optional(),
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
  confirmedThoughtLevel: z.string().nullable().optional(),
  permissionMode: PermissionModeSchema,
  permissionEnforcement: z.enum(['native', 'client_guard']).nullable().optional(),
  lastSeq: z.number().int().nonnegative(),
  usage: TokenUsageSchema.nullable(),
  pendingApprovalCount: z.number().int().nonnegative().default(0),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

export const TRIAGE_INBOX_PLUGIN_ID = 'hm.plugin.triage-inbox';
const TriageIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SessionTriageMetaSchema = z.object({
  sessionId: z.string(),
  pinned: z.boolean(),
  settled: z.boolean(),
  forceUnread: z.boolean(),
  lastViewedTurnSeq: TriageIntegerSchema,
  snoozedUntilMs: TriageIntegerSchema.nullable(),
  updatedAt: TriageIntegerSchema,
});
export type SessionTriageMeta = z.infer<typeof SessionTriageMetaSchema>;

export const SessionTriageStateSchema = z.object({
  sessionId: z.string(),
  sessionSeq: TriageIntegerSchema,
  status: SessionStatusSchema,
  pendingApprovalCount: TriageIntegerSchema,
  latestTurnSeq: TriageIntegerSchema,
  hasRunningSubagents: z.boolean(),
  meta: SessionTriageMetaSchema,
});
export type SessionTriageState = z.infer<typeof SessionTriageStateSchema>;

export const TriageSnoozeExpiredSchema = z.object({
  type: z.literal('triage.snooze_expired'),
  sessionId: z.string(),
  snoozedUntilMs: TriageIntegerSchema,
  createdAt: TriageIntegerSchema,
});
export type TriageSnoozeExpired = z.infer<typeof TriageSnoozeExpiredSchema>;

export const ApprovalAnnotationSchema = z.object({
  pluginId: z.string(),
  sourcePluginId: z.string().optional(),
  risk: RiskLevelSchema.optional(),
  severity: RiskAnnotationSeveritySchema.optional(),
  label: z.string(),
  title: z.string().optional(),
  detail: z.string().optional(),
  matchedPattern: z.string().optional(),
  degraded: z.boolean().optional(),
});
export type ApprovalAnnotationDto = z.infer<typeof ApprovalAnnotationSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  parentSessionId: z.string().nullable().optional(),
  instanceId: z.string().optional(),
  nativeRequestId: z.string(),
  kind: RuntimeRequestKindSchema.default('command_approval'),
  toolName: z.string(),
  toolKind: ToolKindSchema.default('other'),
  summary: z.string(),
  input: z.unknown(),
  diffPreview: z.string().nullable().optional(),
  riskLevel: RiskLevelSchema,
  supportedDecisions: z.array(z.string()).optional(),
  questionSpec: UserQuestionSpecSchema.nullable().optional(),
  questionAnswer: UserQuestionAnswerSchema.nullable().optional(),
  secretSpec: SecretRequestSpecSchema.nullable().optional(),
  secretProvided: z.boolean().optional(),
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
  'session.config_confirmed',
  'session.commands_updated',
  'session.title_updated',
  'session.harness_switched',
  'session.imported',
  'session.forked',
  'session.merged_back',
  'search_index.rebuilt',
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
  'runtime_request.updated',
  'checkpoint.captured',
  'checkpoint.reverted',
  'subagent.spawned',
  'subagent.updated',
  'subagent.cohort_completed',
  'subagent.merged',
  'compression.chunk_ready',
  'compression.fallback_triggered',
  'terminal.opened',
  'terminal.exited',
  'terminal.context_attached',
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
  'codex_cli', 'codex_desktop', 'claude_cli', 'agy_cli', 'agy_desktop', 'pi_cli', 'opencode_cli', 'custom',
]);

export const DiscoveredCliSessionSchema = z.object({
  harnessKind: HarnessKindSchema,
  source: NativeHistorySourceSchema.optional(),
  scannerId: z.string().optional(),
  nativeSessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  updatedAt: z.number(),
  sourcePath: z.string().optional(),
  fileSizeBytes: z.number().nonnegative().optional(),
  compressed: z.boolean().optional(),
  approxTurnCount: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
  alreadyImportedSessionId: z.string().nullable().optional(),
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

export const InstanceBillingTierSchema = z.enum([
  'subscription',
  'api_payg',
  'local_free',
  'unknown',
]);
export type InstanceBillingTier = z.infer<typeof InstanceBillingTierSchema>;

export const HarnessAccountUsageSchema = z.object({
  harnessId: z.string(),
  harnessKind: HarnessKindSchema,
  instanceId: z.string().optional(),
  driverId: HarnessDriverIdSchema.optional(),
  displayName: z.string(),
  billingTier: InstanceBillingTierSchema.optional(),
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
  fetchedAt: z.number().optional(),
  cached: z.boolean().optional(),
  error: z.string().nullable().optional(),
});
export type HarnessAccountUsage = z.infer<typeof HarnessAccountUsageSchema>;

export const FailoverModeSchema = z.enum(['manual_one_click', 'auto_same_tier', 'auto_any']);
export type FailoverMode = z.infer<typeof FailoverModeSchema>;

export const FailoverPolicySchema = z.object({
  mode: FailoverModeSchema.default('manual_one_click'),
  priorityChain: z.array(z.string().min(1)).default([]),
  maxAutoSwitchesPerSession: z.number().int().min(0).max(10).default(2),
  autoRetryInterruptedPrompt: z.boolean().default(true),
  notifyOnQuotaReset: z.boolean().default(true),
});
export type FailoverPolicy = z.infer<typeof FailoverPolicySchema>;

export const FailoverRecommendationSchema = z.object({
  failedInstanceId: z.string(),
  failureClass: z.string(),
  recommendedInstanceId: z.string().nullable(),
  recommendedDisplayName: z.string().nullable().optional(),
  recommendedBillingTier: InstanceBillingTierSchema.optional(),
  canAutoFailover: z.boolean(),
  downgradedToManualReason: z.string().nullable().optional(),
  pingPongBlocked: z.boolean().default(false),
  autoSwitchCount: z.number().int().nonnegative().default(0),
  maxAutoSwitchesPerSession: z.number().int().nonnegative().default(2),
  failedResetsAt: z.number().nullable().optional(),
  earliestResetAt: z.number().nullable().optional(),
  candidates: z.array(
    z.object({
      instanceId: z.string(),
      driverId: HarnessDriverIdSchema,
      displayName: z.string(),
      billingTier: InstanceBillingTierSchema,
      available: z.boolean(),
      inCooldown: z.boolean(),
      resetsAt: z.number().nullable().optional(),
      reason: z.string().optional(),
    }),
  ).default([]),
});
export type FailoverRecommendation = z.infer<typeof FailoverRecommendationSchema>;

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

export const CheckpointRevertModeSchema = z.enum([
  'native_and_files',
  'files_only',
  'fork_new_branch',
]);
export type CheckpointRevertMode = z.infer<typeof CheckpointRevertModeSchema>;

export const CheckpointRevertResultSchema = z.object({
  revertedToCheckpointId: z.string(),
  targetTurnSeq: z.number().int().nonnegative(),
  preRevertCheckpointId: z.string(),
  modeUsed: CheckpointRevertModeSchema,
  nativeRolledBack: z.boolean(),
  newNativeBindingReset: z.boolean(),
  filesRestored: z.number().int().nonnegative(),
  untrackedRemoved: z.number().int().nonnegative(),
  skippedLargeFiles: z.array(z.string()).default([]),
});
export type CheckpointRevertResult = z.infer<typeof CheckpointRevertResultSchema>;

export const GitFileDiffResultSchema = z.object({
  path: z.string(),
  staged: z.boolean(),
  diff: z.string(),
  binary: z.boolean().default(false),
  truncated: z.boolean().default(false),
  totalBytes: z.number().int().nonnegative().default(0),
});
export type GitFileDiffResult = z.infer<typeof GitFileDiffResultSchema>;

export const GitWorkspaceTruthDigestSchema = z.object({
  isGitRepo: z.boolean(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  dirtyFilesCount: z.number().int().nonnegative(),
  dirtyFiles: z.array(z.string()),
  diffStat: z.string(),
  capturedAt: z.number(),
  durationMs: z.number().nonnegative(),
});
export type GitWorkspaceTruthDigest = z.infer<typeof GitWorkspaceTruthDigestSchema>;

export const GitWorktreeEntrySchema = z.object({
  path: z.string(),
  headSha: z.string().nullable(),
  branch: z.string().nullable(),
  isMain: z.boolean(),
  isBare: z.boolean().default(false),
  locked: z.boolean().default(false),
  prunable: z.boolean().default(false),
  dirtyCount: z.number().int().nonnegative().default(0),
  linkedSessionIds: z.array(z.string()).default([]),
});
export type GitWorktreeEntry = z.infer<typeof GitWorktreeEntrySchema>;

export const GitDryRunMergeResultSchema = z.object({
  supported: z.boolean(),
  gitVersion: z.string().nullable(),
  baseBranch: z.string(),
  headBranch: z.string(),
  hasConflicts: z.boolean(),
  conflictFiles: z.array(z.string()),
  treeSha: z.string().nullable(),
  message: z.string().optional(),
});
export type GitDryRunMergeResult = z.infer<typeof GitDryRunMergeResultSchema>;

export const WorkspaceSetupScriptInfoSchema = z.object({
  exists: z.boolean(),
  scriptPath: z.string().nullable(),
  relativePath: z.string().nullable(),
  content: z.string().nullable(),
  sha256: z.string().nullable(),
  trusted: z.boolean(),
  trustedAt: z.number().nullable().optional(),
});
export type WorkspaceSetupScriptInfo = z.infer<typeof WorkspaceSetupScriptInfoSchema>;

export const GitActionResultSchema = z.object({
  ok: z.boolean(),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  message: z.string(),
  prUrl: z.string().nullable().optional(),
});
export type GitActionResult = z.infer<typeof GitActionResultSchema>;

// ── Session Explorer, FTS5 Search, Fork/MergeBack, Side Chat & Bundle v2 ─

export const SessionSearchHighlightSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type SessionSearchHighlight = z.infer<typeof SessionSearchHighlightSchema>;

export const SessionSearchHitSchema = z.object({
  sessionId: z.string(),
  sessionTitle: z.string(),
  workspaceId: z.string(),
  turnId: z.string(),
  turnSeq: z.number().int().nonnegative(),
  itemId: z.string(),
  blockType: z.string(),
  snippetText: z.string(),
  snippetHtmlSafe: z.string(),
  highlights: z.array(SessionSearchHighlightSchema).default([]),
  driverId: z.string(),
  createdAt: z.number(),
});
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;

export const SessionSearchResponseSchema = z.object({
  hits: z.array(SessionSearchHitSchema),
  fallbackUsed: z.boolean().default(false),
  tookMs: z.number().nonnegative().default(0),
});
export type SessionSearchResponse = z.infer<typeof SessionSearchResponseSchema>;

export const ForkSessionResultSchema = z.object({
  session: SessionSchema,
  modeUsed: z.enum(['native', 'portable']),
  notice: z.string(),
  worktreePath: z.string().nullable().optional(),
});
export type ForkSessionResult = z.infer<typeof ForkSessionResultSchema>;

export const MergeBackResultSchema = z.object({
  parentSessionId: z.string(),
  childSessionId: z.string(),
  forkDeltaSummary: z.string(),
  itemId: z.string(),
  eventSeq: z.number().int().nonnegative(),
  touchedFiles: z.array(z.string()).default([]),
});
export type MergeBackResult = z.infer<typeof MergeBackResultSchema>;

export const SideChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  harnessId: z.string().optional(),
  model: z.string().nullable().optional(),
  createdAt: z.number(),
});
export type SideChatMessage = z.infer<typeof SideChatMessageSchema>;

export const PortableSessionBundleV2Schema = z.object({
  bundleVersion: z.literal(2),
  exportedAt: z.number(),
  redacted: z.boolean(),
  redactionCategories: z.array(z.string()).default([]),
  redactedCount: z.number().int().nonnegative().default(0),
  session: z.object({
    originalId: z.string(),
    title: z.string(),
    harnessId: z.string(),
    harnessKind: HarnessKindSchema,
    model: z.string().nullable().optional(),
    actualModel: z.string().nullable().optional(),
    reasoningEffort: ReasoningEffortSchema.nullable().optional(),
    permissionMode: PermissionModeSchema.default('manual'),
    cwd: z.string(),
    participatingHarnesses: z.array(z.string()).default([]),
    createdAt: z.number(),
    updatedAt: z.number(),
  }),
  taskState: SessionTaskStateSchema.omit({ sessionId: true }).nullable().optional(),
  items: z.array(TurnBlockRecordSchema).default([]),
  events: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        type: CanonicalEventTypeSchema,
        turnId: z.string().nullable(),
        createdAt: z.number(),
        payload: z.record(z.unknown()),
      }),
    )
    .default([]),
});
export type PortableSessionBundleV2 = z.infer<typeof PortableSessionBundleV2Schema>;

// ── Multi-Harness Parallel Orchestrator (Scenario D) ───────────────────

export const SubagentIsolationSchema = z.enum(['read_only', 'worktree_write']);
export type SubagentIsolation = z.infer<typeof SubagentIsolationSchema>;

export const SubagentStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'stopped',
]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentDiffStatSchema = z.object({
  filesChanged: z.number().int().nonnegative().default(0),
  insertions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  changedFiles: z.array(z.string()).default([]),
});
export type SubagentDiffStat = z.infer<typeof SubagentDiffStatSchema>;

export const SubagentRunRecordSchema = z.object({
  subagentId: z.string(),
  cohortId: z.string(),
  parentSessionId: z.string(),
  childSessionId: z.string(),
  targetInstanceId: z.string(),
  targetDriverId: z.string().optional(),
  roleTitle: z.string(),
  prompt: z.string().default(''),
  isolation: SubagentIsolationSchema,
  worktreePath: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
  effectiveApprovalPolicy: PermissionModeSchema,
  requestedApprovalPolicy: PermissionModeSchema.nullable().optional(),
  depth: z.number().int().min(1).default(1),
  timeoutMs: z.number().int().positive().default(15 * 60 * 1000),
  failFast: z.boolean().default(false),
  status: SubagentStatusSchema,
  pendingApprovalCount: z.number().int().nonnegative().optional(),
  diffStat: SubagentDiffStatSchema.nullable().optional(),
  summary: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  mergedAt: z.number().nullable().optional(),
  mergedIntoBranch: z.string().nullable().optional(),
  worktreeCleaned: z.boolean().optional(),
  createdAt: z.number(),
  finishedAt: z.number().nullable().optional(),
});
export type SubagentRunRecord = z.infer<typeof SubagentRunRecordSchema>;

export const SubagentCohortSummarySchema = z.object({
  cohortId: z.string(),
  parentSessionId: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'partial']),
  total: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  stoppedCount: z.number().int().nonnegative(),
  runningCount: z.number().int().nonnegative(),
  wakeupDelivered: z.boolean(),
  wakeupQueued: z.boolean(),
  subagents: z.array(SubagentRunRecordSchema),
  createdAt: z.number(),
  completedAt: z.number().nullable().optional(),
});
export type SubagentCohortSummary = z.infer<typeof SubagentCohortSummarySchema>;

export const OrchestratorBoardResponseSchema = z.object({
  parentSessionId: z.string(),
  enabled: z.boolean(),
  activeCount: z.number().int().nonnegative(),
  maxConcurrent: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  currentDepth: z.number().int().nonnegative(),
  subagents: z.array(SubagentRunRecordSchema),
  cohorts: z.array(SubagentCohortSummarySchema),
});
export type OrchestratorBoardResponse = z.infer<typeof OrchestratorBoardResponseSchema>;

export const SubagentMergeBackResultSchema = z.object({
  subagentId: z.string(),
  branchName: z.string(),
  baseBranch: z.string(),
  merged: z.boolean(),
  commitSha: z.string().nullable(),
  worktreeCleaned: z.boolean(),
  branchDeleted: z.boolean(),
  dryRun: GitDryRunMergeResultSchema,
  message: z.string(),
});
export type SubagentMergeBackResult = z.infer<typeof SubagentMergeBackResultSchema>;

// ── AI Context Compression & Symbol Index Schemas ──────────────────────

export const FileSymbolKindSchema = z.enum([
  'class',
  'interface',
  'type',
  'enum',
  'function',
  'const',
  'struct',
  'trait',
  'impl',
  'def',
  'mod',
]);
export type FileSymbolKind = z.infer<typeof FileSymbolKindSchema>;

export const FileSymbolEntrySchema = z.object({
  kind: FileSymbolKindSchema,
  name: z.string(),
  line: z.number().int().positive(),
  exported: z.boolean(),
  signature: z.string().optional(),
});
export type FileSymbolEntry = z.infer<typeof FileSymbolEntrySchema>;

export const FileSymbolOutlineSchema = z.object({
  path: z.string(),
  language: z.enum(['typescript', 'javascript', 'python', 'go', 'rust', 'other']),
  mtimeMs: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  symbols: z.array(FileSymbolEntrySchema),
  truncated: z.boolean().optional(),
});
export type FileSymbolOutline = z.infer<typeof FileSymbolOutlineSchema>;

export const ReferencedPathCheckSchema = z.object({
  path: z.string(),
  existsAtCheck: z.boolean(),
});
export type ReferencedPathCheck = z.infer<typeof ReferencedPathCheckSchema>;

export const CompressedTurnChunkSchema = z.object({
  chunkId: z.string(),
  sessionId: z.string(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  fromTurn: z.number().int().positive(),
  toTurn: z.number().int().positive(),
  sourceItemsHash: z.string(),
  summaryMarkdown: z.string(),
  originalChars: z.number().int().nonnegative(),
  compressedChars: z.number().int().nonnegative(),
  compressionRatio: z.number().nonnegative(),
  usedLlm: z.boolean(),
  summarizerInstanceId: z.string().nullable(),
  fallback: z.boolean(),
  fallbackReason: z.string().nullable(),
  cacheHit: z.boolean(),
  referencedPaths: z.array(ReferencedPathCheckSchema),
  createdAt: z.number(),
});
export type CompressedTurnChunk = z.infer<typeof CompressedTurnChunkSchema>;

export const ContextCompressionConfigSchema = z.object({
  summarizerInstanceId: z.string().nullable().default(null),
  summarizerModel: z.string().nullable().default(null),
  dailyCallLimit: z.number().int().min(0).max(10_000).default(50),
  sessionTokenBudgetCap: z.number().int().min(1_000).max(5_000_000).default(120_000),
  timeoutMs: z.number().int().min(100).max(60_000).default(8_000),
  chunkSizeTurns: z.number().int().min(2).max(50).default(10),
  rollupTurnThreshold: z.number().int().min(5).max(500).default(25),
  backgroundRollupEnabled: z.boolean().default(true),
  symbolOutlineMaxChars: z.number().int().min(500).max(20_000).default(4_000),
});
export type ContextCompressionConfig = z.infer<typeof ContextCompressionConfigSchema>;

export const CompressionCacheStatsSchema = z.object({
  chunkCount: z.number().int().nonnegative(),
  symbolFileCount: z.number().int().nonnegative(),
  workspaceBytesUsed: z.number().int().nonnegative(),
  workspaceBytesCap: z.number().int().positive(),
  dailyLlmCallsUsed: z.number().int().nonnegative(),
  dailyLlmCallsLimit: z.number().int().nonnegative(),
  sessionTokensUsed: z.number().int().nonnegative(),
  sessionTokenBudgetCap: z.number().int().positive(),
});
export type CompressionCacheStats = z.infer<typeof CompressionCacheStatsSchema>;

export const SessionCompressionStatusSchema = z.object({
  enabled: z.boolean(),
  sessionId: z.string(),
  workspaceId: z.string(),
  config: ContextCompressionConfigSchema,
  chunks: z.array(CompressedTurnChunkSchema),
  symbolOutlines: z.array(FileSymbolOutlineSchema),
  symbolOutlineMarkdown: z.string(),
  totalOriginalChars: z.number().int().nonnegative(),
  totalCompressedChars: z.number().int().nonnegative(),
  compressionRatio: z.number().nonnegative(),
  cacheStats: CompressionCacheStatsSchema,
});
export type SessionCompressionStatus = z.infer<typeof SessionCompressionStatusSchema>;

// ── Integrated PTY Terminal & Context Chips ────────────────────────────

export const TerminalBackendKindSchema = z.enum(['pty', 'pipe']);
export type TerminalBackendKind = z.infer<typeof TerminalBackendKindSchema>;

export const TerminalTabStatusSchema = z.enum(['running', 'exited']);
export type TerminalTabStatus = z.infer<typeof TerminalTabStatusSchema>;

export const DevServerHintSchema = z.object({
  command: z.string(),
  framework: z.string(),
  detectedAt: z.number(),
});
export type DevServerHint = z.infer<typeof DevServerHintSchema>;

export const ManagedTerminalTabSchema = z.object({
  terminalId: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  title: z.string(),
  shell: z.string(),
  pid: z.number().int().nonnegative(),
  backend: TerminalBackendKindSchema,
  status: TerminalTabStatusSchema,
  exitCode: z.number().int().nullable().optional(),
  ringBufferBytes: z.number().int().nonnegative().default(0),
  devServerHint: DevServerHintSchema.nullable().optional(),
  createdAt: z.number(),
});
export type ManagedTerminalTab = z.infer<typeof ManagedTerminalTabSchema>;

export const TerminalContextChipSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string().min(1),
  terminalTitle: z.string().min(1),
  cwd: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  cleanText: z.string().max(16_384),
  truncated: z.boolean(),
  exitCode: z.number().int().nullable().optional(),
});
export type TerminalContextChip = z.infer<typeof TerminalContextChipSchema>;

// ── Phase AGY: Native Account Isolation & Profile Schemas ──────────────

export const AgyAuthMethodSchema = z.enum([
  'oauth-personal',
  'oauth-business',
  'gemini-api-key',
  'agent-platform',
]);
export type AgyAuthMethod = z.infer<typeof AgyAuthMethodSchema>;

export const AgyIsolationModeSchema = z.enum([
  'official_default',
  'profile_isolated',
]);
export type AgyIsolationMode = z.infer<typeof AgyIsolationModeSchema>;

export const AgyAccountDefaultsSchema = z.object({
  defaultModel: z.string().nullable().optional(),
  defaultEffort: ReasoningEffortSchema.nullable().optional(),
  defaultPermissionMode: PermissionModeSchema.optional(),
  enableSandbox: z.boolean().optional(),
  linkGlobalSkills: z.boolean().default(true),
  syncGlobalRules: z.boolean().default(true),
  additionalDirectories: z.array(z.string()).default([]),
});
export type AgyAccountDefaults = z.infer<typeof AgyAccountDefaultsSchema>;

export const AgyAccountIdentitySchema = z.object({
  accountFingerprint: z.string().nullable().optional(),
  emailLabel: z.string().nullable().optional(),
  tierName: z.string().nullable().optional(),
  tierId: z.string().nullable().optional(),
  verifiedAt: z.number().nullable().optional(),
});
export type AgyAccountIdentity = z.infer<typeof AgyAccountIdentitySchema>;

export const AgyProfileConfigSchema = z.object({
  instanceId: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_.:-]*$/i),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  isolationMode: AgyIsolationModeSchema.default('official_default'),
  authMethod: AgyAuthMethodSchema.default('oauth-personal'),
  geminiDir: z.string().optional(),
  appDataDirName: z.string().trim().min(1).max(80).default('antigravity-cli'),
  binaryPath: z.string().optional(),
  gcpProject: z.string().optional(),
  gcpLocation: z.string().optional(),
  defaults: AgyAccountDefaultsSchema.default({}),
  identity: AgyAccountIdentitySchema.optional(),
  enabled: z.boolean().default(true),
});
export type AgyProfileConfig = z.infer<typeof AgyProfileConfigSchema>;

export const AgyAuthPhaseSchema = z.enum([
  'idle',
  'starting',
  'waiting_code',
  'verifying',
  'authenticated',
  'unauthenticated',
  'failed',
  'cancelled',
]);
export type AgyAuthPhase = z.infer<typeof AgyAuthPhaseSchema>;

export const AgyAuthStateSchema = z.object({
  instanceId: z.string(),
  phase: AgyAuthPhaseSchema,
  flowId: z.string().nullable().default(null),
  authorizationUrl: z.string().nullable().default(null),
  expiresAt: z.number().nullable().default(null),
  message: z.string().nullable().default(null),
  isolationMode: AgyIsolationModeSchema.optional(),
  authMethod: AgyAuthMethodSchema.optional(),
  identity: AgyAccountIdentitySchema.nullable().optional(),
});
export type AgyAuthState = z.infer<typeof AgyAuthStateSchema>;
