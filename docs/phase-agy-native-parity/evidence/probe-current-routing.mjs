import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Synthetic ACP server for source-audit reproduction. This never invokes agy.
const parentSession = 'synthetic-parent';
if (process.argv.includes('--mock-server')) {
  const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const update = (fields) => write({
    method: 'session/update', params: { sessionId: parentSession, update: fields },
  });
  const background = (toolCallId, status, sessionUpdate) => update({
    sessionUpdate, toolCallId, title: 'Run synthetic background command',
    kind: 'execute', status, rawInput: { isBackground: true, backgroundTaskId: toolCallId },
  });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      write({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (request.method === 'session/new') {
      write({ id: request.id, result: { sessionId: parentSession } });
    } else if (request.method === 'session/prompt') {
      background('synthetic-A', 'in_progress', 'tool_call');
      background('synthetic-B', 'in_progress', 'tool_call');
      write({ id: request.id, result: { stopReason: 'end_turn' } });
    } else if (request.id === 'synthetic-permission' && request.result) {
      process.send({ type: 'permission-response', outcome: request.result.outcome?.outcome });
    } else if (request.id !== undefined && request.method) {
      write({ id: request.id, result: {} });
    }
  });
  process.on('message', () => {
    background('synthetic-A', 'completed', 'tool_call_update');
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic late text' } });
    write({
      id: 'synthetic-permission',
      method: 'session/request_permission',
      params: {
        sessionId: parentSession,
        toolCall: { toolCallId: 'synthetic-C', kind: 'execute', title: 'Synthetic permission' },
        options: [{ kind: 'allow_once', optionId: 'once', name: 'Allow once' }],
      },
    });
  });
} else {
  const { AcpSessionHandle } = await import('../../../packages/daemon/dist/harnesses/acp/strict-acp-adapter.js');
  const { AntigravityAcpFlavorPolicy } = await import('../../../packages/daemon/dist/harnesses/agy/agy-driver.js');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--mock-server'], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const handle = new AcpSessionHandle(child, { cwd: process.cwd(), permissionMode: 'manual' }, {
    flavorPolicy: new AntigravityAcpFlavorPolicy(),
    authenticateEagerly: false,
    sessionLoadReplayIdleMs: 0,
  });
  const results = [];
  child.on('message', (message) => {
    if (message?.type === 'permission-response') {
      results.push({ event: 'permission.response', outcome: message.outcome });
    }
  });
  const deadline = setTimeout(() => child.kill(), 8_000);
  try {
    await handle.initialize();
    const events = handle.onEvent((event) => {
      if (event.type === 'turn.completed') {
        results.push({ event: event.type, turnId: event.turnId, backgroundLease: handle.hasActiveBackgroundWork() });
        child.send('release-late-frames');
      } else if (event.type === 'message.assistant.delta' || event.type === 'approval.requested') {
        results.push({ event: event.type, turnId: event.turnId, backgroundLease: handle.hasActiveBackgroundWork() });
      }
    });
    await handle.sendTurn({ turnId: 'synthetic-user-turn', text: 'Synthetic turn' });
    const waitUntil = Date.now() + 4_000;
    while (results.length < 3 && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const value of results) console.log(JSON.stringify({ kind: 'synthetic', ...value }));
    events();
    assert.deepEqual(results, [
      { event: 'turn.completed', turnId: 'synthetic-user-turn', backgroundLease: true },
      { event: 'message.assistant.delta', turnId: 'turn_bg', backgroundLease: false },
      { event: 'permission.response', outcome: 'cancelled' },
    ], 'Source-audit baseline changed or synthetic session did not complete');
  } finally {
    clearTimeout(deadline);
    await handle.dispose();
  }
}
