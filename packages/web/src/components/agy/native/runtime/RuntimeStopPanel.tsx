import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert, Square } from 'lucide-react';
import { useState } from 'react';
import type {
  CapabilityDescriptor,
  NativeControlRequest,
  NativeRuntimeProjection,
  RuntimeBinding,
} from '../../../../lib/native-client';
import { EntityStatusBadge, toneStyle } from '../shared';
import {
  deriveStopStatusSummary,
  findStopCapabilityAction,
  type StopTargetCandidate,
} from './runtime-view-model';

export interface RuntimeStopPanelProps {
  readonly projection: NativeRuntimeProjection;
  readonly candidates: readonly StopTargetCandidate[];
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly onDispatchControl?: (
    req: Omit<NativeControlRequest, 'generation' | 'idempotencyKey'> & {
      expectedBinding?: RuntimeBinding;
    },
  ) => Promise<void>;
}

/**
 * Dedicated Stop control panel for NP-04 Reactive Runtime.
 * Explicitly separates:
 * 1. Stop Target (Runtime root / Finite work / Detached Daemon / Activity)
 * 2. Stop Waiting (requested -> grace period waiting for native confirmation)
 * 3. Stop Result (confirmed_cancelled vs unconfirmed_unknown vs disconnected vs error)
 *
 * Strictly capability-gated: disabled unless `control === 'available'` and cancel/stop action is available.
 */
export function RuntimeStopPanel({
  projection,
  candidates,
  capabilities,
  onDispatchControl,
}: RuntimeStopPanelProps) {
  const [selectedKey, setSelectedKey] = useState<string>(candidates[0]?.key ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [requestedTargetKey, setRequestedTargetKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectedCandidate =
    candidates.find((c) => c.key === selectedKey) ?? candidates[0] ?? null;
  if (!selectedCandidate) return null;

  const stopCap = findStopCapabilityAction(capabilities);
  const isAttached = projection.status === 'attached';
  const canExecuteStop = Boolean(stopCap && onDispatchControl && isAttached && !submitting);

  const stopSummary = deriveStopStatusSummary({
    target: selectedCandidate,
    projection,
    localRequested: requestedTargetKey === selectedCandidate.key,
    localSubmitting: submitting && requestedTargetKey === selectedCandidate.key,
    localError: requestedTargetKey === selectedCandidate.key ? errorMsg : null,
  });

  const summaryStyle = toneStyle(stopSummary.tone);

  const handleStop = async () => {
    if (!stopCap || !onDispatchControl || submitting || !isAttached) return;
    setSubmitting(true);
    setRequestedTargetKey(selectedCandidate.key);
    setErrorMsg(null);
    try {
      await onDispatchControl({
        target: selectedCandidate.target,
        action: stopCap.actionKey,
        expectedRevision: selectedCandidate.expectedRevision,
        expectedBinding: projection.binding,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      data-testid="np04-stop-panel"
      data-stop-phase={stopSummary.phase}
      aria-label="原生停止控制（目标、等待与结果）"
      className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
          <Square size={11} className="text-[var(--accent-rose)]" fill="currentColor" aria-hidden="true" />
          <span>原生停止控制 (Stop)</span>
        </div>
        <EntityStatusBadge
          kind="gate"
          gate={stopCap ? stopCap.capability.control : 'unknown'}
          compact
        />
      </div>

      {/* 1. Stop Target Selection */}
      <div className="space-y-1">
        <div className="text-[10.5px] font-medium text-[var(--text-muted)]">1. 停止目标 (Target)</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="选择停止目标">
          {candidates.map((cand) => {
            const isSelected = cand.key === selectedCandidate.key;
            return (
              <button
                key={cand.key}
                type="button"
                role="radio"
                aria-checked={isSelected}
                data-testid={`np04-stop-target-${cand.target.type}`}
                onClick={() => {
                  setSelectedKey(cand.key);
                  setErrorMsg(null);
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors"
                style={{
                  backgroundColor: isSelected ? 'var(--bg-active)' : 'var(--bg-elevated)',
                  borderColor: isSelected ? 'var(--border-focus)' : 'var(--border-hairline)',
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <span className="font-medium">{cand.kindBadge}</span>
                <span className="max-w-[160px] truncate font-mono-code text-[10px] text-[var(--text-muted)]">
                  {cand.target.id}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Action Dispatch & Waiting State */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-[var(--text-secondary)]">
          <span>目标详情：</span>
          <span className="font-medium text-[var(--text-primary)]">{selectedCandidate.label}</span>
          <span className="ml-1 font-mono-code text-[10px] text-[var(--text-muted)]">
            (rev {selectedCandidate.expectedRevision} · {projection.binding.generation})
          </span>
        </div>

        <button
          type="button"
          data-testid="np04-stop-dispatch-btn"
          disabled={!canExecuteStop}
          onClick={() => void handleStop()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45"
          style={{
            backgroundColor: 'var(--accent-rose-soft)',
            color: 'var(--accent-rose)',
            border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
          }}
        >
          {submitting || stopSummary.phase === 'waiting_confirmation' ? (
            <Loader2 size={11.5} className="animate-spin" aria-hidden="true" />
          ) : (
            <Square size={10} fill="currentColor" aria-hidden="true" />
          )}
          <span>
            {submitting
              ? '正在发送停止…'
              : stopSummary.phase === 'waiting_confirmation'
                ? '等待原生确认…'
                : (stopCap?.actionLabel ?? '停止不可用（未验证控制能力）')}
          </span>
        </button>
      </div>

      {!stopCap && (
        <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
          <ShieldAlert size={11.5} aria-hidden="true" />
          <span>当前绑定尚未开放已验证的原生停止控制，已保持只读边界。</span>
        </div>
      )}

      {/* 3. Explicit Stop Waiting / Result Feedback */}
      {stopSummary.phase !== 'idle' && (
        <div
          data-testid="np04-stop-result"
          role={stopSummary.phase === 'error' ? 'alert' : 'status'}
          className="flex items-start gap-2 rounded-xl border p-2 text-[11px]"
          style={{
            backgroundColor: summaryStyle.backgroundColor,
            borderColor: summaryStyle.borderColor,
            color: summaryStyle.color,
          }}
        >
          {stopSummary.phase === 'confirmed_cancelled' ? (
            <CheckCircle2 size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          ) : stopSummary.phase === 'waiting_confirmation' ? (
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <div className="font-semibold">{stopSummary.headline}</div>
            <div className="mt-0.5 text-[var(--text-secondary)]">{stopSummary.detail}</div>
          </div>
        </div>
      )}
    </section>
  );
}
