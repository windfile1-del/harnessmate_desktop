import {
  PEER_CONTRACTS,
  PluginApiError,
  type ResolveServiceSelectionOptions,
  type ServiceResolutionV1,
  type SessionCollaborationServiceV1,
  type SessionCompressionServiceV1,
  type SessionHandoffServiceV1,
  type SessionOrchestrationServiceV1,
  serviceResolutionErrorCode,
} from '@harnessmate/plugin-api';
import type { PluginManager } from '../plugins/plugin-manager.js';

export interface ResolvedPeerService<T> {
  instanceId: string;
  service: T;
  resolution: ServiceResolutionV1;
}

function buildCollaborationUnavailableError(
  contract: string,
  resolution: ServiceResolutionV1,
): PluginApiError {
  if (resolution.status === 'disabled') {
    return new PluginApiError(
      'E_PLUGIN_DISABLED',
      `协作能力 ${contract} 所属插件实例 (${resolution.instanceId ?? 'unknown'}) 已停用`,
    );
  }
  return new PluginApiError(
    serviceResolutionErrorCode(resolution.status as Exclude<ServiceResolutionV1['status'], 'ready'>),
    `协作能力 ${contract} 当前不可用 (${resolution.status})`,
  );
}

function resolveRequiredPeer<T>(
  pluginManager: PluginManager,
  contract: string,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<T> {
  const resolution = pluginManager.resolveServiceSelection(contract, {
    ...options,
    allowSingleCandidate: options?.allowSingleCandidate ?? true,
  });
  if (resolution.status !== 'ready' || !resolution.instanceId) {
    throw buildCollaborationUnavailableError(contract, resolution);
  }
  const service = pluginManager.host.getServiceByInstance<T>(resolution.instanceId, contract);
  if (!service) {
    throw new PluginApiError(
      'E_SERVICE_UNAVAILABLE',
      `协作服务 ${contract}@${resolution.instanceId} 不可用`,
    );
  }
  return { instanceId: resolution.instanceId, service, resolution };
}

function resolveOptionalPeer<T>(
  pluginManager: PluginManager,
  contract: string,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<T> | null {
  try {
    return resolveRequiredPeer<T>(pluginManager, contract, options);
  } catch (err) {
    if (err instanceof PluginApiError && (err.code === 'E_PLUGIN_DISABLED' || err.code === 'E_SERVICE_UNAVAILABLE')) {
      return null;
    }
    throw err;
  }
}

export function resolveSessionHandoffProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<SessionHandoffServiceV1> {
  return resolveRequiredPeer<SessionHandoffServiceV1>(pluginManager, PEER_CONTRACTS.sessionHandoff, options);
}

export function resolveOptionalSessionHandoffProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<SessionHandoffServiceV1> | null {
  return resolveOptionalPeer<SessionHandoffServiceV1>(pluginManager, PEER_CONTRACTS.sessionHandoff, options);
}

export function resolveSessionCompressionProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<SessionCompressionServiceV1> {
  return resolveRequiredPeer<SessionCompressionServiceV1>(pluginManager, PEER_CONTRACTS.sessionCompression, options);
}

export function resolveOptionalSessionCompressionProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<SessionCompressionServiceV1> | null {
  return resolveOptionalPeer<SessionCompressionServiceV1>(pluginManager, PEER_CONTRACTS.sessionCompression, options);
}

export function resolveSessionCollaborationProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<SessionCollaborationServiceV1> {
  return resolveRequiredPeer<SessionCollaborationServiceV1>(pluginManager, PEER_CONTRACTS.sessionCollaboration, options);
}

export function resolveSessionOrchestrationProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<SessionOrchestrationServiceV1> {
  return resolveRequiredPeer<SessionOrchestrationServiceV1>(pluginManager, PEER_CONTRACTS.sessionOrchestration, options);
}

export function resolveOptionalSessionOrchestrationProvider(
  pluginManager: PluginManager,
  options?: Omit<ResolveServiceSelectionOptions, 'allowSingleCandidate'> & { allowSingleCandidate?: boolean },
): ResolvedPeerService<SessionOrchestrationServiceV1> | null {
  return resolveOptionalPeer<SessionOrchestrationServiceV1>(pluginManager, PEER_CONTRACTS.sessionOrchestration, options);
}
