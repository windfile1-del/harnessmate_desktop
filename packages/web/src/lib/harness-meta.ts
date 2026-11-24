import type {
  HarnessInfo,
  HarnessPresentationMeta,
  PermissionMode,
  ProviderOptionDescriptor,
  TokenUsage,
} from '@harnessmate/protocol';

export interface HarnessVisualMeta {
  shortLabel: string;
  accentColor: string;
  softBg: string;
  tagline: string;
  iconSvg?: string;
}

export const DEFAULT_HARNESS_VISUAL_META: HarnessVisualMeta = {
  shortLabel: 'Agent',
  accentColor: 'var(--accent-star)',
  softBg: 'var(--accent-star-soft)',
  tagline: 'Plugin Harness',
};

/**
 * Minimal fallback lookup retained only for legacy events or offline snapshots
 * that lack backend-supplied `HarnessPresentationMeta`. Core UI components must
 * call `resolveHarnessMeta()` with `HarnessInfo` / `presentation` first.
 */
export const HARNESS_META: Record<string, HarnessVisualMeta | undefined> = {};

function fallbackMetaForKind(kind: string): HarnessVisualMeta {
  const cleaned = (kind || 'agent').trim();
  const label = cleaned.length <= 4 ? cleaned.toUpperCase() : cleaned.slice(0, 1).toUpperCase() + cleaned.slice(1, 14);
  return {
    shortLabel: label,
    accentColor: DEFAULT_HARNESS_VISUAL_META.accentColor,
    softBg: DEFAULT_HARNESS_VISUAL_META.softBg,
    tagline: `Harness · ${cleaned || 'custom'}`,
  };
}

export function getHarnessMeta(
  kind: string,
  presentation?: HarnessPresentationMeta | null,
): HarnessVisualMeta {
  if (presentation) {
    return {
      shortLabel: presentation.shortLabel,
      accentColor: presentation.accentColor,
      softBg: presentation.softBg,
      tagline: presentation.tagline,
      iconSvg: presentation.iconSvg,
    };
  }
  return HARNESS_META[kind] ?? fallbackMetaForKind(kind);
}

/**
 * Resolves visual presentation metadata strictly from backend-supplied
 * `HarnessInfo.presentation` first (matched by `instanceId`/`id` or `driverId`/`kind`),
 * with a vendor-agnostic default fallback so new third-party Harness drivers
 * require zero frontend code changes.
 */
export function resolveHarnessMeta(
  target: {
    harnessId?: string | null;
    harnessKind?: string | null;
    harness?: HarnessInfo | null;
    presentation?: HarnessPresentationMeta | null;
  },
  harnesses?: readonly HarnessInfo[],
): HarnessVisualMeta {
  if (target.presentation) {
    return getHarnessMeta(target.harnessKind ?? target.harnessId ?? 'agent', target.presentation);
  }
  const direct = target.harness;
  if (direct?.presentation) {
    return getHarnessMeta(direct.driverId ?? direct.kind, direct.presentation);
  }
  if (harnesses && harnesses.length > 0) {
    const byId = target.harnessId
      ? harnesses.find((h) => h.id === target.harnessId || h.instanceId === target.harnessId)
      : undefined;
    if (byId?.presentation) {
      return getHarnessMeta(byId.driverId ?? byId.kind, byId.presentation);
    }
    if (byId) {
      return {
        shortLabel: byId.displayName.slice(0, 16),
        accentColor: DEFAULT_HARNESS_VISUAL_META.accentColor,
        softBg: DEFAULT_HARNESS_VISUAL_META.softBg,
        tagline: byId.protocolLabel || byId.description,
      };
    }
    const byKind = target.harnessKind
      ? harnesses.find((h) => (h.driverId ?? h.kind) === target.harnessKind)
      : undefined;
    if (byKind?.presentation) {
      return getHarnessMeta(byKind.driverId ?? byKind.kind, byKind.presentation);
    }
  }
  if (direct) {
    return {
      shortLabel: direct.displayName.slice(0, 16),
      accentColor: DEFAULT_HARNESS_VISUAL_META.accentColor,
      softBg: DEFAULT_HARNESS_VISUAL_META.softBg,
      tagline: direct.protocolLabel || direct.description,
    };
  }
  return getHarnessMeta(target.harnessKind ?? target.harnessId ?? 'agent');
}

/**
 * Resolves dynamic provider option descriptors from `HarnessInfo` (`optionDescriptors` or
 * `capabilitiesV2.optionDescriptors`). Falls back to synthesizing a generic `reasoningEffort`
 * descriptor only when a legacy driver declares `capabilities.reasoningEfforts` without V2 descriptors.
 */
export function resolveHarnessOptionDescriptors(
  harness: HarnessInfo | null | undefined,
  selectedModelId?: string | null,
): ProviderOptionDescriptor[] {
  if (!harness) return [];
  const raw =
    (harness.optionDescriptors && harness.optionDescriptors.length > 0
      ? harness.optionDescriptors
      : harness.capabilitiesV2?.optionDescriptors) ?? [];

  if (raw.length > 0) {
    const modelMeta = selectedModelId
      ? harness.models.find((m) => m.id === selectedModelId)
      : harness.models.find((m) => m.id === harness.defaultModelId);
    if (!modelMeta?.supportedEfforts || modelMeta.supportedEfforts.length === 0) {
      return raw;
    }
    const allowed = new Set<string>(modelMeta.supportedEfforts);
    return raw.map((desc) => {
      if (desc.kind === 'select' && (desc.key === 'reasoningEffort' || desc.key === 'effort')) {
        const filtered = desc.options.filter((opt) => allowed.has(opt.value));
        if (filtered.length > 0) {
          return {
            ...desc,
            defaultValue:
              modelMeta.defaultEffort && allowed.has(modelMeta.defaultEffort)
                ? modelMeta.defaultEffort
                : desc.defaultValue,
            options: filtered,
          };
        }
      }
      return desc;
    });
  }

  // Legacy fallback: synthesize reasoningEffort select from model/capabilities without vendor branching
  const modelMeta = selectedModelId ? harness.models.find((m) => m.id === selectedModelId) : null;
  const efforts =
    modelMeta?.supportedEfforts && modelMeta.supportedEfforts.length > 0
      ? modelMeta.supportedEfforts
      : harness.capabilities.reasoningEfforts ?? [];
  if (efforts.length === 0) return [];
  return [
    {
      key: 'reasoningEffort',
      label: '推理强度',
      kind: 'select',
      defaultValue: modelMeta?.defaultEffort,
      options: efforts.map((eff) => ({ value: eff, label: eff })),
    },
  ];
}

export interface ContextWindowMeter {
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  cachedTokens: number;
  cacheHitRate: number | null;
  level: 'normal' | 'warning' | 'critical';
  isEstimated: boolean;
}

const DEFAULT_ESTIMATED_CONTEXT_WINDOW = 200_000;

export function resolveContextWindowMeter(usage: TokenUsage | null | undefined): ContextWindowMeter | null {
  if (!usage) return null;
  const usedTokens = usage.contextTokens ?? (usage.inputTokens + usage.outputTokens);
  if (usedTokens <= 0 && !usage.modelContextWindow) return null;
  const isEstimated = !usage.modelContextWindow;
  const maxTokens = usage.modelContextWindow ?? DEFAULT_ESTIMATED_CONTEXT_WINDOW;
  const usagePercent = Math.min(100, Math.round((usedTokens / Math.max(1, maxTokens)) * 100));
  const cachedTokens = usage.cacheReadTokens ?? usage.cachedTokens ?? 0;
  const cacheDenominator = Math.max(usage.inputTokens, cachedTokens);
  const cacheHitRate =
    cachedTokens > 0 && cacheDenominator > 0
      ? Math.min(100, Math.round((cachedTokens / cacheDenominator) * 100))
      : null;
  const level: ContextWindowMeter['level'] =
    usagePercent >= 85 ? 'critical' : usagePercent >= 70 ? 'warning' : 'normal';
  return {
    usedTokens,
    maxTokens,
    usagePercent,
    cachedTokens,
    cacheHitRate,
    level,
    isEstimated,
  };
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, { label: string; desc: string }> = {
  plan: { label: 'Plan', desc: '只读分析与规划，不修改文件' },
  manual: { label: 'Manual', desc: '高敏感或未信任操作逐项审批' },
  accept_edits: { label: 'Accept Edits', desc: '允许工作区编辑，命令需审批' },
  auto: { label: 'Auto', desc: '自动批准沙箱内工具调用' },
};

export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

export function formatCountdown(targetTs: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.ceil((targetTs - now) / 1000));
  if (diffSec <= 0) return '已恢复';
  if (diffSec < 60) return `${diffSec} 秒后`;
  const mins = Math.ceil(diffSec / 60);
  if (mins < 60) return `${mins} 分钟后`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs} 小时 ${remMins} 分钟后` : `${hrs} 小时后`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatByteSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
