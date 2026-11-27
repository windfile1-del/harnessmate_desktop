import { PluginApiError, harnessDriverCategoryContract } from '@harnessmate/plugin-api';
import type {
  CustomAcpHarnessConfig,
  HarnessDriverId,
  HarnessInfo,
  HarnessInstanceConfig,
} from '@harnessmate/protocol';
import type { HarnessAdapter } from './types.js';

export type HarnessDriverFactory = (instance: ResolvedHarnessInstance) => HarnessAdapter;

export interface ResolvedHarnessInstance extends HarnessInstanceConfig {
  continuationKey: string;
  sanitizedEnv: Record<string, string>;
}

export interface RegisteredDriverEntry {
  key: string;
  pluginId: string;
  providerInstanceId: string;
  providerRunId: string;
  driverId: HarnessDriverId;
  harnessId: string;
  aliases: string[];
  isDefault: boolean;
  adapter: HarnessAdapter;
  instanceConfig: ResolvedHarnessInstance;
}

const RESERVED_ENV_KEYS = new Set([
  'HARNESSMATE_LOCAL_TOKEN',
  'HARNESSMATE_SESSION_MCP_TOKEN',
  'HARNESSMATE_DATA_DIR',
]);

/**
 * Strips host daemon secrets from instance environment whitelists so multiple
 * instances of the same driver never leak credentials across isolation boundaries.
 */
export function sanitizeInstanceEnv(envWhitelist?: Record<string, string>): Record<string, string> {
  if (!envWhitelist) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(envWhitelist)) {
    if (!key || RESERVED_ENV_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export function resolveContinuationKey(config: HarnessInstanceConfig): string {
  if (config.continuationKey?.trim()) return config.continuationKey.trim();
  if (config.homeDir?.trim()) return `${config.driverId}:home:${config.homeDir.trim()}`;
  return `${config.driverId}:instance:${config.instanceId}`;
}

export function driverRegistrationKey(providerInstanceId: string, driverId: string, harnessId: string): string {
  return `${providerInstanceId}::${driverId}::${harnessId}`;
}

export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();
  private readonly drivers = new Map<HarnessDriverId, HarnessDriverFactory>();
  private readonly instances = new Map<string, ResolvedHarnessInstance>();
  private readonly entriesByKey = new Map<string, RegisteredDriverEntry>();
  private readonly entriesByProvider = new Map<string, Map<string, RegisteredDriverEntry>>();
  private readonly primaryEntryByHarnessId = new Map<string, RegisteredDriverEntry>();
  private readonly metadataOverrides = new Map<string, { displayName?: string; description?: string }>();
  private customAcpFactory: ((config: CustomAcpHarnessConfig) => HarnessAdapter) | null = null;
  private cachedProbes = new Map<string, HarnessInfo>();

  /**
   * Batch 4: No vendor driver categories are reserved in the kernel.
   * Codex, Claude, ACP, and AGY are all open to peer plugin implementations.
   */
  isReserved(_id: string): boolean {
    return false;
  }

  setCustomAcpFactory(factory: ((config: CustomAcpHarnessConfig) => HarnessAdapter) | null): void {
    this.customAcpFactory = factory;
  }

  // ── Provider-Scoped Driver Directory ─────────────────────────────────

  registerProviderDriver(params: {
    pluginId: string;
    providerInstanceId: string;
    providerRunId: string;
    driverId: HarnessDriverId;
    harnessId: string;
    aliases?: string[];
    isDefault?: boolean;
    adapter: HarnessAdapter;
    instanceConfig?: Partial<ResolvedHarnessInstance>;
  }): RegisteredDriverEntry {
    const driverId = params.driverId.trim();
    const harnessId = params.harnessId.trim();
    const key = driverRegistrationKey(params.providerInstanceId, driverId, harnessId);
    const prev = this.entriesByKey.get(key);
    if (prev) {
      this.unregisterProviderDriver(params.providerInstanceId, driverId, harnessId);
    }

    const baseConfig: HarnessInstanceConfig = {
      instanceId: harnessId,
      driverId,
      providerPluginId: params.pluginId,
      providerInstanceId: params.providerInstanceId,
      displayName: params.instanceConfig?.displayName ?? params.adapter.displayName,
      description: params.instanceConfig?.description ?? params.adapter.description,
      continuationKey:
        params.instanceConfig?.continuationKey
        ?? params.adapter.continuationKey
        ?? `${driverId}:instance:${harnessId}`,
      binaryPath: params.instanceConfig?.binaryPath,
      homeDir: params.instanceConfig?.homeDir,
      extraArgs: params.instanceConfig?.extraArgs,
      envWhitelist: params.instanceConfig?.envWhitelist,
      apiBaseUrl: params.instanceConfig?.apiBaseUrl,
      authToken: params.instanceConfig?.authToken,
      defaultServiceTier: params.instanceConfig?.defaultServiceTier,
      enabled: params.instanceConfig?.enabled ?? true,
    };

    const resolvedConfig: ResolvedHarnessInstance = {
      ...baseConfig,
      continuationKey: resolveContinuationKey(baseConfig),
      sanitizedEnv: sanitizeInstanceEnv(baseConfig.envWhitelist),
    };

    const entry: RegisteredDriverEntry = {
      key,
      pluginId: params.pluginId,
      providerInstanceId: params.providerInstanceId,
      providerRunId: params.providerRunId,
      driverId,
      harnessId,
      aliases: [...new Set((params.aliases ?? []).map((a) => a.trim()).filter((a) => a && a !== harnessId))],
      isDefault: Boolean(params.isDefault),
      adapter: params.adapter,
      instanceConfig: resolvedConfig,
    };

    this.entriesByKey.set(key, entry);
    const providerBucket = this.entriesByProvider.get(params.providerInstanceId) ?? new Map<string, RegisteredDriverEntry>();
    providerBucket.set(key, entry);
    this.entriesByProvider.set(params.providerInstanceId, providerBucket);

    // Claim primary harnessId only if unclaimed, owned by the same provider, or explicitly default
    const existingPrimary = this.primaryEntryByHarnessId.get(harnessId);
    if (
      !existingPrimary
      || existingPrimary.providerInstanceId === params.providerInstanceId
      || (entry.isDefault && !existingPrimary.isDefault)
    ) {
      this.primaryEntryByHarnessId.set(harnessId, entry);
      this.adapters.set(harnessId, entry.adapter);
      this.instances.set(harnessId, resolvedConfig);
    }

    for (const alias of entry.aliases) {
      const existingAlias = this.primaryEntryByHarnessId.get(alias);
      if (!existingAlias || existingAlias.providerInstanceId === params.providerInstanceId) {
        this.primaryEntryByHarnessId.set(alias, entry);
        if (!this.adapters.has(alias)) {
          this.adapters.set(alias, entry.adapter);
        }
      }
    }

    this.cachedProbes.delete(key);
    this.cachedProbes.delete(harnessId);
    return entry;
  }

  unregisterProviderDriver(providerInstanceId: string, driverId?: string, harnessId?: string): number {
    const providerBucket = this.entriesByProvider.get(providerInstanceId);
    if (!providerBucket) return 0;

    let removed = 0;
    for (const [key, entry] of [...providerBucket.entries()]) {
      if (driverId && entry.driverId !== driverId) continue;
      if (harnessId && entry.harnessId !== harnessId) continue;

      providerBucket.delete(key);
      this.entriesByKey.delete(key);
      this.cachedProbes.delete(key);
      this.cachedProbes.delete(entry.harnessId);
      removed += 1;

      if (this.primaryEntryByHarnessId.get(entry.harnessId)?.key === key) {
        this.primaryEntryByHarnessId.delete(entry.harnessId);
        if (this.adapters.get(entry.harnessId) === entry.adapter) {
          this.adapters.delete(entry.harnessId);
        }
        if (this.instances.get(entry.harnessId)?.providerInstanceId === providerInstanceId) {
          this.instances.delete(entry.harnessId);
        }
        this.promoteFallbackPrimary(entry.harnessId);
      }

      for (const alias of entry.aliases) {
        if (this.primaryEntryByHarnessId.get(alias)?.key === key) {
          this.primaryEntryByHarnessId.delete(alias);
          if (this.adapters.get(alias) === entry.adapter) {
            this.adapters.delete(alias);
          }
          this.promoteFallbackPrimary(alias);
        }
      }
    }

    if (providerBucket.size === 0) {
      this.entriesByProvider.delete(providerInstanceId);
    }
    return removed;
  }

  private promoteFallbackPrimary(harnessId: string): void {
    const candidates = [...this.entriesByKey.values()]
      .filter((e) => e.harnessId === harnessId || e.aliases.includes(harnessId))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.providerInstanceId.localeCompare(b.providerInstanceId));
    const winner = candidates[0];
    if (!winner) return;
    this.primaryEntryByHarnessId.set(harnessId, winner);
    if (!this.adapters.has(harnessId)) {
      this.adapters.set(harnessId, winner.adapter);
    }
    if (winner.harnessId === harnessId && !this.instances.has(harnessId)) {
      this.instances.set(harnessId, winner.instanceConfig);
    }
  }

  listEntries(filter?: { driverId?: string; providerInstanceId?: string; harnessId?: string }): RegisteredDriverEntry[] {
    let entries = [...this.entriesByKey.values()];
    if (filter?.providerInstanceId) {
      entries = entries.filter((e) => e.providerInstanceId === filter.providerInstanceId);
    }
    if (filter?.driverId) {
      entries = entries.filter((e) => e.driverId === filter.driverId);
    }
    if (filter?.harnessId) {
      entries = entries.filter((e) => e.harnessId === filter.harnessId || e.aliases.includes(filter.harnessId!));
    }
    return entries;
  }

  getEntry(harnessId: string, providerInstanceId?: string): RegisteredDriverEntry | undefined {
    if (providerInstanceId) {
      const bucket = this.entriesByProvider.get(providerInstanceId);
      if (!bucket) return undefined;
      for (const entry of bucket.values()) {
        if (entry.harnessId === harnessId || entry.aliases.includes(harnessId) || entry.driverId === harnessId) {
          return entry;
        }
      }
      return undefined;
    }
    return this.primaryEntryByHarnessId.get(harnessId);
  }

  resolveAdapter(opts: {
    harnessId: string;
    driverId?: string;
    providerInstanceId?: string;
    preferredProviderInstanceId?: string;
  }): { adapter: HarnessAdapter; entry?: RegisteredDriverEntry } | undefined {
    if (opts.providerInstanceId) {
      const bucket = this.entriesByProvider.get(opts.providerInstanceId);
      if (bucket) {
        for (const entry of bucket.values()) {
          if (entry.harnessId === opts.harnessId || entry.aliases.includes(opts.harnessId)) {
            return { adapter: entry.adapter, entry };
          }
        }
        if (opts.driverId) {
          for (const entry of bucket.values()) {
            if (entry.driverId === opts.driverId) {
              return { adapter: entry.adapter, entry };
            }
          }
        }
        for (const entry of bucket.values()) {
          if (entry.driverId === opts.harnessId) {
            return { adapter: entry.adapter, entry };
          }
        }
      }
      return undefined;
    }

    if (opts.preferredProviderInstanceId) {
      const preferred = this.resolveAdapter({
        harnessId: opts.harnessId,
        driverId: opts.driverId,
        providerInstanceId: opts.preferredProviderInstanceId,
      });
      if (preferred) return preferred;
    }

    const primary = this.primaryEntryByHarnessId.get(opts.harnessId);
    if (primary) {
      return { adapter: primary.adapter, entry: primary };
    }
    const legacy = this.adapters.get(opts.harnessId);
    if (legacy) {
      return { adapter: legacy };
    }
    return undefined;
  }

  // ── Driver Registration (Instance-First, Backward Compatible) ────────

  registerDriver(driverId: HarnessDriverId, factory: HarnessDriverFactory): void {
    this.drivers.set(driverId, factory);
  }

  unregisterDriver(driverId: HarnessDriverId): boolean {
    return this.drivers.delete(driverId);
  }

  hasDriver(driverId: HarnessDriverId): boolean {
    return this.drivers.has(driverId) || [...this.entriesByKey.values()].some((e) => e.driverId === driverId);
  }

  listDrivers(): HarnessDriverId[] {
    const out = new Set<HarnessDriverId>(this.drivers.keys());
    for (const entry of this.entriesByKey.values()) out.add(entry.driverId);
    return Array.from(out);
  }

  // ── Instance Lifecycle (Multi-Instance per Driver) ───────────────────

  registerInstance(config: HarnessInstanceConfig): HarnessAdapter {
    const factory = this.drivers.get(config.driverId);
    if (!factory) {
      throw new Error(`Harness driver not registered: ${config.driverId}`);
    }
    const resolved: ResolvedHarnessInstance = {
      ...config,
      continuationKey: resolveContinuationKey(config),
      sanitizedEnv: sanitizeInstanceEnv(config.envWhitelist),
    };
    this.instances.set(config.instanceId, resolved);
    const adapter = factory(resolved);
    this.register(adapter);
    if (config.providerInstanceId) {
      this.registerProviderDriver({
        pluginId: config.providerPluginId ?? adapter.providerPluginId ?? config.providerInstanceId,
        providerInstanceId: config.providerInstanceId,
        providerRunId: adapter.providerRunId ?? 'host',
        driverId: config.driverId,
        harnessId: config.instanceId,
        isDefault: config.instanceId === config.driverId,
        adapter,
        instanceConfig: resolved,
      });
    }
    return adapter;
  }

  /**
   * Updates non-structural instance metadata (displayName, description) in place
   * without replacing the registered adapter or interrupting active sessions.
   */
  updateInstanceMetadata(
    instanceId: string,
    patch: { displayName?: string; description?: string },
  ): boolean {
    const adapter = this.get(instanceId);
    if (!adapter) return false;
    const prev = this.metadataOverrides.get(instanceId) ?? {};
    this.metadataOverrides.set(instanceId, {
      displayName: patch.displayName ?? prev.displayName,
      description: patch.description ?? prev.description,
    });
    const existing = this.instances.get(instanceId);
    if (existing) {
      this.instances.set(instanceId, {
        ...existing,
        displayName: patch.displayName ?? existing.displayName,
        description: patch.description ?? existing.description,
      });
    }
    for (const entry of this.entriesByKey.values()) {
      if (entry.harnessId === instanceId) {
        entry.instanceConfig = {
          ...entry.instanceConfig,
          displayName: patch.displayName ?? entry.instanceConfig.displayName,
          description: patch.description ?? entry.instanceConfig.description,
        };
        this.cachedProbes.delete(entry.key);
      }
    }
    this.cachedProbes.delete(instanceId);
    return true;
  }

  getInstanceConfig(instanceId: string): ResolvedHarnessInstance | undefined {
    return this.instances.get(instanceId) ?? this.primaryEntryByHarnessId.get(instanceId)?.instanceConfig;
  }

  listInstances(): ResolvedHarnessInstance[] {
    const byId = new Map<string, ResolvedHarnessInstance>();
    for (const [id, inst] of this.instances) {
      byId.set(id, inst);
    }
    for (const entry of this.entriesByKey.values()) {
      if (!byId.has(entry.harnessId)) {
        byId.set(entry.harnessId, entry.instanceConfig);
      }
    }
    return Array.from(byId.values());
  }

  // ── Adapter Registry (V1–V4 Compatible) ──────────────────────────────

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.cachedProbes.delete(adapter.id);
    if (!this.instances.has(adapter.id)) {
      const driverId = adapter.driverId ?? adapter.kind;
      this.instances.set(adapter.id, {
        instanceId: adapter.id,
        driverId,
        ...(adapter.providerPluginId ? { providerPluginId: adapter.providerPluginId } : {}),
        ...(adapter.providerInstanceId ? { providerInstanceId: adapter.providerInstanceId } : {}),
        displayName: adapter.displayName,
        description: adapter.description,
        continuationKey: adapter.continuationKey ?? `${driverId}:instance:${adapter.id}`,
        sanitizedEnv: {},
        enabled: true,
      });
    }
  }

  registerCustomAcp(config: CustomAcpHarnessConfig): void {
    if (!this.customAcpFactory) {
      throw new PluginApiError('E_PLUGIN_DISABLED', '通用 ACP 驱动插件当前未启用');
    }
    const adapter = this.customAcpFactory(config);
    this.register(adapter);
  }

  unregister(id: string): boolean {
    this.cachedProbes.delete(id);
    this.instances.delete(id);
    this.metadataOverrides.delete(id);
    const primary = this.primaryEntryByHarnessId.get(id);
    if (primary) {
      this.unregisterProviderDriver(primary.providerInstanceId, primary.driverId, primary.harnessId);
    }
    return this.adapters.delete(id);
  }

  get(id: string, providerInstanceId?: string): HarnessAdapter | undefined {
    if (providerInstanceId) {
      return this.getEntry(id, providerInstanceId)?.adapter;
    }
    return this.primaryEntryByHarnessId.get(id)?.adapter ?? this.adapters.get(id);
  }

  listAdapters(): HarnessAdapter[] {
    const out: HarnessAdapter[] = [];
    const seen = new Set<HarnessAdapter>();
    for (const entry of this.entriesByKey.values()) {
      if (!seen.has(entry.adapter)) {
        seen.add(entry.adapter);
        out.push(entry.adapter);
      }
    }
    for (const adapter of this.adapters.values()) {
      if (!seen.has(adapter)) {
        seen.add(adapter);
        out.push(adapter);
      }
    }
    return out;
  }

  async probeAll(forceRefresh = false): Promise<HarnessInfo[]> {
    const seenKeys = new Set<string>();
    const targets: Array<{ harnessId: string; providerInstanceId?: string }> = [];

    for (const entry of this.entriesByKey.values()) {
      if (seenKeys.has(entry.key)) continue;
      seenKeys.add(entry.key);
      targets.push({ harnessId: entry.harnessId, providerInstanceId: entry.providerInstanceId });
    }
    for (const adapter of this.adapters.values()) {
      const covered = [...this.entriesByKey.values()].some((e) => e.adapter === adapter);
      if (!covered) {
        targets.push({ harnessId: adapter.id });
      }
    }

    const results = await Promise.all(
      targets.map(({ harnessId, providerInstanceId }) => this.probeInstance(harnessId, forceRefresh, providerInstanceId)),
    );
    return results.filter((info): info is HarnessInfo => info !== undefined);
  }

  async probeInstance(
    instanceId: string,
    forceRefresh = false,
    providerInstanceId?: string,
  ): Promise<HarnessInfo | undefined> {
    const entry = this.getEntry(instanceId, providerInstanceId);
    const adapter = entry?.adapter ?? (providerInstanceId ? undefined : this.get(instanceId));
    if (!adapter) return undefined;

    const cacheKey = entry?.key ?? adapter.id;
    if (!forceRefresh && this.cachedProbes.has(cacheKey)) {
      return this.cachedProbes.get(cacheKey)!;
    }
    const instance = entry?.instanceConfig ?? this.instances.get(adapter.id);
    const override = this.metadataOverrides.get(adapter.id);
    const resolvedDriverId = adapter.driverId ?? adapter.kind;
    const resolvedProviderPluginId = entry?.pluginId ?? adapter.providerPluginId;
    const resolvedProviderInstanceId = entry?.providerInstanceId ?? adapter.providerInstanceId;
    const resolvedProviderRunId = entry?.providerRunId ?? adapter.providerRunId;

    try {
      const raw = !forceRefresh && adapter.probePassive
        ? await adapter.probePassive()
        : await adapter.probe();
      const info: HarnessInfo = {
        ...raw,
        id: entry?.harnessId ?? raw.id ?? adapter.id,
        driverId: raw.driverId ?? resolvedDriverId,
        instanceId: entry?.harnessId ?? raw.instanceId ?? adapter.id,
        ...(resolvedProviderPluginId ? { providerPluginId: resolvedProviderPluginId } : {}),
        ...(resolvedProviderInstanceId ? { providerInstanceId: resolvedProviderInstanceId } : {}),
        ...(resolvedProviderRunId ? { providerRunId: resolvedProviderRunId } : {}),
        driverCategoryContract: raw.driverCategoryContract ?? harnessDriverCategoryContract(resolvedDriverId),
        continuationKey: raw.continuationKey ?? instance?.continuationKey ?? adapter.continuationKey,
        displayName: override?.displayName ?? raw.displayName,
        description: override?.description ?? raw.description,
        capabilitiesV2: raw.capabilitiesV2 ?? adapter.capabilitiesV2,
        presentation: raw.presentation ?? adapter.presentation,
        ...(adapter.supportedCommands ? { supportedCommands: adapter.supportedCommands } : {}),
      };
      if ((entry ? this.getEntry(entry.harnessId, entry.providerInstanceId)?.adapter : this.get(adapter.id)) === adapter) {
        this.cachedProbes.set(cacheKey, info);
      }
      return info;
    } catch (err) {
      const fallback: HarnessInfo = {
        id: entry?.harnessId ?? adapter.id,
        kind: adapter.kind,
        driverId: resolvedDriverId,
        instanceId: entry?.harnessId ?? adapter.id,
        ...(resolvedProviderPluginId ? { providerPluginId: resolvedProviderPluginId } : {}),
        ...(resolvedProviderInstanceId ? { providerInstanceId: resolvedProviderInstanceId } : {}),
        ...(resolvedProviderRunId ? { providerRunId: resolvedProviderRunId } : {}),
        driverCategoryContract: harnessDriverCategoryContract(resolvedDriverId),
        continuationKey: instance?.continuationKey ?? adapter.continuationKey,
        displayName: override?.displayName ?? adapter.displayName,
        description: override?.description ?? adapter.description,
        protocolLabel: adapter.protocolLabel,
        binaryPath: null,
        version: null,
        health: 'unavailable',
        healthMessage: err instanceof Error ? err.message : String(err),
        capabilities: adapter.capabilities,
        capabilitiesV2: adapter.capabilitiesV2,
        presentation: adapter.presentation,
        ...(adapter.supportedCommands ? { supportedCommands: adapter.supportedCommands } : {}),
        models: [],
        isCustom: adapter.isCustom,
      };
      if ((entry ? this.getEntry(entry.harnessId, entry.providerInstanceId)?.adapter : this.get(adapter.id)) === adapter) {
        this.cachedProbes.set(cacheKey, fallback);
      }
      return fallback;
    }
  }
}
