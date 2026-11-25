import {
  asWorkId,
  type ActivityId,
  type Blocking,
  type Evidence,
  type NativeAgentId,
  type NativeAlias,
  type NativeWork,
  type NativeWorkKind,
  type Observed,
  type WorkId,
  type WorkOutcome,
  type WorkState,
} from '@harnessmate/protocol';
import type { DecodedToolPatch } from './types.js';

export const TERMINAL_WORK_STATES: ReadonlySet<WorkState> = new Set([
  'finished',
  'failed',
  'cancelled',
]);

export const ACTIVE_WORK_STATES: ReadonlySet<WorkState> = new Set([
  'queued',
  'running',
  'waiting',
  'requires_action',
]);

export function isTerminalWorkState(state: WorkState): boolean {
  return TERMINAL_WORK_STATES.has(state);
}

export function isActiveWorkState(state: WorkState): boolean {
  return ACTIVE_WORK_STATES.has(state);
}

export interface TrackedWorkRecord {
  work: NativeWork;
  originTurnId: string | null;
  originSession?: string;
  toolCallId?: string;
  backgroundTaskId?: string;
  lastIngressOrdinal: number;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
}

export interface WorkPatchApplyResult {
  readonly work: NativeWork;
  readonly isNew: boolean;
  readonly changed: boolean;
  readonly duplicateTerminal: boolean;
  readonly transitionedToTerminal: boolean;
  readonly aliases: readonly { readonly targetEntityId: WorkId; readonly alias: NativeAlias }[];
}

/**
 * Per-ID NativeWork tracker with strict omitted-field preservation,
 * independent blocking vs detached-daemon sets, and bounded eviction.
 */
export class ReactiveWorkTracker {
  private readonly works = new Map<WorkId, TrackedWorkRecord>();
  private readonly toolCallIndex = new Map<string, WorkId>();
  private readonly taskIndex = new Map<string, WorkId>();
  private seq = 0;

  constructor(private maxTrackedWork: number) {}

  setMaxTrackedWork(maxTrackedWork: number): void {
    this.maxTrackedWork = Math.max(10, maxTrackedWork);
    this.evictIfOverLimit();
  }

  private aliasKey(originSession: string | undefined, rawId: string): string {
    return `${originSession ?? ''}\u0000${rawId}`;
  }

  findByToolCallId(toolCallId: string, originSession?: string): TrackedWorkRecord | null {
    const direct = this.toolCallIndex.get(this.aliasKey(originSession, toolCallId));
    if (direct) return this.works.get(direct) ?? null;
    // Fallback within the same generation if originSession was omitted on a later patch
    if (originSession !== undefined) {
      const unscoped = this.toolCallIndex.get(this.aliasKey(undefined, toolCallId));
      if (unscoped) return this.works.get(unscoped) ?? null;
    }
    for (const rec of this.works.values()) {
      if (rec.toolCallId === toolCallId) return rec;
    }
    return null;
  }

  findByTaskId(taskId: string, originSession?: string): TrackedWorkRecord | null {
    const direct = this.taskIndex.get(this.aliasKey(originSession, taskId));
    if (direct) return this.works.get(direct) ?? null;
    for (const rec of this.works.values()) {
      if (rec.backgroundTaskId === taskId) return rec;
    }
    return null;
  }

  getById(workId: WorkId): TrackedWorkRecord | null {
    return this.works.get(workId) ?? null;
  }

  listWorks(): NativeWork[] {
    return Array.from(this.works.values()).map((r) => r.work);
  }

  listRecords(): TrackedWorkRecord[] {
    return Array.from(this.works.values());
  }

  /**
   * Applies a per-ID tool patch:
   * - Omitted fields ALWAYS preserve previous values (prevents S06 status-only patch clobbering).
   * - Explicit `null` clears only known nullable fields (`observedLabel`).
   * - Duplicate terminal patches for an already-terminal work are idempotently ignored.
   */
  applyToolPatch(params: {
    readonly patch: DecodedToolPatch;
    readonly evidence: Evidence;
    readonly ingressOrdinal: number;
    readonly now: number;
    readonly originSession?: string;
    readonly originActivityId?: ActivityId;
    readonly originTurnId: string | null;
    readonly ownerAgentId?: NativeAgentId;
  }): WorkPatchApplyResult | null {
    const { patch, evidence, ingressOrdinal, now, originSession, originActivityId, originTurnId, ownerAgentId } =
      params;

    const toolCallId = patch.toolCallId;
    const bgTaskId = patch.backgroundTaskId.op === 'set' ? patch.backgroundTaskId.value : undefined;
    if (!toolCallId && !bgTaskId) {
      return null;
    }

    let existing =
      (toolCallId ? this.findByToolCallId(toolCallId, originSession) : null) ??
      (bgTaskId ? this.findByTaskId(bgTaskId, originSession) : null);

    const aliases: Array<{ targetEntityId: WorkId; alias: NativeAlias }> = [];

    if (!existing) {
      const workId = asWorkId(`wrk_${++this.seq}`);
      const kind: NativeWorkKind = patch.kind.op === 'set' ? patch.kind.value : 'unknown';
      const blocking: Blocking = patch.blocking.op === 'set' ? patch.blocking.value : 'unknown';
      const state: Observed<WorkState> =
        patch.state.op === 'set'
          ? patch.state.value === 'unknown'
            ? { kind: 'unknown', reasonCode: patch.stateReasonCode ?? 'wire_status_unknown' }
            : { kind: 'known', value: patch.state.value, evidence }
          : { kind: 'known', value: 'running', evidence };

      const outcome: Observed<WorkOutcome> | undefined =
        patch.outcome.op === 'set'
          ? { kind: 'known', value: patch.outcome.value, evidence }
          : patch.outcomeReasonCode
            ? { kind: 'unknown', reasonCode: patch.outcomeReasonCode }
            : undefined;

      const observedLabel =
        patch.observedLabel.op === 'set' ? patch.observedLabel.value : undefined;

      const work: NativeWork = {
        id: workId,
        kind,
        ...(originActivityId ? { originActivityId } : {}),
        ...(ownerAgentId ? { ownerAgentId } : {}),
        blocking,
        state,
        ...(outcome ? { outcome } : {}),
        ...(observedLabel !== undefined ? { observedLabel } : {}),
        revision: 1,
      };

      const record: TrackedWorkRecord = {
        work,
        originTurnId,
        originSession,
        toolCallId: toolCallId ?? undefined,
        backgroundTaskId: bgTaskId,
        lastIngressOrdinal: ingressOrdinal,
        createdAt: now,
        updatedAt: now,
        lastProgressAt: now,
      };
      this.works.set(workId, record);

      if (toolCallId) {
        this.toolCallIndex.set(this.aliasKey(originSession, toolCallId), workId);
        aliases.push({
          targetEntityId: workId,
          alias: {
            namespace: 'tool_call',
            ...(originSession ? { originSessionId: originSession } : {}),
            nativeValue: toolCallId,
            evidence,
          },
        });
      }
      if (bgTaskId) {
        this.taskIndex.set(this.aliasKey(originSession, bgTaskId), workId);
        aliases.push({
          targetEntityId: workId,
          alias: {
            namespace: 'task',
            ...(originSession ? { originSessionId: originSession } : {}),
            nativeValue: bgTaskId,
            evidence,
          },
        });
      }

      this.evictIfOverLimit();
      const startedTerminal = state.kind === 'known' && isTerminalWorkState(state.value);
      return {
        work,
        isNew: true,
        changed: true,
        duplicateTerminal: false,
        transitionedToTerminal: startedTerminal,
        aliases,
      };
    }

    // Existing record: check duplicate terminal patch
    const prevKnownState = existing.work.state.kind === 'known' ? existing.work.state.value : null;
    const prevWasTerminal = prevKnownState !== null && isTerminalWorkState(prevKnownState);
    const nextPatchState = patch.state.op === 'set' ? patch.state.value : null;
    if (prevWasTerminal && nextPatchState !== null && isTerminalWorkState(nextPatchState)) {
      // Idempotent duplicate terminal delivery: do not mutate revision or emit duplicate transition
      return {
        work: existing.work,
        isNew: false,
        changed: false,
        duplicateTerminal: true,
        transitionedToTerminal: false,
        aliases: [],
      };
    }

    let changed = false;
    let nextKind = existing.work.kind;
    if (patch.kind.op === 'set' && patch.kind.value !== 'unknown' && patch.kind.value !== nextKind) {
      nextKind = patch.kind.value;
      changed = true;
    }

    let nextBlocking = existing.work.blocking;
    if (
      patch.blocking.op === 'set' &&
      patch.blocking.value !== 'unknown' &&
      patch.blocking.value !== nextBlocking
    ) {
      nextBlocking = patch.blocking.value;
      changed = true;
    }

    let nextState = existing.work.state;
    if (patch.state.op === 'set') {
      const candidate: Observed<WorkState> =
        patch.state.value === 'unknown'
          ? { kind: 'unknown', reasonCode: patch.stateReasonCode ?? 'wire_status_unknown' }
          : { kind: 'known', value: patch.state.value, evidence };
      nextState = candidate;
      changed = true;
    }

    let nextOutcome = existing.work.outcome;
    if (patch.outcome.op === 'set') {
      nextOutcome = { kind: 'known', value: patch.outcome.value, evidence };
      changed = true;
    } else if (patch.outcomeReasonCode && !nextOutcome) {
      nextOutcome = { kind: 'unknown', reasonCode: patch.outcomeReasonCode };
      changed = true;
    }

    let nextLabel = existing.work.observedLabel;
    if (patch.observedLabel.op === 'set' && patch.observedLabel.value !== nextLabel) {
      nextLabel = patch.observedLabel.value;
      changed = true;
    } else if (patch.observedLabel.op === 'clear' && nextLabel !== undefined) {
      nextLabel = undefined;
      changed = true;
    }

    const nextOwnerAgentId = existing.work.ownerAgentId ?? ownerAgentId;
    if (nextOwnerAgentId !== existing.work.ownerAgentId) {
      changed = true;
    }

    if (toolCallId && !existing.toolCallId) {
      existing.toolCallId = toolCallId;
      this.toolCallIndex.set(this.aliasKey(originSession, toolCallId), existing.work.id);
      aliases.push({
        targetEntityId: existing.work.id,
        alias: {
          namespace: 'tool_call',
          ...(originSession ? { originSessionId: originSession } : {}),
          nativeValue: toolCallId,
          evidence,
        },
      });
    }
    if (bgTaskId && !existing.backgroundTaskId) {
      existing.backgroundTaskId = bgTaskId;
      this.taskIndex.set(this.aliasKey(originSession, bgTaskId), existing.work.id);
      aliases.push({
        targetEntityId: existing.work.id,
        alias: {
          namespace: 'task',
          ...(originSession ? { originSessionId: originSession } : {}),
          nativeValue: bgTaskId,
          evidence,
        },
      });
    }

    if (!changed) {
      existing.lastProgressAt = now;
      existing.lastIngressOrdinal = Math.max(existing.lastIngressOrdinal, ingressOrdinal);
      return {
        work: existing.work,
        isNew: false,
        changed: false,
        duplicateTerminal: false,
        transitionedToTerminal: false,
        aliases,
      };
    }

    const updatedWork: NativeWork = {
      id: existing.work.id,
      kind: nextKind,
      ...(existing.work.originActivityId ? { originActivityId: existing.work.originActivityId } : {}),
      ...(nextOwnerAgentId ? { ownerAgentId: nextOwnerAgentId } : {}),
      ...(existing.work.workflowId ? { workflowId: existing.work.workflowId } : {}),
      blocking: nextBlocking,
      state: nextState,
      ...(nextOutcome ? { outcome: nextOutcome } : {}),
      ...(nextLabel !== undefined ? { observedLabel: nextLabel } : {}),
      revision: existing.work.revision + 1,
    };

    existing.work = updatedWork;
    existing.updatedAt = now;
    existing.lastProgressAt = now;
    existing.lastIngressOrdinal = Math.max(existing.lastIngressOrdinal, ingressOrdinal);

    const nowTerminal = nextState.kind === 'known' && isTerminalWorkState(nextState.value);
    return {
      work: updatedWork,
      isNew: false,
      changed: true,
      duplicateTerminal: false,
      transitionedToTerminal: !prevWasTerminal && nowTerminal,
      aliases,
    };
  }

  /**
   * Direct upsert from an external `NativeObservation` (e.g., from NP-05/07/12 or recovery).
   */
  upsertWorkExternal(work: NativeWork, originTurnId: string | null, now: number): NativeWork {
    const existing = this.works.get(work.id);
    if (existing) {
      const merged: NativeWork = {
        ...work,
        revision: Math.max(work.revision, existing.work.revision + 1),
      };
      existing.work = merged;
      existing.updatedAt = now;
      existing.lastProgressAt = now;
      return merged;
    }
    this.works.set(work.id, {
      work,
      originTurnId,
      lastIngressOrdinal: 0,
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
    });
    this.evictIfOverLimit();
    return work;
  }

  /**
   * Returns active work IDs that are CONFIRMED BLOCKING for a specific turn (or any turn if turnId omitted).
   * Daemons (`blocking === 'detached'`) and schedules NEVER appear here.
   */
  listActiveBlockingWorkIds(turnId?: string): WorkId[] {
    const result: WorkId[] = [];
    for (const rec of this.works.values()) {
      if (rec.work.blocking !== 'confirmed_blocking') continue;
      if (turnId !== undefined && rec.originTurnId !== turnId) continue;
      if (rec.work.state.kind === 'known' && isActiveWorkState(rec.work.state.value)) {
        result.push(rec.work.id);
      }
    }
    return result;
  }

  /**
   * Returns active non-blocking work started during an activity (e.g. a wake segment's foreground read-only tool).
   */
  listActiveWorkIdsForActivity(activityId: ActivityId): WorkId[] {
    const result: WorkId[] = [];
    for (const rec of this.works.values()) {
      if (rec.work.originActivityId !== activityId) continue;
      if (rec.work.blocking === 'detached') continue;
      if (rec.work.state.kind === 'known' && isActiveWorkState(rec.work.state.value)) {
        result.push(rec.work.id);
      }
    }
    return result;
  }

  /**
   * Returns active detached daemons (never block user turn; tracked independently for observation lease).
   */
  listActiveDaemonWorkIds(): WorkId[] {
    const result: WorkId[] = [];
    for (const rec of this.works.values()) {
      if (rec.work.kind !== 'daemon') continue;
      if (rec.work.state.kind === 'known' && isActiveWorkState(rec.work.state.value)) {
        result.push(rec.work.id);
      }
    }
    return result;
  }

  /**
   * Computes independent retention lease reasons for warm-pool and runtime projection.
   */
  listWorkRetentionReasons(opts: { retainDetachedDaemons: boolean }): string[] {
    const reasons: string[] = [];
    for (const rec of this.works.values()) {
      if (rec.work.state.kind !== 'known' || !isActiveWorkState(rec.work.state.value)) continue;
      if (rec.work.blocking === 'confirmed_blocking') {
        reasons.push(`finite_work:${rec.work.id}`);
      } else if (rec.work.kind === 'daemon' && opts.retainDetachedDaemons) {
        reasons.push(`daemon_observe:${rec.work.id}`);
      }
    }
    return reasons;
  }

  /**
   * Marks all non-terminal works as `stale` (preserving last observed state) on transport close
   * or cancel grace expiry. NEVER fabricates `finished`, `succeeded`, or `cancelled`.
   */
  markNonTerminalAsStale(reasonCode: string, now: number, filterWorkId?: WorkId): NativeWork[] {
    const updated: NativeWork[] = [];
    for (const rec of this.works.values()) {
      if (filterWorkId && rec.work.id !== filterWorkId) continue;
      if (rec.work.state.kind === 'known' && isTerminalWorkState(rec.work.state.value)) continue;
      if (rec.work.state.kind === 'stale' && rec.work.state.reasonCode === reasonCode) continue;

      const nextState: Observed<WorkState> =
        rec.work.state.kind === 'known'
          ? {
              kind: 'stale',
              last: rec.work.state.value,
              evidence: rec.work.state.evidence,
              reasonCode,
            }
          : rec.work.state.kind === 'stale'
            ? {
                kind: 'stale',
                ...(rec.work.state.last !== undefined ? { last: rec.work.state.last } : {}),
                ...(rec.work.state.evidence ? { evidence: rec.work.state.evidence } : {}),
                reasonCode,
              }
            : {
                kind: 'unknown',
                reasonCode,
              };

      rec.work = {
        ...rec.work,
        state: nextState,
        revision: rec.work.revision + 1,
      };
      rec.updatedAt = now;
      updated.push(rec.work);
    }
    return updated;
  }

  /**
   * Marks timed-out active works as `unknown` (`observation_timeout`) without fabricating completion.
   */
  markActiveAsUnknownTimeout(reasonCode: string, now: number, turnId?: string): NativeWork[] {
    const updated: NativeWork[] = [];
    for (const rec of this.works.values()) {
      if (turnId !== undefined && rec.originTurnId !== turnId) continue;
      if (rec.work.state.kind !== 'known' || !isActiveWorkState(rec.work.state.value)) continue;
      if (rec.work.blocking !== 'confirmed_blocking') continue;

      rec.work = {
        ...rec.work,
        state: {
          kind: 'unknown',
          reasonCode,
        },
        revision: rec.work.revision + 1,
      };
      rec.updatedAt = now;
      updated.push(rec.work);
    }
    return updated;
  }

  private evictIfOverLimit(): void {
    if (this.works.size <= this.maxTrackedWork) return;
    const terminalSorted = Array.from(this.works.values())
      .filter((rec) => rec.work.state.kind === 'known' && isTerminalWorkState(rec.work.state.value))
      .sort((a, b) => a.updatedAt - b.updatedAt);

    for (const victim of terminalSorted) {
      if (this.works.size <= this.maxTrackedWork) break;
      this.works.delete(victim.work.id);
      if (victim.toolCallId) {
        this.toolCallIndex.delete(this.aliasKey(victim.originSession, victim.toolCallId));
      }
      if (victim.backgroundTaskId) {
        this.taskIndex.delete(this.aliasKey(victim.originSession, victim.backgroundTaskId));
      }
    }
  }
}
