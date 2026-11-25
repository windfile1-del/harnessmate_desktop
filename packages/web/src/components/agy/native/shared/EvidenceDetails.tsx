import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { useState } from 'react';
import type { EvidenceDto } from '../../../../lib/native-client';
import { EVIDENCE_SOURCE_LABELS } from './status-dictionary';

export interface EvidenceDetailsProps {
  evidence?: EvidenceDto | null;
  reasonCode?: string | null;
  evidenceRefs?: readonly string[];
  defaultOpen?: boolean;
  label?: string;
}

function formatObservedTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

/**
 * Collapsible provenance inspector displaying field-level evidence source,
 * freshness, last observed timestamp, and allowlisted reason/evidence IDs.
 * Never renders private host paths, tokens, or raw wire payloads.
 */
export function EvidenceDetails({
  evidence,
  reasonCode,
  evidenceRefs,
  defaultOpen = false,
  label = '证据来源与新鲜度',
}: EvidenceDetailsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const effectiveReason = reasonCode ?? evidence?.reasonCode ?? null;
  const freshnessLabel =
    evidence?.freshness === 'fresh'
      ? '最新'
      : evidence?.freshness === 'stale'
        ? '已过期 (Stale)'
        : '未知 (Unknown)';

  return (
    <div
      data-testid="evidence-details"
      className="rounded-xl text-[11px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          <Info size={11.5} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
          <span className="truncate font-medium text-[var(--text-primary)]">{label}</span>
        </span>
        <span className="shrink-0 font-mono-code text-[10px] text-[var(--text-muted)]">
          {evidence ? `${EVIDENCE_SOURCE_LABELS[evidence.sourceKind]} · ${freshnessLabel}` : '无观测证据'}
        </span>
      </button>

      {open && (
        <dl
          className="grid grid-cols-1 gap-1.5 px-3 py-2 text-[11px] sm:grid-cols-2"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">来源类型</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">
              {evidence ? EVIDENCE_SOURCE_LABELS[evidence.sourceKind] : '未提供来源'}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">新鲜度</dt>
            <dd className="mt-0.5 text-[var(--text-primary)]">{freshnessLabel}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">最后观察时间</dt>
            <dd className="mt-0.5 font-mono-code text-[var(--text-secondary)]">
              {evidence ? formatObservedTime(evidence.observedAt) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">诊断码 (Reason)</dt>
            <dd className="mt-0.5 font-mono-code text-[var(--text-secondary)]">
              {effectiveReason || '—'}
            </dd>
          </div>
          {evidence?.wireVariant && (
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">协议变体</dt>
              <dd className="mt-0.5 font-mono-code text-[var(--text-secondary)]">{evidence.wireVariant}</dd>
            </div>
          )}
          {evidence?.schemaVersion && (
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">快照版本</dt>
              <dd className="mt-0.5 font-mono-code text-[var(--text-secondary)]">{evidence.schemaVersion}</dd>
            </div>
          )}
          {evidence?.captureId && (
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">回放样本 ID</dt>
              <dd className="mt-0.5 font-mono-code text-[var(--text-secondary)]">{evidence.captureId}</dd>
            </div>
          )}
          {evidenceRefs && evidenceRefs.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">引用证据 ID</dt>
              <dd className="mt-0.5 flex flex-wrap gap-1">
                {evidenceRefs.map((ref) => (
                  <span
                    key={ref}
                    className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-secondary)]"
                  >
                    {ref}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
