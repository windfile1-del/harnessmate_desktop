import { z } from 'zod';
import {
  PluginTurnEventSchema,
  isValidPluginPermission,
  type PluginAction,
  type PluginCommand,
  type PluginProjection,
  type PluginTurnEvent,
} from '@harnessmate/plugin-api';

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);

const legacyCapabilityPattern = /^(action|tool):[a-z0-9][a-z0-9_-]{0,39}$/;
export const PluginPermissionIdSchema = z.string().min(1).max(260).refine(
  (value) => legacyCapabilityPattern.test(value) || isValidPluginPermission(value),
  '无效的插件权限标识',
);
export const SetPluginPermissionRequestSchema = z.object({
  workspaceId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  capability: PluginPermissionIdSchema,
  granted: z.boolean(),
  coverFuture: z.boolean().optional(),
}).strict();
export type SetPluginPermissionRequest = z.infer<typeof SetPluginPermissionRequestSchema>;

export const RunPluginActionRequestSchema = z.object({
  command: id, harnessId: z.string().min(1), args: z.string().max(12_000), pluginId: z.string().min(1).max(96).optional(),
}).strict();
export type RunPluginActionRequest = z.infer<typeof RunPluginActionRequestSchema>;

export interface PluginPermission {
  pluginId: string;
  pluginName: string;
  digest: string;
  capability: string;
  description: string;
  granted: boolean;
  risk?: 'low' | 'medium' | 'high';
  scope?: 'workspace' | 'global';
  coverFuture?: boolean;
  inheritedFromDigest?: string;
}

export type SessionPluginAction = PluginAction & { pluginId: string; pluginName: string; reason?: string };
export type SessionPluginCommand = PluginCommand & { pluginId: string; pluginName: string };

export interface SessionModelPluginTools {
  count: number;
  status: 'none' | 'next_turn' | 'configured' | 'connected' | 'unsupported';
}

export const PluginPanelQuerySchema = z.object({
  event: PluginTurnEventSchema.optional(),
  harnessId: z.string().min(1).max(128).optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
}).strict();
export type PluginPanelQuery = z.infer<typeof PluginPanelQuerySchema>;

export interface PluginTurnRow {
  seq: number;
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  harnessId: string | null;
  event: PluginTurnEvent;
  timestamp: number;
  imported: boolean;
  files?: string[];
  verifications?: Array<{ command: string; status: 'pass' | 'fail' | 'unknown' }>;
}

export interface PluginPanelSnapshot {
  scope: PluginProjection['scope'];
  counts: Array<{ event: PluginTurnEvent; harnessId: string | null; count: number }>;
  rows: PluginTurnRow[];
  total: number;
  pageSize: number;
}

export const PluginUiMessageRequestSchema = z.object({
  slotId: id,
  slot: z.string().min(1).max(64).optional(),
  runId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).nullable().optional(),
  payload: z.unknown(),
}).strict();
export type PluginUiMessageRequest = z.infer<typeof PluginUiMessageRequestSchema>;

export interface PluginLogEntryDto {
  timestamp: number;
  pluginId: string;
  runId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source?: 'plugin' | 'host';
  message: string;
  meta?: Record<string, unknown>;
}

export const PluginScaffoldTemplateSchema = z.enum([
  'isolated',
  'ui-slot',
  'service',
  'declarative',
  'browser-preview',
  'browser-workspace',
  'markdown-preview',
  'harness-adapter',
]);
export type PluginScaffoldTemplateDto = z.infer<typeof PluginScaffoldTemplateSchema>;

export const ScaffoldPluginRequestSchema = z.object({
  id: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(320).optional(),
  author: z.string().max(80).optional(),
  template: PluginScaffoldTemplateSchema.default('isolated'),
  serviceName: z.string().max(100).optional(),
  driverId: z.string().max(40).optional(),
  binaryName: z.string().max(64).optional(),
  targetDir: z.string().min(1).max(500).optional(),
  linkDevMode: z.boolean().default(true),
}).strict();
export type ScaffoldPluginRequest = z.infer<typeof ScaffoldPluginRequestSchema>;

export const LinkDevPluginRequestSchema = z.object({
  trustedId: z.string().min(1).max(64).optional(),
  dirPath: z.string().trim().min(1).max(500),
}).strict();
export type LinkDevPluginRequest = z.infer<typeof LinkDevPluginRequestSchema>;

export const TrustedPublisherSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().trim().min(1).max(120),
  publicKeyPem: z.string().trim().min(32).max(4096),
  addedAt: z.number().optional(),
});
export type TrustedPublisher = z.infer<typeof TrustedPublisherSchema>;

export const RemotePluginEntrySchema = z.object({
  id: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
  description: z.string().max(320),
  author: z.string().max(80).optional(),
  category: z.enum(['harness', 'tool', 'mcp', 'telemetry', 'ui', 'remote', 'workflow']).default('workflow'),
  tags: z.array(z.string()).default([]),
  engines: z.object({ pluginApi: z.string().min(1).max(80) }),
  publisherId: z.string().min(1).max(80),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(16).max(512).optional(),
  files: z.record(z.string()).optional(),
  downloadUrl: z.string().url().optional(),
});
export type RemotePluginEntry = z.infer<typeof RemotePluginEntrySchema>;

export const RemotePluginIndexSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().optional(),
  registryName: z.string().max(120).optional(),
  publishers: z.array(TrustedPublisherSchema).default([]),
  entries: z.array(RemotePluginEntrySchema).default([]),
});
export type RemotePluginIndex = z.infer<typeof RemotePluginIndexSchema>;

export const UpdatePluginRegistryConfigRequestSchema = z.object({
  indexUrls: z.array(z.string().trim().min(1).max(500)).max(10),
  requireSigned: z.boolean().optional(),
}).strict();
export type UpdatePluginRegistryConfigRequest = z.infer<typeof UpdatePluginRegistryConfigRequestSchema>;

export const AddTrustedPublisherRequestSchema = TrustedPublisherSchema.omit({ addedAt: true }).strict();
export type AddTrustedPublisherRequest = z.infer<typeof AddTrustedPublisherRequestSchema>;

export interface PluginRegistryStateDto {
  indexUrls: string[];
  requireSigned: boolean;
  trustedPublishers: TrustedPublisher[];
  lastSyncedAt: number | null;
  errors: Array<{ url: string; error: string }>;
}

// ── AI Plugin Builder v2 Schemas ────────────────────────────────────────

export const PluginBuilderTierSchema = z.enum(['auto', 'tier1', 'tier2']);
export type PluginBuilderTier = z.infer<typeof PluginBuilderTierSchema>;

export const PluginBuilderTemplateSchema = z.enum([
  'isolated',
  'ui-slot',
  'service',
  'harness-adapter',
]);
export type PluginBuilderTemplate = z.infer<typeof PluginBuilderTemplateSchema>;

export const PluginBuilderInstallModeSchema = z.enum(['local_install', 'dev_link']);
export type PluginBuilderInstallMode = z.infer<typeof PluginBuilderInstallModeSchema>;

export const PluginAuditIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
});
export type PluginAuditIssue = z.infer<typeof PluginAuditIssueSchema>;

export const PluginAuditPermissionSummarySchema = z.object({
  capability: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  scope: z.enum(['workspace', 'global']),
  description: z.string(),
  unused: z.boolean().optional(),
});
export type PluginAuditPermissionSummary = z.infer<typeof PluginAuditPermissionSummarySchema>;

export const PluginStaticAuditReportSchema = z.object({
  passed: z.boolean(),
  blockingIssues: z.array(PluginAuditIssueSchema),
  warnings: z.array(PluginAuditIssueSchema),
  permissionSummary: z.array(PluginAuditPermissionSummarySchema),
});
export type PluginStaticAuditReport = z.infer<typeof PluginStaticAuditReportSchema>;

export const BuilderVerificationStepSchema = z.object({
  step: z.enum([
    'manifest_schema',
    'static_audit_and_syntax',
    'mock_host_activation',
    'sandbox_ui_check',
  ]),
  label: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().nonnegative(),
  details: z.string(),
  errors: z.array(z.string()).default([]),
});
export type BuilderVerificationStep = z.infer<typeof BuilderVerificationStepSchema>;

export const BuilderAttemptLogSchema = z.object({
  attempt: z.number().int().min(1),
  durationMs: z.number().nonnegative(),
  passed: z.boolean(),
  steps: z.array(BuilderVerificationStepSchema),
  errorSummary: z.string().optional(),
});
export type BuilderAttemptLog = z.infer<typeof BuilderAttemptLogSchema>;

export const BuilderV2GenerateRequestSchema = z
  .object({
    description: z.string().trim().min(3).max(8_000),
    harnessId: z.string().min(1),
    workspaceId: z.string().min(1),
    model: z.string().min(1).optional(),
    tier: PluginBuilderTierSchema.default('auto'),
    template: PluginBuilderTemplateSchema.optional(),
    pluginId: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    previous: z.record(z.unknown()).optional(),
    editing: z
      .object({
        id: z.string().min(2).max(64),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    maxAttempts: z.number().int().min(1).max(3).default(3),
  })
  .strict();
export type BuilderV2GenerateRequest = z.infer<typeof BuilderV2GenerateRequestSchema>;

export const BuilderV2AuditRequestSchema = z
  .object({
    manifest: z.record(z.unknown()).optional(),
    files: z.record(z.string()),
  })
  .strict();
export type BuilderV2AuditRequest = z.infer<typeof BuilderV2AuditRequestSchema>;

export const BuilderV2InstallRequestSchema = z
  .object({
    draftId: z.string().min(1).max(120).optional(),
    files: z.record(z.string()).optional(),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    trustCode: z.boolean(),
    installMode: PluginBuilderInstallModeSchema.default('local_install'),
    targetDir: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type BuilderV2InstallRequest = z.infer<typeof BuilderV2InstallRequestSchema>;

export interface BuilderV2Result {
  tierUsed: 'tier1' | 'tier2';
  classificationReason: string;
  templateUsed?: PluginBuilderTemplate;
  draftId?: string;
  digest?: string;
  verified: boolean;
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
  audit?: PluginStaticAuditReport;
  steps?: BuilderVerificationStep[];
  attempts?: BuilderAttemptLog[];
  error?: string;
}
