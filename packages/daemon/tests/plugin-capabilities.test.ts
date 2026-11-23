import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginManifestSchema, type Session } from '@harnessmate/protocol';
import { expect, it } from 'vitest';
import type { AdapterSessionConfig, NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

it('authorizes V3 actions and model tools by workspace and revision, and rebinds at turn boundaries', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-plugin-capabilities-'));
  const firstDir = fs.mkdtempSync(path.join(dataDir, 'first-'));
  const otherDir = fs.mkdtempSync(path.join(dataDir, 'other-'));
  let daemon = createDaemon({ dataDir, port: 0 });
  const pluginId = 'user.session-toolkit';
  const sessions: Array<{ config: AdapterSessionConfig; emit?: (event: NormalizedAdapterEvent) => void; disposed: boolean }> = [];
  const stubAdapter = () => {
    const adapter = daemon.registry.get('codex')!;
    adapter.createSession = async (config) => {
      const entry: typeof sessions[number] = { config, disposed: false };
      sessions.push(entry);
      return { nativeSessionId: 'fixture-thread', pluginMcpAvailable: Boolean(config.pluginMcp),
        onEvent(listener) { entry.emit = listener; return () => { entry.emit = undefined; }; },
        async sendTurn({ turnId }) { entry.emit?.({ type: 'turn.started', turnId }); },
        async interrupt() {}, async resolveApproval() {}, async dispose() { entry.disposed = true; },
      };
    };
  };
  const installed = () => daemon.pluginManager.listInstalled().find(({ id }) => id === pluginId)!;
  const post = (url: string, payload?: object) => daemon.app.inject({ method: 'POST', url, payload });
  const permissions = (workspaceId: string) => daemon.app.inject(`/api/v1/plugins/${pluginId}/permissions?workspaceId=${workspaceId}`);
  const grant = (workspaceId: string, capability: string, granted = true, digest = installed().packageDigest) => daemon.app.inject({
    method: 'PUT', url: `/api/v1/plugins/${pluginId}/permissions`, payload: { workspaceId, capability, digest, granted },
  });
  const action = (session: Session, command: string, args = '') => post(`/api/v1/plugins/actions/${session.id}`, { command, harnessId: 'codex', args });
  const status = async (session: Session) => (await daemon.app.inject(`/api/v1/sessions/${session.id}/commands`)).json();
  const mcp = (token: string, method: string, params?: object, origin?: string) => daemon.app.inject({
    method: 'POST', url: '/api/v1/plugin-tools', headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  try {
    await daemon.start();
    stubAdapter();
    const workspace = await daemon.sessionManager.addWorkspace(firstDir);
    const other = await daemon.sessionManager.addWorkspace(otherDir);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'codex', permissionMode: 'manual' });
    const unrelated = await daemon.sessionManager.createSession({ workspaceId: other.id, harnessId: 'codex', permissionMode: 'manual' });
    expect((await post('/api/v1/plugins/install', { mode: 'catalog', catalogId: pluginId })).statusCode).toBe(201);
    const manifest = PluginManifestSchema.parse(installed());
    const originalDigest = installed().packageDigest;
    expect((await post('/api/v1/plugins/preview/program', { manifest, programId: 'unique_lines', text: 'beta\nalpha\nbeta' })).json())
      .toEqual({ output: 'alpha\nbeta' });
    expect((await status(session)).pluginActions.find(({ command }: { command: string }) => command === 'unique-lines').reason).toContain('授权');
    expect((await action(session, 'unique-lines', 'b\na\nb')).statusCode).toBe(400);
    expect((await grant(workspace.id, 'action:unique-lines')).statusCode).toBe(200);
    expect((await grant(workspace.id, 'action:toolkit-plan')).statusCode).toBe(200);
    expect((await grant(workspace.id, 'action:toolkit-compact')).statusCode).toBe(200);
    expect((await action(session, 'unique-lines', 'b\na\nb')).json()).toMatchObject({ output: 'a\nb' });
    expect((await action(unrelated, 'unique-lines', 'b\na\nb')).statusCode).toBe(400);
    expect((await action(session, 'toolkit-plan')).json()).toMatchObject({ session: { permissionMode: 'plan' } });
    expect((await status(session)).pluginActions.find(({ command }: { command: string }) => command === 'toolkit-compact').reason).toContain('压缩');
    expect((await action(session, 'toolkit-plan', 'off')).statusCode).toBe(400);

    const baseline = await daemon.sessionManager.sendTurn(session.id, 'First turn');
    expect(sessions[0]?.config.pluginMcp).toBeUndefined();
    expect((await grant(workspace.id, 'tool:unique_lines')).statusCode).toBe(200);
    expect(sessions[0]?.disposed).toBe(false);
    sessions[0]?.emit?.({ type: 'turn.cancelled', turnId: baseline.turnId });
    expect((await status(session)).modelTools).toEqual({ count: 1, status: 'next_turn' });
    const active = await daemon.sessionManager.sendTurn(session.id, 'Second turn');
    expect(sessions[0]?.disposed).toBe(true);
    expect(sessions[1]?.config).toMatchObject({ nativeSessionId: 'fixture-thread', requireNativeResume: true });
    const connection = sessions[1]?.config.pluginMcp;
    expect(connection?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/plugin-tools$/);
    const token = connection!.token;
    expect((await mcp('incorrect', 'tools/list')).statusCode).toBe(403);
    expect((await mcp(token, 'tools/list', {}, 'https://example.com')).statusCode).toBe(403);
    expect((await mcp(token, 'initialize', { protocolVersion: '2025-06-18' })).json().result.protocolVersion).toBe('2025-06-18');
    const { tools } = (await mcp(token, 'tools/list')).json().result;
    expect(tools).toHaveLength(1);
    expect((await status(session)).modelTools).toEqual({ count: 1, status: 'connected' });
    const request = { name: tools[0].name, arguments: { text: 'b\na\nb' } };
    expect((await mcp(token, 'tools/call', request)).json().result.content).toEqual([{ type: 'text', text: 'a\nb' }]);
    expect((await mcp(token, 'tools/call', { ...request, name: 'toolkit-plan' })).json().result.isError).toBe(true);
    expect((await grant(workspace.id, 'tool:unique_lines', false)).statusCode).toBe(200);
    expect((await mcp(token, 'tools/call', request)).json().result.isError).toBe(true);
    expect(sessions[1]?.disposed).toBe(false);
    expect((await status(unrelated)).modelTools.count).toBe(0);
    sessions[1]?.emit?.({ type: 'turn.cancelled', turnId: active.turnId });
    const third = await daemon.sessionManager.sendTurn(session.id, 'Third turn');
    expect((await mcp(token, 'tools/list')).statusCode).toBe(403);
    expect(sessions[2]?.config.pluginMcp).toBeUndefined();
    sessions[2]?.emit?.({ type: 'turn.cancelled', turnId: third.turnId });

    const updated = { ...manifest, version: '1.1.0' };
    expect((await post('/api/v1/plugins/install', { mode: 'manifest', manifest: updated })).statusCode).toBe(201);
    expect((await grant(workspace.id, 'action:unique-lines', true, originalDigest)).statusCode).toBe(400);
    expect((await action(session, 'unique-lines', 'a')).statusCode).toBe(400);
    expect((await post(`/api/v1/plugins/${pluginId}/rollback`)).statusCode).toBe(200);
    expect((await action(session, 'unique-lines', 'a')).statusCode).toBe(200);
    await daemon.stop();
    daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    expect((await permissions(workspace.id)).json().permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'action:unique-lines', granted: true }),
      expect.objectContaining({ capability: 'tool:unique_lines', granted: false }),
    ]));
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 20_000);
