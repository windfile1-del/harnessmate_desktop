import { describe, expect, it } from 'vitest';
import {
  compareSessionDataCursors,
  isSameSessionDataStream,
  LEGACY_SESSION_DATA_CONTRACT,
  PEER_CONTRACTS,
  PEER_CONTRACT_VERSIONS,
  SESSION_DATA_CONTRACT,
  SESSION_RUNTIME_CONTRACT,
  sessionDataStreamKey,
  type SessionDataCursor,
  type SessionDataStreamIdentity,
} from '@harnessmate/plugin-api';
import {
  createDeterministicMockDriverFixture,
  createLegacySessionDataFixture,
  replayAdapterTranscript,
} from '@harnessmate/plugin-sdk/testing';

describe('B3-W1 C1: session data/runtime contracts, cursors, and fixtures', () => {
  it('registers session.data.v1, session.runtime.v1, and hm.session-data.v1 in public peer contracts', () => {
    expect(PEER_CONTRACTS.sessionData).toBe(SESSION_DATA_CONTRACT);
    expect(PEER_CONTRACTS.sessionRuntime).toBe(SESSION_RUNTIME_CONTRACT);
    expect(PEER_CONTRACTS.hmSessionData).toBe(LEGACY_SESSION_DATA_CONTRACT);
    expect(PEER_CONTRACT_VERSIONS['session.data.v1']).toBe('1.0.0');
    expect(PEER_CONTRACT_VERSIONS['session.runtime.v1']).toBe('1.0.0');
    expect(PEER_CONTRACT_VERSIONS['hm.session-data.v1']).toBe('1.0.0');
  });

  it('scopes stream cursors by providerInstanceId and streamId and refuses cross-stream seq comparison', () => {
    const streamA: SessionDataStreamIdentity = {
      providerInstanceId: 'hm.plugin.session-data-default',
      streamId: 'default-sqlite-001',
    };
    const streamB: SessionDataStreamIdentity = {
      providerInstanceId: 'hm.plugin.session-data-lite',
      streamId: 'lite-mem-001',
    };

    expect(isSameSessionDataStream(streamA, { ...streamA })).toBe(true);
    expect(isSameSessionDataStream(streamA, streamB)).toBe(false);
    expect(sessionDataStreamKey(streamA)).toBe('hm.plugin.session-data-default::default-sqlite-001');

    const c1: SessionDataCursor = { ...streamA, seq: 10 };
    const c2: SessionDataCursor = { ...streamA, seq: 15 };
    const foreign: SessionDataCursor = { ...streamB, seq: 2 };

    expect(compareSessionDataCursors(c1, c2)).toBe(-5);
    expect(compareSessionDataCursors(c2, c1)).toBe(5);
    expect(compareSessionDataCursors(c1, foreign)).toBeNull();
  });

  it('produces deterministic legacy B2 session data fixtures', () => {
    const fixture = createLegacySessionDataFixture();
    expect(fixture.workspace.id).toBe('ws_legacy_fixture_1');
    expect(fixture.session.id).toBe('sess_legacy_fixture_1');
    expect(fixture.session.nativeSessionId).toBe('native_legacy_thread_001');
    expect(fixture.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(fixture.turnItems).toHaveLength(2);
    expect(fixture.runs[0]?.status).toBe('completed');
    expect(fixture.bindings[0]?.syncedUpToSeq).toBe(4);
    expect(fixture.nativeImportMapping.sessionId).toBe(fixture.session.id);
  });

  it('supports deterministic streaming, manual interrupt, late callback injection, config modes, and unknown dispatch failure', async () => {
    const ctrl = createDeterministicMockDriverFixture({
      driverId: 'mock-c1',
      defaultScript: { chunks: ['Hello ', 'W1!'] },
    });

    const replay = await replayAdapterTranscript(ctrl.driver, [], { prompt: 'hi' });
    replay.assert({
      terminalType: 'turn.completed',
      assistantTextContains: 'Hello W1!',
      eventTypes: ['native_session_ready', 'turn.started', 'message.assistant.delta', 'turn.completed'],
    });

    const handle = await ctrl.driver.createSession({
      cwd: 'D:/HarnessMate/b3-tmp/w1',
      permissionMode: 'manual',
    });
    const observed: string[] = [];
    handle.onEvent((ev) => {
      if (ev.type === 'message.assistant.delta') observed.push(`delta:${ev.text}`);
      else observed.push(ev.type);
    });

    ctrl.setNextTurnScript({ manualControl: true, chunks: ['part1-'] });
    await handle.sendTurn({ turnId: 't_manual', text: 'stream' });
    ctrl.emitDelta('t_manual', 'part2');
    await handle.interrupt();
    ctrl.emitLateEvent({ type: 'message.assistant.delta', turnId: 't_manual', text: 'late-ghost' });

    expect(observed).toContain('delta:part1-');
    expect(observed).toContain('delta:part2');
    expect(observed).toContain('turn.cancelled');
    expect(ctrl.interrupts).toEqual(['t_manual']);

    await handle.updateConfig?.({ model: 'mock-model-2' });
    expect(ctrl.appliedConfigs).toEqual([{ model: 'mock-model-2' }]);

    ctrl.setConfigMode('unsupported');
    await expect(handle.updateConfig?.({ model: 'mock-model-3' })).rejects.toThrow(/unsupported/i);

    ctrl.setNextTurnScript({ failAfterDispatch: true });
    await expect(handle.sendTurn({ turnId: 't_unknown', text: 'boom' })).rejects.toThrow(/Unknown dispatch outcome/);

    await handle.dispose();
    expect(ctrl.disposedHandles).toBe(2);
  });
});
