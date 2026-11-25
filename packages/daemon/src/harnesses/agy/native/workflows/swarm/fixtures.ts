import {
  asActivityId,
  asBindingGeneration,
  asRuntimeId,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import type { NativeIngress } from '../../wiring/types.js';

/**
 * Provenance-tagged OFFLINE SYNTHETIC T10 fixtures for NP-08 Swarm & Shared Board.
 *
 * All fixtures in this module are explicitly `synthetic` (NOT live Windows Google captures)
 * and MUST NOT be used to elevate AGY-W04 / AGY-W05 real-device verification levels.
 */
export const NP08_FIXTURE_PROVENANCE = 'synthetic' as const;

export function createSyntheticSwarmBinding(opts?: {
  readonly sessionId?: string;
  readonly instanceId?: string;
  readonly runtimeId?: string;
  readonly generation?: string;
}): RuntimeBinding {
  return {
    runtimeId: asRuntimeId(opts?.runtimeId ?? 'nrt_np08_t10'),
    sessionId: opts?.sessionId ?? 'sess_np08_t10',
    instanceId: opts?.instanceId ?? 'agy',
    generation: asBindingGeneration(opts?.generation ?? 'gen_np08_1'),
  };
}

/**
 * T10-A: Full structured synthetic Swarm lifecycle:
 * 1. Coordinator start
 * 2. Worker (`worker-alpha`) + Verifier (`verifier-1`) registered with real native worker IDs
 * 3. Worker enters `idle` (MUST NOT count as succeeded!)
 * 4. Board post with `@worker-alpha` mention + thread reply
 * 5. Worker wakes `idle -> running` after real mention
 * 6. Worker completes (`finished` + `succeeded`), Verifier fails (`failed`)
 * 7. Coordinator settles (`finished`)
 */
export function createT10FullStructuredSwarmFrames(opts: {
  readonly binding: RuntimeBinding;
  readonly connectionId?: string;
  readonly rootNativeSessionId?: string;
  readonly swarmNativeId?: string;
}): {
  readonly provenance: typeof NP08_FIXTURE_PROVENANCE;
  readonly originActivityId: ReturnType<typeof asActivityId>;
  readonly rootNativeSessionId: string;
  readonly swarmNativeId: string;
  readonly workerNativeId: string;
  readonly verifierNativeId: string;
  readonly frames: readonly NativeIngress[];
} {
  const connectionId = opts.connectionId ?? 'conn_t10_a';
  const rootNativeSessionId = opts.rootNativeSessionId ?? 'native_root_t10_a';
  const swarmNativeId = opts.swarmNativeId ?? 'swarm_run_t10_a';
  const workerNativeId = 'native_worker_alpha_01';
  const verifierNativeId = 'native_verifier_01';
  const originActivityId = asActivityId('act_t10_origin_01');

  const mkFrame = (ingressOrdinal: number, update: Record<string, unknown>, originSession = rootNativeSessionId): NativeIngress => ({
    binding: opts.binding,
    connectionId,
    ingressOrdinal,
    channel: 'live',
    originSession,
    wire: {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: originSession,
        update,
      },
    },
  });

  const frames: NativeIngress[] = [
    // 1. Coordinator started
    mkFrame(1, {
      sessionUpdate: 'swarm_coordinator_update',
      eventId: 'evt_t10_01',
      swarmId: swarmNativeId,
      originActivityId,
      objective: 'Verify Swarm worker wake, board thread pagination, and verifier failure',
      status: 'running',
      boardStatus: 'available',
      summary: 'Coordinator initialized Swarm session',
    }),
    // 2. Worker alpha announced with verified native worker ID
    mkFrame(2, {
      sessionUpdate: 'swarm_worker_update',
      eventId: 'evt_t10_02',
      swarmId: swarmNativeId,
      nativeWorkerId: workerNativeId,
      parentSessionId: rootNativeSessionId,
      rosterName: 'worker-alpha',
      role: 'worker',
      model: 'gemini-3.8-flash',
      foreground: 'running',
      state: 'running',
    }),
    // 3. Verifier announced with verified native worker ID
    mkFrame(3, {
      sessionUpdate: 'swarm_worker_update',
      eventId: 'evt_t10_03',
      swarmId: swarmNativeId,
      nativeWorkerId: verifierNativeId,
      parentSessionId: rootNativeSessionId,
      rosterName: 'verifier-1',
      role: 'verifier',
      foreground: 'idle',
      state: 'waiting',
    }),
    // 4. Worker alpha goes idle (NOT finished/succeeded!)
    mkFrame(4, {
      sessionUpdate: 'swarm_worker_update',
      eventId: 'evt_t10_04',
      swarmId: swarmNativeId,
      nativeWorkerId: workerNativeId,
      parentSessionId: rootNativeSessionId,
      rosterName: 'worker-alpha',
      role: 'worker',
      foreground: 'idle',
      state: 'waiting',
    }),
    // 5. Board post #1 (root post)
    mkFrame(5, {
      sessionUpdate: 'swarm_board_post',
      eventId: 'evt_t10_05',
      swarmId: swarmNativeId,
      postId: 'post_t10_001',
      authorNativeId: rootNativeSessionId,
      authorLabel: 'coordinator',
      summary: 'Kickoff thread: @worker-alpha please inspect auth guard',
      mentions: ['worker-alpha'],
      isSystemWake: false,
      createdAt: 1_764_100_005_000,
    }),
    // 6. Board post #2 (thread reply with system attribution)
    mkFrame(6, {
      sessionUpdate: 'swarm_board_post',
      eventId: 'evt_t10_06',
      swarmId: swarmNativeId,
      postId: 'post_t10_002',
      threadId: 'post_t10_001',
      authorNativeId: workerNativeId,
      authorLabel: 'worker-alpha',
      summary: 'System wake received; starting check on auth guard',
      mentions: [],
      isSystemWake: true,
      createdAt: 1_764_100_006_000,
    }),
    // 7. Worker alpha wakes idle -> running after real mention
    mkFrame(7, {
      sessionUpdate: 'swarm_worker_update',
      eventId: 'evt_t10_07',
      swarmId: swarmNativeId,
      nativeWorkerId: workerNativeId,
      parentSessionId: rootNativeSessionId,
      rosterName: 'worker-alpha',
      role: 'worker',
      foreground: 'running',
      state: 'running',
    }, workerNativeId),
    // 8. Board post #3 (verifier handoff)
    mkFrame(8, {
      sessionUpdate: 'swarm_board_post',
      eventId: 'evt_t10_08',
      swarmId: swarmNativeId,
      postId: 'post_t10_003',
      threadId: 'post_t10_001',
      authorNativeId: workerNativeId,
      authorLabel: 'worker-alpha',
      summary: 'Patch ready for @verifier-1 review',
      mentions: ['verifier-1'],
      createdAt: 1_764_100_008_000,
    }),
    // 9. Worker alpha finishes with explicit succeeded outcome
    mkFrame(9, {
      sessionUpdate: 'swarm_worker_update',
      eventId: 'evt_t10_09',
      swarmId: swarmNativeId,
      nativeWorkerId: workerNativeId,
      parentSessionId: rootNativeSessionId,
      rosterName: 'worker-alpha',
      role: 'worker',
      foreground: 'idle',
      state: 'finished',
      outcome: 'succeeded',
    }, workerNativeId),
    // 10. Verifier wakes & fails explicitly
    mkFrame(10, {
      sessionUpdate: 'swarm_worker_update',
      eventId: 'evt_t10_10',
      swarmId: swarmNativeId,
      nativeWorkerId: verifierNativeId,
      parentSessionId: rootNativeSessionId,
      rosterName: 'verifier-1',
      role: 'verifier',
      foreground: 'running',
      state: 'running',
    }, verifierNativeId),
    mkFrame(11, {
      sessionUpdate: 'swarm_worker_update',
      eventId: 'evt_t10_11',
      swarmId: swarmNativeId,
      nativeWorkerId: verifierNativeId,
      parentSessionId: rootNativeSessionId,
      rosterName: 'verifier-1',
      role: 'verifier',
      foreground: 'idle',
      state: 'failed',
      outcome: 'failed',
    }, verifierNativeId),
    // 12. Coordinator settles
    mkFrame(12, {
      sessionUpdate: 'swarm_coordinator_update',
      eventId: 'evt_t10_12',
      swarmId: swarmNativeId,
      status: 'finished',
      summary: 'Coordinator settled after worker completion and verifier report',
    }),
  ];

  return {
    provenance: NP08_FIXTURE_PROVENANCE,
    originActivityId,
    rootNativeSessionId,
    swarmNativeId,
    workerNativeId,
    verifierNativeId,
    frames,
  };
}

/**
 * T10-B: Upstream-limited Swarm without ACP Board feed and with tool-title-only spawn call.
 * Proves:
 * - Board stays `upstream_limited`
 * - Coordinator trace is captured
 * - Tool title `"swarm add worker-ghost"` does NOT fabricate a worker in `workerIds`
 */
export function createT10UpstreamLimitedSwarmFrames(opts: {
  readonly binding: RuntimeBinding;
  readonly connectionId?: string;
  readonly rootNativeSessionId?: string;
}): readonly NativeIngress[] {
  const connectionId = opts.connectionId ?? 'conn_t10_b';
  const rootNativeSessionId = opts.rootNativeSessionId ?? 'native_root_t10_b';

  return [
    {
      binding: opts.binding,
      connectionId,
      ingressOrdinal: 1,
      channel: 'live',
      originSession: rootNativeSessionId,
      wire: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: rootNativeSessionId,
          update: {
            sessionUpdate: 'swarm_coordinator_update',
            swarmId: 'swarm_run_t10_b',
            objective: 'Inspect upstream-limited Swarm without Board feed',
            status: 'running',
            boardStatus: 'upstream_limited',
            boardUnavailableReason: 'acp_swarm_board_not_exposed',
            summary: 'Coordinator active; ACP stream does not expose Board posts',
          },
        },
      },
    },
    {
      binding: opts.binding,
      connectionId,
      ingressOrdinal: 2,
      channel: 'live',
      originSession: rootNativeSessionId,
      wire: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: rootNativeSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_swarm_add_ghost',
            toolName: 'swarm',
            title: 'Run swarm add worker-ghost',
            status: 'running',
            rawInput: {
              action: 'add',
              name: 'worker-ghost',
              brief: 'Should never create a worker without verified native worker ID',
            },
          },
        },
      },
    },
  ];
}
