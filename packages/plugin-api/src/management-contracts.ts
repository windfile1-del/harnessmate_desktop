/** Public UI/tool ownership contracts. Management uses the existing /api/v1/plugins HTTP API. */
export const MANAGEMENT_VIEW_CONTRACT = 'management.view.v1';
export const DEVELOPER_TOOLS_CONTRACT = 'developer.tools.v1';
export interface DeveloperTaskV1 {
  taskId: string;
  instanceId: string;
  runId: string;
  kind: 'generate' | 'author';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  closePolicy: 'cancel' | 'background';
  createdAt: number;
  updatedAt: number;
  result?: Record<string, unknown>;
  error?: string;
}
export interface PluginSettingsDescriptorV1 {
  instanceId: string;
  pluginId: string;
  version: string;
  schemaVersion: number;
  settings: Record<string, { type: 'string' | 'number' | 'boolean' | 'object' | 'array'; default?: unknown; description?: string; volatile?: boolean }>;
  config: Record<string, unknown>;
  views: Array<{ slot: string; id: string; title: string }>;
}
