import { z } from 'zod';
import { PluginPanelQuerySchema } from './plugin-sdk.js';
import { PluginManifestSchema } from '@harnessmate/plugin-api';
import {
  AgyAccountDefaultsSchema,
  AgyAuthMethodSchema,
  AgyAuthStateSchema,
  AgyIsolationModeSchema,
  ApprovalDecisionSchema,
  AttachmentSchema,
  CanonicalEventSchema,
  SessionTriageMetaSchema,
  SessionTriageStateSchema,
  TriageSnoozeExpiredSchema,
  CheckpointRevertModeSchema,
  ContextSyncModeSchema,
  CustomRiskRuleSchema,
  ManagedTerminalTabSchema,
  NativeHistorySourceSchema,
  PermissionModeSchema,
  PortableSessionBundleV2Schema,
  GeneratedPluginManifestSchema,
  ReasoningEffortSchema,
  SubagentIsolationSchema,
  TaskStepSchema,
  TaskVerificationSchema,
  TerminalContextChipSchema,
  UserQuestionAnswerSchema,
  type Session,
} from './canonical.js';

export const PROTOCOL_VERSION = 'hm-remote-v1';

export const ImportNativeSessionRequestSchema = z.object({
  source: NativeHistorySourceSchema,
  scannerId: z.string().min(1).max(64).optional(),
  nativeSessionId: z.string().min(1).max(200),
  workspaceId: z.string().optional(),
  mode: z.enum(['mirror', 'attach']).optional(),
});
export type ImportNativeSessionRequest = z.infer<typeof ImportNativeSessionRequestSchema>;

export const ForkSessionRequestSchema = z.object({
  fromTurnSeq: z.number().int().nonnegative().optional(),
  targetHarnessId: z.string().min(1).optional(),
  targetModel: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  createWorktree: z.boolean().optional(),
  worktreeBranch: z.string().trim().min(1).max(120).optional(),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequestSchema>;

export const MergeBackRequestSchema = z.object({
  summaryOverride: z.string().max(12_000).optional(),
  includeTouchedFiles: z.boolean().optional(),
  includeVerifications: z.boolean().optional(),
});
export type MergeBackRequest = z.infer<typeof MergeBackRequestSchema>;

export const SideChatRequestSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
  harnessId: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
});
export type SideChatRequest = z.infer<typeof SideChatRequestSchema>;

export const SideChatPromoteRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  targetHarnessId: z.string().min(1).optional(),
  createWorktree: z.boolean().optional(),
});
export type SideChatPromoteRequest = z.infer<typeof SideChatPromoteRequestSchema>;

export const ImportSessionBundleRequestSchema = z.object({
  bundle: PortableSessionBundleV2Schema,
  workspaceId: z.string().min(1).optional(),
  titleOverride: z.string().trim().min(1).max(160).optional(),
});
export type ImportSessionBundleRequest = z.infer<typeof ImportSessionBundleRequestSchema>;

export const CreateCustomRiskRuleRequestSchema = CustomRiskRuleSchema.omit({ id: true, builtin: true }).extend({
  id: z.string().min(1).max(64).optional(),
});
export type CreateCustomRiskRuleRequest = z.infer<typeof CreateCustomRiskRuleRequestSchema>;

export const HarnessCommandNameSchema = z.enum([
  'compact', 'usage', 'goal', 'plan', 'model', 'plugin', 'skills', 'skill',
]);
export type HarnessCommandName = z.infer<typeof HarnessCommandNameSchema>;
export const RunHarnessCommandRequestSchema = z.object({
  command: HarnessCommandNameSchema,
  args: z.string().trim().max(12_000).default(''),
  harnessId: z.string().min(1),
});
export type RunHarnessCommandRequest = z.infer<typeof RunHarnessCommandRequestSchema>;

export interface HarnessCommandInfo {
  command: string;
  description: string;
  argumentHint?: string;
  source?: 'builtin' | 'native_advertised';
}

export interface HarnessCommandResult {
  session: Session;
  output: string;
  turnId?: string;
}

// ── REST Request Schemas ───────────────────────────────────────────────

export const CreateWorkspaceRequestSchema = z.object({
  rootPath: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const CreateSessionRequestSchema = z.object({
  workspaceId: z.string().min(1),
  harnessId: z.string().min(1).optional(),
  title: z.string().max(160).optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  permissionMode: PermissionModeSchema.default('accept_edits'),
  nativeSessionId: z.string().nullable().optional(),
  createWorktree: z.boolean().optional(),
  worktreeBranch: z.string().optional(),
  contextSyncMode: ContextSyncModeSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const UpdateSessionRequestSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  permissionMode: PermissionModeSchema.optional(),
  contextSyncMode: ContextSyncModeSchema.optional(),
  archived: z.boolean().optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

export const SwitchHarnessRequestSchema = z.object({
  targetHarnessId: z.string().min(1),
  targetModel: z.string().nullable().optional(),
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  syncMode: ContextSyncModeSchema.optional(),
});
export type SwitchHarnessRequest = z.infer<typeof SwitchHarnessRequestSchema>;

export const UpdateSessionTriageRequestSchema = SessionTriageMetaSchema
  .pick({ pinned: true, settled: true, forceUnread: true, snoozedUntilMs: true })
  .partial().strict()
  .refine((patch) => Object.keys(patch).length > 0, '至少指定一个分拣字段');
export type UpdateSessionTriageRequest = z.infer<typeof UpdateSessionTriageRequestSchema>;

export const MarkSessionViewedRequestSchema = z.object({
  throughTurnSeq: SessionTriageMetaSchema.shape.lastViewedTurnSeq.optional(),
  observedUpdatedAt: SessionTriageMetaSchema.shape.updatedAt.optional(),
}).strict();
export type MarkSessionViewedRequest = z.infer<typeof MarkSessionViewedRequestSchema>;

export const TriageStateResponseSchema = z.object({ sessions: z.array(SessionTriageStateSchema) });
export type TriageStateResponse = z.infer<typeof TriageStateResponseSchema>;

export const TriageCheckSnoozesResponseSchema = z.object({
  expired: z.array(TriageSnoozeExpiredSchema),
  reminders: z.array(TriageSnoozeExpiredSchema).optional(),
  sessions: z.array(SessionTriageStateSchema),
});
export type TriageCheckSnoozesResponse = z.infer<typeof TriageCheckSnoozesResponseSchema>;

export const UpdateTaskStateRequestSchema = z.object({
  objective: z.string().max(2000).optional(),
  steps: z.array(TaskStepSchema).optional(),
  decisions: z.array(z.string().max(400)).optional(),
  touchedFiles: z.array(z.string().max(300)).optional(),
  verifications: z.array(TaskVerificationSchema).optional(),
  blockers: z.array(z.string().max(400)).optional(),
  pinnedFacts: z.array(z.string().max(400)).optional(),
  rollingSummary: z.string().max(12000).optional(),
});
export type UpdateTaskStateRequest = z.infer<typeof UpdateTaskStateRequestSchema>;

export const FailoverRequestSchema = z.object({
  targetHarnessId: z.string().min(1),
  targetModel: z.string().nullable().optional(),
  retryLastFailedTurn: z.boolean().default(true),
});
export type FailoverRequest = z.infer<typeof FailoverRequestSchema>;

// ── Git Checkpoints, Diff, Worktree & Delivery Request Schemas ─────────

export const RevertCheckpointRequestSchema = z.object({
  targetTurnSeq: z.number().int().nonnegative().optional(),
  checkpointId: z.string().min(1).optional(),
  mode: CheckpointRevertModeSchema,
});
export type RevertCheckpointRequest = z.infer<typeof RevertCheckpointRequestSchema>;

export const GcCheckpointsRequestSchema = z.object({
  keepLast: z.number().int().min(0).max(500).default(20),
  olderThanDays: z.number().min(0).max(365).optional(),
});
export type GcCheckpointsRequest = z.infer<typeof GcCheckpointsRequestSchema>;

export const GitDiscardFileRequestSchema = z.object({
  filePath: z.string().min(1),
});
export type GitDiscardFileRequest = z.infer<typeof GitDiscardFileRequestSchema>;

export const CreateWorktreeRequestSchema = z.object({
  branchName: z.string().trim().min(1).max(120),
  baseBranch: z.string().trim().min(1).max(120).optional(),
});
export type CreateWorktreeRequest = z.infer<typeof CreateWorktreeRequestSchema>;

export const RemoveWorktreeRequestSchema = z.object({
  worktreePath: z.string().trim().min(1),
  force: z.boolean().optional(),
  releaseTerminals: z.boolean().optional(),
});
export type RemoveWorktreeRequest = z.infer<typeof RemoveWorktreeRequestSchema>;

export const DryRunMergeRequestSchema = z.object({
  baseBranch: z.string().trim().min(1).max(120),
  headBranch: z.string().trim().min(1).max(120),
});
export type DryRunMergeRequest = z.infer<typeof DryRunMergeRequestSchema>;

export const TrustSetupScriptRequestSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  trusted: z.boolean(),
});
export type TrustSetupScriptRequest = z.infer<typeof TrustSetupScriptRequestSchema>;

export const GitCommitRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  files: z.array(z.string().min(1)).optional(),
  stageAll: z.boolean().default(true),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequestSchema>;

export const GitPushRequestSchema = z.object({
  remote: z.string().trim().min(1).max(120).optional(),
  branch: z.string().trim().min(1).max(120).optional(),
  setUpstream: z.boolean().optional(),
});
export type GitPushRequest = z.infer<typeof GitPushRequestSchema>;

export const GitPullRequestSchema = z.object({
  remote: z.string().trim().min(1).max(120).optional(),
  branch: z.string().trim().min(1).max(120).optional(),
});
export type GitPullRequest = z.infer<typeof GitPullRequestSchema>;

export const GitCreatePrRequestSchema = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().max(16_000).default(''),
  base: z.string().trim().min(1).max(120).optional(),
  draft: z.boolean().default(false),
});
export type GitCreatePrRequest = z.infer<typeof GitCreatePrRequestSchema>;

export const TurnOptionValueSchema = z.union([z.string(), z.boolean(), z.number()]);
export type TurnOptionValue = z.infer<typeof TurnOptionValueSchema>;
export const TurnOptionsMapSchema = z.record(z.string().min(1), TurnOptionValueSchema);
export type TurnOptionsMap = z.infer<typeof TurnOptionsMapSchema>;

export const SendTurnRequestSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  terminalContexts: z.array(TerminalContextChipSchema).max(12).optional(),
  harnessId: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
  turnOptions: TurnOptionsMapSchema.optional(),
  omitHandoff: z.boolean().optional(),
  literalText: z.boolean().optional(),
  mode: z.literal('plugin_development').optional(),
});
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>;

export const UploadAttachmentRequestSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(['image', 'file_ref']),
  mimeType: z.string().max(120).optional(),
  dataBase64: z.string().optional(),
  sourcePath: z.string().optional(),
});
export type UploadAttachmentRequest = z.infer<typeof UploadAttachmentRequestSchema>;

export const ResolveApprovalRequestSchema = z.object({
  decision: ApprovalDecisionSchema.optional(),
  comment: z.string().max(500).optional(),
  resolvedBy: z.enum(['desktop', 'mobile']).default('desktop'),
  questionAnswer: UserQuestionAnswerSchema.optional(),
  secretValue: z.string().max(16_384).optional(),
  noLog: z.boolean().optional(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequestSchema>;

export const PairExchangeRequestSchema = z.object({
  pairingCode: z.string().min(4).max(16),
  deviceName: z.string().min(1).max(80),
  platform: z.enum(['android', 'ios', 'web']).default('android'),
});
export type PairExchangeRequest = z.infer<typeof PairExchangeRequestSchema>;

export const UpdateRemoteConfigRequestSchema = z.object({
  lanEnabled: z.boolean(),
});
export type UpdateRemoteConfigRequest = z.infer<typeof UpdateRemoteConfigRequestSchema>;

export const TogglePluginRequestSchema = z.object({
  enabled: z.boolean(),
});
export type TogglePluginRequest = z.infer<typeof TogglePluginRequestSchema>;

const installedPluginDigest = z.string().regex(/^[a-f0-9]{64}$/).nullable().optional();

const pluginInstallConfirmation = {
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedInstalledDigest: installedPluginDigest,
  trustCode: z.boolean().optional(),
};

export const InstallPluginRequestSchema = z.union([
  z.object({
    mode: z.literal('catalog'),
    catalogId: z.string().min(1),
    ...pluginInstallConfirmation,
  }),
  z.object({
    mode: z.literal('local_dir'),
    dirPath: z.string().min(1),
    ...pluginInstallConfirmation,
  }),
  z.object({
    mode: z.literal('manifest'),
    manifest: PluginManifestSchema,
    ...pluginInstallConfirmation,
  }),
  z.object({
    mode: z.literal('remote_index'),
    pluginId: z.string().min(1),
    version: z.string().optional(),
    allowUntrusted: z.boolean().optional(),
    ...pluginInstallConfirmation,
  }),
]);
export type InstallPluginRequest = z.infer<typeof InstallPluginRequestSchema>;

export const GeneratePluginDraftRequestSchema = z.object({
  workspaceId: z.string().min(1),
  harnessId: z.string().min(1),
  description: z.string().trim().min(3).max(6000),
  model: z.string().min(1).optional(),
  previous: PluginManifestSchema.optional(),
  editing: z.object({ id: PluginManifestSchema.shape.id, digest: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type GeneratePluginDraftRequest = z.infer<typeof GeneratePluginDraftRequestSchema>;

export const ReplayPluginDraftRequestSchema = z.object({
  manifest: GeneratedPluginManifestSchema,
  sessionId: z.string().min(1),
  panelId: z.string().min(1).max(40),
  query: PluginPanelQuerySchema,
}).strict();
export type ReplayPluginDraftRequest = z.infer<typeof ReplayPluginDraftRequestSchema>;

export const PreviewPluginProgramRequestSchema = z.object({
  manifest: GeneratedPluginManifestSchema, programId: z.string().min(1).max(40), text: z.string().max(12_000),
}).strict();
export type PreviewPluginProgramRequest = z.infer<typeof PreviewPluginProgramRequestSchema>;

export const AddMcpServerRequestSchema = z.object({
  targetHarnesses: z.array(z.string().min(1).max(96)).min(1),
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
});
export type AddMcpServerRequest = z.infer<typeof AddMcpServerRequestSchema>;

export const ToggleMcpServerRequestSchema = z.object({
  harnessId: z.string().min(1).max(96),
  name: z.string().min(1),
  enabled: z.boolean(),
});
export type ToggleMcpServerRequest = z.infer<typeof ToggleMcpServerRequestSchema>;

// ── Remote Pairing & Device Types ──────────────────────────────────────

export const PairedDeviceSchema = z.object({
  id: z.string(),
  deviceName: z.string(),
  platform: z.enum(['android', 'ios', 'web']),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

export const RemoteAccessStatusSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  desktopId: z.string(),
  desktopName: z.string(),
  port: z.number().int(),
  lanEnabled: z.boolean(),
  lanAddresses: z.array(z.string()),
  tailscaleAddresses: z.array(z.string()),
  activePairing: z
    .object({
      code: z.string(),
      expiresAt: z.number(),
      qrUri: z.string(),
    })
    .nullable(),
  pairedDevices: z.array(PairedDeviceSchema),
});
export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatusSchema>;

// ── WebSocket Multiplexing Protocol (HM-Remote v1) ─────────────────────

export const WsClientFrameSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('subscribe'),
    sessionId: z.string(),
    afterSeq: z.number().int().nonnegative().default(0),
  }),
  z.object({
    op: z.literal('unsubscribe'),
    sessionId: z.string(),
  }),
  z.object({
    op: z.literal('subscribe_attention'),
  }),
  z.object({
    op: z.literal('subscribe_command_output'),
    sessionId: z.string(),
    toolCallId: z.string(),
  }),
  z.object({
    op: z.literal('unsubscribe_command_output'),
    sessionId: z.string(),
    toolCallId: z.string(),
  }),
  z.object({
    op: z.literal('subscribe_terminal'),
    terminalId: z.string().min(1),
  }),
  z.object({
    op: z.literal('unsubscribe_terminal'),
    terminalId: z.string().min(1),
  }),
  z.object({
    op: z.literal('terminal_input'),
    terminalId: z.string().min(1),
    data: z.string(),
  }),
  z.object({
    op: z.literal('terminal_resize'),
    terminalId: z.string().min(1),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(4).max(200),
  }),
  z.object({
    op: z.literal('ping'),
    ts: z.number().optional(),
  }),
]);
export type WsClientFrame = z.infer<typeof WsClientFrameSchema>;

export const AttentionItemSchema = z.object({
  kind: z.enum([
    'approval_needed',
    'turn_completed',
    'turn_failed',
    'session_updated',
    'harness_switched',
  ]),
  sessionId: z.string(),
  sessionTitle: z.string(),
  harnessId: z.string(),
  summary: z.string(),
  approvalId: z.string().optional(),
  timestamp: z.number(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const WsServerFrameSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('hello'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    desktopId: z.string(),
    desktopName: z.string(),
  }),
  z.object({
    op: z.literal('event'),
    event: CanonicalEventSchema,
  }),
  z.object({
    op: z.literal('replay_complete'),
    sessionId: z.string(),
    lastSeq: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal('attention'),
    item: AttentionItemSchema,
  }),
  z.object({
    op: z.literal('command_output'),
    sessionId: z.string(),
    toolCallId: z.string(),
    chunk: z.string(),
    stream: z.enum(['stdout', 'stderr']).default('stdout'),
    snapshot: z.boolean().optional(),
    done: z.boolean().optional(),
    timestamp: z.number(),
  }),
  z.object({
    op: z.literal('terminal_output'),
    terminalId: z.string(),
    chunk: z.string(),
    snapshot: z.boolean().optional(),
    truncated: z.boolean().optional(),
    ringBufferBytes: z.number().int().nonnegative().optional(),
    timestamp: z.number(),
  }),
  z.object({
    op: z.literal('terminal_status'),
    terminal: ManagedTerminalTabSchema,
    event: z.enum(['opened', 'updated', 'exited', 'restarted', 'closed']),
  }),
  z.object({ op: z.literal('plugins_changed') }),
  z.object({
    op: z.literal('agy_auth_state'),
    state: AgyAuthStateSchema,
  }),
  z.object({
    op: z.literal('triage_updated'),
    session: SessionTriageStateSchema,
    event: TriageSnoozeExpiredSchema.optional(),
  }),
  z.object({
    op: z.literal('pong'),
    ts: z.number(),
  }),
  z.object({
    op: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
]);
export type WsServerFrame = z.infer<typeof WsServerFrameSchema>;

// ── Multi-Harness Parallel Orchestrator REST Schemas ───────────────────

export const DelegateSubagentRequestSchema = z.object({
  targetInstanceId: z.string().min(1),
  roleTitle: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(40_000),
  isolation: SubagentIsolationSchema.default('read_only'),
  cohortId: z.string().trim().min(1).max(96).optional(),
  requestedApprovalPolicy: z.string().trim().min(1).max(32).optional(),
  model: z.string().nullable().optional(),
  timeoutMs: z.number().int().min(200).max(3_600_000).optional(),
  failFast: z.boolean().optional(),
  baseBranch: z.string().trim().min(1).max(120).optional(),
});
export type DelegateSubagentRequest = z.infer<typeof DelegateSubagentRequestSchema>;

export const SendToSubagentRequestSchema = z.object({
  text: z.string().trim().min(1).max(40_000),
});
export type SendToSubagentRequest = z.infer<typeof SendToSubagentRequestSchema>;

export const DryRunSubagentMergeRequestSchema = z.object({
  baseBranch: z.string().trim().min(1).max(120).optional(),
});
export type DryRunSubagentMergeRequest = z.infer<typeof DryRunSubagentMergeRequestSchema>;

export const MergeSubagentRequestSchema = z.object({
  baseBranch: z.string().trim().min(1).max(120).optional(),
  confirmMerge: z.boolean(),
  cleanupWorktree: z.boolean().default(false),
  deleteBranch: z.boolean().default(false),
  commitMessage: z.string().trim().min(1).max(240).optional(),
});
export type MergeSubagentRequest = z.infer<typeof MergeSubagentRequestSchema>;

// ── Context Compression & Symbol Index REST Schemas ─────────────────────

export const ManualCompressRequestSchema = z.object({
  fromSeq: z.number().int().min(0).optional(),
  toSeq: z.number().int().min(0).optional(),
  budgetChars: z.number().int().min(400).max(200_000).optional(),
  forceRecompute: z.boolean().optional(),
  includeSymbolOutline: z.boolean().optional(),
});
export type ManualCompressRequest = z.infer<typeof ManualCompressRequestSchema>;

export const UpdateCompressionConfigRequestSchema = z.object({
  summarizerInstanceId: z.string().trim().min(1).max(128).nullable().optional(),
  summarizerModel: z.string().trim().min(1).max(128).nullable().optional(),
  dailyCallLimit: z.number().int().min(0).max(10_000).optional(),
  sessionTokenBudgetCap: z.number().int().min(1_000).max(5_000_000).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  chunkSizeTurns: z.number().int().min(2).max(50).optional(),
  rollupTurnThreshold: z.number().int().min(5).max(500).optional(),
  backgroundRollupEnabled: z.boolean().optional(),
  symbolOutlineMaxChars: z.number().int().min(500).max(20_000).optional(),
});
export type UpdateCompressionConfigRequest = z.infer<typeof UpdateCompressionConfigRequestSchema>;

// ── Integrated PTY Terminal & Context Chips REST Schemas ──────────────

export const OpenTerminalRequestSchema = z.object({
  cwd: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(80).optional(),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(200).optional(),
  initialCommand: z.string().max(4_000).optional(),
  sessionId: z.string().min(1).optional(),
});
export type OpenTerminalRequest = z.infer<typeof OpenTerminalRequestSchema>;

export const TerminalInputRequestSchema = z.object({
  data: z.string().max(65_536),
});
export type TerminalInputRequest = z.infer<typeof TerminalInputRequestSchema>;

export const CreateTerminalContextChipRequestSchema = z.object({
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  recentLines: z.number().int().min(1).max(500).optional(),
  selectedText: z.string().max(200_000).optional(),
  sessionId: z.string().min(1).optional(),
});
export type CreateTerminalContextChipRequest = z.infer<typeof CreateTerminalContextChipRequestSchema>;

export const ReleaseTerminalsPathRequestSchema = z.object({
  targetPath: z.string().trim().min(1),
});
export type ReleaseTerminalsPathRequest = z.infer<typeof ReleaseTerminalsPathRequestSchema>;

// ── Phase AGY-2: Multi-Account Profile & Official Auth REST Schemas ─────

export const UpsertAgyInstanceRequestSchema = z.object({
  instanceId: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_.:-]*$/i),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  isolationMode: AgyIsolationModeSchema.optional(),
  authMethod: AgyAuthMethodSchema.default('oauth-personal'),
  geminiDir: z.string().optional(),
  appDataDirName: z.string().trim().min(1).max(80).default('antigravity-cli'),
  binaryPath: z.string().optional(),
  gcpProject: z.string().optional(),
  gcpLocation: z.string().optional(),
  defaults: AgyAccountDefaultsSchema.optional(),
  enabled: z.boolean().default(true),
});
export type UpsertAgyInstanceRequest = z.infer<typeof UpsertAgyInstanceRequestSchema>;

export const AgyAuthRespondRequestSchema = z.object({
  flowId: z.string().min(1),
  codeOrUrl: z.string().trim().min(1).max(4096),
});
export type AgyAuthRespondRequest = z.infer<typeof AgyAuthRespondRequestSchema>;

export const AgyAuthCancelRequestSchema = z.object({
  flowId: z.string().min(1).optional(),
});
export type AgyAuthCancelRequest = z.infer<typeof AgyAuthCancelRequestSchema>;

export const AgyAuthLogoutRequestSchema = z.object({
  confirmSharedKeyring: z.boolean().optional(),
});
export type AgyAuthLogoutRequest = z.infer<typeof AgyAuthLogoutRequestSchema>;
