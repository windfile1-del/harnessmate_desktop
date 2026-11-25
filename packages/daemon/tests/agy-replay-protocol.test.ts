import fs from 'node:fs';
import { mintAgyDispatchProvenance } from '../src/harnesses/agy/native/wiring/provenance.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AgyAdapter } from '../src/harnesses/agy/agy-driver.js';
import { DEFAULT_AGY_APP_DATA_DIR_NAME } from '../src/harnesses/agy/agy-launch-context.js';
import { createDaemon } from '../src/server/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'agy-1.5.14');

const dispatchProvenance = mintAgyDispatchProvenance('human_direct', 'desktop', 'AGY replay fixture');

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const daemon = activeDaemons.pop();
    await daemon?.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

function createFixtureReplayBinary(
  tmp: string,
  fixtureFileName: string,
): { binaryPath: string; rpcLogPath: string } {
  const fixturePath = path.join(FIXTURES_DIR, fixtureFileName);
  const rpcLogPath = path.join(tmp, 'replay-rpc.jsonl');
  const scriptPath = path.join(tmp, 'replay-agy.mjs');

  fs.writeFileSync(
    scriptPath,
    `
import fs from 'node:fs';
import readline from 'node:readline';

const fixtureLines = fs
  .readFileSync(${JSON.stringify(fixturePath)}, 'utf8')
  .trim()
  .split(/\\r?\\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function byStage(stage) {
  return fixtureLines.find((entry) => entry.stage === stage)?.frame ?? null;
}

function sendFrame(frame, overrideId) {
  const copy = JSON.parse(JSON.stringify(frame));
  if (overrideId !== undefined) copy.id = overrideId;
  process.stdout.write(JSON.stringify(copy) + '\\n');
}

let firstPromptId = null;
let askPromptId = null;
let cancelPromptId = null;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  fs.appendFileSync(${JSON.stringify(rpcLogPath)}, JSON.stringify({ id: msg.id ?? null, method: msg.method ?? null, params: msg.params ?? null }) + '\\n');

  if (msg.method === 'initialize') {
    sendFrame(byStage('initialize'), msg.id);
    return;
  }

  if (msg.method === 'session/new') {
    const sessFrame = byStage('session/new');
    sendFrame(sessFrame, msg.id);
    if (!sessFrame?.error) {
      const cmdNotify = byStage('session/new_notify_commands');
      const usageNotify = byStage('session/new_notify_usage');
      const titleNotify = byStage('session/new_notify_title');
      if (cmdNotify) sendFrame(cmdNotify);
      if (usageNotify) sendFrame(usageNotify);
      if (titleNotify) sendFrame(titleNotify);
    }
    return;
  }

  if (msg.method === 'session/set_mode') {
    sendFrame({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    const upd = byStage('set_model_gemini31');
    if (upd) {
      sendFrame(upd);
      sendFrame({ jsonrpc: '2.0', id: msg.id, result: { configOptions: upd.params.update.configOptions } });
    } else {
      sendFrame({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
    return;
  }

  if (msg.method === 'session/cancel') {
    if (cancelPromptId !== null) {
      sendFrame({ jsonrpc: '2.0', id: cancelPromptId, result: { stopReason: 'cancelled' } });
      cancelPromptId = null;
    }
    if (msg.id !== undefined) {
      sendFrame({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
    return;
  }

  if (msg.method === 'session/prompt') {
    const text = msg.params?.prompt?.[0]?.text ?? '';
    if (text.includes('TURN_1')) {
      firstPromptId = msg.id;
      for (const stage of ['turn_1_title', 'turn_1_steps', 'turn_1_subagent', 'turn_1_bg', 'turn_1_permission_security']) {
        const frame = byStage(stage);
        if (frame) sendFrame(frame);
      }
      return;
    }
    if (text.includes('STEER_MSG')) {
      const steerChunk = byStage('turn_1_steer_chunk');
      if (steerChunk) sendFrame(steerChunk);
      sendFrame({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      if (firstPromptId !== null) {
        sendFrame({ jsonrpc: '2.0', id: firstPromptId, result: { stopReason: 'end_turn' } });
        firstPromptId = null;
      }
      return;
    }
    if (text.includes('ASK_USER')) {
      askPromptId = msg.id;
      const askFrame = byStage('turn_ask_question');
      if (askFrame) sendFrame(askFrame);
      return;
    }
    if (text.includes('CANCEL_ME')) {
      cancelPromptId = msg.id;
      const chunk = byStage('turn_cancel_chunk');
      if (chunk) sendFrame(chunk);
      return;
    }
    if (text.includes('RECOVERY_TURN')) {
      const chunk = byStage('turn_recovery_chunk');
      if (chunk) sendFrame(chunk);
      sendFrame({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (text.includes('QUOTA_TURN')) {
      const errFrame = byStage('turn_quota_error');
      if (errFrame) sendFrame(errFrame, msg.id);
      return;
    }
    sendFrame({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (msg.id === 8102 && msg.result) {
    if (askPromptId !== null) {
      sendFrame({ jsonrpc: '2.0', id: askPromptId, result: { stopReason: 'end_turn' } });
      askPromptId = null;
    }
    return;
  }
});
`,
    'utf8',
  );

  const binaryPath =
    process.platform === 'win32'
      ? (() => {
          const p = path.join(tmp, 'replay-agy.cmd');
          fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8');
          return p;
        })()
      : (() => {
          const p = path.join(tmp, 'replay-agy');
          fs.writeFileSync(p, `#!/bin/sh\nnode "${scriptPath}" "$@"\n`, 'utf8');
          fs.chmodSync(p, 0o755);
          return p;
        })();

  return { binaryPath, rpcLogPath };
}

async function waitFor<T>(
  predicate: () => T | null | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val !== null && val !== undefined && val !== false) return val;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for replay condition`);
}

describe('Phase AGY-6: AGY 1.5.14 Offline Protocol Replay Suite', () => {
  it('replays all 7 sanitized agy 1.5.14 ACP lifecycle scenarios deterministically', async () => {
    const tmp = makeTempDir('hm-agy-replay-full-');
    const { binaryPath, rpcLogPath } = createFixtureReplayBinary(tmp, 'session-full.ndjson');

    const daemon = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      binaryOverrides: { agy: binaryPath },
    });
    activeDaemons.push(daemon);
    await daemon.start();

    const agyAdapter = daemon.registry.get('agy') as AgyAdapter;
    const ws = await daemon.sessionManager.addWorkspace(tmp, 'replay-ws');
    const sess = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'agy',
      permissionMode: 'manual',
    });

    // Scenario 1 + 2: Start Turn 1 (include '·' so initial title remains eligible for ACP session_info_update), confirm metadata, available commands, config_option_update
    const t1 = await daemon.sessionManager.sendTurn(sess.id, 'TURN_1 · Init', undefined, { dispatchProvenance });

    // Verify usage_update, session_info_update, Run update_steps, subagent, bg task, & security warning approval
    await waitFor(() => {
      const evs = daemon.store.getEventsAfter(sess.id, 0, 200);
      return evs.some((e) => e.type === 'usage.updated') &&
        daemon.sessionManager.listPendingApprovals(sess.id).some((a) => a.kind !== 'user_question');
    });

    const secApproval = daemon.sessionManager
      .listPendingApprovals(sess.id)
      .find((a) => a.kind !== 'user_question')!;
    expect(secApproval.summary).toContain('Script touches workspace root files');

    await daemon.sessionManager.resolveRuntimeRequest(
      secApproval.id,
      { decision: 'approve_once' },
      'desktop',
    );

    // Scenario 5: Mid-turn Steering while running (no session/cancel)
    const steered = await daemon.sessionManager.sendTurn(sess.id, 'STEER_MSG', undefined, { dispatchProvenance });
    expect(steered.turnId).toBe(t1.turnId);
    await waitFor(() => daemon.sessionManager.getSession(sess.id)?.status === 'idle');

    // Scenario 2: Switch model via updateSession -> config_option_update refreshes thought_level cache
    await daemon.sessionManager.updateSession(sess.id, { model: 'gemini-3.1-pro-preview' });
    await waitFor(() => agyAdapter.getObservedEffortsForModel('gemini-3.1-pro-preview').length === 3);
    expect(agyAdapter.getObservedEffortsForModel('gemini-3.1-pro-preview')).toEqual(['low', 'high', 'xhigh']);

    // Scenario 3: interaction_* user_question flow
    await daemon.sessionManager.sendTurn(sess.id, 'ASK_USER', undefined, { dispatchProvenance });
    const qApproval = await waitFor(
      () => daemon.sessionManager.listPendingApprovals(sess.id).find((a) => a.kind === 'user_question'),
    );
    expect(qApproval.questionSpec?.options?.map((o) => o.id)).toEqual(['staging', 'production']);
    await daemon.sessionManager.resolveRuntimeRequest(
      qApproval.id,
      { questionAnswer: { selectedOptionIds: ['staging'] } },
      'desktop',
    );
    await waitFor(() => daemon.sessionManager.getSession(sess.id)?.status === 'idle');

    // Scenario 6: session/cancel interrupt & subsequent RECOVERY_TURN
    await daemon.sessionManager.sendTurn(sess.id, 'CANCEL_ME', undefined, { dispatchProvenance });
    await waitFor(() => daemon.sessionManager.getSession(sess.id)?.status === 'running');
    await daemon.sessionManager.interruptSession(sess.id);
    await waitFor(() => daemon.sessionManager.getSession(sess.id)?.status === 'idle');

    await daemon.sessionManager.sendTurn(sess.id, 'RECOVERY_TURN', undefined, { dispatchProvenance });
    await waitFor(() => daemon.sessionManager.getSession(sess.id)?.status === 'idle');

    // Scenario 7: QUOTA_EXHAUSTED structured failure
    await daemon.sessionManager.sendTurn(sess.id, 'QUOTA_TURN', undefined, { dispatchProvenance });
    await waitFor(() =>
      daemon.store.getEventsAfter(sess.id, 0, 500).some((e) => e.type === 'turn.failed'),
    );

    const events = daemon.store.getEventsAfter(sess.id, 0, 500);
    const turnItems = daemon.store.listTurnItems(sess.id, { limit: 100 });
    expect(events.some((e) => e.type === 'session.title_updated' && e.payload.title === 'AGY 1.5.14 Replay Verification')).toBe(true);
    expect(turnItems.some((item) => item.blockType === 'ext:agy.plan')).toBe(true);
    expect(turnItems.some((item) => item.blockType === 'ext:agy.subagent_batch')).toBe(true);
    expect(turnItems.some((item) => item.blockType === 'ext:agy.background_task')).toBe(true);
    expect(events.some((e) => e.type === 'turn.failed' && String(e.payload.message ?? '').includes('QUOTA_EXHAUSTED'))).toBe(true);
    expect(agyAdapter.getAdvertisedCommands().map((c) => c.name)).toEqual(['plan', 'goal', 'review']);

    const rpcMethods = fs
      .readFileSync(rpcLogPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l) as { method?: string | null });
    expect(rpcMethods.filter((m) => m.method === 'session/cancel').length).toBe(1);
  }, 45_000);

  it('replays auth-required.ndjson (-32000 Authentication required) and fails closed', async () => {
    const tmp = makeTempDir('hm-agy-replay-auth-');
    const profilesRoot = path.join(tmp, 'profiles');
    const { binaryPath } = createFixtureReplayBinary(tmp, 'auth-required.ndjson');

    const adapter = new AgyAdapter({
      profile: {
        instanceId: 'agy.unauth',
        displayName: 'AGY Unauthenticated',
        isolationMode: 'profile_isolated',
        authMethod: 'oauth-personal',
        appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
        defaults: {
          linkGlobalSkills: false,
          syncGlobalRules: false,
          additionalDirectories: [],
        },
        enabled: true,
      },
      profilesRootDir: profilesRoot,
      binaryOverride: binaryPath,
      applyWindowsAcl: false,
    });

    await expect(
      adapter.createSession({
        cwd: tmp,
        permissionMode: 'manual',
      }),
    ).rejects.toThrow(/Authentication required|-32000/i);
  }, 20_000);
});
