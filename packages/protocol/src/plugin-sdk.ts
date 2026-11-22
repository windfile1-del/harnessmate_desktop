import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const label = z.string().trim().min(1).max(64);

export const PluginTurnEventSchema = z.enum(['turn.completed', 'turn.failed', 'turn.cancelled']);
export type PluginTurnEvent = z.infer<typeof PluginTurnEventSchema>;

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
  counts: z.boolean().optional(),
  openTurn: z.boolean().optional(),
  placements: z.array(z.enum(['sidebar_tool', 'composer_action'])).max(2).optional(),
  copySummary: z.object({ label, command: id.optional() }).strict().optional(),
}).strict();
export type PluginDataPanel = z.infer<typeof PluginDataPanelSchema>;

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
