import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { AdapterSessionConfig, NormalizedAdapterEvent } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

function writePluginDir(
  parent: string,
  folderName: string,
  manifest: Record<string, unknown>,
  entryCode: string,
  entryName = 'index.mjs',
): string {
  const dir = path.join(parent, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'harnessmate-plugin.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, entryName), entryCode);
  return dir;
}

async function installTrustedDir(daemon: ReturnType<typeof createDaemon>, dirPath: string) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  expect(preview.requiresTrust).toBe(true);
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  return preview;
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

it('enforces Node permission sandbox, sanitized env, handshake requires, and stale runId rejection', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-sandbox-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-src-'));
  const secretFile = path.join(staging, 'outside-secret.txt');
  fs.writeFileSync(secretFile, 'TOP_SECRET_DATA');

  const prevOpenAi = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-secret-should-not-leak';
  const daemon = createDaemon({ dataDir, port: 0 });

  try {
    await daemon.start();
    const workspace = await daemon.sessionManager.addWorkspace(staging);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'codex', permissionMode: 'manual' });

    // 1. Handshake rejects unsupported `requires`
    const badRequiresDir = writePluginDir(
      staging,
      'bad-requires',
      {
        id: 'user.bad-requires',
        name: 'Bad Requires',
        version: '1.0.0',
        description: 'Requires unsupported feature',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
      },
      `export const requires = ['future.teleport'];
       export function apply() {}`,
    );
    const badPreview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: badRequiresDir });
    await expect(
      daemon.pluginManager.installPlugin({
        mode: 'local_dir',
        dirPath: badRequiresDir,
        trustCode: true,
        expectedDigest: badPreview.digest,
      }),
    ).rejects.toThrow('宿主不支持');
    expect(daemon.pluginManager.listInstalled().some(({ id }) => id === 'user.bad-requires')).toBe(false);

    // 2. Sandbox probe plugin verifies fs/child_process/env/system-channel/runId isolation
    const probeDir = writePluginDir(
      staging,
      'sandbox-probe',
      {
        id: 'user.sandbox-probe',
        name: 'Sandbox Probe',
        version: '1.0.0',
        description: 'Probes isolation boundary',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
        contributes: {
          commands: [{ command: 'probe', description: 'Run sandbox checks' }],
        },
      },
      `import fs from 'node:fs';
       import { spawnSync } from 'node:child_process';
       export const requires = ['rpc.v1', 'isolation.process'];
       export function apply(ctx) {
         ctx.commands.register('probe', async ({ args }) => {
           const report = {
             runId: ctx.runId,
             hasSystemPromptApi: 'systemPrompt' in ctx || 'outboundGate' in ctx,
             leakedOpenAi: Boolean(process.env.OPENAI_API_KEY),
             leakedHarnessMateToken: Object.keys(process.env).some((k) => k.startsWith('HARNESSMATE_')),
           };
           try {
             fs.readFileSync(args, 'utf8');
             report.outsideRead = 'ALLOWED';
           } catch (err) {
             report.outsideRead = err.code || err.message;
           }
           try {
             fs.writeFileSync('escape.txt', 'bad');
             report.directWrite = 'ALLOWED';
           } catch (err) {
             report.directWrite = err.code || err.message;
           }
           try {
             spawnSync(process.execPath, ['-v']);
             report.spawnChild = 'ALLOWED';
           } catch (err) {
             report.spawnChild = err.code || err.message;
           }
           try {
             await ctx.__rawRpcCall('sessions.list', {}, 'forged-run-id');
             report.forgedRunId = 'ALLOWED';
           } catch (err) {
             report.forgedRunId = err.code || err.message;
           }
           try {
             await ctx.__rawRpcCall('service.call', { service: 'harness.codex', method: 'probe', args: [] });
             report.internalHarness = 'ALLOWED';
           } catch (err) {
             report.internalHarness = err.code || err.message;
           }
           return { kind: 'message', text: JSON.stringify(report) };
         });
       }`,
    );

    await installTrustedDir(daemon, probeDir);
    const info = daemon.pluginManager.listInstalled().find(({ id }) => id === 'user.sandbox-probe')!;
    expect(info.runtimeState).toBe('ACTIVE');
    expect(info.runtimeMode).toBe('isolated');
    const firstRunId = info.runId!;
    expect(firstRunId).toBeTruthy();

    const res = await daemon.pluginManager.isolated!.runCommand(session, 'probe', secretFile, firstRunId);
    expect(res.kind).toBe('message');
    const report = JSON.parse((res as { kind: 'message'; text: string }).text);
    expect(report).toEqual({
      runId: firstRunId,
      hasSystemPromptApi: false,
      leakedOpenAi: false,
      leakedHarnessMateToken: false,
      outsideRead: 'ERR_ACCESS_DENIED',
      directWrite: 'ERR_ACCESS_DENIED',
      spawnChild: 'ERR_ACCESS_DENIED',
      forgedRunId: 'E_STALE_RUN',
      internalHarness: 'E_PERMISSION_DENIED',
    });

    // Restart plugin and verify old runId is rejected with E_STALE_RUN while new runId succeeds
    await daemon.pluginManager.togglePlugin('user.sandbox-probe', false);
    await daemon.pluginManager.togglePlugin('user.sandbox-probe', true);
    const secondRunId = daemon.pluginManager.isolated!.getRunId('user.sandbox-probe')!;
    expect(secondRunId).not.toBe(firstRunId);
    await expect(
      daemon.pluginManager.isolated!.runCommand(session, 'probe', secretFile, firstRunId),
    ).rejects.toMatchObject({ code: 'E_STALE_RUN' });
    const afterRestart = await daemon.pluginManager.isolated!.runCommand(session, 'probe', secretFile, secondRunId);
    expect(afterRestart.kind).toBe('message');
  } finally {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}, 25_000);

it('isolates single-call timeouts and applies exponential backoff crash recovery until FAILED after 5 crashes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-reliability-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-rel-src-'));
  const daemon = createDaemon({
    dataDir,
    port: 0,
    pluginCrashPolicy: { baseBackoffMs: 40, maxBackoffMs: 120, crashWindowMs: 60_000, maxCrashesInWindow: 5 },
  });

  try {
    await daemon.start();
    const pluginDir = writePluginDir(
      staging,
      'timeout-crash',
      {
        id: 'user.reliability',
        name: 'Reliability Plugin',
        version: '1.0.0',
        description: 'Tests timeout and crash recovery',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
        provides: ['acme.reliability'],
      },
      `export function apply(ctx) {
         ctx.provide('acme.reliability', {
           async slow() {
             await new Promise((resolve) => setTimeout(resolve, 2000));
             return 'too-late';
           },
           fast(x) {
             return 'ok:' + x + ':' + ctx.runId;
           },
         });
       }`,
    );

    await installTrustedDir(daemon, pluginDir);
    const active = daemon.pluginManager.isolated!.getActive('user.reliability')!;
    const runId1 = active.runId;

    // Single call timeout should NOT terminate the plugin process
    await expect(
      active.process.call('host.service.call', { service: 'acme.reliability', method: 'slow', args: [] }, 80, runId1),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });

    const fastRes = await active.process.call('host.service.call', { service: 'acme.reliability', method: 'fast', args: ['alive'] }, 2_000, runId1);
    expect(fastRes).toBe(`ok:alive:${runId1}`);
    expect(daemon.pluginManager.isolated!.getRunId('user.reliability')).toBe(runId1);

    // Crash 1..4 should recover with a fresh runId each time
    let prevRunId = runId1;
    for (let crash = 1; crash <= 4; crash++) {
      daemon.pluginManager.isolated!.getActive('user.reliability')!.process.forceKill();
      await waitFor(() => {
        const current = daemon.pluginManager.isolated!.getActive('user.reliability');
        return Boolean(current && current.runId !== prevRunId && daemon.pluginManager.host.status('user.reliability')?.state === 'ACTIVE');
      });
      prevRunId = daemon.pluginManager.isolated!.getRunId('user.reliability')!;
    }

    // 5th crash in window must transition plugin permanently to FAILED (no more auto-restart)
    daemon.pluginManager.isolated!.getActive('user.reliability')!.process.forceKill();
    await waitFor(() => {
      const status = daemon.pluginManager.host.status('user.reliability');
      return status?.state === 'FAILED' && Boolean(status.error?.includes('5 次'));
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(daemon.pluginManager.host.status('user.reliability')?.state).toBe('FAILED');
    expect(daemon.pluginManager.isolated!.getActive('user.reliability')).toBeUndefined();
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}, 25_000);

it('supports third-party services across processes and permission-gated public service replacement', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-services-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-svc-src-'));
  const daemon = createDaemon({ dataDir, port: 0 });

  try {
    await daemon.start();
    const workspace = await daemon.sessionManager.addWorkspace(staging);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'codex', permissionMode: 'manual' });

    // Reserved service cannot be provided by third-party plugin
    const reservedDir = writePluginDir(
      staging,
      'reserved-harness',
      {
        id: 'user.bad-harness',
        name: 'Bad Harness',
        version: '1.0.0',
        description: 'Tries to hijack harness.codex',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
        provides: ['harness.codex'],
      },
      `export function apply() {}`,
    );
    expect(() => daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath: reservedDir }))
      .toThrow(expect.objectContaining({ code: 'E_PERMISSION_DENIED' }));

    // 1. Third-party custom service provider + dependent consumer across two isolated processes
    const providerDir = writePluginDir(
      staging,
      'echo-provider',
      {
        id: 'user.echo-provider',
        name: 'Echo Provider',
        version: '1.0.0',
        description: 'Provides acme.echo',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
        provides: ['acme.echo'],
      },
      `export function apply(ctx) {
         ctx.provide('acme.echo', {
           double(n) { return Number(n) * 2; },
         });
       }`,
    );
    const consumerDir = writePluginDir(
      staging,
      'echo-consumer',
      {
        id: 'user.echo-consumer',
        name: 'Echo Consumer',
        version: '1.0.0',
        description: 'Consumes acme.echo',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
        inject: ['acme.echo'],
        contributes: { commands: [{ command: 'double-it', description: 'Double a number' }] },
      },
      `export function apply(ctx) {
         ctx.commands.register('double-it', async ({ args }) => {
           const svc = ctx.get('acme.echo');
           const out = await svc.double(Number(args));
           return { kind: 'message', text: String(out) };
         });
       }`,
    );

    // Install consumer first -> PENDING waiting on acme.echo
    await installTrustedDir(daemon, consumerDir);
    expect(daemon.pluginManager.host.status('user.echo-consumer')).toMatchObject({
      state: 'PENDING',
      missingServices: ['acme.echo'],
    });

    // Install provider -> both become ACTIVE and cross-process RPC succeeds
    await installTrustedDir(daemon, providerDir);
    expect(daemon.pluginManager.host.status('user.echo-provider')?.state).toBe('ACTIVE');
    expect(daemon.pluginManager.host.status('user.echo-consumer')?.state).toBe('ACTIVE');

    const rpcResult = await daemon.pluginManager.isolated!.runCommand(session, 'double-it', '21');
    expect(rpcResult).toEqual({ kind: 'message', text: '42' });

    // Disable provider -> consumer returns to PENDING; re-enable -> consumer returns to ACTIVE
    await daemon.pluginManager.togglePlugin('user.echo-provider', false);
    expect(daemon.pluginManager.host.status('user.echo-consumer')).toMatchObject({
      state: 'PENDING',
      missingServices: ['acme.echo'],
    });
    await daemon.pluginManager.togglePlugin('user.echo-provider', true);
    expect(daemon.pluginManager.host.status('user.echo-consumer')?.state).toBe('ACTIVE');
    expect(await daemon.pluginManager.isolated!.runCommand(session, 'double-it', '15')).toEqual({ kind: 'message', text: '30' });

    // 2. Replace built-in public service `ledger` with `service:provide:ledger` permission
    const customLedgerDir = writePluginDir(
      staging,
      'custom-ledger',
      {
        id: 'user.custom-ledger',
        name: 'Custom Ledger',
        version: '1.0.0',
        description: 'Replaces built-in ledger service',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
        provides: ['ledger'],
        permissions: ['service:provide:ledger'],
      },
      `export function apply(ctx) {
         ctx.provide('ledger', {
           get(sessionId) {
             return {
               sessionId,
               objective: 'custom-ledger-objective',
               steps: [],
               decisions: ['from-third-party'],
               touchedFiles: [],
               blockers: [],
               pinnedFacts: [],
               version: 99,
               updatedAt: 1,
             };
           },
         });
       }`,
    );

    const ledgerReaderDir = writePluginDir(
      staging,
      'ledger-reader',
      {
        id: 'user.ledger-reader',
        name: 'Ledger Reader',
        version: '1.0.0',
        description: 'Reads ledger via ctx.ledger',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        main: 'index.mjs',
        inject: ['ledger'],
        permissions: ['session:read'],
        contributes: { commands: [{ command: 'read-ledger', description: 'Read ledger' }] },
      },
      `export function apply(ctx) {
         ctx.commands.register('read-ledger', async ({ sessionId }) => {
           const data = await ctx.ledger.get(sessionId);
           return { kind: 'message', text: data.objective };
         });
       }`,
    );

    await daemon.pluginManager.togglePlugin('core.task-ledger', false);
    const ledgerPreview = await installTrustedDir(daemon, customLedgerDir);
    // Without service:provide:ledger grant, custom-ledger fails with E_PERMISSION_DENIED
    expect(daemon.pluginManager.host.status('user.custom-ledger')?.state).toBe('FAILED');
    expect(daemon.pluginManager.host.status('user.custom-ledger')?.error).toContain('service:provide:ledger');

    // Grant service:provide:ledger globally -> custom-ledger activates automatically!
    const grantRes = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/user.custom-ledger/permissions',
      payload: {
        workspaceId: '__global__',
        digest: ledgerPreview.digest,
        capability: 'service:provide:ledger',
        granted: true,
      },
    });
    expect(grantRes.statusCode).toBe(200);
    expect(daemon.pluginManager.host.status('user.custom-ledger')?.state).toBe('ACTIVE');

    // Install reader and grant session:read -> reads from third-party custom ledger!
    const readerPreview = await installTrustedDir(daemon, ledgerReaderDir);
    await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/user.ledger-reader/permissions',
      payload: {
        workspaceId: workspace.id,
        digest: readerPreview.digest,
        capability: 'session:read',
        granted: true,
      },
    });
    const readRes = await daemon.pluginManager.isolated!.runCommand(session, 'read-ledger', '');
    expect(readRes).toEqual({ kind: 'message', text: 'custom-ledger-objective' });

    // Revoke service:provide:ledger -> custom-ledger loses service and reader enters PENDING
    await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/user.custom-ledger/permissions',
      payload: {
        workspaceId: '__global__',
        digest: ledgerPreview.digest,
        capability: 'service:provide:ledger',
        granted: false,
      },
    });
    expect(daemon.pluginManager.host.status('user.custom-ledger')?.state).toBe('FAILED');
    expect(daemon.pluginManager.host.status('user.ledger-reader')?.state).toBe('PENDING');
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}, 25_000);

it('enforces V4 permissions, handoff/approval/tool hooks, coverFuture upgrades, and V3-to-V4 migration', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-perms-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-ws-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-p3-perm-src-'));
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'world-content');

  let daemon = createDaemon({ dataDir, port: 0 });
  const sessions: Array<{ config: AdapterSessionConfig; emit?: (event: NormalizedAdapterEvent) => void }> = [];
  const stubAdapter = () => {
    const adapter = daemon.registry.get('codex')!;
    adapter.createSession = async (config) => {
      const entry: typeof sessions[number] = { config };
      sessions.push(entry);
      return {
        nativeSessionId: 'p3-thread',
        pluginMcpAvailable: Boolean(config.pluginMcp),
        onEvent(listener) { entry.emit = listener; return () => { entry.emit = undefined; }; },
        async sendTurn({ turnId }) { entry.emit?.({ type: 'turn.started', turnId }); },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
      };
    };
  };

  try {
    await daemon.start();
    stubAdapter();
    const workspace = await daemon.sessionManager.addWorkspace(workspaceDir);
    const session = await daemon.sessionManager.createSession({ workspaceId: workspace.id, harnessId: 'codex', permissionMode: 'manual' });

    const suiteManifestV1 = {
      id: 'user.full-v4',
      name: 'Full V4 Suite',
      version: '1.0.0',
      description: 'Exercises V4 permissions, tools, handoff, approvals, storage, fs',
      apiVersion: 4,
      engines: { pluginApi: '^4.0' },
      main: 'index.mjs',
      permissions: [
        'storage:plugin',
        'fs:workspace:read',
        'handoff:section',
        'approvals:annotate',
        'session:read',
        'tools:model',
      ],
      contributes: {
        commands: [
          { command: 'read-ws', description: 'Read workspace file' },
          { command: 'kv-roundtrip', description: 'Test plugin storage' },
        ],
      },
    };
    const suiteCode = `export function apply(ctx) {
      ctx.commands.register('read-ws', async ({ workspaceId, args }) => {
        const text = await ctx.fs.read(workspaceId, args);
        return { kind: 'message', text };
      });
      ctx.commands.register('kv-roundtrip', async ({ args }) => {
        await ctx.storage.plugin.set('greeting', args);
        const value = await ctx.storage.plugin.get('greeting');
        return { kind: 'message', text: String(value) };
      });
      ctx.handoff.onCompose((event) => ({
        id: 'notes',
        order: 600,
        text: 'Plugin handoff note for ' + event.targetHarnessId,
      }));
      ctx.handoff.onShouldOffer((event) => {
        if (event.reason === 'rate_limit') return { offer: true, targetHarnessId: 'claude', reason: 'quota exhausted' };
      });
      ctx.approvals.onAnnotate((event) => ({
        risk: 'high',
        label: '审查提醒',
        detail: 'Observed tool ' + event.toolName,
      }));
      ctx.tools.register({
        name: 'sum_pair',
        description: 'Adds two numbers',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
        handler: ({ a, b }) => String(Number(a) + Number(b)),
      });
    }`;

    const suiteDirV1 = writePluginDir(staging, 'full-v4-v1', suiteManifestV1, suiteCode);
    const previewV1 = await installTrustedDir(daemon, suiteDirV1);

    // 1. Unauthorized calls fail with E_PERMISSION_DENIED
    await expect(
      daemon.pluginManager.isolated!.runCommand(session, 'read-ws', 'hello.txt'),
    ).rejects.toMatchObject({ code: 'E_PERMISSION_DENIED' });
    await expect(
      daemon.pluginManager.isolated!.runCommand(session, 'kv-roundtrip', 'hi'),
    ).rejects.toMatchObject({ code: 'E_PERMISSION_DENIED' });

    // Grant all declared permissions WITH coverFuture: true
    for (const capability of suiteManifestV1.permissions) {
      const res = await daemon.app.inject({
        method: 'PUT',
        url: '/api/v1/plugins/user.full-v4/permissions',
        payload: { workspaceId: workspace.id, digest: previewV1.digest, capability, granted: true, coverFuture: true },
      });
      expect(res.statusCode).toBe(200);
    }

    // 2. Authorized calls succeed; workspace traversal still denied
    expect(await daemon.pluginManager.isolated!.runCommand(session, 'read-ws', 'hello.txt'))
      .toEqual({ kind: 'message', text: 'world-content' });
    await expect(
      daemon.pluginManager.isolated!.runCommand(session, 'read-ws', '../escape.txt'),
    ).rejects.toMatchObject({ code: 'E_PERMISSION_DENIED' });
    expect(await daemon.pluginManager.isolated!.runCommand(session, 'kv-roundtrip', 'persisted-val'))
      .toEqual({ kind: 'message', text: 'persisted-val' });

    // 3. Handoff compose appends plugin section without altering core sections
    daemon.store.appendEvent(session.id, 'message.user', { text: 'Prior Codex turn', harnessId: 'codex' }, 'turn_prior');
    daemon.store.appendEvent(session.id, 'message.assistant.completed', { text: 'Done on Codex', harnessId: 'codex' }, 'turn_prior');
    const preview = await daemon.sessionManager.getContextPreview(session.id, 'agy');
    expect(preview.compiledMarkdown).toContain('Plugin handoff note for agy');
    expect(preview.compiledMarkdown).toContain('Workspace Truth Anchor');

    // 4. Approval annotate adds note without resolving approval + handoff.shouldOffer bail
    const approval = daemon.store.createApproval({
      id: 'appr_p3_test',
      sessionId: session.id,
      nativeRequestId: 'nat_1',
      toolName: 'bash',
      toolKind: 'command',
      summary: 'rm -rf build',
      input: { cmd: 'rm -rf build' },
      riskLevel: 'high',
      status: 'pending',
      resolvedBy: null,
      decision: null,
      comment: null,
      createdAt: Date.now(),
      resolvedAt: null,
    });
    const annotated = await daemon.sessionManager.annotatePendingApproval(session, approval);
    expect(annotated?.status).toBe('pending');
    expect(annotated?.annotations).toEqual([
      expect.objectContaining({ pluginId: 'user.full-v4', risk: 'high', label: '审查提醒', detail: 'Observed tool bash' }),
    ]);

    const offer = await daemon.sessionManager.evaluateHandoffOffer(session, 'codex', '429 rate_limit exceeded');
    expect(offer).toEqual({ offer: true, targetHarnessId: 'claude', reason: 'quota exhausted' });

    // 5. Isolated V4 model tool works via official MCP lease with arbitrary JSON Schema
    const turn = await daemon.sessionManager.sendTurn(session.id, 'Call sum tool');
    const mcpConn = sessions[0]?.config.pluginMcp;
    expect(mcpConn).toBeDefined();
    const listRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-tools',
      headers: { authorization: `Bearer ${mcpConn!.token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const tools = listRes.json().result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema.required).toEqual(['a', 'b']);

    const callRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugin-tools',
      headers: { authorization: `Bearer ${mcpConn!.token}` },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tools[0].name, arguments: { a: 19, b: 23 } } },
    });
    expect(callRes.json().result.content).toEqual([{ type: 'text', text: '42' }]);
    sessions[0]?.emit?.({ type: 'turn.cancelled', turnId: turn.turnId });

    // 6. Host restart (upgrade simulation) preserves grants
    await daemon.stop();
    daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    const postRestartSession = daemon.store.getSession(session.id)!;
    expect(await daemon.pluginManager.isolated!.runCommand(postRestartSession, 'read-ws', 'hello.txt'))
      .toEqual({ kind: 'message', text: 'world-content' });

    // 7. Upgrade v1.0.0 -> v1.1.0 with SAME permissions: coverFuture automatically carries grants over!
    const suiteDirV2 = writePluginDir(
      staging,
      'full-v4-v2',
      { ...suiteManifestV1, version: '1.1.0' },
      suiteCode + '\n// v1.1.0\n',
    );
    await installTrustedDir(daemon, suiteDirV2);
    expect(await daemon.pluginManager.isolated!.runCommand(postRestartSession, 'read-ws', 'hello.txt'))
      .toEqual({ kind: 'message', text: 'world-content' });

    // 8. Upgrade v1.1.0 -> v1.2.0 adding a NEW permission (fs:workspace:write): coverFuture must NOT carry over!
    const suiteDirV3 = writePluginDir(
      staging,
      'full-v4-v3',
      {
        ...suiteManifestV1,
        version: '1.2.0',
        permissions: [...suiteManifestV1.permissions, 'fs:workspace:write'],
      },
      suiteCode + '\n// v1.2.0\n',
    );
    await installTrustedDir(daemon, suiteDirV3);
    await expect(
      daemon.pluginManager.isolated!.runCommand(postRestartSession, 'read-ws', 'hello.txt'),
    ).rejects.toMatchObject({ code: 'E_PERMISSION_DENIED' });

    // 9. V3 -> V4 authorization migration (tool:* with coverFuture migrates to tools:model)
    const v3Manifest = {
      id: 'user.migrated-tool',
      name: 'Migrated Tool',
      version: '1.0.0',
      apiVersion: 3,
      description: 'V3 tool plugin',
      contributes: {
        programs: [{ id: 'trimmer', description: 'Trim text', steps: [{ op: 'trim' }], exposeToModel: true }],
      },
    };
    const v3Install = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { mode: 'manifest', manifest: v3Manifest },
    });
    expect(v3Install.statusCode).toBe(201);
    const v3Digest = daemon.pluginManager.listInstalled().find(({ id }) => id === 'user.migrated-tool')!.packageDigest!;
    const v3Grant = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/plugins/user.migrated-tool/permissions',
      payload: { workspaceId: workspace.id, digest: v3Digest, capability: 'tool:trimmer', granted: true, coverFuture: true },
    });
    expect(v3Grant.statusCode).toBe(200);

    // Upgrade same plugin ID to V4 declaring `tools:model`
    const v4MigratedDir = writePluginDir(
      staging,
      'migrated-v4',
      {
        id: 'user.migrated-tool',
        name: 'Migrated Tool',
        version: '2.0.0',
        apiVersion: 4,
        engines: { pluginApi: '^4.0' },
        description: 'Upgraded V4 tool plugin',
        main: 'index.mjs',
        permissions: ['tools:model'],
      },
      `export function apply(ctx) {
         ctx.tools.register({
           name: 'trimmer',
           description: 'Trim text',
           inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
           handler: ({ text }) => String(text).trim(),
         });
       }`,
    );
    await installTrustedDir(daemon, v4MigratedDir);
    const migratedPerms = await daemon.app.inject(`/api/v1/plugins/user.migrated-tool/permissions?workspaceId=${workspace.id}`);
    expect(migratedPerms.json().permissions).toEqual([
      expect.objectContaining({ capability: 'tools:model', granted: true, inheritedFromDigest: v3Digest }),
    ]);
  } finally {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}, 30_000);
