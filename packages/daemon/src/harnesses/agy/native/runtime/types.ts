import type {
  Activity,
  ActivityId,
  BindingGeneration,
  Evidence,
  NativeAgentId,
  NativeCanonicalEvent,
  NativeRequestSummaryDto,
  NativeRuntimeStatus,
  NativeWork,
  NativeWorkKind,
  RpcId,
  RuntimeBinding,
  RuntimeId,
  WorkId,
  WorkOutcome,
  WorkState,
  Blocking,
} from '@harnessmate/protocol';
import type {
  NativeCommitMutation,
  NativeEventDraft,
  NativePermissionPort,
  PromptContext,
  TurnSettlement,
} from '../wiring/types.js';

export const AGY_NP04_RUNTIME_VERSION = '1.0.0-np04' as const;

export interface RuntimeTimerHandle {
  cancel(): void;
}

export interface RuntimeTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle;
}

export const defaultRuntimeTimerScheduler: RuntimeTimerScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    let cancelled = false;
    return {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(timer);
      },
    };
  },
};

export interface ReactiveRuntimeConfig {
  /** Grace period after Stop/Cancel is requested before unconfirmed active work becomes unknown/stale. */
  readonly cancelGraceMs: number;
  /** Bounded quiescence window after blocking finite work finishes to capture immediate native wake segments. */
  readonly quiescenceWindowMs: number;
  /** Bounded quiescence window for native-only continuation activities before transitioning to quiescent. */
  readonly nativeActivityQuiescenceMs: number;
  /** Hard upper bound for holding an active turn or finite work with zero wire progress before marking unknown. */
  readonly observationTimeoutMs: number;
  /** Maximum tracked NativeWork entities retained per runtime generation (oldest terminal items evicted first). */
  readonly maxTrackedWorkPerRuntime: number;
  /** Maximum buffered timeline entries per ActivityId for NativeTimelineReaderPort. */
  readonly maxTimelineEntriesPerActivity: number;
  /** When true, disables heuristic title/input classification and requires explicit structured wire fields. */
  readonly strictMode: boolean;
  /** Whether detached daemons alone prevent warm-pool eviction when no finite work or pending requests exist. */
  readonly retainWarmPoolForDetachedDaemons: boolean;
}

export const DEFAULT_REACTIVE_RUNTIME_CONFIG: Readonly<ReactiveRuntimeConfig> = Object.freeze({
  cancelGraceMs: 5_000,
  quiescenceWindowMs: 1_500,
  nativeActivityQuiescenceMs: 2_000,
  observationTimeoutMs: 180_000,
  maxTrackedWorkPerRuntime: 500,
  maxTimelineEntriesPerActivity: 1_000,
  strictMode: false,
  retainWarmPoolForDetachedDaemons: true,
});

// ── Contract Stubs for NP-05 (Child Identity) & NP-07 (Permissions) ────

/**
 * Contract stub seam for NP-05 Child Identity resolution.
 * Until NP-05 is wired in G2 integration, the default stub preserves `unresolved`
 * whenever no confirmed native child ID exists.
 */
export interface ReactiveChildIdentityStub {
  resolveOwnerAgent(input: {
    readonly binding: RuntimeBinding;
    readonly originSession?: string;
    readonly childSessionId?: string;
    readonly toolCallId?: string;
  }): {
    readonly agentId?: NativeAgentId;
    readonly lineage: 'confirmed' | 'unresolved' | 'conflicting';
  };
}

export const DEFAULT_UNRESOLVED_CHILD_STUB: ReactiveChildIdentityStub = {
  resolveOwnerAgent: () => ({ lineage: 'unresolved' }),
};

/**
 * Contract stub seam for NP-07 Pending Requests.
 * Can be backed directly by `NativePermissionPort` or an in-memory stub before G2 wiring.
 */
export interface ReactivePendingRequestStub {
  listActivePendingRequestIds(binding: RuntimeBinding): readonly string[];
}

export function createPermissionPortRequestStub(
  port: Pick<NativePermissionPort, 'listPendingRequests'>,
): ReactivePendingRequestStub {
  return {
    listActivePendingRequestIds(binding) {
      return port
        .listPendingRequests(binding)
        .filter((req) => req.runtimeId === binding.runtimeId && req.generation === binding.generation)
        .map((req) => req.approvalId);
    },
  };
}

/**
 * Persistence + publish bridge matching `AgyNativeRuntimeRegistry.commitAndPublish`.
 */
export interface NativeRuntimePublisher {
  commitAndPublish(
    binding: RuntimeBinding,
    mutation: NativeCommitMutation,
    eventDraft: NativeEventDraft,
  ): { deduplicated: boolean; event: NativeCanonicalEvent };
}

// ── Versioned Codec Types ──────────────────────────────────────────────

export interface CodecRuleDescriptor {
  readonly id: string;
  readonly version: string;
  readonly minCliVersion?: string;
  readonly traceRefs: readonly string[];
  readonly requiresNonStrictMode?: boolean;
  readonly description: string;
}

export type PatchField<T> =
  | { readonly op: 'omit' }
  | { readonly op: 'clear' }
  | { readonly op: 'set'; readonly value: T };

export interface DecodedToolPatch {
  readonly updateKind: 'tool_call' | 'tool_call_update';
  readonly toolCallId: string | null;
  readonly backgroundTaskId: PatchField<string>;
  readonly kind: PatchField<NativeWorkKind>;
  readonly blocking: PatchField<Blocking>;
  readonly state: PatchField<WorkState>;
  readonly stateReasonCode?: string;
  readonly outcome: PatchField<WorkOutcome>;
  readonly outcomeReasonCode?: string;
  readonly observedLabel: PatchField<string>;
  readonly title?: string;
  readonly toolKind?: string;
  readonly childSessionId?: string;
  readonly matchedRuleIds: readonly string[];
  readonly unknownFields: readonly string[];
  readonly isNonZeroExit?: boolean;
  readonly exitCode?: number;
  readonly outputSummary?: string;
}

export type DecodedWireFrame =
  | {
      readonly kind: 'tool_patch';
      readonly patch: DecodedToolPatch;
      readonly originSession?: string;
    }
  | {
      readonly kind: 'assistant_chunk';
      readonly text: string;
      readonly wakeEpochHint?: number;
      readonly originSession?: string;
      readonly unknownFields: readonly string[];
    }
  | {
      readonly kind: 'thought_chunk';
      readonly text: string;
      readonly originSession?: string;
    }
  | {
      readonly kind: 'usage_update';
      readonly used?: number;
      readonly size?: number;
      readonly originSession?: string;
    }
  | {
      readonly kind: 'metadata_update';
      readonly updateType:
        | 'session_info_update'
        | 'available_commands_update'
        | 'config_option_update'
        | 'plan';
      readonly originSession?: string;
    }
  | {
      readonly kind: 'server_request';
      readonly wireRequestId: RpcId;
      readonly rpcIdType: 'number' | 'string';
      readonly method: string;
      readonly originSession?: string;
      readonly childSessionId?: string;
      readonly toolCallId?: string;
      readonly isInteraction: boolean;
      readonly title?: string;
    }
  | {
      readonly kind: 'unknown_frame';
      readonly method?: string;
      readonly sessionUpdate?: string;
      readonly reasonCode: string;
      readonly originSession?: string;
    };

// ── Captured Prompt Scope & Cancel State ───────────────────────────────

export interface CapturedPromptRecord {
  readonly scopeKey: string;
  readonly ctx: PromptContext;
  readonly activityId: ActivityId;
  readonly settled: boolean;
  readonly settledAt?: number;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

export type CancelTargetType = 'runtime' | 'activity' | 'work' | 'agent' | 'workflow';

export type CancelOutcome =
  | 'requested'
  | 'confirmed_cancelled'
  | 'grace_expired_unknown'
  | 'transport_closed';

export interface CancelStateRecord {
  readonly target: { readonly type: CancelTargetType; readonly id: string };
  readonly requestedAt: number;
  readonly graceDeadlineAt: number;
  readonly outcome: CancelOutcome;
  readonly confirmedAt?: number;
  readonly reasonCode?: string;
}

// ── Diagnostics & Layer Attribution ────────────────────────────────────

export type ReactiveAttributionCode =
  | 'healthy_reactive_wake_observed'
  | 'healthy_single_turn'
  | 'reactive_not_observed'
  | 'observation_timeout_unknown'
  | 'transport_disconnected_while_active'
  | 'cancel_confirmed'
  | 'cancel_grace_expired_unknown'
  | 'upstream_early_prompt_response'
  | 'hm_stale_rpc_pollution_blocked'
  | 'hm_duplicate_terminal_patch_ignored'
  | 'hm_missing_tool_call_id'
  | 'hm_history_replay_isolated'
  | 'hm_generation_fenced'
  | 'hm_usage_only_no_reopen';

export interface RuntimeDiagnosticEntry {
  readonly at: number;
  readonly code: ReactiveAttributionCode;
  readonly layer: 'upstream' | 'adapter' | 'runtime' | 'transport';
  readonly message: string;
  readonly runtimeId: RuntimeId;
  readonly generation: BindingGeneration;
  readonly turnId?: string | null;
  readonly workId?: WorkId;
  readonly activityId?: ActivityId;
}

export interface ReactiveRunDiagnosis {
  readonly runtimeId: RuntimeId;
  readonly generation: BindingGeneration;
  readonly status: NativeRuntimeStatus;
  readonly finiteWorkCount: number;
  readonly activeBlockingWorkCount: number;
  readonly activeDaemonWorkCount: number;
  readonly unknownWorkCount: number;
  readonly earlyPromptResponsesObserved: number;
  readonly wakeSegmentsObserved: number;
  readonly reactiveNotObservedGaps: number;
  readonly staleRpcResponsesBlocked: number;
  readonly duplicateSettlementsPrevented: number;
  readonly cancelState: CancelStateRecord | null;
  readonly primaryAttribution: ReactiveAttributionCode;
  readonly diagnostics: readonly RuntimeDiagnosticEntry[];
}

export interface ReactiveRuntimeSnapshot {
  readonly binding: RuntimeBinding;
  readonly status: NativeRuntimeStatus;
  readonly retentionReasons: readonly string[];
  readonly activities: readonly Activity[];
  readonly work: readonly NativeWork[];
  readonly pendingRequestIds: readonly string[];
  readonly requests: readonly NativeRequestSummaryDto[];
  readonly heldTurnIds: readonly string[];
  readonly cancelState: CancelStateRecord | null;
  readonly activePromptScopes: readonly string[];
  readonly diagnosis: ReactiveRunDiagnosis;
}

export interface HeldTurnState {
  readonly turnId: string;
  readonly activityId: ActivityId;
  readonly promptScopeKey: string;
  readonly promptStopReason: string;
  readonly heldSince: number;
  readonly initialBlockingWorkIds: readonly WorkId[];
  readonly wakeObserved: boolean;
  readonly wakeSegmentCount: number;
  readonly lastEvidence?: Evidence;
}

export type EligibleOrDisconnectedSettlement = Extract<
  TurnSettlement,
  { readonly kind: 'eligible' | 'disconnected' }
>;

export function formatTypedRpcKey(rpcId: RpcId | null): string {
  if (rpcId === null) return 'null';
  return typeof rpcId === 'number' ? `n:${rpcId}` : `s:${rpcId}`;
}

export function buildPromptScopeKey(ctx: PromptContext): string {
  return `${ctx.binding.runtimeId}|${ctx.binding.generation}|${ctx.connectionId}|${ctx.requestOrdinal}|${formatTypedRpcKey(ctx.rpcId)}`;
}

export function buildSettlementKey(
  runtimeId: RuntimeId,
  generation: BindingGeneration,
  turnId: string,
): string {
  return `${runtimeId}::${generation}::${turnId}`;
}
