import { z } from 'zod';
import { PluginContributesSchema, PluginManifestSchema } from '@harnessmate/plugin-api';

export const HarnessKindSchema = z.enum(['codex', 'agy', 'claude', 'acp']);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

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

export const HarnessHealthSchema = z.enum(['ready', 'degraded', 'unavailable', 'unauthenticated']);
export type HarnessHealth = z.infer<typeof HarnessHealthSchema>;

export const HarnessInfoSchema = z.object({
  id: z.string(),
  kind: HarnessKindSchema,
  displayName: z.string(),
  description: z.string(),
  protocolLabel: z.string(),
  binaryPath: z.string().nullable(),
  version: z.string().nullable(),
  health: HarnessHealthSchema,
  healthMessage: z.string().optional(),
  capabilities: HarnessCapabilitiesSchema,
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

export const SessionTaskStateSchema = z.object({
  sessionId: z.string(),
  objective: z.string().default(''),
  steps: z.array(TaskStepSchema).default([]),
  decisions: z.array(z.string()).default([]),
  touchedFiles: z.array(z.string()).default([]),
  verifications: z.array(TaskVerificationSchema).default([]),
  blockers: z.array(z.string()).default([]),
  pinnedFacts: z.array(z.string()).default([]),
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
  .omit({ entry: true, main: true, provides: true, contributes: true }).extend({
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
});
export type InstalledPluginInfo = z.infer<typeof InstalledPluginInfoSchema>;

export const PluginCatalogItemSchema = PluginManifestSchema.extend({
  installed: z.boolean(),
  tags: z.array(z.string()).default([]),
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
