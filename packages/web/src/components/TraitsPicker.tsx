import type { ProviderOptionDescriptor, TurnOptionValue } from '@harnessmate/protocol';
import { SlidersHorizontal } from 'lucide-react';
import { useMemo } from 'react';

const TRAITS_STORAGE_PREFIX = 'hm_traits_v1:';

export function sanitizeTraitValues(
  descriptors: readonly ProviderOptionDescriptor[],
  rawValues: Readonly<Record<string, TurnOptionValue | undefined>>,
): Record<string, TurnOptionValue> {
  const clean: Record<string, TurnOptionValue> = {};
  for (const desc of descriptors) {
    const candidate = rawValues[desc.key];
    if (desc.kind === 'select') {
      const validValues = new Set(desc.options.map((o) => o.value));
      if (typeof candidate === 'string' && validValues.has(candidate)) {
        clean[desc.key] = candidate;
      } else if (desc.defaultValue !== undefined && validValues.has(desc.defaultValue)) {
        clean[desc.key] = desc.defaultValue;
      }
    } else if (desc.kind === 'boolean') {
      if (typeof candidate === 'boolean') {
        clean[desc.key] = candidate;
      } else if (typeof desc.defaultValue === 'boolean') {
        clean[desc.key] = desc.defaultValue;
      }
    } else if (desc.kind === 'number') {
      const num =
        typeof candidate === 'number' && Number.isFinite(candidate)
          ? candidate
          : typeof desc.defaultValue === 'number' && Number.isFinite(desc.defaultValue)
            ? desc.defaultValue
            : undefined;
      if (num !== undefined) {
        let clamped = num;
        if (desc.min !== undefined) clamped = Math.max(desc.min, clamped);
        if (desc.max !== undefined) clamped = Math.min(desc.max, clamped);
        clean[desc.key] = clamped;
      }
    }
  }
  return clean;
}

export function loadSavedTraitValues(scopeKey: string): Record<string, TurnOptionValue> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(`${TRAITS_STORAGE_PREFIX}${scopeKey}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, TurnOptionValue> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function persistTraitValues(
  scopeKey: string,
  values: Readonly<Record<string, TurnOptionValue>>,
): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${TRAITS_STORAGE_PREFIX}${scopeKey}`, JSON.stringify(values));
  } catch {
    // ignore storage quota errors
  }
}

export interface TraitsPickerProps {
  descriptors: readonly ProviderOptionDescriptor[];
  values: Readonly<Record<string, TurnOptionValue | undefined>>;
  disabled?: boolean;
  onChange: (key: string, value: TurnOptionValue | null) => void;
}

/**
 * Purely schema-driven dynamic trait controls (`composer.traits`).
 * Zero vendor hardcoding — renders `select`, `boolean`, and `number`
 * descriptors directly from backend `ProviderOptionDescriptor[]`.
 */
export function TraitsPicker({
  descriptors,
  values,
  disabled = false,
  onChange,
}: TraitsPickerProps) {
  const sanitized = useMemo(
    () => sanitizeTraitValues(descriptors, values),
    [descriptors, values],
  );

  if (descriptors.length === 0) return null;

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1.5"
      data-testid="traits-picker"
      aria-label="模型与引擎动态参数"
    >
      {descriptors.map((desc) => {
        const currentValue = sanitized[desc.key];

        if (desc.kind === 'select') {
          const strValue = typeof currentValue === 'string' ? currentValue : '';
          return (
            <label
              key={desc.key}
              title={desc.description ?? desc.label}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] text-[var(--text-secondary)]"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <SlidersHorizontal size={11} className="shrink-0 opacity-65" />
              <span className="sr-only">{desc.label}</span>
              <select
                aria-label={desc.label}
                data-trait-key={desc.key}
                value={strValue}
                disabled={disabled}
                onChange={(e) => onChange(desc.key, e.target.value || null)}
                className="cursor-pointer bg-transparent text-[11.5px] text-[var(--text-primary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                {!desc.defaultValue && <option value="">{desc.label}: 默认</option>}
                {desc.options.map((opt) => (
                  <option key={opt.value} value={opt.value} title={opt.description}>
                    {desc.label}: {opt.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        if (desc.kind === 'boolean') {
          const checked = currentValue === true;
          return (
            <button
              key={desc.key}
              type="button"
              role="switch"
              aria-checked={checked}
              aria-label={desc.label}
              data-trait-key={desc.key}
              disabled={disabled}
              title={desc.description ?? desc.label}
              onClick={() => onChange(desc.key, !checked)}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                backgroundColor: checked ? 'var(--accent-indigo-soft)' : 'var(--bg-elevated)',
                color: checked ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                border: `1px solid ${checked ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor: checked ? 'var(--accent-indigo)' : 'var(--text-muted)',
                }}
              />
              <span>{desc.label}</span>
            </button>
          );
        }

        // number descriptor
        const numVal = typeof currentValue === 'number' ? currentValue : desc.defaultValue ?? desc.min ?? 0;
        return (
          <label
            key={desc.key}
            title={desc.description ?? desc.label}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-[var(--text-secondary)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <span className="truncate">{desc.label}</span>
            <input
              type="number"
              aria-label={desc.label}
              data-trait-key={desc.key}
              value={numVal}
              min={desc.min}
              max={desc.max}
              step={desc.step ?? 1}
              disabled={disabled}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed)) {
                  onChange(desc.key, parsed);
                }
              }}
              className="font-mono-code w-16 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] focus:outline-none disabled:opacity-50"
            />
          </label>
        );
      })}
    </div>
  );
}
