import type { HarnessModelInfo, ReasoningEffort } from '@harnessmate/protocol';
import { Brain, Cpu, Lock } from 'lucide-react';
import { useMemo } from 'react';
import {
  resolveActualModelEffortOptions,
  type ObservedConfigOptionLite,
} from './command-catalog';

export interface AgyModelEffortPickerProps {
  readonly harnessModels?: readonly HarnessModelInfo[];
  readonly activeModelId?: string | null;
  readonly activeEffort?: ReasoningEffort | null;
  readonly observedConfigOptions?: readonly ObservedConfigOptionLite[];
  readonly disabled?: boolean;
  readonly onSelectModel: (modelId: string | null) => void;
  readonly onSelectEffort: (effort: ReasoningEffort) => void;
}

const EFFORT_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  none: '无 (none)',
  disabled: '关闭 (disabled)',
  low: '低 (low)',
  medium: '中 (medium)',
  high: '高 (high)',
  xhigh: '极高 (xhigh)',
  max: '最大 (max)',
  ultra: '超高 (ultra)',
};

/**
 * AGY Actual Model & Effort Picker (NP-06).
 * - Populates model list and `thought_level` options STRICTLY from actual observed runtime
 *   `configOptions` / harness probe metadata.
 * - Never fabricates unsupported effort levels and never silently falls back to another model
 *   or account when options are unobserved.
 */
export function AgyModelEffortPicker({
  harnessModels,
  activeModelId,
  activeEffort,
  observedConfigOptions,
  disabled = false,
  onSelectModel,
  onSelectEffort,
}: AgyModelEffortPickerProps) {
  const resolved = useMemo(
    () =>
      resolveActualModelEffortOptions({
        harnessModels,
        activeModelId,
        activeEffort,
        observedConfigOptions,
      }),
    [harnessModels, activeModelId, activeEffort, observedConfigOptions],
  );

  const groupedModels = useMemo(() => {
    const groups = new Map<string, typeof resolved.models[number][]>();
    for (const model of resolved.models) {
      const list = groups.get(model.group) ?? [];
      list.push(model);
      groups.set(model.group, list);
    }
    return [...groups.entries()];
  }, [resolved.models]);

  return (
    <div
      data-testid="agy-model-effort-picker"
      className="inline-flex flex-wrap items-center gap-1.5 text-[11px]"
    >
      <label className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5">
        <Cpu size={11.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
        <span className="sr-only">AGY 模型选择</span>
        <select
          aria-label="AGY 模型选择"
          disabled={disabled || resolved.models.length === 0}
          value={resolved.currentModelId ?? ''}
          onChange={(e) => onSelectModel(e.target.value ? e.target.value : null)}
          className="cursor-pointer bg-transparent text-[11px] font-medium text-[var(--text-primary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
        >
          <option value="">
            {resolved.models.length === 0 ? '未观测到可用模型' : 'CLI 默认模型'}
          </option>
          {groupedModels.map(([groupName, models]) => (
            <optgroup key={groupName} label={groupName}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {resolved.effortObserved ? (
        <label className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5">
          <Brain size={11.5} className="text-[var(--accent-emerald)]" aria-hidden="true" />
          <span className="sr-only">AGY 思考强度</span>
          <select
            aria-label="AGY 思考强度"
            disabled={disabled}
            value={resolved.currentEffort ?? ''}
            onChange={(e) => {
              const val = e.target.value as ReasoningEffort;
              if (val) onSelectEffort(val);
            }}
            className="cursor-pointer bg-transparent text-[11px] font-medium text-[var(--text-primary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-55"
          >
            {!resolved.currentEffort && (
              <option value="" disabled>
                思考强度
              </option>
            )}
            {resolved.availableEfforts.map((level) => (
              <option key={level} value={level}>
                {EFFORT_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span
          data-testid="agy-effort-unobserved"
          title={resolved.effortUnavailableReason}
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--text-muted)]"
        >
          <Lock size={10} aria-hidden="true" />
          未观测到思考强度选项
        </span>
      )}
    </div>
  );
}
