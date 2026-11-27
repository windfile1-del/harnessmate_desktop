import type { SessionDataServiceV1 } from '@harnessmate/plugin-api';
import type {
  DailyTokenBucket,
  HarnessAccountUsage,
  InstanceBillingTier,
} from '@harnessmate/protocol';
import type { HarnessMateStore, LocalInstanceUsageAggregate } from '../db/sqlite.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { AdapterUsageLimitResult, HarnessAdapter } from '../harnesses/types.js';

export interface UsageServiceOptions {
  /** Cache TTL for remote `readUsageLimits()` queries (defaults to 60s). */
  ttlMs?: number;
  /** Clock override for deterministic unit tests. */
  now?: () => number;
  /** Active `session.data.v1` providers for decoupled usage aggregation. */
  getSessionDataServices?: () => SessionDataServiceV1[];
}

export interface SessionContextMeterSnapshot {
  sessionId: string;
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  cachedInputTokens: number;
  cacheHitRate: number | null;
  level: 'normal' | 'warning' | 'critical';
  isEstimated: boolean;
}

interface CachedRemoteUsage {
  adapter: HarnessAdapter;
  result: AdapterUsageLimitResult;
  fetchedAt: number;
}

const DEFAULT_USAGE_TTL_MS = 60_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Multi-instance, driver-agnostic Usage Aggregation Service.
 *
 * Iterates over all registered instances in `HarnessRegistry`, invokes each
 * driver's optional standard `readUsageLimits()` capability (zero hardcoded
 * vendor names or `instanceof` checks), merges local SQLite `session_runs`
 * statistics, and caches remote probes with a 60s TTL.
 */
export class UsageService {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly getSessionDataServices?: () => SessionDataServiceV1[];
  private readonly remoteCache = new Map<string, CachedRemoteUsage>();
  private readonly inflight = new Map<HarnessAdapter, Promise<CachedRemoteUsage | null>>();
  private stopped = false;

  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    opts?: UsageServiceOptions | Record<string, string>,
  ) {
    const structured =
      opts && ('ttlMs' in opts || 'now' in opts || 'getSessionDataServices' in opts)
        ? (opts as UsageServiceOptions)
        : undefined;
    this.ttlMs = structured?.ttlMs ?? DEFAULT_USAGE_TTL_MS;
    this.now = structured?.now ?? (() => Date.now());
    this.getSessionDataServices = structured?.getSessionDataServices;
  }

  private async readLocalAggregates(): Promise<Map<string, LocalInstanceUsageAggregate>> {
    const services = this.getSessionDataServices?.() ?? [];
    if (services.length === 0) {
      return this.store.getUsageAggregatesByInstance();
    }
    const merged = new Map<string, LocalInstanceUsageAggregate>();
    for (const svc of services) {
      const res = await svc.getUsageAggregatesByInstance().catch(() => null);
      if (!res?.ok) continue;
      for (const agg of res.value.aggregates) {
        const prev = merged.get(agg.instanceId);
        if (!prev) {
          merged.set(agg.instanceId, {
            instanceId: agg.instanceId,
            harnessId: agg.harnessId,
            sessionCount: agg.sessionCount,
            inputTokens: agg.inputTokens,
            outputTokens: agg.outputTokens,
            cachedTokens: agg.cachedTokens,
            costUsd: agg.costUsd,
            dailyBuckets: agg.dailyBuckets.map((b) => ({
              date: b.date,
              tokens: b.inputTokens + b.outputTokens,
            })),
          });
        } else {
          prev.sessionCount += agg.sessionCount;
          prev.inputTokens += agg.inputTokens;
          prev.outputTokens += agg.outputTokens;
          prev.cachedTokens += agg.cachedTokens;
          prev.costUsd += agg.costUsd;
        }
      }
    }
    return merged;
  }

  /**
   * Collects usage & quota snapshots across ALL registered Harness instances.
   * Respects the 60s TTL cache unless `forceRefresh` is explicitly requested.
   */
  async collectAccountUsage(opts?: { forceRefresh?: boolean }): Promise<HarnessAccountUsage[]> {
    const forceRefresh = opts?.forceRefresh === true;
    const services = this.getSessionDataServices?.() ?? [];
    const localAggs = services.length === 0
      ? this.store.getUsageAggregatesByInstance()
      : await this.readLocalAggregates();
    const adapters = this.registry.listAdapters();

    return Promise.all(
      adapters.map((adapter) =>
        this.collectForAdapter(adapter, localAggs.get(adapter.id), forceRefresh),
      ),
    );
  }

  /**
   * Collects usage & quota for a single registered instance by `instanceId`.
   */
  async collectInstanceUsage(
    instanceId: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<HarnessAccountUsage> {
    const forceRefresh = opts?.forceRefresh === true;
    const services = this.getSessionDataServices?.() ?? [];
    const local = (services.length === 0
      ? this.store.getUsageAggregatesByInstance()
      : await this.readLocalAggregates()
    ).get(instanceId);
    const adapter = this.registry.get(instanceId);
    if (!adapter) {
      return this.buildOfflineFallback(instanceId, local);
    }
    return this.collectForAdapter(adapter, local, forceRefresh);
  }

  /**
   * Backward-compatible alias for `/usage` callers expecting Codex instance usage.
   */
  collectCodexUsage(opts?: { forceRefresh?: boolean }): Promise<HarnessAccountUsage> {
    return this.collectInstanceUsage('codex', opts);
  }

  /**
   * Clears cached remote usage for one instance (e.g. after a `usage_limit` error) or all instances.
   */
  invalidateCache(instanceId?: string): void {
    for (const adapter of this.inflight.keys()) {
      if (!instanceId || adapter.id === instanceId) this.inflight.delete(adapter);
    }
    if (instanceId) {
      this.remoteCache.delete(instanceId);
    } else {
      this.remoteCache.clear();
    }
  }

  dispose(): void {
    this.stopped = true;
    this.invalidateCache();
  }

  /**
   * Returns cached billing tier for an instance without triggering a remote probe.
   */
  getKnownBillingTier(instanceId: string): InstanceBillingTier {
    const entry = this.remoteCache.get(instanceId);
    const cached = entry?.adapter === this.registry.get(instanceId) ? entry?.result : undefined;
    if (cached?.billingTier) return cached.billingTier;
    const instance = this.registry.getInstanceConfig(instanceId);
    if (instance?.sanitizedEnv) {
      for (const k of Object.keys(instance.sanitizedEnv)) {
        if (/API_KEY|AUTH_TOKEN/i.test(k)) return 'api_payg';
      }
    }
    return 'unknown';
  }

  /**
   * Computes session-level context window occupancy & Prompt Cache hit rate.
   */
  getSessionContextMeter(sessionId: string): SessionContextMeterSnapshot | null {
    const session = this.store.getSession(sessionId);
    if (!session?.usage) return null;
    const usage = session.usage;
    const usedTokens = usage.contextTokens ?? (usage.inputTokens + usage.outputTokens);
    const isEstimated = !usage.modelContextWindow;
    const maxTokens = usage.modelContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const usagePercent = Math.min(100, Math.round((usedTokens / Math.max(1, maxTokens)) * 100));
    const cachedInputTokens = usage.cacheReadTokens ?? usage.cachedTokens ?? 0;
    const denom = Math.max(usage.inputTokens, cachedInputTokens);
    const cacheHitRate =
      cachedInputTokens > 0 && denom > 0
        ? Math.min(100, Math.round((cachedInputTokens / denom) * 100))
        : null;
    const level: SessionContextMeterSnapshot['level'] =
      usagePercent >= 85 ? 'critical' : usagePercent >= 70 ? 'warning' : 'normal';
    return {
      sessionId,
      usedTokens,
      maxTokens,
      usagePercent,
      cachedInputTokens,
      cacheHitRate,
      level,
      isEstimated,
    };
  }

  private async collectForAdapter(
    adapter: HarnessAdapter,
    local: LocalInstanceUsageAggregate | undefined,
    forceRefresh: boolean,
  ): Promise<HarnessAccountUsage> {
    const nowTs = this.now();
    const driverId = adapter.driverId ?? adapter.kind;
    const instanceCfg = this.registry.getInstanceConfig(adapter.id);
    const displayName = instanceCfg?.displayName ?? adapter.displayName;
    const localBuckets: DailyTokenBucket[] = local?.dailyBuckets ?? [];

    const base: HarnessAccountUsage = {
      harnessId: adapter.id,
      harnessKind: adapter.kind,
      instanceId: adapter.id,
      driverId,
      displayName,
      billingTier: 'unknown',
      loggedIn: false,
      accountLabel: null,
      planType: null,
      authMethod: null,
      rateLimits: [],
      dailyBuckets: localBuckets,
      localSessionCount: local?.sessionCount ?? 0,
      localInputTokens: local?.inputTokens ?? 0,
      localOutputTokens: local?.outputTokens ?? 0,
      localCachedTokens: local?.cachedTokens ?? 0,
      localCostUsd: local?.costUsd ?? 0,
      fetchedAt: nowTs,
      cached: false,
    };

    if (typeof adapter.readUsageLimits !== 'function') {
      // Graceful degradation for custom/third-party drivers without remote usage hook
      base.billingTier = this.getKnownBillingTier(adapter.id);
      return base;
    }

    const existingCache = this.remoteCache.get(adapter.id);
    if (!forceRefresh && existingCache?.adapter === adapter && nowTs - existingCache.fetchedAt < this.ttlMs) {
      return this.mergeRemoteResult(base, existingCache.result, existingCache.fetchedAt, true);
    }

    const remote = await this.fetchWithDeduplication(adapter);
    if (!remote) return base;
    return this.mergeRemoteResult(base, remote.result, remote.fetchedAt, false);
  }

  private async fetchWithDeduplication(adapter: HarnessAdapter): Promise<CachedRemoteUsage | null> {
    if (this.stopped) return null;
    const existing = this.inflight.get(adapter);
    if (existing) return existing;

    const promise = Promise.resolve().then(async (): Promise<CachedRemoteUsage | null> => {
      const fetchedAt = this.now();
      try {
        const result = await adapter.readUsageLimits!();
        if (this.inflight.get(adapter) !== promise || this.registry.get(adapter.id) !== adapter) return null;
        const entry: CachedRemoteUsage = { adapter, result, fetchedAt };
        this.remoteCache.set(adapter.id, entry);
        return entry;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const fallbackResult: AdapterUsageLimitResult = {
          loggedIn: false,
          accountLabel: null,
          planType: null,
          authMethod: null,
          billingTier: 'unknown',
          rateLimits: [],
          error: errMsg,
        };
        if (this.inflight.get(adapter) !== promise || this.registry.get(adapter.id) !== adapter) return null;
        const entry: CachedRemoteUsage = { adapter, result: fallbackResult, fetchedAt };
        this.remoteCache.set(adapter.id, entry);
        return entry;
      } finally {
        if (this.inflight.get(adapter) === promise) this.inflight.delete(adapter);
      }
    });

    this.inflight.set(adapter, promise);
    return promise;
  }

  private mergeRemoteResult(
    base: HarnessAccountUsage,
    remote: AdapterUsageLimitResult,
    fetchedAt: number,
    cached: boolean,
  ): HarnessAccountUsage {
    return {
      ...base,
      loggedIn: remote.loggedIn,
      accountLabel: remote.accountLabel,
      planType: remote.planType,
      authMethod: remote.authMethod,
      billingTier: remote.billingTier ?? base.billingTier,
      gatewayUrl: remote.gatewayUrl ?? base.gatewayUrl,
      rateLimits: remote.rateLimits ?? [],
      resetCreditsAvailable: remote.resetCreditsAvailable,
      lifetimeTokens: remote.lifetimeTokens,
      peakDailyTokens: remote.peakDailyTokens,
      currentStreakDays: remote.currentStreakDays,
      dailyBuckets:
        remote.dailyBuckets && remote.dailyBuckets.length > 0
          ? remote.dailyBuckets
          : base.dailyBuckets,
      fetchedAt,
      cached,
      error: remote.error ?? null,
    };
  }

  private buildOfflineFallback(
    instanceId: string,
    local: LocalInstanceUsageAggregate | undefined,
  ): HarnessAccountUsage {
    return {
      harnessId: instanceId,
      harnessKind: instanceId,
      instanceId,
      driverId: instanceId,
      displayName: instanceId,
      billingTier: 'unknown',
      loggedIn: false,
      accountLabel: null,
      planType: null,
      authMethod: null,
      rateLimits: [],
      dailyBuckets: local?.dailyBuckets ?? [],
      localSessionCount: local?.sessionCount ?? 0,
      localInputTokens: local?.inputTokens ?? 0,
      localOutputTokens: local?.outputTokens ?? 0,
      localCachedTokens: local?.cachedTokens ?? 0,
      localCostUsd: local?.costUsd ?? 0,
      fetchedAt: this.now(),
      cached: false,
      error: `Harness instance not registered: ${instanceId}`,
    };
  }
}
