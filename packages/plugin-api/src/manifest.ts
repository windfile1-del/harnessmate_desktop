import { z } from 'zod';
import { PluginActionSchema, PluginDataPanelSchema, PluginProgramSchema, PluginProjectionSchema } from './contributions.js';
import { PluginSlotContributionSchema } from './slots.js';

export const PLUGIN_API_VERSION = '4.0.0';
export const PLUGIN_MANIFEST_VERSION = 4;
export const PluginServiceNameSchema = z.string().max(100).regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/);
const services = z.array(PluginServiceNameSchema).max(32).refine((names) => new Set(names).size === names.length);

export const BUILTIN_PUBLIC_SERVICES = ['ledger', 'handoff', 'git', 'usage', 'notify'] as const;
export type BuiltinPublicServiceName = typeof BUILTIN_PUBLIC_SERVICES[number];

export function isReservedServiceName(name: string): boolean {
  return name === 'harness' || name.startsWith('harness.') || name === 'mcpHub' || name === 'remote' || name === 'native-commands' || name === 'failover';
}

export function isBuiltinPublicService(name: string): name is BuiltinPublicServiceName {
  return (BUILTIN_PUBLIC_SERVICES as readonly string[]).includes(name);
}

export function isThirdPartyCustomServiceName(name: string): boolean {
  return !isReservedServiceName(name) && !isBuiltinPublicService(name) && name.includes('.') && !name.startsWith('core.');
}

export const STATIC_PLUGIN_PERMISSIONS = [
  'events:turn',
  'events:message',
  'events:tool',
  'events:approval',
  'session:read',
  'session:command',
  'session:send',
  'composer:suggest',
  'handoff:section',
  'approvals:annotate',
  'storage:plugin',
  'storage:workspace',
  'fs:workspace:read',
  'fs:workspace:write',
  'notify',
  'clipboard:write',
  'browser:preview',
  'tools:model',
] as const;
export type StaticPluginPermission = typeof STATIC_PLUGIN_PERMISSIONS[number];

const staticPermissionSet = new Set<string>(STATIC_PLUGIN_PERMISSIONS);
const netHostPattern = /^net:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function isValidPluginPermission(value: string): boolean {
  if (staticPermissionSet.has(value)) return true;
  if (value.startsWith('net:')) {
    return value.length <= 257 && netHostPattern.test(value);
  }
  if (value.startsWith('service:provide:')) {
    const service = value.slice('service:provide:'.length);
    return PluginServiceNameSchema.safeParse(service).success && !isReservedServiceName(service);
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
  type: z.enum(['string', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
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
  settings: z.record(PluginSettingSchema).optional(),
  uiSlots: z
    .array(z.enum(['sidebar_tool', 'inspector_tab', 'composer_action', 'modal']))
    .optional(),
  hooks: z.array(z.enum(['before_turn', 'after_turn', 'on_event'])).optional(),
});
export type PluginContributes = z.infer<typeof PluginContributesSchema>;

const permissions = z.array(PluginPermissionSchema).max(64).refine((items) => new Set(items).size === items.length);

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
