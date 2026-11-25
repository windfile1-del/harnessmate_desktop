import readline from 'node:readline';

/**
 * Deterministic ACP stdio JSON-RPC 2.0 peer for NP-17 independent acceptance tests.
 * Scenario controlled via `NP17_ACP_SCENARIO` env var (default: `reactive_t02_t04`).
 */
const scenario = process.env.NP17_ACP_SCENARIO || 'reactive_t02_t04';
const nativeSessionId = process.env.NP17_NATIVE_SESSION_ID || 'np17_nat_sess_1';
const negotiatedVersion = Number(process.env.NP17_PROTOCOL_VERSION || '1');

function send(obj) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
}

function sendUpdate(update) {
  send({
    method: 'session/update',
    params: {
      sessionId: nativeSessionId,
      update,
    },
  });
}

let activeModeId = 'default';
let pendingReq = null;
let promptTurnCount = 0;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Handle response to server->client session/request_permission
  if (msg.id !== undefined && !msg.method && pendingReq && String(msg.id) === String(pendingReq.id)) {
    const chosenOption =
      msg.result?.outcome?.optionId ??
      (msg.result?.answers ? 'question_answered' : 'unknown');
    const current = pendingReq;
    pendingReq = null;
    if (current.afterResolve) current.afterResolve(chosenOption, msg.result);
    return;
  }

  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: negotiatedVersion,
        agentInfo: { name: 'Antigravity ACP Server (NP17 Synthetic)', version: '1.5.17-np17' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, load: {}, resume: {}, close: {}, additionalDirectories: {} },
        },
        authMethods: [
          { id: 'oauth-personal', name: 'Google Personal OAuth' },
          { id: 'oauth-business', name: 'Google Workspace' },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/new' || msg.method === 'session/load' || msg.method === 'session/resume') {
    send({
      id: msg.id,
      result: {
        sessionId: nativeSessionId,
        modes: {
          currentModeId: activeModeId,
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
            { id: 'accept-edits', name: 'Accept Edits' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: 'gemini-3.8-flash',
            options: [
              { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
              { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator Neon' },
            ],
          },
          {
            id: 'thought_level',
            category: 'thought_level',
            type: 'select',
            currentValue: 'medium',
            options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
          },
        ],
      },
    });
    setTimeout(() => {
      sendUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'plan', description: 'Enter plan mode' },
          { name: 'compact', description: 'Compact conversation' },
          { name: 'usage', description: 'Show quota usage' },
        ],
      });
    }, 10);
    return;
  }

  if (msg.method === 'session/set_mode') {
    const modeId = msg.params?.modeId;
    if (modeId === 'plan' || modeId === 'default' || modeId === 'accept-edits') {
      activeModeId = modeId;
      sendUpdate({ sessionUpdate: 'current_mode_update', currentModeId: modeId });
      send({ id: msg.id, result: { currentModeId: modeId } });
    } else {
      send({ id: msg.id, error: { code: -32602, message: `Unsupported mode: ${String(modeId)}` } });
    }
    return;
  }

  if (msg.method === 'session/set_config_option') {
    send({ id: msg.id, result: { updated: true } });
    return;
  }

  if (msg.method === 'session/cancel') {
    send({ id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/prompt') {
    promptTurnCount += 1;
    const text = Array.isArray(msg.params?.prompt)
      ? msg.params.prompt.map((c) => (c?.type === 'text' ? c.text : '')).join('\n')
      : '';

    if (scenario === 'reactive_t02_t04' && promptTurnCount === 1) {
      sendUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_np17_finite_1',
        title: 'Run finite verification task',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { isBackground: true, IsDaemon: false, backgroundTaskId: 'bg_np17_finite' },
      });
      sendUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_np17_daemon_1',
        title: 'Start long-lived daemon watcher',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { isBackground: true, IsDaemon: true, backgroundTaskId: 'bg_np17_daemon' },
      });
      setTimeout(() => send({ id: msg.id, result: { stopReason: 'end_turn' } }), 25);
      setTimeout(() => {
        sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_np17_finite_1',
          status: 'completed',
          rawOutput: { exitCode: 0, stdout: 'NP17_FINITE_DONE' },
        });
        sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `NP17_REACTIVE_COMPLETE (${activeModeId})` },
        });
      }, 90);
      return;
    }

    if (scenario === 'requests_t06_t07') {
      if (text.includes('ask-question')) {
        const reqId = 'q_np17_str_1';
        pendingReq = {
          id: reqId,
          afterResolve: (chosen) => {
            sendUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `NP17_QUESTION_RESOLVED:${chosen}` },
            });
            send({ id: msg.id, result: { stopReason: 'end_turn' } });
          },
        };
        send({
          id: reqId,
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'interaction_np17_q1',
              title: 'Select rollout ring',
              rawInput: { question: 'Which rollout ring should NP-17 verify?' },
            },
            options: [
              { optionId: 'canary', name: 'Canary' },
              { optionId: 'rollback_only', name: 'Rollback Only' },
            ],
          },
        });
        return;
      }

      const reqId = 7101;
      pendingReq = {
        id: reqId,
        afterResolve: (chosen) => {
          sendUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `NP17_PERM_RESOLVED:${chosen}` },
          });
        },
      };
      // Early prompt end before out-of-turn permission
      setTimeout(() => send({ id: msg.id, result: { stopReason: 'end_turn' } }), 20);
      setTimeout(() => {
        send({
          id: reqId,
          method: 'session/request_permission',
          params: {
            sessionId: nativeSessionId,
            toolCall: {
              toolCallId: 'tc_np17_perm_shell',
              title: 'Run read-only status check',
              kind: 'execute',
              rawInput: { command: 'git status --short' },
            },
            options: [
              { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
            ],
          },
        });
      }, 60);
      return;
    }

    // Default clean prompt turn (also used for post-rollback legacy verification)
    sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `NP17_TURN_${promptTurnCount}_OK:${activeModeId}:${text.slice(0, 48)}` },
    });
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
