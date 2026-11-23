import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginManifestSchema, type PluginManifest } from '@harnessmate/protocol';
import { expect, it } from 'vitest';
import type { NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

it('refines a draft, replays it without changing the installed plugin, and checks the reviewed revision during install', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-plugin-replay-'));
  const workspacePath = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspacePath);
  const daemon = createDaemon({ dataDir, port: 0 });
  try {
    await daemon.start();
    const workspace = await daemon.sessionManager.addWorkspace(workspacePath);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'codex', permissionMode: 'manual' });
    const history = daemon.store.importSession({ ...session, id: 'desktop-history', title: 'Desktop history',
      nativeSessionId: 'desktop-original' }, 'codex_desktop', undefined, [
      { type: 'turn.failed', turnId: 'failure', createdAt: 1, payload: { harnessId: 'codex', imported: true } },
      { type: 'turn.completed', turnId: 'completion', createdAt: 2, payload: { harnessId: 'codex', imported: true } },
    ]);
    const post = (route: string, payload: object) => daemon.app.inject({
      method: 'POST', url: `/api/v1/plugins/${route}`, payload,
    });
    const pluginId = 'user.project-acceptance';
    expect((await post('install', { mode: 'catalog', catalogId: pluginId })).statusCode).toBe(201);
    const installed = () => daemon.pluginManager.listInstalled().find(({ id }) => id === pluginId)!;
    const original = PluginManifestSchema.parse(installed());
    const editing = { id: original.id, digest: installed().packageDigest! };
    const first: PluginManifest = { ...original, version: '1.1.0', description: 'Show verification failures', contributes: {
      ...original.contributes, dataPanels: original.contributes.dataPanels!.map((panel) => ({ ...panel, defaultEvent: 'turn.failed' })),
    } };
    const second: PluginManifest = { ...first, contributes: { ...first.contributes,
      dataPanels: first.contributes.dataPanels!.map((panel) => ({ ...panel, title: 'Review failures' })),
    } };
    const adapter = daemon.registry.get('codex')!;
    const prompts: string[] = [];
    adapter.createSession = async ({ permissionMode }) => {
      expect(permissionMode).toBe('plan');
      let onEvent: ((event: NormalizedAdapterEvent) => void) | undefined;
      return {
        nativeSessionId: null,
        onEvent(listener) { onEvent = listener; return () => { onEvent = undefined; }; },
        async sendTurn({ turnId, text }) {
          prompts.push(text);
          onEvent?.({ type: 'message.assistant.completed', turnId, text: JSON.stringify(prompts.length === 1 ? first : second) });
          onEvent?.({ type: 'turn.completed', turnId });
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
      };
    };
    const request = { workspaceId: workspace.id, harnessId: 'codex', editing };
    const generate = await post('generate', { ...request, description: 'Default to failures' });
    expect(generate.statusCode).toBe(200);
    const revise = await post('generate', { ...request, description: 'Rename the panel too', previous: generate.json().manifest });
    expect(revise.statusCode).toBe(200);
    expect(revise.json().manifest).toEqual(second);
    expect(JSON.parse(prompts[0]!.split('\nInstalled baseline:\n')[1]!)).toEqual(original);
    expect(JSON.parse(prompts[1]!.split('\nCurrent draft:\n')[1]!)).toEqual(first);

    const candidate = { mode: 'manifest', manifest: second };
    const review = await post('preview', candidate);
    expect(review.json()).toMatchObject({ installedDigest: editing.digest, installedManifest: original, manifest: second });
    const replayRequest = { manifest: second, sessionId: history.id, panelId: 'acceptance', query: { offset: 0, event: 'turn.failed' } };
    const replay = await post('preview/replay', replayRequest);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ total: 1, rows: [{ turnId: 'failure', imported: true }] });
    expect((await post('preview/replay', { ...replayRequest, manifest: { ...second, entry: 'index.mjs' } })).statusCode).toBe(400);
    expect(installed().packageDigest).toBe(editing.digest);
    expect(daemon.store.getSession(history.id)?.lastSeq).toBe(2);
    expect(installed().contributes.dataPanels?.[0]?.title).toBe('项目验收台');

    expect((await post('install', { ...candidate, manifest: { ...second, version: '1.2.0' } })).statusCode).toBe(201);
    const reviewedInstall = { ...candidate, expectedInstalledDigest: editing.digest };
    expect((await post('install', reviewedInstall)).statusCode).toBe(409);
    expect((await post('generate', { ...request, description: 'Check the outdated base' })).statusCode).toBe(409);
    expect(installed().version).toBe('1.2.0');
    const updatedReview = await post('preview', candidate);
    expect((await post('install', { ...candidate, expectedInstalledDigest: updatedReview.json().installedDigest })).statusCode).toBe(201);
    expect(installed().contributes.dataPanels?.[0]).toMatchObject({ title: 'Review failures', defaultEvent: 'turn.failed' });
    expect((await post(`${pluginId}/rollback`, {})).statusCode).toBe(200);
    expect(installed().version).toBe('1.2.0');
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 15_000);
