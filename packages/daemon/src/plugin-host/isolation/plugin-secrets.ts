import { PluginApiError } from '@harnessmate/plugin-api';

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Extracts and validates `<namespace>` from a plugin secret reference
 * formatted as `<namespace>:<key>` (e.g. `vendor:api_key`, `server:password`).
 */
export function parseSecretNamespace(secretRef: string): string {
  if (typeof secretRef !== 'string' || !secretRef.trim() || secretRef.length > 160) {
    throw new PluginApiError('E_INVALID_INPUT', '无效的 secretRef 格式');
  }
  const colonIdx = secretRef.indexOf(':');
  if (colonIdx <= 0 || colonIdx === secretRef.length - 1) {
    throw new PluginApiError('E_INVALID_INPUT', 'secretRef 必须为 <namespace>:<key> 格式');
  }
  const namespace = secretRef.slice(0, colonIdx);
  if (!NAMESPACE_PATTERN.test(namespace) || namespace.includes('..')) {
    throw new PluginApiError('E_INVALID_INPUT', `非法的密钥命名空间: ${namespace}`);
  }
  return namespace;
}

/**
 * In-memory credential store for isolated V5 plugins.
 * Secrets are never logged, persisted to SQLite session history, or emitted on event buses.
 */
export class PluginSecretStore {
  private readonly secrets = new Map<string, string>();

  set(secretRef: string, value: string): void {
    parseSecretNamespace(secretRef);
    if (typeof value !== 'string') {
      throw new PluginApiError('E_INVALID_INPUT', '密钥值必须为字符串');
    }
    this.secrets.set(secretRef, value);
  }

  delete(secretRef: string): boolean {
    return this.secrets.delete(secretRef);
  }

  has(secretRef: string): boolean {
    return this.secrets.has(secretRef);
  }

  resolve(secretRef: string): string | null {
    parseSecretNamespace(secretRef);
    return this.secrets.get(secretRef) ?? null;
  }

  clear(): void {
    this.secrets.clear();
  }
}
