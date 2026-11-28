import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AcpAdapter } from '../src/harnesses/acp-adapter.js';
import { ClaudeStreamJsonAdapter } from '../src/harnesses/claude-adapter.js';
import { CodexAppServerAdapter } from '../src/harnesses/codex-adapter.js';
import { ResilientJsonLineParser } from '../src/harnesses/process.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const tempDirs: string[] = [];
const daemons: DaemonInstance[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (daemons.length > 0) {
    const d = daemons.pop()!;
    await d.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore windows locked file cleanup race
    }
  }
});

describe('ResilientJsonLineParser', () => {
  it('skips non-JSON preamble noise lines like opencodex warnings while parsing fragmented JSON', () => {
    const parsed: Record<string, unknown>[] = [];
    const noise: string[] = [];
    const parser = new ResilientJsonLineParser(
      (obj) => parsed.push(obj),
      (line) => noise.push(line),
    );

    parser.feed('opencodex: proxy autostart failed; launching Codex anyway.\r\n');
    parser.feed('{"jsonrpc":"2.0","id":1,');
    parser.feed('"result":{"ok":true}}\nnot-json-line\n{"type":"delta","text":"hi"}\n');

    expect(noise).toEqual([
      'opencodex: proxy autostart failed; launching Codex anyway.',
      'not-json-line',
    ]);
    expect(parsed).toEqual([
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
      { type: 'delta', text: 'hi' },
    ]);
  });
});

function writeMockScript(dir: string, name: string, source: string): string {
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(scriptPath, source, 'utf8');
  return scriptPath;
}

it('replays a resolution for legacy expired approvals on startup', async () => {
  const dataDir = makeTempDir('hm-expired-');
  const workspaceDir = makeTempDir('hm-expired-workspace-');
  const original = createDaemon({ dataDir, port: 0, hostOverride: '127.0.0.1' });
  let sessionId: string;
  try {
    await original.start();
    const workspace = await original.sessionManager.addWorkspace(workspaceDir);
    const session = await original.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual' });
    sessionId = session.id;
    const approval = {
      id: 'appr_legacy', sessionId, nativeRequestId: 'acy_legacy', toolName: 'Edit', toolKind: 'file_edit',
      input: null, summary: 'Review edit', diffPreview: null, riskLevel: 'medium', status: 'pending',
      resolvedBy: null, decision: null, comment: null, createdAt: Date.now(), resolvedAt: null,
    } as const;
    original.store.createApproval(approval);
    original.store.appendEvent(sessionId, 'approval.requested', { approval }, 'turn_legacy');
    original.store.updateSession(sessionId, { status: 'awaiting_approval' });
    original.store.expirePendingApprovals(sessionId);
  } finally {
    await original.stop();
  }
  const recovered = createDaemon({ dataDir, port: 0, hostOverride: '127.0.0.1' });
  daemons.push(recovered);
  expect(recovered.sessionManager.getSession(sessionId)?.status).toBe('idle');
  expect(recovered.sessionManager.listPendingApprovals(sessionId)).toHaveLength(0);
  const events = recovered.sessionManager.getSessionEvents(sessionId);
  expect(events.filter(({ type }) => type === 'approval.resolved')).toMatchObject([
    { payload: { approvalId: 'appr_legacy', status: 'expired' } },
  ]);
});

it('imports a desktop rollout with large metadata and reads every event page', async () => {
  const dataDir = makeTempDir('hm-desktop-history-');
  const wsDir = fs.mkdtempSync(path.join(dataDir, 'workspace-'));
  const codexHome = path.join(dataDir, 'codex-home');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '11', '22');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const nativeSessionId = '11111111-2222-4333-8444-555555555555';
  const transcript = [JSON.stringify({
    type: 'session_meta',
    payload: { id: nativeSessionId, originator: 'Codex Desktop', cwd: wsDir, base_instructions: 'x'.repeat(30_000) },
  })];
  for (let i = 0; i < 1400; i++) {
    transcript.push(JSON.stringify({ type: 'response_item', payload: {
      id: `u${i}`, type: 'message', role: 'user', content: [{ type: 'input_text', text: `question ${i}` }],
    } }));
    transcript.push(JSON.stringify({ type: 'response_item', payload: {
      id: `a${i}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${i}` }],
    } }));
  }
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-11-22T14-00-00-${nativeSessionId}.jsonl`),
    transcript.join('\n'), 'utf8');
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const daemon = createDaemon({ dataDir, port: 0, hostOverride: '127.0.0.1' });
  daemons.push(daemon);
  try {
    const { port } = await daemon.start();
    const base = `http://127.0.0.1:${port}/api/v1`;
    const discovered = await (await fetch(`${base}/harnesses/discovered-sessions`)).json();
    expect(discovered.sessions).toContainEqual(expect.objectContaining({
      nativeSessionId, source: 'codex_desktop', cwd: wsDir,
    }));
    const importRequest = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'codex_desktop', nativeSessionId }),
    };
    const imported = await fetch(`${base}/harnesses/import-session`, importRequest);
    expect(imported.status).toBe(200);
    const { session } = await imported.json();
    expect(session.lastSeq).toBe(4200);
    const again = await (await fetch(`${base}/harnesses/import-session`, importRequest)).json();
    expect(again.session.id).toBe(session.id);

    let seq = 0;
    const eventUrl = `${base}/sessions/${session.id}/events`;
    const events = [];
    while (seq < session.lastSeq) {
      const page = await (await fetch(`${eventUrl}?afterSeq=${seq}`)).json();
      expect(page.events[0]?.seq).toBe(seq + 1);
      events.push(...page.events);
      seq = page.events.at(-1).seq;
    }
    expect(events.at(-2)?.payload.text).toBe('answer 1399');
    const { markdown } = await (await fetch(`${base}/sessions/${session.id}/export`)).json();
    expect(markdown).toContain('answer 1399');
    const context = await daemon.sessionManager.getContextPreview(session.id, 'claude');
    expect(context.unsyncedTurnCount).toBe(1400);

    const corsBlocked = await fetch(eventUrl, { headers: { Origin: 'https://example.invalid' } });
    expect(corsBlocked.status).toBe(403);
    const devAllowed = await fetch(eventUrl, { headers: { Origin: 'http://localhost:5173' } });
    expect(devAllowed.status).toBe(200);
  } finally {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
  }
});

describe('Real stdio Mock CLI Adapters + Daemon + HM-Remote v1', () => {
  it('runs full Codex App-Server JSON-RPC flow with noisy preamble and cross-device atomic approval', async () => {
    const dataDir = makeTempDir('hm-codex-data-');
    const wsDir = makeTempDir('hm-codex-ws-');

    const mockCodexScript = writeMockScript(
      dataDir,
      'mock-codex.mjs',
      `
      import readline from 'node:readline';
      // Emit noisy opencodex preamble before any JSON-RPC traffic
      process.stdout.write('opencodex: proxy autostart failed; launching Codex anyway.\\n');
      const rl = readline.createInterface({ input: process.stdin });
      let pendingApprovalResolve = null;
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'mock-codex' } } }) + '\\n');
        } else if (msg.method === 'thread/start') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_mock_1' } } }) + '\\n');
        } else if (msg.method === 'turn/start') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'trn_1' } } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/reasoning/textDelta', params: { delta: 'Planning check...' } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { item: { id: 'cmd_1', type: 'commandExecution', command: 'npm test' } } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } }) + '\\n');
          pendingApprovalResolve = (decision) => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { itemId: 'cmd_1', delta: 'PASS 12/12\\n' } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'cmd_1', type: 'commandExecution', status: 'completed', aggregatedOutput: 'PASS 12/12' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'Decision was ' + decision } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'msg_1', type: 'agentMessage', text: 'Decision was ' + decision } } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'trn_1', status: 'completed' } } }) + '\\n');
          };
        } else if (msg.id === 9001 && msg.result) {
          pendingApprovalResolve?.(msg.result.decision);
        }
      });
      `,
    );

    const mockAdapter = new CodexAppServerAdapter(process.execPath, [mockCodexScript]);
    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [mockAdapter],
    });
    daemons.push(daemon);
    const { port } = await daemon.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Pair a mobile device via HM-Remote v1
    const pairCreated = await (await fetch(`${baseUrl}/api/v1/pair/create`, { method: 'POST' })).json();
    const pairingCode = pairCreated.activePairing.code as string;
    const exchanged = await (
      await fetch(`${baseUrl}/api/v1/pair/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode, deviceName: 'Honor Test Phone', platform: 'android' }),
      })
    ).json();
    const mobileToken = exchanged.token as string;
    expect(mobileToken).toMatch(/^hmd_/);

    // Create workspace & session
    const wsRes = await (
      await fetch(`${baseUrl}/api/v1/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: wsDir, name: 'TestRepo' }),
      })
    ).json();
    const sessRes = await (
      await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: wsRes.workspace.id,
          harnessId: 'codex',
          permissionMode: 'accept_edits',
        }),
      })
    ).json();
    const sessionId = sessRes.session.id as string;

    // Start turn
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Run tests please' }),
    });

    // Wait for pending approval to appear
    let approvalId = '';
    for (let i = 0; i < 40; i++) {
      const apprRes = await (await fetch(`${baseUrl}/api/v1/approvals?sessionId=${sessionId}`)).json();
      if (apprRes.approvals.length > 0) {
        approvalId = apprRes.approvals[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(approvalId).toBeTruthy();

    // Simulate concurrent approval race: Mobile approves while Desktop denies simultaneously
    const [mobileApprovalRes, desktopApprovalRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/approvals/${approvalId}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mobileToken}`,
        },
        body: JSON.stringify({ decision: 'allow_once', resolvedBy: 'mobile' }),
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/v1/approvals/${approvalId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'deny', resolvedBy: 'desktop' }),
      }).then((r) => r.json()),
    ]);

    // Both responses must agree on the single atomic winner
    expect(mobileApprovalRes.approval.decision).toBe(desktopApprovalRes.approval.decision);
    expect(mobileApprovalRes.approval.resolvedBy).toBe(desktopApprovalRes.approval.resolvedBy);

    // Wait for turn completion
    let events: Array<{ seq: number; type: string; payload: Record<string, unknown> }> = [];
    for (let i = 0; i < 40; i++) {
      const evRes = await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events`)).json();
      events = evRes.events;
      if (events.some((e) => e.type === 'turn.completed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(events.some((e) => e.type === 'diagnostic.log' && String(e.payload.message).includes('opencodex'))).toBe(true);
    expect(events.some((e) => e.type === 'tool.call.completed')).toBe(true);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);

    // Verify HM-Remote v1 WebSocket cursor replay (afterSeq)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${encodeURIComponent(mobileToken)}`);
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ op: 'subscribe', sessionId, afterSeq: 2 }));
      });
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        frames.push(frame);
        if (frame.op === 'replay_complete') {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });

    expect(frames[0]?.op).toBe('hello');
    const replayedEvents = frames.filter((f) => f.op === 'event');
    expect(replayedEvents.length).toBe(events.filter((e) => e.seq > 2).length);
  });

  it('runs ACP (AGY) and Claude stream-json mock adapters into identical canonical events', async () => {
    const dataDir = makeTempDir('hm-multi-data-');
    const wsDir = makeTempDir('hm-multi-ws-');

    const mockAcpScript = writeMockScript(
      dataDir,
      'mock-acp.mjs',
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      let promptReqId = null;
      let mode = 'default';
      const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (msg.method === 'session/new') {
          write({ id: msg.id, result: { sessionId: 'acp_sess_1', modes: {
            currentModeId: mode, availableModes: ['default', 'accept-edits', 'plan', 'auto'].map((id) => ({ id })),
          } } });
        } else if (msg.method === 'session/set_mode') {
          mode = msg.params.modeId;
          write({ id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          promptReqId = msg.id;
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from AGY ACP' } } } }) + '\\n');
          const kind = msg.params.prompt[0].text === 'shell' ? 'execute' : 'edit';
          write({ id: 77, method: 'session/request_permission', params: { toolCall: { title: 'Example operation', kind }, options: [{ optionId: 'opt_allow', kind: 'allow_once' }, { optionId: 'opt_deny', kind: 'reject_once' }] } });
        } else if (msg.id === 77 && msg.result) {
          write({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: {
            type: 'text', text: mode + ':' + msg.result.outcome.optionId,
          } } } });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } }) + '\\n');
        }
      });
      `,
    );

    const mockClaudeScript = writeMockScript(
      dataDir,
      'mock-claude.mjs',
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.type === 'user') {
          process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_sess_99' }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello from Claude Stream' } } }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'creq_1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo ok' } } }) + '\\n');
        } else if (msg.type === 'control_response') {
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hello from Claude Stream', usage: { input_tokens: 120, output_tokens: 45 }, total_cost_usd: 0.002 }) + '\\n');
        }
      });
      `,
    );

    // Override claude binary with a tiny wrapper cmd/script? For direct node spawn, instantiate ACP & Claude directly via adapters
    const agyAdapter = new AcpAdapter({
      id: 'agy',
      kind: 'agy',
      displayName: 'Mock AGY',
      description: 'Mock ACP',
      command: process.execPath,
      args: [mockAcpScript],
    });

    const agyHandle = await agyAdapter.createSession({ cwd: wsDir, permissionMode: 'manual' });
    let agyEvents: string[] = [];
    let answer = '';
    agyHandle.onEvent((ev) => {
      agyEvents.push(ev.type);
      if (ev.type === 'message.assistant.completed') answer = ev.text;
      if (ev.type === 'approval.requested') {
        void agyHandle.resolveApproval(ev.nativeRequestId, 'allow_once');
      }
    });
    try {
      // Batch 4 W2 moved permission policy evaluation into approval.policy.v1 / runtime.requests.v1;
      // raw AcpAdapter forwards session/set_mode and emits approval.requested without local driver auto-decisions.
      const scenarios = [
        ['manual', 'edit', true, 'default:opt_allow'],
        ['accept_edits', 'edit', true, 'accept-edits:opt_allow'],
        ['accept_edits', 'shell', true, 'accept-edits:opt_allow'],
        ['auto', 'shell', true, 'auto:opt_allow'],
        ['plan', 'edit', true, 'plan:opt_allow'],
        ['manual', 'edit', true, 'default:opt_allow'],
      ] as const;
      for (const [index, [permissionMode, text, manuallyReviewed, result]] of scenarios.entries()) {
        agyEvents = [];
        answer = '';
        await agyHandle.updateConfig?.({ permissionMode });
        await agyHandle.sendTurn({ turnId: `t_mock_${index}`, text, permissionMode });
        for (let i = 0; i < 30 && !agyEvents.includes('turn.completed'); i++) {
          await new Promise((r) => setTimeout(r, 40));
        }
        expect(agyEvents).toContain('message.assistant.delta');
        expect(agyEvents.includes('approval.requested')).toBe(manuallyReviewed);
        expect(agyEvents).toContain('turn.completed');
        expect(answer).toContain(result);
      }
    } finally {
      await agyHandle.dispose();
    }

    // Test ClaudeStreamJsonAdapter with a runnable wrapper script
    const claudeWrapper =
      process.platform === 'win32'
        ? writeMockScript(
            dataDir,
            'mock-claude.cmd',
            `@echo off\r\n"${process.execPath}" "${mockClaudeScript}" %*\r\n`,
          )
        : (() => {
            const p = writeMockScript(
              dataDir,
              'mock-claude.sh',
              `#!/bin/sh\nexec "${process.execPath}" "${mockClaudeScript}" "$@"\n`,
            );
            fs.chmodSync(p, 0o755);
            return p;
          })();

    const claudeAdapter = new ClaudeStreamJsonAdapter(claudeWrapper);
    const claudeHandle = await claudeAdapter.createSession({ cwd: wsDir, permissionMode: 'accept_edits' });
    const claudeEvents: string[] = [];
    claudeHandle.onEvent((ev) => {
      claudeEvents.push(ev.type);
      if (ev.type === 'approval.requested') {
        void claudeHandle.resolveApproval(ev.nativeRequestId, 'allow_once');
      }
    });
    await claudeHandle.sendTurn({ turnId: 't2', text: 'hi claude' });
    for (let i = 0; i < 40 && !claudeEvents.includes('turn.completed'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await claudeHandle.dispose();
    expect(claudeEvents).toContain('native_session_ready');
    expect(claudeEvents).toContain('message.assistant.delta');
    expect(claudeEvents).toContain('approval.requested');
    expect(claudeEvents).toContain('usage.updated');
    expect(claudeEvents).toContain('turn.completed');
  }, 15_000);

  it('verifies AGY ACP session/set_config_option model switching, plugin lifecycle, attachments, and cross-harness handoff', async () => {
    const dataDir = makeTempDir('hm-v2-data-');
    const wsDir = makeTempDir('hm-v2-ws-');
    fs.writeFileSync(path.join(wsDir, 'AGENTS.md'), '# Project Rules\nBe concise.', 'utf8');
    fs.writeFileSync(path.join(wsDir, 'hello.ts'), 'export const hi = 42;\n', 'utf8');

    const mockAgyModelScript = writeMockScript(
      dataDir,
      'mock-agy-model.mjs',
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      let currentModel = 'gemini-4-neon';
      const opts = [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ];
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, result: {
              sessionId: 'agy_m1',
              models: { currentModelId: 'gemini-4-neon-high', availableModels: [{ modelId: 'gemini-4-neon-high' }, { modelId: 'gpt-oss-120b-medium' }] },
              configOptions: [{ id: 'model', category: 'model', currentValue: currentModel, options: opts }]
            }
          }) + '\\n');
        } else if (msg.method === 'session/set_config_option') {
          currentModel = msg.params.value;
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, result: {
              configOptions: [{ id: 'model', category: 'model', currentValue: currentModel, options: opts }]
            }
          }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          const textBlock = (msg.params.prompt || []).find((b) => b.type === 'text')?.text || '';
          const hasImage = (msg.params.prompt || []).some((b) => b.type === 'image');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', method: 'session/update', params: {
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MODEL=' + currentModel + ';IMG=' + hasImage + ';PROMPT=' + textBlock.slice(0, 40) } }
            }
          }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
        }
      });
      `,
    );

    const mockAgy = new AcpAdapter({
      id: 'agy',
      kind: 'agy',
      displayName: 'Mock AGY',
      description: 'Mock ACP',
      command: process.execPath,
      args: [mockAgyModelScript],
    });

    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [mockAgy],
    });
    daemons.push(daemon);
    const { port } = await daemon.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Plugin Studio: install ext.git-pr-studio from catalog, verify /commit command appears
    const installRes = await (
      await fetch(`${baseUrl}/api/v1/plugins/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'catalog', catalogId: 'ext.git-pr-studio' }),
      })
    ).json();
    expect(installRes.slashCommands.some((c: { command: string }) => c.command === 'commit')).toBe(true);

    // 2. Create workspace & AGY session explicitly choosing gpt-oss-120b-medium (NOT default gemini-4-neon!)
    const wsRes = await (
      await fetch(`${baseUrl}/api/v1/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: wsDir, name: 'V2Repo' }),
      })
    ).json();
    const sessRes = await (
      await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: wsRes.workspace.id,
          harnessId: 'agy',
          model: 'gpt-oss-120b-medium',
          permissionMode: 'accept_edits',
        }),
      })
    ).json();
    const sessionId = sessRes.session.id as string;

    // 3. Upload a 1x1 PNG image attachment & verify workspace file search + rules discovery
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const attRes = await (
      await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'screen.png',
          kind: 'image',
          mimeType: 'image/png',
          dataBase64: tinyPngBase64,
        }),
      })
    ).json();
    expect(attRes.attachment.previewUrl).toContain('/api/v1/attachments/');
    const previewUrl = attRes.attachment.previewUrl as string;
    const preview = await fetch(`${baseUrl}${previewUrl}`);
    expect(preview.status).toBe(200);
    expect(Buffer.from(await preview.arrayBuffer()).toString('base64')).toBe(tinyPngBase64);

    const previewWithoutRemoteAuth = await daemon.app.inject({
      method: 'GET', url: previewUrl, remoteAddress: '192.0.2.10',
    });
    expect(previewWithoutRemoteAuth.statusCode).toBe(401);
    const previewFromOtherSite = await daemon.app.inject({
      method: 'GET', url: previewUrl, remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' },
    });
    expect(previewFromOtherSite.statusCode).toBe(403);

    const rulesRes = await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/rules`)).json();
    expect(rulesRes.instructions.some((i: { name: string }) => i.name === 'AGENTS.md')).toBe(true);

    const filesRes = await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/files?q=hello`)).json();
    expect(filesRes.files.some((f: { name: string }) => f.name === 'hello.ts')).toBe(true);

    // 4. Send /commit slash command with image attachment; verify actual model is gpt-oss-120b-medium & image passed!
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '/commit test msg', attachments: [attRes.attachment] }),
    });

    let events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for (let i = 0; i < 40; i++) {
      const evRes = await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events`)).json();
      events = evRes.events;
      if (events.some((e) => e.type === 'turn.completed')) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    const assistantText = events
      .filter((e) => e.type === 'message.assistant.delta')
      .map((e) => String(e.payload.text ?? ''))
      .join('');
    expect(assistantText).toContain('MODEL=gpt-oss-120b-medium');
    expect(assistantText).toContain('IMG=true');
    expect(assistantText).toContain('git status');

    const sessAfter = await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`)).json();
    expect(sessAfter.session.actualModel).toBe('gpt-oss-120b-medium');

    // 5. Cross-Harness Handoff + Markdown Export
    const handoffRes = await (
      await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetHarnessId: 'codex' }),
      })
    ).json();
    expect(handoffRes.session.harnessId).toBe('codex');
    expect(handoffRes.handoffPrompt).toContain('Cross-Harness Handoff');

    const exportRes = await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/export`)).json();
    expect(exportRes.markdown).toContain('MODEL=gpt-oss-120b-medium');
  }, 15_000);
});
