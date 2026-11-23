import { z } from 'zod';
import { PluginTurnEventSchema, type PluginAction, type PluginProjection, type PluginTurnEvent } from '@harnessmate/plugin-api';

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);

export const PluginPermissionIdSchema = z.string().regex(/^(action|tool):[a-z0-9][a-z0-9_-]{0,39}$/);
export const SetPluginPermissionRequestSchema = z.object({
  workspaceId: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
  capability: PluginPermissionIdSchema, granted: z.boolean(),
}).strict();
export type SetPluginPermissionRequest = z.infer<typeof SetPluginPermissionRequestSchema>;

export const RunPluginActionRequestSchema = z.object({
  command: id, harnessId: z.string().min(1), args: z.string().max(12_000),
}).strict();
export type RunPluginActionRequest = z.infer<typeof RunPluginActionRequestSchema>;

export interface PluginPermission {
  pluginId: string;
  pluginName: string;
  digest: string;
  capability: string;
  description: string;
  granted: boolean;
}

export type SessionPluginAction = PluginAction & { pluginId: string; pluginName: string; reason?: string };

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
