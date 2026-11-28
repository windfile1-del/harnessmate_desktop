import type { InstalledPluginInfo, InstallPluginRequest, PluginManifest } from '@harnessmate/protocol';

export interface KernelHealthSnapshot {
  status: string;
  emptyComposition?: boolean;
  daemonVersion?: string;
  pluginSafeMode?: boolean;
  port?: number;
  uptimeSec?: number;
}

export interface KernelPluginsSnapshot {
  plugins: InstalledPluginInfo[];
  emptyComposition?: boolean;
  pluginsDir?: string;
}

export interface KernelCompositionEntry {
  id: string;
  name: string;
  disabled: boolean;
  config?: Record<string, unknown>;
  bindings?: Record<string, string>;
  sources?: string[];
}

export interface KernelCompositionSnapshot {
  bundles: string[];
  bindings?: Record<string, string>;
  entries: KernelCompositionEntry[];
  emptyComposition?: boolean;
  canRestore?: boolean;
  safeMode?: boolean;
  error?: string;
}

export interface KernelRestartResult {
  initiated: boolean;
  restartRequired: boolean;
  reason?: string;
}

interface MinimalElectronBridge {
  daemonUrl?: string;
  restartApp?: (options?: { safeMode?: boolean }) => Promise<{ ok?: boolean; reason?: string } | void>;
}

function getKernelBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const bridge = (window as unknown as { harnessMateBridge?: MinimalElectronBridge }).harnessMateBridge;
  return bridge?.daemonUrl ? bridge.daemonUrl.replace(/\/$/, '') : '';
}

async function kernelFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getKernelBaseUrl()}${path}`;
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!res.ok) {
    const obj = payload && typeof payload === 'object' ? (payload as { error?: unknown; code?: unknown }) : undefined;
    const err = new Error(obj?.error ? String(obj.error) : `HTTP ${res.status}`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    if (typeof obj?.code === 'string') err.code = obj.code;
    throw err;
  }
  return payload as T;
}

/**
 * Independent minimal kernel HTTP/recovery client.
 * Deliberately excludes business APIs, app-store, ModalHost, Sidebar, and chat modules.
 */
export const kernelRecoveryClient = {
  previewInstall(request: InstallPluginRequest) {
    return kernelFetch<{ manifest: PluginManifest; digest: string; installedDigest?: string; requiresTrust: boolean }>('/api/v1/plugins/preview', { method: 'POST', body: JSON.stringify(request) });
  },
  install(request: InstallPluginRequest) {
    return kernelFetch<KernelPluginsSnapshot>('/api/v1/plugins/install', { method: 'POST', body: JSON.stringify(request) });
  },
  getHealth(signal?: AbortSignal): Promise<KernelHealthSnapshot> {
    return kernelFetch<KernelHealthSnapshot>('/api/v1/health', { signal });
  },

  listPlugins(signal?: AbortSignal): Promise<KernelPluginsSnapshot> {
    return kernelFetch<KernelPluginsSnapshot>('/api/v1/plugins', { signal });
  },

  getComposition(signal?: AbortSignal): Promise<KernelCompositionSnapshot> {
    return kernelFetch<KernelCompositionSnapshot>('/api/v1/plugins/composition', { signal });
  },

  setCompositionBinding(
    contract: string,
    instanceId: string | null,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; composition: KernelCompositionSnapshot }> {
    return kernelFetch<{ ok: boolean; composition: KernelCompositionSnapshot }>('/api/v1/plugins/composition/bindings', {
      method: 'PUT',
      body: JSON.stringify({ contract, instanceId }),
      signal,
    });
  },

  togglePlugin(id: string, enabled: boolean, signal?: AbortSignal): Promise<KernelPluginsSnapshot> {
    return kernelFetch<KernelPluginsSnapshot>(`/api/v1/plugins/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
      signal,
    });
  },

  rollbackPlugin(id: string, signal?: AbortSignal): Promise<KernelPluginsSnapshot> {
    return kernelFetch<KernelPluginsSnapshot>(`/api/v1/plugins/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({}),
      signal,
    });
  },

  restoreComposition(
    source: 'builtin' | 'previous' | 'empty',
    signal?: AbortSignal,
  ): Promise<KernelPluginsSnapshot> {
    return kernelFetch<KernelPluginsSnapshot>('/api/v1/plugins/composition/restore', {
      method: 'POST',
      body: JSON.stringify({ source }),
      signal,
    });
  },

  reloadPlugins(signal?: AbortSignal): Promise<KernelPluginsSnapshot> {
    return kernelFetch<KernelPluginsSnapshot>('/api/v1/plugins/reload', {
      method: 'POST',
      body: JSON.stringify({}),
      signal,
    });
  },

  async requestRestart(options?: { safeMode?: boolean }): Promise<KernelRestartResult> {
    if (typeof window !== 'undefined') {
      const bridge = (window as unknown as { harnessMateBridge?: MinimalElectronBridge }).harnessMateBridge;
      if (typeof bridge?.restartApp === 'function') {
        await bridge.restartApp(options);
        return { initiated: true, restartRequired: false };
      }
    }
    return {
      initiated: false,
      restartRequired: true,
      reason: '当前浏览器环境不支持自动重启宿主进程，请刷新页面或重启 HarnessMate Desktop 完成生效。',
    };
  },
};
