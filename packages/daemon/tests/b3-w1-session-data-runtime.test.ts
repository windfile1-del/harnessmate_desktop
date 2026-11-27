import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  PEER_CONTRACTS,
  type SessionDataServiceV1,
  type SessionRuntimeServiceV1,
} from '@harnessmate/plugin-api';
import {
  createDeterministicMockDriverFixture,
  createLegacySessionDataFixture,
  type DeterministicMockDriverController,
} from '@harnessmate/plugin-sdk/testing';
import type { HarnessInfo } from '@harnessmate/protocol';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../src/harnesses/types.js';
import { auditPluginPackage } from '../src/plugins/plugin-static-audit.js';
import { SESSION_DATA_DEFAULT_PLUGIN_ID } from '../src/plugins/session-data-default/index.js';
import { SESSION_RUNTIME_DEFAULT_PLUGIN_ID } from '../src/plugins/session-runtime-default/index.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const dataLiteDir = path.join(repoRoot, 'plugins', 'examples', 'hm.plugin.session-data-lite');
const runtimeLiteDir = path.join(repoRoot, 'plugins', 'examples', 'hm.plugin.session-runtime-lite');
const searchLiteDir = path.join(repoRoot, 'plugins', 'examples', 'hm.plugin.session-search-lite');

const TEST_TMP_ROOT = process.env.HARNESSMATE_TEST_TMP || 'D:/HarnessMate/b3-tmp/w1';
const tempDirs: string[] = [];
const activeDaemons: DaemonInstance[] = [];

function makeTempDir(prefix: string): string {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, prefix));
  tempDirs.push(dir);
  return dir;
}

function wrapFixtureAsHarnessAdapter(
  id: string,
  ctrl: DeterministicMockDriverController,
): HarnessAdapter {
  const probeResult = {
    id,
    kind: ctrl.driver.driverId,
    driverId: ctrl.driver.driverId,
    displayName: ctrl.driver.displayName,
    description: ctrl.driver.description,
    protocolLabel: ctrl.driver.protocolLabel,
    binaryPath: null,
    version: '1.0.0-mock',
    health: 'ready' as const,
    capabilities: ctrl.driver.capabilities,
    capabilitiesV2: ctrl.driver.capabilitiesV2,
    models: [{ id: 'mock-model-1', displayName: 'Mock Model 1', isDefault: true }],
    defaultModelId: 'mock-model-1',
  } satisfies HarnessInfo;

  return {
    id,
    kind: ctrl.driver.driverId,
    driverId: ctrl.driver.driverId,
    continuationKey: `${ctrl.driver.driverId}:${id}`,
    displayName: ctrl.driver.displayName,
    description: ctrl.driver.description,
    protocolLabel: ctrl.driver.protocolLabel,
    capabilities: ctrl.driver.capabilities,
    capabilitiesV2: ctrl.driver.capabilitiesV2,
    probePassive: () => probeResult,
    probe: async () => probeResult,
    async createSession(config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
      const inner = await ctrl.driver.createSession({
        cwd: config.cwd,
        model: config.model ?? null,
        reasoningEffort: config.reasoningEffort ?? null,
        permissionMode: config.permissionMode,
        nativeSessionId: config.nativeSessionId ?? null,
      });
      return {
        nativeSessionId: inner.nativeSessionId ?? null,
        sendTurn: (input: TurnInput) => inner.sendTurn(input as never),
        interrupt: () => inner.interrupt(),
        resolveApproval: (nativeRequestId, decision, comment) =>
          inner.resolveApproval(nativeRequestId, decision, comment),
        updateConfig: (patch) => inner.updateConfig(patch as never),
        dispose: () => inner.dispose(),
        onEvent: (listener: (ev: NormalizedAdapterEvent) => void) =>
          inner.onEvent(listener as never),
      };
    },
  };
}

async function installAndGrantPlugin(
  daemon: DaemonInstance,
  dirPath: string,
  extraPermissions: string[] = [],
) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  const caps = [...new Set([...(preview.manifest.permissions ?? []), ...extraPermissions])];
  for (const capability of caps) {
    const res = await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/plugins/${preview.manifest.id}/permissions`,
      payload: {
        workspaceId: '__global__',
        digest: preview.digest,
        capability,
        granted: true,
      },
    });
    expect(res.statusCode).toBe(200);
  }
  return preview;
}

function readPluginFilesForAudit(dirPath: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dirPath, 'harnessmate-plugin.json'), 'utf8'));
  const files: Record<string, string> = {};
  for (const name of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, name);
    if (fs.statSync(full).isFile()) {
      files[name] = fs.readFileSync(full, 'utf8');
    }
  }
  return { manifest, files };
}

function seedLegacyWorkspaceSession(daemon: DaemonInstance, wsRoot: string) {
  const fixture = createLegacySessionDataFixture();
  daemon.store.createWorkspace({
    ...fixture.workspace,
    rootPath: wsRoot,
  });
  daemon.store.createSession({
    ...fixture.session,
    cwd: wsRoot,
    harnessId: 'mock-stream',
    harnessKind: 'mock-stream',
    lastSeq: 0,
  });
  for (const ev of fixture.events) {
    daemon.store.appendEvent(
      fixture.session.id,
      ev.type as never,
      ev.payload,
      ev.turnId,
      ev.createdAt,
    );
  }
  for (const item of fixture.turnItems) {
    daemon.store.upsertTurnItem({
      ...item,
      schemaVersion: 2,
      instanceId: 'mock-stream',
      driverId: 'mock-stream',
      blockType: item.blockType as never,
      status: item.status as never,
    });
  }
  for (const run of fixture.runs) {
    daemon.store.startSessionRun({
      runId: run.runId,
      sessionId: run.sessionId,
      turnId: run.turnId,
      instanceId: 'mock-stream',
      driverId: 'mock-stream',
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
    });
  }
  for (const b of fixture.bindings) {
    daemon.store.upsertSessionBinding({
      ...b,
      harnessId: 'mock-stream',
      harnessKind: 'mock-stream',
      driverUsed: null,
    });
  }
  daemon.store.upsertHistoryImportMapping({
    sourceId: fixture.nativeImportMapping.sourceId,
    nativeSessionId: fixture.nativeImportMapping.nativeSessionId,
    sessionId: fixture.session.id,
    sourcePath: null,
    harnessKind: 'mock-stream',
    createdAt: Date.now(),
  });
  return fixture;
}

async function openWsAndReplay(params: {
  port: number;
  token: string;
  sessionId: string;
  afterSeq: number;
  stream?: { providerInstanceId: string; streamId: string };
}) {
  return await new Promise<{
    replayEvents: Array<{ seq: number; type: string; turnId: string | null; payload: Record<string, unknown> }>;
    replayComplete: { sessionId: string; afterSeq: number; lastSeq: number; stream?: { providerInstanceId: string; streamId: string } };
  }>((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${params.port}/api/v1/ws?token=${encodeURIComponent(params.token)}`,
    );
    const replayEvents: Array<{ seq: number; type: string; turnId: string | null; payload: Record<string, unknown> }> = [];
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('WS replay timed out'));
    }, 8_000);
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.op === 'hello') {
        ws.send(JSON.stringify({
          op: 'subscribe',
          sessionId: params.sessionId,
          afterSeq: params.afterSeq,
          ...(params.stream ? { stream: params.stream } : {}),
        }));
      } else if (msg.op === 'event' && msg.event) {
        replayEvents.push(msg.event);
      } else if (msg.op === 'replay_complete') {
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve({ replayEvents, replayComplete: msg });
      }
    });
  });
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    await activeDaemons.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Best-effort cleanup on Windows transient handles
    }
  }
});

describe('B3-W1 Acceptance: peer-owned session data & runtime', () => {
  it('passes static audit for pure-SDK lite plugins with 0 blocking findings', () => {
    for (const dir of [dataLiteDir, runtimeLiteDir]) {
      const { manifest, files } = readPluginFilesForAudit(dir);
      const report = auditPluginPackage(files, manifest);
      expect(report.passed).toBe(true);
      expect(report.blockingIssues).toHaveLength(0);
    }
  });

  it('installs, binds, and completes full dual-workspace lifecycle (open -> send -> stream -> interrupt -> resend -> restart recovery)', async () => {
    const dataDir = makeTempDir('dual-data-');
    const wsDirA = makeTempDir('dual-wsA-');
    const wsDirB = makeTempDir('dual-wsB-');

    const ctrlA = createDeterministicMockDriverFixture({ driverId: 'mock-stream', defaultScript: { chunks: ['A-ok'] } });
    const adapterA = wrapFixtureAsHarnessAdapter('mock-stream', ctrlA);

    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [adapterA],
    });
    activeDaemons.push(daemon);
    await daemon.start();

    await installAndGrantPlugin(daemon, dataLiteDir);
    await installAndGrantPlugin(daemon, runtimeLiteDir);

    const dataProviders = daemon.pluginManager.listServiceProviders(PEER_CONTRACTS.sessionData);
    const runtimeProviders = daemon.pluginManager.listServiceProviders(PEER_CONTRACTS.sessionRuntime);
    expect(dataProviders.map((p) => p.instanceId)).toEqual(
      expect.arrayContaining([SESSION_DATA_DEFAULT_PLUGIN_ID, 'hm.plugin.session-data-lite']),
    );
    expect(runtimeProviders.map((p) => p.instanceId)).toEqual(
      expect.arrayContaining([SESSION_RUNTIME_DEFAULT_PLUGIN_ID, 'hm.plugin.session-runtime-lite']),
    );

    // Seed legacy B2 fixture on WS-A (default SQLite owner)
    const legacy = seedLegacyWorkspaceSession(daemon, wsDirA);
    await daemon.pluginManager.setWorkspaceBinding(legacy.workspace.id, PEER_CONTRACTS.sessionData, SESSION_DATA_DEFAULT_PLUGIN_ID);
    await daemon.pluginManager.setWorkspaceBinding(legacy.workspace.id, PEER_CONTRACTS.sessionRuntime, SESSION_RUNTIME_DEFAULT_PLUGIN_ID);

    // Open legacy session via REST and verify pre-existing turns
    const openLegacyRes = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${legacy.session.id}` });
    expect(openLegacyRes.statusCode).toBe(200);
    expect(openLegacyRes.json().session.nativeSessionId).toBe('native_legacy_thread_001');

    // Create WS-B bound explicitly to pure-SDK lite data + runtime
    const createWsB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { rootPath: wsDirB, name: 'Lite Workspace B', dataInstanceId: 'hm.plugin.session-data-lite' },
    });
    expect(createWsB.statusCode).toBe(201);
    const wsB = createWsB.json().workspace;
    const runtimeLiteInfo = daemon.pluginManager.listInstalled().find((p) => p.id === 'hm.plugin.session-runtime-lite');
    for (const cap of ['session:send', 'session:read']) {
      const grantRes = await daemon.app.inject({
        method: 'PUT',
        url: '/api/v1/plugins/hm.plugin.session-runtime-lite/permissions',
        payload: {
          workspaceId: wsB.id,
          digest: runtimeLiteInfo!.packageDigest,
          capability: cap,
          granted: true,
        },
      });
      expect(grantRes.statusCode).toBe(200);
    }
    const bindRuntimeB = await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${wsB.id}/bindings`,
      payload: { contract: PEER_CONTRACTS.sessionRuntime, instanceId: 'hm.plugin.session-runtime-lite' },
    });
    expect(bindRuntimeB.statusCode).toBe(200);

    const bindingsB = await daemon.app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsB.id}/bindings` });
    expect(bindingsB.statusCode).toBe(200);
    expect(bindingsB.json().resolved['session.data.v1'].instanceId).toBe('hm.plugin.session-data-lite');
    expect(bindingsB.json().resolved['session.runtime.v1'].instanceId).toBe('hm.plugin.session-runtime-lite');

    // Create a session on WS-B and verify host SQLite does NOT hold WS-B session
    const createSessB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspaceId: wsB.id, harnessId: 'mock-stream', permissionMode: 'manual' },
    });
    expect(createSessB.statusCode).toBe(201);
    const sessB = createSessB.json().session;
    expect(daemon.store.getSession(sessB.id)).toBeNull();

    // Run Send -> Continuous Streaming -> Interrupt -> Resend on BOTH WS-A (legacy session) and WS-B
    for (const [label, sessId] of [['WS-A', legacy.session.id], ['WS-B', sessB.id]] as const) {
      ctrlA.setNextTurnScript({
        manualControl: true,
        chunks: [`${label}-stream-1 `, `${label}-stream-2 `],
      });
      const turn1Res = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessId}/turns`,
        payload: { text: `${label} first streaming turn`, requestId: `req-${label}-1` },
      });
      expect(turn1Res.statusCode).toBe(202);
      const turn1Id = turn1Res.json().turnId as string;

      // Continuous streaming chunk
      ctrlA.emitDelta(turn1Id, `${label}-stream-3`);

      // Interrupt -> must drain buffered delta before turn.cancelled
      const interruptRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessId}/interrupt`,
      });
      expect(interruptRes.statusCode).toBe(200);

      await expect.poll(async () => {
        const s = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessId}` });
        return s.json().session.status;
      }, { timeout: 6_000 }).toBe('idle');

      // Resend a new turn after interrupt -> completes cleanly
      ctrlA.setNextTurnScript({ chunks: [`${label}-final-reply`] });
      const turn2Res = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${sessId}/turns`,
        payload: { text: `${label} second turn after interrupt`, requestId: `req-${label}-2` },
      });
      expect(turn2Res.statusCode).toBe(202);
      const turn2Id = turn2Res.json().turnId as string;
      expect(turn2Id).not.toBe(turn1Id);

      await expect.poll(async () => {
        const runsRes = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessId}/runs` });
        const runs = runsRes.json().runs as Array<{ turnId: string; status: string }>;
        return runs.find((r) => r.turnId === turn2Id)?.status;
      }, { timeout: 6_000 }).toBe('completed');

      const evRes = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessId}/events?afterSeq=0` });
      const events = evRes.json().events as Array<{ seq: number; type: string; turnId: string | null; payload: Record<string, unknown> }>;
      // Monotonic seq & delta drained before cancellation
      for (let i = 1; i < events.length; i += 1) {
        expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
      }
      const turn1DeltaIdx = events.findIndex(
        (e) => e.turnId === turn1Id && e.type === 'message.assistant.delta' && String(e.payload.text).includes('stream-3'),
      );
      const turn1CancelIdx = events.findIndex((e) => e.turnId === turn1Id && e.type === 'turn.cancelled');
      expect(turn1DeltaIdx).toBeGreaterThan(-1);
      expect(turn1CancelIdx).toBeGreaterThan(turn1DeltaIdx);
    }

    // Seed an active crash-interrupted turn in both providers, then restart daemon cleanly
    const dataDef = daemon.pluginManager.host.getServiceByInstance<SessionDataServiceV1>(
      SESSION_DATA_DEFAULT_PLUGIN_ID,
      PEER_CONTRACTS.sessionData,
    )!;
    const dataLite = daemon.pluginManager.host.getServiceByInstance<SessionDataServiceV1>(
      'hm.plugin.session-data-lite',
      PEER_CONTRACTS.sessionData,
    )!;
    const now = Date.now();
    await dataDef.commitBatch({
      sessionId: legacy.session.id,
      sessionPatch: { status: 'running' },
      runStart: {
        runId: 'run_crash_a',
        sessionId: legacy.session.id,
        turnId: 'turn_crash_a',
        instanceId: 'mock-stream',
        driverId: 'mock-stream',
        status: 'running',
        startedAt: now,
      },
    });
    await dataLite.commitBatch({
      sessionId: sessB.id,
      sessionPatch: { status: 'running' },
      runStart: {
        runId: 'run_crash_b',
        sessionId: sessB.id,
        turnId: 'turn_crash_b',
        instanceId: 'mock-stream',
        driverId: 'mock-stream',
        status: 'running',
        startedAt: now,
      },
    });

    await daemon.stop();
    activeDaemons.pop();

    const ctrlAfterRestart = createDeterministicMockDriverFixture({ driverId: 'mock-stream', defaultScript: { chunks: ['restarted'] } });
    const daemon2 = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [wrapFixtureAsHarnessAdapter('mock-stream', ctrlAfterRestart)],
    });
    activeDaemons.push(daemon2);
    await daemon2.start();

    // Wait for runtime crash recovery on both WS-A and WS-B (sessions transition from running -> error, orphaned runs -> interrupted)
    await expect.poll(async () => {
      const rA = await daemon2.app.inject({ method: 'GET', url: `/api/v1/sessions/${legacy.session.id}` });
      const rB = await daemon2.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}` });
      return `${rA.json().session?.status}:${rB.json().session?.status}`;
    }, { timeout: 10_000 }).toBe('error:error');

    const runsAAfter = (await daemon2.app.inject({ method: 'GET', url: `/api/v1/sessions/${legacy.session.id}/runs` })).json().runs;
    const runsBAfter = (await daemon2.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}/runs` })).json().runs;
    expect(runsAAfter.find((r: { runId: string }) => r.runId === 'run_crash_a')?.status).toBe('interrupted');
    expect(runsBAfter.find((r: { runId: string }) => r.runId === 'run_crash_b')?.status).toBe('interrupted');

    // Both sessions still usable after restart
    const postRestartSend = await daemon2.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessB.id}/turns`,
      payload: { text: 'after restart prompt' },
    });
    expect(postRestartSend.statusCode).toBe(202);
  }, 45_000);

  it('enforces requestId idempotency, unknown-outcome non-replay, late callback fencing, and requested vs driver-confirmed config receipts', async () => {
    const dataDir = makeTempDir('idem-data-');
    const wsDir = makeTempDir('idem-ws-');
    const ctrl = createDeterministicMockDriverFixture({ driverId: 'mock-stream' });
    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [wrapFixtureAsHarnessAdapter('mock-stream', ctrl)],
    });
    activeDaemons.push(daemon);
    await daemon.start();

    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'Idem WS');
    const sess = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'mock-stream',
      permissionMode: 'manual',
    });

    // 1. Duplicate requestId with identical payload -> reused, driver dispatched once
    const first = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.id}/turns`,
      payload: { text: 'idempotent ping', requestId: 'req-same-1' },
    });
    expect(first.statusCode).toBe(202);
    const second = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.id}/turns`,
      payload: { text: 'idempotent ping', requestId: 'req-same-1' },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().turnId).toBe(first.json().turnId);
    expect(second.json().deduplicated).toBe(true);
    expect(ctrl.dispatchedTurns).toHaveLength(1);

    // Different payload on same requestId -> conflict
    const conflict = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.id}/turns`,
      payload: { text: 'different payload', requestId: 'req-same-1' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(ctrl.dispatchedTurns).toHaveLength(1);

    // 2. Unknown outcome send failure must NOT auto-replay on retry
    ctrl.setNextTurnScript({ failAfterDispatch: true, failMessage: 'transport lost after send' });
    const unknown1 = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.id}/turns`,
      payload: { text: 'risky external write', requestId: 'req-unknown-1' },
    });
    expect(unknown1.statusCode).toBeGreaterThanOrEqual(400);
    expect(ctrl.dispatchedTurns).toHaveLength(2);

    const runtimeSvc = daemon.pluginManager.host.getServiceByInstance<SessionRuntimeServiceV1>(
      SESSION_RUNTIME_DEFAULT_PLUGIN_ID,
      PEER_CONTRACTS.sessionRuntime,
    )!;
    const statusRes = await runtimeSvc.getTurnStatus({ sessionId: sess.id, requestId: 'req-unknown-1' });
    expect(statusRes.ok && statusRes.value.receipt?.status).toBe('unknown');

    const retryUnknown = await runtimeSvc.sendTurn({
      sessionId: sess.id,
      text: 'risky external write',
      requestId: 'req-unknown-1',
    });
    expect(retryUnknown.ok).toBe(true);
    if (retryUnknown.ok) {
      expect(retryUnknown.value.disposition).toBe('reused');
      expect(retryUnknown.value.status).toBe('unknown');
    }
    expect(ctrl.dispatchedTurns).toHaveLength(2);

    // Reset error -> idle so we can test generation fencing and config receipts
    await daemon.sessionManager.updateSession(sess.id, { archived: false });

    // 3. Generation fencing: late callback for first turnId must not appear after subsequent turn
    ctrl.setNextTurnScript({ manualControl: true, chunks: ['turn3-live'] });
    const turn3 = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sess.id}/turns`,
      payload: { text: 'turn 3 live' },
    });
    expect(turn3.statusCode).toBe(202);
    ctrl.emitLateEvent({
      type: 'message.assistant.delta',
      turnId: first.json().turnId,
      text: 'STALE_POLLUTION_FROM_TURN_1',
    });
    ctrl.completeTurn(turn3.json().turnId, 'turn3-done');

    await expect.poll(async () => {
      const s = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sess.id}` });
      return s.json().session.status;
    }).toBe('idle');

    const events = daemon.sessionManager.getSessionEvents(sess.id);
    expect(events.some((e) => JSON.stringify(e.payload).includes('STALE_POLLUTION_FROM_TURN_1'))).toBe(false);

    // 4. Config receipt separates requested values vs driver-confirmed values
    ctrl.setConfigMode('applied');
    const cfgApplied = await runtimeSvc.applyConfig({
      sessionId: sess.id,
      patch: { model: 'mock-model-confirmed', reasoningEffort: 'high' },
    });
    expect(cfgApplied.ok).toBe(true);
    if (cfgApplied.ok) {
      expect(cfgApplied.value.status).toBe('applied');
      expect(cfgApplied.value.requested.model).toBe('mock-model-confirmed');
      expect(cfgApplied.value.confirmed.actualModel).toBe('mock-model-confirmed');
    }

    ctrl.setConfigMode('unsupported');
    const cfgUnsupported = await runtimeSvc.applyConfig({
      sessionId: sess.id,
      patch: { model: 'unsupported-model' },
    });
    expect(cfgUnsupported.ok).toBe(true);
    if (cfgUnsupported.ok) {
      expect(cfgUnsupported.value.status).toBe('unsupported');
      expect(cfgUnsupported.value.requested.model).toBe('unsupported-model');
      expect(cfgUnsupported.value.confirmed.actualModel).toBeNull();
    }
  }, 30_000);

  it('supports WS catch-up + cross-stream cursor reset, isolates single-instance disable/update/crash with zero fallback, and keeps projections & B1/B2 compat working', async () => {
    const dataDir = makeTempDir('iso-data-');
    const wsDirA = makeTempDir('iso-wsA-');
    const wsDirB = makeTempDir('iso-wsB-');
    const ctrl = createDeterministicMockDriverFixture({ driverId: 'mock-stream' });

    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [wrapFixtureAsHarnessAdapter('mock-stream', ctrl)],
    });
    activeDaemons.push(daemon);
    const { port } = await daemon.start();

    await installAndGrantPlugin(daemon, dataLiteDir);
    await installAndGrantPlugin(daemon, runtimeLiteDir);
    await installAndGrantPlugin(daemon, searchLiteDir);

    const searchLiteRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: { id: 'search.lite.w1', name: 'hm.plugin.session-search-lite' },
    });
    expect(searchLiteRes.statusCode).toBe(200);

    const wsA = (await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { rootPath: wsDirA, name: 'WS-A', dataInstanceId: SESSION_DATA_DEFAULT_PLUGIN_ID },
    })).json().workspace;
    const wsB = (await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { rootPath: wsDirB, name: 'WS-B', dataInstanceId: 'hm.plugin.session-data-lite' },
    })).json().workspace;
    const runtimeLiteInfo = daemon.pluginManager.listInstalled().find((p) => p.id === 'hm.plugin.session-runtime-lite');
    for (const cap of ['session:send', 'session:read']) {
      const grantRes = await daemon.app.inject({
        method: 'PUT',
        url: '/api/v1/plugins/hm.plugin.session-runtime-lite/permissions',
        payload: {
          workspaceId: wsB.id,
          digest: runtimeLiteInfo!.packageDigest,
          capability: cap,
          granted: true,
        },
      });
      expect(grantRes.statusCode).toBe(200);
    }
    await daemon.pluginManager.setWorkspaceBinding(wsB.id, PEER_CONTRACTS.sessionRuntime, 'hm.plugin.session-runtime-lite');

    const sessA = (await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspaceId: wsA.id, harnessId: 'mock-stream', permissionMode: 'manual' },
    })).json().session;
    const sessB = (await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspaceId: wsB.id, harnessId: 'mock-stream', permissionMode: 'manual' },
    })).json().session;

    ctrl.setNextTurnScript({ chunks: ['Alpha search keyword '] });
    await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessA.id}/turns`,
      payload: { text: 'Alpha prompt keyword' },
    });
    ctrl.setNextTurnScript({ chunks: ['Beta lite keyword '] });
    await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessB.id}/turns`,
      payload: { text: 'Beta prompt keyword' },
    });

    await expect.poll(() => daemon.sessionManager.getSessionAsync(sessA.id).then((s) => s?.status)).toBe('idle');
    await expect.poll(() => daemon.sessionManager.getSessionAsync(sessB.id).then((s) => s?.status)).toBe('idle');

    // WS reconnect catch-up & cross-stream cursor reset
    const wsCatchUp = await openWsAndReplay({
      port,
      token: daemon.config.localToken,
      sessionId: sessB.id,
      afterSeq: 1,
    });
    expect(wsCatchUp.replayComplete.stream?.providerInstanceId).toBe('hm.plugin.session-data-lite');
    expect(wsCatchUp.replayEvents.every((e) => e.seq > 1)).toBe(true);

    const crossStream = await openWsAndReplay({
      port,
      token: daemon.config.localToken,
      sessionId: sessB.id,
      afterSeq: 999,
      stream: { providerInstanceId: SESSION_DATA_DEFAULT_PLUGIN_ID, streamId: 'sqlite-main' },
    });
    expect((crossStream.replayComplete as { streamMismatch?: boolean }).streamMismatch).toBe(true);
    expect(crossStream.replayEvents[0]?.seq).toBe(1);

    // B1/B2 compat: reindex search-lite on WS-B and verify ledger + usage endpoints
    const reindexB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/search.lite.w1/routes/reindex',
      payload: { workspaceId: wsB.id },
    });
    expect(reindexB.statusCode).toBe(200);
    const searchB = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-instances/search.lite.w1/routes/query',
      payload: { q: 'Beta lite keyword', workspaceId: wsB.id },
    });
    expect(searchB.statusCode).toBe(200);
    expect(searchB.json().value.hits.some((h: { sessionId: string }) => h.sessionId === sessB.id)).toBe(true);

    const ledgerA = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessA.id}/task-state` });
    const ledgerB = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}/task-state` });
    expect(ledgerA.statusCode).toBe(200);
    expect(ledgerB.statusCode).toBe(200);

    // Disable hm.plugin.session-data-lite -> WS-B rejects writes/reads with 409 & zero fallback, WS-A stays healthy!
    await daemon.pluginManager.togglePlugin('hm.plugin.session-data-lite', false);
    const readBDisabled = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}` });
    expect(readBDisabled.statusCode).toBe(409);
    expect(readBDisabled.json().code).toBe('E_PLUGIN_DISABLED');
    const writeBDisabled = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessB.id}/turns`,
      payload: { text: 'must not write to disabled lite data' },
    });
    expect(writeBDisabled.statusCode).toBe(409);
    expect(daemon.store.getSession(sessB.id)).toBeNull();

    // WS-A continues operating unaffected
    ctrl.setNextTurnScript({ chunks: ['A still healthy'] });
    const turnAWhileBDisabled = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessA.id}/turns`,
      payload: { text: 'WS-A healthy check' },
    });
    expect(turnAWhileBDisabled.statusCode).toBe(202);

    // Re-enable lite data, hot-reload runtime-lite, verify WS-B recovers cleanly without disturbing WS-A
    await daemon.pluginManager.togglePlugin('hm.plugin.session-data-lite', true);
    await expect.poll(async () => {
      const r = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}` });
      return r.statusCode;
    }, { timeout: 6_000 }).toBe(200);

    await daemon.pluginManager.reloadAll();
    const afterReloadB = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}` });
    expect(afterReloadB.statusCode).toBe(200);

    await daemon.pluginManager.togglePlugin(SESSION_DATA_DEFAULT_PLUGIN_ID, false);
    const readADisabled = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessA.id}` });
    expect(readADisabled.statusCode).toBe(409);
    expect(readADisabled.json().code).toBe('E_PLUGIN_DISABLED');

    const seqBeforeTurnB = (await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}` })).json().session.lastSeq;
    ctrl.setNextTurnScript({ chunks: ['B works without default data plugin'] });
    const turnBWhileADisabled = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessB.id}/turns`,
      payload: { text: 'WS-B works independently' },
    });
    expect(turnBWhileADisabled.statusCode).toBe(202);
    await expect.poll(async () => {
      const r = await daemon.app.inject({ method: 'GET', url: `/api/v1/sessions/${sessB.id}` });
      return r.json().session.lastSeq;
    }, { timeout: 6_000 }).toBeGreaterThan(seqBeforeTurnB);

    // Re-enable default data plugin before teardown
    await daemon.pluginManager.togglePlugin(SESSION_DATA_DEFAULT_PLUGIN_ID, true);
  }, 45_000);
});
