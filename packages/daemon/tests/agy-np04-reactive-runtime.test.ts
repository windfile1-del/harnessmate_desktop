import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asBindingGeneration,
  asRuntimeId,
  type NativeCanonicalEvent,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { AgyAdapter } from '../src/harnesses/agy/agy-driver.js';
import { DEFAULT_AGY_APP_DATA_DIR_NAME } from '../src/harnesses/agy/agy-launch-context.js';
import {
  AGY_REACTIVE_CODEC_RULES,
  AgyReactiveRuntimeController,
  createReactiveRuntimeController,
  createStaticChildIdentityStub,
  decodeNativeIngressFrame,
  type NativeRuntimePublisher,
  type RuntimeTimerHandle,
  type RuntimeTimerScheduler,
} from '../src/harnesses/agy/native/runtime/index.js';
import type {
  NativeTurnSettlementSink,
  PromptContext,
  TurnSettlement,
} from '../src/harnesses/agy/native/wiring/types.js';
import { createDaemon } from '../src/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NP01_FIXTURES_DIR = path.join(__dirname, 'fixtures', 'agy-np');
const AGY_1514_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'agy-1.5.14', 'session-full.ndjson');

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop();
    await d?.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

/**
 * Deterministic virtual clock & timer scheduler so 15min+ timeouts, cancel grace windows,
 * and quiescence boundaries execute deterministically in milliseconds.
 */
class VirtualClockScheduler implements RuntimeTimerScheduler {
  nowMs = 1_700_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { fireAt: number; cb: () => void }>();

  now = (): number => this.nowMs;

  setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { fireAt: this.nowMs + Math.max(0, delayMs), cb: callback });
    return {
      cancel: () => {
        this.timers.delete(id);
      },
    };
  }

  advanceBy(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestAt = Infinity;
      for (const [id, entry] of this.timers.entries()) {
        if (entry.fireAt <= target && entry.fireAt < earliestAt) {
          earliestAt = entry.fireAt;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const entry = this.timers.get(earliestId);
      this.timers.delete(earliestId);
      this.nowMs = earliestAt;
      entry?.cb();
    }
    this.nowMs = target;
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

function makeBinding(suffix = '1', generation = 'gen_1'): RuntimeBinding {
  return {
    runtimeId: asRuntimeId(`nrt_np04_${suffix}`),
    sessionId: `sess_np04_${suffix}`,
    instanceId: 'agy',
    generation: asBindingGeneration(generation),
  };
}

function makePromptCtx(
  binding: RuntimeBinding,
  turnId: string,
  opts?: Partial<PromptContext>,
): PromptContext {
  return {
    turnId,
    requestOrdinal: opts?.requestOrdinal ?? 1,
    rpcId: opts?.rpcId ?? 10,
    binding,
    connectionId: opts?.connectionId ?? 'conn_1',
    capabilitySnapshotRevision: opts?.capabilitySnapshotRevision ?? 1,
    startedAt: opts?.startedAt ?? 1_700_000_000_000,
    isSteering: opts?.isSteering ?? false,
  };
}

interface RecordedSettlement {
  binding: RuntimeBinding;
  turnId: string;
  settlement: Extract<TurnSettlement, { kind: 'eligible' | 'disconnected' }>;
}

function makeRecordingSink(): {
  sink: NativeTurnSettlementSink;
  calls: RecordedSettlement[];
} {
  const calls: RecordedSettlement[] = [];
  const settledKeys = new Set<string>();
  const sink: NativeTurnSettlementSink = {
    settleTurn(params) {
      const key = `${params.binding.runtimeId}::${params.binding.generation}::${params.turnId}`;
      if (settledKeys.has(key)) {
        return { settled: false, reason: 'already_settled' };
      }
      settledKeys.add(key);
      calls.push(params);
      return { settled: true };
    },
  };
  return { sink, calls };
}

function loadNdjson(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('NP-04 Versioned Wire Codec & Per-ID Patch Semantics (synthetic + replay_with_provenance)', () => {
  it('exposes versioned codec rules with trace provenance and handles omitted vs null vs unknown fields', () => {
    expect(AGY_REACTIVE_CODEC_RULES.length).toBeGreaterThanOrEqual(5);
    for (const rule of AGY_REACTIVE_CODEC_RULES) {
      expect(rule.traceRefs.length).toBeGreaterThan(0);
    }

    const binding = makeBinding('codec');
    const clock = new VirtualClockScheduler();
    const ctrl = createReactiveRuntimeController({ now: clock.now, scheduler: clock });
    const ctx = makePromptCtx(binding, 'turn_codec');
    ctrl.onPromptStarted(ctx);

    // Initial finite command with title and explicit background flag
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 1,
      channel: 'live',
      originSession: 'nat_sess_1',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_sess_1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_patch_1',
            title: 'Run finite job',
            status: 'in_progress',
            rawInput: { isBackground: true, IsDaemon: false, backgroundTaskId: 'bg_1' },
          },
        },
      },
    });

    // Status-only patch (omits title, rawInput, kind) -> MUST preserve finite_command, confirmed_blocking, observedLabel!
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 2,
      channel: 'live',
      originSession: 'nat_sess_1',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_sess_1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_patch_1',
            status: 'running',
            unknownVendorHint: 'ignored_safely',
          },
        },
      },
    });

    let snap = ctrl.getRuntimeSnapshot(binding)!;
    expect(snap.work).toHaveLength(1);
    expect(snap.work[0]?.kind).toBe('finite_command');
    expect(snap.work[0]?.blocking).toBe('confirmed_blocking');
    expect(snap.work[0]?.observedLabel).toBe('Run finite job');

    // Explicit `title: null` clears observedLabel per schema while preserving kind & blocking
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 3,
      channel: 'live',
      originSession: 'nat_sess_1',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_sess_1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_patch_1',
            title: null,
            status: 'completed', // Note: no exitCode/ok in rawOutput -> outcome MUST NOT be fabricated as succeeded!
          },
        },
      },
    });

    snap = ctrl.getRuntimeSnapshot(binding)!;
    expect(snap.work[0]?.kind).toBe('finite_command');
    expect(snap.work[0]?.blocking).toBe('confirmed_blocking');
    expect(snap.work[0]?.observedLabel).toBeUndefined();
    expect(snap.work[0]?.state).toMatchObject({ kind: 'known', value: 'finished' });
    expect(snap.work[0]?.outcome).toMatchObject({
      kind: 'unknown',
      reasonCode: 'outcome_not_reported_by_wire',
    });

    // Duplicate terminal patch is idempotent (revision does not advance)
    const revBeforeDup = snap.work[0]!.revision;
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 4,
      channel: 'live',
      originSession: 'nat_sess_1',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'nat_sess_1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_patch_1',
            status: 'completed',
          },
        },
      },
    });
    snap = ctrl.getRuntimeSnapshot(binding)!;
    expect(snap.work[0]?.revision).toBe(revBeforeDup);
    expect(
      snap.diagnosis.diagnostics.some((d) => d.code === 'hm_duplicate_terminal_patch_ignored'),
    ).toBe(true);

    // Missing toolCallId on malformed patch -> diagnosed without crash or corruption
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 5,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'tool_call_update', status: 'completed' } },
      },
    });
    expect(
      ctrl.diagnoseRuntime(binding)?.diagnostics.some((d) => d.code === 'hm_missing_tool_call_id'),
    ).toBe(true);

    // Unrecognized status string maps to unknown (never fabricated finished/succeeded)
    const decodedUnknown = decodeNativeIngressFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 6,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_weird',
            status: 'mystic_vendor_state',
          },
        },
      },
    });
    expect(decodedUnknown.kind).toBe('tool_patch');
    if (decodedUnknown.kind === 'tool_patch') {
      expect(decodedUnknown.patch.state).toEqual({ op: 'set', value: 'unknown' });
      expect(decodedUnknown.patch.stateReasonCode).toContain('unrecognized_wire_status');
    }

    // Strict mode disables heuristic title classification (`invoke_subagent` stays unknown)
    const strictDecoded = decodeNativeIngressFrame(
      {
        binding,
        connectionId: 'conn_1',
        ingressOrdinal: 7,
        channel: 'live',
        wire: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc_sub_strict',
              title: 'invoke_subagent',
              status: 'in_progress',
            },
          },
        },
      },
      { strictMode: true },
    );
    expect(strictDecoded.kind).toBe('tool_patch');
    if (strictDecoded.kind === 'tool_patch') {
      expect(strictDecoded.patch.kind).toEqual({ op: 'set', value: 'unknown' });
    }
  });
});

describe('NP-04 Reactive Lifecycle Scenarios T02-T06, T08, T14 & AGY 1.5.14 Replay', () => {
  it('T02: holds early prompt response for 20s finite work, absorbs native wake + read-only tool, settles ONCE, and preserves reactive_not_observed gap when wake is absent', () => {
    // 1. Replay NP-01 T02 fixture (with real wake + read-only tool + final text)
    const binding = makeBinding('t02');
    const clock = new VirtualClockScheduler();
    const { sink, calls } = makeRecordingSink();
    const ctrl = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { quiescenceWindowMs: 1_000, observationTimeoutMs: 60_000 },
    });
    ctrl.attachSettlementSink(sink);

    const fixture = loadNdjson(path.join(NP01_FIXTURES_DIR, 't02-reactive-20s-wake.ndjson'));
    const ctx = makePromptCtx(binding, 'turn-t02-1', { requestOrdinal: 3, rpcId: 3 });
    ctrl.onPromptStarted(ctx);

    let ordinal = 1;
    let promptSettlement: TurnSettlement | null = null;
    for (const row of fixture) {
      if (row.action !== 'stdout_frame') continue;
      const frame = row.frame as Record<string, unknown>;
      if (frame.method === 'session/update') {
        ctrl.acceptFrame({
          binding,
          connectionId: 'conn_1',
          ingressOrdinal: ordinal++,
          channel: 'live',
          wire: frame,
        });
      } else if (frame.id === 3 && frame.result) {
        promptSettlement = ctrl.onPromptSettled(ctx, {
          ok: true,
          stopReason: String((frame.result as { stopReason?: string }).stopReason ?? 'end_turn'),
          isCurrentTurn: true,
        });
      }
    }

    // Early prompt response MUST hold turn!
    expect(promptSettlement?.kind).toBe('held');
    // Immediately after wake chunks arrive, still within quiescence window (not prematurely settled)
    expect(calls).toHaveLength(0);
    // Advance past quiescence boundary -> settles ONCE!
    clock.advanceBy(1_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.turnId).toBe('turn-t02-1');
    expect(calls[0]?.settlement).toMatchObject({
      kind: 'eligible',
      outcome: 'completed',
      stopReason: 'reactive_wake_completed',
    });

    const diag = ctrl.diagnoseRuntime(binding)!;
    expect(diag.primaryAttribution).toBe('healthy_reactive_wake_observed');
    expect(diag.wakeSegmentsObserved).toBe(1);
    expect(diag.reactiveNotObservedGaps).toBe(0);
    expect(diag.earlyPromptResponsesObserved).toBe(1);

    // Finite work has explicit exitCode: 0 -> confirmed succeeded
    const snap = ctrl.getRuntimeSnapshot(binding)!;
    const finiteWork = snap.work.find((w) => w.kind === 'finite_command');
    expect(finiteWork?.state).toMatchObject({ kind: 'known', value: 'finished' });
    expect(finiteWork?.outcome).toMatchObject({ kind: 'known', value: 'succeeded' });

    // Activity timeline is readable via NativeTimelineReaderPort
    const actId = snap.activities[0]!.id;
    const page = ctrl.readTimeline({ binding, scopeKind: 'activity', scopeId: actId, limit: 20 });
    expect(page.items.length).toBeGreaterThanOrEqual(3);
    expect(page.items.some((e) => e.text?.includes('NP01_WAKE_CHECK'))).toBe(true);

    // 2. Same finite flow WITHOUT wake -> MUST preserve `reactive_not_observed` gap honestly!
    const bindingNoWake = makeBinding('t02_nowake');
    const sinkNoWake = makeRecordingSink();
    const ctrlNoWake = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { quiescenceWindowMs: 1_000 },
    });
    ctrlNoWake.attachSettlementSink(sinkNoWake.sink);
    const ctx2 = makePromptCtx(bindingNoWake, 'turn_nowake', { connectionId: 'conn_2' });
    ctrlNoWake.onPromptStarted(ctx2);
    ctrlNoWake.acceptFrame({
      binding: bindingNoWake,
      connectionId: 'conn_2',
      ingressOrdinal: 1,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 's2',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_nw_1',
            title: '20s command',
            status: 'in_progress',
            rawInput: { isBackground: true, IsDaemon: false },
          },
        },
      },
    });
    const held = ctrlNoWake.onPromptSettled(ctx2, { ok: true, stopReason: 'end_turn', isCurrentTurn: true });
    expect(held.kind).toBe('held');
    ctrlNoWake.acceptFrame({
      binding: bindingNoWake,
      connectionId: 'conn_2',
      ingressOrdinal: 2,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 's2',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_nw_1',
            status: 'completed',
            rawOutput: { exitCode: 0 },
          },
        },
      },
    });
    clock.advanceBy(1_000);
    expect(sinkNoWake.calls).toHaveLength(1);
    expect(sinkNoWake.calls[0]?.settlement).toMatchObject({
      kind: 'eligible',
      outcome: 'completed',
      stopReason: 'finite_work_finished_no_wake',
    });
    const noWakeDiag = ctrlNoWake.diagnoseRuntime(bindingNoWake)!;
    expect(noWakeDiag.primaryAttribution).toBe('reactive_not_observed');
    expect(noWakeDiag.reactiveNotObservedGaps).toBe(1);
    expect(noWakeDiag.wakeSegmentsObserved).toBe(0);
  });

  it('T03: handles synthetic 15min+ observation timeout -> unknown, RPC timeout, and non-zero exit without fabricating success', () => {
    const binding = makeBinding('t03');
    const clock = new VirtualClockScheduler();
    const { sink, calls } = makeRecordingSink();
    const ctrl = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { observationTimeoutMs: 15 * 60_000 + 5_000, quiescenceWindowMs: 1_000 },
    });
    ctrl.attachSettlementSink(sink);

    // 1. Synthetic 15min+ held finite work -> observation timeout marks work UNKNOWN (not finished/succeeded!)
    const ctx = makePromptCtx(binding, 'turn_t03_15m', { connectionId: 'conn_t03' });
    ctrl.onPromptStarted(ctx);
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t03',
      ingressOrdinal: 1,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 't03-sess',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-long-finite',
            title: 'Run long build',
            status: 'in_progress',
            rawInput: { isBackground: true, IsDaemon: false, backgroundTaskId: 'bg-long-1' },
          },
        },
      },
    });
    expect(ctrl.onPromptSettled(ctx, { ok: true, stopReason: 'end_turn', isCurrentTurn: true }).kind).toBe('held');

    // Still held at 15 minutes
    clock.advanceBy(15 * 60_000);
    expect(calls).toHaveLength(0);
    expect(ctrl.listRetentionReasons(binding).some((r) => r.startsWith('finite_work:'))).toBe(true);

    // Exceeds observation timeout -> transitions work to unknown and settles turn ONCE as failed/unknown
    clock.advanceBy(5_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.settlement).toMatchObject({
      kind: 'eligible',
      outcome: 'failed',
      code: 'observation_timeout',
    });
    const snap = ctrl.getRuntimeSnapshot(binding)!;
    expect(snap.work[0]?.state).toMatchObject({
      kind: 'unknown',
      reasonCode: 'observation_timeout',
    });
    expect(snap.activities[0]?.state).toBe('unknown');
    expect(snap.diagnosis.primaryAttribution).toBe('observation_timeout_unknown');

    // 2. Non-zero exit on finite work without wake -> preserves failed state & outcome
    const bindingFail = makeBinding('t03_fail');
    const sinkFail = makeRecordingSink();
    const ctrlFail = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { quiescenceWindowMs: 500 },
    });
    ctrlFail.attachSettlementSink(sinkFail.sink);
    const ctxFail = makePromptCtx(bindingFail, 'turn_t03_fail', { connectionId: 'conn_t03_f' });
    ctrlFail.onPromptStarted(ctxFail);
    ctrlFail.acceptFrame({
      binding: bindingFail,
      connectionId: 'conn_t03_f',
      ingressOrdinal: 1,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 't03-fail',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_fail',
            title: 'Failing build',
            status: 'in_progress',
            rawInput: { isBackground: true, IsDaemon: false },
          },
        },
      },
    });
    expect(ctrlFail.onPromptSettled(ctxFail, { ok: true, stopReason: 'end_turn', isCurrentTurn: true }).kind).toBe('held');
    ctrlFail.acceptFrame({
      binding: bindingFail,
      connectionId: 'conn_t03_f',
      ingressOrdinal: 2,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 't03-fail',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_fail',
            status: 'completed',
            rawOutput: { exitCode: 137 },
          },
        },
      },
    });
    clock.advanceBy(500);
    expect(sinkFail.calls).toHaveLength(1);
    expect(sinkFail.calls[0]?.settlement).toMatchObject({
      kind: 'eligible',
      outcome: 'failed',
      code: 'finite_work_failed',
    });
    const failWork = ctrlFail.getRuntimeSnapshot(bindingFail)!.work[0]!;
    expect(failWork.state).toMatchObject({ kind: 'known', value: 'failed' });
    expect(failWork.outcome).toMatchObject({ kind: 'known', value: 'failed' });
  });

  it('T04: parallel finite A & B out-of-order (B before A) + detached daemon D -> B does not release A, daemon never blocks turn', () => {
    const binding = makeBinding('t04');
    const clock = new VirtualClockScheduler();
    const { sink, calls } = makeRecordingSink();
    const ctrl = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { quiescenceWindowMs: 500 },
    });
    ctrl.attachSettlementSink(sink);

    const fixture = loadNdjson(path.join(NP01_FIXTURES_DIR, 't04-parallel-finite-and-daemon.ndjson'));
    const ctx = makePromptCtx(binding, 'turn-t04-1', { requestOrdinal: 3, rpcId: 3, connectionId: 'conn_t04' });
    ctrl.onPromptStarted(ctx);

    const stdoutFrames = fixture
      .filter((r) => r.action === 'stdout_frame')
      .map((r) => r.frame as Record<string, unknown>);

    let ordinal = 1;
    // Dispatch A, B, D starts + early prompt response
    for (const frame of stdoutFrames) {
      if (frame.method === 'session/update') {
        const upd = (frame.params as { update?: { sessionUpdate?: string } }).update;
        if (upd?.sessionUpdate === 'tool_call') {
          ctrl.acceptFrame({
            binding,
            connectionId: 'conn_t04',
            ingressOrdinal: ordinal++,
            channel: 'live',
            wire: frame,
          });
        }
      }
    }

    const promptRes = ctrl.onPromptSettled(ctx, { ok: true, stopReason: 'end_turn', isCurrentTurn: true });
    expect(promptRes.kind).toBe('held');
    if (promptRes.kind === 'held') {
      // ONLY finite A & B block the turn — daemon D MUST NOT be in blocking reasons!
      expect(promptRes.reasonIds).toHaveLength(2);
      expect(promptRes.reasonIds.every((r) => r.startsWith('finite_work:'))).toBe(true);
    }

    // Retention reasons include finite A, finite B, held_turn, AND independent daemon_observe D
    const initialReasons = ctrl.listRetentionReasons(binding);
    expect(initialReasons.filter((r) => r.startsWith('finite_work:'))).toHaveLength(2);
    expect(initialReasons.filter((r) => r.startsWith('daemon_observe:'))).toHaveLength(1);

    // Finish B FIRST (status-only patch without title/rawInput!)
    const finishB = stdoutFrames.find(
      (f) =>
        f.method === 'session/update' &&
        (f.params as { update?: { toolCallId?: string; sessionUpdate?: string } }).update?.toolCallId === 'tc-finite-B' &&
        (f.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === 'tool_call_update',
    )!;
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t04',
      ingressOrdinal: ordinal++,
      channel: 'live',
      wire: finishB,
    });

    // Advance beyond quiescence -> A is STILL running so turn MUST REMAIN HELD!
    clock.advanceBy(2_000);
    expect(calls).toHaveLength(0);
    expect(ctrl.decideTurnSettlement('turn-t04-1', binding).kind).toBe('held');
    expect(ctrl.listRetentionReasons(binding).filter((r) => r.startsWith('finite_work:'))).toHaveLength(1);

    // Now finish A SECOND -> blocking set becomes empty while daemon D is STILL running!
    const finishA = stdoutFrames.find(
      (f) =>
        f.method === 'session/update' &&
        (f.params as { update?: { toolCallId?: string; sessionUpdate?: string } }).update?.toolCallId === 'tc-finite-A' &&
        (f.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === 'tool_call_update',
    )!;
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t04',
      ingressOrdinal: ordinal++,
      channel: 'live',
      wire: finishA,
    });

    clock.advanceBy(500);
    // Turn settles ONCE even though daemon D is STILL running!
    expect(calls).toHaveLength(1);
    expect(calls[0]?.turnId).toBe('turn-t04-1');
    expect(calls[0]?.settlement.kind).toBe('eligible');

    // Daemon D stays active & independently observable in Runtime Center!
    const snap = ctrl.getRuntimeSnapshot(binding)!;
    const daemon = snap.work.find((w) => w.kind === 'daemon');
    expect(daemon?.blocking).toBe('detached');
    expect(daemon?.state).toMatchObject({ kind: 'known', value: 'running' });
    expect(ctrl.listRetentionReasons(binding)).toEqual([`daemon_observe:${daemon!.id}`]);
    expect(ctrl.onWarmPoolEvictCheck(binding).allowEvict).toBe(false);

    // Config hot-reload: allow evicting detached daemons without dropping tracked work
    ctrl.reloadConfig({ retainWarmPoolForDetachedDaemons: false });
    expect(ctrl.onWarmPoolEvictCheck(binding).allowEvict).toBe(true);
    expect(ctrl.getRuntimeSnapshot(binding)!.work.find((w) => w.kind === 'daemon')).toBeDefined();
  });

  it('T05: separates late tool updates from sequential native wake activities and ensures usage_update never reopens turn', () => {
    const binding = makeBinding('t05');
    const clock = new VirtualClockScheduler();
    const { sink, calls } = makeRecordingSink();
    const ctrl = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { nativeActivityQuiescenceMs: 500 },
    });
    ctrl.attachSettlementSink(sink);

    const ctx = makePromptCtx(binding, 'turn-t05-1', { connectionId: 'conn_t05' });
    ctrl.onPromptStarted(ctx);
    const settled = ctrl.onPromptSettled(ctx, { ok: true, stopReason: 'end_turn', isCurrentTurn: true });
    expect(settled.kind).toBe('eligible');

    const fixture = loadNdjson(path.join(NP01_FIXTURES_DIR, 't05-double-wake-and-usage-only.ndjson'));
    const updates = fixture
      .filter((r) => r.action === 'stdout_frame' && (r.frame as { method?: string }).method === 'session/update')
      .map((r) => r.frame as Record<string, unknown>);

    // 1. First wake chunk (experimentalWakeEpoch: 1) -> native-only activity #1 (`turnId: null`)
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t05',
      ingressOrdinal: 1,
      channel: 'live',
      wire: updates[0],
    });
    // Let native activity #1 become quiescent
    clock.advanceBy(500);

    // 2. Late tool_call_update (`tc-late-old-1`) -> updates work ONLY, does NOT open a new activity or reopen turn!
    const actCountBeforeLateTool = ctrl.getRuntimeSnapshot(binding)!.activities.length;
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t05',
      ingressOrdinal: 2,
      channel: 'live',
      wire: updates[1],
    });
    expect(ctrl.getRuntimeSnapshot(binding)!.activities.length).toBe(actCountBeforeLateTool);
    expect(ctrl.getRuntimeSnapshot(binding)!.work).toHaveLength(1);

    // 3. usage_update alone -> does NOT open a new activity or reopen turn!
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t05',
      ingressOrdinal: 3,
      channel: 'live',
      wire: updates[2],
    });
    expect(ctrl.getRuntimeSnapshot(binding)!.activities.length).toBe(actCountBeforeLateTool);
    expect(
      ctrl.diagnoseRuntime(binding)!.diagnostics.some((d) => d.code === 'hm_usage_only_no_reopen'),
    ).toBe(true);

    // 4. Second wake chunk (experimentalWakeEpoch: 2) -> opens distinct native-only activity #2!
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t05',
      ingressOrdinal: 4,
      channel: 'live',
      wire: updates[3],
    });

    const snap = ctrl.getRuntimeSnapshot(binding)!;
    const nativeOnlyActs = snap.activities.filter((a) => a.turnId === null);
    expect(nativeOnlyActs).toHaveLength(2);
    expect(nativeOnlyActs[0]?.origin).toBe('native_continuation');
    expect(nativeOnlyActs[0]?.state).toBe('quiescent');
    expect(nativeOnlyActs[1]?.origin).toBe('native_continuation');
    expect(nativeOnlyActs[1]?.priorActivityId).toBe(nativeOnlyActs[0]?.id);
    expect(nativeOnlyActs[1]?.state).toBe('running');
    // Original user turn was never reopened or double-settled!
    expect(calls).toHaveLength(0);
    expect(snap.activities[0]?.state).toBe('finished');

    // 5. history_replay frames NEVER open live activities or retention leases
    const actCountBeforeReplay = snap.activities.length;
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t05',
      ingressOrdinal: 5,
      channel: 'history_replay',
      wire: updates[0],
    });
    expect(ctrl.getRuntimeSnapshot(binding)!.activities.length).toBe(actCountBeforeReplay);
    expect(
      ctrl.diagnoseRuntime(binding)!.diagnostics.some((d) => d.code === 'hm_history_replay_isolated'),
    ).toBe(true);
  });

  it('T06: handles out-of-turn permission (numeric RPC ID) and child interaction_* (string RPC ID) with NP-05/NP-07 stubs', () => {
    const binding = makeBinding('t06');
    const clock = new VirtualClockScheduler();
    const ctrl = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      childIdentityStub: createStaticChildIdentityStub({ 't06-child-alpha': 'agt_child_alpha' }),
    });

    const ctx = makePromptCtx(binding, 'turn-t06-1', { connectionId: 'conn_t06' });
    ctrl.onPromptStarted(ctx);
    ctrl.onPromptSettled(ctx, { ok: true, stopReason: 'end_turn', isCurrentTurn: true });

    const fixture = loadNdjson(path.join(NP01_FIXTURES_DIR, 't06-post-turn-permission-and-child.ndjson'));
    const serverReqs = fixture
      .filter((r) => r.action === 'stdout_frame' && (r.frame as { method?: string }).method === 'session/request_permission')
      .map((r) => r.frame as Record<string, unknown>);

    // 1. Numeric RPC ID 9001 out-of-turn permission
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t06',
      ingressOrdinal: 1,
      channel: 'live',
      wire: serverReqs[0],
    });
    expect(ctrl.listRetentionReasons(binding)).toEqual([expect.stringMatching(/^pending_request:request_/)]);
    expect(ctrl.onWarmPoolEvictCheck(binding).allowEvict).toBe(false);

    // 2. String RPC ID 'child-req-str-1' interaction_* with confirmed child stub
    ctrl.acceptFrame({
      binding,
      connectionId: 'conn_t06',
      ingressOrdinal: 2,
      channel: 'live',
      wire: serverReqs[1],
    });
    expect(ctrl.listRetentionReasons(binding)).toHaveLength(2);

    const snap = ctrl.getRuntimeSnapshot(binding)!;
    const [numReq, strReq] = snap.requests;
    expect(numReq?.kind).toBe('permission');
    expect(numReq?.targetLineage).toBe('unresolved');
    expect(strReq?.kind).toBe('question');
    expect(strReq?.targetLineage).toBe('confirmed');
    expect(strReq?.agentId).toBe('agt_child_alpha');

    // Resolving both releases pending_request retention leases cleanly
    ctrl.resolveWirePendingRequest(binding, 9001, 'response_written');
    ctrl.resolveWirePendingRequest(binding, 'child-req-str-1', 'response_written');
    expect(ctrl.listRetentionReasons(binding)).toEqual([]);
  });

  it('T08: prevents stop -> next turn stale RPC contamination, tracks parallel steering, and distinguishes cancel confirmation vs grace expiry', () => {
    const binding = makeBinding('t08');
    const clock = new VirtualClockScheduler();
    const { sink, calls } = makeRecordingSink();
    const ctrl = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { cancelGraceMs: 2_000, quiescenceWindowMs: 500 },
    });
    ctrl.attachSettlementSink(sink);

    // 1. Stop Turn 1 -> start Turn 2 -> stale Turn 1 prompt response MUST NOT pollute Turn 2!
    const ctx1 = makePromptCtx(binding, 'turn_1', { requestOrdinal: 1, rpcId: 101 });
    ctrl.onPromptStarted(ctx1);
    ctrl.onCancelRequested(binding);
    clock.advanceBy(2_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.settlement).toMatchObject({ stopReason: 'cancel_grace_expired' });
    const ctx2 = makePromptCtx(binding, 'turn_2', { requestOrdinal: 2, rpcId: 102 });
    ctrl.onPromptStarted(ctx2);

    const staleSettle = ctrl.onPromptSettled(ctx1, {
      ok: true,
      stopReason: 'end_turn',
      isCurrentTurn: false,
    });
    expect(staleSettle).toMatchObject({ kind: 'eligible', stopReason: 'stale_prompt_response_ignored' });
    expect(ctrl.diagnoseRuntime(binding)!.staleRpcResponsesBlocked).toBe(1);

    // Mid-turn steering on Turn 2 (parallel RPC 103 settling before primary RPC 102)
    const steerCtx = makePromptCtx(binding, 'turn_2', {
      requestOrdinal: 3,
      rpcId: 103,
      isSteering: true,
    });
    ctrl.onPromptStarted(steerCtx);
    const steerSettle = ctrl.onPromptSettled(steerCtx, {
      ok: true,
      stopReason: 'end_turn',
      isCurrentTurn: true,
    });
    // Must stay held while primary RPC 102 is still in-flight!
    expect(steerSettle.kind).toBe('held');

    // Now primary RPC 102 settles Turn 2 cleanly
    const turn2Settle = ctrl.onPromptSettled(ctx2, {
      ok: true,
      stopReason: 'end_turn',
      isCurrentTurn: true,
    });
    expect(turn2Settle).toMatchObject({ kind: 'eligible', outcome: 'completed', stopReason: 'end_turn' });

    // 2. Cancel grace EXPIRY without native confirmation -> work marked stale, activity unknown (never fake cancelled!)
    const bindingGrace = makeBinding('t08_grace');
    const sinkGrace = makeRecordingSink();
    const ctrlGrace = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { cancelGraceMs: 2_000 },
    });
    ctrlGrace.attachSettlementSink(sinkGrace.sink);

    const ctx3 = makePromptCtx(bindingGrace, 'turn_grace', { connectionId: 'conn_g' });
    ctrlGrace.onPromptStarted(ctx3);
    ctrlGrace.acceptFrame({
      binding: bindingGrace,
      connectionId: 'conn_g',
      ingressOrdinal: 1,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'sg',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_grace_1',
            title: 'Long command',
            status: 'in_progress',
            rawInput: { isBackground: true, IsDaemon: false },
          },
        },
      },
    });
    expect(ctrlGrace.onPromptSettled(ctx3, { ok: true, stopReason: 'end_turn', isCurrentTurn: true }).kind).toBe('held');
    ctrlGrace.onCancelRequested(bindingGrace);
    expect(ctrlGrace.listRetentionReasons(bindingGrace).some((r) => r.startsWith('cancel_grace:'))).toBe(true);
    expect(ctrlGrace.getRuntimeSnapshot(bindingGrace)!.activities[0]?.state).toBe('cancelling');

    clock.advanceBy(2_000);
    const graceSnap = ctrlGrace.getRuntimeSnapshot(bindingGrace)!;
    expect(graceSnap.cancelState?.outcome).toBe('grace_expired_unknown');
    expect(graceSnap.work[0]?.state).toMatchObject({
      kind: 'stale',
      last: 'running',
      reasonCode: 'cancel_grace_expired',
    });
    expect(graceSnap.activities[0]?.state).toBe('unknown');
    expect(sinkGrace.calls).toHaveLength(1);
    expect(sinkGrace.calls[0]?.settlement).toMatchObject({
      kind: 'eligible',
      outcome: 'cancelled',
      stopReason: 'cancel_grace_expired',
    });

    // 3. Cancel CONFIRMED within grace window (native tool_call_update cancelled) + strictMode hot-reload
    const bindingConfirm = makeBinding('t08_confirm');
    const sinkConfirm = makeRecordingSink();
    const ctrlConfirm = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { cancelGraceMs: 3_000, strictMode: false },
    });
    ctrlConfirm.attachSettlementSink(sinkConfirm.sink);
    const ctx4 = makePromptCtx(bindingConfirm, 'turn_cancel_ok', { connectionId: 'conn_ok' });
    ctrlConfirm.onPromptStarted(ctx4);
    ctrlConfirm.acceptFrame({
      binding: bindingConfirm,
      connectionId: 'conn_ok',
      ingressOrdinal: 1,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'sok',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_cancel_ok',
            title: 'Cancelable finite',
            status: 'in_progress',
            rawInput: { isBackground: true, IsDaemon: false },
          },
        },
      },
    });
    expect(ctrlConfirm.onPromptSettled(ctx4, { ok: true, stopReason: 'end_turn', isCurrentTurn: true }).kind).toBe('held');
    ctrlConfirm.onCancelRequested(bindingConfirm);
    clock.advanceBy(500);
    ctrlConfirm.acceptFrame({
      binding: bindingConfirm,
      connectionId: 'conn_ok',
      ingressOrdinal: 2,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'sok',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_cancel_ok',
            status: 'cancelled',
          },
        },
      },
    });
    const confirmSnap = ctrlConfirm.getRuntimeSnapshot(bindingConfirm)!;
    expect(confirmSnap.cancelState?.outcome).toBe('confirmed_cancelled');
    expect(confirmSnap.activities[0]?.state).toBe('cancelled');
    expect(sinkConfirm.calls).toHaveLength(1);
    expect(sinkConfirm.calls[0]?.settlement).toMatchObject({
      kind: 'eligible',
      outcome: 'cancelled',
      stopReason: 'cancelled',
    });

    // Hot-reload strictMode -> subsequent heuristic-only title stays unknown without losing prior work
    ctrlConfirm.reloadConfig({ strictMode: true, cancelGraceMs: 4_000 });
    expect(ctrlConfirm.getConfig().strictMode).toBe(true);
    expect(ctrlConfirm.getConfig().cancelGraceMs).toBe(4_000);
    ctrlConfirm.acceptFrame({
      binding: bindingConfirm,
      connectionId: 'conn_ok',
      ingressOrdinal: 3,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'sok',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_strict_after_reload',
            title: 'invoke_subagent',
            status: 'in_progress',
          },
        },
      },
    });
    expect(
      ctrlConfirm.getRuntimeSnapshot(bindingConfirm)!.work.find((w) => w.observedLabel === 'invoke_subagent')?.kind,
    ).toBe('unknown');
    expect(calls).toHaveLength(1);
  });

  it('T14: transport exit marks active work stale (never cancelled), settles held turn ONCE as disconnected, and generation change fences old timers/frames', () => {
    const binding1 = makeBinding('t14', 'gen_1');
    const binding2 = makeBinding('t14', 'gen_2');
    const clock = new VirtualClockScheduler();
    const { sink, calls } = makeRecordingSink();
    const ctrl = createReactiveRuntimeController({
      now: clock.now,
      scheduler: clock,
      config: { quiescenceWindowMs: 1_000, observationTimeoutMs: 10_000 },
    });
    ctrl.attachSettlementSink(sink);

    const ctx = makePromptCtx(binding1, 'turn_crash', { connectionId: 'conn_crash' });
    ctrl.onPromptStarted(ctx);
    ctrl.acceptFrame({
      binding: binding1,
      connectionId: 'conn_crash',
      ingressOrdinal: 1,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: {
          sessionId: 'sc',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_crash_finite',
            title: 'Build task',
            status: 'in_progress',
            rawInput: { isBackground: true, IsDaemon: false },
          },
        },
      },
    });
    expect(ctrl.onPromptSettled(ctx, { ok: true, stopReason: 'end_turn', isCurrentTurn: true }).kind).toBe('held');

    // Transport crashes -> settles held turn ONCE as disconnected & marks work stale (NEVER cancelled!)
    ctrl.handleTransportClosed(binding1, 'conn_crash', 'process_exit_137');
    ctrl.handleTransportClosed(binding1, 'conn_crash', 'duplicate_close');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.settlement).toEqual({ kind: 'disconnected', reason: 'process_exit_137' });
    const crashedSnap = ctrl.getRuntimeSnapshot(binding1)!;
    expect(crashedSnap.status).toBe('disconnected');
    expect(crashedSnap.work[0]?.state).toMatchObject({
      kind: 'stale',
      last: 'running',
      reasonCode: 'process_exit_137',
    });
    expect(ctrl.listRetentionReasons(binding1)).toEqual([]);

    // Generation change -> old gen frames fenced, reconnect transitions gen_2 to reconciling
    ctrl.onProfileGenerationChanged(binding1, binding2);
    ctrl.onReconnect(binding2, 'resume');
    expect(ctrl.getRuntimeSnapshot(binding2)!.status).toBe('reconciling');

    ctrl.acceptFrame({
      binding: binding1,
      connectionId: 'conn_old',
      ingressOrdinal: 99,
      channel: 'live',
      wire: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'stale gen1 text' } } },
      },
    });
    expect(
      ctrl.diagnoseRuntime(binding2)!.diagnostics.some((d) => d.code === 'hm_generation_fenced'),
    ).toBe(true);
    expect(ctrl.getRuntimeSnapshot(binding2)!.activities).toHaveLength(0);
  });

  it('replays legacy AGY 1.5.14 session-full.ndjson compat shapes without regression (replay_with_provenance)', () => {
    const binding = makeBinding('1514');
    const clock = new VirtualClockScheduler();
    const ctrl = createReactiveRuntimeController({ now: clock.now, scheduler: clock });
    const ctx = makePromptCtx(binding, 'turn_1514', { connectionId: 'conn_1514' });
    ctrl.onPromptStarted(ctx);

    const rows = loadNdjson(AGY_1514_FIXTURE_PATH);
    let ordinal = 1;
    for (const row of rows) {
      const frame = row.frame as Record<string, unknown>;
      if (frame.method === 'session/update' || frame.method === 'session/request_permission') {
        ctrl.acceptFrame({
          binding,
          connectionId: 'conn_1514',
          ingressOrdinal: ordinal++,
          channel: 'live',
          wire: frame,
        });
      }
    }

    const snap = ctrl.getRuntimeSnapshot(binding)!;
    // Schedule tool from 1.5.14 (`DurationSeconds: 60`) classified as `schedule` + `detached` (NEVER blocks turn!)
    const sched = snap.work.find((w) => w.kind === 'schedule');
    expect(sched).toBeDefined();
    expect(sched?.blocking).toBe('detached');
    // Subagent launch from 1.5.14 (`invoke_subagent`) classified as `subagent` + `unknown` blocking
    const sub = snap.work.find((w) => w.kind === 'subagent');
    expect(sub).toBeDefined();
    expect(sub?.blocking).toBe('unknown');
    // Both numeric permissions (`8101` security, `8102` interaction_001) tracked with distinct kinds
    expect(snap.requests.map((req) => req.kind)).toEqual(['permission', 'question']);

    // Resolving both requests allows turn settlement even while schedule stays detached
    ctrl.resolveWirePendingRequest(binding, 8101, 'response_written');
    ctrl.resolveWirePendingRequest(binding, 8102, 'response_written');
    const settled = ctrl.onPromptSettled(ctx, { ok: true, stopReason: 'end_turn', isCurrentTurn: true });
    expect(settled).toMatchObject({ kind: 'eligible', outcome: 'completed' });
  });
});

describe('NP-04 End-to-End Integration with SessionManager + AgyNativeRuntimeRegistry + Mock ACP Process', () => {
  it('wires AgyReactiveRuntimeController into live Daemon, holds early prompt response for finite A/B, ignores daemon D for turn settlement, and emits turn.completed ONCE', async () => {
    const tmp = makeTempDir('hm-np04-e2e-');
    const mockScript = path.join(tmp, 'mock-agy-np04.mjs');
    fs.writeFileSync(
      mockScript,
      `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'mock-agy-np04', version: '1.5.16' },
        agentCapabilities: { promptCapabilities: { embeddedContext: false } },
      },
    }) + '\\n');
    return;
  }
  if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: 'nat_np04_e2e', configOptions: [] },
    }) + '\\n');
    return;
  }
  if (msg.method === 'session/set_mode') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    return;
  }
  if (msg.method === 'session/prompt') {
    // 1. Start finite A, finite B, and detached daemon D
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'nat_np04_e2e',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_e2e_A',
          title: 'Finite A',
          status: 'in_progress',
          rawInput: { isBackground: true, IsDaemon: false, backgroundTaskId: 'bg_A' },
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'nat_np04_e2e',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_e2e_B',
          title: 'Finite B',
          status: 'in_progress',
          rawInput: { isBackground: true, IsDaemon: false, backgroundTaskId: 'bg_B' },
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'nat_np04_e2e',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_e2e_D',
          title: 'Detached Daemon D',
          status: 'in_progress',
          rawInput: { isBackground: true, IsDaemon: true, backgroundTaskId: 'bg_D' },
        },
      },
    }) + '\\n');
    // 2. Early prompt response while A & B are running!
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' },
      }) + '\\n');
    }, 20);
    // 3. Finish B first (status-only patch!)
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'nat_np04_e2e',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_e2e_B',
            status: 'completed',
            rawOutput: { exitCode: 0 },
          },
        },
      }) + '\\n');
    }, 80);
    // 4. Finish A second + emit wake read-only tool & final message (while daemon D stays running!)
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'nat_np04_e2e',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_e2e_A',
            status: 'completed',
            rawOutput: { exitCode: 0, stdout: 'NP04_A_DONE' },
          },
        },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'nat_np04_e2e',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Wake summary after A and B finished.' },
          },
        },
      }) + '\\n');
    }, 180);
  }
});
`,
      'utf8',
    );

    class ScriptAgyAdapter extends AgyAdapter {
      protected override buildLaunchArgs(): string[] {
        return [mockScript];
      }
    }

    const daemon = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      webDistDir: null,
    });
    activeDaemons.push(daemon);

    const adapter = new ScriptAgyAdapter({
      profile: {
        instanceId: 'agy-np04-e2e',
        displayName: 'AGY NP-04 E2E',
        isolationMode: 'profile_isolated',
        authMethod: 'oauth-personal',
        appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
        defaults: { linkGlobalSkills: false, syncGlobalRules: false, additionalDirectories: [] },
        enabled: true,
      },
      profilesRootDir: path.join(tmp, 'profiles'),
      binaryOverride: process.execPath,
      applyWindowsAcl: false,
    });
    daemon.registry.register(adapter);

    const publishedEvents: NativeCanonicalEvent[] = [];
    const publisher: NativeRuntimePublisher = {
      commitAndPublish: (b, m, e) => {
        const res = daemon.nativeRegistry.commitAndPublish(b, m, e);
        if (!res.deduplicated) publishedEvents.push(res.event);
        return res;
      },
    };
    const controller = new AgyReactiveRuntimeController({
      publisher,
      config: { quiescenceWindowMs: 120, observationTimeoutMs: 10_000 },
    });

    daemon.nativeRegistry.setFeatureFlags({ enabled: true, nativeLifecycle: true });
    daemon.nativeRegistry.registerModules({
      lifecycle: controller,
      timelineReader: controller,
    });

    const ws = daemon.store.createWorkspace({
      id: 'ws_np04_e2e',
      name: 'NP04 E2E',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });
    const session = daemon.store.createSession({
      id: 'sess_np04_e2e',
      workspaceId: ws.id,
      harnessId: 'agy-np04-e2e',
      harnessKind: 'agy',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'NP04 E2E Reactive',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const turn = await daemon.sessionManager.sendTurn(session.id, 'Run parallel finite A/B + daemon D');

    // Wait past early prompt response (20ms) and B finish (80ms) while A is still running (finishes at 180ms)
    await new Promise((r) => setTimeout(r, 120));
    expect(daemon.store.getSession(session.id)?.status).toBe('running');
    expect(
      daemon.sessionManager
        .getSessionEvents(session.id, 0)
        .filter((e) => e.type === 'turn.completed' && e.turnId === turn.turnId),
    ).toHaveLength(0);

    // Wait for A to finish (180ms) + wake + quiescence (120ms)
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (daemon.store.getSession(session.id)?.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(daemon.store.getSession(session.id)?.status).toBe('idle');
    // Guaranteed SINGLE settlement of held user turn!
    const turnCompletedEvents = daemon.sessionManager
      .getSessionEvents(session.id, 0)
      .filter((e) => e.type === 'turn.completed' && e.turnId === turn.turnId);
    expect(turnCompletedEvents).toHaveLength(1);

    // Native projection in SQLite has finite A/B finished AND detached daemon D still running!
    const projection = daemon.nativeRegistry.getProjectionForSession(session.id, 'agy-np04-e2e');
    expect(projection.work.filter((w) => w.kind === 'finite_command')).toHaveLength(2);
    const daemonWork = projection.work.find((w) => w.kind === 'daemon');
    expect(daemonWork?.blocking).toBe('detached');
    expect(daemonWork?.state).toMatchObject({ kind: 'known', value: 'running' });
    expect(publishedEvents.some((e) => e.type === 'native.work.changed')).toBe(true);
    expect(publishedEvents.some((e) => e.type === 'native.activity.changed')).toBe(true);

    // HTTP timeline endpoint serves NP-04's NativeTimelineReaderPort
    const actId = projection.activities[0]!.id;
    const tlRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/activity/${actId}/timeline`,
    });
    expect(tlRes.statusCode).toBe(200);
    expect(tlRes.json().items.length).toBeGreaterThan(0);

    controller.dispose();
  }, 20_000);
});
