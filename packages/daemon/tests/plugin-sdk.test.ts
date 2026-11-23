import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginManifest, PluginPanelSnapshot } from '@harnessmate/protocol';
import { expect, it } from 'vitest';
import { createDaemon } from '../src/server/app.js';

it('projects persisted CLI events across a workspace and preserves the active panel on a failed upgrade', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-plugin-sdk-'));
  const workspacePath = path.join(dataDir, 'workspace');
  const otherPath = path.join(dataDir, 'other');
  fs.mkdirSync(workspacePath);
  fs.mkdirSync(otherPath);
  let daemon = createDaemon({ dataDir, port: 0 });
  try {
    await daemon.start();
    const workspace = await daemon.sessionManager.addWorkspace(workspacePath);
    const other = await daemon.sessionManager.addWorkspace(otherPath);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'codex', permissionMode: 'manual' });
    const imported = daemon.store.importSession({ ...session, id: 'agy-history', harnessId: 'agy', harnessKind: 'agy',
      nativeSessionId: 'desktop-history', title: 'AGY history' }, 'agy_desktop', undefined, [{
      type: 'turn.completed', turnId: 'one', createdAt: 1000, payload: { harnessId: 'agy', imported: true },
    }]);
    const unrelated = await daemon.sessionManager.createSession({ workspaceId: other.id, harnessId: 'codex', permissionMode: 'manual' });
    daemon.store.appendEvent(unrelated.id, 'turn.completed', { harnessId: 'codex' }, 'outside');

    const post = (endpoint: string, payload?: object) => daemon.app.inject({ method: 'POST', url: `/api/v1/plugins/${endpoint}`, payload });
    const pluginId = 'user.project-acceptance';
    const panels = (query = '') => daemon.app.inject(`/api/v1/sessions/${session.id}/plugin-panels/${pluginId}/acceptance${query}`);
    const read = async (query = ''): Promise<PluginPanelSnapshot> => {
      const response = await panels(query);
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    expect((await panels()).statusCode).toBe(404);
    expect((await post('install', { mode: 'catalog', catalogId: pluginId })).statusCode).toBe(201);
    expect(await read()).toMatchObject({ total: 1, rows: [{ sessionId: imported.id, imported: true, verifications: [] }] });

    daemon.store.appendEvent(session.id, 'tool.call.started', {
      toolCallId: 'edit', toolKind: 'file_edit', toolName: 'Edit', input: { file_path: 'src/index.ts' },
    }, 'one');
    daemon.store.appendEvent(session.id, 'tool.call.completed', { toolCallId: 'edit', status: 'success' }, 'one');
    daemon.store.appendEvent(session.id, 'tool.call.started', {
      toolCallId: 'test', toolKind: 'shell', toolName: 'Exec', input: { command: ['pnpm', 'test'] },
    }, 'one');
    daemon.store.appendEvent(session.id, 'tool.call.completed', { toolCallId: 'test', status: 'error' }, 'one');
    daemon.store.appendEvent(session.id, 'turn.completed', { harnessId: 'codex' }, 'one');
    daemon.store.appendEvent(session.id, 'turn.failed', { harnessId: 'codex' }, 'one');
    daemon.store.appendEvent(session.id, 'turn.completed', { harnessId: 'codex', maintenance: true }, 'compact');
    for (let index = 0; index < 26; index++) {
      daemon.store.appendEvent(session.id, 'turn.completed', { harnessId: 'claude' }, `claude-${index}`);
    }
    expect(await read()).toMatchObject({ total: 28, scope: 'workspace', counts: expect.arrayContaining([
      { event: 'turn.completed', harnessId: 'claude', count: 26 },
      { event: 'turn.completed', harnessId: 'agy', count: 1 },
      { event: 'turn.failed', harnessId: 'codex', count: 1 },
    ]) });
    expect(await read('?event=turn.failed')).toMatchObject({ total: 1, rows: [{
      turnId: 'one', files: ['src/index.ts'], verifications: [{ command: 'pnpm test', status: 'fail' }],
    }] });
    expect(await read('?harnessId=claude&offset=25')).toMatchObject({ total: 26, rows: [{ turnId: 'claude-0' }] });
    expect((await panels('?event=approval.requested')).statusCode).toBe(400);
    expect(() => daemon.pluginManager.expandSlashCommand('/acceptance')).toThrow('桌面插件面板命令');

    const installed = daemon.pluginManager.listInstalled().find(({ id }) => id === pluginId)!;
    const upgraded: PluginManifest = { ...installed, version: '1.1.0', contributes: {
      ...installed.contributes, projections: [{ id: 'turns', scope: 'session', events: ['turn.completed', 'turn.failed'] }],
    } };
    const broken = { ...upgraded, contributes: { ...upgraded.contributes, projections: [] } };
    expect((await post('install', { mode: 'manifest', manifest: broken })).statusCode).toBe(400);
    expect((await post('preview', { mode: 'manifest', manifest: { ...upgraded, apiVersion: 1 } })).statusCode).toBe(400);
    expect((await read()).scope).toBe('workspace');
    expect((await post('install', { mode: 'manifest', manifest: upgraded })).statusCode).toBe(201);
    expect(await read()).toMatchObject({ scope: 'session', total: 27 });
    await daemon.stop();
    daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    expect(await read()).toMatchObject({ scope: 'session', total: 27 });
    expect((await post(`${pluginId}/rollback`)).statusCode).toBe(200);
    expect(await read()).toMatchObject({ scope: 'workspace', total: 28 });
    expect((await daemon.app.inject({ method: 'PATCH', url: `/api/v1/plugins/${pluginId}`, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await panels()).statusCode).toBe(404);
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 20_000);
