import {
  FailoverPolicySchema,
  type Attachment,
  type FailoverPolicy,
  type FailoverRecommendation,
  type InstanceBillingTier,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { UsageService } from './usage-service.js';

export interface InstanceCooldownRecord {
  instanceId: string;
  failureClass: string;
  resetsAt: number;
  backoffLevel: number;
  failedAt: number;
  notifiedReset: boolean;
}

export interface QuotaResetNotification {
  instanceId: string;
  displayName: string;
  resetsAt: number;
}

const FAILOVER_KV_SCOPE = 'global';
const FAILOVER_KV_PLUGIN_ID = 'core.auto-failover';
const FAILOVER_KV_POLICY_KEY = 'failover_policy';
const BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

export const FAILOVER_TRIGGER_CLASSES = new Set([
  'usage_limit',
  'rate_limited',
  'provider_unavailable',
]);

export function classifyTerminalFailure(
  code: string | null | undefined,
  message: string,
): string {
  if (code && FAILOVER_TRIGGER_CLASSES.has(code)) return code;
  if (/usage.?limit|rate.?limit|quota|too many requests|429/i.test(message)) {
    return /rate.?limit|429/i.test(message) ? 'rate_limited' : 'usage_limit';
  }
  if (/unavailable|overloaded|service unavailable|503|502|connection refused/i.test(message)) {
    return 'provider_unavailable';
  }
  return code || 'provider_error';
}

export class FailoverCoordinator {
  private readonly cooldowns = new Map<string, InstanceCooldownRecord>();
  private readonly autoSwitchesBySession = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private readonly getUsageService: () => UsageService | undefined,
    opts?: { now?: () => number },
  ) {
    this.now = opts?.now ?? (() => Date.now());
  }

  getPolicy(): FailoverPolicy {
    const raw = this.store.getPluginStorageValue(
      FAILOVER_KV_SCOPE,
      FAILOVER_KV_PLUGIN_ID,
      FAILOVER_KV_POLICY_KEY,
    );
    const parsed = FailoverPolicySchema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    return FailoverPolicySchema.parse({});
  }

  setPolicy(input: Partial<FailoverPolicy>): FailoverPolicy {
    const merged = FailoverPolicySchema.parse({
      ...this.getPolicy(),
      ...input,
    });
    this.store.setPluginStorageValue(
      FAILOVER_KV_SCOPE,
      FAILOVER_KV_PLUGIN_ID,
      FAILOVER_KV_POLICY_KEY,
      merged,
    );
    return merged;
  }

  /**
   * Records a rate-limit / unavailability cooldown for an instance and invalidates
   * its usage cache so subsequent quota reads fetch fresh reset timestamps.
   */
  recordFailure(
    instanceId: string,
    failureClass: string,
    resetsAt?: number | null,
  ): InstanceCooldownRecord {
    const nowTs = this.now();
    const prev = this.cooldowns.get(instanceId);
    const backoffLevel = prev ? Math.min(BACKOFF_STEPS_MS.length - 1, prev.backoffLevel + 1) : 0;
    const effectiveResetsAt =
      typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > nowTs
        ? resetsAt
        : nowTs + BACKOFF_STEPS_MS[backoffLevel]!;

    const record: InstanceCooldownRecord = {
      instanceId,
      failureClass,
      resetsAt: effectiveResetsAt,
      backoffLevel,
      failedAt: nowTs,
      notifiedReset: false,
    };
    this.cooldowns.set(instanceId, record);
    this.getUsageService()?.invalidateCache(instanceId);
    return record;
  }

  clearCooldown(instanceId: string): void {
    this.cooldowns.delete(instanceId);
  }

  getCooldown(instanceId: string): InstanceCooldownRecord | undefined {
    const rec = this.cooldowns.get(instanceId);
    if (!rec) return undefined;
    if (rec.resetsAt <= this.now()) {
      return undefined;
    }
    return rec;
  }

  /**
   * Checks cooled-down instances whose `resetsAt` has elapsed so the host can
   * notify the user that their primary instance quota has recovered.
   */
  checkQuotaResets(nowOverride?: number): QuotaResetNotification[] {
    const nowTs = nowOverride ?? this.now();
    const recovered: QuotaResetNotification[] = [];
    for (const [instanceId, rec] of this.cooldowns.entries()) {
      if (rec.resetsAt <= nowTs && !rec.notifiedReset) {
        rec.notifiedReset = true;
        const adapter = this.registry.get(instanceId);
        const cfg = this.registry.getInstanceConfig(instanceId);
        recovered.push({
          instanceId,
          displayName: cfg?.displayName ?? adapter?.displayName ?? instanceId,
          resetsAt: rec.resetsAt,
        });
        this.cooldowns.delete(instanceId);
      }
    }
    return recovered;
  }

  recordAutoSwitch(sessionId: string): number {
    const next = (this.autoSwitchesBySession.get(sessionId) ?? 0) + 1;
    this.autoSwitchesBySession.set(sessionId, next);
    return next;
  }

  getAutoSwitchCount(sessionId: string): number {
    return this.autoSwitchesBySession.get(sessionId) ?? 0;
  }

  resetSessionSwitches(sessionId: string): void {
    this.autoSwitchesBySession.delete(sessionId);
  }

  /**
   * Evaluates `FailoverPolicy` priority chain, cooldowns, Ping-Pong guard, and
   * subscription->API_PAYG cost guard to produce an actionable recommendation.
   */
  recommendFailover(
    sessionId: string,
    failedInstanceId: string,
    failureClass: string,
    opts?: {
      billingTierByInstance?: Readonly<Record<string, InstanceBillingTier>>;
      unavailableInstances?: ReadonlySet<string>;
      resetsAt?: number | null;
    },
  ): FailoverRecommendation {
    const nowTs = this.now();
    const policy = this.getPolicy();
    const usageSvc = this.getUsageService();
    const resolveTier = (id: string): InstanceBillingTier =>
      opts?.billingTierByInstance?.[id] ?? usageSvc?.getKnownBillingTier(id) ?? 'unknown';

    const failedTier = resolveTier(failedInstanceId);
    const failedCooldown = this.cooldowns.get(failedInstanceId);
    const failedResetsAt =
      opts?.resetsAt ?? (failedCooldown && failedCooldown.resetsAt > nowTs ? failedCooldown.resetsAt : null);

    const adapters = this.registry.listAdapters();
    const adapterById = new Map(adapters.map((a) => [a.id, a]));

    // Build ordered candidate list: explicit priorityChain first, then any other registered instances
    const orderedIds: string[] = [];
    const seen = new Set<string>([failedInstanceId]);
    for (const id of policy.priorityChain) {
      if (!seen.has(id) && adapterById.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    }
    for (const adapter of adapters) {
      if (!seen.has(adapter.id)) {
        seen.add(adapter.id);
        orderedIds.push(adapter.id);
      }
    }

    const candidates: FailoverRecommendation['candidates'] = [];
    let earliestResetAt: number | null = failedResetsAt;
    let firstAvailable: (typeof candidates)[number] | null = null;

    for (const id of orderedIds) {
      const adapter = adapterById.get(id)!;
      const cfg = this.registry.getInstanceConfig(id);
      const displayName = cfg?.displayName ?? adapter.displayName;
      const driverId = adapter.driverId ?? adapter.kind;
      const billingTier = resolveTier(id);
      const unavailable = opts?.unavailableInstances?.has(id) ?? false;
      const cooldown = this.cooldowns.get(id);
      const inCooldown = Boolean(cooldown && cooldown.resetsAt > nowTs);

      if (inCooldown && cooldown) {
        earliestResetAt =
          earliestResetAt === null ? cooldown.resetsAt : Math.min(earliestResetAt, cooldown.resetsAt);
      }

      const available = !unavailable && !inCooldown;
      const entry = {
        instanceId: id,
        driverId,
        displayName,
        billingTier,
        available,
        inCooldown,
        resetsAt: inCooldown ? cooldown?.resetsAt ?? null : null,
        reason: unavailable
          ? '实例不可用'
          : inCooldown
            ? `冷却中 (${cooldown?.failureClass})`
            : undefined,
      };
      candidates.push(entry);
      if (available && !firstAvailable) {
        firstAvailable = entry;
      }
    }

    const autoSwitchCount = this.getAutoSwitchCount(sessionId);
    const pingPongBlocked =
      !firstAvailable || autoSwitchCount >= policy.maxAutoSwitchesPerSession;

    let canAutoFailover = false;
    let downgradedToManualReason: string | null = null;

    if (firstAvailable && !pingPongBlocked && policy.mode !== 'manual_one_click') {
      if (
        policy.mode === 'auto_same_tier' &&
        failedTier === 'subscription' &&
        firstAvailable.billingTier === 'api_payg'
      ) {
        // Cost guardrail: never auto-switch from subscription to pay-as-you-go API without user consent
        canAutoFailover = false;
        downgradedToManualReason =
          '成本护栏：已拦截从订阅包月实例自动切换至按量付费 API 实例，请手动确认接力。';
      } else {
        canAutoFailover = true;
      }
    } else if (pingPongBlocked && autoSwitchCount >= policy.maxAutoSwitchesPerSession) {
      downgradedToManualReason = `已达到单会话最大自动切换上限 (${policy.maxAutoSwitchesPerSession} 次)，已暂停自动接力以防乒乓死循环。`;
    } else if (!firstAvailable) {
      downgradedToManualReason = '当前所有备选实例均处于限额冷却或不可用状态。';
    }

    return {
      failedInstanceId,
      failureClass,
      recommendedInstanceId: firstAvailable?.instanceId ?? null,
      recommendedDisplayName: firstAvailable?.displayName ?? null,
      recommendedBillingTier: firstAvailable?.billingTier,
      canAutoFailover,
      downgradedToManualReason,
      pingPongBlocked,
      autoSwitchCount,
      maxAutoSwitchesPerSession: policy.maxAutoSwitchesPerSession,
      failedResetsAt,
      earliestResetAt,
      candidates,
    };
  }

  /**
   * Extracts the last failed user turn's input & attachments for 1-click failover replay.
   */
  retryInput(sessionId: string): { text: string; attachments?: Attachment[] } | undefined {
    let current: { text: string; attachments?: Attachment[] } | undefined;
    let retry: typeof current;
    let lastUserTurnId: string | null = null;
    for (const event of this.store.iterateEvents(sessionId)) {
      if (event.type === 'message.user') {
        lastUserTurnId = event.turnId;
        const { text, attachments } = event.payload;
        current =
          typeof text === 'string' && text.trim()
            ? {
                text,
                attachments: Array.isArray(attachments) ? (attachments as Attachment[]) : undefined,
              }
            : undefined;
      } else if (event.type === 'turn.completed') {
        retry = undefined;
      } else if (event.type === 'turn.failed' && event.turnId === lastUserTurnId) {
        retry = current;
      }
    }
    return retry;
  }
}
