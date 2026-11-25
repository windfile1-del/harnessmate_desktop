import type { CanonicalEvent, Session } from '@harnessmate/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeClientError,
  NativeFeedController,
  applyNativeEventBatch,
  coalesceTimelineEntries,
  type ActivityId,
  type BindingGeneration,
  type NativeAgentId,
  type NativeCanonicalEvent,
  type NativeRuntimeProjection,
  type NativeRuntimeTransport,
  type RuntimeId,
  type WorkId,
} from '../src/lib/native-client';
import { projectSessionEvents } from '../src/lib/projector';
import {
  computeVirtualWindow,
  createLiveReactiveFixture,
  createStressFixture,
  createStubNativeTransport,
  parseWorkbenchRouteHash,
  serializeWorkbenchRouteHash,
} from '../src/components/agy/native/shared';
import { useAppStore } from '../src/stores/app-store';

const initialStore = useAppStore.getState();

afterEach(() => {
  useAppStore.getState().setNativeTransport(null);
  useAppStore.setState(initialStore, true);
  vi.restoreAllMocks();
});

describe('NP-03 Native Client & Projection Reducer (03b)', () => {
  it('hydrates snapshot, paginates catch-up events, and applies live batches with generation fencing', async () => {
    const { projection: baseSnap, capabilities } = createLiveReactiveFixture('sess_pag');
    const rt = baseSnap.binding.runtimeId;
    const gen = baseSnap.binding.generation;
    const ev = {
      sourceKind: 'live_protocol' as const,
      freshness: 'fresh' as const,
      observedAt: 1_764_000_020_000,
      wireVariant: 'acp_v1',
    };

    const pageEvents: NativeCanonicalEvent[] = [13, 14, 15, 16, 17].map((seq) => ({
      schemaVersion: 1,
      runtimeId: rt,
      generation: gen,
      seq,
      turnId: null,
      createdAt: 1_764_000_000_000 + seq * 1000,
      type: 'native.work.changed',
      payload: {
        work: {
          id: `wk_page_${seq}` as WorkId,
          kind: 'finite_command',
          blocking: 'confirmed_blocking',
          state: { kind: 'known', value: 'running', evidence: ev },
          observedLabel: `task-${seq}`,
          revision: seq,
        },
      },
    }));

    const transport = createStubNativeTransport({
      snapshot: baseSnap,
      capabilities,
      events: pageEvents,
      pageSize: 2,
    });
    const getEventsSpy = vi.spyOn(transport, 'getEvents');

    let latestProj: NativeRuntimeProjection | null = null;
    let latestSyncPhase = 'idle';
    const controller = new NativeFeedController({
      sessionId: 'sess_pag',
      transport,
      batchWindowMs: 0,
      pageLimit: 2,
      onUpdate: ({ projection, syncState }) => {
        latestProj = projection;
        latestSyncPhase = syncState.phase;
      },
    });

    await controller.hydrate();
    expect(latestSyncPhase).toBe('live');
    expect(getEventsSpy).toHaveBeenCalledTimes(3); // 2 + 2 + 1 across 3 pages
    expect(latestProj?.asOfSeq).toBe(17);

    // Enqueue stale generation event (must be dropped) + duplicate seq (idempotent) + valid seq 18
    controller.enqueueLiveEvents([
      {
        schemaVersion: 1,
        runtimeId: rt,
        generation: 'gen_old_0' as BindingGeneration,
        seq: 18,
        turnId: null,
        createdAt: 1_764_000_020_000,
        type: 'native.runtime.changed',
        payload: { status: 'disconnected' },
      },
      pageEvents[4]!, // duplicate seq 17
      {
        schemaVersion: 1,
        runtimeId: rt,
        generation: gen,
        seq: 18,
        turnId: null,
        createdAt: 1_764_000_021_000,
        type: 'native.work.changed',
        payload: {
          work: {
            id: 'wk_page_17' as WorkId,
            kind: 'finite_command',
            blocking: 'confirmed_blocking',
            state: { kind: 'known', value: 'finished', evidence: ev },
            outcome: { kind: 'known', value: 'succeeded', evidence: ev },
            observedLabel: 'task-17',
            revision: 18,
          },
        },
      },
    ]);

    const snap = controller.getSnapshot();
    expect(snap.projection?.asOfSeq).toBe(18);
    expect(snap.projection?.status).toBe('attached'); // stale disconnect was dropped
    expect(snap.syncState.droppedStaleEvents).toBe(1);
    const w17 = snap.projection?.work.find((w) => w.id === 'wk_page_17');
    expect(w17?.state.kind === 'known' && w17.state.value).toBe('finished');
    expect(w17?.outcome?.kind === 'known' && w17.outcome.value).toBe('succeeded');
    controller.dispose();
  });

  it('recovers cleanly from 410 RESYNC_REQUIRED and repairs seq gaps via catch-up', async () => {
    const { projection: baseSnap, capabilities } = createLiveReactiveFixture('sess_resync');
    const rt = baseSnap.binding.runtimeId;
    const gen = baseSnap.binding.generation;
    const ev = {
      sourceKind: 'live_protocol' as const,
      freshness: 'fresh' as const,
      observedAt: 1_764_000_025_000,
    };

    const events: NativeCanonicalEvent[] = [13, 14, 15].map((seq) => ({
      schemaVersion: 1,
      runtimeId: rt,
      generation: gen,
      seq,
      turnId: null,
      createdAt: 1_764_000_000_000 + seq * 1000,
      type: 'native.activity.changed',
      payload: {
        activity: {
          id: `act_r_${seq}` as ActivityId,
          turnId: null,
          origin: 'native_continuation',
          state: 'running',
          summary: `wake #${seq}`,
          evidence: ev,
          updatedAt: 1_764_000_000_000 + seq * 1000,
        },
      },
    }));

    const transport = createStubNativeTransport({
      snapshot: baseSnap,
      capabilities,
      events,
      simulateResyncOnce: true,
    });
    const snapSpy = vi.spyOn(transport, 'getSnapshot');

    const controller = new NativeFeedController({
      sessionId: 'sess_resync',
      transport,
      batchWindowMs: 0,
      onUpdate: () => {},
    });

    await controller.hydrate();
    // Initial snapshot + full resync after 410 RESYNC_REQUIRED
    expect(snapSpy).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().syncState.resyncCount).toBe(1);
    expect(controller.getSnapshot().syncState.phase).toBe('live');

    // Seq gap check in pure reducer: jumping from 15 to 19 halts live apply and reports gap
    const current = controller.getSnapshot().projection!;
    const gapOutcome = applyNativeEventBatch(current, [
      {
        schemaVersion: 1,
        runtimeId: rt,
        generation: gen,
        seq: 19,
        turnId: null,
        createdAt: 1_764_000_030_000,
        type: 'native.runtime.changed',
        payload: { status: 'reconciling' },
      },
    ]);
    expect(gapOutcome.seqGapDetected).toEqual({ expectedSeq: 16, receivedSeq: 19 });
    expect(gapOutcome.projection.asOfSeq).toBe(15);
    controller.dispose();
  });

  it('coalesces keyed text deltas without deduplicating distinct identical text chunks', () => {
    const merged = coalesceTimelineEntries(
      [
        {
          entryId: 'd1',
          seq: 1,
          timestamp: 1000,
          kind: 'assistant_text',
          actorKind: 'main',
          text: 'Hello ',
          deltaCoalesceKey: 'msg_1',
        },
      ],
      [
        {
          entryId: 'd2',
          seq: 2,
          timestamp: 1005,
          kind: 'assistant_text',
          actorKind: 'main',
          text: 'world!',
          deltaCoalesceKey: 'msg_1',
        },
        {
          entryId: 'chunk_a',
          seq: 3,
          timestamp: 1010,
          kind: 'assistant_text',
          actorKind: 'main',
          text: 'OK',
        },
        {
          entryId: 'chunk_b',
          seq: 4,
          timestamp: 1015,
          kind: 'assistant_text',
          actorKind: 'main',
          text: 'OK',
        },
      ],
    );

    expect(merged).toHaveLength(3);
    expect(merged[0]?.text).toBe('Hello world!');
    expect(merged[1]?.text).toBe('OK');
    expect(merged[2]?.text).toBe('OK');
  });

  it('isolates legacy native placeholder turns (turn_bg / turn_unknown) only when native UI mode requests it', () => {
    const events: CanonicalEvent[] = [
      {
        sessionId: 's_agy',
        seq: 1,
        type: 'message.user',
        turnId: 'turn_real_1',
        createdAt: 1000,
        payload: { text: 'Run 20s build' },
      },
      {
        sessionId: 's_agy',
        seq: 2,
        type: 'turn.completed',
        turnId: 'turn_real_1',
        createdAt: 1100,
        payload: { stopReason: 'end_turn' },
      },
      {
        sessionId: 's_agy',
        seq: 3,
        type: 'message.assistant.delta',
        turnId: 'turn_bg',
        createdAt: 2100,
        payload: { text: 'Late background output' },
      },
      {
        sessionId: 's_agy',
        seq: 4,
        type: 'message.assistant.delta',
        turnId: 'turn_unknown',
        createdAt: 2200,
        payload: { text: 'Orphan late frame' },
      },
    ];

    // Legacy default behavior unchanged (backward compatibility)
    const legacy = projectSessionEvents(events, { id: 'agy', kind: 'agy' });
    expect(legacy.turns).toHaveLength(3);

    // Native workbench isolation removes ghost turns from ChatStage timeline
    const isolated = projectSessionEvents(events, { id: 'agy', kind: 'agy' }, undefined, {
      isolateNativePlaceholders: true,
    });
    expect(isolated.turns).toHaveLength(1);
    expect(isolated.turns[0]?.turnId).toBe('turn_real_1');
    expect(isolated.detachedNativeEvents).toHaveLength(2);
    expect(isolated.detachedNativeEvents?.map((e) => e.turnId)).toEqual(['turn_bg', 'turn_unknown']);
  });

  it('handles 409 STALE_BINDING command conflicts by preserving draft and refreshing capabilities, and clears state on account switch', async () => {
    const { projection, capabilities } = createLiveReactiveFixture('sess_store_1');
    const session: Session = {
      id: 'sess_store_1',
      workspaceId: 'ws_1',
      harnessId: 'agy',
      harnessKind: 'agy',
      participatingHarnesses: ['agy', 'agy.work'],
      contextSyncMode: 'auto',
      cwd: 'D:/repo',
      title: 'AGY Store Test',
      status: 'idle',
      model: 'gemini-3.8-flash',
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 1,
      usage: null,
      pendingApprovalCount: 0,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const conflictTransport: NativeRuntimeTransport = {
      ...createStubNativeTransport({ snapshot: projection, capabilities }),
      submitCommand: vi.fn(async () => {
        throw new NativeClientError('Binding generation changed', 409, 'STALE_BINDING');
      }),
    };
    const getSnapSpy = vi.spyOn(conflictTransport, 'getSnapshot');

    const store = useAppStore.getState();
    store.setAgyNativeWorkbenchEnabled(true);
    store.setNativeTransport(conflictTransport);
    useAppStore.setState({
      sessions: [session],
      selectedSessionId: session.id,
      draftTextBySession: { [session.id]: 'keep my draft text' },
    });
    store.ingestNativeProjectionFixture(session.id, projection, capabilities);
    store.setNativeWorkbenchRoute(session.id, {
      surface: 'subagents',
      selectedAgentId: 'ag_child_researcher' as NativeAgentId,
    });

    const ok = await useAppStore.getState().submitNativeCommand(session.id, {
      capabilityId: 'AGY-W04',
      actionKey: 'swarm',
      args: { prompt: 'keep my draft text' },
    });

    expect(ok).toBe(false);
    expect(useAppStore.getState().draftTextBySession[session.id]).toBe('keep my draft text');
    expect(useAppStore.getState().nativeRuntimeBySession[session.id]?.commandSubmission?.phase).toBe(
      'conflict',
    );
    expect(getSnapSpy).toHaveBeenCalled();

    // Clearing state on account/profile switch wipes old route & projection cleanly
    useAppStore.getState().clearNativeSessionState(session.id);
    expect(useAppStore.getState().nativeRuntimeBySession[session.id]).toBeUndefined();
  });

  it('serializes and parses Workbench route hashes using only HM-scoped opaque IDs', () => {
    const hash = serializeWorkbenchRouteHash('sess_hm_42', {
      surface: 'subagents',
      layout: 'full',
      selectedAgentId: 'ag_child_1' as NativeAgentId,
      selectedActivityId: 'act_2' as ActivityId,
    });
    expect(hash).toBe(
      '#agy-workbench?session=sess_hm_42&surface=subagents&layout=full&activity=act_2&agent=ag_child_1',
    );
    expect(parseWorkbenchRouteHash(hash, 'sess_hm_42')).toEqual({
      surface: 'subagents',
      layout: 'full',
      selectedActivityId: 'act_2',
      selectedWorkId: null,
      selectedAgentId: 'ag_child_1',
      selectedWorkflowId: null,
    });
    // Cross-session hash is ignored safely
    expect(parseWorkbenchRouteHash(hash, 'sess_other')).toBeNull();
  });

  it('T18 Stress (joint with NP-16): processes 100 children, 10,000 events, and 20 pending requests with bounded virtual window', () => {
    const { projection, events, timelineEntries, approvals } = createStressFixture({
      agentCount: 100,
      eventCount: 10_000,
      pendingRequestCount: 20,
    });

    expect(projection.agents).toHaveLength(101); // 1 root + 100 children
    expect(projection.relations).toHaveLength(100);
    expect(approvals).toHaveLength(20);
    expect(events).toHaveLength(10_000);

    const t0 = performance.now();
    const outcome = applyNativeEventBatch(projection, events);
    const elapsedMs = performance.now() - t0;

    expect(outcome.appliedCount).toBe(10_000);
    expect(outcome.projection.asOfSeq).toBe(10_000);
    expect(outcome.projection.work).toHaveLength(50);
    expect(outcome.seqGapDetected).toBeNull();
    // Reducer must stay well under 250ms for 10k events on desktop hardware
    expect(elapsedMs).toBeLessThan(1500);

    // Virtual window for 10,000 timeline entries renders only a small bounded slice
    const winStart = computeVirtualWindow(timelineEntries.length, 0, 360, 76, 6);
    const winMid = computeVirtualWindow(timelineEntries.length, 380_000, 360, 76, 6);
    expect(winStart.renderedCount).toBeLessThanOrEqual(20);
    expect(winMid.renderedCount).toBeLessThanOrEqual(20);
    expect(winMid.topSpacerPx).toBeGreaterThan(300_000);
    expect(winMid.bottomSpacerPx).toBeGreaterThan(300_000);
  });
});
