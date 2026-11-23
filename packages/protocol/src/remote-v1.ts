import { z } from 'zod';
import { PluginPanelQuerySchema } from './plugin-sdk.js';
import { PluginManifestSchema } from '@harnessmate/plugin-api';
import {
  ApprovalDecisionSchema,
  AttachmentSchema,
  CanonicalEventSchema,
  ContextSyncModeSchema,
  NativeHistorySourceSchema,
  PermissionModeSchema,
  GeneratedPluginManifestSchema,
  ReasoningEffortSchema,
  TaskStepSchema,
  TaskVerificationSchema,
  type Session,
} from './canonical.js';

export const PROTOCOL_VERSION = 'hm-remote-v1';

export const ImportNativeSessionRequestSchema = z.object({
  source: NativeHistorySourceSchema,
  nativeSessionId: z.string().min(1).max(200),
  workspaceId: z.string().optional(),
});
export type ImportNativeSessionRequest = z.infer<typeof ImportNativeSessionRequestSchema>;

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
  command: HarnessCommandName;
  description: string;
  argumentHint?: string;
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

export const SendTurnRequestSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
  harnessId: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
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
  decision: ApprovalDecisionSchema,
  comment: z.string().max(500).optional(),
  resolvedBy: z.enum(['desktop', 'mobile']).default('desktop'),
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
  targetHarnesses: z.array(z.enum(['codex', 'agy', 'claude'])).min(1),
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
});
export type AddMcpServerRequest = z.infer<typeof AddMcpServerRequestSchema>;

export const ToggleMcpServerRequestSchema = z.object({
  harnessId: z.enum(['codex', 'agy', 'claude']),
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
  z.object({ op: z.literal('plugins_changed') }),
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
