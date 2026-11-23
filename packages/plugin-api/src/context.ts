import type { PluginEventName, PluginEventV4 } from './events.js';
import type { PLUGIN_API_VERSION } from './manifest.js';

export const pluginErrorCodes = [
  'E_PERMISSION_DENIED', 'E_SERVICE_UNAVAILABLE', 'E_NOT_SUPPORTED', 'E_TIMEOUT',
  'E_INVALID_INPUT', 'E_LIMIT_EXCEEDED', 'E_CONFLICT', 'E_STALE_RUN',
] as const;
export type PluginErrorCode = typeof pluginErrorCodes[number];

export class PluginApiError extends Error {
  constructor(readonly code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginApiError';
  }
}

export type Disposer = () => void;
export interface PluginContext {
  readonly api: { readonly version: typeof PLUGIN_API_VERSION; has(feature: string): boolean };
  get<Service = unknown>(name: string): Service | undefined;
  on<Name extends PluginEventName>(name: Name, listener: (event: PluginEventV4<Name>) => void | Promise<void>): Disposer;
  effect(activate: () => Disposer): Disposer;
}
