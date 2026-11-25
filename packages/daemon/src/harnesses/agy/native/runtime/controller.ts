import { randomUUID } from 'node:crypto';
import {
  asActivityId,
  asNativeAgentId,
  sanitizeNativeWorkForPublic,
  toPublicEvidenceDto,
  type Activity,
  type ActivityId,
  type BindingGeneration,
  type Evidence,
  type NativeRequestReceiptState,
  type NativeRequestSummaryDto,
  type NativeRuntimeStatus,
  type NativeTimelineEntryDto,
  type NativeWork,
  type RpcId,
  type RuntimeBinding,
  type RuntimeId,
  type WorkId,
} from '@harnessmate/protocol';
import type {
  NativeIngress,
  NativeLifecyclePort,
  NativeObservation,
  NativeTimelineReaderPort,
  NativeTurnSettlementSink,
  PromptContext,
  TurnSettlement,
} from '../wiring/types.js';
import { decodeNativeIngressFrame } from './codec.js';
import { buildReactiveRunDiagnosis } from './diagnostics.js';
import {
  DEFAULT_REACTIVE_RUNTIME_CONFIG,
  DEFAULT_UNRESOLVED_CHILD_STUB,
  buildPromptScopeKey,
  buildSettlementKey,
  formatTypedRpcKey,
  type CancelStateRecord,
  type CancelTargetType,
  type CapturedPromptRecord,
  type EligibleOrDisconnectedSettlement,
  type HeldTurnState,
  type NativeRuntimePublisher,
  type ReactiveAttributionCode,
  type ReactiveChildIdentityStub,
  type ReactivePendingRequestStub,
  type ReactiveRunDiagnosis,
  type ReactiveRuntimeConfig,
  type ReactiveRuntimeSnapshot,
  type RuntimeDiagnosticEntry,
  type RuntimeTimerHandle,
  type RuntimeTimerScheduler,
  defaultRuntimeTimerScheduler,
} from './types.js';
import { ReactiveWorkTracker } from './work-tracker.js';

export interface AgyReactiveRuntimeControllerOptions {
  readonly config?: Partial<ReactiveRuntimeConfig>;
  readonly publisher?: NativeRuntimePublisher;
  readonly childIdentityStub?: ReactiveChildIdentityStub;
  readonly pendingRequestStub?: ReactivePendingRequestStub;
  readonly now?: () => number;
  readonly scheduler?: RuntimeTimerScheduler;
}

interface ActivityTimelineBuffer {
  revision: number;
  seq: number;
  entries: NativeTimelineEntryDto[];
}

interface GenerationState {
  binding: RuntimeBinding;
  status: NativeRuntimeStatus;
  runtimeRevision: number;
  workTracker: ReactiveWorkTracker;
  activities: Map<ActivityId, Activity>;
  activitySeq: number;
  lastActivityId: ActivityId | null;
  activeForegroundTurnId: string | null;
  activeForegroundActivityId: ActivityId | null;
  activeNativeActivityId: ActivityId | null;
  activeNativeWakeEpoch?: number;
  promptsByScope: Map<string, CapturedPromptRecord>;
  heldTurns: Map<string, HeldTurnState>;
  settledTurnKeys: Set<string>;
  cancelState: CancelStateRecord | null;
  requestsByApprovalId: Map<string, NativeRequestSummaryDto>;
  wirePendingReqKeys: Map<string, string>;
  connectionId?: string;
  timelines: Map<ActivityId, ActivityTimelineBuffer>;
  diagnostics: RuntimeDiagnosticEntry[];
  counters: {
    earlyPromptResponsesObserved: number;
    wakeSegmentsObserved: number;
    reactiveNotObservedGaps: number;
    staleRpcResponsesBlocked: number;
    duplicateSettlementsPrevented: number;
  };
  timers: {
    quiescenceByTurn: Map<string, RuntimeTimerHandle>;
    observationTimeoutByTurn: Map<string, RuntimeTimerHandle>;
    nativeActivityQuiescence: RuntimeTimerHandle | null;
    cancelGrace: RuntimeTimerHandle | null;
  };
}

function generationMapKey(runtimeId: RuntimeId, generation: BindingGeneration): string {
  return `${runtimeId}::${generation}`;
}

function isTimeoutError(message: string, code?: string): boolean {
  if (code && /timeout/i.test(code)) return true;
  return /timed?\s*out|etimedout/i.test(message);
}

/**
 * NP-04 Reactive Runtime & Background Keep-Alive Controller.
 *
 * Implements `NativeLifecyclePort` and `NativeTimelineReaderPort` against the frozen G1 contracts:
 * - Per-ID work patch merging (finite, daemon, schedule, subagent, unknown) with omitted-field preservation
 * - Independent blocking set vs detached daemon retention leases
 * - Early v1 prompt response hold with verifiable quiescence & observation-timeout -> unknown bounds
 * - Strict separation of late tool updates vs native wake segments (`turnId: null` native-only activities)
 * - Captured RPC scope preventing stop -> next turn stale response contamination
 * - Cancel grace tracking (target / waiting / confirmed vs grace_expired_unknown)
 * - Generation fencing, history_replay isolation, transport exit stale marking, warm-pool LRU checks, and config reload
 * - Single-settlement guarantee per `(runtimeId, generation, turnId)` via `NativeTurnSettlementSink`
 */
export class AgyReactiveRuntimeController
  implements NativeLifecyclePort, NativeTimelineReaderPort
{
  private config: ReactiveRuntimeConfig;
  private readonly publisher?: NativeRuntimePublisher;
  private readonly childIdentityStub: ReactiveChildIdentityStub;
  private readonly pendingRequestStub?: ReactivePendingRequestStub;
  private readonly nowFn: () => number;
  private readonly scheduler: RuntimeTimerScheduler;
  private settlementSink: NativeTurnSettlementSink | null = null;

  private readonly activeGenerationByRuntime = new Map<RuntimeId, BindingGeneration>();
  private readonly generations = new Map<string, GenerationState>();
  private readonly globalSettledTurnKeys = new Set<string>();

  constructor(opts: AgyReactiveRuntimeControllerOptions = {}) {
    this.config = Object.freeze({
      ...DEFAULT_REACTIVE_RUNTIME_CONFIG,
      ...opts.config,
    });
    this.publisher = opts.publisher;
    this.childIdentityStub = opts.childIdentityStub ?? DEFAULT_UNRESOLVED_CHILD_STUB;
    this.pendingRequestStub = opts.pendingRequestStub;
    this.nowFn = opts.now ?? (() => Date.now());
    this.scheduler = opts.scheduler ?? defaultRuntimeTimerScheduler;
  }

  // ── Configuration & Hot Reload ───────────────────────────────────────

  getConfig(): ReactiveRuntimeConfig {
    return this.config;
  }

  /**
   * Atomically reloads tunable runtime parameters (cancel grace, quiescence window,
   * observation timeout, strict mode, daemon eviction policy) without dropping active
   * work, held turns, or live retention leases.
   */
  reloadConfig(patch: Partial<ReactiveRuntimeConfig>): ReactiveRuntimeConfig {
    this.config = Object.freeze({
      ...this.config,
      ...patch,
    });
    for (const gen of this.generations.values()) {
      gen.workTracker.setMaxTrackedWork(this.config.maxTrackedWorkPerRuntime);
    }
    return this.config;
  }

  // ── NativeLifecyclePort Implementation ───────────────────────────────

  attachSettlementSink(sink: NativeTurnSettlementSink): void {
    this.settlementSink = sink;
  }

  onPromptStarted(ctx: PromptContext): void {
    const gen = this.getOrInitCurrentGeneration(ctx.binding, 'attached');
    if (!gen || gen.status === 'disconnected' || (gen.connectionId && gen.connectionId !== ctx.connectionId)) {
      this.recordStaleGenerationAttempt(ctx.binding, 'onPromptStarted', ctx.turnId);
      return;
    }

    const now = this.nowFn();
    const scopeKey = buildPromptScopeKey(ctx);

    let activityId: ActivityId;
    if (ctx.isSteering && gen.activeForegroundTurnId === ctx.turnId && gen.activeForegroundActivityId) {
      activityId = gen.activeForegroundActivityId;
    } else if (ctx.originActivityId && gen.activities.has(ctx.originActivityId)) {
      activityId = ctx.originActivityId;
    } else {
      activityId = this.allocateActivityId(gen);
    }

    const existingActivity = gen.activities.get(activityId);
    const activity: Activity = {
      id: activityId,
      turnId: ctx.turnId,
      origin: 'user_turn',
      ...(existingActivity?.priorActivityId ? { priorActivityId: existingActivity.priorActivityId } : {}),
      state: 'running',
      summary: ctx.isSteering ? '用户追加引导中 (Mid-turn Steering)' : '用户轮次运行中',
      evidence: {
        sourceKind: 'host_observation',
        freshness: 'host',
        observedAt: now,
        reasonCode: ctx.isSteering ? 'prompt_steering_started' : 'prompt_started',
      },
      updatedAt: now,
    };

    gen.activities.set(activityId, activity);
    gen.lastActivityId = activityId;
    gen.connectionId ??= ctx.connectionId;
    gen.status = 'attached';

    if (!ctx.isSteering) {
      gen.activeForegroundTurnId = ctx.turnId;
      gen.activeForegroundActivityId = activityId;
      // Starting a new user turn clears any previous cancel state for the runtime
      if (gen.cancelState && gen.cancelState.outcome !== 'requested') {
        gen.cancelState = null;
      }
    }

    gen.promptsByScope.set(scopeKey, {
      scopeKey,
      ctx,
      activityId,
      settled: false,
    });

    this.appendTimelineEntry(gen, activityId, {
      kind: 'status',
      actorKind: 'user',
      title: ctx.isSteering ? 'Mid-turn Steering' : 'User Turn Started',
      text: ctx.isSteering
        ? `Steer prompt dispatched (req #${ctx.requestOrdinal})`
        : `Prompt dispatched (req #${ctx.requestOrdinal})`,
      status: 'running',
      evidence: {
        kind: 'host_observation',
        observedAt: now,
        reasonCode: ctx.isSteering ? 'prompt_steering_started' : 'prompt_started',
      },
    });

    this.publishActivity(gen, activity, {
      mutationKey: `prompt_start:${ctx.connectionId}:${ctx.requestOrdinal}:${formatTypedRpcKey(ctx.rpcId)}`,
    });
    this.publishRuntimeStatus(gen, 'prompt_started');
  }

  onPromptSettled(
    ctx: PromptContext,
    result:
      | { ok: true; stopReason: string; isCurrentTurn: boolean }
      | {
          ok: false;
          message: string;
          code?: string;
          failureClass?: string;
          resetAt?: number | null;
          isCurrentTurn: boolean;
        },
  ): TurnSettlement {
    const gen = this.getCurrentGenerationIfMatches(ctx.binding);
    if (!gen || gen.status === 'disconnected' || (gen.connectionId && gen.connectionId !== ctx.connectionId)) {
      this.recordStaleGenerationAttempt(ctx.binding, 'onPromptSettled', ctx.turnId);
      return { kind: 'eligible', outcome: 'cancelled', stopReason: 'stale_generation' };
    }

    const now = this.nowFn();
    const scopeKey = buildPromptScopeKey(ctx);
    const promptRec = gen.promptsByScope.get(scopeKey);

    // Duplicate response for the same captured RPC scope -> idempotent no-op
    if (promptRec?.settled) {
      gen.counters.duplicateSettlementsPrevented += 1;
      return { kind: 'eligible', outcome: 'completed', stopReason: promptRec.stopReason ?? 'duplicate_ignored' };
    }

    if (promptRec) {
      gen.promptsByScope.set(scopeKey, {
        ...promptRec,
        settled: true,
        settledAt: now,
        ...(result.ok ? { stopReason: result.stopReason } : { errorMessage: result.message }),
      });
    }

    // Captured RPC scope guard: a stale response from a previously cancelled or superseded turn
    // MUST NEVER contaminate or settle the currently active turn!
    const isStaleScope =
      !result.isCurrentTurn ||
      (gen.activeForegroundTurnId !== null && gen.activeForegroundTurnId !== ctx.turnId && !gen.heldTurns.has(ctx.turnId));

    if (isStaleScope) {
      gen.counters.staleRpcResponsesBlocked += 1;
      this.recordDiagnostic(gen, {
        code: 'hm_stale_rpc_pollution_blocked',
        layer: 'runtime',
        message: `Blocked stale prompt response for turn ${ctx.turnId} (rpc=${formatTypedRpcKey(ctx.rpcId)}, req#${ctx.requestOrdinal}) while current turn is ${gen.activeForegroundTurnId ?? 'none'}`,
        turnId: ctx.turnId,
        activityId: promptRec?.activityId,
      });
      return {
        kind: 'eligible',
        outcome: 'cancelled',
        stopReason: 'stale_prompt_response_ignored',
      };
    }

    // If this was a steering RPC settling while the primary prompt RPC for the same turn is still in-flight,
    // keep the turn active without settling it early.
    if (ctx.isSteering) {
      const hasOtherInFlightPromptForTurn = Array.from(gen.promptsByScope.values()).some(
        (rec) => rec.ctx.turnId === ctx.turnId && !rec.settled,
      );
      if (hasOtherInFlightPromptForTurn) {
        return { kind: 'held', reasonIds: [`active_prompt:${ctx.turnId}`] };
      }
    }

    const activityId = promptRec?.activityId ?? gen.activeForegroundActivityId;

    // ── Failure branch (RPC error / 15min+ timeout / quota error) ──
    if (!result.ok) {
      const timedOut = isTimeoutError(result.message, result.code);
      if (gen.activeForegroundTurnId === ctx.turnId) {
        gen.activeForegroundTurnId = null;
        gen.activeForegroundActivityId = null;
      }

      if (timedOut) {
        const timedOutWorks = gen.workTracker.markActiveAsUnknownTimeout(
          'prompt_rpc_timeout',
          now,
          ctx.turnId,
        );
        for (const work of timedOutWorks) {
          this.publishWork(gen, work, ctx.turnId);
        }
        this.recordDiagnostic(gen, {
          code: 'observation_timeout_unknown',
          layer: 'transport',
          message: `Prompt RPC timed out for turn ${ctx.turnId}; marked ${timedOutWorks.length} active blocking work(s) unknown`,
          turnId: ctx.turnId,
          activityId: activityId ?? undefined,
        });
      }

      if (activityId) {
        const act = gen.activities.get(activityId);
        if (act) {
          const updatedAct: Activity = {
            ...act,
            state: timedOut ? 'unknown' : 'failed',
            summary: timedOut
              ? '等待响应超时，当前状态未确认'
              : `轮次失败：${result.message.slice(0, 200)}`,
            evidence: {
              sourceKind: 'host_observation',
              freshness: 'host',
              observedAt: now,
              reasonCode: timedOut ? 'prompt_rpc_timeout' : result.code ?? 'prompt_rpc_error',
            },
            updatedAt: now,
          };
          gen.activities.set(activityId, updatedAct);
          this.publishActivity(gen, updatedAct);
        }
      }

      this.markTurnSettledLocally(gen, ctx.turnId);
      this.publishRuntimeStatus(gen, timedOut ? 'prompt_rpc_timeout' : 'prompt_failed');

      return {
        kind: 'eligible',
        outcome: 'failed',
        message: result.message,
        ...(result.code ? { code: result.code } : {}),
        ...(result.failureClass ? { failureClass: result.failureClass } : {}),
        ...(result.resetAt !== undefined ? { resetAt: result.resetAt } : {}),
      };
    }

    // ── Cancelled stopReason branch ──
    if (result.stopReason === 'cancelled') {
      if (gen.activeForegroundTurnId === ctx.turnId) {
        gen.activeForegroundTurnId = null;
        gen.activeForegroundActivityId = null;
      }
      if (gen.cancelState?.target.type === 'runtime') {
        this.confirmCancelIfActive(gen, 'prompt_stop_reason_cancelled');
      }
      if (activityId) {
        const act = gen.activities.get(activityId);
        if (act) {
          const updatedAct: Activity = {
            ...act,
            state: 'cancelled',
            summary: '已收到原生取消确认',
            evidence: {
              sourceKind: 'live_protocol',
              freshness: 'live',
              observedAt: now,
            },
            updatedAt: now,
          };
          gen.activities.set(activityId, updatedAct);
          this.publishActivity(gen, updatedAct);
        }
      }
      this.markTurnSettledLocally(gen, ctx.turnId);
      this.publishRuntimeStatus(gen, 'prompt_cancelled');
      return { kind: 'eligible', outcome: 'cancelled', stopReason: 'cancelled' };
    }

    if (gen.cancelState?.outcome === 'requested' && gen.cancelState.target.type === 'runtime') {
      return { kind: 'held', reasonIds: ['native_cancel_pending'] };
    }

    // ── Normal/Early Prompt Response branch ──
    // Check if there are other still-in-flight prompts for this turn (e.g. steering RPC)
    const otherInFlightForTurn = Array.from(gen.promptsByScope.values()).some(
      (rec) => rec.ctx.turnId === ctx.turnId && !rec.settled,
    );
    if (otherInFlightForTurn) {
      return { kind: 'held', reasonIds: [`active_prompt:${ctx.turnId}`] };
    }

    // Check active CONFIRMED BLOCKING finite work and pending live requests for this turn!
    // Detached daemons & schedules NEVER block turn settlement.
    const blockingWorkIds = gen.workTracker.listActiveBlockingWorkIds(ctx.turnId);
    const pendingReqReasons = this.listActivePendingRequestReasons(gen);

    if (blockingWorkIds.length > 0 || pendingReqReasons.length > 0) {
      gen.counters.earlyPromptResponsesObserved += 1;
      this.recordDiagnostic(gen, {
        code: 'upstream_early_prompt_response',
        layer: 'upstream',
        message: `Prompt response (${result.stopReason}) arrived while ${blockingWorkIds.length} finite work(s) and ${pendingReqReasons.length} pending request(s) remain active; holding turn ${ctx.turnId}`,
        turnId: ctx.turnId,
        activityId: activityId ?? undefined,
      });

      const resolvedActivityId = activityId ?? this.allocateActivityId(gen);
      const heldState: HeldTurnState = {
        turnId: ctx.turnId,
        activityId: resolvedActivityId,
        promptScopeKey: scopeKey,
        promptStopReason: result.stopReason,
        heldSince: now,
        initialBlockingWorkIds: [...blockingWorkIds],
        wakeObserved: false,
        wakeSegmentCount: 0,
      };
      gen.heldTurns.set(ctx.turnId, heldState);

      if (gen.activeForegroundTurnId === ctx.turnId) {
        gen.activeForegroundTurnId = null;
        gen.activeForegroundActivityId = null;
      }

      const prevAct = gen.activities.get(resolvedActivityId);
      const nextActState = pendingReqReasons.length > 0 ? 'requires_action' : 'waiting_background';
      const updatedAct: Activity = {
        id: resolvedActivityId,
        turnId: ctx.turnId,
        origin: prevAct?.origin ?? 'user_turn',
        ...(prevAct?.priorActivityId ? { priorActivityId: prevAct.priorActivityId } : {}),
        ...(blockingWorkIds[0] ? { workId: blockingWorkIds[0] } : {}),
        state: nextActState,
        summary:
          pendingReqReasons.length > 0
            ? '等待用户处理原生权限或问答请求'
            : `等待 ${blockingWorkIds.length} 项有限后台任务完成`,
        evidence: {
          sourceKind: 'live_protocol',
          freshness: 'live',
          observedAt: now,
        },
        updatedAt: now,
      };
      gen.activities.set(resolvedActivityId, updatedAct);
      this.publishActivity(gen, updatedAct);
      this.publishRuntimeStatus(gen, 'turn_held_for_background');
      this.armObservationTimeout(gen, ctx.turnId);

      const reasonIds = [
        ...blockingWorkIds.map((id) => `finite_work:${id}`),
        ...pendingReqReasons,
      ];
      return { kind: 'held', reasonIds };
    }

    // No blocking work and no pending requests -> eligible for immediate single settlement
    if (gen.activeForegroundTurnId === ctx.turnId) {
      gen.activeForegroundTurnId = null;
      gen.activeForegroundActivityId = null;
    }

    if (activityId) {
      const act = gen.activities.get(activityId);
      if (act) {
        const updatedAct: Activity = {
          ...act,
          state: 'finished',
          summary: '用户轮次已结束',
          evidence: {
            sourceKind: 'live_protocol',
            freshness: 'live',
            observedAt: now,
          },
          updatedAt: now,
        };
        gen.activities.set(activityId, updatedAct);
        this.publishActivity(gen, updatedAct);
      }
    }

    this.markTurnSettledLocally(gen, ctx.turnId);
    this.publishRuntimeStatus(gen, 'prompt_completed');
    return {
      kind: 'eligible',
      outcome: 'completed',
      stopReason: result.stopReason,
    };
  }

  acceptFrame(envelope: NativeIngress): void {
    // Isolate history_replay frames: NEVER create live retention leases, wake activities, or turn holds
    if (envelope.channel === 'history_replay') {
      const gen = this.getCurrentGenerationIfMatches(envelope.binding);
      if (gen) {
        this.recordDiagnostic(gen, {
          code: 'hm_history_replay_isolated',
          layer: 'runtime',
          message: `Isolated history_replay ingress #${envelope.ingressOrdinal} without mutating live runtime state`,
        });
      }
      return;
    }

    const gen = this.getOrInitCurrentGeneration(envelope.binding, 'attached');
    if (!gen) {
      this.recordStaleGenerationAttempt(envelope.binding, 'acceptFrame', null);
      return;
    }

    if (gen.status === 'disconnected' || (gen.connectionId && gen.connectionId !== envelope.connectionId)) return;
    gen.connectionId = envelope.connectionId;
    const now = this.nowFn();
    gen.status = 'attached';

    const evidence: Evidence = {
      kind: 'live_protocol',
      connectionId: envelope.connectionId,
      ingressOrdinal: envelope.ingressOrdinal,
      wireVariant: 'agy-acp-v1',
      observedAt: now,
    };

    const decoded = decodeNativeIngressFrame(envelope, { strictMode: this.config.strictMode });

    switch (decoded.kind) {
      case 'usage_update': {
        // T05 invariant: usage_update NEVER opens a new activity or reopens a settled turn
        if (!gen.activeForegroundTurnId && gen.heldTurns.size === 0) {
          this.recordDiagnostic(gen, {
            code: 'hm_usage_only_no_reopen',
            layer: 'runtime',
            message: 'Observed idle usage_update; kept session quiescent without reopening turn or creating activity',
          });
        }
        return;
      }

      case 'metadata_update':
      case 'unknown_frame':
        return;

      case 'server_request': {
        this.handleLiveServerRequestFrame(gen, decoded, evidence, now);
        return;
      }

      case 'tool_patch': {
        this.handleLiveToolPatchFrame(gen, decoded.patch, decoded.originSession, evidence, envelope.ingressOrdinal, now);
        return;
      }

      case 'assistant_chunk': {
        this.handleLiveMessageChunkFrame(gen, 'assistant_text', decoded.text, decoded.wakeEpochHint, evidence, now);
        return;
      }

      case 'thought_chunk': {
        this.handleLiveMessageChunkFrame(gen, 'thinking', decoded.text, undefined, evidence, now);
        return;
      }
    }
  }

  acceptNativeObservation(observation: NativeObservation): void {
    const gen = this.getOrInitCurrentGeneration(observation.binding, 'attached');
    if (!gen) {
      this.recordStaleGenerationAttempt(observation.binding, `observation:${observation.kind}`, null);
      return;
    }

    const now = this.nowFn();
    switch (observation.kind) {
      case 'runtime_status': {
        gen.status = observation.status;
        this.publishRuntimeStatus(gen, observation.reasonCode ?? 'external_runtime_status');
        return;
      }

      case 'work_upsert': {
        const upserted = gen.workTracker.upsertWorkExternal(
          observation.work,
          observation.turnId ?? null,
          now,
        );
        this.publishWork(gen, upserted, observation.turnId ?? null, observation.mutationKey);
        this.reevaluateHeldTurns(gen, now);
        this.publishRuntimeStatus(gen, 'external_work_upsert');
        return;
      }

      case 'activity_upsert': {
        gen.activities.set(observation.activity.id, observation.activity);
        gen.lastActivityId = observation.activity.id;
        this.publishActivity(gen, observation.activity, {
          deltaSummary: observation.deltaSummary,
          timelinePageHint: observation.timelinePageHint,
          hmAnchorSeq: observation.hmAnchorSeq,
          mutationKey: observation.mutationKey,
        });
        return;
      }

      case 'request_changed': {
        const prev = gen.requestsByApprovalId.get(observation.approvalId);
        const summary: NativeRequestSummaryDto = {
          approvalId: observation.approvalId,
          runtimeId: observation.binding.runtimeId,
          generation: observation.binding.generation,
          ...(observation.targetAgentId ? { agentId: observation.targetAgentId } : {}),
          ...(observation.activityId ? { activityId: observation.activityId } : {}),
          targetLineage: observation.targetAgentId ? 'confirmed' : (prev?.targetLineage ?? 'unresolved'),
          kind: observation.kindName,
          allowedOptionIds: prev?.allowedOptionIds ?? [],
          ...(observation.receiptId ? { receiptId: observation.receiptId } : {}),
          receiptState: observation.receiptState,
          updatedAt: now,
        };
        gen.requestsByApprovalId.set(observation.approvalId, summary);

        if (observation.receiptState === 'pending' || observation.receiptState === 'claimed') {
          this.markActiveActivityRequiresAction(gen, observation.activityId, now);
        } else {
          // Clear synthetic wire pending marker if resolved
          if (gen.wirePendingReqKeys.size > 0 && this.listActivePendingRequestReasons(gen).length === 0) {
            // keep wire keys cleared when explicitly resolved via matching key
          }
          this.reevaluateHeldTurns(gen, now);
        }
        this.publishRuntimeStatus(gen, `request_${observation.receiptState}`);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Resolves an in-memory wire pending request marker (used by tests or contract stubs before NP-07 wiring).
   */
  resolveWirePendingRequest(
    binding: RuntimeBinding,
    wireRequestId: RpcId,
    receiptState: NativeRequestReceiptState,
    connectionId?: string,
  ): void {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen || (connectionId && gen.connectionId !== connectionId)) return;
    const wireKey = formatTypedRpcKey(wireRequestId);
    const key = gen.wirePendingReqKeys.get(wireKey);
    if (!key) return;
    gen.wirePendingReqKeys.delete(wireKey);
    const existing = gen.requestsByApprovalId.get(key);
    const now = this.nowFn();
    if (existing) {
      gen.requestsByApprovalId.set(key, {
        ...existing,
        receiptState,
        updatedAt: now,
      });
    }
    this.reevaluateHeldTurns(gen, now);
    this.reevaluateNativeActivityAfterRequestClear(gen, now);
    this.publishRuntimeStatus(gen, `wire_request_${receiptState}`);
  }

  private reevaluateNativeActivityAfterRequestClear(gen: GenerationState, now: number): void {
    if (!gen.activeNativeActivityId) return;
    if (this.listActivePendingRequestReasons(gen).length > 0) return;
    const act = gen.activities.get(gen.activeNativeActivityId);
    if (!act || act.state !== 'requires_action') return;
    const updated: Activity = {
      ...act,
      state: 'running',
      summary: '原生请求已响应，等待后续原生事件',
      updatedAt: now,
    };
    gen.activities.set(act.id, updated);
    this.publishActivity(gen, updated);
    this.armNativeActivityQuiescence(gen);
  }

  onCancelRequested(binding: RuntimeBinding, target?: { type: string; id: string }): void {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen) {
      this.recordStaleGenerationAttempt(binding, 'onCancelRequested', null);
      return;
    }

    const now = this.nowFn();
    const normalizedType: CancelTargetType =
      target?.type === 'activity' ||
      target?.type === 'work' ||
      target?.type === 'agent' ||
      target?.type === 'workflow'
        ? target.type
        : 'runtime';
    const targetId = target?.id ?? binding.runtimeId;

    if (gen.cancelState?.outcome === 'requested' &&
        gen.cancelState.target.type === normalizedType && gen.cancelState.target.id === targetId) return;
    gen.timers.cancelGrace?.cancel();
    gen.cancelState = {
      target: { type: normalizedType, id: targetId },
      requestedAt: now,
      graceDeadlineAt: now + this.config.cancelGraceMs,
      outcome: 'requested',
    };

    // Transition targeted / active activities to `cancelling`
    if (normalizedType === 'activity') {
      const act = gen.activities.get(asActivityId(targetId));
      if (act) {
        const cancelling: Activity = {
          ...act,
          state: 'cancelling',
          summary: '已发出原生取消信号，等待确认…',
          updatedAt: now,
        };
        gen.activities.set(act.id, cancelling);
        this.publishActivity(gen, cancelling);
      }
    } else if (normalizedType === 'runtime') {
      const targetActIds = new Set<ActivityId>();
      if (gen.activeForegroundActivityId) targetActIds.add(gen.activeForegroundActivityId);
      for (const held of gen.heldTurns.values()) targetActIds.add(held.activityId);
      if (gen.activeNativeActivityId) targetActIds.add(gen.activeNativeActivityId);

      for (const aid of targetActIds) {
        const act = gen.activities.get(aid);
        if (act && act.state !== 'finished' && act.state !== 'failed' && act.state !== 'cancelled') {
          const cancelling: Activity = {
            ...act,
            state: 'cancelling',
            summary: '已发出原生取消信号，等待确认…',
            updatedAt: now,
          };
          gen.activities.set(aid, cancelling);
          this.publishActivity(gen, cancelling);
        }
      }
    }

    this.publishRuntimeStatus(gen, 'cancel_requested');

    // Schedule bounded cancel grace window
    gen.timers.cancelGrace = this.scheduler.setTimeout(() => {
      this.handleCancelGraceExpired(binding);
    }, this.config.cancelGraceMs);
  }

  handleTransportClosed(binding: RuntimeBinding, connectionId: string, reason?: string): void {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen || gen.status === 'disconnected' || (gen.connectionId && gen.connectionId !== connectionId)) return;

    const now = this.nowFn();
    const closeReason = reason ?? 'transport_closed';
    this.clearAllTimers(gen);

    const hadActiveWorkOrTurns =
      gen.heldTurns.size > 0 ||
      gen.activeForegroundTurnId !== null ||
      gen.workTracker.listActiveBlockingWorkIds().length > 0 ||
      gen.workTracker.listActiveDaemonWorkIds().length > 0;

    gen.status = 'disconnected';
    gen.activeForegroundTurnId = null;
    gen.activeForegroundActivityId = null;
    gen.activeNativeActivityId = null;

    if (gen.cancelState && gen.cancelState.outcome === 'requested') {
      gen.cancelState = {
        ...gen.cancelState,
        outcome: 'transport_closed',
        reasonCode: closeReason,
      };
    }

    // Mark all pending requests as connection_lost (never replay old approvals on reconnect)
    gen.wirePendingReqKeys.clear();
    for (const [approvalId, req] of gen.requestsByApprovalId.entries()) {
      if (req.receiptState === 'pending') {
        gen.requestsByApprovalId.set(approvalId, {
          ...req,
          receiptState: 'connection_lost',
          updatedAt: now,
        });
      } else if (req.receiptState === 'claimed') {
        gen.requestsByApprovalId.set(approvalId, {
          ...req,
          receiptState: 'delivery_unknown',
          updatedAt: now,
        });
      }
    }

    // Process exit confirms observation ended — NEVER fabricate cancelled/finished for background works!
    const staledWorks = gen.workTracker.markNonTerminalAsStale(closeReason, now);
    const uncertainEntityIds: string[] = staledWorks.map((w) => w.id);
    for (const work of staledWorks) {
      this.publishWork(gen, work, null);
    }

    // Transition active activities to `unknown`
    for (const [aid, act] of gen.activities.entries()) {
      if (
        act.state === 'starting' ||
        act.state === 'running' ||
        act.state === 'waiting_background' ||
        act.state === 'requires_action' ||
        act.state === 'cancelling'
      ) {
        const updatedAct: Activity = {
          ...act,
          state: 'unknown',
          summary: `观测连接已断开 (${closeReason})，状态未确认`,
          evidence: {
            sourceKind: 'host_observation',
            freshness: 'host',
            observedAt: now,
            reasonCode: closeReason,
          },
          updatedAt: now,
        };
        gen.activities.set(aid, updatedAct);
        uncertainEntityIds.push(aid);
        this.publishActivity(gen, updatedAct);
      }
    }

    if (hadActiveWorkOrTurns) {
      this.recordDiagnostic(gen, {
        code: 'transport_disconnected_while_active',
        layer: 'transport',
        message: `Transport connection ${connectionId} closed (${closeReason}) with ${uncertainEntityIds.length} uncertain entity(s)`,
      });
    }

    // Settle all held turns ONCE as `disconnected`
    const heldSnapshot = Array.from(gen.heldTurns.values());
    for (const held of heldSnapshot) {
      this.settleTurnOnce(gen, held.turnId, {
        kind: 'disconnected',
        reason: closeReason,
      });
    }

    this.publishRuntimeStatus(gen, closeReason);
    this.publishRecoveryChanged(gen, {
      status: 'disconnected',
      invalidatedGenerations: [],
      uncertainEntityIds,
      reasonCode: closeReason,
    });
  }

  onProfileGenerationChanged(prevBinding: RuntimeBinding | null, nextBinding: RuntimeBinding): void {
    const now = this.nowFn();
    if (prevBinding) {
      const prevKey = generationMapKey(prevBinding.runtimeId, prevBinding.generation);
      const prevGen = this.generations.get(prevKey);
      if (prevGen) {
        this.clearAllTimers(prevGen);
        prevGen.status = 'disconnected';
        prevGen.wirePendingReqKeys.clear();
        prevGen.workTracker.markNonTerminalAsStale('generation_retired', now);
        prevGen.heldTurns.clear();
        prevGen.activeForegroundTurnId = null;
        prevGen.activeForegroundActivityId = null;
        prevGen.activeNativeActivityId = null;
      }
    }

    this.activeGenerationByRuntime.set(nextBinding.runtimeId, nextBinding.generation);
    const nextGen = this.createGenerationState(nextBinding, 'reconciling');
    this.generations.set(generationMapKey(nextBinding.runtimeId, nextBinding.generation), nextGen);

    this.publishRecoveryChanged(nextGen, {
      status: 'reconciling',
      invalidatedGenerations: prevBinding ? [prevBinding.generation] : [],
      uncertainEntityIds: [],
      reasonCode: 'generation_changed',
    });
  }

  onReconnect(binding: RuntimeBinding, mode: 'resume' | 'load' | 'fresh'): void {
    const gen = this.getOrInitCurrentGeneration(
      binding,
      mode === 'fresh' ? 'attached' : 'reconciling',
    );
    if (!gen) return;
    gen.status = mode === 'fresh' ? 'attached' : 'reconciling';
    this.publishRuntimeStatus(gen, `reconnect_${mode}`);
    if (mode !== 'fresh') {
      this.publishRecoveryChanged(gen, {
        status: 'reconciling',
        invalidatedGenerations: [],
        uncertainEntityIds: [],
        reasonCode: `reconnect_${mode}`,
      });
    }
  }

  listRetentionReasons(binding: RuntimeBinding): string[] {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen || gen.status === 'disconnected') return [];

    const reasons: string[] = [];
    if (gen.activeForegroundTurnId) {
      reasons.push(`active_prompt:${gen.activeForegroundTurnId}`);
    }
    for (const held of gen.heldTurns.values()) {
      reasons.push(`held_turn:${held.turnId}`);
    }
    if (gen.cancelState?.outcome === 'requested') {
      reasons.push(`cancel_grace:${gen.cancelState.target.id}`);
    }
    reasons.push(
      ...gen.workTracker.listWorkRetentionReasons({
        retainDetachedDaemons: this.config.retainWarmPoolForDetachedDaemons,
      }),
    );
    reasons.push(...this.listActivePendingRequestReasons(gen));

    return Array.from(new Set(reasons));
  }

  onWarmPoolEvictCheck(binding: RuntimeBinding): { allowEvict: boolean; reasons: string[] } {
    const reasons = this.listRetentionReasons(binding);
    return {
      allowEvict: reasons.length === 0,
      reasons,
    };
  }

  decideTurnSettlement(turnId: string, binding: RuntimeBinding): TurnSettlement {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen) {
      return { kind: 'disconnected', reason: 'stale_or_unknown_binding' };
    }
    if (gen.status === 'disconnected') {
      return { kind: 'disconnected', reason: 'transport_disconnected' };
    }

    const blockingWorkIds = gen.workTracker.listActiveBlockingWorkIds(turnId);
    const pendingReqReasons = this.listActivePendingRequestReasons(gen);
    const held = gen.heldTurns.get(turnId);
    const activeWakeTools = held ? gen.workTracker.listActiveWorkIdsForActivity(held.activityId) : [];

    const reasons = [
      ...blockingWorkIds.map((id) => `finite_work:${id}`),
      ...activeWakeTools
        .filter((id) => !blockingWorkIds.includes(id))
        .map((id) => `wake_work:${id}`),
      ...pendingReqReasons,
    ];

    if (reasons.length > 0) {
      return { kind: 'held', reasonIds: reasons };
    }
    if (gen.cancelState?.outcome === 'requested') {
      return { kind: 'held', reasonIds: [`cancel_grace:${gen.cancelState.target.id}`] };
    }
    if (held && gen.timers.quiescenceByTurn.has(turnId)) {
      return { kind: 'held', reasonIds: [`quiescence_window:${turnId}`] };
    }

    return {
      kind: 'eligible',
      outcome: gen.cancelState?.outcome === 'confirmed_cancelled' ? 'cancelled' : 'completed',
      stopReason: held?.wakeObserved ? 'reactive_wake_completed' : 'end_turn',
    };
  }

  // ── NativeTimelineReaderPort Implementation ──────────────────────────

  readTimeline(input: {
    readonly binding: RuntimeBinding;
    readonly scopeKind: 'activity' | 'agent';
    readonly scopeId: string;
    readonly pageToken?: string;
    readonly limit: number;
  }): {
    readonly revision: number;
    readonly items: readonly NativeTimelineEntryDto[];
    readonly nextPageToken: string | null;
    readonly hasMore: boolean;
    readonly sourceUnavailableReason?: string;
  } {
    const gen = this.getCurrentGenerationIfMatches(input.binding);
    if (!gen) {
      return {
        revision: 0,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'stale_or_unknown_binding',
      };
    }

    if (input.scopeKind !== 'activity') {
      return {
        revision: gen.runtimeRevision,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'agent_timeline_owned_by_np05',
      };
    }

    const buffer = gen.timelines.get(asActivityId(input.scopeId));
    if (!buffer) {
      return {
        revision: gen.runtimeRevision,
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const offset = input.pageToken ? Math.max(0, Number.parseInt(input.pageToken, 10) || 0) : 0;
    const limit = Math.max(1, Math.min(200, input.limit));
    const slice = buffer.entries.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < buffer.entries.length;

    return {
      revision: buffer.revision,
      items: slice,
      nextPageToken: hasMore ? String(nextOffset) : null,
      hasMore,
    };
  }

  // ── Inspection & Diagnostics API ─────────────────────────────────────

  getWireRequestActivity(binding: RuntimeBinding, connectionId: string, rpcId: RpcId): Activity | undefined {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen || gen.connectionId !== connectionId) return;
    const key = gen.wirePendingReqKeys.get(formatTypedRpcKey(rpcId));
    const activityId = key ? gen.requestsByApprovalId.get(key)?.activityId : undefined;
    return activityId ? gen.activities.get(activityId) : undefined;
  }

  getRuntimeSnapshot(binding: RuntimeBinding): ReactiveRuntimeSnapshot | null {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen) return null;
    const work = gen.workTracker.listWorks();
    const pendingRequestIds = this.listActivePendingRequestIds(gen);
    return {
      binding: gen.binding,
      status: gen.status,
      retentionReasons: this.listRetentionReasons(binding),
      activities: Array.from(gen.activities.values()),
      work,
      pendingRequestIds,
      requests: Array.from(gen.requestsByApprovalId.values()),
      heldTurnIds: Array.from(gen.heldTurns.keys()),
      cancelState: gen.cancelState,
      activePromptScopes: Array.from(gen.promptsByScope.values())
        .filter((p) => !p.settled)
        .map((p) => p.scopeKey),
      diagnosis: this.buildDiagnosis(gen),
    };
  }

  diagnoseRuntime(binding: RuntimeBinding): ReactiveRunDiagnosis | null {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen) return null;
    return this.buildDiagnosis(gen);
  }

  dispose(): void {
    for (const gen of this.generations.values()) {
      this.clearAllTimers(gen);
    }
    this.generations.clear();
    this.activeGenerationByRuntime.clear();
  }

  // ── Internal Frame Handlers ──────────────────────────────────────────

  private handleLiveToolPatchFrame(
    gen: GenerationState,
    patch: ReturnType<typeof decodeNativeIngressFrame> extends infer U
      ? U extends { kind: 'tool_patch'; patch: infer P }
        ? P
        : never
      : never,
    originSession: string | undefined,
    evidence: Evidence,
    ingressOrdinal: number,
    now: number,
  ): void {
    if (!patch.toolCallId && patch.backgroundTaskId.op !== 'set') {
      this.recordDiagnostic(gen, {
        code: 'hm_missing_tool_call_id',
        layer: 'adapter',
        message: `Ignored malformed ${patch.updateKind} frame missing toolCallId and backgroundTaskId`,
      });
      return;
    }

    const existingWork =
      (patch.toolCallId ? gen.workTracker.findByToolCallId(patch.toolCallId, originSession) : null) ??
      (patch.backgroundTaskId.op === 'set'
        ? gen.workTracker.findByTaskId(patch.backgroundTaskId.value, originSession)
        : null);

    // Determine ownership:
    // 1. Existing work -> preserve its original turn & activity attribution!
    //    A pure late `tool_call_update` after turn settlement updates ONLY the work item (never opens a new activity).
    // 2. New `tool_call`:
    //    a) Active foreground user turn -> attach to foreground activity/turn
    //    b) Held user turn -> native WAKE segment on that held turn!
    //    c) No active/held user turn -> open native-only activity (`turnId: null`) ONLY for real `tool_call`, NOT late `tool_call_update`!
    let targetTurnId: string | null = existingWork?.originTurnId ?? null;
    let targetActivityId: ActivityId | undefined = existingWork?.work.originActivityId;
    let openedWakeOnHeldTurn: HeldTurnState | null = null;

    if (!existingWork) {
      if (gen.activeForegroundTurnId && gen.activeForegroundActivityId) {
        targetTurnId = gen.activeForegroundTurnId;
        targetActivityId = gen.activeForegroundActivityId;
      } else if (gen.heldTurns.size > 0) {
        const held = this.getPrimaryHeldTurn(gen);
        if (held) {
          targetTurnId = held.turnId;
          targetActivityId = held.activityId;
          if (patch.updateKind === 'tool_call') {
            openedWakeOnHeldTurn = held;
          }
        }
      } else if (patch.updateKind === 'tool_call') {
        const nativeAct = this.ensureNativeOnlyActivity(gen, {
          reason: 'native_tool_call',
          summary: patch.title ? `原生工具调用：${patch.title}` : '原生唤醒工具调用',
          evidence,
          now,
        });
        targetTurnId = null;
        targetActivityId = nativeAct.id;
      }
    }

    const resolvedChild = this.childIdentityStub.resolveOwnerAgent({
      binding: gen.binding,
      originSession,
      childSessionId: patch.childSessionId,
      toolCallId: patch.toolCallId ?? undefined,
    });

    const applied = gen.workTracker.applyToolPatch({
      patch,
      evidence,
      ingressOrdinal,
      now,
      originSession,
      originActivityId: targetActivityId,
      originTurnId: targetTurnId,
      ownerAgentId: resolvedChild.lineage === 'confirmed' ? resolvedChild.agentId : undefined,
    });

    if (!applied) return;

    if (applied.duplicateTerminal) {
      this.recordDiagnostic(gen, {
        code: 'hm_duplicate_terminal_patch_ignored',
        layer: 'runtime',
        message: `Ignored duplicate terminal tool_call_update for ${applied.work.id}`,
        turnId: targetTurnId,
        workId: applied.work.id,
      });
      return;
    }

    if (openedWakeOnHeldTurn) {
      this.markHeldTurnWakeObserved(gen, openedWakeOnHeldTurn, evidence, now, patch.title);
    }

    if (applied.changed) {
      this.publishWork(gen, applied.work, targetTurnId, undefined, applied.aliases);
    }

    if (targetActivityId) {
      const statusLabel =
        applied.work.state.kind === 'known' ? applied.work.state.value : applied.work.state.kind;
      this.appendTimelineEntry(gen, targetActivityId, {
        kind: 'tool',
        actorKind: 'main',
        title: applied.work.observedLabel ?? patch.title ?? applied.work.id,
        text: patch.outputSummary ?? `Work ${applied.work.id} (${applied.work.kind}) -> ${statusLabel}`,
        status: applied.work.state.kind === 'known' ? applied.work.state.value : 'unknown',
        evidence,
      });
    }

    // If a cancel was requested targeting this work (or runtime) and the work confirmed `cancelled`
    if (
      applied.work.state.kind === 'known' &&
      applied.work.state.value === 'cancelled' &&
      gen.cancelState?.outcome === 'requested' &&
      ((gen.cancelState.target.type === 'runtime' && !gen.activeForegroundTurnId &&
        gen.workTracker.listActiveBlockingWorkIds().length === 0) ||
        (gen.cancelState.target.type === 'work' && gen.cancelState.target.id === applied.work.id))
    ) {
      this.confirmCancelIfActive(gen, `work_cancelled:${applied.work.id}`);
    }

    // Re-evaluate held turns & native-only activity quiescence
    this.reevaluateHeldTurns(gen, now);
    if (gen.activeNativeActivityId && targetActivityId === gen.activeNativeActivityId) {
      this.armNativeActivityQuiescence(gen);
    }
    this.publishRuntimeStatus(gen, applied.transitionedToTerminal ? 'work_terminal' : 'work_updated');
  }

  private handleLiveMessageChunkFrame(
    gen: GenerationState,
    entryKind: 'assistant_text' | 'thinking',
    text: string,
    wakeEpochHint: number | undefined,
    evidence: Evidence,
    now: number,
  ): void {
    if (!text) return;

    // 1. Active foreground user turn owns it
    if (gen.activeForegroundTurnId && gen.activeForegroundActivityId) {
      this.appendTimelineEntry(gen, gen.activeForegroundActivityId, {
        kind: entryKind,
        actorKind: 'main',
        text,
        deltaCoalesceKey: `${gen.activeForegroundActivityId}:${entryKind}`,
        evidence,
      });
      return;
    }

    // 2. Held user turn -> native wake segment on the same held user turn!
    if (gen.heldTurns.size > 0) {
      const held = this.getPrimaryHeldTurn(gen);
      if (held) {
        this.markHeldTurnWakeObserved(gen, held, evidence, now);
        this.appendTimelineEntry(gen, held.activityId, {
          kind: entryKind,
          actorKind: 'main',
          text,
          deltaCoalesceKey: `${held.activityId}:wake_${held.wakeSegmentCount}:${entryKind}`,
          evidence,
        });
        this.reevaluateHeldTurns(gen, now);
        return;
      }
    }

    // 3. No active or held user turn -> native-only activity (`turnId: null`)!
    const nativeAct = this.ensureNativeOnlyActivity(gen, {
      reason: 'native_continuation_message',
      summary: '原生唤醒续跑输出',
      wakeEpochHint,
      evidence,
      now,
    });
    this.appendTimelineEntry(gen, nativeAct.id, {
      kind: entryKind,
      actorKind: 'main',
      text,
      deltaCoalesceKey: `${nativeAct.id}:${entryKind}`,
      evidence,
    });
    this.armNativeActivityQuiescence(gen);
  }

  private handleLiveServerRequestFrame(
    gen: GenerationState,
    decoded: Extract<ReturnType<typeof decodeNativeIngressFrame>, { kind: 'server_request' }>,
    evidence: Evidence,
    now: number,
  ): void {
    const wireKey = formatTypedRpcKey(decoded.wireRequestId);
    if (gen.wirePendingReqKeys.has(wireKey)) return;
    const reqKey = `request_${randomUUID()}`;
    gen.wirePendingReqKeys.set(wireKey, reqKey);

    let targetActivityId: ActivityId;
    if (gen.activeForegroundActivityId) {
      targetActivityId = gen.activeForegroundActivityId;
    } else if (gen.heldTurns.size > 0) {
      const held = this.getPrimaryHeldTurn(gen)!;
      targetActivityId = held.activityId;
      this.markHeldTurnWakeObserved(gen, held, evidence, now, decoded.title);
      this.cancelQuiescenceTimer(gen, held.turnId);
    } else {
      const nativeAct = this.ensureNativeOnlyActivity(gen, {
        reason: 'out_of_turn_server_request',
        summary: decoded.title ? `原生请求：${decoded.title}` : '脱离轮次的原生权限请求',
        evidence,
        now,
      });
      targetActivityId = nativeAct.id;
      gen.timers.nativeActivityQuiescence?.cancel();
      gen.timers.nativeActivityQuiescence = null;
    }

    const resolvedChild = this.childIdentityStub.resolveOwnerAgent({
      binding: gen.binding,
      originSession: decoded.originSession,
      childSessionId: decoded.childSessionId,
      toolCallId: decoded.toolCallId,
    });

    const summary: NativeRequestSummaryDto = {
      approvalId: reqKey,
      runtimeId: gen.binding.runtimeId,
      generation: gen.binding.generation,
      ...(resolvedChild.lineage === 'confirmed' && resolvedChild.agentId
        ? { agentId: resolvedChild.agentId }
        : {}),
      activityId: targetActivityId,
      targetLineage: resolvedChild.lineage,
      kind: decoded.isInteraction ? 'question' : 'permission',
      allowedOptionIds: [],
      receiptState: 'pending',
      evidence: toPublicEvidenceDto(evidence, now),
      updatedAt: now,
    };
    gen.requestsByApprovalId.set(reqKey, summary);

    this.markActiveActivityRequiresAction(gen, targetActivityId, now);
    this.appendTimelineEntry(gen, targetActivityId, {
      kind: 'request',
      actorKind: resolvedChild.lineage === 'confirmed' ? 'child' : 'main',
      ...(resolvedChild.lineage === 'confirmed' && resolvedChild.agentId
        ? { actorId: resolvedChild.agentId }
        : {}),
      title: decoded.title ?? decoded.method,
      text: decoded.isInteraction ? '原生交互请求' : '原生权限请求',
      status: 'requires_action',
      evidence,
    });

    this.publishRuntimeStatus(gen, 'native_request_pending');
  }

  // ── Wake, Quiescence, Timeout & Single-Settlement Helpers ────────────

  private markHeldTurnWakeObserved(
    gen: GenerationState,
    held: HeldTurnState,
    evidence: Evidence,
    now: number,
    detail?: string,
  ): void {
    this.cancelQuiescenceTimer(gen, held.turnId);
    const updatedHeld: HeldTurnState = {
      ...held,
      wakeObserved: true,
      wakeSegmentCount: held.wakeObserved ? held.wakeSegmentCount : held.wakeSegmentCount + 1,
      lastEvidence: evidence,
    };
    gen.heldTurns.set(held.turnId, updatedHeld);

    if (!held.wakeObserved) {
      gen.counters.wakeSegmentsObserved += 1;
      this.recordDiagnostic(gen, {
        code: 'healthy_reactive_wake_observed',
        layer: 'runtime',
        message: `Observed native reactive wake on held turn ${held.turnId}${detail ? ` (${detail})` : ''}`,
        turnId: held.turnId,
        activityId: held.activityId,
      });
    }

    const act = gen.activities.get(held.activityId);
    if (act && act.state !== 'running') {
      const nextAct: Activity = {
        ...act,
        state: 'running',
        summary: detail ? `原生唤醒继续：${detail}` : '原生唤醒继续执行中',
        evidence: toPublicEvidenceDto(evidence, now),
        updatedAt: now,
      };
      gen.activities.set(held.activityId, nextAct);
      this.publishActivity(gen, nextAct);
    }

    // Re-arm observation timeout since live progress occurred
    this.armObservationTimeout(gen, held.turnId);
  }

  private ensureNativeOnlyActivity(
    gen: GenerationState,
    opts: {
      readonly reason: string;
      readonly summary: string;
      readonly wakeEpochHint?: number;
      readonly evidence: Evidence;
      readonly now: number;
    },
  ): Activity {
    const current = gen.activeNativeActivityId
      ? gen.activities.get(gen.activeNativeActivityId)
      : undefined;

    const shouldStartFresh =
      !current ||
      current.state === 'quiescent' ||
      current.state === 'finished' ||
      current.state === 'failed' ||
      current.state === 'cancelled' ||
      current.state === 'unknown' ||
      (opts.wakeEpochHint !== undefined &&
        gen.activeNativeWakeEpoch !== undefined &&
        opts.wakeEpochHint !== gen.activeNativeWakeEpoch);

    if (!shouldStartFresh && current) {
      return current;
    }

    if (current && current.state === 'running') {
      const quiesced: Activity = {
        ...current,
        state: 'quiescent',
        updatedAt: opts.now,
      };
      gen.activities.set(current.id, quiesced);
      this.publishActivity(gen, quiesced);
    }

    const newId = this.allocateActivityId(gen);
    const hasPrior = gen.lastActivityId !== null;
    const nextActivity: Activity = {
      id: newId,
      turnId: null,
      origin: hasPrior ? 'native_continuation' : 'native_task',
      ...(gen.lastActivityId ? { priorActivityId: gen.lastActivityId } : {}),
      state: 'running',
      summary: opts.summary,
      evidence: toPublicEvidenceDto(opts.evidence, opts.now),
      updatedAt: opts.now,
    };
    gen.activities.set(newId, nextActivity);
    gen.lastActivityId = newId;
    gen.activeNativeActivityId = newId;
    gen.activeNativeWakeEpoch = opts.wakeEpochHint;
    gen.counters.wakeSegmentsObserved += 1;

    this.recordDiagnostic(gen, {
      code: 'healthy_reactive_wake_observed',
      layer: 'runtime',
      message: `Opened native-only activity ${newId} (${nextActivity.origin}, reason=${opts.reason})`,
      turnId: null,
      activityId: newId,
    });

    this.publishActivity(gen, nextActivity);
    this.publishRuntimeStatus(gen, opts.reason);
    return nextActivity;
  }

  private reevaluateHeldTurns(gen: GenerationState, now: number): void {
    if (gen.status === 'disconnected') return;
    if (gen.cancelState?.outcome === 'requested' && gen.cancelState.target.type === 'runtime') return;

    for (const held of Array.from(gen.heldTurns.values())) {
      const blockingWorkIds = gen.workTracker.listActiveBlockingWorkIds(held.turnId);
      const activeWakeTools = gen.workTracker.listActiveWorkIdsForActivity(held.activityId);
      const pendingReqReasons = this.listActivePendingRequestReasons(gen);

      if (blockingWorkIds.length > 0 || activeWakeTools.length > 0 || pendingReqReasons.length > 0) {
        this.cancelQuiescenceTimer(gen, held.turnId);
        const act = gen.activities.get(held.activityId);
        if (act) {
          const desiredState =
            pendingReqReasons.length > 0
              ? 'requires_action'
              : held.wakeObserved || activeWakeTools.length > 0
                ? 'running'
                : 'waiting_background';
          if (act.state !== desiredState && act.state !== 'cancelling') {
            const updated: Activity = {
              ...act,
              state: desiredState,
              updatedAt: now,
            };
            gen.activities.set(act.id, updated);
            this.publishActivity(gen, updated);
          }
        }
        continue;
      }

      // All blocking work and wake tools have reached terminal state and no pending requests remain.
      // Arm verifiable quiescence boundary so immediate wake frames attach to this turn;
      // if quiescence expires, settle the held turn ONCE.
      this.armQuiescenceTimer(gen, held.turnId);
    }
  }

  private armQuiescenceTimer(gen: GenerationState, turnId: string): void {
    this.cancelQuiescenceTimer(gen, turnId);
    const binding = gen.binding;
    const handle = this.scheduler.setTimeout(() => {
      this.handleHeldTurnQuiescence(binding, turnId);
    }, this.config.quiescenceWindowMs);
    gen.timers.quiescenceByTurn.set(turnId, handle);
  }

  private cancelQuiescenceTimer(gen: GenerationState, turnId: string): void {
    const existing = gen.timers.quiescenceByTurn.get(turnId);
    if (existing) {
      existing.cancel();
      gen.timers.quiescenceByTurn.delete(turnId);
    }
  }

  private handleHeldTurnQuiescence(binding: RuntimeBinding, turnId: string): void {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen || gen.status === 'disconnected') return;
    if (gen.cancelState?.outcome === 'requested' && gen.cancelState.target.type === 'runtime') return;
    gen.timers.quiescenceByTurn.delete(turnId);

    const held = gen.heldTurns.get(turnId);
    if (!held) return;

    // Re-check invariants before settling
    if (
      gen.workTracker.listActiveBlockingWorkIds(turnId).length > 0 ||
      gen.workTracker.listActiveWorkIdsForActivity(held.activityId).length > 0 ||
      this.listActivePendingRequestReasons(gen).length > 0
    ) {
      return;
    }

    const now = this.nowFn();
    if (!held.wakeObserved) {
      // Explicitly preserve `reactive_not_observed` gap — never fabricate wake!
      gen.counters.reactiveNotObservedGaps += 1;
      this.recordDiagnostic(gen, {
        code: 'reactive_not_observed',
        layer: 'upstream',
        message: `Blocking finite work(s) for turn ${turnId} finished, but no native wake frame arrived within ${this.config.quiescenceWindowMs}ms quiescence window`,
        turnId,
        activityId: held.activityId,
      });
    }

    // Check if every initial blocking work ended in `failed` and no wake recovered it
    const initialWorks = held.initialBlockingWorkIds
      .map((id) => gen.workTracker.getById(id)?.work)
      .filter((w): w is NativeWork => Boolean(w));
    const allFailedWithoutWake =
      !held.wakeObserved &&
      initialWorks.length > 0 &&
      initialWorks.every((w) => w.state.kind === 'known' && w.state.value === 'failed');

    const act = gen.activities.get(held.activityId);
    if (act) {
      const updatedAct: Activity = {
        ...act,
        state: allFailedWithoutWake ? 'failed' : 'finished',
        summary: held.wakeObserved
          ? '原生唤醒已完成并达到静默边界'
          : allFailedWithoutWake
            ? '有限后台任务失败，未观察到原生唤醒'
            : '有限后台任务已结束（未观察到后续原生唤醒）',
        evidence: {
          sourceKind: held.wakeObserved ? 'live_protocol' : 'host_observation',
          freshness: held.wakeObserved ? 'live' : 'host',
          observedAt: now,
          ...(held.wakeObserved ? {} : { reasonCode: 'reactive_not_observed' }),
        },
        updatedAt: now,
      };
      gen.activities.set(act.id, updatedAct);
      this.publishActivity(gen, updatedAct);
    }

    this.settleTurnOnce(
      gen,
      turnId,
      allFailedWithoutWake
        ? {
            kind: 'eligible',
            outcome: 'failed',
            message: 'Finite background task failed and no native wake recovery was observed',
            code: 'finite_work_failed',
          }
        : {
            kind: 'eligible',
            outcome: 'completed',
            stopReason: held.wakeObserved ? 'reactive_wake_completed' : 'finite_work_finished_no_wake',
          },
    );
  }

  private armObservationTimeout(gen: GenerationState, turnId: string): void {
    const prev = gen.timers.observationTimeoutByTurn.get(turnId);
    if (prev) prev.cancel();
    const binding = gen.binding;
    const handle = this.scheduler.setTimeout(() => {
      this.handleObservationTimeout(binding, turnId);
    }, this.config.observationTimeoutMs);
    gen.timers.observationTimeoutByTurn.set(turnId, handle);
  }

  private handleObservationTimeout(binding: RuntimeBinding, turnId: string): void {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen || gen.status === 'disconnected') return;
    gen.timers.observationTimeoutByTurn.delete(turnId);

    const held = gen.heldTurns.get(turnId);
    if (!held) return;

    const now = this.nowFn();
    const timedOutWorks = gen.workTracker.markActiveAsUnknownTimeout(
      'observation_timeout',
      now,
      turnId,
    );
    for (const w of timedOutWorks) {
      this.publishWork(gen, w, turnId);
    }

    this.recordDiagnostic(gen, {
      code: 'observation_timeout_unknown',
      layer: 'upstream',
      message: `Observation timeout (${this.config.observationTimeoutMs}ms) reached for held turn ${turnId}; marked ${timedOutWorks.length} work(s) unknown without fabricating completion`,
      turnId,
      activityId: held.activityId,
    });

    const act = gen.activities.get(held.activityId);
    if (act) {
      const updatedAct: Activity = {
        ...act,
        state: 'unknown',
        summary: '观测超时，原生后台状态未确认',
        evidence: {
          sourceKind: 'host_observation',
          freshness: 'host',
          observedAt: now,
          reasonCode: 'observation_timeout',
        },
        updatedAt: now,
      };
      gen.activities.set(act.id, updatedAct);
      this.publishActivity(gen, updatedAct);
    }

    this.settleTurnOnce(gen, turnId, {
      kind: 'eligible',
      outcome: 'failed',
      message: 'Native background observation timed out; status remains unknown',
      code: 'observation_timeout',
    });
  }

  private armNativeActivityQuiescence(gen: GenerationState): void {
    gen.timers.nativeActivityQuiescence?.cancel();
    const binding = gen.binding;
    const actId = gen.activeNativeActivityId;
    if (!actId) return;
    gen.timers.nativeActivityQuiescence = this.scheduler.setTimeout(() => {
      const cur = this.getCurrentGenerationIfMatches(binding);
      if (!cur || cur.status === 'disconnected') return;
      cur.timers.nativeActivityQuiescence = null;
      if (cur.activeNativeActivityId !== actId) return;
      if (
        cur.workTracker.listActiveWorkIdsForActivity(actId).length > 0 ||
        this.listActivePendingRequestReasons(cur).length > 0
      ) {
        return;
      }
      const act = cur.activities.get(actId);
      if (act && act.state === 'running') {
        const now = this.nowFn();
        const quiesced: Activity = {
          ...act,
          state: 'quiescent',
          summary: '原生续跑已静默，可由后续原生事件再唤醒',
          updatedAt: now,
        };
        cur.activities.set(actId, quiesced);
        this.publishActivity(cur, quiesced);
        this.publishRuntimeStatus(cur, 'native_activity_quiescent');
      }
    }, this.config.nativeActivityQuiescenceMs);
  }

  private confirmCancelIfActive(gen: GenerationState, reasonCode: string): void {
    if (!gen.cancelState || gen.cancelState.outcome !== 'requested') return;
    gen.timers.cancelGrace?.cancel();
    gen.timers.cancelGrace = null;

    const now = this.nowFn();
    gen.cancelState = {
      ...gen.cancelState,
      outcome: 'confirmed_cancelled',
      confirmedAt: now,
      reasonCode,
    };

    this.recordDiagnostic(gen, {
      code: 'cancel_confirmed',
      layer: 'runtime',
      message: `Native cancel confirmed for ${gen.cancelState.target.type}:${gen.cancelState.target.id} (${reasonCode})`,
    });

    if (gen.cancelState.target.type === 'runtime') {
      for (const held of Array.from(gen.heldTurns.values())) {
        const act = gen.activities.get(held.activityId);
        if (act) {
          const cancelledAct: Activity = {
            ...act,
            state: 'cancelled',
            summary: '已收到原生取消确认',
            updatedAt: now,
          };
          gen.activities.set(act.id, cancelledAct);
          this.publishActivity(gen, cancelledAct);
        }
        this.settleTurnOnce(gen, held.turnId, {
          kind: 'eligible',
          outcome: 'cancelled',
          stopReason: 'cancelled',
        });
      }
    }

    this.publishRuntimeStatus(gen, 'cancel_confirmed');
  }

  private handleCancelGraceExpired(binding: RuntimeBinding): void {
    const gen = this.getCurrentGenerationIfMatches(binding);
    if (!gen || gen.status === 'disconnected') return;
    gen.timers.cancelGrace = null;
    if (!gen.cancelState || gen.cancelState.outcome !== 'requested') return;

    const now = this.nowFn();
    const target = gen.cancelState.target;
    gen.cancelState = {
      ...gen.cancelState,
      outcome: 'grace_expired_unknown',
      reasonCode: 'cancel_grace_expired',
    };

    const staled = gen.workTracker.markNonTerminalAsStale('cancel_grace_expired', now, (work) => {
      switch (target.type) {
        case 'runtime': return work.blocking !== 'detached';
        case 'work': return work.id === target.id;
        case 'activity': return work.originActivityId === target.id;
        case 'agent': return work.ownerAgentId === target.id;
        case 'workflow': return work.workflowId === target.id;
      }
    });
    for (const w of staled) {
      this.publishWork(gen, w, null);
    }

    this.recordDiagnostic(gen, {
      code: 'cancel_grace_expired_unknown',
      layer: 'upstream',
      message: `Cancel grace (${this.config.cancelGraceMs}ms) expired for ${target.type}:${target.id} without native confirmation; marked ${staled.length} active work(s) stale/unknown`,
    });

    // Mark cancelling activities as `unknown` (never fabricate `cancelled` without wire proof)
    for (const [aid, act] of gen.activities.entries()) {
      if (act.state === 'cancelling') {
        const updated: Activity = {
          ...act,
          state: 'unknown',
          summary: '取消宽限期已到，未收到原生终止确认（状态未知）',
          evidence: {
            sourceKind: 'host_observation',
            freshness: 'host',
            observedAt: now,
            reasonCode: 'cancel_grace_expired',
          },
          updatedAt: now,
        };
        gen.activities.set(aid, updated);
        this.publishActivity(gen, updated);
      }
    }

    // Settle held turns ONCE so host session doesn't hang forever
    if (target.type === 'runtime') {
      const turnIds = new Set(gen.heldTurns.keys());
      if (gen.activeForegroundTurnId) turnIds.add(gen.activeForegroundTurnId);
      gen.activeForegroundTurnId = null;
      gen.activeForegroundActivityId = null;
      gen.activeNativeActivityId = null;
      for (const turnId of turnIds) {
        this.settleTurnOnce(gen, turnId, {
          kind: 'eligible',
          outcome: 'cancelled',
          stopReason: 'cancel_grace_expired',
        });
      }
    }

    this.publishRuntimeStatus(gen, 'cancel_grace_expired');
  }

  /**
   * Single-settlement choke point enforcing at-most-once settlement per `(runtimeId, generation, turnId)`.
   */
  private settleTurnOnce(
    gen: GenerationState,
    turnId: string,
    settlement: EligibleOrDisconnectedSettlement,
  ): { readonly settled: boolean; readonly reason?: string } {
    const key = buildSettlementKey(gen.binding.runtimeId, gen.binding.generation, turnId);
    if (gen.settledTurnKeys.has(key) || this.globalSettledTurnKeys.has(key)) {
      gen.counters.duplicateSettlementsPrevented += 1;
      return { settled: false, reason: 'already_settled' };
    }

    if (this.activeGenerationByRuntime.get(gen.binding.runtimeId) !== gen.binding.generation) {
      return { settled: false, reason: 'stale_generation' };
    }

    gen.settledTurnKeys.add(key);
    this.globalSettledTurnKeys.add(key);
    gen.heldTurns.delete(turnId);
    this.cancelQuiescenceTimer(gen, turnId);
    const obsTimer = gen.timers.observationTimeoutByTurn.get(turnId);
    if (obsTimer) {
      obsTimer.cancel();
      gen.timers.observationTimeoutByTurn.delete(turnId);
    }

    this.publishRuntimeStatus(gen, 'turn_settled');

    if (!this.settlementSink) {
      return { settled: true, reason: 'no_sink_attached' };
    }

    try {
      return this.settlementSink.settleTurn({
        binding: gen.binding,
        turnId,
        settlement,
      });
    } catch {
      return { settled: false, reason: 'sink_error' };
    }
  }

  private markTurnSettledLocally(gen: GenerationState, turnId: string): void {
    const key = buildSettlementKey(gen.binding.runtimeId, gen.binding.generation, turnId);
    gen.settledTurnKeys.add(key);
    this.globalSettledTurnKeys.add(key);
    gen.heldTurns.delete(turnId);
    this.cancelQuiescenceTimer(gen, turnId);
    const obsTimer = gen.timers.observationTimeoutByTurn.get(turnId);
    if (obsTimer) {
      obsTimer.cancel();
      gen.timers.observationTimeoutByTurn.delete(turnId);
    }
  }

  // ── Helper Utilities ─────────────────────────────────────────────────

  private getOrInitCurrentGeneration(
    binding: RuntimeBinding,
    initialStatus: NativeRuntimeStatus,
  ): GenerationState | null {
    const activeGen = this.activeGenerationByRuntime.get(binding.runtimeId);
    if (activeGen && activeGen !== binding.generation) {
      return null;
    }
    if (!activeGen) {
      this.activeGenerationByRuntime.set(binding.runtimeId, binding.generation);
    }
    const key = generationMapKey(binding.runtimeId, binding.generation);
    let state = this.generations.get(key);
    if (!state) {
      state = this.createGenerationState(binding, initialStatus);
      this.generations.set(key, state);
    }
    return state;
  }

  private getCurrentGenerationIfMatches(binding: RuntimeBinding): GenerationState | null {
    const activeGen = this.activeGenerationByRuntime.get(binding.runtimeId);
    if (activeGen !== binding.generation) return null;
    return this.generations.get(generationMapKey(binding.runtimeId, binding.generation)) ?? null;
  }

  private createGenerationState(
    binding: RuntimeBinding,
    status: NativeRuntimeStatus,
  ): GenerationState {
    return {
      binding,
      status,
      runtimeRevision: 0,
      workTracker: new ReactiveWorkTracker(this.config.maxTrackedWorkPerRuntime),
      activities: new Map(),
      activitySeq: 0,
      lastActivityId: null,
      activeForegroundTurnId: null,
      activeForegroundActivityId: null,
      activeNativeActivityId: null,
      promptsByScope: new Map(),
      heldTurns: new Map(),
      settledTurnKeys: new Set(),
      cancelState: null,
      requestsByApprovalId: new Map(),
      wirePendingReqKeys: new Map(),
      timelines: new Map(),
      diagnostics: [],
      counters: {
        earlyPromptResponsesObserved: 0,
        wakeSegmentsObserved: 0,
        reactiveNotObservedGaps: 0,
        staleRpcResponsesBlocked: 0,
        duplicateSettlementsPrevented: 0,
      },
      timers: {
        quiescenceByTurn: new Map(),
        observationTimeoutByTurn: new Map(),
        nativeActivityQuiescence: null,
        cancelGrace: null,
      },
    };
  }

  private clearAllTimers(gen: GenerationState): void {
    for (const h of gen.timers.quiescenceByTurn.values()) h.cancel();
    gen.timers.quiescenceByTurn.clear();
    for (const h of gen.timers.observationTimeoutByTurn.values()) h.cancel();
    gen.timers.observationTimeoutByTurn.clear();
    gen.timers.nativeActivityQuiescence?.cancel();
    gen.timers.nativeActivityQuiescence = null;
    gen.timers.cancelGrace?.cancel();
    gen.timers.cancelGrace = null;
  }

  private allocateActivityId(gen: GenerationState): ActivityId {
    return asActivityId(`act_${gen.binding.generation}_${++gen.activitySeq}`);
  }

  private getPrimaryHeldTurn(gen: GenerationState): HeldTurnState | null {
    for (const held of gen.heldTurns.values()) {
      return held;
    }
    return null;
  }

  private listActivePendingRequestIds(gen: GenerationState): string[] {
    const ids = new Set<string>();
    for (const key of gen.wirePendingReqKeys.values()) {
      ids.add(key);
    }
    for (const req of gen.requestsByApprovalId.values()) {
      if (req.receiptState === 'pending' || req.receiptState === 'claimed') {
        ids.add(req.approvalId);
      }
    }
    if (this.pendingRequestStub) {
      for (const id of this.pendingRequestStub.listActivePendingRequestIds(gen.binding)) {
        ids.add(id);
      }
    }
    return Array.from(ids);
  }

  private listActivePendingRequestReasons(gen: GenerationState): string[] {
    return this.listActivePendingRequestIds(gen).map((id) => `pending_request:${id}`);
  }

  private markActiveActivityRequiresAction(
    gen: GenerationState,
    explicitActivityId: ActivityId | undefined,
    now: number,
  ): void {
    const targetId =
      explicitActivityId ??
      gen.activeForegroundActivityId ??
      this.getPrimaryHeldTurn(gen)?.activityId ??
      gen.activeNativeActivityId;
    if (!targetId) return;
    const act = gen.activities.get(targetId);
    if (!act || act.state === 'requires_action') return;
    const updated: Activity = {
      ...act,
      state: 'requires_action',
      summary: '等待用户处理原生权限或问答请求',
      updatedAt: now,
    };
    gen.activities.set(targetId, updated);
    this.publishActivity(gen, updated);
  }

  private appendTimelineEntry(
    gen: GenerationState,
    activityId: ActivityId,
    input: {
      readonly kind: NativeTimelineEntryDto['kind'];
      readonly actorKind: NativeTimelineEntryDto['actorKind'];
      readonly actorId?: string;
      readonly title?: string;
      readonly text?: string;
      readonly status?: NativeTimelineEntryDto['status'];
      readonly deltaCoalesceKey?: string;
      readonly evidence: Evidence;
    },
  ): void {
    let buffer = gen.timelines.get(activityId);
    if (!buffer) {
      buffer = { revision: 0, seq: 0, entries: [] };
      gen.timelines.set(activityId, buffer);
    }
    const now = this.nowFn();
    const seq = ++buffer.seq;
    buffer.revision += 1;
    const entry: NativeTimelineEntryDto = {
      entryId: `tl_${activityId}_${seq}`,
      seq,
      timestamp: now,
      kind: input.kind,
      actorKind: input.actorKind,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.title ? { title: input.title.slice(0, 240) } : {}),
      ...(input.text ? { text: input.text.slice(0, 8192) } : {}),
      ...(input.status ? { status: input.status } : {}),
      truncated: Boolean(input.text && input.text.length > 8192),
      ...(input.deltaCoalesceKey ? { deltaCoalesceKey: input.deltaCoalesceKey } : {}),
      evidence: toPublicEvidenceDto(input.evidence, now),
    };
    buffer.entries.push(entry);
    if (buffer.entries.length > this.config.maxTimelineEntriesPerActivity) {
      buffer.entries.splice(0, buffer.entries.length - this.config.maxTimelineEntriesPerActivity);
    }
  }

  private recordDiagnostic(
    gen: GenerationState,
    entry: {
      readonly code: ReactiveAttributionCode;
      readonly layer: RuntimeDiagnosticEntry['layer'];
      readonly message: string;
      readonly turnId?: string | null;
      readonly workId?: WorkId;
      readonly activityId?: ActivityId;
    },
  ): void {
    gen.diagnostics.push({
      at: this.nowFn(),
      code: entry.code,
      layer: entry.layer,
      message: entry.message,
      runtimeId: gen.binding.runtimeId,
      generation: gen.binding.generation,
      ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
      ...(entry.workId ? { workId: entry.workId } : {}),
      ...(entry.activityId ? { activityId: entry.activityId } : {}),
    });
    if (gen.diagnostics.length > 200) {
      gen.diagnostics.splice(0, gen.diagnostics.length - 200);
    }
  }

  private recordStaleGenerationAttempt(
    binding: RuntimeBinding,
    op: string,
    turnId: string | null,
  ): void {
    const activeGen = this.activeGenerationByRuntime.get(binding.runtimeId);
    if (!activeGen) return;
    const current = this.generations.get(generationMapKey(binding.runtimeId, activeGen));
    if (!current) return;
    this.recordDiagnostic(current, {
      code: 'hm_generation_fenced',
      layer: 'runtime',
      message: `Fenced stale-generation ${op} from ${binding.generation} (current=${activeGen})`,
      turnId,
    });
  }

  private buildDiagnosis(gen: GenerationState): ReactiveRunDiagnosis {
    return buildReactiveRunDiagnosis({
      binding: gen.binding,
      status: gen.status,
      work: gen.workTracker.listWorks(),
      cancelState: gen.cancelState,
      counters: gen.counters,
      diagnostics: gen.diagnostics,
    });
  }

  // ── Safe Atomic Publishing via NP-02 Registry Bridge ─────────────────

  private publishRuntimeStatus(gen: GenerationState, reasonCode?: string): void {
    if (!this.publisher) return;
    const reasons = this.listRetentionReasons(gen.binding);
    gen.runtimeRevision += 1;
    try {
      this.publisher.commitAndPublish(
        gen.binding,
        {
          status: gen.status,
          retentionReasons: reasons,
        },
        {
          type: 'native.runtime.changed',
          turnId: gen.activeForegroundTurnId ?? this.getPrimaryHeldTurn(gen)?.turnId ?? null,
          payload: {
            status: gen.status,
            retentionReasons: reasons,
            revision: gen.runtimeRevision,
            ...(reasonCode ? { reasonCode } : {}),
          },
          createdAt: this.nowFn(),
        },
      );
    } catch {
      // Isolate persistence/stale-binding errors from transport callback loop
    }
  }

  private publishActivity(
    gen: GenerationState,
    activity: Activity,
    opts?: {
      deltaSummary?: string;
      timelinePageHint?: string;
      hmAnchorSeq?: number;
      mutationKey?: string;
    },
  ): void {
    if (!this.publisher) return;
    try {
      this.publisher.commitAndPublish(
        gen.binding,
        {
          activities: [activity],
          status: gen.status,
          retentionReasons: this.listRetentionReasons(gen.binding),
        },
        {
          type: 'native.activity.changed',
          turnId: activity.turnId,
          ...(opts?.hmAnchorSeq !== undefined ? { hmAnchorSeq: opts.hmAnchorSeq } : {}),
          ...(opts?.mutationKey ? { mutationKey: opts.mutationKey } : {}),
          payload: {
            activity,
            ...(opts?.deltaSummary ? { deltaSummary: opts.deltaSummary } : {}),
            ...(opts?.timelinePageHint ? { timelinePageHint: opts.timelinePageHint } : {}),
          },
          createdAt: this.nowFn(),
        },
      );
    } catch {
      // Isolate persistence errors
    }
  }

  private publishWork(
    gen: GenerationState,
    work: NativeWork,
    turnId: string | null,
    mutationKey?: string,
    aliases?: readonly {
      readonly targetEntityId: WorkId;
      readonly alias: import('@harnessmate/protocol').NativeAlias;
    }[],
  ): void {
    if (!this.publisher) return;
    const now = this.nowFn();
    try {
      this.publisher.commitAndPublish(
        gen.binding,
        {
          work: [work],
          ...(aliases && aliases.length > 0
            ? {
                aliases: aliases.map((a) => ({
                  targetEntityKind: 'work' as const,
                  targetEntityId: a.targetEntityId,
                  alias: a.alias,
                })),
              }
            : {}),
          retentionReasons: this.listRetentionReasons(gen.binding),
        },
        {
          type: 'native.work.changed',
          turnId,
          ...(mutationKey ? { mutationKey } : {}),
          payload: {
            work: sanitizeNativeWorkForPublic(work, now),
          },
          createdAt: now,
        },
      );
    } catch {
      // Isolate persistence errors
    }
  }

  private publishRecoveryChanged(
    gen: GenerationState,
    payload: {
      readonly status: NativeRuntimeStatus;
      readonly invalidatedGenerations: readonly BindingGeneration[];
      readonly uncertainEntityIds: readonly string[];
      readonly reasonCode: string;
    },
  ): void {
    if (!this.publisher) return;
    try {
      this.publisher.commitAndPublish(
        gen.binding,
        {
          status: payload.status,
          retentionReasons: this.listRetentionReasons(gen.binding),
        },
        {
          type: 'native.recovery.changed',
          turnId: null,
          payload: {
            status: payload.status,
            invalidatedGenerations: [...payload.invalidatedGenerations],
            uncertainEntityIds: [...payload.uncertainEntityIds],
            reasonCode: payload.reasonCode,
          },
          createdAt: this.nowFn(),
        },
      );
    } catch {
      // Isolate persistence errors
    }
  }
}

export function createReactiveRuntimeController(
  opts?: AgyReactiveRuntimeControllerOptions,
): AgyReactiveRuntimeController {
  return new AgyReactiveRuntimeController(opts);
}

/**
 * Helper to create a confirmed child stub for contract testing before NP-05 integration.
 */
export function createStaticChildIdentityStub(
  sessionToAgentId: Readonly<Record<string, string>>,
): ReactiveChildIdentityStub {
  return {
    resolveOwnerAgent({ childSessionId, originSession }) {
      const matched =
        (childSessionId ? sessionToAgentId[childSessionId] : undefined) ??
        (originSession ? sessionToAgentId[originSession] : undefined);
      if (matched) {
        return { agentId: asNativeAgentId(matched), lineage: 'confirmed' };
      }
      return { lineage: 'unresolved' };
    },
  };
}
