import fs from 'node:fs';
import type {
  AgyAuthMethod,
  InstanceBillingTier,
  RateLimitWindow,
} from '@harnessmate/protocol';
import { AgyAuthRequiredError, inspectAgyCommand } from '../agy-commands.js';
import { resolveBinary } from '../process.js';
import type { AdapterUsageLimitResult } from '../types.js';
import type { AgyLaunchContext } from './agy-launch-context.js';

export interface AgyUsageBucketRaw {
  id?: string;
  name?: string;
  window?: string;
  remaining_fraction?: number;
  used_fraction?: number;
  reset_time?: string | number;
}

export interface AgyUsageGroupRaw {
  id?: string;
  name?: string;
  buckets?: AgyUsageBucketRaw[];
}

export interface AgyUsageCommandPayload {
  description?: string;
  tier?: string;
  plan?: string;
  account?: string;
  groups?: AgyUsageGroupRaw[];
}

export function formatAgyAuthMethodLabel(authMethod: AgyAuthMethod): string {
  switch (authMethod) {
    case 'oauth-business':
      return 'Gemini Enterprise';
    case 'gemini-api-key':
      return 'Gemini API Key';
    case 'agent-platform':
      return 'Agent Platform';
    case 'oauth-personal':
    default:
      return 'Google OAuth';
  }
}

export function resolveAgyBillingTier(authMethod: AgyAuthMethod): InstanceBillingTier {
  if (authMethod === 'gemini-api-key' || authMethod === 'agent-platform') {
    return 'api_payg';
  }
  return 'subscription';
}

function parseResetTimestamp(raw: string | number | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw.trim());
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export function formatAgyUsageSummary(data: unknown): string {
  const payload = (data && typeof data === 'object' ? data : null) as AgyUsageCommandPayload | null;
  const lines = (payload?.groups ?? []).flatMap((group) =>
    (group.buckets ?? []).map((item) => {
      const rem =
        typeof item.remaining_fraction === 'number'
          ? `剩余 ${(100 * item.remaining_fraction).toFixed(1)}%`
          : undefined;
      const resetMs = parseResetTimestamp(item.reset_time);
      const resetStr = resetMs ? `${new Date(resetMs).toLocaleString()} 重置` : undefined;
      return [item.name || item.id || group.name, item.window, rem, resetStr]
        .filter(Boolean)
        .join(' · ');
    }),
  );
  return lines.join('\n') || payload?.description || 'AGY 没有返回模型额度';
}

function parseWindowMinutes(rawWindow?: string): number {
  const w = rawWindow?.trim().toLowerCase() ?? '';
  if (!w) return 0;
  const h = w.match(/^(\d+)\s*h/);
  if (h) return Number(h[1]) * 60;
  const d = w.match(/^(\d+)\s*d/);
  if (d) return Number(d[1]) * 24 * 60;
  const m = w.match(/^(\d+)\s*m/);
  if (m) return Number(m[1]);
  if (w.includes('week')) return 7 * 24 * 60;
  return 0;
}

export function parseAgyUsagePayload(
  data: unknown,
  authMethod: AgyAuthMethod,
  fallbackTierName?: string | null,
): AdapterUsageLimitResult {
  const payload = (data && typeof data === 'object' ? data : null) as AgyUsageCommandPayload | null;
  const rateLimits: RateLimitWindow[] = [];

  for (const group of payload?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      const title = bucket.name || bucket.id || group.name || 'Quota';
      const label = bucket.window ? `${title} · ${bucket.window}` : title;
      const remainingFraction =
        typeof bucket.remaining_fraction === 'number'
          ? bucket.remaining_fraction
          : typeof bucket.used_fraction === 'number'
            ? 1 - bucket.used_fraction
            : undefined;
      if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) {
        continue;
      }
      const clampedRem = Math.max(0, Math.min(1, remainingFraction));
      rateLimits.push({
        label,
        usedPercent: Math.round((1 - clampedRem) * 100),
        resetsAt: parseResetTimestamp(bucket.reset_time),
        windowMinutes: parseWindowMinutes(bucket.window),
      });
    }
  }

  return {
    loggedIn: true,
    accountLabel: payload?.account?.trim() || null,
    planType: payload?.tier?.trim() || payload?.plan?.trim() || fallbackTierName || null,
    authMethod: formatAgyAuthMethodLabel(authMethod),
    billingTier: resolveAgyBillingTier(authMethod),
    rateLimits,
    error: rateLimits.length === 0 && payload?.description ? payload.description : undefined,
  };
}

/**
 * Probes quota limits strictly via the official `agy -p /usage --output-format json`
 * command running inside the instance's `AgyLaunchContext` (never via private
 * HTTP endpoints or shared keyring reading).
 */
export async function probeAgyUsageViaCli(
  ctx: AgyLaunchContext,
  opts?: { cwd?: string; fallbackTierName?: string | null },
): Promise<AdapterUsageLimitResult> {
  const authLabel = formatAgyAuthMethodLabel(ctx.authMethod);
  if (
    ctx.isolationMode === 'profile_isolated' &&
    ctx.authMethod === 'oauth-personal' &&
    !ctx.hasLocalTokenFile()
  ) {
    return {
      loggedIn: false,
      accountLabel: null,
      planType: opts?.fallbackTierName ?? null,
      authMethod: authLabel,
      billingTier: 'unknown',
      rateLimits: [],
      error: 'AGY 隔离账号尚未登录，请在设置中完成官方 Google 登录',
    };
  }

  const binary = await resolveBinary('agy', ctx.binaryPath);
  if (!binary) {
    return {
      loggedIn: false,
      accountLabel: null,
      planType: opts?.fallbackTierName ?? null,
      authMethod: authLabel,
      billingTier: 'unknown',
      rateLimits: [],
      error: '未找到 agy CLI 可执行文件',
    };
  }

  const cwd = opts?.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
  try {
    const data = await inspectAgyCommand(binary, cwd, '/usage', { launchContext: ctx });
    return parseAgyUsagePayload(data, ctx.authMethod, opts?.fallbackTierName);
  } catch (err) {
    if (err instanceof AgyAuthRequiredError) {
      return {
        loggedIn: false,
        accountLabel: null,
        planType: opts?.fallbackTierName ?? null,
        authMethod: authLabel,
        billingTier: 'unknown',
        rateLimits: [],
        error: err.message,
      };
    }
    return {
      loggedIn: false,
      accountLabel: null,
      planType: opts?.fallbackTierName ?? null,
      authMethod: authLabel,
      billingTier: 'unknown',
      rateLimits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
