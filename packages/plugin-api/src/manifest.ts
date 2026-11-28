import { z } from 'zod';
import { PluginActionSchema, PluginDataPanelSchema, PluginProgramSchema, PluginProjectionSchema } from './contributions.js';
import { PluginSlotContributionSchema } from './slots.js';
import { FILE_PREVIEW_PERMISSION, FilePreviewContributionSchema } from './file-preview.js';

export const PLUGIN_API_VERSION = '4.0.0';
export const PLUGIN_MANIFEST_VERSION = 4;

export const PEER_CONTRACTS = {
  applicationView: 'application.view.v1',
  chatView: 'chat.view.v1',
  browser: 'browser.v1',
  filePreview: 'filePreview.v1',
  approvalPolicy: 'approval.policy.v1',
  runtimeRequests: 'runtime.requests.v1',
  runtimeRequestsView: 'runtime.requests.view.v1',
  runtimeRequestDelivery: 'runtime.request-delivery.v1',
  historySource: 'history.source.v1',
  historyImport: 'history.import.v1',
  sessionSearch: 'session.search.v1',
  gitWorkspace: 'git.workspace.v1',
  gitCheckpoint: 'git.checkpoint.v1',
  terminalWorkspace: 'terminal.workspace.v1',
  terminalRunner: 'terminal.runner.v1',
  workspaceFiles: 'workspace.files.v1',
  sessionAttachments: 'session.attachments.v1',
  workspaceRules: 'workspace.rules.v1',
  harnessUsage: 'harness.usage.v1',
  harnessModelCatalog: 'harness.model-catalog.v1',
  sessionFailover: 'session.failover.v1',
  harnessMcpConfig: 'harness.mcp-config.v1',
  sessionModelTools: 'session.model-tools.v1',
  sessionData: 'session.data.v1',
  sessionRuntime: 'session.runtime.v1',
  hmSessionData: 'hm.session-data.v1',
  harnessDriver: 'harness.driver.v1',
  harnessDriverCodex: 'harness.driver.codex.v1',
  harnessDriverClaude: 'harness.driver.claude.v1',
  harnessDriverAcp: 'harness.driver.acp.v1',
  harnessDriverAgy: 'harness.driver.agy.v1',
  sessionHandoff: 'session.handoff.v1',
  sessionCompression: 'session.compression.v1',
  sessionCollaboration: 'session.collaboration.v1',
  sessionOrchestration: 'session.orchestration.v1',
  agyRuntime: 'agy.runtime.v1',
  agyAccounts: 'agy.accounts.v1',
  agyWorkbench: 'agy.workbench.v1',
} as const;
export const PEER_CONTRACT_NAMES = [
  'application.view.v1',
  'chat.view.v1',
  'browser.v1',
  'filePreview.v1',
  'approval.policy.v1',
  'runtime.requests.v1',
  'runtime.requests.view.v1',
  'runtime.request-delivery.v1',
  'history.source.v1',
  'history.import.v1',
  'session.search.v1',
  'git.workspace.v1',
  'git.checkpoint.v1',
  'terminal.workspace.v1',
  'terminal.runner.v1',
  'workspace.files.v1',
  'session.attachments.v1',
  'workspace.rules.v1',
  'harness.usage.v1',
  'harness.model-catalog.v1',
  'session.failover.v1',
  'harness.mcp-config.v1',
  'session.model-tools.v1',
  'session.data.v1',
  'session.runtime.v1',
  'hm.session-data.v1',
  'harness.driver.v1',
  'harness.driver.codex.v1',
  'harness.driver.claude.v1',
  'harness.driver.acp.v1',
  'harness.driver.agy.v1',
  'session.handoff.v1',
  'session.compression.v1',
  'session.collaboration.v1',
  'session.orchestration.v1',
  'agy.runtime.v1',
  'agy.accounts.v1',
  'agy.workbench.v1',
] as const;
export type PeerContractName = typeof PEER_CONTRACT_NAMES[number];

const DYNAMIC_DRIVER_CONTRACT_PATTERN = /^harness\.driver\.[a-z0-9][a-z0-9._-]{0,47}\.v1$/i;

export function isDynamicDriverPeerContract(name: string): boolean {
  return DYNAMIC_DRIVER_CONTRACT_PATTERN.test(name);
}

export function isPeerContractName(name: string): name is PeerContractName {
  return (PEER_CONTRACT_NAMES as readonly string[]).includes(name) || isDynamicDriverPeerContract(name);
}

export const PluginServiceNameSchema = z.union([
  z.enum(PEER_CONTRACT_NAMES),
  z.string().max(100).regex(DYNAMIC_DRIVER_CONTRACT_PATTERN),
  z.string().max(100).regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/),
]);
const services = z.array(PluginServiceNameSchema).max(32).refine((names) => new Set(names).size === names.length);

export const BUILTIN_PUBLIC_SERVICES = ['ledger', 'handoff', 'git', 'usage', 'notify'] as const;
export type BuiltinPublicServiceName = typeof BUILTIN_PUBLIC_SERVICES[number];

export function isReservedServiceName(name: string): boolean {
  return name === 'harness' || (name.startsWith('harness.') && !isPeerContractName(name))
    || name === 'mcpHub' || name === 'remote' || name === 'native-commands' || name === 'failover';
}

export function isBuiltinPublicService(name: string): name is BuiltinPublicServiceName {
  return (BUILTIN_PUBLIC_SERVICES as readonly string[]).includes(name);
}

export function isThirdPartyCustomServiceName(name: string): boolean {
  return !isReservedServiceName(name) && !isBuiltinPublicService(name) && (isPeerContractName(name) || (name.includes('.') && !name.startsWith('core.')));
}

export const STATIC_PLUGIN_PERMISSIONS = [
  'events:turn',
  'events:message',
  'events:tool',
  'events:approval',
  'session:read',
  'session:command',
  'session:send',
  'session:fork',
  'session:switch',
  'session:orchestrate',
  'composer:suggest',
  'handoff:section',
  'handoff:redact',
  'context:compressor',
  'approvals:annotate',
  'storage:plugin',
  'storage:workspace',
  'fs:workspace:read',
  'fs:workspace:write',
  'fs:cli_histories:read',
  'workspace:git:read',
  'workspace:git:write',
  'process:pty:workspace',
  'harness:driver:register',
  'notify',
  'clipboard:write',
  'browser:preview',
  FILE_PREVIEW_PERMISSION,
  'tools:model',
] as const;
export type StaticPluginPermission = typeof STATIC_PLUGIN_PERMISSIONS[number];

const staticPermissionSet = new Set<string>(STATIC_PLUGIN_PERMISSIONS);
const netHostPattern = /^net:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const safeTokenPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isValidPluginPermission(value: string): boolean {
  if (staticPermissionSet.has(value)) return true;
  if (value.startsWith('net:')) {
    return value.length <= 257 && netHostPattern.test(value);
  }
  if (value.startsWith('service:provide:')) {
    const service = value.slice('service:provide:'.length);
    return PluginServiceNameSchema.safeParse(service).success && !isReservedServiceName(service);
  }
  if (value.startsWith('process:spawn:')) {
    const binary = value.slice('process:spawn:'.length);
    return safeTokenPattern.test(binary) && !binary.includes('..');
  }
  if (value.startsWith('secrets:read:')) {
    const ns = value.slice('secrets:read:'.length);
    return safeTokenPattern.test(ns) && !ns.includes('..');
  }
  return false;
}

export const PluginPermissionSchema = z.string().min(1).max(260).refine(isValidPluginPermission, '无效的 V4 插件权限声明');
export type PluginPermissionDeclaration = z.infer<typeof PluginPermissionSchema>;

export const PluginCommandSchema = z.object({
  command: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/),
  description: z.string().max(160),
  argumentHint: z.string().max(80).optional(),
}).strict();
export type PluginCommand = z.infer<typeof PluginCommandSchema>;

export const PluginSettingSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  default: z.unknown().optional(),
  description: z.string().max(240).optional(),
  volatile: z.boolean().optional(),
}).strict();
export type PluginSetting = z.infer<typeof PluginSettingSchema>;

export const CustomAcpHarnessConfigSchema = z.object({
  id: z.string().min(1).max(48).regex(/^[a-z0-9][a-z0-9_-]*$/),
  displayName: z.string().min(1).max(80),
  description: z.string().max(240).default('Custom ACP CLI Harness'),
  command: z.string().min(1),
  args: z.array(z.string()).default(['acp', '--stdio']),
  env: z.record(z.string()).optional(),
});
export type CustomAcpHarnessConfig = z.infer<typeof CustomAcpHarnessConfigSchema>;

export const PluginCategorySchema = z.enum([
  'harness',
  'tool',
  'mcp',
  'telemetry',
  'ui',
  'remote',
  'workflow',
]);
export type PluginCategory = z.infer<typeof PluginCategorySchema>;

export const PluginSlashCommandSchema = z.object({
  command: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/),
  description: z.string().max(160),
  template: z.string().min(1),
  argumentHint: z.string().max(80).optional(),
});
export type PluginSlashCommand = z.infer<typeof PluginSlashCommandSchema>;

export const PluginMcpPresetSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(200),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
});
export type PluginMcpPreset = z.infer<typeof PluginMcpPresetSchema>;

export const PluginPanelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  title: z.string().trim().min(1).max(64),
  description: z.string().max(240).optional(),
  sections: z.array(z.enum(['turns', 'changed_files', 'verifications', 'recent_activity'])).max(4).default([]),
  actions: z.array(z.object({
    label: z.string().trim().min(1).max(48),
    command: PluginSlashCommandSchema.shape.command,
    args: z.string().max(240).optional(),
  })).max(6).default([]),
}).strict();
export type PluginPanel = z.infer<typeof PluginPanelSchema>;

export const PluginContributesSchema = z.object({
  harnesses: z.array(CustomAcpHarnessConfigSchema).optional(),
  slashCommands: z.array(PluginSlashCommandSchema).optional(),
  commands: z.array(PluginCommandSchema).max(24).optional(),
  mcpPresets: z.array(PluginMcpPresetSchema).optional(),
  panels: z.array(PluginPanelSchema).max(6).optional(),
  projections: z.array(PluginProjectionSchema).max(6).optional(),
  dataPanels: z.array(PluginDataPanelSchema).max(6).optional(),
  programs: z.array(PluginProgramSchema).max(12).optional(),
  actions: z.array(PluginActionSchema).max(12).optional(),
  slots: z.array(PluginSlotContributionSchema).max(12).optional(),
  filePreview: FilePreviewContributionSchema.optional(),
  settings: z.record(PluginSettingSchema).optional(),
  settingsVersion: z.number().int().positive().optional(),
  uiSlots: z
    .array(z.enum(['sidebar_tool', 'inspector_tab', 'composer_action', 'modal']))
    .optional(),
  hooks: z.array(z.enum(['before_turn', 'after_turn', 'on_event'])).optional(),
});
export type PluginContributes = z.infer<typeof PluginContributesSchema>;

const permissions = z.array(PluginPermissionSchema).max(64).refine((items) => new Set(items).size === items.length);

export const PluginDependencyDeclarationSchema = z.object({
  contract: PluginServiceNameSchema,
  version: z.string().trim().min(1).max(40).optional(),
  optional: z.boolean().optional(),
}).strict();
export type PluginDependencyDeclaration = z.infer<typeof PluginDependencyDeclarationSchema>;

export const PluginManifestSchema = z.object({
  id: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1).max(80),
  version: z.string().default('1.0.0'),
  description: z.string().max(320),
  author: z.string().max(80).optional(),
  category: PluginCategorySchema.default('workflow'),
  entry: z.string().optional(),
  apiVersion: z.number().int().positive().optional(),
  engines: z.object({ pluginApi: z.string().trim().min(1).max(80) }).optional(),
  main: z.string().optional(),
  inject: services.optional(),
  optional: services.optional(),
  provides: services.optional(),
  dependencies: z.record(z.string().min(1).max(64), PluginDependencyDeclarationSchema).optional(),
  startPage: z.string().trim().min(1).max(80).optional(),
  activationEvents: z.array(z.string().min(1).max(120)).max(32).optional(),
  permissions: permissions.optional(),
  contributes: PluginContributesSchema.default({}),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginManifestV4Schema = PluginManifestSchema.extend({
  apiVersion: z.literal(PLUGIN_MANIFEST_VERSION),
  engines: PluginManifestSchema.shape.engines.unwrap(),
}).omit({ entry: true });
export type PluginManifestV4 = z.infer<typeof PluginManifestV4Schema>;
