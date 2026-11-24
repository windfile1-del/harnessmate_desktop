import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AgyAdapter } from '../src/harnesses/agy/agy-driver.js';
import {
  listAgySubagentRecords,
  readAgySubagentDetail,
} from '../src/harnesses/agy/agy-child-work.js';
import { DEFAULT_AGY_APP_DATA_DIR_NAME } from '../src/harnesses/agy/agy-launch-context.js';
import {
  parseAgyBackgroundOrSubagentUpdate,
  parseAgyInteractionPermission,
  parseAgySessionInfoUpdate,
  parseAgyUpdateStepsToolCall,
  parseAgyUsageUpdate,
  supportsAgyActiveSteering,
  truncateAgyToolText,
} from '../src/harnesses/agy/agy-protocol.js';
import {
  detectSilentAgyTurnError,
  readAgyConversationMaxStepIdx,
} from '../src/harnesses/agy/agy-turn-outcome.js';
import type { NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

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

describe('AGY protocol event parsers & steering version gate', () => {
  it('checks steering version >= 1.5.0 and truncates oversized tool output', () => {
    expect(supportsAgyActiveSteering('1.5.14')).toBe(true);
    expect(supportsAgyActiveSteering('1.5.0')).toBe(true);
    expect(supportsAgyActiveSteering('1.4.9')).toBe(false);
    expect(supportsAgyActiveSteering(null)).toBe(false);

    const longText = 'x'.repeat(200);
    expect(truncateAgyToolText(longText, 50)).toContain('[truncated 150 chars by AGY protocol guard]');
  });

  it('parses usage_update, session_info_update, Run update_steps, interaction_*, and background/subagent blocks', () => {
    expect(
      parseAgyUsageUpdate({ sessionUpdate: 'usage_update', used: 24_000, size: 1_048_576 }, 't-1'),
    ).toEqual({
      type: 'usage.updated',
      turnId: 't-1',
      usage: { inputTokens: 0, outputTokens: 0, contextTokens: 24_000, modelContextWindow: 1_048_576 },
    });

    expect(parseAgySessionInfoUpdate({ sessionUpdate: 'session_info_update', title: 'Refactored Auth' })).toEqual({
      type: 'session.title_updated',
      title: 'Refactored Auth',
    });

    const planEv = parseAgyUpdateStepsToolCall(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-plan-1',
        title: 'Run update_steps',
        status: 'in_progress',
        rawInput: { steps: [{ title: 'Inspect files', status: 'done' }] },
      },
      't-1',
    );
    expect(planEv?.type).toBe('turn_block.ext');
    if (planEv?.type === 'turn_block.ext') {
      expect(planEv.blockType).toBe('ext:agy.plan');
      expect(planEv.fallbackSummary).toContain('[done] Inspect files');
    }

    const q = parseAgyInteractionPermission(
      {
        toolCall: {
          toolCallId: 'interaction_42',
          title: 'Choose deployment region',
          rawInput: { question: 'Where should we deploy?' },
        },
      },
      [
        { optionId: 'opt_us', name: 'US East', kind: 'allow_once' },
        { optionId: 'opt_eu', name: 'EU West', kind: 'allow_once' },
      ],
    );
    expect(q?.questionSpec.question).toBe('Where should we deploy?');
    expect(q?.questionSpec.options).toHaveLength(2);

    const bg = parseAgyBackgroundOrSubagentUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-sched-1',
        title: 'schedule',
        status: 'in_progress',
        rawInput: { DurationSeconds: 60, Prompt: 'Check build' },
      },
      't-1',
    );
    expect(bg?.keepsBackgroundAlive).toBe(true);
    expect(bg?.event.type).toBe('turn_block.ext');
    if (bg?.event.type === 'turn_block.ext') {
      expect(bg.event.blockType).toBe('ext:agy.background_task');
    }
  });
});

describe('AGY child-work read-only observer & silent ERROR_STEP_TYPE(17) detector', () => {
  it('reads subagent transcripts safely and rejects path traversal', () => {
    const tmp = makeTempDir('hm-agy-subagents-');
    const appDataPath = path.join(tmp, 'antigravity-cli');
    const subDir = path.join(appDataPath, 'brain', 'sess-1', '.system_generated', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'sub-1.json'),
      JSON.stringify({ id: 'sub-1', role: 'Codebase Researcher', typeName: 'research', status: 'completed', summary: 'Found 3 files' }),
      'utf8',
    );
    fs.writeFileSync(path.join(subDir, 'sub-1.jsonl'), '{"msg":"step 1"}\n{"msg":"done"}\n', 'utf8');

    const listed = listAgySubagentRecords(appDataPath, 'sess-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.role).toBe('Codebase Researcher');

    const detail = readAgySubagentDetail(appDataPath, 'sess-1', 'sub-1');
    expect(detail?.transcriptLines).toHaveLength(2);
    expect(readAgySubagentDetail(appDataPath, 'sess-1', '../escape')).toBeNull();
  });

  it('detects silent QUOTA_EXHAUSTED and INVALID_THINKING_SIGNATURE rows in conversations/<id>.db', () => {
    const tmp = makeTempDir('hm-agy-convdb-');
    const appDataPath = path.join(tmp, 'antigravity-cli');
    const convDir = path.join(appDataPath, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, 'conv-1.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, type INTEGER NOT NULL, payload TEXT)');
    db.prepare('INSERT INTO steps (idx, type, payload) VALUES (?, ?, ?)').run(1, 2, 'ok');
    db.close();

    const baseline = readAgyConversationMaxStepIdx(appDataPath, 'conv-1');
    expect(baseline).toBe(1);
    expect(detectSilentAgyTurnError(appDataPath, 'conv-1', baseline)).toBeNull();

    const db2 = new DatabaseSync(dbPath);
    db2
      .prepare('INSERT INTO steps (idx, type, payload) VALUES (?, ?, ?)')
      .run(2, 17, JSON.stringify({ reason: 'QUOTA_EXHAUSTED resets at 2026-11-25T12:00:00Z' }));
    db2.close();

    const quotaErr = detectSilentAgyTurnError(appDataPath, 'conv-1', baseline);
    expect(quotaErr?.failed).toBe(true);
    expect(quotaErr?.failureClass).toBe('usage_limit');
    expect(quotaErr?.resetAt).toBe(Date.parse('2026-11-25T12:00:00Z'));

    const db3 = new DatabaseSync(dbPath);
    db3
      .prepare('INSERT INTO steps (idx, type, payload) VALUES (?, ?, ?)')
      .run(3, 17, JSON.stringify({ error: 'INVALID_THINKING_SIGNATURE detected' }));
    db3.close();

    const sigErr = detectSilentAgyTurnError(appDataPath, 'conv-1', 2);
    expect(sigErr?.code).toBe('invalid_thinking_signature');
    expect(sigErr?.corruptSession).toBe(true);
  });
});

describe('AGY live mock ACP steering, interaction_* question & daemon mid-turn steering', () => {
  it('supports interaction_* user_question -> resolveQuestion, usage_update meter, and mid-turn steering without cancelling', async () => {
    const tmp = makeTempDir('hm-agy-e2e-lc-');
    const scriptPath = path.join(tmp, 'mock-agy-lc.mjs');
    const callsLog = path.join(tmp, 'rpc-log.jsonl');

    fs.writeFileSync(
      scriptPath,
      `
import fs from 'node:fs';
import readline from 'node:readline';

let firstPromptReqId = null;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  fs.appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(msg) + '\\n');

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: 1, agentInfo: { name: 'antigravity', version: '1.5.14' }, agentCapabilities: {} }
    }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: 'agy-lc-1', modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] } }
    }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    const text = msg.params?.prompt?.[0]?.text || '';
    if (text.includes('FIRST_TURN')) {
      firstPromptReqId = msg.id;
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'agy-lc-1', update: { sessionUpdate: 'usage_update', used: 12000, size: 1048576 } }
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'agy-lc-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-plan',
            title: 'Run update_steps',
            status: 'in_progress',
            rawInput: { steps: [{ title: 'Analyze', status: 'done' }] }
          }
        }
      }) + '\\n');
    } else if (text.includes('STEER_MSG')) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' }
      }) + '\\n');
      if (firstPromptReqId !== null) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: firstPromptReqId,
          result: { stopReason: 'end_turn' }
        }) + '\\n');
        firstPromptReqId = null;
      }
    } else if (text.includes('ASK_USER')) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 9001,
        method: 'session/request_permission',
        params: {
          sessionId: 'agy-lc-1',
          toolCall: { toolCallId: 'interaction_ask_1', title: 'Proceed with deploy?', rawInput: { question: 'Target env?' } },
          options: [{ optionId: 'staging', name: 'Staging' }, { optionId: 'prod', name: 'Production' }]
        }
      }) + '\\n');
      firstPromptReqId = msg.id;
    }
  } else if (msg.id === 9001 && msg.result) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: firstPromptReqId,
      result: { stopReason: 'end_turn' }
    }) + '\\n');
  } else if (msg.method === 'session/set_mode') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
`,
      'utf8',
    );

    const mockBin =
      process.platform === 'win32'
        ? (() => {
            const p = path.join(tmp, 'mock-agy.cmd');
            fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8');
            return p;
          })()
        : (() => {
            const p = path.join(tmp, 'mock-agy');
            fs.writeFileSync(p, `#!/bin/sh\nnode "${scriptPath}" "$@"\n`, 'utf8');
            fs.chmodSync(p, 0o755);
            return p;
          })();

    const daemon = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      binaryOverrides: { agy: mockBin },
    });
    activeDaemons.push(daemon);
    await daemon.start();

    const agyAdapter = daemon.registry.get('agy') as AgyAdapter;
    const ws = await daemon.sessionManager.addWorkspace(tmp, 'lc-ws');
    const sess = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'agy',
      permissionMode: 'manual',
    });

    // First turn stays running while waiting for steer
    const t1 = await daemon.sessionManager.sendTurn(sess.id, 'FIRST_TURN');
    expect(agyAdapter.capabilitiesV2.supportsActiveSteering).toBe(true);

    // Wait deterministically until mock ACP has processed FIRST_TURN and emitted usage.updated + ext:agy.plan
    const deadlineFirst = Date.now() + 8_000;
    while (Date.now() < deadlineFirst) {
      const evs = daemon.store.getEventsAfter(sess.id, 0, 100);
      if (evs.some((e) => e.type === 'usage.updated')) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // Steering turn succeeds while session is running (does not emit session/cancel)
    const steered = await daemon.sessionManager.sendTurn(sess.id, 'STEER_MSG');
    expect(steered.turnId).toBe(t1.turnId);

    // Wait for completion
    for (let i = 0; i < 160; i++) {
      if (daemon.sessionManager.getSession(sess.id)?.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(daemon.sessionManager.getSession(sess.id)?.status).toBe('idle');

    const rpcCalls = fs
      .readFileSync(callsLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method?: string });
    expect(rpcCalls.some((c) => c.method === 'session/cancel')).toBe(false);

    // Next turn triggers interaction_* question approval
    await daemon.sessionManager.sendTurn(sess.id, 'ASK_USER');
    let pendingAppr;
    for (let i = 0; i < 160; i++) {
      pendingAppr = daemon.sessionManager.listPendingApprovals(sess.id)[0];
      if (pendingAppr) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pendingAppr?.kind).toBe('user_question');
    expect(pendingAppr?.questionSpec?.options?.map((o) => o.id)).toEqual(['staging', 'prod']);

    await daemon.sessionManager.resolveRuntimeRequest(
      pendingAppr!.id,
      { questionAnswer: { selectedOptionIds: ['staging'] } },
      'desktop',
    );

    for (let i = 0; i < 160; i++) {
      if (daemon.sessionManager.getSession(sess.id)?.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(daemon.sessionManager.getSession(sess.id)?.status).toBe('idle');
  }, 30_000);
});
