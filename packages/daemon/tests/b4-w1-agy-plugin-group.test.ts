import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGY_ACCOUNTS_CONTRACT,
  AGY_RUNTIME_CONTRACT,
  AGY_WORKBENCH_CONTRACT,
  compareAgyRuntimeCursors,
  type AgyAccountsServiceV1,
  type AgyRuntimeServiceV1,
} from '@harnessmate/plugin-api';
import {
  createAgyLegacyApprovalBridgeSample,
  createAgyNativeReplayFixture,
} from '@harnessmate/plugin-sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { mintAgyDispatchProvenance } from '../src/harnesses/agy/native/wiring/provenance.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
} from '../src/harnesses/types.js';
import { readPluginPackage } from '../src/plugins/plugin-package.js';
import { auditPluginPackage } from '../src/plugins/plugin-static-audit.js';
import { createDaemon } from '../src/server/app.js';

const USER_PROVENANCE = () => mintAgyDispatchProvenance('human_direct', 'desktop', 'b4_w1_test');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const AGY_LITE_EXAMPLE_DIR = path.join(REPO_ROOT, 'plugins', 'examples', 'hm.plugin.agy-driver-lite');

const cleanupDirs: string[] = [];
const daemons: Array<ReturnType<typeof createDaemon>> = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows transient lock cleanup
  }
}

function createFakeAgyAdapter(id = 'agy', options?: { slowTurnMs?: number }): HarnessAdapter {
  let seq = 0;
  return {
    id,
    kind: 'agy',
    driverId: 'agy',
    instanceId: id,
    continuationKey: `agy:${id}`,
    displayName: `Mock AGY (${id})`,
    description: 'Deterministic mock AGY adapter for B4-W1 seam verification',
    protocolLabel: 'ACP-Mock',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      permissionModes: ['plan', 'manual', 'auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: false,
      subagents: true,
    },
    async probe() {
      return {
        binaryPath: `/mock-bin/${id}/agy`,
        version: '1.5.14-mock',
        health: 'ready',
        models: [{ id: 'gemini-pro-mock', displayName: 'Gemini Pro Mock', isDefault: true }],
        defaultModelId: 'gemini-pro-mock',
      };
    },
    async createSession(cfg: AdapterSessionConfig): Promise<AdapterSessionHandle> {
      seq += 1;
      const nativeSessionId = cfg.nativeSessionId || `agy_mock_sess_${id}_${seq}`;
      const listeners = new Set<(ev: NormalizedAdapterEvent) => void>();
      let activeTurnId: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let resolvePendingTurn: (() => void) | null = null;
      const emit = (ev: NormalizedAdapterEvent) => {
        for (const fn of [...listeners]) fn(ev);
      };
      return {
        get nativeSessionId() {
          return nativeSessionId;
        },
        async sendTurn(input) {
          activeTurnId = input.turnId;
          emit({ type: 'session.ready', nativeSessionId });
          emit({ type: 'turn.started', turnId: input.turnId });
          const delayMs = input.text.includes('[slow]') ? (options?.slowTurnMs ?? 800) : 10;
          if (delayMs > 50) {
            await new Promise<void>((resolve) => {
              resolvePendingTurn = resolve;
              timer = setTimeout(() => {
                timer = null;
                resolvePendingTurn = null;
                if (activeTurnId !== input.turnId) {
                  resolve();
                  return;
                }
                activeTurnId = null;
                emit({ type: 'message.assistant.delta', turnId: input.turnId, delta: `[mock:${id}] ${input.text}` });
                emit({ type: 'message.assistant.completed', turnId: input.turnId, text: `[mock:${id}] ${input.text}` });
                emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'end_turn' });
                resolve();
              }, delayMs);
            });
          } else {
            activeTurnId = null;
            emit({ type: 'message.assistant.delta', turnId: input.turnId, delta: `[mock:${id}] ${input.text}` });
            emit({ type: 'message.assistant.completed', turnId: input.turnId, text: `[mock:${id}] ${input.text}` });
            emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'end_turn' });
          }
        },
        async interrupt() {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (activeTurnId) {
            const turnId = activeTurnId;
            activeTurnId = null;
            emit({ type: 'turn.completed', turnId, stopReason: 'cancelled' });
          }
          const done = resolvePendingTurn;
          resolvePendingTurn = null;
          done?.();
        },
        async resolveApproval() {},
        async dispose() {
          if (timer) clearTimeout(timer);
          const done = resolvePendingTurn;
          resolvePendingTurn = null;
          done?.();
          listeners.clear();
        },
        onEvent(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    },
  };
}

async function installTrustedDir(daemon: ReturnType<typeof createDaemon>, dirPath: string) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  return preview;
}

async function grantPermission(
  daemon: ReturnType<typeof createDaemon>,
  pluginId: string,
  digest: string,
  capability: string,
) {
  const res = await daemon.app.inject({
    method: 'PUT',
    url: `/api/v1/plugins/${pluginId}/permissions`,
    payload: { workspaceId: '__global__', digest, capability, granted: true },
  });
  expect(res.statusCode).toBe(200);
}

const ENABLED_NATIVE_FLAGS = {
  enabled: true,
  observatoryTap: false,
  nativeLifecycle: true,
  nativePermissions: true,
  nativeCommands: true,
  nativeWorkflowObservation: true,
  nativeTasksObservation: true,
  acpV2Preview: false,
};

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(async () => {
  while (daemons.length > 0) {
    const d = daemons.pop()!;
    await d.stop().catch(() => {});
  }
  while (cleanupDirs.length > 0) {
    safeRmSync(cleanupDirs.pop()!);
  }
});

describe('B4-W1 AGY Native Plugin Group', () => {
  it('runs default AGY new + resumed session lifecycle, cancel, resync, terminal settlement, and preserves legacy IDs + B3 rollback schema', async () => {
    const dataDir = createTempDir('hm-b4w1-default-');
    const wsDir = createTempDir('hm-b4w1-ws-');
    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [createFakeAgyAdapter('agy', { slowTurnMs: 1200 })],
      nativeFeatureFlags: ENABLED_NATIVE_FLAGS,
    });
    daemons.push(daemon);
    await daemon.start();

    expect(daemon.registry.isReserved('agy')).toBe(false);
    const runtimeProviders = daemon.pluginManager.listServiceProviders(AGY_RUNTIME_CONTRACT);
    expect(runtimeProviders.some((p) => p.instanceId === 'harness-agy' && p.pluginId === 'core.harness.agy')).toBe(true);
    const accountProviders = daemon.pluginManager.listServiceProviders(AGY_ACCOUNTS_CONTRACT);
    expect(accountProviders.some((p) => p.instanceId === 'harness-agy')).toBe(true);
    const workbenchProviders = daemon.pluginManager.listServiceProviders(AGY_WORKBENCH_CONTRACT);
    expect(workbenchProviders.some((p) => p.pluginId === 'hm.plugin.agy-workbench-default')).toBe(true);

    const workspace = await daemon.sessionManager.addWorkspace(wsDir, 'AGY Default WS');

    // 1. Create new AGY session and run turn
    const session = await daemon.sessionManager.createSession({
      workspaceId: workspace.id,
      harnessId: 'agy',
      permissionMode: 'manual',
      title: 'Default AGY Lifecycle',
    });
    expect(session.harnessId).toBe('agy');
    expect(session.harnessKind).toBe('agy');

    await daemon.sessionManager.sendTurn(session.id, 'Hello default AGY', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await waitFor(() => daemon.store.getSession(session.id)?.status === 'idle');
    const afterFirst = daemon.store.getSession(session.id)!;
    const preservedNativeSessionId = afterFirst.nativeSessionId;
    expect(preservedNativeSessionId).toBeTruthy();

    // 2. Verify provider mapping persisted in SQLite with distinct pluginInstanceId vs legacy profileInstanceId
    const mapping = daemon.store.db
      .prepare(
        `SELECT m.driver_provider_instance_id, m.runtime_provider_instance_id, m.profile_instance_id, m.harness_id
         FROM native_runtime_provider_mappings m
         JOIN native_runtime_bindings b ON b.runtime_id = m.runtime_id
         WHERE b.session_id = ?`,
      )
      .get(session.id) as
      | {
          driver_provider_instance_id: string;
          runtime_provider_instance_id: string;
          profile_instance_id: string;
          harness_id: string;
        }
      | undefined;
    expect(mapping).toBeTruthy();
    expect(mapping?.driver_provider_instance_id).toBe('harness-agy');
    expect(mapping?.runtime_provider_instance_id).toBe('harness-agy');
    expect(mapping?.profile_instance_id).toBe('agy');
    expect(mapping?.harness_id).toBe('agy');

    // B3 rollback compatibility: component_schema_migrations version remains 1
    const migRow = daemon.store.db
      .prepare('SELECT version FROM component_schema_migrations WHERE component = ?')
      .get('agy-native-runtime') as { version: number } | undefined;
    expect(migRow?.version).toBe(1);

    // 3. Snapshot + capabilities via legacy URL forwarding
    const snapRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/native/snapshot`,
    });
    expect(snapRes.statusCode).toBe(200);
    const snapJson = snapRes.json() as { projection: { binding: { runtimeId: string; generation: string } } };
    expect(snapJson.projection.binding.runtimeId).toBeTruthy();

    // 4. Send slow turn -> cancel -> verify terminal settlement
    const slowTurn1 = daemon.sessionManager.sendTurn(session.id, '[slow] long running AGY work', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await waitFor(() => daemon.store.getSession(session.id)?.status === 'running');
    await daemon.sessionManager.interruptSession(session.id);
    await slowTurn1.catch(() => {});
    await waitFor(() => daemon.store.getSession(session.id)?.status === 'idle');

    // 5. Simulate daemon restart / old session resume preserving business identity
    await daemon.stop();
    daemons.pop();

    const daemon2 = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [createFakeAgyAdapter('agy')],
      nativeFeatureFlags: ENABLED_NATIVE_FLAGS,
    });
    daemons.push(daemon2);
    await daemon2.start();

    const resumed = daemon2.store.getSession(session.id)!;
    expect(resumed.harnessId).toBe('agy');
    expect(resumed.nativeSessionId).toBe(preservedNativeSessionId);

    await daemon2.sessionManager.sendTurn(session.id, 'Resumed after reconnect', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await waitFor(() => daemon2.store.getSession(session.id)?.status === 'idle');
    const afterResume = daemon2.store.getSession(session.id)!;
    expect(afterResume.nativeSessionId).toBe(preservedNativeSessionId);
  }, 45_000);

  it('installs external pure-SDK hm.plugin.agy-driver-lite, binds two workspaces to different providers, runs replay/commands/cancel, and preserves bindings across reversed load order', async () => {
    const dataDir = createTempDir('hm-b4w1-dual-ws-');
    const wsADir = createTempDir('hm-b4w1-wsa-');
    const wsBDir = createTempDir('hm-b4w1-wsb-');
    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [createFakeAgyAdapter('agy')],
      nativeFeatureFlags: ENABLED_NATIVE_FLAGS,
    });
    daemons.push(daemon);
    await daemon.start();

    // 1. Real product static audit (0 blocking) + install + permission grant
    const litePkg = readPluginPackage(AGY_LITE_EXAMPLE_DIR);
    const liteAudit = auditPluginPackage(litePkg.manifest, litePkg.files);
    expect(liteAudit.passed).toBe(true);
    expect(liteAudit.blockingIssues).toEqual([]);
    const preview = await installTrustedDir(daemon, AGY_LITE_EXAMPLE_DIR);
    await grantPermission(daemon, 'hm.plugin.agy-driver-lite', preview.digest!, 'harness:driver:register');
    await grantPermission(daemon, 'hm.plugin.agy-driver-lite', preview.digest!, 'storage:plugin');
    await daemon.pluginManager.reloadAll();

    const liteHarnessId = 'hm.plugin.agy-driver-lite:agy';
    expect(daemon.registry.get('agy')).toBeDefined();
    expect(daemon.registry.get(liteHarnessId)).toBeDefined();

    // 2. Create two workspaces bound to different AGY runtime/account/workbench providers
    const wsA = await daemon.sessionManager.addWorkspace(wsADir, 'Workspace Default AGY');
    const wsB = await daemon.sessionManager.addWorkspace(wsBDir, 'Workspace External AGY Lite');

    for (const contract of [AGY_RUNTIME_CONTRACT, AGY_ACCOUNTS_CONTRACT]) {
      const bindA = await daemon.app.inject({
        method: 'PUT',
        url: `/api/v1/workspaces/${wsA.id}/bindings`,
        payload: { contract, instanceId: 'harness-agy' },
      });
      expect(bindA.statusCode).toBe(200);
      const bindB = await daemon.app.inject({
        method: 'PUT',
        url: `/api/v1/workspaces/${wsB.id}/bindings`,
        payload: { contract, instanceId: 'hm.plugin.agy-driver-lite' },
      });
      expect(bindB.statusCode).toBe(200);
    }

    const bindWbB = await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${wsB.id}/bindings`,
      payload: { contract: AGY_WORKBENCH_CONTRACT, instanceId: 'hm.plugin.agy-driver-lite' },
    });
    expect(bindWbB.statusCode).toBe(200);

    // 3. Create sessions in each workspace and execute turns + commands + replay + cancel
    const sessA = await daemon.sessionManager.createSession({
      workspaceId: wsA.id,
      harnessId: 'agy',
      permissionMode: 'manual',
      title: 'Default WS Session',
    });
    const sessB = await daemon.sessionManager.createSession({
      workspaceId: wsB.id,
      harnessId: liteHarnessId,
      permissionMode: 'manual',
      title: 'Lite WS Session',
    });

    await daemon.sessionManager.sendTurn(sessA.id, 'Hello WS-A', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await daemon.sessionManager.sendTurn(sessB.id, 'Hello WS-B', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await waitFor(
      () =>
        daemon.store.getSession(sessA.id)?.status === 'idle' &&
        daemon.store.getSession(sessB.id)?.status === 'idle',
    );

    const eventsB = daemon.store.getEventsAfter(sessB.id, 0);
    expect(
      eventsB.some(
        (e) =>
          (e.type === 'message.assistant.delta' || e.type === 'message.assistant.completed') &&
          JSON.stringify(e.payload).includes('[AGY Lite:hm.plugin.agy-driver-lite]'),
      ),
    ).toBe(true);

    // 4. Execute declared native command & workflow replay on external AGY Lite via agy.runtime.v1
    const liteRuntimeSvc = daemon.pluginManager.host.getServiceByInstance<Record<string, (...args: unknown[]) => Promise<unknown>>>(
      'hm.plugin.agy-driver-lite',
      AGY_RUNTIME_CONTRACT,
    );
    expect(liteRuntimeSvc).toBeDefined();

    const snapB = (await liteRuntimeSvc!.getSnapshot({ sessionId: sessB.id })) as {
      projection: { binding: { generation: string }; workflows: Array<{ id: string }> };
    };
    const genB = snapB.projection.binding.generation;
    expect(genB).toContain('hm.plugin.agy-driver-lite');

    const cmdB = (await liteRuntimeSvc!.submitCommand({
      sessionId: sessB.id,
      bindingGeneration: genB,
      catalogRevision: 1,
      capabilityId: 'agy.lite.swarm',
      actionKey: 'launch',
      args: { objective: 'Peer SDK Replay' },
      idempotencyKey: 'lite_cmd_1',
    })) as { status: string; output: string };
    expect(cmdB.status).toBe('completed');
    expect(cmdB.output).toContain('wf_swarm_');

    // Stale generation must be rejected
    const staleCmd = (await liteRuntimeSvc!.submitCommand({
      sessionId: sessB.id,
      bindingGeneration: 'gen_stale_000',
      catalogRevision: 1,
      capabilityId: 'agy.lite.mode',
      actionKey: 'set_mode',
      args: { mode: 'plan' },
      idempotencyKey: 'lite_cmd_stale',
    })) as { __nativeError?: { code: string } };
    expect(staleCmd.__nativeError?.code).toBe('STALE_BINDING');

    // Slow turn + cancel on external AGY Lite
    await daemon.sessionManager.sendTurn(sessB.id, '[slow] cancellable lite turn', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await waitFor(() => daemon.store.getSession(sessB.id)?.status === 'running');
    const ctrlRes = (await liteRuntimeSvc!.dispatchControl({
      sessionId: sessB.id,
      generation: genB,
      target: { type: 'runtime', id: sessB.id },
      action: 'cancel',
      idempotencyKey: 'lite_cancel_1',
    })) as { state: string };
    expect(ctrlRes.state).toBe('applied');
    await waitFor(() => daemon.store.getSession(sessB.id)?.status === 'idle');

    // 5. Reverse plugin instance load order in composition and restart -> bindings must remain invariant!
    const compPath = path.join(dataDir, 'plugin-composition.json');
    if (fs.existsSync(compPath)) {
      const comp = JSON.parse(fs.readFileSync(compPath, 'utf8')) as { instances?: unknown[] };
      if (Array.isArray(comp.instances)) {
        comp.instances.reverse();
        fs.writeFileSync(compPath, JSON.stringify(comp, null, 2));
      }
    }
    await daemon.stop();
    daemons.pop();

    const daemonReversed = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [createFakeAgyAdapter('agy')],
      nativeFeatureFlags: ENABLED_NATIVE_FLAGS,
    });
    daemons.push(daemonReversed);
    await daemonReversed.start();

    const resA = daemonReversed.pluginManager.resolveServiceSelection(AGY_RUNTIME_CONTRACT, { workspaceId: wsA.id });
    const resB = daemonReversed.pluginManager.resolveServiceSelection(AGY_RUNTIME_CONTRACT, { workspaceId: wsB.id });
    expect(resA.instanceId).toBe('harness-agy');
    expect(resB.instanceId).toBe('hm.plugin.agy-driver-lite');
  }, 60_000);

  it('supports same-package multi-account core.harness.agy instances with isolated dirs/auth and pins in-flight sessions when default binding changes', async () => {
    const dataDir = createTempDir('hm-b4w1-multi-acct-');
    const wsDir = createTempDir('hm-b4w1-multi-ws-');
    const altProfilesDir = createTempDir('hm-b4w1-alt-profiles-');
    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [createFakeAgyAdapter('agy', { slowTurnMs: 900 })],
      nativeFeatureFlags: ENABLED_NATIVE_FLAGS,
    });
    daemons.push(daemon);
    await daemon.start();

    // Add second instance of core.harness.agy with distinct CLI/home/profile directory & harnessId
    const addInst = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/instances',
      payload: {
        id: 'harness-agy-work',
        name: 'core.harness.agy',
        config: {
          profilesRootDir: altProfilesDir,
          binaryPath: '/mock-bin/work/agy',
          harnessId: 'agy.work_peer',
          profileInstanceId: 'agy.work_peer',
          displayName: 'AGY Work Peer Account',
          provenancePolicy: 'permissive',
        },
      },
    });
    expect(addInst.statusCode).toBe(200);

    const providers = daemon.pluginManager.listServiceProviders(AGY_RUNTIME_CONTRACT);
    expect(providers.map((p) => p.instanceId)).toEqual(
      expect.arrayContaining(['harness-agy', 'harness-agy-work']),
    );

    // Verify distinct provider identities (pluginInstanceId vs legacy profileInstanceId)
    const svcDefault = daemon.pluginManager.host.getServiceByInstance<AgyRuntimeServiceV1>(
      'harness-agy',
      AGY_RUNTIME_CONTRACT,
    )!;
    const svcWork = daemon.pluginManager.host.getServiceByInstance<AgyRuntimeServiceV1>(
      'harness-agy-work',
      AGY_RUNTIME_CONTRACT,
    )!;
    const infoDefault = await svcDefault.getProviderInfo();
    const infoWork = await svcWork.getProviderInfo();
    expect(infoDefault.ok && infoDefault.value.instanceId).toBe('harness-agy');
    expect(infoDefault.ok && infoDefault.value.provenancePolicy).toBe('strict_consumer_oauth');
    expect(infoWork.ok && infoWork.value.instanceId).toBe('harness-agy-work');
    expect(infoWork.ok && infoWork.value.provenancePolicy).toBe('permissive');

    const acctDefault = daemon.pluginManager.host.getServiceByInstance<AgyAccountsServiceV1>(
      'harness-agy',
      AGY_ACCOUNTS_CONTRACT,
    )!;
    const acctWork = daemon.pluginManager.host.getServiceByInstance<AgyAccountsServiceV1>(
      'harness-agy-work',
      AGY_ACCOUNTS_CONTRACT,
    )!;
    const listDef = await acctDefault.listInstances();
    const listWork = await acctWork.listInstances();
    expect(listDef.ok && listDef.value.instances.some((i) => i.profile.instanceId === 'agy')).toBe(true);
    expect(listWork.ok && listWork.value.instances.some((i) => i.profile.instanceId === 'agy.work_peer')).toBe(true);

    // Create session pinned to default `harness-agy`
    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'Multi-Account WS');
    const sess = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'agy',
      permissionMode: 'manual',
      title: 'Pinned Account Session',
    });
    const pinnedTurn = daemon.sessionManager.sendTurn(sess.id, '[slow] pinned to default account', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await waitFor(() => daemon.store.getSession(sess.id)?.status === 'running');

    // Switch global default binding to `harness-agy-work` WHILE session is in-flight
    const switchDefault = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/composition/bindings',
      payload: { contract: AGY_RUNTIME_CONTRACT, instanceId: 'harness-agy-work' },
    });
    expect(switchDefault.statusCode).toBe(200);

    // In-flight session snapshot & interrupt must stay pinned to original `harness-agy` (not bleed to `harness-agy-work`)
    const snap = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sess.id}/native/snapshot`,
    });
    expect(snap.statusCode).toBe(200);
    await daemon.sessionManager.interruptSession(sess.id);
    await pinnedTurn.catch(() => {});
    await waitFor(() => daemon.store.getSession(sess.id)?.status === 'idle');

    const mapping = daemon.store.db
      .prepare(
        `SELECT m.driver_provider_instance_id, m.runtime_provider_instance_id
         FROM native_runtime_provider_mappings m
         JOIN native_runtime_bindings b ON b.runtime_id = m.runtime_id
         WHERE b.session_id = ?`,
      )
      .get(sess.id) as
      | { driver_provider_instance_id: string; runtime_provider_instance_id: string }
      | undefined;
    expect(mapping?.driver_provider_instance_id).toBe('harness-agy');
    expect(mapping?.runtime_provider_instance_id).toBe('harness-agy');
  }, 45_000);

  it('replays all 8 native workflow families and validates W1->W2 legacy approval narrow bridge sample', () => {
    const fixture = createAgyNativeReplayFixture({
      pluginId: 'core.harness.agy',
      pluginInstanceId: 'harness-agy',
      profileInstanceId: 'agy',
      harnessId: 'agy',
    });
    const expectedFamilies = [
      'reactive',
      'subagents',
      'swarm',
      'boost',
      'teamwork',
      'dynamic',
      'tasks',
      'artifacts',
    ];
    expect(fixture.workflowSamples.map((s) => s.workflowKind)).toEqual(expectedFamilies);
    expect(fixture.identity.pluginInstanceId).toBe('harness-agy');
    expect(fixture.identity.profileInstanceId).toBe('agy');
    expect(fixture.settlementDecision.action).toBe('hold');

    const nextGen = fixture.advanceGeneration('gen_2');
    expect(nextGen.binding.generation).toBe('gen_2');
    expect(nextGen.binding.bindingRevision).toBe(2);

    // Cursor comparison: comparable within same instance/generation, null across instance/generation
    const curA = { stream: fixture.stream, seq: 3 };
    const curB = { stream: fixture.stream, seq: 5 };
    const curNextGen = { stream: nextGen.stream, seq: 1 };
    const curOtherInst = { stream: { ...fixture.stream, providerInstanceId: 'harness-agy-work' }, seq: 9 };
    expect(compareAgyRuntimeCursors(curA, curB)).toBe(-1);
    expect(compareAgyRuntimeCursors(curB, curA)).toBe(1);
    expect(compareAgyRuntimeCursors(curA, curNextGen)).toBeNull();
    expect(compareAgyRuntimeCursors(curA, curOtherInst)).toBeNull();

    // W1 -> W2 temporary legacy approval narrow adapter sample
    let fakeNow = 100_000;
    const bridge = createAgyLegacyApprovalBridgeSample({ now: () => fakeNow, defaultDeadlineMs: 30_000 });
    const reg = bridge.registerRequest({
      approvalId: 'appr_b4w1_1',
      nativeRequestId: 'nreq_1',
      binding: fixture.binding,
      toolName: 'run_shell',
      summary: 'Execute build step',
      options: [
        { optionId: 'allow_once', label: 'Allow Once', kind: 'allow_once' },
        { optionId: 'reject_once', label: 'Deny', kind: 'reject_once' },
      ],
    });
    expect(reg.bindingRevision).toBe(1);
    expect(reg.deadlineAtMs).toBe(130_000);

    // Stale generation & revision CAS mismatch rejected
    const staleRes = bridge.resolveRequest({
      approvalId: reg.approvalId,
      decision: 'allow_once',
      expectedGeneration: 'gen_old',
      idempotencyKey: 'k_stale',
    });
    expect(staleRes.staleGeneration).toBe(true);
    expect(staleRes.accepted).toBe(false);

    const casMismatch = bridge.resolveRequest({
      approvalId: reg.approvalId,
      decision: 'allow_once',
      expectedGeneration: fixture.binding.generation,
      expectedBindingRevision: 99,
      idempotencyKey: 'k_cas',
    });
    expect(casMismatch.conflict).toBe(true);
    expect(casMismatch.accepted).toBe(false);

    // Valid CAS reply accepted & idempotent, settlement acknowledged once
    const okRes = bridge.resolveRequest({
      approvalId: reg.approvalId,
      decision: 'allow_once',
      selectedOptionId: 'allow_once',
      expectedGeneration: fixture.binding.generation,
      expectedBindingRevision: reg.bindingRevision,
      idempotencyKey: 'k_ok_1',
    });
    expect(okRes.accepted).toBe(true);
    expect(okRes.receiptState).toBe('delivered');
    expect(bridge.acknowledgeSettlement(okRes.settlementRef!).acknowledged).toBe(true);
    expect(bridge.acknowledgeSettlement(okRes.settlementRef!).duplicate).toBe(true);
  });

  it('keeps background turns running when workbench UI is disabled, and enforces zero-fallback 409 E_PLUGIN_DISABLED + resource cleanup + recovery when AGY runtime is disabled', async () => {
    const dataDir = createTempDir('hm-b4w1-disable-');
    const wsDir = createTempDir('hm-b4w1-disable-ws-');
    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [createFakeAgyAdapter('agy', { slowTurnMs: 2500 })],
      nativeFeatureFlags: ENABLED_NATIVE_FLAGS,
    });
    daemons.push(daemon);
    await daemon.start();

    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'Disable Test WS');
    const sess = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'agy',
      permissionMode: 'manual',
      title: 'Disable Semantics',
    });

    // 1. Start background turn, then disable AGY workbench UI plugin -> turn MUST still finish cleanly!
    const bgTurn = daemon.sessionManager.sendTurn(sess.id, '[slow] continue while workbench disabled', undefined, {
      dispatchProvenance: USER_PROVENANCE(),
    });
    await waitFor(
      () => daemon.store.getSession(sess.id)?.status === 'running',
      5_000,
      `running (got ${daemon.store.getSession(sess.id)?.status})`,
    );
    await daemon.pluginManager.togglePlugin('hm.plugin.agy-workbench-default', false);
    expect(daemon.pluginManager.listServiceProviders(AGY_WORKBENCH_CONTRACT)).toHaveLength(0);

    await bgTurn;
    await waitFor(
      () => daemon.store.getSession(sess.id)?.status === 'idle',
      8_000,
      `idle after bgTurn (got ${daemon.store.getSession(sess.id)?.status}, events=${daemon.store.getEventsAfter(sess.id, 0).map((e) => e.type).join(',')})`,
    );
    const events = daemon.store.getEventsAfter(sess.id, 0);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);

    // 2. Disable AGY runtime/driver provider (`core.harness.agy`) -> zero host fallback, explicit 409 E_PLUGIN_DISABLED
    await daemon.pluginManager.togglePlugin('core.harness.agy', false);
    expect(daemon.pluginManager.listServiceProviders(AGY_RUNTIME_CONTRACT)).toHaveLength(0);
    expect(daemon.pluginManager.listServiceProviders(AGY_ACCOUNTS_CONTRACT)).toHaveLength(0);

    const legacyAccounts = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/harnesses/agy/instances',
    });
    expect(legacyAccounts.statusCode).toBe(409);
    expect((legacyAccounts.json() as { code?: string }).code).toBe('E_PLUGIN_DISABLED');

    const legacyArtifacts = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sess.id}/agy/artifacts`,
    });
    expect(legacyArtifacts.statusCode).toBe(409);
    expect((legacyArtifacts.json() as { code?: string }).code).toBe('E_PLUGIN_DISABLED');

    const legacyNativeSnap = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sess.id}/native/snapshot`,
    });
    expect(legacyNativeSnap.statusCode).toBe(409);
    expect((legacyNativeSnap.json() as { code?: string }).code).toBe('E_PLUGIN_DISABLED');

    // 3. Re-enable AGY runtime + workbench -> recovers cleanly
    await daemon.pluginManager.togglePlugin('core.harness.agy', true);
    await daemon.pluginManager.togglePlugin('hm.plugin.agy-workbench-default', true);

    const recoveredAccounts = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/harnesses/agy/instances',
    });
    expect(recoveredAccounts.statusCode).toBe(200);
    const recoveredSnap = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sess.id}/native/snapshot`,
    });
    expect(recoveredSnap.statusCode).toBe(200);
  }, 45_000);
});
