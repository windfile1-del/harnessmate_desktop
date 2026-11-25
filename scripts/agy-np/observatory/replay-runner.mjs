import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFourLayerSummary } from './four-layer.mjs';
import { createDaemonTapCallbacks, ProtocolObservatoryRecorder } from './recorder.mjs';
import { validateCaptureRecords } from './schema-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export function loadReplayFixture(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, idx) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new Error(`Invalid JSON in fixture ${filePath} line ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  const meta = lines.find((l) => l.kind === 'scenario_meta');
  if (!meta) {
    throw new Error(`Fixture ${filePath} missing scenario_meta header line`);
  }
  const steps = lines.filter((l) => l.kind !== 'scenario_meta');
  return { meta, steps };
}

export function evaluateVerdictCriteria(criteria = {}, records = [], summary = null) {
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });

  if (typeof criteria.minRecords === 'number') {
    check('minRecords', records.length >= criteria.minRecords, `got=${records.length}, expected>=${criteria.minRecords}`);
  }
  if (criteria.zeroLeaks !== false) {
    const val = validateCaptureRecords(records);
    check('schemaAndZeroLeaks', val.valid && val.leakFindings.length === 0, val.valid ? 'ok' : val.errors.join('; '));
  }
  if (Array.isArray(criteria.requiredMessageKinds)) {
    const seen = new Set(records.map((r) => r.messageKind));
    for (const kind of criteria.requiredMessageKinds) {
      check(`messageKind:${kind}`, seen.has(kind), seen.has(kind) ? 'present' : 'missing');
    }
  }
  if (Array.isArray(criteria.requiredUpdateTypes)) {
    const seen = new Set(records.map((r) => r.shape?.updateType).filter(Boolean));
    for (const ut of criteria.requiredUpdateTypes) {
      check(`updateType:${ut}`, seen.has(ut), seen.has(ut) ? 'present' : 'missing');
    }
  }
  if (Array.isArray(criteria.requiredStderrCategories)) {
    const seen = new Set(records.filter((r) => r.messageKind === 'stderr_classified').map((r) => r.shape?.category));
    for (const cat of criteria.requiredStderrCategories) {
      check(`stderrCategory:${cat}`, seen.has(cat), seen.has(cat) ? 'present' : 'missing');
    }
  }
  if (Array.isArray(criteria.requiredMarkers)) {
    const seen = new Set();
    for (const r of records) {
      if (Array.isArray(r.shape?.testMarkers)) {
        for (const m of r.shape.testMarkers) seen.add(m.marker);
      }
    }
    for (const marker of criteria.requiredMarkers) {
      check(`marker:${marker}`, seen.has(marker), seen.has(marker) ? 'correlated' : 'missing');
    }
  }
  if (Array.isArray(criteria.requiredLayers)) {
    const seen = new Set(records.map((r) => r.layer));
    for (const layer of criteria.requiredLayers) {
      check(`layer:${layer}`, seen.has(layer), seen.has(layer) ? 'present' : 'missing');
    }
  }
  if (typeof criteria.minMalformedLines === 'number') {
    const count = records.filter((r) => r.messageKind === 'malformed_line').length;
    check('minMalformedLines', count >= criteria.minMalformedLines, `got=${count}, expected>=${criteria.minMalformedLines}`);
  }
  if (typeof criteria.expectedExitCode === 'number') {
    const exitRec = records.find((r) => r.messageKind === 'process_exit');
    check(
      'expectedExitCode',
      exitRec?.shape?.exitCode === criteria.expectedExitCode,
      `got=${exitRec?.shape?.exitCode}, expected=${criteria.expectedExitCode}`,
    );
  }
  if (criteria.expectTimeout === true) {
    const hasTimeout = records.some((r) => r.messageKind === 'timeout');
    check('expectTimeout', hasTimeout, hasTimeout ? 'timeout_recorded' : 'missing_timeout');
  }
  if (Array.isArray(criteria.forbiddenSubstrings)) {
    const serialized = records.map((r) => JSON.stringify(r)).join('\n');
    for (const bad of criteria.forbiddenSubstrings) {
      const leaked = serialized.includes(bad);
      check(`noLeak:${bad.slice(0, 18)}`, !leaked, leaked ? 'LEAKED' : 'clean');
    }
  }
  if (Array.isArray(criteria.expectedAnomalies) && summary) {
    const seenStatuses = new Set(summary.anomalies.map((a) => a.status));
    for (const status of criteria.expectedAnomalies) {
      check(`anomaly:${status}`, seenStatuses.has(status), seenStatuses.has(status) ? 'observed' : 'not_observed');
    }
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * Runs a deterministic child-process stdio replay for a loaded fixture.
 * Separates child startup readiness (via IPC `replay_ready`) from scenario timeline and watchdog,
 * and waits for process exit + stream close before computing the final verdict.
 */
export async function runTransportReplay(fixture, options = {}) {
  const { meta, steps } = fixture;
  const simulateSlowStartMs = Number(options.simulateSlowStartMs ?? 0);
  const recorder = new ProtocolObservatoryRecorder({
    captureId: options.captureId ?? `replay-${meta.scenarioId}`,
    scenario: meta.scenarioId,
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    cliVersion: meta.cliVersion ?? '1.5.16-replay',
    protocol: null,
    accountCategory: meta.accountCategory ?? 'synthetic',
    source: meta.source ?? 'replay_with_provenance',
    producer: 'replay_harness',
    salt: options.salt ?? 'np01-replay-deterministic-salt',
    provenance: {
      origin: meta.provenanceOrigin ?? `fixture:${meta.scenarioId}`,
      migratedFrom: null,
      timingSynthetic: true,
      notes: meta.description ?? 'Deterministic NP-01 observatory replay',
    },
  });

  const tap = createDaemonTapCallbacks(recorder);
  const connId = 'conn-1';
  const generation = meta.generation ?? 'gen-1';
  recorder.recordCaptureMeta(
    { profileSource: meta.accountCategory ?? 'synthetic', mode: 'transport_replay', requestedProtocol: meta.protocol ?? 1 },
    { connectionId: connId, generation },
  );

  const childScript = `
    import readline from 'node:readline';
    const steps = JSON.parse(process.env.NP01_REPLAY_STEPS || '[]');
    const slowStartMs = Number(process.env.NP01_SLOW_START_MS || '0');
    const emitStep = async (step) => {
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (step.action === 'stdout_frame') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...step.frame }) + '\\n');
      } else if (step.action === 'stdout_split_frame') {
        const raw = JSON.stringify({ jsonrpc: '2.0', ...step.frame }) + '\\n';
        const mid = Math.max(1, Math.floor(raw.length / 2));
        process.stdout.write(raw.slice(0, mid));
        await new Promise((r) => setTimeout(r, 15));
        process.stdout.write(raw.slice(mid));
      } else if (step.action === 'stdout_raw') {
        process.stdout.write(step.text + '\\n');
      } else if (step.action === 'stderr_line') {
        process.stderr.write(step.text + '\\n');
      } else if (step.action === 'exit') {
        process.exit(step.exitCode ?? 0);
      }
    };
    const byTrigger = new Map();
    for (const s of steps) {
      const key = s.trigger || 'immediate';
      if (!byTrigger.has(key)) byTrigger.set(key, []);
      byTrigger.get(key).push(s);
    }
    const runQueue = async (trigger) => {
      const list = byTrigger.get(trigger) || [];
      for (const s of list) await emitStep(s);
    };
    let chain = Promise.resolve();
    const enqueue = (trigger) => {
      chain = chain.then(() => runQueue(trigger));
    };
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const trigger = msg.method
        ? 'on_request:' + msg.method
        : 'on_client_reply:' + String(msg.id);
      enqueue(trigger);
    });
    if (slowStartMs > 0) await new Promise((r) => setTimeout(r, slowStartMs));
    process.send?.({ type: 'replay_ready' });
    enqueue('immediate');
  `;

  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    env: {
      ...process.env,
      NP01_REPLAY_STEPS: JSON.stringify(steps),
      NP01_SLOW_START_MS: String(simulateSlowStartMs),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  const clientActions = steps.filter((s) => s.kind === 'client_step');
  const sendClient = (frame, extra = {}) => {
    const full = { jsonrpc: '2.0', ...frame };
    tap.onOutboundFrame({ connectionId: connId, generation, frame: full, ...extra });
    if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(`${JSON.stringify(full)}\n`);
    }
  };

  let stdoutBuf = '';
  let stderrBuf = '';
  let ordinal = 0;
  let scenarioStarted = false;
  let watchdogTimer = null;
  let endReason = 'closed';
  const scheduledTimers = [];

  const clearAllTimers = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    for (const t of scheduledTimers) clearTimeout(t);
  };

  const startScenarioTimeline = () => {
    if (scenarioStarted) return;
    scenarioStarted = true;
    const watchdogMs = options.watchdogMs ?? meta.replayTimeoutMs ?? 8_000;
    watchdogTimer = setTimeout(() => {
      endReason = 'watchdog_timeout';
      tap.onTimeout({
        connectionId: connId,
        generation,
        method: meta.expectedTimeoutMethod ?? 'session/prompt',
        rpcId: meta.expectedTimeoutRpcId ?? 3,
        timeoutMs: watchdogMs,
        scope: 'replay_watchdog',
        forced: true,
      });
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, watchdogMs);

    for (const step of clientActions.filter((s) => !s.trigger || s.trigger === 'scheduled')) {
      const t = setTimeout(() => {
        if (step.action === 'client_frame') {
          sendClient(step.frame, { turnId: step.turnId });
        } else if (step.action === 'force_timeout') {
          tap.onTimeout({
            connectionId: connId,
            generation,
            method: step.method ?? 'session/prompt',
            rpcId: step.rpcId ?? 3,
            timeoutMs: step.timeoutMs ?? 900_000,
            scope: 'rpc_request',
            forced: true,
          });
        } else if (step.action === 'close_stdin') {
          child.stdin?.end();
        }
      }, step.delayMs ?? 10);
      scheduledTimers.push(t);
    }
  };

  const donePromise = new Promise((resolve) => {
    const readyGuard = setTimeout(() => {
      // Fallback if IPC ready was missed
      startScenarioTimeline();
    }, Math.max(5_000, simulateSlowStartMs + 2_000));

    child.on('message', (msg) => {
      if (msg?.type === 'replay_ready') {
        clearTimeout(readyGuard);
        startScenarioTimeline();
      }
    });

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) {
          nl = stdoutBuf.indexOf('\n');
          continue;
        }
        ordinal++;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          tap.onMalformedLine({ connectionId: connId, generation, ingressOrdinal: ordinal, line, stream: 'stdout' });
          nl = stdoutBuf.indexOf('\n');
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          tap.onMalformedLine({ connectionId: connId, generation, ingressOrdinal: ordinal, line, stream: 'stdout' });
          nl = stdoutBuf.indexOf('\n');
          continue;
        }
        tap.onInboundFrame({ connectionId: connId, generation, ingressOrdinal: ordinal, frame: parsed });

        if (meta.emitFourLayerStubs) {
          emitSyntheticDownstreamLayers(tap, { connId, generation, ordinal, parsed });
        }

        if (parsed.method && parsed.id !== undefined) {
          const replyStep = clientActions.find(
            (s) => s.trigger === `on_server_request:${parsed.method}` && (s.matchId === undefined || s.matchId === parsed.id),
          );
          if (replyStep) {
            const rt = setTimeout(() => {
              sendClient(
                { id: parsed.id, ...(replyStep.result ? { result: replyStep.result } : { error: replyStep.error }) },
                { ingressOrdinal: ordinal },
              );
            }, replyStep.delayMs ?? 5);
            scheduledTimers.push(rt);
          }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      let nl = stderrBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line) tap.onStderrLine({ connectionId: connId, generation, line });
        nl = stderrBuf.indexOf('\n');
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(readyGuard);
      clearAllTimers();
      if (stderrBuf.trim()) tap.onStderrLine({ connectionId: connId, generation, line: stderrBuf.trim() });
      tap.onProcessExit({ connectionId: connId, generation, exitCode: code, signal, reason: 'child_closed' });
      resolve(endReason);
    });
  });

  const finalReason = await donePromise;
  recorder.recordCaptureEnd(
    { reason: finalReason, promptSent: clientActions.some((s) => s.frame?.method === 'session/prompt') },
    { connectionId: connId, generation },
  );
  await recorder.flush();

  const validation = validateCaptureRecords(recorder.records);
  const summary = buildFourLayerSummary(recorder.records);
  const verdict = evaluateVerdictCriteria(meta.verdictCriteria, recorder.records, summary);

  return {
    scenarioId: meta.scenarioId,
    endReason: finalReason,
    records: recorder.records,
    validation,
    summary,
    verdict,
  };
}

function emitSyntheticDownstreamLayers(tap, { connId, generation, ordinal, parsed }) {
  if (parsed.method === 'session/update') {
    const u = parsed.params?.update ?? {};
    const sessionId = parsed.params?.sessionId;
    const aliases = {
      sessionId,
      toolCallId: u.toolCallId,
      taskId: u.rawInput?.backgroundTaskId ?? u.taskId,
      childSessionId: u.childSessionId,
      turnId: 'turn-1',
      activityId: 'act-1',
      workId: u.toolCallId ? `work-${u.toolCallId}` : undefined,
    };
    tap.onNormalizedEvent({
      connectionId: connId,
      generation,
      ingressOrdinal: ordinal,
      event: {
        type: u.sessionUpdate === 'agent_message_chunk' ? 'message.assistant.delta' : `acp.${u.sessionUpdate ?? 'update'}`,
        turnId: 'turn-1',
        toolCallId: u.toolCallId,
        status: u.status,
      },
      aliases,
    });
    tap.onNativeCanonicalEvent({
      connectionId: connId,
      generation,
      ingressOrdinal: ordinal,
      event: {
        type: u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update' ? 'native.work.changed' : 'native.activity.changed',
        seq: ordinal,
        state: u.status ?? 'running',
      },
      aliases,
    });
    tap.onUiProjection({
      connectionId: connId,
      generation,
      ingressOrdinal: ordinal,
      projection: {
        status: 'attached',
        asOfSeq: ordinal,
        visibleBlockType: u.sessionUpdate,
      },
      aliases,
    });
  } else if (parsed.method === 'session/request_permission') {
    const sessionId = parsed.params?.sessionId;
    const tc = parsed.params?.toolCall ?? {};
    const aliases = {
      sessionId,
      toolCallId: tc.toolCallId,
      approvalId: parsed.id,
      childSessionId: parsed.params?.childSessionId,
      turnId: 'turn-1',
      activityId: 'act-1',
    };
    tap.onNormalizedEvent({
      connectionId: connId,
      generation,
      ingressOrdinal: ordinal,
      event: {
        type: 'approval.requested',
        turnId: 'turn-1',
        nativeRequestId: `acp_req_${parsed.id}`,
        kind: String(tc.toolCallId ?? '').startsWith('interaction_') ? 'user_question' : 'permission',
      },
      aliases,
    });
    tap.onNativeCanonicalEvent({
      connectionId: connId,
      generation,
      ingressOrdinal: ordinal,
      event: {
        type: 'native.request.changed',
        seq: ordinal,
        state: 'requires_action',
        receiptState: 'pending',
      },
      aliases,
    });
    tap.onUiProjection({
      connectionId: connId,
      generation,
      ingressOrdinal: ordinal,
      projection: {
        status: 'requires_action',
        asOfSeq: ordinal,
        pendingRequestCount: 1,
      },
      aliases,
    });
  }
}

export async function runFourLayerBaselineCorrelation(options = {}) {
  const strictAcpPath = path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'harnesses', 'acp', 'strict-acp-adapter.js');
  const agyDriverPath = path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'harnesses', 'agy', 'agy-driver.js');
  if (!fs.existsSync(strictAcpPath) || !fs.existsSync(agyDriverPath)) {
    throw new Error('Built daemon artifacts not found. Run `pnpm --filter @harnessmate/daemon build` first.');
  }

  const strictAcpUrl = pathToFileURL(strictAcpPath).href;
  const agyDriverUrl = pathToFileURL(agyDriverPath).href;
  const { AcpSessionHandle } = await import(/* @vite-ignore */ strictAcpUrl);
  const { AntigravityAcpFlavorPolicy } = await import(/* @vite-ignore */ agyDriverUrl);

  const recorder = new ProtocolObservatoryRecorder({
    captureId: options.captureId ?? 'baseline-four-layer-t02-t04-t06',
    scenario: options.scenario ?? 'T02_T04_T06_baseline_four_layer',
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    cliVersion: '1.5.16-synthetic-peer',
    protocol: null,
    accountCategory: 'synthetic',
    source: 'synthetic',
    producer: 'replay_harness',
    salt: options.salt ?? 'np01-baseline-four-layer-salt',
    provenance: {
      origin: 'real_baseline_AcpSessionHandle_with_synthetic_peer',
      migratedFrom: null,
      timingSynthetic: true,
      notes: 'Observatory v0.2: 4-layer correlation across raw stdio, real baseline adapter, canonical stub, and UI stub',
    },
  });

  const tap = createDaemonTapCallbacks(recorder);
  const connId = 'conn-1';
  const generation = 'gen-1';
  const parentSessionId = 'synthetic-parent-session';
  recorder.recordCaptureMeta(
    { profileSource: 'synthetic', mode: 'four_layer_baseline_correlation', requestedProtocol: 1 },
    { connectionId: connId, generation },
  );

  const mockPeerScript = `
    import readline from 'node:readline';
    const parentSession = ${JSON.stringify(parentSessionId)};
    const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
    const update = (u) => write({ method: 'session/update', params: { sessionId: parentSession, update: u } });
    const bg = (id, status, kind, isDaemon = false) => update({
      sessionUpdate: kind,
      toolCallId: id,
      title: isDaemon ? 'Run synthetic daemon server' : 'Run synthetic background command',
      kind: 'execute',
      status,
      rawInput: { isBackground: true, IsDaemon: isDaemon, backgroundTaskId: id },
    });
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', async (line) => {
      let req;
      try { req = JSON.parse(line); } catch { return; }
      if (req.method === 'initialize') {
        write({ id: req.id, result: { protocolVersion: 1, agentInfo: { name: 'synthetic-acp', version: '1.5.16-synthetic' }, agentCapabilities: {} } });
      } else if (req.method === 'session/new') {
        write({ id: req.id, result: { sessionId: parentSession } });
      } else if (req.method === 'session/prompt') {
        bg('bg-task-A', 'in_progress', 'tool_call', false);
        await pause(15);
        bg('bg-task-B', 'in_progress', 'tool_call', false);
        await pause(15);
        bg('daemon-D', 'in_progress', 'tool_call', true);
        await pause(15);
        write({ id: req.id, result: { stopReason: 'end_turn' } });
      } else if (req.id === 'perm-late-1' && req.result) {
        process.send?.({ type: 'permission_reply', outcome: req.result.outcome?.outcome ?? null });
      } else if (req.id !== undefined && req.method) {
        write({ id: req.id, result: {} });
      }
    });
    process.on('message', async () => {
      await pause(15);
      bg('bg-task-B', 'completed', 'tool_call_update', false);
      await pause(15);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wake output NP01_BG_B_DONE while A still runs' } });
      await pause(15);
      write({
        id: 'perm-late-1',
        method: 'session/request_permission',
        params: {
          sessionId: parentSession,
          toolCall: { toolCallId: 'tool-late-readonly', kind: 'read', title: 'Get-Location' },
          options: [{ kind: 'allow_once', optionId: 'allow_once', name: 'Allow once' }],
        },
      });
    });
  `;

  const child = spawn(process.execPath, ['--input-type=module', '-e', mockPeerScript], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  let lastIngressOrdinal = 0;
  const origWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...rest) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        tap.onOutboundFrame({
          connectionId: connId,
          generation,
          ingressOrdinal: parsed.method ? 0 : lastIngressOrdinal,
          frame: parsed,
        });
      } catch {
        // ignore
      }
    }
    return origWrite(chunk, ...rest);
  };

  let outBuf = '';
  child.stdout.on('data', (chunk) => {
    outBuf += chunk.toString('utf8');
    let nl = outBuf.indexOf('\n');
    while (nl !== -1) {
      const line = outBuf.slice(0, nl).replace(/\r$/, '');
      outBuf = outBuf.slice(nl + 1);
      if (line.trim()) {
        lastIngressOrdinal++;
        try {
          const parsed = JSON.parse(line);
          tap.onInboundFrame({ connectionId: connId, generation, ingressOrdinal: lastIngressOrdinal, frame: parsed });
        } catch {
          tap.onMalformedLine({ connectionId: connId, generation, ingressOrdinal: lastIngressOrdinal, line, stream: 'stdout' });
        }
      }
      nl = outBuf.indexOf('\n');
    }
  });

  const handle = new AcpSessionHandle(
    child,
    { cwd: process.cwd(), permissionMode: 'manual' },
    {
      flavorPolicy: new AntigravityAcpFlavorPolicy(),
      authenticateEagerly: false,
      sessionLoadReplayIdleMs: 0,
    },
  );

  let permReplyOutcome = null;
  child.on('message', (m) => {
    if (m?.type === 'permission_reply') permReplyOutcome = m.outcome;
  });

  let canonicalSeq = 0;
  let lateReleased = false;
  const unsub = handle.onEvent((event) => {
    const lease = handle.hasActiveBackgroundWork();
    const ord = lastIngressOrdinal;
    const aliases = {
      sessionId: parentSessionId,
      toolCallId: event.toolCallId ?? event.payload?.toolCallId,
      taskId: event.payload?.toolCallId,
      turnId: event.turnId,
    };
    tap.onNormalizedEvent({
      connectionId: connId,
      generation,
      ingressOrdinal: ord,
      event,
      aliases,
      backgroundLease: lease,
    });

    canonicalSeq++;
    const isBgSlot = event.turnId === 'turn_bg' || event.turnId === 'turn_unknown';
    tap.onNativeCanonicalEvent({
      connectionId: connId,
      generation,
      ingressOrdinal: ord,
      event: {
        type: event.type === 'turn.completed' ? 'native.runtime.changed' : 'native.activity.changed',
        seq: canonicalSeq,
        state: event.type === 'turn.completed' ? 'finished' : isBgSlot ? 'orphan_placeholder' : 'running',
        settlementDecision: event.type === 'turn.completed' ? 'baseline_premature_settle' : undefined,
      },
      aliases,
    });

    tap.onUiProjection({
      connectionId: connId,
      generation,
      ingressOrdinal: ord,
      projection: {
        status: event.type === 'turn.completed' ? 'idle_despite_bg' : isBgSlot ? 'ghost_turn_bg' : 'running',
        asOfSeq: canonicalSeq,
      },
      aliases,
    });

    if (event.type === 'turn.completed' && !lateReleased) {
      lateReleased = true;
      child.send('release-late-frames');
    }
  });

  try {
    await handle.initialize();
    await handle.sendTurn({ turnId: 'user-turn-1', text: 'Run synthetic T02+T04+T06' });
    const deadline = Date.now() + 4_000;
    while (permReplyOutcome === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    unsub();
    await handle.dispose();
  }

  recorder.recordCaptureEnd({ reason: 'four_layer_complete', promptSent: true }, { connectionId: connId, generation });
  await recorder.flush();

  const validation = validateCaptureRecords(recorder.records);
  const summary = buildFourLayerSummary(recorder.records);
  return {
    permReplyOutcome,
    records: recorder.records,
    validation,
    summary,
  };
}
