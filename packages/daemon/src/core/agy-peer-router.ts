import {
  AGY_ACCOUNTS_CONTRACT,
  AGY_RUNTIME_CONTRACT,
  AGY_WORKBENCH_CONTRACT,
  HARNESS_DRIVER_AGY_CONTRACT,
  PluginApiError,
  type AgyAccountsServiceV1,
  type AgyRuntimeServiceV1,
  type AgyWorkbenchServiceV1,
  type ServiceResolutionV1,
} from '@harnessmate/plugin-api';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { PluginManager } from '../plugins/plugin-manager.js';

export interface ResolvedAgyRuntimeProvider {
  instanceId: string;
  runId: string;
  service: AgyRuntimeServiceV1;
  source: 'explicit' | 'session_owner' | 'driver_owner' | 'service_selection';
}

export interface ResolvedAgyAccountsProvider {
  instanceId: string;
  runId: string;
  service: AgyAccountsServiceV1;
  source: 'explicit' | 'service_selection';
}

export interface ResolvedAgyWorkbenchProvider {
  instanceId: string;
  runId: string;
  service: AgyWorkbenchServiceV1;
}

export function recordAgyRuntimeOwner(
  store: HarnessMateStore,
  sessionId: string,
  providerInstanceId: string,
  workspaceId?: string | null,
): void {
  store.upsertResourceOwner({
    resourceType: 'session',
    resourceId: sessionId,
    contract: AGY_RUNTIME_CONTRACT,
    instanceId: providerInstanceId,
    workspaceId: workspaceId ?? null,
  });
}

export function getRecordedAgyRuntimeOwner(
  store: HarnessMateStore,
  sessionId: string,
): string | undefined {
  return store.getResourceOwner('session', sessionId, AGY_RUNTIME_CONTRACT)?.instanceId;
}

function buildDisabledError(contract: string, resolution: ServiceResolutionV1): PluginApiError {
  if (resolution.status === 'disabled') {
    return new PluginApiError(
      'E_PLUGIN_DISABLED',
      `AGY 插件实例 (${resolution.instanceId ?? 'unknown'}) 已停用 (${contract})`,
    );
  }
  return new PluginApiError(
    'E_SERVICE_UNAVAILABLE',
    `AGY 服务契约 ${contract} 当前不可用 (${resolution.status})`,
  );
}

/**
 * Resolves the owning `agy.runtime.v1` provider for a session/workspace/explicit instance.
 * Guarantees:
 * - Explicit or session-pinned providers NEVER fall back to another instance when disabled (`E_PLUGIN_DISABLED`).
 * - Workspace/session binding selection determines provider independent of plugin load order.
 */
export function resolveAgyRuntimeProvider(
  pluginManager: PluginManager,
  opts: {
    sessionId?: string;
    workspaceId?: string;
    explicitInstanceId?: string | null;
    driverProviderInstanceId?: string | null;
    store?: HarnessMateStore;
    allowSingleCandidate?: boolean;
  } = {},
): ResolvedAgyRuntimeProvider {
  const explicit = opts.explicitInstanceId?.trim() || undefined;
  if (explicit) {
    if (pluginManager.isInstanceKnownDisabled(explicit)) {
      throw new PluginApiError('E_PLUGIN_DISABLED', `AGY 运行时插件实例 ${explicit} 已停用`);
    }
    const svc = pluginManager.host.getServiceByInstance<AgyRuntimeServiceV1>(explicit, AGY_RUNTIME_CONTRACT);
    const meta = pluginManager.host.listServiceProviders(AGY_RUNTIME_CONTRACT).find((p) => p.instanceId === explicit);
    if (!svc) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `插件实例 ${explicit} 未提供 ${AGY_RUNTIME_CONTRACT}`);
    }
    return {
      instanceId: explicit,
      runId: meta?.runId ?? 'host',
      service: svc,
      source: 'explicit',
    };
  }

  const recorded = opts.store && opts.sessionId
    ? getRecordedAgyRuntimeOwner(opts.store, opts.sessionId)
    : undefined;
  if (recorded) {
    if (pluginManager.isInstanceKnownDisabled(recorded)) {
      throw new PluginApiError('E_PLUGIN_DISABLED', `会话绑定的 AGY 运行时实例 (${recorded}) 已停用`);
    }
    const svc = pluginManager.host.getServiceByInstance<AgyRuntimeServiceV1>(recorded, AGY_RUNTIME_CONTRACT);
    const meta = pluginManager.host.listServiceProviders(AGY_RUNTIME_CONTRACT).find((p) => p.instanceId === recorded);
    if (svc) {
      return {
        instanceId: recorded,
        runId: meta?.runId ?? 'host',
        service: svc,
        source: 'session_owner',
      };
    }
    throw new PluginApiError('E_SERVICE_UNAVAILABLE', `会话绑定的 AGY 运行时实例 (${recorded}) 当前不可用`);
  }

  const driverOwner = opts.driverProviderInstanceId?.trim() || undefined;
  if (driverOwner) {
    if (pluginManager.isInstanceKnownDisabled(driverOwner)) {
      throw new PluginApiError('E_PLUGIN_DISABLED', `AGY 驱动提供方实例 (${driverOwner}) 已停用`);
    }
    const svc = pluginManager.host.getServiceByInstance<AgyRuntimeServiceV1>(driverOwner, AGY_RUNTIME_CONTRACT);
    const meta = pluginManager.host.listServiceProviders(AGY_RUNTIME_CONTRACT).find((p) => p.instanceId === driverOwner);
    if (svc) {
      return {
        instanceId: driverOwner,
        runId: meta?.runId ?? 'host',
        service: svc,
        source: 'driver_owner',
      };
    }
  }

  const resolution = pluginManager.resolveServiceSelection(AGY_RUNTIME_CONTRACT, {
    sessionId: opts.sessionId,
    workspaceId: opts.workspaceId,
    allowSingleCandidate: opts.allowSingleCandidate ?? true,
  });
  if (resolution.status !== 'ready' || !resolution.instanceId) {
    // Also check if driver category binding points to an instance providing agy.runtime.v1
    const driverRes = pluginManager.resolveServiceSelection(HARNESS_DRIVER_AGY_CONTRACT, {
      sessionId: opts.sessionId,
      workspaceId: opts.workspaceId,
      allowSingleCandidate: opts.allowSingleCandidate ?? true,
    });
    if (driverRes.status === 'ready' && driverRes.instanceId) {
      const svc = pluginManager.host.getServiceByInstance<AgyRuntimeServiceV1>(
        driverRes.instanceId,
        AGY_RUNTIME_CONTRACT,
      );
      const meta = pluginManager.host
        .listServiceProviders(AGY_RUNTIME_CONTRACT)
        .find((p) => p.instanceId === driverRes.instanceId);
      if (svc) {
        return {
          instanceId: driverRes.instanceId,
          runId: meta?.runId ?? 'host',
          service: svc,
          source: 'driver_owner',
        };
      }
    }
    throw buildDisabledError(AGY_RUNTIME_CONTRACT, resolution);
  }

  const svc = pluginManager.host.getServiceByInstance<AgyRuntimeServiceV1>(
    resolution.instanceId,
    AGY_RUNTIME_CONTRACT,
  );
  const meta = pluginManager.host
    .listServiceProviders(AGY_RUNTIME_CONTRACT)
    .find((p) => p.instanceId === resolution.instanceId);
  if (!svc) {
    throw new PluginApiError('E_SERVICE_UNAVAILABLE', `AGY 运行时实例 ${resolution.instanceId} 服务句柄缺失`);
  }
  return {
    instanceId: resolution.instanceId,
    runId: meta?.runId ?? 'host',
    service: svc,
    source: 'service_selection',
  };
}

export function resolveOptionalAgyRuntimeProvider(
  pluginManager: PluginManager,
  opts: Parameters<typeof resolveAgyRuntimeProvider>[1] = {},
): ResolvedAgyRuntimeProvider | null {
  try {
    return resolveAgyRuntimeProvider(pluginManager, opts);
  } catch {
    return null;
  }
}

export function resolveAgyAccountsProvider(
  pluginManager: PluginManager,
  opts: {
    explicitInstanceId?: string | null;
    workspaceId?: string;
    sessionId?: string;
    allowSingleCandidate?: boolean;
  } = {},
): ResolvedAgyAccountsProvider {
  const explicit = opts.explicitInstanceId?.trim() || undefined;
  if (explicit) {
    if (pluginManager.isInstanceKnownDisabled(explicit)) {
      throw new PluginApiError('E_PLUGIN_DISABLED', `AGY 账号插件实例 ${explicit} 已停用`);
    }
    const svc = pluginManager.host.getServiceByInstance<AgyAccountsServiceV1>(explicit, AGY_ACCOUNTS_CONTRACT);
    const meta = pluginManager.host.listServiceProviders(AGY_ACCOUNTS_CONTRACT).find((p) => p.instanceId === explicit);
    if (!svc) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `插件实例 ${explicit} 未提供 ${AGY_ACCOUNTS_CONTRACT}`);
    }
    return {
      instanceId: explicit,
      runId: meta?.runId ?? 'host',
      service: svc,
      source: 'explicit',
    };
  }

  const resolution = pluginManager.resolveServiceSelection(AGY_ACCOUNTS_CONTRACT, {
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    allowSingleCandidate: opts.allowSingleCandidate ?? true,
  });
  if (resolution.status !== 'ready' || !resolution.instanceId) {
    throw buildDisabledError(AGY_ACCOUNTS_CONTRACT, resolution);
  }
  const svc = pluginManager.host.getServiceByInstance<AgyAccountsServiceV1>(
    resolution.instanceId,
    AGY_ACCOUNTS_CONTRACT,
  );
  const meta = pluginManager.host
    .listServiceProviders(AGY_ACCOUNTS_CONTRACT)
    .find((p) => p.instanceId === resolution.instanceId);
  if (!svc) {
    throw new PluginApiError('E_SERVICE_UNAVAILABLE', `AGY 账号实例 ${resolution.instanceId} 服务句柄缺失`);
  }
  return {
    instanceId: resolution.instanceId,
    runId: meta?.runId ?? 'host',
    service: svc,
    source: 'service_selection',
  };
}

export function listActiveAgyAccountsProviders(
  pluginManager: PluginManager,
): ResolvedAgyAccountsProvider[] {
  const out: ResolvedAgyAccountsProvider[] = [];
  for (const prov of pluginManager.host.listServiceProviders(AGY_ACCOUNTS_CONTRACT)) {
    const svc = pluginManager.host.getServiceByInstance<AgyAccountsServiceV1>(
      prov.instanceId,
      AGY_ACCOUNTS_CONTRACT,
    );
    if (!svc) continue;
    out.push({
      instanceId: prov.instanceId,
      runId: prov.runId ?? 'host',
      service: svc,
      source: 'service_selection',
    });
  }
  return out;
}

export function resolveOptionalAgyWorkbenchProvider(
  pluginManager: PluginManager,
  opts: { sessionId?: string; workspaceId?: string } = {},
): ResolvedAgyWorkbenchProvider | null {
  const res = pluginManager.resolveServiceSelection(AGY_WORKBENCH_CONTRACT, {
    sessionId: opts.sessionId,
    workspaceId: opts.workspaceId,
    allowSingleCandidate: true,
  });
  if (res.status !== 'ready' || !res.instanceId) return null;
  const svc = pluginManager.host.getServiceByInstance<AgyWorkbenchServiceV1>(
    res.instanceId,
    AGY_WORKBENCH_CONTRACT,
  );
  if (!svc) return null;
  const meta = pluginManager.host
    .listServiceProviders(AGY_WORKBENCH_CONTRACT)
    .find((p) => p.instanceId === res.instanceId);
  return {
    instanceId: res.instanceId,
    runId: meta?.runId ?? 'host',
    service: svc,
  };
}
