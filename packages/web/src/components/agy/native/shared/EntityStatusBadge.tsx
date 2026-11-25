import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Loader2,
  PauseCircle,
  Radio,
  ShieldAlert,
  WifiOff,
  XCircle,
} from 'lucide-react';
import type {
  ActivityStatus,
  AgentForeground,
  AgentLineage,
  Blocking,
  GateState,
  NativeRequestReceiptState,
  NativeRuntimeStatus,
  Observed,
  WorkOutcome,
  WorkState,
} from '../../../../lib/native-client';
import {
  ACTIVITY_STATUS_DICTIONARY,
  AGENT_LINEAGE_LABELS,
  BLOCKING_DICTIONARY,
  GATE_STATE_DICTIONARY,
  RECEIPT_STATE_DICTIONARY,
  RUNTIME_STATUS_DICTIONARY,
  WORK_OUTCOME_DICTIONARY,
  resolveObservedForegroundMeta,
  resolveObservedWorkMeta,
  toneStyle,
  type SemanticTone,
  type StatusMeta,
} from './status-dictionary';

export type EntityStatusBadgeProps =
  | { kind: 'runtime'; status: NativeRuntimeStatus; compact?: boolean }
  | { kind: 'activity'; status: ActivityStatus; compact?: boolean }
  | { kind: 'work'; observed: Observed<WorkState>; compact?: boolean }
  | { kind: 'outcome'; observed: Observed<WorkOutcome>; compact?: boolean }
  | { kind: 'foreground'; observed: Observed<AgentForeground>; compact?: boolean }
  | { kind: 'blocking'; blocking: Blocking; compact?: boolean }
  | { kind: 'gate'; gate: GateState; compact?: boolean }
  | { kind: 'receipt'; state: NativeRequestReceiptState; compact?: boolean }
  | { kind: 'lineage'; lineage: AgentLineage; compact?: boolean };

function resolveBadgeMeta(props: EntityStatusBadgeProps): StatusMeta {
  switch (props.kind) {
    case 'runtime':
      return RUNTIME_STATUS_DICTIONARY[props.status];
    case 'activity':
      return ACTIVITY_STATUS_DICTIONARY[props.status];
    case 'work':
      return resolveObservedWorkMeta(props.observed);
    case 'outcome':
      if (props.observed.kind === 'known') {
        return WORK_OUTCOME_DICTIONARY[props.observed.value];
      }
      return {
        label: props.observed.kind === 'stale' ? '结果已过期' : '结果未确认',
        shortLabel: props.observed.kind === 'stale' ? '结果过期' : '结果未知',
        tone: props.observed.kind === 'stale' ? 'clay' : 'muted',
        ariaLabel: `工作结果${props.observed.kind === 'stale' ? '已过期' : '未知'}`,
        description: props.observed.reasonCode,
      };
    case 'foreground':
      return resolveObservedForegroundMeta(props.observed);
    case 'blocking':
      return BLOCKING_DICTIONARY[props.blocking];
    case 'gate':
      return GATE_STATE_DICTIONARY[props.gate];
    case 'receipt':
      return RECEIPT_STATE_DICTIONARY[props.state];
    case 'lineage':
      return AGENT_LINEAGE_LABELS[props.lineage];
  }
}

function StatusIcon({
  props,
  tone,
}: {
  props: EntityStatusBadgeProps;
  tone: SemanticTone;
}) {
  if (props.kind === 'runtime') {
    if (props.status === 'attached') return <Radio size={11} aria-hidden="true" />;
    if (props.status === 'reconciling') return <Loader2 size={11} className="animate-spin" aria-hidden="true" />;
    return <WifiOff size={11} aria-hidden="true" />;
  }
  if (props.kind === 'activity') {
    if (props.status === 'running' || props.status === 'starting' || props.status === 'cancelling' || props.status === 'reconciling') {
      return <Loader2 size={11} className="animate-spin" aria-hidden="true" />;
    }
    if (props.status === 'waiting_background') return <Clock size={11} aria-hidden="true" />;
    if (props.status === 'requires_action') return <ShieldAlert size={11} aria-hidden="true" />;
    if (props.status === 'finished') return <CheckCircle2 size={11} aria-hidden="true" />;
    if (props.status === 'failed') return <XCircle size={11} aria-hidden="true" />;
    if (props.status === 'quiescent') return <PauseCircle size={11} aria-hidden="true" />;
    return <HelpCircle size={11} aria-hidden="true" />;
  }
  if (tone === 'emerald') return <CheckCircle2 size={11} aria-hidden="true" />;
  if (tone === 'rose') return <XCircle size={11} aria-hidden="true" />;
  if (tone === 'star') return <AlertTriangle size={11} aria-hidden="true" />;
  if (tone === 'clay') return <AlertCircle size={11} aria-hidden="true" />;
  if (tone === 'indigo') return <Clock size={11} aria-hidden="true" />;
  return <HelpCircle size={11} aria-hidden="true" />;
}

/**
 * Accessible status badge driven by `STATUS_DICTIONARY_VERSION`.
 * Uses text + icon + subtle color so status never depends on color alone,
 * and avoids `aria-live` to prevent screen-reader jitter under high-frequency updates.
 */
export function EntityStatusBadge(props: EntityStatusBadgeProps) {
  const meta = resolveBadgeMeta(props);
  const style = toneStyle(meta.tone);
  const label = props.compact ? meta.shortLabel : meta.label;

  return (
    <span
      data-testid={`entity-status-${props.kind}`}
      data-status-tone={meta.tone}
      aria-label={meta.ariaLabel}
      title={meta.description}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-tight"
      style={style}
    >
      <StatusIcon props={props} tone={meta.tone} />
      <span>{label}</span>
    </span>
  );
}
