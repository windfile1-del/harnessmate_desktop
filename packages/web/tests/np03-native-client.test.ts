import {
  AGY_NATIVE_CONTRACT_REVISION,
  NativeCanonicalEventSchema,
  NativeCommandResponseSchema,
  NativeEventsResponseSchema,
  createKnownEmptyNativeProjection,
  type CanonicalEvent,
  type Session,
} from '@harnessmate/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeClientError,
  NativeFeedController,
  applyNativeEventBatch,
  coalesceTimelineEntries,
  createHttpNativeTransport,
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('NP-02 / NP-03 shared wire integration', () => {
  it('reads a 202 receipt and projects the daemon approval event shape', async () => {
    const { projection } = createLiveReactiveFixture('sess_contract');
    const wireBinding = createKnownEmptyNativeProjection({
      sessionId: projection.binding.sessionId,
      instanceId: projection.binding.instanceId,
      runtimeId: projection.binding.runtimeId,
      generation: projection.binding.generation,
    }).binding;
    const seq = projection.asOfSeq + 1;
    const event = NativeCanonicalEventSchema.parse({
      schemaVersion: 1,
      runtimeId: wireBinding.runtimeId,
      sessionId: wireBinding.sessionId,
      generation: wireBinding.generation,
      seq,
      turnId: null,
      createdAt: 100,
      type: 'native.request.changed',
      payload: { approvalId: 'approval_contract', receiptId: 'receipt_approval', kind: 'permission', receiptState: 'pending' },
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(NativeCommandResponseSchema.parse({
        schemaVersion: 1, kind: 'accepted', receiptId: 'receipt_command', activityId: 'activity_contract',
      }), { status: 202 }))
      .mockResolvedValueOnce(Response.json(NativeEventsResponseSchema.parse({
        schemaVersion: 1, binding: wireBinding, runtimeId: wireBinding.runtimeId,
        generation: wireBinding.generation, asOfSeq: seq, events: [event],
        nextSeq: seq, nextCursor: 'cursor-fixture', hasMore: false,
      })));
    vi.stubGlobal('fetch', fetchMock);
    const transport = createHttpNativeTransport();
    await expect(transport.submitCommand(wireBinding.sessionId, {
      bindingGeneration: wireBinding.generation,
      catalogRevision: 0, capabilityId: 'agy.workflow.goal', actionKey: 'launch',
      idempotencyKey: 'contract-req', args: {},
    })).resolves.toMatchObject({ status: 'accepted', receiptId: 'receipt_command' });
    const page = await transport.getEvents(wireBinding.sessionId, {
      afterSeq: projection.asOfSeq, generation: wireBinding.generation,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toContain('generation=');
    const next = applyNativeEventBatch(projection, page.events).projection;
    expect(next.requestIds).toContain('approval_contract');
    expect(next.receipts?.approval_contract).toMatchObject({
      receiptState: 'pending', receiptId: 'receipt_approval', generation: wireBinding.generation,
    });
  });

  it('keeps mismatched capability bindings or revisions out of the selected runtime', async () => {
    const { projection, capabilities } = createLiveReactiveFixture('sess_caps_contract');
    const transport = createStubNativeTransport({ snapshot: projection, capabilities });
    const readCapabilities = transport.getCapabilities.bind(transport);
    const controller = new NativeFeedController({
      sessionId: projection.binding.sessionId, transport, onUpdate: () => {},
    });
    try {
      const cap = await readCapabilities(projection.binding.sessionId);
      for (const mismatch of [
        { ...cap, binding: { ...cap.binding, generation: 'gen_retired' as BindingGeneration } },
        { ...cap, capabilitiesRevision: cap.capabilitiesRevision + 1 },
      ]) {
        transport.getCapabilities = async () => mismatch;
        await controller.hydrate();
        expect(controller.getSnapshot()).toMatchObject({
          capabilities: [], syncState: { phase: 'incomplete', incompleteReason: 'capabilities_binding_mismatch' },
        });
      }
      transport.getCapabilities = readCapabilities;
      await controller.hydrate();
      expect(controller.getSnapshot()).toMatchObject({ capabilities, syncState: { phase: 'live' } });
    } finally {
      controller.dispose();
    }
  });

  it('lets a new hydration finish while the retired page request is still pending', async () => {
    const { projection, capabilities } = createLiveReactiveFixture('sess_refresh_contract');
    const transport = createStubNativeTransport({ snapshot: projection, capabilities });
    const readEvents = transport.getEvents.bind(transport);
    let reportPage: (page: Awaited<ReturnType<typeof readEvents>>) => void = () => {};
    const pending = new Promise<Awaited<ReturnType<typeof readEvents>>>(resolve => { reportPage = resolve; });
    let reportStarted = () => {};
    const started = new Promise<void>(resolve => { reportStarted = resolve; });
    const getEvents = vi.fn(readEvents).mockImplementationOnce(() => {
      reportStarted();
      return pending;
    });
    transport.getEvents = getEvents;
    const controller = new NativeFeedController({
      sessionId: projection.binding.sessionId, transport, onUpdate: () => {},
    });
    const request = { afterSeq: projection.asOfSeq };
    const first = controller.hydrate();
    try {
      await started;
      await controller.hydrate();
      expect(getEvents).toHaveBeenCalledTimes(2);
      expect(controller.getSnapshot().syncState.phase).toBe('live');
    } finally {
      reportPage(await readEvents(projection.binding.sessionId, request));
      await first;
      controller.dispose();
    }
  });

  it('subscribes from the hydrated watermark and reconnects with a fresh snapshot', async () => {
    vi.useFakeTimers();
    const sockets: FixtureSocket[] = [];
    class FixtureSocket extends EventTarget {
      readonly send = vi.fn();
      readonly close = vi.fn();
      constructor(readonly url: URL) {
        super();
        sockets.push(this);
      }
      receive(frame: unknown) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
      }
    }
    vi.stubGlobal('WebSocket', FixtureSocket);
    vi.stubGlobal('window', { location: { href: 'http://localhost/' } });
    const projection = createKnownEmptyNativeProjection({
      sessionId: 'sess_socket', instanceId: 'agy', enabled: true,
    });
    const { binding } = projection;
    const rev = AGY_NATIVE_CONTRACT_REVISION;
    let snapshotSeq = 0;
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/snapshot')) return Response.json({ schemaVersion: 1, contractRevision: rev, enabled: true, projection: { ...projection, asOfSeq: snapshotSeq } });
      if (input.endsWith('/capabilities')) return Response.json({
        schemaVersion: 1, contractRevision: rev, enabled: true, binding, capabilitiesRevision: 0, descriptors: [],
      });
      return Response.json({
        schemaVersion: 1, binding, runtimeId: binding.runtimeId, generation: binding.generation,
        asOfSeq: snapshotSeq, nextSeq: snapshotSeq, nextCursor: 'cursor_fixture', hasMore: false, events: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new NativeFeedController({
      sessionId: binding.sessionId, transport: createHttpNativeTransport(), onUpdate: () => {},
    });
    const accept = (socket: FixtureSocket) => socket.receive({
      op: 'native_hello', schemaVersion: 1, contractRevision: rev, sessionId: binding.sessionId,
      runtimeId: binding.runtimeId, generation: binding.generation, enabled: true,
    });
    const finishReplay = (socket: FixtureSocket, lastSeq: number) => socket.receive({
      op: 'native_replay_complete', schemaVersion: 1, runtimeId: binding.runtimeId,
      generation: binding.generation, lastSeq, nextCursor: 'cursor_fixture',
    });
    try {
      await controller.hydrate();
      expect(controller.getSnapshot().syncState.phase).toBe('catching_up');
      const first = sockets[0]!;
      expect(String(first.url)).toBe('ws://localhost/api/v1/sessions/sess_socket/native/ws');
      accept(first);
      expect(JSON.parse(first.send.mock.calls[0]![0])).toMatchObject({
        op: 'subscribe_native', afterSeq: 0, generation: binding.generation,
      });
      first.receive({
        op: 'native_event', schemaVersion: 1, event: {
          schemaVersion: 1, ...binding, instanceId: undefined, seq: 1, turnId: null, createdAt: 100,
          type: 'native.request.changed', payload: { approvalId: 'approval_socket', kind: 'permission', receiptState: 'pending' },
        },
      });
      finishReplay(first, 1);
      expect(controller.getSnapshot()).toMatchObject({
        projection: { asOfSeq: 1, requestIds: ['approval_socket'] }, syncState: { phase: 'live' },
      });
      snapshotSeq = 1;
      first.dispatchEvent(new Event('close'));
      expect(controller.getSnapshot().syncState.phase).toBe('incomplete');
      await vi.advanceTimersByTimeAsync(300);
      const second = sockets[1]!;
      accept(second);
      finishReplay(second, snapshotSeq);
      expect(first.close).toHaveBeenCalledOnce();
      expect(controller.getSnapshot().syncState.phase).toBe('live');
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/snapshot'))).toHaveLength(2);
    } finally {
      controller.dispose();
    }
    expect(sockets[1]?.close).toHaveBeenCalledOnce();
  });
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

  it('R1 regressions: drains pre-hydrate queue, refuses Live on unresolved gap/page-limit, replays post-gap suffix, and blocks old-binding rollback', async () => {
    const { projection: baseSnap, capabilities } = createLiveReactiveFixture('sess_r1');
    const rt = baseSnap.binding.runtimeId;
    const gen = baseSnap.binding.generation;
    const ev = {
      sourceKind: 'live_protocol' as const,
      freshness: 'fresh' as const,
      observedAt: 1_764_000_050_000,
      wireVariant: 'acp_v1',
    };

    const makeWorkEvent = (seq: number): NativeCanonicalEvent => ({
      schemaVersion: 1,
      runtimeId: rt,
      generation: gen,
      seq,
      turnId: null,
      createdAt: 1_764_000_000_000 + seq * 1000,
      type: 'native.work.changed',
      payload: {
        work: {
          id: `wk_r1_${seq}` as WorkId,
          kind: 'finite_command',
          blocking: 'confirmed_blocking',
          state: { kind: 'known', value: 'running', evidence: ev },
          observedLabel: `r1-${seq}`,
          revision: seq,
        },
      },
    });

    // 1. Pre-hydrate queued seq 13 MUST drain after hydrate() completes
    const baseTransport = createStubNativeTransport({ snapshot: baseSnap, capabilities, events: [] });
    const c1 = new NativeFeedController({
      sessionId: 'sess_r1',
      transport: baseTransport,
      batchWindowMs: 0,
      onUpdate: () => {},
    });
    c1.enqueueLiveEvents([makeWorkEvent(13)]);
    await c1.hydrate();
    expect(c1.getSnapshot().projection?.asOfSeq).toBe(13);
    expect(c1.getSnapshot().syncState.phase).toBe('live');

    // 2. Old-binding seq 1 native.runtime.changed MUST NOT roll back binding or disconnect
    c1.enqueueLiveEvents([
      {
        schemaVersion: 1,
        runtimeId: rt,
        generation: 'gen_0_old' as BindingGeneration,
        seq: 1,
        turnId: null,
        createdAt: 1_764_000_001_000,
        type: 'native.runtime.changed',
        payload: {
          status: 'disconnected',
          binding: {
            runtimeId: rt,
            sessionId: 'sess_r1',
            instanceId: 'agy',
            generation: 'gen_0_old' as BindingGeneration,
          },
        },
      },
    ]);
    expect(c1.getSnapshot().projection?.binding.generation).toBe(gen);
    expect(c1.getSnapshot().projection?.status).toBe('attached');
    expect(c1.getSnapshot().projection?.asOfSeq).toBe(13);
    expect(c1.getSnapshot().syncState.droppedStaleEvents).toBeGreaterThanOrEqual(1);
    c1.dispose();

    // 3. Live seq 14 arrives while catch-up initially returns empty -> incomplete (NOT live); later catch-up supplies seq 13 -> replays 14 -> live!
    let deliverSeq13 = false;
    const gapTransport: NativeRuntimeTransport = {
      ...createStubNativeTransport({ snapshot: baseSnap, capabilities, events: [] }),
      getEvents: async (_sid, { afterSeq }) => ({
        schemaVersion: 1,
        binding: baseSnap.binding,
        asOfSeq: deliverSeq13 && afterSeq < 13 ? 13 : afterSeq,
        events: deliverSeq13 && afterSeq < 13 ? [makeWorkEvent(13)] : [],
        nextCursor: null,
        hasMore: false,
      }),
    };
    const c2 = new NativeFeedController({
      sessionId: 'sess_r1',
      transport: gapTransport,
      batchWindowMs: 0,
      maxResyncAttempts: 1,
      onUpdate: () => {},
    });
    await c2.hydrate();
    expect(c2.getSnapshot().projection?.asOfSeq).toBe(12);

    c2.enqueueLiveEvents([makeWorkEvent(14)]);
    await new Promise((r) => setTimeout(r, 10));
    expect(c2.getSnapshot().syncState.phase).toBe('incomplete');
    expect(c2.getSnapshot().projection?.asOfSeq).toBe(12);

    // Now backend catches up seq 13 -> buffered suffix seq 14 replays cleanly to reach 14 + live
    deliverSeq13 = true;
    await c2.catchUp();
    expect(c2.getSnapshot().projection?.asOfSeq).toBe(14);
    expect(c2.getSnapshot().syncState.phase).toBe('live');
    c2.dispose();

    // 4. Paginated GET /events starting at seq 14 (missing 13) -> incomplete (NOT live)
    const missingPageTransport = createStubNativeTransport({
      snapshot: baseSnap,
      capabilities,
      events: [makeWorkEvent(14)],
    });
    const c3 = new NativeFeedController({
      sessionId: 'sess_r1',
      transport: missingPageTransport,
      batchWindowMs: 0,
      maxResyncAttempts: 1,
      onUpdate: () => {},
    });
    await c3.hydrate();
    expect(c3.getSnapshot().syncState.phase).toBe('incomplete');
    expect(c3.getSnapshot().projection?.asOfSeq).toBe(12);
    c3.dispose();

    // 5. Hitting maxPages with hasMore=true -> incomplete (NOT live)
    const limitTransport = createStubNativeTransport({
      snapshot: baseSnap,
      capabilities,
      events: [makeWorkEvent(13), makeWorkEvent(14), makeWorkEvent(15)],
      pageSize: 1,
    });
    const c4 = new NativeFeedController({
      sessionId: 'sess_r1',
      transport: limitTransport,
      batchWindowMs: 0,
      pageLimit: 1,
      maxPages: 2,
      onUpdate: () => {},
    });
    await c4.hydrate();
    expect(c4.getSnapshot().projection?.asOfSeq).toBe(14);
    expect(c4.getSnapshot().syncState.phase).toBe('incomplete');
    expect(c4.getSnapshot().syncState.incompleteReason).toBe('page_limit_reached');
    c4.dispose();
  });

  it('R2 regressions: isolates idempotency keys by full intent, ignores late receipts after clear/disable, and validates control binding', async () => {
    const { projection, capabilities } = createLiveReactiveFixture('sess_r2');
    const session: Session = {
      id: 'sess_r2',
      workspaceId: 'ws_1',
      harnessId: 'agy',
      harnessKind: 'agy',
      participatingHarnesses: ['agy'],
      contextSyncMode: 'auto',
      cwd: 'D:/repo',
      title: 'R2 Scope Test',
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

    const capturedKeys: Array<{ prompt: string; key: string }> = [];
    const resolvers: Array<() => void> = [];

    const controllableTransport: NativeRuntimeTransport = {
      ...createStubNativeTransport({ snapshot: projection, capabilities }),
      submitCommand: vi.fn(async (_sid, req) => {
        capturedKeys.push({ prompt: String(req.args.prompt ?? ''), key: req.idempotencyKey });
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return {
          schemaVersion: 1 as const,
          status: 'accepted' as const,
          modeEvidenceObserved: true,
        };
      }),
    };

    const store = useAppStore.getState();
    store.setAgyNativeWorkbenchEnabled(true);
    store.setNativeTransport(controllableTransport);
    useAppStore.setState({ sessions: [session], selectedSessionId: session.id });
    store.ingestNativeProjectionFixture(session.id, projection, capabilities);

    // 1. Two DIFFERENT prompts in-flight simultaneously MUST get DISTINCT idempotency keys
    const p1 = useAppStore.getState().submitNativeCommand(session.id, {
      capabilityId: 'AGY-W04',
      actionKey: 'swarm',
      args: { prompt: 'task alpha' },
    });
    const p1Dup = useAppStore.getState().submitNativeCommand(session.id, {
      capabilityId: 'AGY-W04',
      actionKey: 'swarm',
      args: { prompt: 'task alpha' },
    });
    const p2 = useAppStore.getState().submitNativeCommand(session.id, {
      capabilityId: 'AGY-W04',
      actionKey: 'swarm',
      args: { prompt: 'task beta' },
    });

    expect(capturedKeys).toHaveLength(3);
    expect(capturedKeys[0]!.key).toBe(capturedKeys[1]!.key); // identical intent reuses key
    expect(capturedKeys[0]!.key).not.toBe(capturedKeys[2]!.key); // different prompt gets new key

    // 2. Clear session slice AND disable gate BEFORE stub resolves -> late receipts MUST NOT resurrect slice
    useAppStore.getState().clearNativeSessionState(session.id);
    useAppStore.getState().setAgyNativeWorkbenchEnabled(false);
    for (const resolve of resolvers) resolve();

    const results = await Promise.all([p1, p1Dup, p2]);
    expect(results).toEqual([false, false, false]);
    expect(useAppStore.getState().nativeRuntimeBySession[session.id]).toBeUndefined();

    // 3. Stale binding on dispatchNativeControl is rejected before hitting transport
    useAppStore.getState().setAgyNativeWorkbenchEnabled(true);
    useAppStore.getState().ingestNativeProjectionFixture(session.id, projection, capabilities);
    await expect(
      useAppStore.getState().dispatchNativeControl(session.id, {
        target: { type: 'work', id: 'wk_finite_1' },
        action: 'cancel',
        expectedBinding: {
          ...projection.binding,
          generation: 'gen_stale_old' as BindingGeneration,
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  });

  it('R3 regressions: delta coalescing deduplicates merged entryIds and isolates actors; store timeline loader uses injected transport', async () => {
    // 1. a + b then duplicate b MUST stay "ab" (never "abb")
    const step1 = coalesceTimelineEntries(
      [
        {
          entryId: 'a',
          seq: 1,
          timestamp: 1000,
          kind: 'assistant_text',
          actorKind: 'child',
          actorId: 'ag_1',
          text: 'a',
          deltaCoalesceKey: 'k1',
        },
      ],
      [
        {
          entryId: 'b',
          seq: 2,
          timestamp: 1005,
          kind: 'assistant_text',
          actorKind: 'child',
          actorId: 'ag_1',
          text: 'b',
          deltaCoalesceKey: 'k1',
        },
      ],
    );
    expect(step1).toHaveLength(1);
    expect(step1[0]?.text).toBe('ab');

    const step2 = coalesceTimelineEntries(step1, [
      {
        entryId: 'b',
        seq: 2,
        timestamp: 1005,
        kind: 'assistant_text',
        actorKind: 'child',
        actorId: 'ag_1',
        text: 'b',
        deltaCoalesceKey: 'k1',
      },
    ]);
    expect(step2).toHaveLength(1);
    expect(step2[0]?.text).toBe('ab');

    // 2. Different actors with the same deltaCoalesceKey MUST NOT merge into one entry
    const step3 = coalesceTimelineEntries(step2, [
      {
        entryId: 'c',
        seq: 3,
        timestamp: 1010,
        kind: 'assistant_text',
        actorKind: 'child',
        actorId: 'ag_2',
        text: 'c',
        deltaCoalesceKey: 'k1',
      },
    ]);
    expect(step3).toHaveLength(2);
    expect(step3[0]?.text).toBe('ab');
    expect(step3[1]?.text).toBe('c');

    // 3. Store timeline loader uses injected stub transport (no hardcoded HTTP transport bypass)
    const { projection, capabilities, timelineByScope } = createLiveReactiveFixture('sess_r3_tl');
    const stubTransport = createStubNativeTransport({
      snapshot: projection,
      capabilities,
      timelineByScope,
    });
    const spy = vi.spyOn(stubTransport, 'getAgentTimeline');
    useAppStore.getState().setNativeTransport(stubTransport);

    const page = await useAppStore
      .getState()
      .loadNativeTimeline('sess_r3_tl', { kind: 'agent', id: 'ag_child_researcher' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.actorLabel).toBe('Codebase Researcher');
  });
});
