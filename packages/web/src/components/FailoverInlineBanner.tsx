import type { FailoverPolicy, FailoverRecommendation, HarnessAccountUsage, HarnessInfo } from '@harnessmate/protocol';
import { AlertTriangle, Clock, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { daemonApi } from '../api/client';
import { formatCountdown, resolveHarnessMeta } from '../lib/harness-meta';
import { useAppStore } from '../stores/app-store';

// ── 4. Inline Usage Limit & Failover Banner ────────────────────────────

export function FailoverInlineBanner({
  sessionId,
  failedInstanceId,
  failureClass,
  errorMessage,
  resetsAt,
  harnesses,
  accountUsage,
  failoverPolicy,
  onFailover,
}: {
  sessionId?: string;
  failedInstanceId: string;
  failureClass?: string | null;
  errorMessage: string;
  resetsAt?: number | null;
  harnesses: readonly HarnessInfo[];
  accountUsage: readonly HarnessAccountUsage[];
  failoverPolicy?: FailoverPolicy | null;
  onFailover: (targetHarnessId: string) => void;
}) {
  const [recommendation, setRecommendation] = useState<FailoverRecommendation>();
  const plugins = useAppStore((state) => state.plugins);
  const hasAlternatives = harnesses.length > 0;
  useEffect(() => {
    setRecommendation(undefined);
    if (!sessionId || !hasAlternatives) return;
    let current = true;
    void daemonApi.getFailoverRecommendation(sessionId, failedInstanceId, failureClass ?? undefined)
      .then(({ recommendation }) => { if (current) setRecommendation(recommendation); })
      .catch(() => {});
    return () => { current = false; };
  }, [sessionId, failedInstanceId, failureClass, hasAlternatives, plugins]);
  const isRateLimit =
    failureClass === 'usage_limit' ||
    failureClass === 'rate_limited' ||
    failureClass === 'provider_unavailable' ||
    /rate.?limit|usage.?limit|quota|429|unavailable/i.test(errorMessage);

  const orderedAlternatives = useMemo(() => {
    const ready = harnesses.filter((h) => h.id !== failedInstanceId && h.health === 'ready');
    if (sessionId) return (recommendation?.candidates ?? [])
      .filter(({ available }) => available)
      .map(({ instanceId }) => ready.find(({ id }) => id === instanceId))
      .filter((harness): harness is HarnessInfo => harness !== undefined);
    const chain = failoverPolicy?.priorityChain ?? [];
    if (chain.length === 0) return ready;
    const rank = new Map(chain.map((id, idx) => [id, idx]));
    return [...ready].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  }, [harnesses, failedInstanceId, failoverPolicy, recommendation, sessionId]);

  const effectiveResetsAt = useMemo(() => {
    if (resetsAt) return resetsAt;
    if (recommendation?.failedResetsAt) return recommendation.failedResetsAt;
    const usage = accountUsage.find(
      (a) => a.instanceId === failedInstanceId || a.harnessId === failedInstanceId,
    );
    const activeWindow = usage?.rateLimits.find((r) => r.usedPercent >= 90 && r.resetsAt);
    return activeWindow?.resetsAt ?? null;
  }, [resetsAt, accountUsage, failedInstanceId, recommendation]);

  const primaryCandidate = orderedAlternatives[0];
  const primaryMeta = primaryCandidate
    ? resolveHarnessMeta({ harness: primaryCandidate }, harnesses)
    : null;
  const failedMeta = resolveHarnessMeta({ harnessId: failedInstanceId }, harnesses);

  const now = Date.now();
  const quotaRecovered = Boolean(effectiveResetsAt && effectiveResetsAt <= now);

  return (
    <div
      data-testid="failover-inline-banner"
      className="space-y-2.5 rounded-xl px-3.5 py-3 text-[12.5px]"
      style={{
        backgroundColor: isRateLimit ? 'var(--accent-star-soft)' : 'var(--accent-rose-soft)',
        border: `1px solid color-mix(in srgb, ${isRateLimit ? 'var(--accent-star)' : 'var(--accent-rose)'} 38%, transparent)`,
        color: isRateLimit ? 'var(--text-primary)' : 'var(--accent-rose)',
      }}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <AlertTriangle
            size={15}
            className="mt-0.5 shrink-0"
            style={{ color: isRateLimit ? 'var(--accent-star)' : 'var(--accent-rose)' }}
          />
          <div className="min-w-0 space-y-1">
            <div className="font-medium text-[var(--text-primary)]">
              {isRateLimit
                ? `${failedMeta.shortLabel} 触发限额或服务不可用 (${failureClass ?? 'usage_limit'})`
                : '本轮执行失败'}
            </div>
            <div className="break-words text-[12px] text-[var(--text-secondary)]">{errorMessage}</div>
            {recommendation?.downgradedToManualReason && (
              <div className="text-[11px] text-[var(--text-secondary)]">{recommendation.downgradedToManualReason}</div>
            )}
            {effectiveResetsAt && (
              <div className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                <Clock size={11} />
                {quotaRecovered ? (
                  <span style={{ color: 'var(--accent-emerald)' }}>
                    额度已恢复，可重新切换回 {failedMeta.shortLabel}
                  </span>
                ) : (
                  <span>
                    预计 {formatCountdown(effectiveResetsAt, now)} 重置 (
                    {new Date(effectiveResetsAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    )
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {orderedAlternatives.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 pt-2"
          style={{
            borderTop: `1px solid color-mix(in srgb, ${isRateLimit ? 'var(--accent-star)' : 'var(--accent-rose)'} 22%, transparent)`,
          }}
        >
          {primaryCandidate && primaryMeta && (
            <button
              type="button"
              onClick={() => onFailover(primaryCandidate.id)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              <RefreshCw size={11.5} />
              <span>一键携 Handoff v2 上下文切至 {primaryCandidate.displayName} 续跑</span>
            </button>
          )}
          {orderedAlternatives.slice(1, 3).map((alt) => {
            const altMeta = resolveHarnessMeta({ harness: alt }, harnesses);
            return (
              <button
                key={alt.id}
                type="button"
                onClick={() => onFailover(alt.id)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-strong)',
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: altMeta.accentColor }}
                />
                <span>切至 {alt.displayName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
