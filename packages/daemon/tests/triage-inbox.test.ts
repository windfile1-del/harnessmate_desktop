import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { TRIAGE_INBOX_PLUGIN_ID, WsServerFrameSchema, type SessionTriageState } from '@harnessmate/protocol';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { TriageInboxService } from '../src/core/triage-inbox-service.js';
import type { HarnessAdapter, NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { GLOBAL_WORKSPACE_SCOPE } from '../src/plugin-host/permissions/permissions.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const pluginId = TRIAGE_INBOX_PLUGIN_ID;
const scope = GLOBAL_WORKSPACE_SCOPE;
const endpoint = '/api/v1/triage';
const dirs = new Set<string>();
const daemons = new Set<DaemonInstance>();
const sockets = new Set<WebSocket>();

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-triage-'));
  dirs.add(dir);
  return dir;
}

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  for (const daemon of daemons) await daemon.stop();
  daemons.clear();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  dirs.clear();
});

async function start(dataDir = tempDir(), customAdapters?: HarnessAdapter[]) {
  const daemon = createDaemon({ dataDir, port: 0, hostOverride: '127.0.0.1', customAdapters });
  daemons.add(daemon);
  const { port } = await daemon.start();
  return { daemon, port, dataDir };
}

async function createSession(daemon: DaemonInstance, root: string, harnessId = 'agy') {
  const workspace = await daemon.sessionManager.addWorkspace(root);
  return daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId, permissionMode: 'manual' });
}

async function state(daemon: DaemonInstance, id: string): Promise<SessionTriageState> {
  const response = await daemon.app.inject({ url: `${endpoint}/state` });
  expect(response.statusCode).toBe(200);
  return response.json<{ sessions: SessionTriageState[] }>().sessions.find(({ sessionId }) => sessionId === id)!;
}

function schema(daemon: DaemonInstance) {
  const db = new DatabaseSync(daemon.paths.dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
  } finally {
    db.close();
  }
}

it('gates the REST endpoints and persists triage only in plugin KV across reload and restart', async () => {
  const { daemon, dataDir } = await start();
  const session = await createSession(daemon, dataDir);
  const url = `${endpoint}/sessions/${session.id}`;
  const before = schema(daemon);
  const plugin = daemon.pluginManager.listInstalled().find(({ id }) => id === pluginId);
  expect(plugin).toMatchObject({ builtin: true, enabled: false, permissions: ['session:read', 'storage:plugin'] });
  expect((await daemon.app.inject({ url: `${endpoint}/state` })).statusCode).toBe(409);
  await daemon.pluginManager.togglePlugin(pluginId, true);

  for (const payload of [{}, { pinned: 'true' }, { lastViewedTurnSeq: 5 }, { snoozedUntilMs: -1 }]) {
    expect((await daemon.app.inject({ method: 'PATCH', url, payload })).statusCode).toBe(400);
  }
  expect((await daemon.app.inject({ method: 'PATCH', url: `${endpoint}/sessions/missing`, payload: { pinned: true } })).statusCode).toBe(404);
  const snoozedUntilMs = Date.now() + 7_200_000;
  expect((await daemon.app.inject({ method: 'PATCH', url, payload: { pinned: true, snoozedUntilMs } })).statusCode).toBe(200);
  expect((await state(daemon, session.id)).meta).toMatchObject({ pinned: true, snoozedUntilMs, settled: false });
  expect((await daemon.app.inject({ method: 'PATCH', url, payload: { settled: true, forceUnread: true } })).statusCode).toBe(200);
  expect((await state(daemon, session.id)).meta).toMatchObject({
    pinned: true, snoozedUntilMs: null, settled: true, forceUnread: true,
  });
  const firstTurn = daemon.store.appendEvent(session.id, 'turn.completed', {}, 'completed-1');
  const secondTurn = daemon.store.appendEvent(session.id, 'turn.completed', {}, 'completed-2');
  daemon.store.appendEvent(session.id, 'turn.completed', { maintenance: true }, 'maintenance');
  const viewed = await daemon.app.inject({ method: 'POST', url: `${url}/viewed`, payload: { throughTurnSeq: firstTurn.seq } });
  expect(viewed.json().session).toMatchObject({
    latestTurnSeq: secondTurn.seq, meta: { forceUnread: false, lastViewedTurnSeq: firstTurn.seq },
  });
  expect((await daemon.app.inject({ method: 'POST', url: `${url}/viewed` })).json().session.meta.lastViewedTurnSeq).toBe(secondTurn.seq);
  const saved = (await state(daemon, session.id)).meta;
  expect(daemon.store.getPluginStorageValue(scope, pluginId, session.id)).toEqual(saved);
  expect(schema(daemon)).toEqual(before);
  await daemon.pluginManager.togglePlugin(pluginId, false);
  expect((await daemon.app.inject({ method: 'PATCH', url, payload: { pinned: false } })).statusCode).toBe(409);
  expect((await daemon.app.inject({ method: 'POST', url: `${url}/viewed` })).statusCode).toBe(409);
  expect((await daemon.app.inject({ method: 'POST', url: `${endpoint}/check-snoozes` })).statusCode).toBe(409);
  await daemon.pluginManager.togglePlugin(pluginId, true);
  await daemon.stop();
  daemons.delete(daemon);
  const reopened = (await start(dataDir)).daemon;
  expect((await state(reopened, session.id)).meta).toEqual(saved);
  expect((await reopened.app.inject({ method: 'PATCH', url, payload: { settled: false, pinned: false } })).statusCode).toBe(200);
  expect((await state(reopened, session.id)).meta).toMatchObject({ settled: false, pinned: false });
});

it('checks expired snoozes from a resumed clock, publishes a single reminder and collects deleted-session metadata', async () => {
  const { daemon, dataDir, port } = await start();
  const session = await createSession(daemon, dataDir);
  const url = `${endpoint}/sessions/${session.id}`;
  daemon.store.setPluginStorageValue(scope, pluginId, 'startup-orphan', {});
  await daemon.pluginManager.togglePlugin(pluginId, true);
  expect(daemon.store.listPluginStorageKeys(scope, pluginId)).toEqual([]);
  const service = daemon.pluginManager.host.get<TriageInboxService>('triage-inbox')!;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
  sockets.add(socket);
  await once(socket, 'open');
  const seen: unknown[] = [];
  socket.on('message', (bytes) => {
    const frame = WsServerFrameSchema.parse(JSON.parse(String(bytes)));
    if (frame.op === 'triage_updated' && frame.event) seen.push(frame.event);
  });
  const published: unknown[] = [];
  const dispose = daemon.pluginManager.host.events.on('triage.snooze_expired', (event) => { published.push(event); });
  const until = Date.now() + 30 * 60_000;
  try {
    await daemon.app.inject({ method: 'PATCH', url, payload: { snoozedUntilMs: until, pinned: true } });
    expect(service.checkExpiredSnoozes(until - 1)).toEqual([]);
    const expired = service.checkExpiredSnoozes(until);
    expect(expired).toEqual([{ type: 'triage.snooze_expired', sessionId: session.id, snoozedUntilMs: until, createdAt: until }]);
    expect(service.checkExpiredSnoozes(until + 1)).toEqual([]);
    await expect.poll(() => seen, { timeout: 1000 }).toEqual(expired);
    expect(published).toMatchObject([{ type: 'triage.snooze_expired', sessionId: session.id, data: { snoozedUntilMs: until } }]);
    const resumed = (await daemon.app.inject({ method: 'POST', url: `${endpoint}/check-snoozes` })).json();
    expect(resumed).toMatchObject({ expired: [], sessions: [{ meta: { snoozedUntilMs: null, pinned: true, forceUnread: true } }] });
    expect(await daemon.sessionManager.deleteSession(session.id)).toBe(true);
    const response = await daemon.app.inject({ url: `${endpoint}/state` });
    expect(response.json().sessions).toEqual([]);
    expect(daemon.store.listPluginStorageKeys(scope, pluginId)).toEqual([]);
  } finally {
    dispose();
  }
});

function approvalHarness() {
  let sendEvent: ((event: NormalizedAdapterEvent) => void) | undefined;
  const capabilities = {
    streaming: true, interactiveApproval: true, reasoningEfforts: ['medium'], permissionModes: ['manual'],
    sessionResume: false, sessionFork: false, imageInput: false, subagents: false,
  } as const;
  const adapter: HarnessAdapter = {
    id: 'mock-triage', kind: 'codex', displayName: 'Triage test harness', description: 'Test fixture',
    protocolLabel: 'mock', capabilities: { ...capabilities, reasoningEfforts: ['medium'], permissionModes: ['manual'] },
    async probe() {
      return {
        id: this.id, kind: this.kind, displayName: this.displayName, description: this.description,
        protocolLabel: this.protocolLabel, capabilities: this.capabilities, health: 'ready',
        models: [], defaultModelId: null, binaryPath: null, version: '1.0.0',
      };
    },
    async createSession() {
      return {
        nativeSessionId: null,
        onEvent(listener) { sendEvent = listener; return () => { sendEvent = undefined; }; },
        async sendTurn({ turnId }) {
          sendEvent?.({ type: 'turn.started', turnId });
          sendEvent?.({
            type: 'approval.requested', turnId, nativeRequestId: 'request-1', toolName: 'Edit',
            toolKind: 'file_edit', summary: 'Approve test edit', riskLevel: 'low', input: {},
          });
        },
        async resolveApproval() {},
        async interrupt() {},
        async dispose() {},
      };
    },
  };
  return {
    adapter,
    emit: (event: NormalizedAdapterEvent) => sendEvent?.(event),
    complete: (turnId: string) => sendEvent?.({ type: 'turn.completed', turnId }),
  };
}

it('projects background approval and turn completion on the desktop socket without a session subscription', async () => {
  const mock = approvalHarness();
  const { daemon, port, dataDir } = await start(tempDir(), [mock.adapter]);
  const session = await createSession(daemon, dataDir, mock.adapter.id);
  await daemon.pluginManager.togglePlugin(pluginId, true);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
  sockets.add(socket);
  await once(socket, 'open');
  const updates: SessionTriageState[] = [];
  socket.on('message', (bytes) => {
    const frame = WsServerFrameSchema.parse(JSON.parse(String(bytes)));
    if (frame.op === 'triage_updated') updates.push(frame.session);
  });
  const turn = await daemon.app.inject({ method: 'POST', url: `/api/v1/sessions/${session.id}/turns`,
    payload: { text: 'Mock approval and completion' } });
  expect(turn.statusCode).toBe(202);
  await expect.poll(() => updates.at(-1), { timeout: 1000 }).toMatchObject({
    sessionId: session.id, status: 'awaiting_approval', pendingApprovalCount: 1, latestTurnSeq: 0,
  });
  const [approval] = daemon.sessionManager.listPendingApprovals(session.id);
  const response = await daemon.app.inject({ method: 'POST', url: `/api/v1/approvals/${approval!.id}/resolve`,
    payload: { decision: 'allow_once' } });
  expect(response.statusCode).toBe(200);
  await expect.poll(() => updates.at(-1), { timeout: 1000 }).toMatchObject({ status: 'running', pendingApprovalCount: 0 });
  mock.complete(turn.json().turnId);
  await expect.poll(() => updates.at(-1), { timeout: 1000 }).toMatchObject({
    status: 'idle', latestTurnSeq: expect.any(Number), meta: { lastViewedTurnSeq: 0, forceUnread: false },
  });
  const latestTurnSeq = updates.at(-1)!.latestTurnSeq;
  expect(latestTurnSeq).toBeGreaterThan(0);
  await daemon.app.inject({ method: 'POST', url: `${endpoint}/sessions/${session.id}/viewed` });
  await expect.poll(() => updates.at(-1)?.meta.lastViewedTurnSeq, { timeout: 1000 }).toBe(latestTurnSeq);
});

it('keeps a running turn and the next send usable when Studio is disabled', async () => {
  const mock = approvalHarness();
  const { daemon, dataDir } = await start(tempDir(), [mock.adapter]);
  const session = await createSession(daemon, dataDir, mock.adapter.id);
  const sessionUrl = `/api/v1/sessions/${session.id}`;
  const send = (text: string) => daemon.app.inject({ method: 'POST', url: `${sessionUrl}/turns`, payload: { text } });
  await daemon.pluginManager.togglePlugin(pluginId, true);
  const first = await send('First W2 stream');
  expect(first.statusCode).toBe(202);
  const { turnId } = first.json();
  await expect.poll(() => daemon.sessionManager.listPendingApprovals(session.id).length).toBe(1);
  const [approval] = daemon.sessionManager.listPendingApprovals(session.id);
  expect((await daemon.app.inject({ method: 'POST', url: `/api/v1/approvals/${approval!.id}/resolve`,
    payload: { decision: 'allow_once' } })).statusCode).toBe(200);

  const toolCallId = 'w2-live-command';
  mock.emit({ type: 'tool.call.started', turnId, toolCallId, toolName: 'shell', toolKind: 'shell', summary: 'Replay command' });
  mock.emit({ type: 'command.output.delta', turnId, toolCallId, chunk: 'before disable' });
  await daemon.pluginManager.togglePlugin('hm.plugin.message-studio', false);
  mock.emit({ type: 'command.output.delta', turnId, toolCallId, chunk: ' after disable' });
  mock.emit({ type: 'tool.call.completed', turnId, toolCallId, toolName: 'shell', status: 'success' });
  mock.emit({ type: 'message.assistant.completed', turnId, text: '- [x] Kept the stream' });
  mock.complete(turnId);

  await expect.poll(() => state(daemon, session.id)).toMatchObject({ status: 'idle' });
  const item = daemon.store.getTurnItem(`tool:${toolCallId}`);
  expect(item).toMatchObject({ status: 'completed', textBody: 'before disable after disable', payload: { toolCallId } });
  const ledger = async () => (await daemon.app.inject(`${sessionUrl}/task-state`)).json().taskState;
  await expect.poll(ledger, { timeout: 10_000 }).toMatchObject({
    steps: expect.arrayContaining([expect.objectContaining({ title: 'Kept the stream', status: 'done' })]),
  });
  expect((await send('Second W2 stream')).statusCode).toBe(202);
});
