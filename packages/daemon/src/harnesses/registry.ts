import type {
  CustomAcpHarnessConfig,
  HarnessDriverId,
  HarnessInfo,
  HarnessInstanceConfig,
} from '@harnessmate/protocol';
import { AcpAdapter } from './acp-adapter.js';
import type { HarnessAdapter } from './types.js';

export type HarnessDriverFactory = (instance: ResolvedHarnessInstance) => HarnessAdapter;

export interface ResolvedHarnessInstance extends HarnessInstanceConfig {
  continuationKey: string;
  sanitizedEnv: Record<string, string>;
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

export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();
  private readonly drivers = new Map<HarnessDriverId, HarnessDriverFactory>();
  private readonly instances = new Map<string, ResolvedHarnessInstance>();
  private readonly metadataOverrides = new Map<string, { displayName?: string; description?: string }>();
  private cachedProbes = new Map<string, HarnessInfo>();

  isReserved(id: string): boolean {
    return id === 'codex' || id === 'claude' || id === 'agy';
  }

  // ── Driver Registration (Instance-First) ─────────────────────────────

  registerDriver(driverId: HarnessDriverId, factory: HarnessDriverFactory): void {
    this.drivers.set(driverId, factory);
  }

  unregisterDriver(driverId: HarnessDriverId): boolean {
    return this.drivers.delete(driverId);
  }

  hasDriver(driverId: HarnessDriverId): boolean {
    return this.drivers.has(driverId);
  }

  listDrivers(): HarnessDriverId[] {
    return Array.from(this.drivers.keys());
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
    const adapter = this.adapters.get(instanceId);
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
    this.cachedProbes.delete(instanceId);
    return true;
  }

  getInstanceConfig(instanceId: string): ResolvedHarnessInstance | undefined {
    return this.instances.get(instanceId);
  }

  listInstances(): ResolvedHarnessInstance[] {
    return Array.from(this.instances.values());
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
        displayName: adapter.displayName,
        description: adapter.description,
        continuationKey: adapter.continuationKey ?? `${driverId}:instance:${adapter.id}`,
        sanitizedEnv: {},
        enabled: true,
      });
    }
  }

  registerCustomAcp(config: CustomAcpHarnessConfig): void {
    this.register(
      new AcpAdapter({
        id: config.id,
        kind: 'acp',
        displayName: config.displayName,
        description: config.description,
        command: config.command,
        args: config.args,
        env: sanitizeInstanceEnv(config.env),
        isCustom: true,
      }),
    );
  }

  unregister(id: string): boolean {
    this.cachedProbes.delete(id);
    this.instances.delete(id);
    this.metadataOverrides.delete(id);
    return this.adapters.delete(id);
  }

  get(id: string): HarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  listAdapters(): HarnessAdapter[] {
    return Array.from(this.adapters.values());
  }

  async probeAll(forceRefresh = false): Promise<HarnessInfo[]> {
    const list = this.listAdapters();
    const results = await Promise.all(list.map(({ id }) => this.probeInstance(id, forceRefresh)));
    return results.filter((info): info is HarnessInfo => info !== undefined);
  }

  async probeInstance(instanceId: string, forceRefresh = false): Promise<HarnessInfo | undefined> {
    const adapter = this.get(instanceId);
    if (!adapter) return undefined;
    if (!forceRefresh && this.cachedProbes.has(adapter.id)) {
      return this.cachedProbes.get(adapter.id)!;
    }
    const instance = this.instances.get(adapter.id);
    const override = this.metadataOverrides.get(adapter.id);
    try {
      const raw = !forceRefresh && adapter.probePassive
        ? await adapter.probePassive()
        : await adapter.probe();
      const info: HarnessInfo = {
        ...raw,
        driverId: raw.driverId ?? adapter.driverId ?? adapter.kind,
        instanceId: raw.instanceId ?? adapter.id,
        continuationKey: raw.continuationKey ?? instance?.continuationKey ?? adapter.continuationKey,
        displayName: override?.displayName ?? raw.displayName,
        description: override?.description ?? raw.description,
        capabilitiesV2: raw.capabilitiesV2 ?? adapter.capabilitiesV2,
        presentation: raw.presentation ?? adapter.presentation,
      };
      if (this.get(adapter.id) === adapter) this.cachedProbes.set(adapter.id, info);
      return info;
    } catch (err) {
      const fallback: HarnessInfo = {
        id: adapter.id,
        kind: adapter.kind,
        driverId: adapter.driverId ?? adapter.kind,
        instanceId: adapter.id,
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
        models: [],
        isCustom: adapter.isCustom,
      };
      if (this.get(adapter.id) === adapter) this.cachedProbes.set(adapter.id, fallback);
      return fallback;
    }
  }
}
