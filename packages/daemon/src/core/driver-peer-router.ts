import {
  HARNESS_DRIVER_CONTRACT,
  PluginApiError,
  harnessDriverCategoryContract,
  type ServiceResolutionV1,
} from '@harnessmate/plugin-api';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { HarnessRegistry, RegisteredDriverEntry } from '../harnesses/registry.js';
import type { HarnessAdapter } from '../harnesses/types.js';
import type { PluginManager } from '../plugins/plugin-manager.js';

export interface ResolvedDriverSelection {
  adapter: HarnessAdapter;
  entry?: RegisteredDriverEntry;
  harnessId: string;
  driverId: string;
  providerPluginId?: string;
  providerInstanceId?: string;
  providerRunId?: string;
  source: 'explicit' | 'session_owner' | 'service_selection' | 'registry';
}

const KNOWN_CATEGORY_ALIASES = new Set(['codex', 'claude', 'acp', 'agy']);

export function recordDriverOwner(
  store: HarnessMateStore,
  sessionId: string,
  providerInstanceId: string,
  workspaceId?: string | null,
): void {
  store.upsertResourceOwner({
    resourceType: 'session',
    resourceId: sessionId,
    contract: HARNESS_DRIVER_CONTRACT,
    instanceId: providerInstanceId,
    workspaceId: workspaceId ?? null,
  });
}

export function getRecordedDriverOwner(
  store: HarnessMateStore,
  sessionId: string,
): string | undefined {
  return store.getResourceOwner('session', sessionId, HARNESS_DRIVER_CONTRACT)?.instanceId;
}

function buildDisabledDriverError(contract: string, resolution: ServiceResolutionV1): PluginApiError {
  if (resolution.status === 'disabled') {
    return new PluginApiError(
      'E_PLUGIN_DISABLED',
      `驱动提供方插件 (${resolution.instanceId ?? 'unknown'}) 已停用 (${contract})`,
    );
  }
  return new PluginApiError(
    'E_SERVICE_UNAVAILABLE',
    `驱动契约 ${contract} 当前不可用 (${resolution.status})`,
  );
}

function resolveFromRegistryByProvider(
  registry: HarnessRegistry,
  providerInstanceId: string,
  harnessId: string,
  driverId?: string,
): { adapter: HarnessAdapter; entry?: RegisteredDriverEntry } | undefined {
  return registry.resolveAdapter({
    harnessId,
    driverId,
    providerInstanceId,
  });
}

/**
 * Resolves a concrete HarnessAdapter and provider identity for a session/workspace scope.
 * Resolution priority:
 * 1) Explicit `driverProviderInstanceId` (never falls back if disabled).
 * 2) Recorded `resource_owners` provider for `sessionId` when `harnessId` matches the session's bound driver.
 * 3) Category peer contract `harness.driver.<driverId>.v1` via PluginManager scope bindings (`session` > `workspace` > `composition`).
 * 4) Exact `harnessId` lookup in `HarnessRegistry`.
 */
export function resolveDriverForScope(
  pluginManager: PluginManager,
  registry: HarnessRegistry,
  opts: {
    harnessId: string;
    driverProviderInstanceId?: string | null;
    sessionId?: string;
    workspaceId?: string;
    store?: HarnessMateStore;
  },
): ResolvedDriverSelection {
  const harnessId = opts.harnessId.trim();
  const explicitProvider = opts.driverProviderInstanceId?.trim() || undefined;
  const recordedProvider = opts.store && opts.sessionId
    ? getRecordedDriverOwner(opts.store, opts.sessionId)
    : undefined;

  // 1. Explicit provider instance requested
  if (explicitProvider) {
    if (pluginManager.isInstanceKnownDisabled(explicitProvider)) {
      throw new PluginApiError('E_PLUGIN_DISABLED', `驱动提供方实例 ${explicitProvider} 已停用`);
    }
    const found = resolveFromRegistryByProvider(registry, explicitProvider, harnessId, harnessId);
    if (!found) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `驱动实例 ${explicitProvider} 未提供 ${harnessId}`);
    }
    return {
      adapter: found.adapter,
      entry: found.entry,
      harnessId: found.entry?.harnessId ?? found.adapter.id,
      driverId: found.entry?.driverId ?? found.adapter.driverId ?? found.adapter.kind,
      providerPluginId: found.entry?.pluginId ?? found.adapter.providerPluginId,
      providerInstanceId: found.entry?.providerInstanceId ?? explicitProvider,
      providerRunId: found.entry?.providerRunId ?? found.adapter.providerRunId,
      source: 'explicit',
    };
  }

  // 2. Existing session pinned to a recorded driver provider instance
  if (recordedProvider) {
    const exactOrCategoryForRecorded = resolveFromRegistryByProvider(
      registry,
      recordedProvider,
      harnessId,
      KNOWN_CATEGORY_ALIASES.has(harnessId) ? harnessId : undefined,
    );
    if (pluginManager.isInstanceKnownDisabled(recordedProvider)) {
      // Only fail if the session is still using that provider's harnessId or category
      const existingSession = opts.store && opts.sessionId ? opts.store.getSession(opts.sessionId) : null;
      if (!existingSession || existingSession.harnessId === harnessId) {
        throw new PluginApiError('E_PLUGIN_DISABLED', `会话绑定的驱动插件 (${recordedProvider}) 已停用`);
      }
    }
    if (exactOrCategoryForRecorded) {
      return {
        adapter: exactOrCategoryForRecorded.adapter,
        entry: exactOrCategoryForRecorded.entry,
        harnessId: exactOrCategoryForRecorded.entry?.harnessId ?? exactOrCategoryForRecorded.adapter.id,
        driverId:
          exactOrCategoryForRecorded.entry?.driverId
          ?? exactOrCategoryForRecorded.adapter.driverId
          ?? exactOrCategoryForRecorded.adapter.kind,
        providerPluginId:
          exactOrCategoryForRecorded.entry?.pluginId ?? exactOrCategoryForRecorded.adapter.providerPluginId,
        providerInstanceId: recordedProvider,
        providerRunId:
          exactOrCategoryForRecorded.entry?.providerRunId ?? exactOrCategoryForRecorded.adapter.providerRunId,
        source: 'session_owner',
      };
    }
  }

  // 3. Category alias (e.g. 'codex', 'claude', 'acp', or registered driverId)
  const existingEntry = registry.getEntry(harnessId);
  const categoryDriverId = KNOWN_CATEGORY_ALIASES.has(harnessId)
    ? harnessId
    : (registry.hasDriver(harnessId) ? harnessId : undefined);

  if (categoryDriverId && (!existingEntry || existingEntry.harnessId === categoryDriverId || existingEntry.driverId === categoryDriverId)) {
    const contract = harnessDriverCategoryContract(categoryDriverId);
    const resolution = pluginManager.resolveServiceSelection(contract, {
      sessionId: opts.sessionId,
      workspaceId: opts.workspaceId,
      allowSingleCandidate: true,
    });
    if (resolution.status === 'disabled') {
      throw buildDisabledDriverError(contract, resolution);
    }
    if (resolution.status === 'ready' && resolution.instanceId) {
      const fromScope = resolveFromRegistryByProvider(registry, resolution.instanceId, harnessId, categoryDriverId);
      if (fromScope) {
        return {
          adapter: fromScope.adapter,
          entry: fromScope.entry,
          harnessId: fromScope.entry?.harnessId ?? fromScope.adapter.id,
          driverId: fromScope.entry?.driverId ?? fromScope.adapter.driverId ?? fromScope.adapter.kind,
          providerPluginId: fromScope.entry?.pluginId ?? fromScope.adapter.providerPluginId,
          providerInstanceId: resolution.instanceId,
          providerRunId: fromScope.entry?.providerRunId ?? fromScope.adapter.providerRunId,
          source: 'service_selection',
        };
      }
    }
  }

  // 4. Exact harnessId lookup in registry (e.g. 'codex.work', 'hm.plugin.codex-driver-lite:codex', 'agy.work', custom ACP)
  const direct = registry.resolveAdapter({ harnessId });
  if (direct) {
    const providerId = direct.entry?.providerInstanceId ?? direct.adapter.providerInstanceId;
    if (providerId && pluginManager.isInstanceKnownDisabled(providerId)) {
      throw new PluginApiError('E_PLUGIN_DISABLED', `驱动提供方实例 ${providerId} 已停用`);
    }
    return {
      adapter: direct.adapter,
      entry: direct.entry,
      harnessId: direct.entry?.harnessId ?? direct.adapter.id,
      driverId: direct.entry?.driverId ?? direct.adapter.driverId ?? direct.adapter.kind,
      providerPluginId: direct.entry?.pluginId ?? direct.adapter.providerPluginId,
      providerInstanceId: providerId,
      providerRunId: direct.entry?.providerRunId ?? direct.adapter.providerRunId,
      source: 'registry',
    };
  }

  throw new PluginApiError('E_SERVICE_UNAVAILABLE', `Harness 驱动实例 ${harnessId} 未注册或已停用`);
}
