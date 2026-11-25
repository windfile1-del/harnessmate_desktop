import { Loader2, ShieldAlert, Square, Terminal } from 'lucide-react';
import { useState } from 'react';
import type {
  CapabilityDescriptor,
  NativeControlRequest,
  RuntimeBinding,
} from '../../../../lib/native-client';
import { EntityStatusBadge } from './EntityStatusBadge';

export interface NativeControlMenuProps {
  target: NativeControlRequest['target'];
  targetLabel: string;
  expectedRevision?: number;
  binding?: RuntimeBinding;
  capability?: CapabilityDescriptor | null;
  disabled?: boolean;
  onDispatchControl?: (
    req: Omit<NativeControlRequest, 'generation' | 'idempotencyKey'> & {
      expectedBinding?: RuntimeBinding;
    },
  ) => Promise<void>;
}

/**
 * Evidence-gated native control bar.
 * Only renders executable controls when the corresponding capability descriptor
 * has `control === 'available'` and an action with `gate === 'available'`.
 * Never fabricates cancel/steer controls for unknown or unconfirmed targets.
 */
export function NativeControlMenu({
  target,
  targetLabel,
  expectedRevision,
  binding,
  capability,
  disabled = false,
  onDispatchControl,
}: NativeControlMenuProps) {
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const availableActions =
    capability?.control === 'available'
      ? capability.actions.filter((action) => action.gate === 'available')
      : [];

  const handleAction = async (actionKey: string, actionLabel: string) => {
    if (!onDispatchControl || submittingAction) return;
    setSubmittingAction(actionKey);
    setErrorMessage(null);
    setReceiptMessage(`已对「${targetLabel}」发出「${actionLabel}」，等待原生确认…`);
    try {
      await onDispatchControl({
        target,
        action: actionKey,
        expectedRevision,
        expectedBinding: binding,
      });
    } catch (err) {
      setReceiptMessage(null);
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingAction(null);
    }
  };

  return (
    <div
      data-testid="native-control-menu"
      data-control-gate={capability?.control ?? 'unknown'}
      className="space-y-1.5 rounded-xl p-2.5 text-[11.5px]"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
          <Terminal size={12} className="text-[var(--accent-indigo)]" aria-hidden="true" />
          <span>原生控制目标：{targetLabel}</span>
        </span>
        <EntityStatusBadge kind="gate" gate={capability?.control ?? 'unknown'} compact />
      </div>

      {availableActions.length > 0 && onDispatchControl ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {availableActions.map((act) => {
            const label = act.label ?? (act.key === 'cancel' || act.key === 'stop' ? '停止任务' : act.key);
            const isCancel = act.key === 'cancel' || act.key === 'stop';
            const busy = submittingAction === act.key;
            return (
              <button
                key={act.key}
                type="button"
                disabled={disabled || submittingAction !== null}
                onClick={() => void handleAction(act.key, label)}
                aria-label={`${label} (${targetLabel})`}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                style={
                  isCancel
                    ? {
                        backgroundColor: 'var(--accent-rose-soft)',
                        color: 'var(--accent-rose)',
                        border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
                      }
                    : {
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-hairline)',
                      }
                }
              >
                {busy ? (
                  <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                ) : isCancel ? (
                  <Square size={10} fill="currentColor" aria-hidden="true" />
                ) : null}
                <span>{busy ? '正在取消…' : label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <ShieldAlert size={11.5} aria-hidden="true" />
          <span>当前目标未获得已验证的原生控制能力，已保持只读边界。</span>
        </p>
      )}

      {receiptMessage && (
        <div className="text-[11px] text-[var(--accent-indigo)]" role="status">
          {receiptMessage}
        </div>
      )}
      {errorMessage && (
        <div className="text-[11px] text-[var(--accent-rose)]" role="alert">
          控制操作失败：{errorMessage}
        </div>
      )}
    </div>
  );
}
