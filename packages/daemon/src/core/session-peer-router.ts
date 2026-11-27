import {
  PEER_CONTRACTS,
  PluginApiError,
  type ResolveServiceSelectionOptions,
  type ServiceResolutionV1,
  type SessionDataServiceV1,
  type SessionRecordDto,
  type SessionRuntimeServiceV1,
  type SessionWorkspaceDto,
  serviceResolutionErrorCode,
} from '@harnessmate/plugin-api';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { PluginManager } from '../plugins/plugin-manager.js';

export interface ResolvedSessionDataProvider {
  instanceId: string;
  service: SessionDataServiceV1;
  resolution: ServiceResolutionV1;
}

export interface ResolvedSessionRuntimeProvider {
  instanceId: string;
  service: SessionRuntimeServiceV1;
  resolution: ServiceResolutionV1;
}

function buildUnavailableError(contract: string, resolution: ServiceResolutionV1): PluginApiError {
  if (resolution.status === 'disabled') {
    return new PluginApiError('E_PLUGIN_DISABLED', `能力 ${contract} 所属插件实例 (${resolution.instanceId ?? 'unknown'}) 已停用`);
  }
  return new PluginApiError(
    serviceResolutionErrorCode(resolution.status as Exclude<ServiceResolutionV1['status'], 'ready'>),
    `能力 ${contract} 当前不可用 (${resolution.status})`,
  );
}

export function resolveSessionDataProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedSessionDataProvider {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionData, {
    ...options,
    allowSingleCandidate: options?.allowSingleCandidate ?? true,
  });
  if (resolution.status !== 'ready' || !resolution.instanceId) {
    throw buildUnavailableError(PEER_CONTRACTS.sessionData, resolution);
  }
  const service = pluginManager.host.getServiceByInstance<SessionDataServiceV1>(
    resolution.instanceId,
    PEER_CONTRACTS.sessionData,
  );
  if (!service) {
    throw new PluginApiError(
      'E_SERVICE_UNAVAILABLE',
      `会话数据服务 ${PEER_CONTRACTS.sessionData}@${resolution.instanceId} 不可用`,
    );
  }
  return { instanceId: resolution.instanceId, service, resolution };
}

export function resolveOptionalSessionDataProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedSessionDataProvider | null {
  try {
    return resolveSessionDataProvider(pluginManager, options);
  } catch (err) {
    if (err instanceof PluginApiError && (err.code === 'E_PLUGIN_DISABLED' || err.code === 'E_SERVICE_UNAVAILABLE')) {
      return null;
    }
    throw err;
  }
}

export function resolveSessionRuntimeProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedSessionRuntimeProvider {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionRuntime, {
    ...options,
    allowSingleCandidate: options?.allowSingleCandidate ?? true,
  });
  if (resolution.status !== 'ready' || !resolution.instanceId) {
    throw buildUnavailableError(PEER_CONTRACTS.sessionRuntime, resolution);
  }
  const service = pluginManager.host.getServiceByInstance<SessionRuntimeServiceV1>(
    resolution.instanceId,
    PEER_CONTRACTS.sessionRuntime,
  );
  if (!service) {
    throw new PluginApiError(
      'E_SERVICE_UNAVAILABLE',
      `会话运行服务 ${PEER_CONTRACTS.sessionRuntime}@${resolution.instanceId} 不可用`,
    );
  }
  return { instanceId: resolution.instanceId, service, resolution };
}

export function listActiveSessionDataProviders(pluginManager: PluginManager): ResolvedSessionDataProvider[] {
  const providers = pluginManager.host.listServiceProviders(PEER_CONTRACTS.sessionData);
  const out: ResolvedSessionDataProvider[] = [];
  for (const prov of providers) {
    if (pluginManager.isInstanceKnownDisabled(prov.instanceId)) continue;
    const service = pluginManager.host.getServiceByInstance<SessionDataServiceV1>(
      prov.instanceId,
      PEER_CONTRACTS.sessionData,
    );
    if (!service) continue;
    const resolution: ServiceResolutionV1 = {
      contract: PEER_CONTRACTS.sessionData,
      versionRange: '*',
      instanceId: prov.instanceId,
      source: 'composition',
      status: 'ready',
      candidates: [{ instanceId: prov.instanceId, pluginId: prov.pluginId, version: prov.version }],
    };
    out.push({ instanceId: prov.instanceId, service, resolution });
  }
  return out;
}

export function listActiveSessionRuntimeProviders(pluginManager: PluginManager): ResolvedSessionRuntimeProvider[] {
  const providers = pluginManager.host.listServiceProviders(PEER_CONTRACTS.sessionRuntime);
  const out: ResolvedSessionRuntimeProvider[] = [];
  for (const prov of providers) {
    if (pluginManager.isInstanceKnownDisabled(prov.instanceId)) continue;
    const service = pluginManager.host.getServiceByInstance<SessionRuntimeServiceV1>(
      prov.instanceId,
      PEER_CONTRACTS.sessionRuntime,
    );
    if (!service) continue;
    const resolution: ServiceResolutionV1 = {
      contract: PEER_CONTRACTS.sessionRuntime,
      versionRange: '*',
      instanceId: prov.instanceId,
      source: 'composition',
      status: 'ready',
      candidates: [{ instanceId: prov.instanceId, pluginId: prov.pluginId, version: prov.version }],
    };
    out.push({ instanceId: prov.instanceId, service, resolution });
  }
  return out;
}

export function recordResourceOwner(
  store: HarnessMateStore,
  resourceType: 'workspace' | 'session',
  resourceId: string,
  instanceId: string,
  workspaceId?: string | null,
): void {
  store.upsertResourceOwner({
    resourceType,
    resourceId,
    contract: PEER_CONTRACTS.sessionData,
    instanceId,
    workspaceId: workspaceId ?? null,
  });
}

export function removeResourceOwner(
  store: HarnessMateStore,
  resourceType: 'workspace' | 'session',
  resourceId: string,
): void {
  store.deleteResourceOwner(resourceType, resourceId, PEER_CONTRACTS.sessionData);
}

/**
 * Resolves the owning `session.data.v1` provider for an existing session.
 * If the session has an explicit or owner binding whose instance is currently disabled,
 * this throws `E_PLUGIN_DISABLED` immediately and never falls back to another provider.
 */
export async function findSessionWithProvider(
  pluginManager: PluginManager,
  sessionId: string,
  explicitDataInstanceId?: string,
): Promise<{
  provider: ResolvedSessionDataProvider;
  session: SessionRecordDto;
} | null> {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionData, {
    explicitInstanceId: explicitDataInstanceId,
    sessionId,
    allowSingleCandidate: true,
  });
  if (resolution.instanceId && (resolution.source === 'explicit' || resolution.source === 'session' || resolution.source === 'workspace')) {
    if (resolution.status !== 'ready') {
      throw buildUnavailableError(PEER_CONTRACTS.sessionData, resolution);
    }
    const provider = resolveSessionDataProvider(pluginManager, {
      explicitInstanceId: resolution.instanceId,
    });
    const res = await provider.service.getSession({ sessionId });
    if (res.ok && res.value.session) {
      return { provider, session: res.value.session };
    }
    return null;
  }

  if (resolution.status === 'disabled') {
    throw buildUnavailableError(PEER_CONTRACTS.sessionData, resolution);
  }

  const orderedProviders: ResolvedSessionDataProvider[] = [];
  if (resolution.status === 'ready' && resolution.instanceId) {
    orderedProviders.push(resolveSessionDataProvider(pluginManager, { explicitInstanceId: resolution.instanceId }));
  }
  for (const candidate of listActiveSessionDataProviders(pluginManager)) {
    if (!orderedProviders.some((p) => p.instanceId === candidate.instanceId)) {
      orderedProviders.push(candidate);
    }
  }
  if (orderedProviders.length === 0) {
    throw buildUnavailableError(PEER_CONTRACTS.sessionData, resolution);
  }

  for (const provider of orderedProviders) {
    const res = await provider.service.getSession({ sessionId });
    if (res.ok && res.value.session) {
      return { provider, session: res.value.session };
    }
  }
  return null;
}

export async function findWorkspaceWithProvider(
  pluginManager: PluginManager,
  workspaceId: string,
): Promise<{
  provider: ResolvedSessionDataProvider;
  workspace: SessionWorkspaceDto;
} | null> {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionData, {
    workspaceId,
    allowSingleCandidate: true,
  });
  if (resolution.instanceId && (resolution.source === 'workspace' || resolution.source === 'explicit')) {
    if (resolution.status !== 'ready') {
      throw buildUnavailableError(PEER_CONTRACTS.sessionData, resolution);
    }
    const provider = resolveSessionDataProvider(pluginManager, {
      explicitInstanceId: resolution.instanceId,
    });
    const res = await provider.service.getWorkspace({ workspaceId });
    if (res.ok && res.value.workspace) {
      return { provider, workspace: res.value.workspace };
    }
    return null;
  }

  if (resolution.status === 'disabled') {
    throw buildUnavailableError(PEER_CONTRACTS.sessionData, resolution);
  }

  const orderedProviders: ResolvedSessionDataProvider[] = [];
  if (resolution.status === 'ready' && resolution.instanceId) {
    orderedProviders.push(resolveSessionDataProvider(pluginManager, { explicitInstanceId: resolution.instanceId }));
  }
  for (const candidate of listActiveSessionDataProviders(pluginManager)) {
    if (!orderedProviders.some((p) => p.instanceId === candidate.instanceId)) {
      orderedProviders.push(candidate);
    }
  }
  if (orderedProviders.length === 0) {
    throw buildUnavailableError(PEER_CONTRACTS.sessionData, resolution);
  }

  for (const provider of orderedProviders) {
    const res = await provider.service.getWorkspace({ workspaceId });
    if (res.ok && res.value.workspace) {
      return { provider, workspace: res.value.workspace };
    }
  }
  return null;
}
