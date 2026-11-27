export function apply(ctx) {
  const sessions = new Set();
  ctx.harnesses.registerDriver({
    driverId: 'fixed-replay',
    displayName: 'Fixed replay · offline',
    description: '60 seconds, 25 mixed batches/second',
    capabilities: { streaming: true, interactiveApproval: false, permissionModes: ['manual', 'auto'], sessionResume: true, sessionFork: false, imageInput: true, subagents: false },
    probe: async () => ({ binaryPath: 'offline:fixed-replay', version: '1.0.0', health: 'ready', models: [{ id: 'replay', displayName: 'Fixed replay', isDefault: true }], defaultModelId: 'replay' }),
    probePassive: async () => ({ binaryPath: 'offline:fixed-replay', version: '1.0.0', health: 'ready', models: [{ id: 'replay', displayName: 'Fixed replay', isDefault: true }], defaultModelId: 'replay' }),
    createSession: async config => {
      let turnId, timer, index = 0, text = '', disposed = false;
      const listeners = new Set();
      const emit = event => { if (!disposed) for (const listener of listeners) listener(event); };
      const stop = () => { clearTimeout(timer); timer = undefined; };
      const session = {
        nativeSessionId: config.nativeSessionId || `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        pluginMcpAvailable: false,
        onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        sendTurn: async input => {
          stop(); turnId = input.turnId; index = 0; text = '';
          emit({ type: 'turn.started', turnId });
          emit({ type: 'model.confirmed', actualModel: 'replay' });
          const total = input.text.startsWith('short') ? 50 : 1500;
          const startedAt = Date.now();
          const tick = () => {
            const marker = `HMREPLAY_${index}_${Date.now()}`;
            const delta = `${marker} 中文流式输出 ${index % 25 === 0 ? '\n\n```ts\nconst value = "代码";\n```\n\n' : '· '}`;
            text += delta;
            emit({ type: 'message.assistant.delta', turnId, text: delta });
            if (index % 25 === 0) {
              const toolCallId = `replay-tool-${index}`;
              emit({ type: 'tool.call.started', turnId, toolCallId, toolName: 'read_file', toolKind: 'read', summary: 'README.md', input: { path: 'README.md' } });
              emit({ type: 'tool.call.delta', turnId, toolCallId, outputDelta: `工具中文输出 ${marker}` });
              emit({ type: 'tool.call.completed', turnId, toolCallId, toolName: 'read_file', status: 'success', output: `工具中文输出 ${marker}` });
              text = '';
            }
            if (++index >= total) {
              stop();
              emit({ type: 'message.assistant.completed', turnId, text });
              emit({ type: 'turn.completed', turnId, stopReason: 'end_turn' });
              turnId = undefined;
            } else timer = setTimeout(tick, Math.max(0, startedAt + (index + 1) * 40 - Date.now()));
          };
          timer = setTimeout(tick, 40);
          return { driverUsed: 'native_warm' };
        },
        interrupt: async () => { stop(); if (turnId) emit({ type: 'turn.cancelled', turnId }); turnId = undefined; },
        resolveApproval: async () => {},
        dispose: async () => { stop(); disposed = true; listeners.clear(); sessions.delete(session); },
      };
      sessions.add(session);
      return session;
    },
  });
  ctx.effect(() => () => { for (const session of sessions) session.dispose(); });
}
