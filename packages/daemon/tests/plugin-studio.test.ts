import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { PluginManifest } from '@harnessmate/protocol';
import type { NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

it('generates a reviewable draft, hot loads it and preserves the previous revision on errors and restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-plugin-studio-'));
  const workspacePath = path.join(dataDir, 'workspace');
  const localPluginPath = path.join(dataDir, 'local-plugin');
  fs.mkdirSync(workspacePath);
  fs.mkdirSync(localPluginPath);
  let daemon = createDaemon({ dataDir, port: 0 });
  try {
    await daemon.start();
    const adapter = daemon.registry.get('codex')!;
    const workspace = await daemon.sessionManager.addWorkspace(workspacePath);
    const draft: PluginManifest = {
      id: 'user.delivery', name: 'Delivery', version: '1.0.0', description: 'Delivery panel',
      category: 'workflow', apiVersion: 1,
      contributes: {
        slashCommands: [{ command: 'delivery', description: 'Build a delivery summary', template: 'Summarize {{args}}' }],
        panels: [{ id: 'report', title: 'Delivery', sections: ['changed_files', 'verifications'],
          actions: [{ label: 'Summarize', command: 'delivery' }] }],
      },
    };
    let listener: ((event: NormalizedAdapterEvent) => void) | undefined;
    let disposed = false;
    adapter.createSession = async (config) => {
      expect(config).toMatchObject({ cwd: workspacePath, permissionMode: 'plan' });
      return {
        nativeSessionId: null,
        onEvent(callback) { listener = callback; return () => { listener = undefined; }; },
        async sendTurn({ turnId, text }) {
          expect(text).toContain('Create a delivery plugin');
          listener?.({ type: 'message.assistant.completed', turnId, text: JSON.stringify(draft) });
          listener?.({ type: 'turn.completed', turnId });
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() { disposed = true; },
      };
    };
    const post = (action: string, payload?: unknown) => daemon.app.inject({
      method: 'POST', url: `/api/v1/plugins/${action}`, payload: payload as Record<string, unknown>,
    });
    const generate = await post('generate', { workspaceId: workspace.id, harnessId: 'codex', description: 'Create a delivery plugin' });
    expect(generate.statusCode).toBe(200);
    expect(generate.json().manifest).toEqual(draft);
    expect(disposed).toBe(true);
    expect(daemon.pluginManager.listInstalled().some(({ id }) => id === draft.id)).toBe(false);
    const preview = await post('preview', { mode: 'manifest', manifest: draft });
    expect(preview.statusCode).toBe(200);
    expect((await post('install', { mode: 'manifest', manifest: draft })).statusCode).toBe(201);
    const turn = { sessionId: 'test', harnessId: 'codex', cwd: workspacePath, text: '/delivery recent changes' };
    expect(await daemon.pluginManager.processBeforeTurn(turn)).toMatchObject({ text: 'Summarize recent changes' });
    expect(daemon.registry.get('codex')).toBe(adapter);

    const codeManifest = { ...draft, version: '2.0.0', entry: 'entry.mjs' };
    fs.writeFileSync(path.join(localPluginPath, 'harnessmate-plugin.json'), JSON.stringify(codeManifest));
    fs.writeFileSync(path.join(localPluginPath, 'entry.mjs'), 'throw new Error("broken upgrade")');
    const codeRequest = { mode: 'local_dir', dirPath: localPluginPath };
    const firstPreview = (await post('preview', codeRequest)).json();
    expect((await post('install', codeRequest)).statusCode).toBe(400);
    const failed = await post('install', { ...codeRequest, expectedDigest: firstPreview.digest, trustCode: true });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error).toContain('broken upgrade');
    expect(await daemon.pluginManager.processBeforeTurn(turn)).toMatchObject({ text: 'Summarize recent changes' });

    fs.writeFileSync(path.join(localPluginPath, 'entry.mjs'), 'export const beforeTurn = ({ text }) => ({ text: "v2 " + text });');
    expect((await post('install', { ...codeRequest, expectedDigest: firstPreview.digest, trustCode: true })).statusCode).toBe(400);
    const secondPreview = (await post('preview', codeRequest)).json();
    expect((await post('install', { ...codeRequest, expectedDigest: secondPreview.digest, trustCode: true })).statusCode).toBe(201);
    expect(await daemon.pluginManager.processBeforeTurn(turn)).toMatchObject({ text: 'v2 Summarize recent changes' });

    await daemon.stop();
    daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    expect(await daemon.pluginManager.processBeforeTurn(turn)).toMatchObject({ text: 'v2 Summarize recent changes' });
    expect((await post(`${draft.id}/rollback`)).statusCode).toBe(200);
    expect(await daemon.pluginManager.processBeforeTurn(turn)).toMatchObject({ text: 'Summarize recent changes' });
    fs.writeFileSync(path.join(localPluginPath, 'entry.mjs'), 'export function beforeTurn() { for (;;) {} }');
    const stuckPreview = (await post('preview', codeRequest)).json();
    expect((await post('install', { ...codeRequest, expectedDigest: stuckPreview.digest, trustCode: true })).statusCode).toBe(201);
    expect(await daemon.pluginManager.processBeforeTurn(turn)).toMatchObject({ text: 'Summarize recent changes' });
    expect(daemon.pluginManager.listInstalled().find(({ id }) => id === draft.id)?.loadError).toContain('超时');
    expect((await post(`${draft.id}/rollback`)).statusCode).toBe(200);
    const reserved = { ...draft, id: 'user.bad', contributes: {
      slashCommands: [{ command: 'compact', description: 'Reserved', template: 'Reserved' }],
    } };
    expect((await post('install', { mode: 'manifest', manifest: reserved })).statusCode).toBe(400);
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 15_000);
