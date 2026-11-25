import type { NativeRuntimeStatus, NativeWork, RuntimeBinding } from '@harnessmate/protocol';
import type {
  CancelStateRecord,
  ReactiveAttributionCode,
  ReactiveRunDiagnosis,
  RuntimeDiagnosticEntry,
} from './types.js';
import { isActiveWorkState } from './work-tracker.js';

export interface DiagnosisCounters {
  readonly earlyPromptResponsesObserved: number;
  readonly wakeSegmentsObserved: number;
  readonly reactiveNotObservedGaps: number;
  readonly staleRpcResponsesBlocked: number;
  readonly duplicateSettlementsPrevented: number;
}

/**
 * Pure diagnostic classifier separating upstream ACP/AGY gaps (e.g. `reactive_not_observed`,
 * unconfirmed cancel, early prompt response, transport exit) from HarnessMate runtime defenses
 * (stale RPC blocking, generation fencing, duplicate terminal suppression).
 */
export function buildReactiveRunDiagnosis(params: {
  readonly binding: RuntimeBinding;
  readonly status: NativeRuntimeStatus;
  readonly work: readonly NativeWork[];
  readonly cancelState: CancelStateRecord | null;
  readonly counters: DiagnosisCounters;
  readonly diagnostics: readonly RuntimeDiagnosticEntry[];
}): ReactiveRunDiagnosis {
  const { binding, status, work, cancelState, counters, diagnostics } = params;

  const finiteWorkCount = work.filter((w) => w.kind === 'finite_command').length;
  const activeBlockingWorkCount = work.filter(
    (w) =>
      w.blocking === 'confirmed_blocking' &&
      w.state.kind === 'known' &&
      isActiveWorkState(w.state.value),
  ).length;
  const activeDaemonWorkCount = work.filter(
    (w) =>
      w.kind === 'daemon' &&
      w.state.kind === 'known' &&
      isActiveWorkState(w.state.value),
  ).length;
  const unknownWorkCount = work.filter((w) => w.state.kind === 'unknown' || w.kind === 'unknown').length;

  let primaryAttribution: ReactiveAttributionCode = 'healthy_single_turn';

  if (diagnostics.some((d) => d.code === 'observation_timeout_unknown')) {
    primaryAttribution = 'observation_timeout_unknown';
  } else if (status === 'disconnected' && diagnostics.some((d) => d.code === 'transport_disconnected_while_active')) {
    primaryAttribution = 'transport_disconnected_while_active';
  } else if (cancelState?.outcome === 'grace_expired_unknown') {
    primaryAttribution = 'cancel_grace_expired_unknown';
  } else if (cancelState?.outcome === 'confirmed_cancelled') {
    primaryAttribution = 'cancel_confirmed';
  } else if (counters.wakeSegmentsObserved > 0) {
    primaryAttribution = 'healthy_reactive_wake_observed';
  } else if (counters.reactiveNotObservedGaps > 0) {
    primaryAttribution = 'reactive_not_observed';
  } else if (counters.staleRpcResponsesBlocked > 0) {
    primaryAttribution = 'hm_stale_rpc_pollution_blocked';
  } else if (counters.earlyPromptResponsesObserved > 0) {
    primaryAttribution = 'upstream_early_prompt_response';
  }

  return {
    runtimeId: binding.runtimeId,
    generation: binding.generation,
    status,
    finiteWorkCount,
    activeBlockingWorkCount,
    activeDaemonWorkCount,
    unknownWorkCount,
    earlyPromptResponsesObserved: counters.earlyPromptResponsesObserved,
    wakeSegmentsObserved: counters.wakeSegmentsObserved,
    reactiveNotObservedGaps: counters.reactiveNotObservedGaps,
    staleRpcResponsesBlocked: counters.staleRpcResponsesBlocked,
    duplicateSettlementsPrevented: counters.duplicateSettlementsPrevented,
    cancelState,
    primaryAttribution,
    diagnostics: [...diagnostics],
  };
}
