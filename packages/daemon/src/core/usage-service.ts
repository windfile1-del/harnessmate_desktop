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
  private readonly remoteCache = new Map<string, CachedRemoteUsage>();
  private readonly inflight = new Map<string, Promise<CachedRemoteUsage | null>>();

  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    opts?: UsageServiceOptions | Record<string, string>,
  ) {
    const structured =
      opts && ('ttlMs' in opts || 'now' in opts) ? (opts as UsageServiceOptions) : undefined;
    this.ttlMs = structured?.ttlMs ?? DEFAULT_USAGE_TTL_MS;
    this.now = structured?.now ?? (() => Date.now());
  }

  /**
   * Collects usage & quota snapshots across ALL registered Harness instances.
   * Respects the 60s TTL cache unless `forceRefresh` is explicitly requested.
   */
  async collectAccountUsage(opts?: { forceRefresh?: boolean }): Promise<HarnessAccountUsage[]> {
    const forceRefresh = opts?.forceRefresh === true;
    const localAggs = this.store.getUsageAggregatesByInstance();
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
    const local = this.store.getUsageAggregatesByInstance().get(instanceId);
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
    if (instanceId) {
      this.remoteCache.delete(instanceId);
    } else {
      this.remoteCache.clear();
    }
  }

  /**
   * Returns cached billing tier for an instance without triggering a remote probe.
   */
  getKnownBillingTier(instanceId: string): InstanceBillingTier {
    const cached = this.remoteCache.get(instanceId)?.result;
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
    if (!forceRefresh && existingCache && nowTs - existingCache.fetchedAt < this.ttlMs) {
      return this.mergeRemoteResult(base, existingCache.result, existingCache.fetchedAt, true);
    }

    const remote = await this.fetchWithDeduplication(adapter);
    if (!remote) return base;
    return this.mergeRemoteResult(base, remote.result, remote.fetchedAt, false);
  }

  private async fetchWithDeduplication(adapter: HarnessAdapter): Promise<CachedRemoteUsage | null> {
    const existing = this.inflight.get(adapter.id);
    if (existing) return existing;

    const promise = (async (): Promise<CachedRemoteUsage | null> => {
      const fetchedAt = this.now();
      try {
        const result = await adapter.readUsageLimits!();
        const entry: CachedRemoteUsage = { result, fetchedAt };
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
        const entry: CachedRemoteUsage = { result: fallbackResult, fetchedAt };
        this.remoteCache.set(adapter.id, entry);
        return entry;
      } finally {
        this.inflight.delete(adapter.id);
      }
    })();

    this.inflight.set(adapter.id, promise);
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
