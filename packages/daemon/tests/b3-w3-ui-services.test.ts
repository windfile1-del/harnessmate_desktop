import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = process.env.HARNESSMATE_TEST_TMP ?? path.join(root, '.tmp/w3/tests');
const daemons: DaemonInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
});

async function start() {
  fs.mkdirSync(tmp, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tmp, 'ui-services-'));
  const daemon = createDaemon({ dataDir, port: 0 });
  daemons.push(daemon);
  const address = await daemon.start();
  return { daemon, ...address };
}

it('loads the actual React resource and invokes view state across the public transport with stale generation rejection', async () => {
  const { daemon } = await start();
  const doc = await daemon.app.inject({ url: '/api/v1/plugins/hm.plugin.chat-default/ui-doc?path=ui/index.html' });
  expect(doc.statusCode, doc.body).toBe(200);
  expect(doc.json().html).toContain('id="root"');
  expect(doc.json().html).toContain('data-inlined-from=');
  const call = (runId: string, method: string, args: unknown[], contract = 'chat.view.v1') => daemon.app.inject({
    method: 'POST', url: '/api/v1/plugin-instances/hm.plugin.chat-default/services/call',
    payload: { runId, method, args, contract, instanceId: 'hm.plugin.chat-default' },
  });
  const run = doc.json().runId;
  expect((await call('expired', 'readViewState', [{ sessionId: 'old' }])).statusCode).toBe(409);
  expect((await call(run, 'constructor', [])).statusCode).toBe(400);
  expect((await call(run, 'spawn', [], 'harness.mcp-config.v1')).statusCode).toBe(400);
  const write = await call(run, 'writeViewState', [{ sessionId: 'old', patch: { text: '不自动发送', attachments: [{ id: 'a' }], scrollTop: 120 } }]);
  expect(write.statusCode, write.body).toBe(200);
  await call(run, 'editViewState', [{ sessionId: 'old', operation: { type: 'addTerminalContext', chip: { id: 'terminal' } } }]);
  const state = (await call(run, 'readViewState', [{ sessionId: 'old' }])).json().value.value.state;
  expect(state).toMatchObject({ text: '不自动发送', attachments: [{ id: 'a' }], terminalContexts: [{ id: 'terminal' }], scrollTop: 120 });
  expect(daemon.store.listSessions()).toHaveLength(0);
  const old = run;
  await daemon.pluginManager.togglePlugin('hm.plugin.chat-default', false);
  expect((await call(old, 'readViewState', [{ sessionId: 'old' }])).statusCode).toBe(409);
});

it('acknowledges before snapshot, batches service events, isolates instances and cancels on the shared websocket', async () => {
  const { daemon, port } = await start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${daemon.config.localToken}`);
  sockets.push(ws);
  const messages: any[] = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({ op: 'subscribe_service', subscriptionId: 'one', contract: 'chat.view.v1', instanceId: 'hm.plugin.chat-default' }));
  const until = async (fn: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!fn() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(fn()).toBe(true);
  };
  await until(() => messages.some(frame => frame.op === 'service_batch' && frame.reset));
  for (let seq = 0; seq < 100; seq++) daemon.pluginManager.host.publishServiceChannel('chat.view.v1', 'hm.plugin.chat-default', { seq, text: '中文代码工具' });
  daemon.pluginManager.host.publishServiceChannel('chat.view.v1', 'another-instance', { forbidden: true });
  await until(() => messages.filter(f => f.op === 'service_batch').flatMap(f => f.events).length === 100);
  const frames = messages.filter(f => f.op === 'service_batch' && f.events.length);
  expect(frames.length).toBeLessThan(5);
  expect(frames.flatMap(f => f.events).map(e => e.payload.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  ws.send(JSON.stringify({ op: 'unsubscribe_service', subscriptionId: 'one' }));
  ws.send(JSON.stringify({ op: 'ping', ts: 123 }));
  await until(() => messages.some(f => f.op === 'pong' && f.ts === 123));
  const before = messages.length;
  daemon.pluginManager.host.publishServiceChannel('chat.view.v1', 'hm.plugin.chat-default', { after: true });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(messages).toHaveLength(before);
});
