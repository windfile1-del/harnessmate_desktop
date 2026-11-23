import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const label = z.string().trim().min(1).max(64);

export const PluginTurnEventSchema = z.enum(['turn.completed', 'turn.failed', 'turn.cancelled']);
export type PluginTurnEvent = z.infer<typeof PluginTurnEventSchema>;

export const PluginNativeCommandSchema = z.enum(['compact', 'usage', 'model', 'plan', 'goal', 'skills', 'skill']);

const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim') }).strict(),
  z.object({ op: z.literal('case'), mode: z.enum(['lower', 'upper']) }).strict(),
  z.object({ op: z.literal('replace'), find: z.string().min(1).max(256), replacement: z.string().max(256) }).strict(),
  z.object({ op: z.literal('wrap'), prefix: z.string().max(512), suffix: z.string().max(512) }).strict(),
  z.object({ op: z.literal('lines'), contains: z.string().min(1).max(256).optional(), ignoreCase: z.boolean().optional(),
    unique: z.boolean().optional(), order: z.enum(['asc', 'desc']).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
]);

export const PluginProgramSchema = z.object({
  id, description: z.string().trim().min(1).max(160),
  steps: z.array(operation).min(1).max(16),
  exposeToModel: z.boolean().optional(),
}).strict();
export type PluginProgram = z.infer<typeof PluginProgramSchema>;

const action = { command: id, description: z.string().trim().min(1).max(160) };
export const PluginActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...action, kind: z.literal('program'), program: id }).strict(),
  z.object({ ...action, kind: z.literal('harness'), nativeCommand: PluginNativeCommandSchema,
    args: z.string().max(2_000).optional() }).strict(),
]);
export type PluginAction = z.infer<typeof PluginActionSchema>;

export const PluginProjectionSchema = z.object({
  id,
  scope: z.enum(['session', 'workspace']),
  events: z.array(PluginTurnEventSchema).min(1).max(3),
}).strict();
export type PluginProjection = z.infer<typeof PluginProjectionSchema>;

export const PluginPanelFieldSchema = z.enum([
  'time', 'session', 'harness', 'status', 'changed_files', 'verifications',
]);
export type PluginPanelField = z.infer<typeof PluginPanelFieldSchema>;

export const PluginDataPanelSchema = z.object({
  id,
  title: label,
  description: z.string().max(240).optional(),
  projection: id,
  columns: z.array(z.object({ field: PluginPanelFieldSchema, label }).strict()).min(1).max(6),
  filters: z.array(z.enum(['harness', 'status'])).max(2).optional(),
  defaultEvent: PluginTurnEventSchema.optional(),
  counts: z.boolean().optional(),
  openTurn: z.boolean().optional(),
  placements: z.array(z.enum(['sidebar_tool', 'composer_action'])).max(2).optional(),
  copySummary: z.object({ label, command: id.optional() }).strict().optional(),
}).strict();
export type PluginDataPanel = z.infer<typeof PluginDataPanelSchema>;
