import type { PluginErrorCode } from './context.js';
import type { PluginRuntimeSlotDescriptor } from './slots.js';

export const PLUGIN_RPC_PROTOCOL_VERSION = 1;

export const HOST_SUPPORTED_FEATURES = [
  'rpc.v1',
  'isolation.process',
  'services.third-party',
  'permissions.v4',
  'handoff.compose',
  'handoff.shouldOffer',
  'approvals.annotate',
  'tools.model',
  'commands.v4',
  'storage.kv',
  'fs.workspace',
  'net.fetch',
  'ui.slots',
] as const;

export interface PluginHandshakeRequest {
  protocolVersion: number;
  pluginApi: string;
  features: readonly string[];
  pluginId: string;
  packageDigest: string;
  runId: string;
  config: Readonly<Record<string, unknown>>;
  declaredPermissions: readonly string[];
  services: readonly string[];
}

export interface PluginHandshakeResponse {
  sdkVersion: string;
  name?: string;
  requires?: readonly string[];
  inject?: readonly string[];
  optional?: readonly string[];
  provides?: readonly string[];
  serviceMethods?: Record<string, readonly string[]>;
  commands?: readonly string[];
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }>;
  slots?: PluginRuntimeSlotDescriptor[];
  sections?: Array<{ id: string; order?: number; text: string }>;
  subscribedEvents?: readonly string[];
  hasHandoffCompose?: boolean;
  hasHandoffShouldOffer?: boolean;
  hasApprovalAnnotate?: boolean;
}

export interface PluginRpcErrorPayload {
  code: PluginErrorCode | 'E_INTERNAL';
  message: string;
}

export interface PluginRpcRequest {
  jsonrpc: '2.0';
  id: number;
  runId: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface PluginRpcNotification {
  jsonrpc: '2.0';
  runId: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface PluginRpcResponse {
  jsonrpc: '2.0';
  id: number;
  runId: string;
  result?: unknown;
  error?: PluginRpcErrorPayload;
}

export type PluginRpcMessage = PluginRpcRequest | PluginRpcNotification | PluginRpcResponse;
