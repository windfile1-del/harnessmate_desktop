import { z } from 'zod';
import { PluginActionSchema, PluginDataPanelSchema, PluginProgramSchema, PluginProjectionSchema } from './contributions.js';

export const PLUGIN_API_VERSION = '4.0.0';
export const PLUGIN_MANIFEST_VERSION = 4;
export const PluginServiceNameSchema = z.string().max(100).regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/);
const services = z.array(PluginServiceNameSchema).max(32).refine((names) => new Set(names).size === names.length);

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

export const PluginContributesSchema = z.object({
  harnesses: z.array(CustomAcpHarnessConfigSchema).optional(),
  slashCommands: z.array(PluginSlashCommandSchema).optional(),
  mcpPresets: z.array(PluginMcpPresetSchema).optional(),
  panels: z.array(PluginPanelSchema).max(6).optional(),
  projections: z.array(PluginProjectionSchema).max(6).optional(),
  dataPanels: z.array(PluginDataPanelSchema).max(6).optional(),
  programs: z.array(PluginProgramSchema).max(12).optional(),
  actions: z.array(PluginActionSchema).max(12).optional(),
  uiSlots: z
    .array(z.enum(['sidebar_tool', 'inspector_tab', 'composer_action', 'modal']))
    .optional(),
  hooks: z.array(z.enum(['before_turn', 'after_turn', 'on_event'])).optional(),
});
export type PluginContributes = z.infer<typeof PluginContributesSchema>;

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
  contributes: PluginContributesSchema.default({}),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginManifestV4Schema = PluginManifestSchema.extend({
  apiVersion: z.literal(PLUGIN_MANIFEST_VERSION),
  engines: PluginManifestSchema.shape.engines.unwrap(),
}).omit({ entry: true });
export type PluginManifestV4 = z.infer<typeof PluginManifestV4Schema>;
