import { describe, expect, it } from 'vitest';
import {
  AGY_ACCOUNTS_CONTRACT,
  AGY_RUNTIME_CONTRACT,
  AGY_WORKBENCH_CONTRACT,
  ALL_PLUGIN_SLOT_KEYS,
  PEER_CONTRACTS,
  agyRuntimeStreamKey,
  compareAgyRuntimeCursors,
  isPeerContractName,
  isSameAgyRuntimeStream,
} from '@harnessmate/plugin-api';
import {
  createAgyLegacyApprovalBridgeSample,
  createAgyNativeReplayFixture,
  createMockPluginHost,
} from '@harnessmate/plugin-sdk/testing';

describe('B4-W1 AGY public contracts, identity mapping, replay & W2 approval bridge fixtures', () => {
  it('registers AGY peer contracts and embedded session stage slot in public plugin-api', () => {
    expect(PEER_CONTRACTS.agyRuntime).toBe(AGY_RUNTIME_CONTRACT);
    expect(PEER_CONTRACTS.agyAccounts).toBe(AGY_ACCOUNTS_CONTRACT);
    expect(PEER_CONTRACTS.agyWorkbench).toBe(AGY_WORKBENCH_CONTRACT);
    expect(isPeerContractName(AGY_RUNTIME_CONTRACT)).toBe(true);
    expect(isPeerContractName(AGY_ACCOUNTS_CONTRACT)).toBe(true);
    expect(isPeerContractName(AGY_WORKBENCH_CONTRACT)).toBe(true);
    expect(ALL_PLUGIN_SLOT_KEYS).toContain('session.stage.embedded');
  });

  it('distinguishes pluginInstanceId from legacy profileInstanceId and isolates cross-instance/generation cursors', () => {
    const fixtureA = createAgyNativeReplayFixture({
      pluginId: 'core.harness.agy',
      pluginInstanceId: 'harness-agy-work',
      profileInstanceId: 'agy-work',
      harnessId: 'agy-work',
      runId: 'run-a-1',
      runtimeId: 'rt_a',
      generation: 'gen_1',
    });
    const fixtureB = createAgyNativeReplayFixture({
      pluginId: 'hm.plugin.agy-driver-lite',
      pluginInstanceId: 'agy-lite-ws-b',
      profileInstanceId: 'agy',
      harnessId: 'agy-lite-ws-b:agy',
      runId: 'run-b-1',
      runtimeId: 'rt_b',
      generation: 'gen_1',
    });

    expect(fixtureA.identity.pluginInstanceId).toBe('harness-agy-work');
    expect(fixtureA.identity.profileInstanceId).toBe('agy-work');
    expect(fixtureA.identity.driverProviderInstanceId).toBe('harness-agy-work');
    expect(fixtureA.identity.pluginInstanceId).not.toBe(fixtureB.identity.pluginInstanceId);
    expect(agyRuntimeStreamKey(fixtureA.stream)).not.toBe(agyRuntimeStreamKey(fixtureB.stream));
    expect(isSameAgyRuntimeStream(fixtureA.stream, fixtureB.stream)).toBe(false);

    // Same stream cursor ordering
    expect(
      compareAgyRuntimeCursors(
        { stream: fixtureA.stream, seq: 3 },
        { stream: fixtureA.stream, seq: 7 },
      ),
    ).toBe(-1);

    // Cross-instance cursor comparison must return null (forces resync)
    expect(
      compareAgyRuntimeCursors(
        { stream: fixtureA.stream, seq: 3 },
        { stream: fixtureB.stream, seq: 7 },
      ),
    ).toBeNull();

    // Generation advance creates a distinct stream; cross-generation comparison returns null
    const nextGen = fixtureA.advanceGeneration('gen_2');
    expect(nextGen.binding.bindingRevision).toBe(2);
    expect(
      compareAgyRuntimeCursors(
        { stream: fixtureA.stream, seq: 10 },
        { stream: nextGen.stream, seq: 1 },
      ),
    ).toBeNull();
  });

  it('provides runnable replay coverage for all AGY native workflow families and allows external agy driver registration in SDK mock host', async () => {
    const replay = createAgyNativeReplayFixture();
    const kinds = new Set(replay.workflowSamples.map((s) => s.workflowKind));
    expect([...kinds].sort()).toEqual([
      'artifacts',
      'boost',
      'dynamic',
      'reactive',
      'subagents',
      'swarm',
      'tasks',
      'teamwork',
    ]);
    expect(replay.settlementDecision.action).toBe('hold');
    expect(replay.settlementDecision.settlementRef).toContain(replay.identity.pluginInstanceId);

    // Pure-SDK mock host allows registering driverId: 'agy' without reservation error
    const host = createMockPluginHost({
      pluginId: 'hm.plugin.agy-driver-lite',
      permissions: ['harness:driver:register', 'storage:plugin'],
    });
    host.ctx.harnesses.registerDriver({
      driverId: 'agy',
      displayName: 'AGY Lite',
      description: 'External AGY driver',
      protocolLabel: 'agy-lite',
      capabilities: {
        streaming: true,
        interactiveApproval: true,
        reasoningEfforts: ['medium'],
        permissionModes: ['manual', 'auto'],
        sessionResume: true,
        sessionFork: false,
        imageInput: false,
        subagents: true,
      },
      probe: async () => ({
        binaryPath: '/virtual/agy',
        version: '1.0.0',
        health: 'ready',
        models: [],
      }),
      createSession: async () => ({
        nativeSessionId: 'conv_lite_1',
        pluginMcpAvailable: false,
        sendTurn: async () => ({ driverUsed: 'native_warm' }),
        interrupt: async () => {},
        onEvent: () => () => {},
        dispose: async () => {},
      }),
    });
    expect(host.drivers.has('agy')).toBe(true);
    host.dispose();
  });

  it('executes the temporary W1 -> W2 legacy approval narrow adapter with native options, CAS, deadline, and once-only settlement', () => {
    let clock = 1_700_000_000_000;
    const bridge = createAgyLegacyApprovalBridgeSample({
      now: () => clock,
      defaultDeadlineMs: 10_000,
    });
    const replay = createAgyNativeReplayFixture({
      pluginId: 'core.harness.agy',
      pluginInstanceId: 'harness-agy',
      profileInstanceId: 'agy',
      harnessId: 'agy',
    });

    const req = bridge.registerRequest({
      approvalId: 'appr_nat_demo_1',
      nativeRequestId: 'rpc_42',
      binding: replay.binding,
      toolName: 'run_shell',
      summary: 'Run unit tests',
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    expect(req.bindingRevision).toBe(1);
    expect(req.deadlineAtMs).toBe(clock + 10_000);

    // Stale generation is fenced
    const staleRes = bridge.resolveRequest({
      approvalId: req.approvalId,
      sessionId: req.sessionId,
      selectedOptionId: 'allow_once',
      resolvedBy: 'desktop',
      idempotencyKey: 'idem-stale',
      expectedGeneration: 'gen_old',
    });
    expect(staleRes.accepted).toBe(false);
    expect(staleRes.staleGeneration).toBe(true);

    // Wrong binding revision triggers CAS conflict
    const casConflict = bridge.resolveRequest({
      approvalId: req.approvalId,
      sessionId: req.sessionId,
      selectedOptionId: 'allow_once',
      resolvedBy: 'desktop',
      idempotencyKey: 'idem-cas',
      expectedBindingRevision: 99,
    });
    expect(casConflict.accepted).toBe(false);
    expect(casConflict.conflict).toBe(true);

    // First valid resolution wins and is idempotent under same key
    const accepted = bridge.resolveRequest({
      approvalId: req.approvalId,
      sessionId: req.sessionId,
      selectedOptionId: 'allow_once',
      resolvedBy: 'desktop',
      idempotencyKey: 'idem-win',
      expectedBindingRevision: 1,
      expectedGeneration: replay.binding.generation,
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.receiptState).toBe('delivered');
    expect(accepted.settlementRef).toBeTruthy();

    const idempotentReplay = bridge.resolveRequest({
      approvalId: req.approvalId,
      sessionId: req.sessionId,
      selectedOptionId: 'allow_once',
      resolvedBy: 'desktop',
      idempotencyKey: 'idem-win',
      expectedBindingRevision: 1,
      expectedGeneration: replay.binding.generation,
    });
    expect(idempotentReplay).toEqual(accepted);

    // Competing caller with different idempotency key sees conflict / already_settled
    const competing = bridge.resolveRequest({
      approvalId: req.approvalId,
      sessionId: req.sessionId,
      selectedOptionId: 'reject_once',
      resolvedBy: 'mobile',
      idempotencyKey: 'idem-race',
    });
    expect(competing.accepted).toBe(false);
    expect(competing.conflict).toBe(true);
    expect(competing.receiptState).toBe('already_settled');

    // Once-only settlement receipt acknowledgement
    expect(bridge.acknowledgeSettlement(accepted.settlementRef!)).toEqual({
      acknowledged: true,
      duplicate: false,
    });
    expect(bridge.acknowledgeSettlement(accepted.settlementRef!)).toEqual({
      acknowledged: false,
      duplicate: true,
    });

    // Deadline expiry path
    const req2 = bridge.registerRequest({
      approvalId: 'appr_nat_demo_2',
      nativeRequestId: 'rpc_43',
      binding: replay.binding,
      toolName: 'write_file',
      summary: 'Write config',
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      deadlineMs: 5_000,
    });
    clock += 6_000;
    const expired = bridge.resolveRequest({
      approvalId: req2.approvalId,
      sessionId: req2.sessionId,
      selectedOptionId: 'allow_once',
      resolvedBy: 'desktop',
      idempotencyKey: 'idem-late',
    });
    expect(expired.accepted).toBe(false);
    expect(expired.receiptState).toBe('expired');
  });
});
