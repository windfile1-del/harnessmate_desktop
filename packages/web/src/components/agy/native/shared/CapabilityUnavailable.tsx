import { AlertTriangle, BookOpen, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';
import type { GateState } from '../../../../lib/native-client';
import { EntityStatusBadge } from './EntityStatusBadge';

export interface CapabilityUnavailableProps {
  title: string;
  gate: GateState;
  reason: string;
  capabilityId?: string;
  officialEntryHint?: string;
  officialDocUrl?: string;
  onRefresh?: () => void;
  onReadOnlyFallback?: () => void;
  readOnlyFallbackLabel?: string;
}

/**
 * Honest degradation boundary component rendered whenever a capability or feed is
 * `unknown`, `unsupported`, `upstream_limited`, `not_tested`, or requires official login/CLI.
 */
export function CapabilityUnavailable({
  title,
  gate,
  reason,
  capabilityId,
  officialEntryHint,
  officialDocUrl,
  onRefresh,
  onReadOnlyFallback,
  readOnlyFallbackLabel = '查看已观察的只读记录',
}: CapabilityUnavailableProps) {
  return (
    <section
      data-testid="capability-unavailable"
      data-capability-gate={gate}
      aria-label={title}
      className="space-y-2.5 rounded-2xl p-3.5 text-[12px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {gate === 'unsupported' ? (
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--accent-rose)]" aria-hidden="true" />
          ) : (
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--accent-clay)]" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">{title}</h3>
              {capabilityId && (
                <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                  {capabilityId}
                </span>
              )}
            </div>
            <p className="mt-1 leading-relaxed text-[var(--text-secondary)]">{reason}</p>
          </div>
        </div>
        <EntityStatusBadge kind="gate" gate={gate} />
      </div>

      {officialEntryHint && (
        <div
          className="rounded-xl px-2.5 py-2 text-[11.5px] text-[var(--text-secondary)]"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <span className="font-medium text-[var(--text-primary)]">官方入口说明：</span>
          <span>{officialEntryHint}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          >
            <RefreshCw size={11.5} aria-hidden="true" />
            <span>刷新能力探测</span>
          </button>
        )}
        {onReadOnlyFallback && (
          <button
            type="button"
            onClick={onReadOnlyFallback}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          >
            <BookOpen size={11.5} aria-hidden="true" />
            <span>{readOnlyFallbackLabel}</span>
          </button>
        )}
        {officialDocUrl && (
          <a
            href={officialDocUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ExternalLink size={11} aria-hidden="true" />
            <span>官方文档</span>
          </a>
        )}
      </div>
    </section>
  );
}
