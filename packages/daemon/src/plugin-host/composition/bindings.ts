import semver from 'semver';
import {
  PluginApiError,
  type ResolveServiceSelectionOptions,
  type SelectionSource,
  type ServiceCandidate,
  type ServiceResolutionV1,
} from '@harnessmate/plugin-api';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { PluginHost } from '../runtime/lifecycle.js';
import type { PluginComposition } from './profile.js';

export type BindingSource = 'session' | 'workspace' | 'composition' | 'default' | 'none';

export interface ResolvedCapabilityBinding {
  contract: string;
  instanceId: string | null;
  source: BindingSource;
}

export function resolveCapabilityBinding(params: {
  contract: string;
  sessionId?: string;
  workspaceId?: string;
  store?: HarnessMateStore;
  composition: PluginComposition;
  isEntryInComposition: (instanceId: string) => boolean;
}): ResolvedCapabilityBinding {
  const { contract, sessionId, workspaceId, store, composition, isEntryInComposition } = params;

  if (store && sessionId) {
    const sessionBinding = store.getCapabilityBinding('session', sessionId, contract);
    if (sessionBinding?.instanceId) {
      return { contract, instanceId: sessionBinding.instanceId, source: 'session' };
    }
  }

  if (store && workspaceId) {
    const workspaceBinding = store.getCapabilityBinding('workspace', workspaceId, contract);
    if (workspaceBinding?.instanceId) {
      return { contract, instanceId: workspaceBinding.instanceId, source: 'workspace' };
    }
  }

  const profileBinding = composition.profileBindings[contract];
  if (profileBinding) {
    return { contract, instanceId: profileBinding, source: 'composition' };
  }

  const layerDefault = composition.layerBindings[contract];
  if (layerDefault && isEntryInComposition(layerDefault)) {
    return { contract, instanceId: layerDefault, source: 'default' };
  }

  return { contract, instanceId: null, source: 'none' };
}

export interface ResolveServiceSelectionParams {
  contract: string;
  options?: ResolveServiceSelectionOptions;
  host: PluginHost;
  composition: PluginComposition;
  store?: HarnessMateStore;
  isInstanceActive: (instanceId: string) => boolean;
  isInstanceDisabled: (instanceId: string) => boolean;
}

export function resolveServiceSelection(params: ResolveServiceSelectionParams): ServiceResolutionV1 {
  const { contract, options, host, composition, store, isInstanceActive, isInstanceDisabled } = params;
  const requestedRange = options?.versionRange?.trim() || undefined;
  const callerInstanceId = options?.callerInstanceId?.trim() || undefined;
  const callerDepRange = callerInstanceId
    ? host.getInstanceDependencyVersion(callerInstanceId, contract)?.trim() || undefined
    : undefined;

  if (requestedRange && !semver.validRange(requestedRange)) {
    throw new PluginApiError('E_INVALID_INPUT', `无效的服务版本范围: ${requestedRange}`);
  }
  if (callerDepRange && !semver.validRange(callerDepRange)) {
    throw new PluginApiError('E_INVALID_INPUT', `无效的依赖版本范围: ${callerDepRange}`);
  }

  const versionRange = requestedRange ?? callerDepRange ?? '*';
  const isCompatibleVersion = (version: string): boolean => {
    if (!semver.valid(version)) return false;
    if (requestedRange && !semver.satisfies(version, requestedRange)) return false;
    if (callerDepRange && !semver.satisfies(version, callerDepRange)) return false;
    return true;
  };

  const allProviders = host.listServiceProviders(contract);
  const candidates: ServiceCandidate[] = allProviders
    .filter((rec) => isInstanceActive(rec.instanceId) && isCompatibleVersion(rec.version))
    .map(({ instanceId, pluginId, version }) => ({ instanceId, pluginId, version }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  const explicitId = options?.explicitInstanceId?.trim() || undefined;
  const sessionId = options?.sessionId?.trim() || undefined;
  const explicitWorkspaceId = options?.workspaceId?.trim() || undefined;
  const ownerWorkspaceRecord = sessionId && store
    ? store.getResourceOwner('session', sessionId, 'session.data.v1')
    : undefined;
  const effectiveWorkspaceId = explicitWorkspaceId
    ?? (sessionId && store ? store.getSession(sessionId)?.workspaceId : undefined)
    ?? ownerWorkspaceRecord?.workspaceId
    ?? undefined;

  let selected: { instanceId: string; source: Exclude<SelectionSource, 'none' | 'single'> } | undefined;
  if (explicitId) {
    selected = { instanceId: explicitId, source: 'explicit' };
  } else if (store && sessionId) {
    const sessionBinding = store.getCapabilityBinding('session', sessionId, contract);
    if (sessionBinding?.instanceId) {
      selected = { instanceId: sessionBinding.instanceId, source: 'session' };
    } else if (contract === 'session.data.v1' || contract === 'hm.session-data.v1') {
      const owner = store.getResourceOwner('session', sessionId, 'session.data.v1');
      if (owner?.instanceId) {
        selected = { instanceId: owner.instanceId, source: 'session' };
      }
    }
  }
  if (!selected && store && !sessionId && effectiveWorkspaceId && (contract === 'session.data.v1' || contract === 'hm.session-data.v1')) {
    const wsOwner = store.getResourceOwner('workspace', effectiveWorkspaceId, 'session.data.v1');
    if (wsOwner?.instanceId) {
      selected = { instanceId: wsOwner.instanceId, source: 'workspace' };
    }
  }
  if (!selected && store && effectiveWorkspaceId) {
    const workspaceBinding = store.getCapabilityBinding('workspace', effectiveWorkspaceId, contract);
    if (workspaceBinding?.instanceId) {
      selected = { instanceId: workspaceBinding.instanceId, source: 'workspace' };
    }
  }
  if (!selected && callerInstanceId) {
    const depBinding = host.getInstanceBinding(callerInstanceId, contract);
    if (depBinding) {
      selected = { instanceId: depBinding, source: 'dependency' };
    }
  }
  if (!selected) {
    const compBinding = composition.contractBindings[contract];
    if (compBinding) {
      selected = { instanceId: compBinding, source: 'composition' };
    }
  }

  if (selected) {
    if (candidates.some((c) => c.instanceId === selected.instanceId)) {
      return {
        contract,
        versionRange,
        instanceId: selected.instanceId,
        source: selected.source,
        status: 'ready',
        candidates,
      };
    }
    const registered = allProviders.find((p) => p.instanceId === selected.instanceId);
    if (registered && isInstanceActive(selected.instanceId) && !isCompatibleVersion(registered.version)) {
      return {
        contract,
        versionRange,
        instanceId: selected.instanceId,
        source: selected.source,
        status: 'incompatible',
        candidates,
      };
    }
    if (isInstanceDisabled(selected.instanceId)) {
      return {
        contract,
        versionRange,
        instanceId: selected.instanceId,
        source: selected.source,
        status: 'disabled',
        candidates,
      };
    }
    return {
      contract,
      versionRange,
      instanceId: selected.instanceId,
      source: selected.source,
      status: 'unavailable',
      candidates,
    };
  }

  if (candidates.length === 0) {
    return {
      contract,
      versionRange,
      instanceId: null,
      source: 'none',
      status: 'unconfigured',
      candidates: [],
    };
  }

  if (candidates.length === 1 && options?.allowSingleCandidate === true) {
    return {
      contract,
      versionRange,
      instanceId: candidates[0]!.instanceId,
      source: 'single',
      status: 'ready',
      candidates,
    };
  }

  return {
    contract,
    versionRange,
    instanceId: null,
    source: 'none',
    status: 'selection_required',
    candidates,
  };
}
