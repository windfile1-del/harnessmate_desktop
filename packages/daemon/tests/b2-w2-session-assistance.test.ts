import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { GLOBAL_WORKSPACE_SCOPE } from '../src/plugin-host/permissions/permissions.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const dirs: string[] = [];
let daemon: DaemonInstance | undefined;
const ledger = 'core.task-ledger';
const inbox = 'hm.plugin.triage-inbox';
const snooze = 'hm.plugin.session-snooze';

async function start(dir?: string) {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-b2-w2-'));
    dirs.push(dir);
  }
  const app = createDaemon({ dataDir: dir, port: 0, hostOverride: '127.0.0.1' });
  daemon = app;
  await app.start();
  return { app, dir };
}

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('commits replay position with the projected ledger and preserves manual fields across disable and restart', async () => {
  const { app, dir } = await start();
  const workspace = await app.sessionManager.addWorkspace(dir);
  const session = await app.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual' });
  const url = `/api/v1/sessions/${session.id}/task-state`;
  const cursorKey = `projection:${session.id}`;
  const cursor = (target: DaemonInstance) => target.store.getPluginStorageValue(GLOBAL_WORKSPACE_SCOPE, ledger, cursorKey);
  const manual = { objective: 'Keep this manual objective', pinnedFacts: ['Keep this fact'], rollingSummary: 'Manual digest' };
  expect((await app.app.inject({ url, method: 'PUT', payload: manual })).statusCode).toBe(200);
  await app.pluginManager.togglePlugin(ledger, false);
  const turnId = 'completed-while-ledger-disabled';
  app.store.appendEvent(session.id, 'message.user', { text: 'Preserve the ledger' }, turnId);
  app.store.appendEvent(session.id, 'message.assistant.completed', { text: '- [x] Completed while disabled' }, turnId);
  const complete = app.store.appendEvent(session.id, 'turn.completed', {}, turnId);
  expect((await app.app.inject({ url })).statusCode).toBe(404);
  expect((await app.app.inject({ url: `/api/v1/sessions/${session.id}` })).json().taskState).toMatchObject(manual);

  const persist = app.store.setPluginStorageValue.bind(app.store);
  const failedWrite = vi.spyOn(app.store, 'setPluginStorageValue').mockImplementation((scope, instanceId, key, value) => {
    if (key === cursorKey && value === complete.seq) throw new Error('Injected cursor write failure');
    persist(scope, instanceId, key, value);
  });
  const before = app.store.getTaskState(session.id);
  await app.pluginManager.togglePlugin(ledger, true);
  await expect.poll(() => failedWrite.mock.calls.some(([, , key, value]) => key === cursorKey && value === complete.seq), { timeout: 10_000 }).toBe(true);
  expect(cursor(app)).not.toBe(complete.seq);
  expect(app.store.getTaskState(session.id)).toEqual(before);
  failedWrite.mockRestore();
  await app.stop();
  daemon = undefined;

  const { app: reopened } = await start(dir);
  await expect.poll(() => cursor(reopened), { timeout: 10_000 }).toBe(complete.seq);
  const projected = reopened.store.getTaskState(session.id)!;
  expect(projected).toMatchObject({ ...manual, steps: [{ title: 'Completed while disabled', status: 'done' }] });
  await reopened.pluginManager.togglePlugin(ledger, false);
  await reopened.pluginManager.togglePlugin(ledger, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(reopened.store.getTaskState(session.id)?.version).toBe(projected.version);
  await reopened.pluginManager.togglePlugin('hm.plugin.task-summary', false);
  expect((await reopened.app.inject({ url: `${url}/summarize`, method: 'POST' })).statusCode).toBe(404);
  expect((await reopened.app.inject({ url })).statusCode).toBe(200);
});

it('recovers a due snooze after restart and never replays a cancelled or deleted cycle', async () => {
  const { app, dir } = await start();
  const workspace = await app.sessionManager.addWorkspace(dir);
  const session = await app.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual' });
  const cancelled = await app.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual' });
  const patch = (target: DaemonInstance, id: string, payload: object) =>
    target.app.inject({ method: 'PATCH', url: `/api/v1/triage/sessions/${id}`, payload });
  const check = (target: DaemonInstance) => target.app.inject({ method: 'POST', url: '/api/v1/triage/check-snoozes' });
  await app.pluginManager.togglePlugin(inbox, true);
  const when = Date.now() + 60_000;
  expect((await patch(app, session.id, { pinned: true, snoozedUntilMs: when })).statusCode).toBe(200);
  expect((await patch(app, cancelled.id, { snoozedUntilMs: when })).statusCode).toBe(200);
  await app.pluginManager.togglePlugin(snooze, false);
  expect((await patch(app, cancelled.id, { snoozedUntilMs: null })).statusCode).toBe(200);
  const prior = app.store.getPluginStorageValue(GLOBAL_WORKSPACE_SCOPE, inbox, session.id) as Record<string, unknown>;
  const past = Date.now() - 60_000;
  app.store.setPluginStorageValue(GLOBAL_WORKSPACE_SCOPE, inbox, session.id, { ...prior, snoozedUntilMs: past });
  expect((await check(app)).json()).toMatchObject({ expired: [], reminders: [] });
  await app.stop();
  daemon = undefined;

  const { app: reopened } = await start(dir);
  await reopened.pluginManager.togglePlugin(snooze, true);
  const first = (await check(reopened)).json();
  expect(first.reminders).toEqual([expect.objectContaining({ sessionId: session.id, snoozedUntilMs: past })]);
  expect((await check(reopened)).json()).toMatchObject({ expired: [], reminders: first.reminders });
  const plan = () => reopened.app.inject({
    method: 'POST', url: '/api/v1/desktop/session-notifications/plan',
    payload: { kind: 'snooze', sessionId: session.id, identity: 'due-cycle' },
  });
  const planned = (await plan()).json().notice;
  expect(planned).toMatchObject({ id: `snooze:${session.id}:due-cycle` });
  expect((await plan()).json().notice).toEqual(planned);
  await reopened.pluginManager.togglePlugin('hm.plugin.desktop-notifications', false);
  expect((await plan()).json().notice).toBeNull();
  expect((await check(reopened)).json().reminders).toEqual(first.reminders);
  expect(await reopened.sessionManager.deleteSession(session.id)).toBe(true);
  expect((await check(reopened)).json()).toMatchObject({ expired: [], reminders: [] });
});

it('loads the preinstalled Studio, ledger and inbox assets with their actual instance identities', async () => {
  const { app } = await start();
  await app.pluginManager.togglePlugin(inbox, true);
  for (const [contract, instanceId] of [['session.studio.v1', 'hm.plugin.message-studio'], ['session.ledger.v1', 'ledger'], ['session.inbox.v1', inbox]]) {
    expect(app.pluginManager.resolveServiceSelection(contract)).toMatchObject({ status: 'ready', instanceId });
    const response = await app.app.inject({ url: `/api/v1/plugins/${instanceId}/ui-doc?path=ui%2Fpanel.html` });
    expect(response.statusCode).toBe(200);
    expect(response.json().html).toContain('harnessMate');
  }
});

it('keeps two inbox and ledger instances isolated and binds directory-installed fixtures per session', async () => {
  const { app, dir } = await start();
  const workspace = await app.sessionManager.addWorkspace(dir);
  const first = await app.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual' });
  const second = await app.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual' });
  const manager = app.pluginManager;
  await manager.togglePlugin(inbox, true);
  await manager.upsertCompositionInstance({ id: 'second-inbox', name: inbox });
  await manager.upsertCompositionInstance({ id: 'second-ledger', name: ledger });
  await manager.setSessionBinding(second.id, 'session.inbox.v1', 'second-inbox');
  await manager.setSessionBinding(second.id, 'session.ledger.v1', 'second-ledger');

  for (const [session, objective] of [[first, 'first only'], [second, 'second only']] as const) {
    const ledgerResponse = await app.app.inject({ method: 'PUT', url: `/api/v1/sessions/${session.id}/task-state`, payload: { objective } });
    expect(ledgerResponse.json().taskState.objective).toBe(objective);
    const inboxResponse = await app.app.inject({ method: 'PATCH', url: `/api/v1/triage/sessions/${session.id}`, payload: { pinned: true } });
    expect(inboxResponse.statusCode).toBe(200);
  }
  expect(app.store.getTaskState(first.id)?.objective).toBe('first only');
  expect(app.store.getTaskState(second.id)?.objective).not.toBe('second only');
  expect(app.store.getPluginStorageValue(GLOBAL_WORKSPACE_SCOPE, inbox, second.id)).toBeUndefined();
  expect(app.store.getPluginStorageValue(GLOBAL_WORKSPACE_SCOPE, 'second-inbox', second.id)).toMatchObject({ pinned: true });

  const dirPath = fileURLToPath(new URL('../../../plugins/examples/user.session-studio-fixture', import.meta.url));
  const preview = manager.previewInstall({ mode: 'local_dir', dirPath });
  await manager.installPlugin({
    mode: 'local_dir', dirPath, trustCode: true,
    expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest,
  });
  const fixture = 'user.session-studio-fixture';
  await manager.setSessionBinding(second.id, 'session.studio.v1', fixture);
  await manager.setSessionBinding(first.id, 'git.workspace.v1', fixture);
  await manager.setSessionBinding(first.id, 'session.failover.v1', fixture);
  const scope = { workspaceId: workspace.id, sessionId: first.id };
  expect((await manager.invokeServiceSelection('git.workspace.v1', 'getStatus', [{ ...scope, cwd: dir }], scope)).value).toMatchObject({
    ...scope, available: true, status: { changes: [{ path: 'fixture/w2-git-status.txt' }] },
  });
  expect((await manager.invokeServiceSelection('session.failover.v1', 'recommend', [scope], scope)).value).toMatchObject({
    sessionId: first.id, candidate: 'fixture-secondary', action: 'suggest',
  });
  fs.mkdirSync(path.join(dir, '.git'));
  await manager.togglePlugin('ledger', false);
  app.store.appendEvent(first.id, 'turn.completed', {}, 'git-fixture-turn');
  await manager.togglePlugin('ledger', true);
  await expect.poll(() => app.store.getTaskState(first.id)?.touchedFiles).toContain('fixture/w2-git-status.txt');
  expect(manager.resolveServiceSelection('session.studio.v1', { sessionId: second.id })).toMatchObject({ status: 'ready', instanceId: fixture });
  expect(manager.resolveServiceSelection('session.studio.v1', { sessionId: first.id })).toMatchObject({ status: 'ready', instanceId: 'hm.plugin.message-studio' });
  await manager.togglePlugin('hm.plugin.message-studio', false);
  expect(manager.resolveServiceSelection('session.studio.v1', { sessionId: second.id })).toMatchObject({ status: 'ready', instanceId: fixture });
  const stillBound = await app.app.inject({ url: `/api/v1/sessions/${second.id}/task-state` });
  expect(stillBound.json().taskState.objective).toBe('second only');
});

it('projects the W1 Git provider into the W2 ledger and reads the same file via the W1 sidebar API', async () => {
  const { app, dir } = await start();
  const repo = path.join(dir, '工作区 with spaces');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  const file = '工作记录.md';
  const changedFile = 'work-log.md';
  fs.writeFileSync(path.join(repo, file), 'First line\nW2 linked line\n');
  fs.writeFileSync(path.join(repo, changedFile), 'W2 Git status probe\n');
  const workspace = await app.sessionManager.addWorkspace(repo);
  const session = await app.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'agy', permissionMode: 'manual' });
  const base = `/api/v1/sessions/${session.id}`;
  const gitUrl = `/api/v1/workspaces/${workspace.id}/git/status?sessionId=${session.id}`;
  const status = await app.app.inject(gitUrl);
  expect(status.json()).toMatchObject({ available: true, instanceId: 'git', status: {
    changes: expect.arrayContaining([expect.objectContaining({ path: changedFile })]),
  } });
  await app.pluginManager.togglePlugin('ledger', false);
  app.store.appendEvent(session.id, 'turn.completed', { harnessId: session.harnessId }, 'w1-w2-turn');
  await app.pluginManager.togglePlugin('ledger', true);
  await expect.poll(() => app.store.getTaskState(session.id)?.touchedFiles, { timeout: 10_000 }).toContain(changedFile);
  const preview = await app.app.inject(`${base}/file-view?path=${encodeURIComponent(file)}&line=2`);
  expect(preview.statusCode).toBe(200);
  expect(preview.json().file).toMatchObject({ relativePath: file, content: 'First line\nW2 linked line\n' });
  await app.pluginManager.togglePlugin('git', false);
  expect((await app.app.inject(gitUrl)).json()).toMatchObject({ available: false, reason: 'disabled' });
  expect((await app.app.inject(`${base}/task-state`)).json().taskState.touchedFiles).toContain(changedFile);
});
