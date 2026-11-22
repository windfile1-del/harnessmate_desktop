import type {
  DailyTokenBucket,
  HarnessAccountUsage,
  RateLimitWindow,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import { AcpAdapter } from '../harnesses/acp-adapter.js';
import { readClaudeLocalSettings } from '../harnesses/claude-adapter.js';
import { CodexAppServerAdapter } from '../harnesses/codex-adapter.js';
import { execCliQuick, resolveBinary } from '../harnesses/process.js';
import type { HarnessRegistry } from '../harnesses/registry.js';

export class UsageService {
  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private readonly binaryOverrides: Record<string, string> = {},
  ) {}

  async collectAccountUsage(): Promise<HarnessAccountUsage[]> {
    const localAggs = this.store.getUsageAggregatesByHarness();

    const [codex, agy, claude] = await Promise.all([
      this.probeCodexUsage(localAggs.get('codex')),
      this.probeAgyUsage(localAggs.get('agy')),
      this.probeClaudeUsage(localAggs.get('claude')),
    ]);

    return [codex, agy, claude];
  }

  private async probeCodexUsage(
    local?: ReturnType<HarnessMateStore['getUsageAggregatesByHarness']> extends Map<string, infer V>
      ? V
      : never,
  ): Promise<HarnessAccountUsage> {
    const base: HarnessAccountUsage = {
      harnessId: 'codex',
      harnessKind: 'codex',
      displayName: 'Codex CLI',
      loggedIn: false,
      accountLabel: null,
      planType: null,
      authMethod: null,
      rateLimits: [],
      dailyBuckets: [],
      localSessionCount: local?.sessionCount ?? 0,
      localInputTokens: local?.inputTokens ?? 0,
      localOutputTokens: local?.outputTokens ?? 0,
      localCachedTokens: local?.cachedTokens ?? 0,
      localCostUsd: local?.costUsd ?? 0,
    };

    const adapter = this.registry.get('codex');
    if (!(adapter instanceof CodexAppServerAdapter)) return base;

    try {
      const snap = await adapter.probeAppServerMetadata(undefined, true);
      if (snap.account) {
        base.loggedIn = true;
        base.accountLabel = snap.account.email ?? snap.account.type ?? 'Signed In';
        base.planType = snap.account.planType ?? null;
        base.authMethod = snap.account.type ?? null;
      }

      const rlRoot = snap.rateLimits as {
        rateLimits?: {
          primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
          secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
        };
        rateLimitResetCredits?: { availableCount?: number };
      } | null;

      const windows: RateLimitWindow[] = [];
      if (rlRoot?.rateLimits?.primary) {
        const p = rlRoot.rateLimits.primary;
        windows.push({
          label: formatWindowLabel(p.windowDurationMins ?? 300),
          usedPercent: clampPct(p.usedPercent ?? 0),
          windowMinutes: p.windowDurationMins ?? 300,
          resetsAt: p.resetsAt ? p.resetsAt * 1000 : null,
        });
      }
      if (rlRoot?.rateLimits?.secondary) {
        const s = rlRoot.rateLimits.secondary;
        windows.push({
          label: formatWindowLabel(s.windowDurationMins ?? 10080),
          usedPercent: clampPct(s.usedPercent ?? 0),
          windowMinutes: s.windowDurationMins ?? 10080,
          resetsAt: s.resetsAt ? s.resetsAt * 1000 : null,
        });
      }
      base.rateLimits = windows;
      base.resetCreditsAvailable = rlRoot?.rateLimitResetCredits?.availableCount;

      const usageRoot = snap.usage as {
        summary?: {
          lifetimeTokens?: number;
          peakDailyTokens?: number;
          currentStreakDays?: number;
        };
        dailyUsageBuckets?: Array<{ startDate?: string; tokens?: number }>;
      } | null;

      if (usageRoot?.summary) {
        base.lifetimeTokens = usageRoot.summary.lifetimeTokens;
        base.peakDailyTokens = usageRoot.summary.peakDailyTokens;
        base.currentStreakDays = usageRoot.summary.currentStreakDays;
      }
      if (Array.isArray(usageRoot?.dailyUsageBuckets)) {
        const recent: DailyTokenBucket[] = usageRoot.dailyUsageBuckets
          .slice(-14)
          .filter((b) => Boolean(b.startDate))
          .map((b) => ({
            date: String(b.startDate),
            tokens: Number(b.tokens ?? 0),
          }));
        base.dailyBuckets = recent;
      }
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }

    return base;
  }

  private async probeAgyUsage(
    local?: ReturnType<HarnessMateStore['getUsageAggregatesByHarness']> extends Map<string, infer V>
      ? V
      : never,
  ): Promise<HarnessAccountUsage> {
    const base: HarnessAccountUsage = {
      harnessId: 'agy',
      harnessKind: 'agy',
      displayName: 'Antigravity CLI',
      loggedIn: false,
      accountLabel: null,
      planType: null,
      authMethod: 'Google OAuth',
      rateLimits: [],
      dailyBuckets: [],
      localSessionCount: local?.sessionCount ?? 0,
      localInputTokens: local?.inputTokens ?? 0,
      localOutputTokens: local?.outputTokens ?? 0,
      localCachedTokens: local?.cachedTokens ?? 0,
      localCostUsd: local?.costUsd ?? 0,
    };

    const adapter = this.registry.get('agy');
    if (!(adapter instanceof AcpAdapter)) return base;

    try {
      const snap = await adapter.probeAcpSessionMetadata();
      base.loggedIn = snap.models.length > 0 || Boolean(snap.tierName);
      base.planType = snap.tierName;
      base.accountLabel = snap.tierName ? `Google Account (${snap.tierName})` : 'Google Account';
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }

    return base;
  }

  private async probeClaudeUsage(
    local?: ReturnType<HarnessMateStore['getUsageAggregatesByHarness']> extends Map<string, infer V>
      ? V
      : never,
  ): Promise<HarnessAccountUsage> {
    const localSettings = readClaudeLocalSettings();
    const base: HarnessAccountUsage = {
      harnessId: 'claude',
      harnessKind: 'claude',
      displayName: 'Claude Code',
      loggedIn: false,
      accountLabel: null,
      planType: null,
      authMethod: null,
      gatewayUrl: localSettings.gatewayUrl,
      rateLimits: [],
      dailyBuckets: [],
      localSessionCount: local?.sessionCount ?? 0,
      localInputTokens: local?.inputTokens ?? 0,
      localOutputTokens: local?.outputTokens ?? 0,
      localCachedTokens: local?.cachedTokens ?? 0,
      localCostUsd: local?.costUsd ?? 0,
    };

    const bin = await resolveBinary('claude', this.binaryOverrides.claude);
    if (!bin) {
      base.error = 'claude CLI not found';
      return base;
    }

    try {
      const res = await execCliQuick(bin, ['auth', 'status'], 6000);
      const parsed = JSON.parse(res.stdout.trim()) as {
        loggedIn?: boolean;
        authMethod?: string;
        apiProvider?: string;
        email?: string;
      };
      base.loggedIn = Boolean(parsed.loggedIn);
      base.authMethod = parsed.authMethod ?? null;
      base.planType = localSettings.gatewayUrl ? 'Custom Gateway (Magpie)' : parsed.apiProvider ?? null;
      base.accountLabel =
        parsed.email ??
        (localSettings.gatewayUrl
          ? `Gateway · ${localSettings.gatewayUrl}`
          : parsed.loggedIn
            ? 'Anthropic Account'
            : null);
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }

    return base;
  }
}

function formatWindowLabel(mins: number): string {
  if (mins >= 1440) {
    const days = Math.round(mins / 1440);
    return `${days} 天周期限额`;
  }
  if (mins >= 60) {
    const hrs = Math.round(mins / 60);
    return `${hrs} 小时周期限额`;
  }
  return `${mins} 分钟限额`;
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}
