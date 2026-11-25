import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MOCK_ACP_PEER_PATH = path.join(FIXTURES_DIR, 'mock-acp-peer.mjs');

const daemonRequire = createRequire(path.join(REPO_ROOT, 'packages', 'daemon', 'package.json'));
const WebSocket = daemonRequire('ws');
const { DatabaseSync } = await import('node:sqlite');

const protocolMod = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'protocol', 'dist', 'index.js')).href);
const appMod = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'server', 'app.js')).href);
const agyDriverMod = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'harnesses', 'agy', 'agy-driver.js')).href);
const agyCtxMod = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'harnesses', 'agy', 'agy-launch-context.js')).href);
const wiringTypesMod = await import(
  pathToFileURL(path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'harnesses', 'agy', 'native', 'wiring', 'types.js')).href
);

const replayMod = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'agy-np', 'observatory', 'replay-runner.mjs')).href);
const migratorMod = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'agy-np', 'observatory', 'migrator.mjs')).href);
const validatorMod = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'agy-np', 'observatory', 'schema-validator.mjs')).href);
const sanitizerMod = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'agy-np', 'observatory', 'sanitizer.mjs')).href);
const probeLiveMod = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'agy-np', 'observatory', 'probe-live.mjs')).href);

const { AGY_NATIVE_CONTRACT_REVISION, AGY_NATIVE_CONTRACT_VERSION, AGY_NATIVE_MIGRATION_COMPONENT, AGY_NATIVE_MIGRATION_VERSION } = protocolMod;
const { createDaemon } = appMod;
const { AgyAdapter } = agyDriverMod;
const { DEFAULT_AGY_APP_DATA_DIR_NAME } = agyCtxMod;
const { DEFAULT_AGY_NATIVE_FEATURE_FLAGS } = wiringTypesMod;

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function waitFor(fn, timeoutMs = 10_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

class ScriptAgyAdapter extends AgyAdapter {
  constructor(opts, scriptPath, extraEnv = {}) {
    super({
      ...opts,
      envWhitelist: {
        ...(opts.envWhitelist ?? {}),
        ...extraEnv,
      },
    });
    this.scriptPath = scriptPath;
    this.extraEnv = extraEnv;
  }

  buildLaunchArgs() {
    return [this.scriptPath];
  }

  buildSpawnEnv() {
    return {
      ...(super.buildSpawnEnv() ?? {}),
      ...this.extraEnv,
    };
  }
}

function makeScriptAgyProfile(instanceId) {
  return {
    instanceId,
    displayName: `AGY Synthetic (${instanceId})`,
    isolationMode: 'profile_isolated',
    authMethod: 'oauth-personal',
    appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
    defaults: { linkGlobalSkills: false, syncGlobalRules: false, additionalDirectories: [] },
    enabled: true,
  };
}

function authHeaders(daemon, port, extra = {}) {
  const headers = {
    Origin: `http://127.0.0.1:${port}`,
    ...extra,
  };
  if (daemon.config?.localToken) {
    headers.Authorization = `Bearer ${daemon.config.localToken}`;
  }
  return headers;
}

async function apiJson(baseUrl, daemon, port, method, urlPath, body, extraHeaders = {}) {
  const headers = authHeaders(daemon, port, extraHeaders);
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { rawText: text };
  }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
}

function openNativeWs(wsUrl, daemon, port) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const headers = { Origin: `http://127.0.0.1:${port}` };
    if (daemon.config?.localToken) {
      headers.Authorization = `Bearer ${daemon.config.localToken}`;
    }
    const ws = new WebSocket(wsUrl, { headers });
    const timer = setTimeout(() => {
      reject(new Error('Timed out opening WebSocket'));
    }, 6_000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ ws, frames });
    });
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(String(data)));
      } catch {
        frames.push({ raw: String(data) });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function checkNoSensitiveLeak(obj, contextLabel) {
  const text = JSON.stringify(obj);
  const findings = sanitizerMod.scanRecordForLeaks(obj);
  assert(findings.length === 0, `${contextLabel} leaked patterns: ${JSON.stringify(findings)}`);
  assert(!text.includes('"connectionId"'), `${contextLabel} exposed internal connectionId`);
  assert(!text.includes('"nativeAlias"'), `${contextLabel} exposed internal nativeAlias`);
}

async function runSuiteAFeatureOn({ rootDir, results }) {
  const dataDir = path.join(rootDir, 'suite-a-data');
  const wsDir = path.join(rootDir, 'suite-a-ws');
  const profilesDir = path.join(rootDir, 'suite-a-profiles');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'AGENTS.md'), '# NP-17 Synthetic Rules\n', 'utf8');

  const daemon = createDaemon({
    dataDir,
    port: 0,
    hostOverride: '127.0.0.1',
    webDistDir: null,
    binaryOverrides: {
      agy: path.join(rootDir, 'blocked-real-agy-sentinel'),
    },
    nativeFeatureFlags: {
      enabled: true,
      nativeLifecycle: true,
      nativePermissions: true,
      nativeCommands: true,
      nativeWorkflowObservation: true,
      nativeTasksObservation: true,
      observatoryTap: true,
      acpV2Preview: false,
    },
  });

  const { port } = await daemon.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  daemon.registry.register(
    new ScriptAgyAdapter(
      {
        profile: makeScriptAgyProfile('agy-np17-reactive'),
        profilesRootDir: profilesDir,
        binaryOverride: process.execPath,
        applyWindowsAcl: false,
      },
      MOCK_ACP_PEER_PATH,
      { NP17_ACP_SCENARIO: 'reactive_t02_t04', NP17_NATIVE_SESSION_ID: 'np17_nat_a1' },
    ),
  );

  daemon.registry.register(
    new ScriptAgyAdapter(
      {
        profile: makeScriptAgyProfile('agy-np17-req'),
        profilesRootDir: profilesDir,
        binaryOverride: process.execPath,
        applyWindowsAcl: false,
      },
      MOCK_ACP_PEER_PATH,
      { NP17_ACP_SCENARIO: 'requests_t06_t07', NP17_NATIVE_SESSION_ID: 'np17_nat_req_1' },
    ),
  );

  try {
    // A1: Origin / Security Gate
    const badOrigin = await fetch(`${baseUrl}/api/v1/workspaces`, {
      method: 'GET',
      headers: {
        Origin: 'https://untrusted.example',
        ...(daemon.config?.localToken ? { Authorization: `Bearer ${daemon.config.localToken}` } : {}),
      },
    });
    assert(badOrigin.status === 403, `Expected 403 for untrusted origin, got ${badOrigin.status}`);
    results.push({ id: 'A1_origin_security_gate', status: 'passed', httpStatus: badOrigin.status });

    // A2: Create Workspace + AGY Session + Connect Real Native WS
    const wsRes = await apiJson(baseUrl, daemon, port, 'POST', '/api/v1/workspaces', {
      rootPath: wsDir,
      name: 'NP17-WS',
    });
    assert(wsRes.status === 201 || wsRes.status === 200, `Workspace create failed: ${wsRes.status}`);
    const workspaceId = wsRes.json.workspace.id;

    const sessRes = await apiJson(baseUrl, daemon, port, 'POST', '/api/v1/sessions', {
      workspaceId,
      harnessId: 'agy-np17-reactive',
      model: 'gemini-3.8-flash',
      permissionMode: 'manual',
    });
    assert(sessRes.status === 201 || sessRes.status === 200, `Session create failed: ${sessRes.status}`);
    const sessionId = sessRes.json.session.id;

    const wsConn = await openNativeWs(`ws://127.0.0.1:${port}/api/v1/sessions/${sessionId}/native/ws`, daemon, port);
    try {
      const helloFrame = await waitFor(
        () => wsConn.frames.find((f) => f.op === 'native_hello'),
        5_000,
        'WS native_hello',
      );
      if (helloFrame.generation) {
        wsConn.ws.send(
          JSON.stringify({
            op: 'subscribe_native',
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            afterSeq: 0,
            generation: helloFrame.generation,
          }),
        );
      }
      results.push({
        id: 'A2_native_ws_handshake',
        status: 'passed',
        frameOps: wsConn.frames.map((f) => f.op),
      });

      // A3: Reactive Turn T02/T04 (holds early end_turn for finite bg; ignores detached daemon)
      const turnRes = await apiJson(baseUrl, daemon, port, 'POST', `/api/v1/sessions/${sessionId}/turns`, {
        text: 'Execute T02 finite background + detached daemon check',
      });
      assert(turnRes.status === 202, `Turn submit failed: ${turnRes.status}`);

      const eventsDone = await waitFor(async () => {
        const evRes = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${sessionId}/events`);
        const events = evRes.json?.events ?? [];
        const failed = events.find((e) => e.type === 'turn.failed');
        if (failed) {
          throw new Error(`Reactive turn emitted turn.failed: ${JSON.stringify(failed.payload)}`);
        }
        return events.some((e) => e.type === 'turn.completed') ? events : null;
      }, 15_000, 'reactive turn.completed').catch(async (err) => {
        const evRes = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${sessionId}/events`);
        const snap = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${sessionId}/native/snapshot`);
        console.error('DIAGNOSTIC EVENTS:', JSON.stringify(evRes.json, null, 2));
        console.error('DIAGNOSTIC SNAPSHOT:', JSON.stringify(snap.json, null, 2));
        throw err;
      });

      const completedCount = eventsDone.filter((e) => e.type === 'turn.completed').length;
      const assistantText = eventsDone
        .filter((e) => e.type === 'message.assistant.delta' || e.type === 'message.assistant.completed')
        .map((e) => String(e.payload?.text ?? ''))
        .join('');
      assert(completedCount === 1, `Expected single turn.completed, got ${completedCount}`);
      assert(assistantText.includes('NP17_REACTIVE_COMPLETE'), 'Missing reactive wake text after early end_turn');

      const snapRes = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${sessionId}/native/snapshot`);
      assert(snapRes.status === 200, `Native snapshot failed: ${snapRes.status}`);
      const capRes = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${sessionId}/native/capabilities`);
      assert(capRes.status === 200, `Native capabilities failed: ${capRes.status}`);
      const natEvRes = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${sessionId}/native/events?after=0`);
      assert(natEvRes.status === 200, `Native events failed: ${natEvRes.status}`);

      // Verify live native WS replay subscription once binding exists
      const replayWs = await openNativeWs(`ws://127.0.0.1:${port}/api/v1/sessions/${sessionId}/native/ws`, daemon, port);
      try {
        const boundHello = await waitFor(
          () => replayWs.frames.find((f) => f.op === 'native_hello'),
          5_000,
          'bound WS native_hello',
        );
        replayWs.ws.send(
          JSON.stringify({
            op: 'subscribe_native',
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            afterSeq: 0,
            generation: boundHello.generation ?? snapRes.json.projection.binding.generation,
          }),
        );
        await waitFor(
          () => replayWs.frames.some((f) => f.op === 'native_replay_complete'),
          5_000,
          'WS native_replay_complete',
        );
        var wsEventFrames = replayWs.frames.filter((f) => f.op === 'native_event').length;
      } finally {
        replayWs.ws.close();
      }

      checkNoSensitiveLeak(snapRes.json, 'native/snapshot');
      checkNoSensitiveLeak(natEvRes.json, 'native/events');

      const firstActivityId = snapRes.json?.projection?.activities?.[0]?.id;
      let timelineCount = 0;
      if (firstActivityId) {
        const tlRes = await apiJson(
          baseUrl,
          daemon,
          port,
          'GET',
          `/api/v1/sessions/${sessionId}/native/activity/${encodeURIComponent(firstActivityId)}/timeline`,
        );
        assert(tlRes.status === 200, `Activity timeline failed: ${tlRes.status}`);
        timelineCount = (tlRes.json?.items ?? []).length;
      }

      results.push({
        id: 'A3_reactive_turn_and_projection',
        status: 'passed',
        completedCount,
        nativeWorkCount: (snapRes.json?.projection?.work ?? []).length,
        nativeEventCount: (natEvRes.json?.events ?? []).length,
        timelineCount,
        wsEventFrames,
      });

      // A4: T08 Command Router, Idempotency, Control & Fail-Closed Gates
      const projection = snapRes.json.projection;
      const binding = projection.binding;
      const catRev = projection.capabilitiesRevision;

      const inspectModelsBody = {
        bindingGeneration: binding.generation,
        catalogRevision: catRev,
        capabilityId: 'AGY-S10',
        actionKey: 'inspect_models',
        args: {},
        idempotencyKey: 'np17_models_idem_1',
      };
      const cmdRes1 = await apiJson(
        baseUrl,
        daemon,
        port,
        'POST',
        `/api/v1/sessions/${sessionId}/native/commands`,
        inspectModelsBody,
      );
      assert(
        cmdRes1.status === 200 || cmdRes1.status === 202,
        `AGY-S10 inspect_models failed unexpectedly: ${cmdRes1.status} ${JSON.stringify(cmdRes1.json)}`,
      );

      // Idempotent duplicate same payload -> same receiptId
      const cmdResDup = await apiJson(
        baseUrl,
        daemon,
        port,
        'POST',
        `/api/v1/sessions/${sessionId}/native/commands`,
        inspectModelsBody,
      );
      assert(cmdResDup.status === cmdRes1.status, `Duplicate idempotency status mismatch: ${cmdResDup.status}`);
      assert(cmdResDup.json?.receiptId === cmdRes1.json?.receiptId, 'Duplicate idempotency minted different receiptId');

      // Mutated payload with same idempotencyKey -> 409 IDEMPOTENCY_CONFLICT
      const cmdConflict = await apiJson(baseUrl, daemon, port, 'POST', `/api/v1/sessions/${sessionId}/native/commands`, {
        ...inspectModelsBody,
        args: { extra: 'mutated' },
      });
      assert(
        cmdConflict.status === 409 && cmdConflict.json?.code === 'IDEMPOTENCY_CONFLICT',
        `Expected 409 IDEMPOTENCY_CONFLICT, got ${cmdConflict.status}`,
      );

      // Auth-required / workflow-gated actions fail closed when profileVerified=false or workflow routing disabled
      const planGated = await apiJson(baseUrl, daemon, port, 'POST', `/api/v1/sessions/${sessionId}/native/commands`, {
        bindingGeneration: binding.generation,
        catalogRevision: catRev,
        capabilityId: 'AGY-W13',
        actionKey: 'set_plan_mode',
        args: {},
        idempotencyKey: 'np17_plan_gated_1',
      });
      assert(planGated.status >= 400, `Expected unverified-profile gate on set_plan_mode, got ${planGated.status}`);

      const workflowGated = await apiJson(baseUrl, daemon, port, 'POST', `/api/v1/sessions/${sessionId}/native/commands`, {
        bindingGeneration: binding.generation,
        catalogRevision: catRev,
        capabilityId: 'AGY-W09',
        actionKey: 'launch_goal',
        args: { objective: 'Verify fail-closed' },
        idempotencyKey: 'np17_goal_gated_1',
      });
      assert(workflowGated.status >= 400, `Expected fail-closed workflow dispatch, got ${workflowGated.status}`);

      // Unverified agent cancel target must reject with 422
      const badCancel = await apiJson(baseUrl, daemon, port, 'POST', `/api/v1/sessions/${sessionId}/native/control`, {
        generation: binding.generation,
        target: { type: 'agent', id: 'agt_unverified_np17' },
        action: 'cancel',
        expectedRevision: projection.revision ?? 0,
        idempotencyKey: 'np17_bad_cancel_1',
      });
      assert(badCancel.status === 422, `Expected 422 for unverified agent cancel, got ${badCancel.status}`);

      results.push({
        id: 'A4_commands_control_and_idempotency',
        status: 'passed',
        inspectModelsStatus: cmdRes1.status,
        planGatedStatus: planGated.status,
        workflowGatedStatus: workflowGated.status,
        badCancelStatus: badCancel.status,
      });

      // A5: T06/T07 Out-of-Turn Permission & Structured Question Routing + CAS
      const reqSessRes = await apiJson(baseUrl, daemon, port, 'POST', '/api/v1/sessions', {
        workspaceId,
        harnessId: 'agy-np17-req',
        permissionMode: 'manual',
      });
      assert(reqSessRes.status === 201 || reqSessRes.status === 200, 'Request session create failed');
      const reqSessId = reqSessRes.json.session.id;

      await apiJson(baseUrl, daemon, port, 'POST', `/api/v1/sessions/${reqSessId}/turns`, {
        text: 'trigger out-of-turn permission',
      });
      const pendingPerm = await waitFor(async () => {
        const res = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${reqSessId}/native/requests`);
        const pending = (res.json?.requests ?? []).find((r) => r.canAnswer && r.receiptState === 'pending');
        return pending ? { binding: res.json.binding, pending } : null;
      }, 8_000, 'out-of-turn native request');

      const resolveOk = await apiJson(
        baseUrl,
        daemon,
        port,
        'POST',
        `/api/v1/sessions/${reqSessId}/native/requests/${pendingPerm.pending.approvalId}/resolve`,
        {
          generation: pendingPerm.binding.generation,
          outcome: 'selected',
          optionId: 'allow_once',
        },
      );
      assert(resolveOk.status === 200, `Native request resolve failed: ${resolveOk.status} ${JSON.stringify(resolveOk.json)}`);

      const resolveDup = await apiJson(
        baseUrl,
        daemon,
        port,
        'POST',
        `/api/v1/sessions/${reqSessId}/native/requests/${pendingPerm.pending.approvalId}/resolve`,
        {
          generation: pendingPerm.binding.generation,
          outcome: 'selected',
          optionId: 'allow_once',
        },
      );
      assert(resolveDup.status === 409, `Expected 409 CAS conflict on duplicate resolve, got ${resolveDup.status} ${JSON.stringify(resolveDup.json)}`);

      const permEvents = await waitFor(async () => {
        const ev = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${reqSessId}/events`);
        const txt = (ev.json?.events ?? [])
          .filter((e) => e.type === 'message.assistant.delta' || e.type === 'message.assistant.completed')
          .map((e) => String(e.payload?.text ?? ''))
          .join('');
        return txt.includes('NP17_PERM_RESOLVED') ? txt : null;
      }, 8_000, 'NP17_PERM_RESOLVED');

      // Question roundtrip
      await apiJson(baseUrl, daemon, port, 'POST', `/api/v1/sessions/${reqSessId}/turns`, {
        text: 'ask-question rollout',
      });
      const pendingQuestion = await waitFor(async () => {
        const res = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${reqSessId}/native/requests`);
        const q = (res.json?.requests ?? []).find(
          (r) =>
            r.canAnswer &&
            r.receiptState === 'pending' &&
            r.approvalId !== pendingPerm.pending.approvalId,
        );
        return q ? { binding: res.json.binding, request: q } : null;
      }, 8_000, 'user_question native request');

      const resolveQ = await apiJson(
        baseUrl,
        daemon,
        port,
        'POST',
        `/api/v1/sessions/${reqSessId}/native/requests/${pendingQuestion.request.approvalId}/resolve`,
        {
          generation: pendingQuestion.binding.generation,
          outcome: 'selected',
          optionId: 'canary',
        },
      );
      assert(resolveQ.status === 200, `Question resolve failed: ${resolveQ.status} ${JSON.stringify(resolveQ.json)}`);

      const qDone = await waitFor(async () => {
        const ev = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${reqSessId}/events`);
        const txt = (ev.json?.events ?? [])
          .filter((e) => e.type === 'message.assistant.delta' || e.type === 'message.assistant.completed')
          .map((e) => String(e.payload?.text ?? ''))
          .join('');
        return txt.includes('NP17_QUESTION_RESOLVED:canary') ? ev.json.events : null;
      }, 8_000, 'NP17_QUESTION_RESOLVED');

      results.push({
        id: 'A5_out_of_turn_permission_and_question_cas',
        status: 'passed',
        permResolvedTextObserved: Boolean(permEvents),
        questionTurnCompleted: qDone.some((e) => e.type === 'turn.completed'),
      });

      // A6: Production Wiring Audit Probes (records observed route state cleanly)
      const legacyEco = await apiJson(baseUrl, daemon, port, 'GET', `/api/v1/sessions/${sessionId}/agy/ecosystem`);
      const np13NativeEco = await apiJson(
        baseUrl,
        daemon,
        port,
        'GET',
        `/api/v1/sessions/${sessionId}/native/ecosystem-catalog`,
      );
      const np14NativeArt = await apiJson(
        baseUrl,
        daemon,
        port,
        'GET',
        `/api/v1/sessions/${sessionId}/native/artifacts`,
      );
      results.push({
        id: 'A6_production_wiring_audit_probes',
        status: 'passed',
        legacyEcosystemStatus: legacyEco.status,
        nativeEcosystemCatalogRouteStatus: np13NativeEco.status,
        nativeArtifactsRouteStatus: np14NativeArt.status,
        note: 'Legacy ecosystem is readable. The native ecosystem and artifact routes are absent from this candidate. Recovery wiring needs its own acceptance.',
      });

      return { dataDir, wsDir, profilesDir, sessionId, reqSessId };
    } finally {
      wsConn.ws.close();
    }
  } finally {
    await daemon.stop();
  }
}

async function runSuiteBRollbackAndSchema({ rootDir, priorState, results }) {
  // B1: Reboot same SQLite dataDir with DEFAULT_AGY_NATIVE_FEATURE_FLAGS (all false -> Gate-OFF / Rollback)
  const daemonOff = createDaemon({
    dataDir: priorState.dataDir,
    port: 0,
    hostOverride: '127.0.0.1',
    webDistDir: null,
    binaryOverrides: {
      agy: path.join(rootDir, 'blocked-real-agy-sentinel'),
    },
  });

  const { port } = await daemonOff.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  daemonOff.registry.register(
    new ScriptAgyAdapter(
      {
        profile: makeScriptAgyProfile('agy-np17-reactive'),
        profilesRootDir: priorState.profilesDir,
        binaryOverride: process.execPath,
        applyWindowsAcl: false,
      },
      MOCK_ACP_PEER_PATH,
      { NP17_ACP_SCENARIO: 'default_clean', NP17_NATIVE_SESSION_ID: 'np17_nat_rollback' },
    ),
  );
  try {
    // Native write endpoints must fail closed with 503 NATIVE_RUNTIME_DISABLED, and snapshot reports enabled: false
    const snapOff = await apiJson(
      baseUrl,
      daemonOff,
      port,
      'GET',
      `/api/v1/sessions/${priorState.sessionId}/native/snapshot`,
    );
    const cmdOff = await apiJson(
      baseUrl,
      daemonOff,
      port,
      'POST',
      `/api/v1/sessions/${priorState.sessionId}/native/commands`,
      {
        bindingGeneration: 'gen_0',
        catalogRevision: 0,
        capabilityId: 'AGY-W13',
        actionKey: 'set_plan_mode',
        args: {},
        idempotencyKey: 'np17_off_1',
      },
    );
    const ctrlOff = await apiJson(
      baseUrl,
      daemonOff,
      port,
      'POST',
      `/api/v1/sessions/${priorState.sessionId}/native/control`,
      {
        generation: 'gen_0',
        target: { type: 'runtime', id: 'nrt_off' },
        action: 'cancel',
        expectedRevision: 0,
        idempotencyKey: 'np17_ctrl_off_1',
      },
    );
    assert(
      snapOff.status === 200 && snapOff.json?.enabled === false && snapOff.json?.projection?.enabled === false,
      `Expected disabled snapshot on gate-off, got ${snapOff.status} ${JSON.stringify(snapOff.json)}`,
    );
    assert(cmdOff.status === 503 && cmdOff.json?.code === 'NATIVE_RUNTIME_DISABLED', `Expected 503 NATIVE_RUNTIME_DISABLED on commands, got ${cmdOff.status}`);
    assert(ctrlOff.status === 503 && ctrlOff.json?.code === 'NATIVE_RUNTIME_DISABLED', `Expected 503 NATIVE_RUNTIME_DISABLED on control, got ${ctrlOff.status}`);

    // Legacy session & prior native-era historical data remain 100% readable!
    const oldSessionRes = await apiJson(baseUrl, daemonOff, port, 'GET', `/api/v1/sessions/${priorState.sessionId}`);
    const oldEventsRes = await apiJson(
      baseUrl,
      daemonOff,
      port,
      'GET',
      `/api/v1/sessions/${priorState.sessionId}/events`,
    );
    assert(oldSessionRes.status === 200, `Old session read failed after rollback: ${oldSessionRes.status}`);
    assert(oldEventsRes.status === 200 && (oldEventsRes.json?.events ?? []).length >= 3, 'Old session events lost/unreadable after rollback');

    // Post-rollback rerun of standard AGY session turn works cleanly
    const postTurn = await apiJson(baseUrl, daemonOff, port, 'POST', `/api/v1/sessions/${priorState.sessionId}/turns`, {
      text: 'post-rollback clean check',
    });
    assert(postTurn.status === 202, `Post-rollback turn submit failed: ${postTurn.status}`);
    const postDone = await waitFor(async () => {
      const ev = await apiJson(baseUrl, daemonOff, port, 'GET', `/api/v1/sessions/${priorState.sessionId}/events`);
      const txt = (ev.json?.events ?? [])
        .filter((e) => e.type === 'message.assistant.delta' || e.type === 'message.assistant.completed')
        .map((e) => String(e.payload?.text ?? ''))
        .join('');
      return txt.includes('NP17_TURN_1_OK') ? ev.json.events : null;
    }, 8_000, 'post-rollback turn completion');

    // Cross-harness Handoff regression after rollback (handoff to default codex slot)
    const handoffRes = await apiJson(baseUrl, daemonOff, port, 'POST', `/api/v1/sessions/${priorState.sessionId}/handoff`, {
      targetHarnessId: 'codex',
    });
    assert(handoffRes.status === 200 || handoffRes.status === 201, `Cross-harness handoff after rollback failed: ${handoffRes.status}`);

    results.push({
      id: 'B1_gate_off_rollback_and_post_rollback_rerun',
      status: 'passed',
      snapshotGateOffStatus: snapOff.status,
      oldSessionEventsCount: oldEventsRes.json.events.length,
      postRollbackEventsCount: postDone.length,
      handoffTargetHarness: handoffRes.json?.session?.harnessId,
    });
  } finally {
    await daemonOff.stop();
  }

  // B2: Forward Schema Version 99 Fail-Closed Tolerance
  const forwardDataDir = path.join(rootDir, 'suite-b-forward-db');
  fs.mkdirSync(forwardDataDir, { recursive: true });
  const seedDaemon = createDaemon({
    dataDir: forwardDataDir,
    port: 0,
    hostOverride: '127.0.0.1',
    webDistDir: null,
    binaryOverrides: {
      agy: path.join(rootDir, 'blocked-real-agy-sentinel'),
    },
  });
  const dbPath = seedDaemon.paths.dbPath;
  const ws = seedDaemon.store.createWorkspace({
    id: 'ws_fwd',
    name: 'Fwd Schema WS',
    rootPath: priorState.wsDir,
    isGitRepo: false,
    gitBranch: null,
    createdAt: Date.now(),
  });
  seedDaemon.store.createSession({
    id: 'sess_fwd_legacy',
    workspaceId: ws.id,
    harnessId: 'codex',
    harnessKind: 'codex',
    nativeSessionId: null,
    cwd: priorState.wsDir,
    worktreeBranch: null,
    title: 'Legacy Session Under Newer Native Schema',
    status: 'idle',
    model: null,
    reasoningEffort: null,
    permissionMode: 'manual',
    lastSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await seedDaemon.stop();

  const rawDb = new DatabaseSync(dbPath);
  rawDb
    .prepare('INSERT OR REPLACE INTO component_schema_migrations (component, version, updated_at) VALUES (?, ?, ?)')
    .run(AGY_NATIVE_MIGRATION_COMPONENT, AGY_NATIVE_MIGRATION_VERSION + 98, Date.now());
  rawDb.close();

  const daemonFwd = createDaemon({
    dataDir: forwardDataDir,
    port: 0,
    hostOverride: '127.0.0.1',
    webDistDir: null,
    binaryOverrides: {
      agy: path.join(rootDir, 'blocked-real-agy-sentinel'),
    },
    nativeFeatureFlags: { enabled: true, nativeLifecycle: true, nativeCommands: true },
  });
  const fwdStatus = daemonFwd.store.getNativeRuntimeSchemaStatus();
  assert(fwdStatus.compatible === false && fwdStatus.newerThanReader === true, `Expected newerThanReader=true, got ${JSON.stringify(fwdStatus)}`);
  let schemaGuardCode = null;
  try {
    daemonFwd.nativeRegistry.ensureRuntimeBinding({
      sessionId: 'sess_fwd_legacy',
      instanceId: 'agy',
      profileRef: 'agy:default',
      status: 'attached',
    });
  } catch (err) {
    schemaGuardCode = err?.code ?? err?.message ?? 'thrown';
  }
  assert(
    schemaGuardCode === 'NATIVE_SCHEMA_NEWER_THAN_READER',
    `Expected NATIVE_SCHEMA_NEWER_THAN_READER on forward schema write, got ${schemaGuardCode}`,
  );
  const fwdListen = await daemonFwd.start();
  const fwdUrl = `http://127.0.0.1:${fwdListen.port}`;
  try {
    const legacyRead = await apiJson(fwdUrl, daemonFwd, fwdListen.port, 'GET', '/api/v1/sessions/sess_fwd_legacy');
    const natBlocked = await apiJson(
      fwdUrl,
      daemonFwd,
      fwdListen.port,
      'POST',
      '/api/v1/sessions/sess_fwd_legacy/native/commands',
      {
        bindingGeneration: 'gen_0',
        catalogRevision: 0,
        capabilityId: 'AGY-S10',
        actionKey: 'inspect_models',
        args: {},
        idempotencyKey: 'np17_fwd_1',
      },
    );
    assert(legacyRead.status === 200, `Legacy session unreadable under forward native schema: ${legacyRead.status}`);
    assert(natBlocked.status >= 400, `Native route should fail closed on forward schema, got ${natBlocked.status}`);
    results.push({
      id: 'B2_forward_schema_isolation',
      status: 'passed',
      schemaStatus: fwdStatus,
      schemaGuardCode,
      legacySessionStatus: legacyRead.status,
      nativeRouteBlockedStatus: natBlocked.status,
    });
  } finally {
    await daemonFwd.stop();
  }
}

async function runSuiteCReplayAndCompat({ results }) {
  const replayLoaded = replayMod.loadReplayFixture(path.join(FIXTURES_DIR, 'e2e-t01-t06-lifecycle.ndjson'));
  const replayOutcome = await replayMod.runTransportReplay(replayLoaded);
  assert(replayOutcome.validation.valid === true, 'NP17 lifecycle replay capture schema validation failed');
  assert(replayOutcome.validation.leakFindings.length === 0, 'NP17 lifecycle replay leak detected');
  assert(replayOutcome.verdict.passed === true, `NP17 lifecycle replay verdict failed: ${JSON.stringify(replayOutcome.verdict.checks)}`);

  const compatText = fs.readFileSync(path.join(FIXTURES_DIR, 'e2e-legacy-1.5.14-compat.ndjson'), 'utf8');
  const migrated = migratorMod.migrateNdjsonToV1(compatText, {
    captureId: 'np17-compat-1514',
    scenario: 'np17_1514_compat',
    origin: 'np17_e2e_fixture',
  });
  assert(migrated.valid && migrated.validation.valid, 'NP17 1.5.14 compatibility migration failed');
  assert(migrated.validation.leakFindings.length === 0, 'NP17 1.5.14 compatibility leak detected');

  const uiMatrix = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'e2e-ui-four-states.json'), 'utf8'));
  const checklist = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'windows-comparison-checklist.json'), 'utf8'));
  assert(uiMatrix.states.actionable && uiMatrix.states.read_only && uiMatrix.states.no_data && uiMatrix.states.stale_request, 'UI 4-state matrix incomplete');
  assert(Array.isArray(checklist.comparisons) && checklist.comparisons.length >= 7, 'Windows comparison checklist incomplete');

  results.push({
    id: 'C1_independent_replay_and_1514_compat',
    status: 'passed',
    replayRecords: replayOutcome.records.length,
    replayLayers: replayOutcome.summary.layerCounts,
    migrated1514Records: migrated.records.length,
    checklistItems: checklist.comparisons.length,
  });
}

async function runSuiteDLiveCleanCli({ outDir, runRoot, agyPath, skipLiveCli, results }) {
  if (skipLiveCli || !agyPath) {
    results.push({ id: 'D1_live_clean_agy_cli_probe', status: 'skipped', reason: 'No live CLI probe requested' });
    return;
  }
  assert(process.platform === 'win32' && fs.existsSync(agyPath), 'Requested official AGY CLI is unavailable');
  const scratchV1 = path.join(runRoot, 'agy-v1');
  const scratchV2 = path.join(runRoot, 'agy-v2');
  const outV1 = path.join(outDir, 'e2e-clean-v1.ndjson');
  const outV2 = path.join(outDir, 'e2e-clean-v2.ndjson');

  try {
    const recV1 = await probeLiveMod.runLiveRecord([
      '--agy',
      agyPath,
      '--scratch',
      scratchV1,
      '--protocol',
      '1',
      '--scenario',
      'np17_e2e_clean_v1',
      '--out',
      outV1,
    ]);
    const recV2 = await probeLiveMod.runLiveRecord([
      '--agy',
      agyPath,
      '--scratch',
      scratchV2,
      '--protocol',
      '2',
      '--scenario',
      'np17_e2e_clean_v2',
      '--out',
      outV2,
    ]);
    assert(recV1?.success && recV2?.success, 'Clean v1/v2 live probe failed');
    const valV1 = validatorMod.parseAndValidateNdjson(fs.readFileSync(outV1, 'utf8'));
    const valV2 = validatorMod.parseAndValidateNdjson(fs.readFileSync(outV2, 'utf8'));
    assert(valV1.valid && valV1.leakFindings.length === 0, 'Live v1 probe validation/leak check failed');
    assert(valV2.valid && valV2.leakFindings.length === 0, 'Live v2 downgrade probe validation/leak check failed');

    results.push({
      id: 'D1_live_clean_agy_cli_probe',
      status: 'passed',
      v1CaptureId: recV1.captureId,
      v2CaptureId: recV2.captureId,
      v1Records: valV1.recordCount,
      v2Records: valV2.recordCount,
    });
  } finally {
    for (const dir of [scratchV1, scratchV2]) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
          // Windows handles on temp dirs may release asynchronously
        }
      }
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'out-dir': { type: 'string', default: 'D:\\HarnessMate\\np17-temp\\e2e-run' },
      'skip-live-cli': { type: 'boolean', default: false },
      'agy-path': { type: 'string' },
    },
  });

  const outDir = path.resolve(values['out-dir']);
  if (process.platform === 'win32') probeLiveMod.requireDPath(outDir, '--out-dir');
  if (values['agy-path'] && !values['skip-live-cli']) {
    probeLiveMod.requireAllowedDir(outDir, '--out-dir', [probeLiveMod.G0_ALLOWED_CLEAN_ROOTS[0]]);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(outDir, 'work-'));
  const results = [];

  try {
    assert(Boolean(DEFAULT_AGY_NATIVE_FEATURE_FLAGS), 'DEFAULT_AGY_NATIVE_FEATURE_FLAGS missing');
    assert(DEFAULT_AGY_NATIVE_FEATURE_FLAGS.enabled === false, 'Default native flags must be closed');

    const priorState = await runSuiteAFeatureOn({ rootDir: runRoot, results });
    await runSuiteBRollbackAndSchema({ rootDir: runRoot, priorState, results });
    await runSuiteCReplayAndCompat({ results });
    await runSuiteDLiveCleanCli({
      outDir,
      runRoot,
      agyPath: values['agy-path'],
      skipLiveCli: values['skip-live-cli'],
      results,
    });

    const summary = {
      schemaVersion: 1,
      contractRevision: AGY_NATIVE_CONTRACT_REVISION,
      migrationComponent: AGY_NATIVE_MIGRATION_COMPONENT,
      migrationVersion: AGY_NATIVE_MIGRATION_VERSION,
      generatedAt: new Date().toISOString(),
      overallStatus: 'passed',
      checks: results,
    };
    const summaryPath = path.join(outDir, 'np17-acceptance-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    try {
      fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // Ignore transient Windows file handle locks on temporary verification directories
    }
  }
}

main().catch((err) => {
  console.error('NP-17 Acceptance Suite FAILED:', err);
  process.exitCode = 1;
});
