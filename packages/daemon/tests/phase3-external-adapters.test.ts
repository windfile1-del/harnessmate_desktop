import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SANDBOX_IFRAME_CSP } from '../src/plugins/plugin-ui.js';
import type { AdapterSessionHandle, HarnessAdapter } from '../src/harnesses/types.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const DEEPSEEK_PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'hm-adapter-deepseek');
const OPENCODE_PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'hm-adapter-opencode');

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch {
      // Best-effort test resource cleanup
    }
  }
});

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 80 });
  } catch {
    // Best-effort cleanup on Windows transient handles
  }
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => safeRmSync(dir));
  return dir;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 8_000, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function installShim(binDir: string, commandName: string, scriptContent: string): string {
  const scriptPath = path.join(binDir, `${commandName}.impl.mjs`);
  fs.writeFileSync(scriptPath, scriptContent, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, `${commandName}.cmd`);
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = path.join(binDir, commandName);
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return shPath;
}

function withPrependedPath(binDir: string): () => void {
  const pathKey = process.platform === 'win32'
    ? (Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path')
    : 'PATH';
  const prev = process.env[pathKey];
  process.env[pathKey] = prev ? `${binDir}${path.delimiter}${prev}` : binDir;
  return () => {
    if (prev === undefined) delete process.env[pathKey];
    else process.env[pathKey] = prev;
  };
}

async function installAndGrantPlugin(
  daemon: DaemonInstance,
  dirPath: string,
  capabilities: string[],
  workspaceId?: string,
) {
  const preview = daemon.pluginManager.previewInstall({ mode: 'local_dir', dirPath });
  expect(preview.requiresTrust).toBe(true);
  await daemon.pluginManager.installPlugin({
    mode: 'local_dir',
    dirPath,
    trustCode: true,
    expectedDigest: preview.digest,
    expectedInstalledDigest: preview.installedDigest,
  });
  for (const capability of capabilities) {
    const res = await daemon.app.inject({
      method: 'PUT',
      url: `/api/v1/plugins/${preview.manifest.id}/permissions`,
      payload: {
        workspaceId: '__global__',
        digest: preview.digest,
        capability,
        granted: true,
      },
    });
    expect(res.statusCode).toBe(200);
    if (workspaceId && (capability.startsWith('process:') || capability.startsWith('net:'))) {
      const wsRes = await daemon.app.inject({
        method: 'PUT',
        url: `/api/v1/plugins/${preview.manifest.id}/permissions`,
        payload: {
          workspaceId,
          digest: preview.digest,
          capability,
          granted: true,
        },
      });
      expect(wsRes.statusCode).toBe(200);
    }
  }
  return preview;
}

function createScriptedBuiltinAdapter(opts: {
  id: string;
  kind: 'codex' | 'claude';
  supportsNativeFork?: boolean;
  largeToolOutput?: string;
}): {
  adapter: HarnessAdapter;
  receivedInputs: Array<{ text: string; contextSyncText?: string | null; injectedItemsCount?: number }>;
} {
  const receivedInputs: Array<{ text: string; contextSyncText?: string | null; injectedItemsCount?: number }> = [];
  let seq = 0;

  const adapter: HarnessAdapter = {
    id: opts.id,
    kind: opts.kind,
    driverId: opts.id,
    displayName: opts.kind === 'codex' ? 'Mock Codex' : 'Mock Claude',
    description: 'Scripted handoff partner adapter',
    protocolLabel: 'mock-builtin',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium', 'high'],
      permissionModes: ['manual', 'accept_edits', 'auto'],
      sessionResume: true,
      sessionFork: Boolean(opts.supportsNativeFork),
      imageInput: false,
      subagents: false,
    },
    capabilitiesV2: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium', 'high'],
      permissionModes: ['manual', 'accept_edits', 'auto'],
      sessionResume: true,
      sessionFork: Boolean(opts.supportsNativeFork),
      imageInput: false,
      subagents: false,
      transport: opts.kind === 'codex' ? 'jsonrpc_stdio' : 'stream_json',
      historyInjectionMode: opts.kind === 'codex' ? 'native_items' : 'sysfile_delta',
      supportsNativeRollback: opts.kind === 'codex',
      supportsNativeFork: Boolean(opts.supportsNativeFork),
      supportsActiveSteering: false,
      supportsUsageLimits: false,
      supportsDynamicOptions: false,
      nativeCommands: [],
      optionDescriptors: [],
    },
    async probe() {
      return {
        id: opts.id,
        kind: opts.kind,
        driverId: opts.id,
        instanceId: opts.id,
        displayName: this.displayName,
        description: this.description,
        protocolLabel: this.protocolLabel,
        binaryPath: null,
        version: '1.0.0',
        health: 'ready',
        capabilities: this.capabilities,
        capabilitiesV2: this.capabilitiesV2,
        models: [{ id: `${opts.kind}-default`, displayName: `${opts.kind} Default`, isDefault: true }],
      };
    },
    async createSession(): Promise<AdapterSessionHandle> {
      const listeners = new Set<(ev: import('../src/harnesses/types.js').NormalizedAdapterEvent) => void>();
      const nativeId = `${opts.kind}_nat_${++seq}`;
      const emit = (ev: import('../src/harnesses/types.js').NormalizedAdapterEvent) => {
        for (const fn of [...listeners]) fn(ev);
      };
      return {
        nativeSessionId: nativeId,
        onEvent(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        ...(opts.kind === 'codex'
          ? {
              async injectContext(payload) {
                receivedInputs.push({
                  text: '[injectContext]',
                  injectedItemsCount: payload.portableItems.length,
                });
                payload.onDispatch?.('codex_inject_items', payload.portableItems);
                return 'codex_inject_items' as const;
              },
            }
          : {}),
        async sendTurn(input) {
          emit({ type: 'native_session_ready', nativeSessionId: nativeId });
          emit({ type: 'turn.started', turnId: input.turnId });
          const syncText = input.contextSync?.deltaMarkdown ?? null;
          if (syncText) {
            input.contextSync?.onDispatch?.(
              opts.kind === 'claude' ? 'claude_sysfile_delta' : 'prompt_envelope',
              syncText,
            );
          }
          receivedInputs.push({ text: input.text, contextSyncText: syncText });

          if (opts.largeToolOutput) {
            emit({
              type: 'tool.call.started',
              turnId: input.turnId,
              toolCallId: `tool_large_${input.turnId}`,
              toolName: 'read_log',
              toolKind: 'other',
              summary: 'Read verbose build output',
            });
            emit({
              type: 'tool.call.completed',
              turnId: input.turnId,
              toolCallId: `tool_large_${input.turnId}`,
              toolName: 'read_log',
              status: 'success',
              output: opts.largeToolOutput,
            });
          }

          emit({
            type: 'message.assistant.completed',
            turnId: input.turnId,
            text: `${opts.kind.toUpperCase()} ACK: ${input.text}`,
          });
          emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'end_turn' });
          return {
            driverUsed: input.contextSync
              ? (opts.kind === 'claude' ? 'claude_sysfile_delta' : 'prompt_envelope')
              : undefined,
          };
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() { listeners.clear(); },
      };
    },
  };

  return { adapter, receivedInputs };
}

function startHttpServer(handler: http.RequestListener): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      cleanups.push(
        () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      );
      resolve({ server, baseUrl });
    });
  });
}

describe('Phase 3 Step 1: External Non-ACP Harness Adapters (DeepSeek & OpenCode)', () => {
  it('hm.adapter.deepseek: runs under --permission sandbox, strips host secrets, supports CLI stdio + reasoning_budget block, blocks native rollback, and degrades cleanly after uninstall', async () => {
    const prevLocalToken = process.env.HARNESSMATE_LOCAL_TOKEN;
    const prevSecretCanary = process.env.SECRET_HOST_API_KEY;
    process.env.HARNESSMATE_LOCAL_TOKEN = 'HOST_CANARY_TOKEN_DO_NOT_LEAK';
    process.env.SECRET_HOST_API_KEY = 'HOST_CANARY_KEY_DO_NOT_LEAK';
    cleanups.push(() => {
      if (prevLocalToken === undefined) delete process.env.HARNESSMATE_LOCAL_TOKEN;
      else process.env.HARNESSMATE_LOCAL_TOKEN = prevLocalToken;
      if (prevSecretCanary === undefined) delete process.env.SECRET_HOST_API_KEY;
      else process.env.SECRET_HOST_API_KEY = prevSecretCanary;
    });

    const dataDir = makeTempDir('hm-p3-ds-data-');
    const wsDir = makeTempDir('hm-p3-ds-ws-');
    const binDir = makeTempDir('hm-p3-ds-bin-');
    cleanups.push(withPrependedPath(binDir));

    // Initialize real Git workspace so checkpoint guard & files_only restore run end-to-end
    execFileSync('git', ['init'], { cwd: wsDir, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@harnessmate.local'], { cwd: wsDir, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wsDir, windowsHide: true });
    fs.writeFileSync(path.join(wsDir, 'tracked.txt'), 'INITIAL_STATE\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: wsDir, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: wsDir, windowsHide: true });

    const leakedEnvFile = path.join(binDir, 'cli-env.json');
    const capturedTurnsFile = path.join(binDir, 'cli-turns.json');
    installShim(
      binDir,
      'deepseek-code',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      if (process.argv.includes('--version')) {
        console.log('deepseek-code 0.9.1');
        process.exit(0);
      }
      fs.writeFileSync(${JSON.stringify(leakedEnvFile)}, JSON.stringify(process.env), 'utf8');
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.type === 'user_turn') {
          fs.writeFileSync(${JSON.stringify(capturedTurnsFile)}, JSON.stringify(msg), 'utf8');
          // Modify tracked file during turn so checkpoint captures diff
          fs.writeFileSync(${JSON.stringify(path.join(wsDir, 'tracked.txt'))}, 'MODIFIED_BY_DEEPSEEK\\n', 'utf8');
          console.log(JSON.stringify({ type: 'native_session_ready', nativeSessionId: 'ds_cli_sess_1' }));
          console.log(JSON.stringify({ type: 'model.confirmed', actualModel: msg.model || 'deepseek-reasoner' }));
          console.log(JSON.stringify({ type: 'thinking.delta', text: 'Step 1: check config...' }));
          console.log(JSON.stringify({ type: 'thinking.completed', text: 'Step 1: check config...' }));
          console.log(JSON.stringify({ type: 'message.assistant.delta', text: 'CLI answer with budget=' }));
          console.log(JSON.stringify({ type: 'message.assistant.completed', text: 'CLI answer with budget=' + msg.turnOptions?.reasoningBudget }));
          console.log(JSON.stringify({ type: 'usage.updated', usage: { inputTokens: 120, outputTokens: 48, reasoningTokens: 4096 } }));
          console.log(JSON.stringify({ type: 'turn.completed', stopReason: 'end_turn' }));
        }
      });
      `,
    );

    const daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    cleanups.push(() => daemon.stop());

    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'DeepSeekRepo');
    await installAndGrantPlugin(
      daemon,
      DEEPSEEK_PLUGIN_DIR,
      [
        'harness:driver:register',
        'process:spawn:deepseek-code',
        'net:127.0.0.1',
        'net:api.deepseek.com',
        'secrets:read:deepseek',
        'storage:plugin',
      ],
      ws.id,
    );

    const adapter = daemon.registry.get('deepseek');
    expect(adapter).toBeDefined();
    expect(adapter!.isCustom).toBe(true);
    expect(adapter!.capabilitiesV2).toMatchObject({
      historyInjectionMode: 'inline',
      supportsNativeRollback: false,
      supportsDynamicOptions: true,
    });
    expect(adapter!.presentation).toMatchObject({
      shortLabel: 'DeepSeek',
      accentColor: '#4D6BFE',
    });

    // Strict CSP HTML slots served cleanly
    const blockDoc = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/plugins/hm.adapter.deepseek/ui-doc?path=ui/reasoning-card.html',
    });
    expect(blockDoc.statusCode).toBe(200);
    expect(blockDoc.json().csp).toBe(SANDBOX_IFRAME_CSP);

    // Switch plugin to CLI mode via settings slot message
    const runId = daemon.pluginManager.isolated?.getRunId('hm.adapter.deepseek');
    const saveRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/hm.adapter.deepseek/ui-message',
      payload: {
        slotId: 'deepseek-settings',
        slot: 'harness.settings',
        runId,
        payload: { action: 'saveConfig', config: { mode: 'cli', cliCommand: 'deepseek-code', contextWindowTokens: 64_000 } },
      },
    });
    expect(saveRes.statusCode).toBe(200);

    const probed = await adapter!.probe();
    expect(probed.health).toBe('ready');
    expect(probed.version).toContain('0.9.1');

    const session = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'deepseek',
      model: 'deepseek-reasoner',
      permissionMode: 'manual',
    });

    await daemon.sessionManager.sendTurn(session.id, 'Analyze workspace safely', [], {
      turnOptions: { reasoningBudget: 'high', deepThink: true },
    });
    await waitFor(() => daemon.store.getSession(session.id)?.status === 'idle');

    // Verify CLI subprocess never inherited host daemon secrets
    const cliEnv = JSON.parse(fs.readFileSync(leakedEnvFile, 'utf8'));
    expect(cliEnv.HARNESSMATE_LOCAL_TOKEN).toBeUndefined();
    expect(cliEnv.SECRET_HOST_API_KEY).toBeUndefined();

    // Verify dynamic Traits option forwarding
    const recordedMsg = JSON.parse(fs.readFileSync(capturedTurnsFile, 'utf8'));
    expect(recordedMsg.turnOptions).toEqual({ reasoningBudget: 'high', deepThink: true });

    // Verify honest 64K modelContextWindow propagation and ext:deepseek.reasoning_budget TurnBlock
    const updatedSession = daemon.store.getSession(session.id)!;
    expect(updatedSession.usage?.modelContextWindow).toBe(64_000);

    const items = daemon.sessionManager.getSessionTurnItems(session.id);
    const budgetBlock = items.find((i) => i.blockType === 'ext:deepseek.reasoning_budget');
    expect(budgetBlock).toBeDefined();
    expect(budgetBlock!.payload).toMatchObject({
      reasoningBudget: 'high',
      budgetLimitTokens: 32_768,
      reasoningTokens: 4096,
      deepThink: true,
    });
    expect(budgetBlock!.textBody).toContain('Budget=high');

    // Checkpoint revert guard MUST refuse native_and_files without touching disk when supportsNativeRollback === false
    await waitFor(() => daemon.sessionManager.listSessionCheckpoints(session.id).length > 0);
    const checkpoints = daemon.sessionManager.listSessionCheckpoints(session.id);
    const preCheckpoint = checkpoints.find((c) => c.phase === 'turn_pre') ?? checkpoints[0]!;
    await expect(
      daemon.sessionManager.revertSessionCheckpoint(session.id, {
        checkpointId: preCheckpoint.checkpointId,
        mode: 'native_and_files',
      }),
    ).rejects.toThrow(/不支持原生对话回滚|E_NATIVE_ROLLBACK_UNSUPPORTED/);
    expect(fs.readFileSync(path.join(wsDir, 'tracked.txt'), 'utf8')).toContain('MODIFIED_BY_DEEPSEEK');

    // Explicit files_only revert restores disk safely
    const reverted = await daemon.sessionManager.revertSessionCheckpoint(session.id, {
      checkpointId: preCheckpoint.checkpointId,
      mode: 'files_only',
    });
    expect(reverted.modeUsed).toBe('files_only');
    expect(reverted.nativeRolledBack).toBe(false);
    expect(reverted.filesRestored).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(wsDir, 'tracked.txt'), 'utf8')).toBe('INITIAL_STATE\n');

    // Uninstalling plugin removes driver cleanly while historical ext:deepseek.reasoning_budget remains readable
    await daemon.pluginManager.uninstallPlugin('hm.adapter.deepseek');
    expect(daemon.registry.get('deepseek')).toBeUndefined();
    const persistedItemsAfterUninstall = daemon.sessionManager.getSessionTurnItems(session.id);
    expect(persistedItemsAfterUninstall.some((i) => i.blockType === 'ext:deepseek.reasoning_budget' && i.textBody.includes('Budget=high'))).toBe(true);
  }, 60_000);

  it('hm.adapter.deepseek: supports API SSE mode, maps HTTP 429 to usage_limit Failover, settles mid-turn crash, and executes Codex -> DeepSeek -> Claude handoff', async () => {
    const dataDir = makeTempDir('hm-p3-ds-api-data-');
    const wsDir = makeTempDir('hm-p3-ds-api-ws-');
    const apiSecret = 'sk-deepseek-ultra-secret-value-42';

    let mode: 'rate_limit' | 'stream_ok' | 'hang_mid_turn' = 'stream_ok';
    const seenAuths: string[] = [];
    const seenPrompts: string[] = [];
    let activeHungRes: http.ServerResponse | null = null;

    const { baseUrl } = await startHttpServer((req, res) => {
      if (req.url === '/v1/models') {
        seenAuths.push(String(req.headers.authorization || ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        seenAuths.push(String(req.headers.authorization || ''));
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          const lastUser = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
          seenPrompts.push(String(lastUser));

          if (mode === 'rate_limit') {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': '120',
            });
            res.end(JSON.stringify({ error: { message: `Rate limited for token Bearer ${apiSecret}` } }));
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          if (mode === 'hang_mid_turn') {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Working before crash...' } }] })}\n\n`);
            activeHungRes = res;
            return;
          }
          res.write(`data: ${JSON.stringify({ model: 'deepseek-reasoner', choices: [{ delta: { reasoning_content: 'Deep thought chain' } }] })}\n\n`);
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'DeepSeek SSE complete' }, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 24, prompt_cache_hit_tokens: 30, completion_tokens_details: { reasoning_tokens: 2048 } } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }, 25);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const codexMock = createScriptedBuiltinAdapter({ id: 'mock-codex', kind: 'codex' });
    const claudeMock = createScriptedBuiltinAdapter({ id: 'mock-claude', kind: 'claude' });
    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [codexMock.adapter, claudeMock.adapter],
      pluginCrashPolicy: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    await daemon.start();
    cleanups.push(() => {
      activeHungRes?.end();
      return daemon.stop();
    });

    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'DeepSeekApiRepo');
    daemon.pluginSecrets.set('deepseek:api_key', apiSecret);

    await installAndGrantPlugin(
      daemon,
      DEEPSEEK_PLUGIN_DIR,
      ['harness:driver:register', 'process:spawn:deepseek-code', 'net:127.0.0.1', 'secrets:read:deepseek', 'storage:plugin'],
      ws.id,
    );

    const runId = daemon.pluginManager.isolated?.getRunId('hm.adapter.deepseek');
    await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/plugins/hm.adapter.deepseek/ui-message',
      payload: {
        slotId: 'deepseek-settings',
        slot: 'harness.settings',
        runId,
        payload: {
          action: 'saveConfig',
          config: {
            mode: 'api_compatible',
            apiBaseUrl: baseUrl,
            apiKeyRef: { secretRef: 'deepseek:api_key' },
          },
        },
      },
    });

    const probed = await daemon.registry.get('deepseek')!.probe();
    expect(probed.health).toBe('ready');
    expect(seenAuths[0]).toBe(`Bearer ${apiSecret}`);

    // 1. HTTP 429 -> usage_limit + resetAt Failover cooldown
    mode = 'rate_limit';
    const rlSession = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'deepseek', permissionMode: 'manual' });
    await daemon.sessionManager.sendTurn(rlSession.id, 'Trigger 429');
    await waitFor(() => daemon.store.getSession(rlSession.id)?.status === 'error');
    const rlEvents = daemon.store.getEventsAfter(rlSession.id, 0, 50);
    const failedEv = rlEvents.find((e) => e.type === 'turn.failed');
    expect(failedEv).toBeDefined();
    expect(failedEv!.payload.failureClass).toBe('usage_limit');
    expect(Number(failedEv!.payload.resetsAt)).toBeGreaterThan(Date.now());
    expect(String(failedEv!.payload.message)).not.toContain(apiSecret);

    // Clear failover cooldown so DeepSeek can accept next test turns
    const failoverSvc = daemon.pluginManager.host.get<{ clearCooldown(id: string): void }>('failover');
    failoverSvc?.clearCooldown('deepseek');

    // 2. Three-engine handoff: Codex -> DeepSeek -> Claude
    mode = 'stream_ok';
    const chainSession = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'mock-codex',
      permissionMode: 'manual',
    });
    await daemon.sessionManager.sendTurn(chainSession.id, 'Anchor phrase CRIMSON-COMPASS-77');
    await waitFor(() => daemon.store.getSession(chainSession.id)?.status === 'idle');

    const swDs = await daemon.sessionManager.switchHarness(chainSession.id, { targetHarnessId: 'deepseek' });
    expect(swDs.contextPreview.driverPlanned).toBe('prompt_envelope');
    await daemon.sessionManager.sendTurn(chainSession.id, 'Continue on DeepSeek');
    await waitFor(() => daemon.store.getSession(chainSession.id)?.status === 'idle');
    expect(seenPrompts.some((p) => p.includes('CRIMSON-COMPASS-77'))).toBe(true);

    const swClaude = await daemon.sessionManager.switchHarness(chainSession.id, { targetHarnessId: 'mock-claude' });
    expect(swClaude.contextPreview.unsyncedTurnCount).toBeGreaterThanOrEqual(1);
    await daemon.sessionManager.sendTurn(chainSession.id, 'Finalize on Claude');
    await waitFor(() => daemon.store.getSession(chainSession.id)?.status === 'idle');
    const claudeSync = claudeMock.receivedInputs.map((i) => i.contextSyncText || i.text).join('\n');
    expect(claudeSync).toContain('DeepSeek SSE complete');

    // 3. Simulated child crash mid-turn settles cleanly without leaving session stuck running
    mode = 'hang_mid_turn';
    const crashSession = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'deepseek', permissionMode: 'manual' });
    await daemon.sessionManager.sendTurn(crashSession.id, 'Long turn interrupted by crash');
    await waitFor(() => daemon.store.getSession(crashSession.id)?.status === 'running' && activeHungRes !== null);

    daemon.pluginManager.isolated?.getActive('hm.adapter.deepseek')?.process.forceKill();
    await waitFor(() => daemon.store.getSession(crashSession.id)?.status === 'error');
    const crashEvents = daemon.store.getEventsAfter(crashSession.id, 0, 50);
    expect(crashEvents.some((e) => e.type === 'turn.failed' && e.payload.failureClass === 'process_exit')).toBe(true);

    // Zero API secret leak across logs
    const logs = JSON.stringify(daemon.pluginManager.getLogs('hm.adapter.deepseek'));
    expect(logs).not.toContain(apiSecret);
  }, 30_000);

  it('hm.adapter.opencode: unit checks + managed_local strips OPENCODE_SERVER_PASSWORD, multiplexes workspaces on single process, and kills process tree on disable', async () => {
    const protocol = await import('../../../plugins/hm-adapter-opencode/lib/protocol.mjs');
    const envBuilt = protocol.buildServerEnvironment({ OPENCODE_SERVER_PASSWORD: 'stale-legacy-password', CUSTOM: 'keep' });
    expect(envBuilt.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(envBuilt.env.OPENCODE_PASSWORD).toBe(envBuilt.password);
    expect(Buffer.from(envBuilt.password, 'base64url').length).toBe(32);

    expect(() => protocol.validateServerInfoResponse(200, { 'content-type': 'text/html' }, '<html>OpenCode 1.x</html>'))
      .toThrow('The server is not an OpenCode 2 server.');
    expect(protocol.sanitizeOpenCodeError('Bearer orBasic opencode:topsecret123 failed topsecret123', ['topsecret123']))
      .not.toContain('topsecret123');
    const fallbackFrame = protocol.parseOpenCodeSseFrame(JSON.stringify({
      type: 'session.execution.succeeded',
      data: 'non-object-corrupt-payload',
      sessionID: 'sess_xyz',
    }));
    expect(fallbackFrame).toMatchObject({ kind: 'unreadable.execution.ended', sessionID: 'sess_xyz', inferredStatus: 'completed' });
    expect(protocol.validateImageJobPayload({ mimeType: 'image/svg+xml', sizeBytes: 100 }).ok).toBe(false);
    expect(protocol.validateImageJobPayload({ mimeType: 'image/png', sizeBytes: 1024, fileName: 'out.png' }).ok).toBe(true);

    // Managed local mode E2E with real spawned HTTP+SSE server shim
    const prevLegacyEnv = process.env.OPENCODE_SERVER_PASSWORD;
    process.env.OPENCODE_SERVER_PASSWORD = 'HOST_LEGACY_SERVER_PASSWORD_V1';
    cleanups.push(() => {
      if (prevLegacyEnv === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = prevLegacyEnv;
    });

    const dataDir = makeTempDir('hm-p3-oc-loc-data-');
    const wsDirA = makeTempDir('hm-p3-oc-loc-wsA-');
    const wsDirB = makeTempDir('hm-p3-oc-loc-wsB-');
    const binDir = makeTempDir('hm-p3-oc-loc-bin-');
    cleanups.push(withPrependedPath(binDir));

    const envLogFile = path.join(binDir, 'serve-starts.json');
    installShim(
      binDir,
      'opencode',
      `
      import fs from 'node:fs';
      import http from 'node:http';
      if (process.argv.includes('--version')) {
        console.log('opencode 2.4.0');
        process.exit(0);
      }
      const prevStarts = fs.existsSync(${JSON.stringify(envLogFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(envLogFile)}, 'utf8')) : [];
      prevStarts.push({
        pid: process.pid,
        hasLegacy: Object.prototype.hasOwnProperty.call(process.env, 'OPENCODE_SERVER_PASSWORD'),
        passwordLen: (process.env.OPENCODE_PASSWORD || '').length,
      });
      fs.writeFileSync(${JSON.stringify(envLogFile)}, JSON.stringify(prevStarts), 'utf8');

      const expectedAuth = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_PASSWORD || '')).toString('base64');
      const subscribers = new Map();
      const sessions = new Map();
      let sessCounter = 0;

      const emitSse = (sid, payload) => {
        const res = subscribers.get(sid);
        if (res) res.write('data: ' + JSON.stringify(payload) + '\\n\\n');
      };

      const server = http.createServer((req, res) => {
        if (req.headers.authorization !== expectedAuth) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/server/info') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: '2.4.0', apiVersion: 2 }));
          return;
        }
        if (url.pathname === '/usage/limits') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            loggedIn: true,
            accountLabel: 'OpenCode Local v2',
            planType: 'local',
            authMethod: 'managed_local',
            billingTier: 'local_free',
            rateLimits: [{ label: 'Session Window', usedPercent: 12, windowMinutes: 60 }],
          }));
          return;
        }
        if (url.pathname === '/sessions' && req.method === 'POST') {
          let b = '';
          req.on('data', (c) => { b += c; });
          req.on('end', () => {
            const parsed = JSON.parse(b || '{}');
            const sid = 'oc_nat_' + (++sessCounter);
            sessions.set(sid, parsed.directory);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionID: sid }));
          });
          return;
        }
        if (url.pathname === '/events') {
          const sid = url.searchParams.get('sessionID') || '';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write(': connected\\n\\n');
          subscribers.set(sid, res);
          req.on('close', () => {
            if (subscribers.get(sid) === res) subscribers.delete(sid);
          });
          return;
        }
        const turnMatch = /^\\/sessions\\/([^/]+)\\/turns$/.exec(url.pathname);
        if (turnMatch && req.method === 'POST') {
          const sid = decodeURIComponent(turnMatch[1]);
          let b = '';
          req.on('data', (c) => { b += c; });
          req.on('end', () => {
            const body = JSON.parse(b || '{}');
            const dir = sessions.get(sid);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accepted: true }));
            setTimeout(() => {
              emitSse(sid, { type: 'shell.job.output', data: { sessionID: sid, toolCallId: 'sh_' + sid, chunk: 'stdout from ' + dir + '\\n', stream: 'stdout' } });
              emitSse(sid, {
                type: 'image.job.updated',
                data: { sessionID: sid, jobId: 'img_' + sid, title: 'Generated Diagram', mimeType: 'image/png', fileName: 'diagram.png', sizeBytes: 128, prompt: body.prompt },
              });
              emitSse(sid, { type: 'message.delta', data: { sessionID: sid, text: 'REPLY[' + dir + '] ' + body.prompt } });
              emitSse(sid, { type: 'message.completed', data: { sessionID: sid, text: 'REPLY[' + dir + '] ' + body.prompt } });
              emitSse(sid, { type: 'session.execution.succeeded', data: { sessionID: sid, stopReason: 'end_turn' } });
            }, 25);
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        console.log('OpenCode server listening at http://127.0.0.1:' + port);
      });
      `,
    );

    const daemon = createDaemon({ dataDir, port: 0 });
    await daemon.start();
    cleanups.push(() => daemon.stop());

    const wsA = await daemon.sessionManager.addWorkspace(wsDirA, 'WsAlpha');
    const wsB = await daemon.sessionManager.addWorkspace(wsDirB, 'WsBeta');

    await installAndGrantPlugin(
      daemon,
      OPENCODE_PLUGIN_DIR,
      ['harness:driver:register', 'process:spawn:opencode', 'net:127.0.0.1', 'secrets:read:opencode', 'storage:plugin'],
    );

    const adapter = daemon.registry.get('opencode');
    expect(adapter).toBeDefined();

    // Passive probe checks --version ONLY and must NOT start `opencode serve`
    const passive = await adapter!.probePassive!();
    expect(passive.health).toBe('ready');
    expect(passive.version).toContain('2.4.0');
    expect(fs.existsSync(envLogFile)).toBe(false);

    // Concurrent turns across TWO distinct workspaces share a SINGLE managed server with zero cross-talk
    const sessA = await daemon.sessionManager.createSession({ workspaceId: wsA.id, harnessId: 'opencode', permissionMode: 'manual' });
    const sessB = await daemon.sessionManager.createSession({ workspaceId: wsB.id, harnessId: 'opencode', permissionMode: 'manual' });

    await Promise.all([
      daemon.sessionManager.sendTurn(sessA.id, 'ALPHA_PROMPT'),
      daemon.sessionManager.sendTurn(sessB.id, 'BETA_PROMPT'),
    ]);

    await waitFor(
      () =>
        daemon.store.getSession(sessA.id)?.status === 'idle' &&
        daemon.store.getSession(sessB.id)?.status === 'idle',
    );

    const starts = JSON.parse(fs.readFileSync(envLogFile, 'utf8'));
    expect(starts).toHaveLength(1);
    expect(starts[0].hasLegacy).toBe(false);
    expect(starts[0].passwordLen).toBeGreaterThanOrEqual(40);
    const managedPid = starts[0].pid as number;
    expect(isPidAlive(managedPid)).toBe(true);

    const msgA = daemon.store.getEventsAfter(sessA.id, 0, 50).find((e) => e.type === 'message.assistant.completed');
    const msgB = daemon.store.getEventsAfter(sessB.id, 0, 50).find((e) => e.type === 'message.assistant.completed');
    expect(String(msgA?.payload.text)).toContain('ALPHA_PROMPT');
    expect(String(msgA?.payload.text)).not.toContain('BETA_PROMPT');
    expect(String(msgB?.payload.text)).toContain('BETA_PROMPT');
    expect(String(msgB?.payload.text)).not.toContain('ALPHA_PROMPT');

    // Extension image job block recorded
    const itemsA = daemon.sessionManager.getSessionTurnItems(sessA.id);
    expect(itemsA.some((i) => i.blockType === 'ext:opencode.image_job')).toBe(true);

    // `readUsageLimits()` wired through isolated driver proxy
    const usage = await adapter!.readUsageLimits!();
    expect(usage.loggedIn).toBe(true);
    expect(usage.rateLimits[0]?.label).toBe('Session Window');

    // Disabling plugin terminates managed child process cleanly (zero zombie server)
    await daemon.pluginManager.togglePlugin('hm.adapter.opencode', false);
    await waitFor(() => !isPidAlive(managedPid), 6_000);
    expect(isPidAlive(managedPid)).toBe(false);
  }, 35_000);

  it('hm.adapter.opencode: external_server validates 1.x HTML rejection, zero secret leaks on 401, Subscribe-Before-POST, silent stream reconciliation, unknown terminal fallback, survival on unload, and Codex <-> OpenCode handoff with hm_session_read', async () => {
    const extPassword = 'EXT_OC_PASSWORD_MUST_NOT_LEAK_9182';
    let scenario: 'v1_html' | 'ok' | 'silent_reconcile_ok' | 'silent_hang' | 'unreadable_terminal' = 'ok';
    const orderLog: string[] = [];
    const subscribers = new Map<string, http.ServerResponse>();
    const serverTurns = new Map<string, { status: string; text?: string }>();
    const receivedTurnPrompts: string[] = [];
    let sessSeq = 0;

    const { server, baseUrl } = await startHttpServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (scenario === 'v1_html' && url.pathname === '/server/info') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body>OpenCode 1.x Web UI</body></html>');
        return;
      }
      const expectedAuth = 'Basic ' + Buffer.from(`opencode:${extPassword}`).toString('base64');
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Rejected credential` }));
        return;
      }
      if (url.pathname === '/server/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '2.5.1', apiVersion: 2 }));
        return;
      }
      if (url.pathname === '/sessions' && req.method === 'POST') {
        const sid = `ext_sess_${++sessSeq}`;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionID: sid }));
        return;
      }
      if (url.pathname === '/events') {
        const sid = url.searchParams.get('sessionID') || '';
        orderLog.push(`SSE_OPEN:${sid}`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': ready\n\n');
        subscribers.set(sid, res);
        req.on('close', () => {
          if (subscribers.get(sid) === res) subscribers.delete(sid);
        });
        return;
      }
      const turnStatusMatch = /^\/sessions\/([^/]+)\/turns\/([^/]+)$/.exec(url.pathname);
      if (turnStatusMatch && req.method === 'GET') {
        const tid = decodeURIComponent(turnStatusMatch[2]);
        const st = serverTurns.get(tid) ?? { status: 'running' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(st));
        return;
      }
      const turnMatch = /^\/sessions\/([^/]+)\/turns$/.exec(url.pathname);
      if (turnMatch && req.method === 'POST') {
        const sid = decodeURIComponent(turnMatch[1]);
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => {
          const body = JSON.parse(b || '{}');
          orderLog.push(`POST_TURN:${sid}`);
          receivedTurnPrompts.push(String(body.prompt || ''));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true }));

          const sse = subscribers.get(sid);
          if (scenario === 'silent_reconcile_ok') {
            serverTurns.set(body.turnId, { status: 'completed', text: 'Reconciled result after silence' });
            return;
          }
          if (scenario === 'silent_hang') {
            serverTurns.set(body.turnId, { status: 'running' });
            return;
          }
          if (scenario === 'unreadable_terminal') {
            sse?.write(`data: ${JSON.stringify({ type: 'future.unknown.widget', data: { foo: 1 }, sessionID: sid })}\n\n`);
            sse?.write(`data: ${JSON.stringify({ type: 'message.delta', data: { sessionID: sid, text: 'Partial before unreadable terminal' } })}\n\n`);
            sse?.write(`data: ${JSON.stringify({ type: 'session.execution.succeeded', data: 'CORRUPT_V3_STRING', sessionID: sid })}\n\n`);
            return;
          }
          sse?.write(`data: ${JSON.stringify({ type: 'message.delta', data: { sessionID: sid, text: 'First SSE frame! ' } })}\n\n`);
          sse?.write(`data: ${JSON.stringify({ type: 'message.completed', data: { sessionID: sid, text: 'First SSE frame! Done.' } })}\n\n`);
          sse?.write(`data: ${JSON.stringify({ type: 'session.execution.succeeded', data: { sessionID: sid } })}\n\n`);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const dataDir = makeTempDir('hm-p3-oc-ext-data-');
    const wsDir = makeTempDir('hm-p3-oc-ext-ws-');
    const codexMock = createScriptedBuiltinAdapter({
      id: 'mock-codex',
      kind: 'codex',
      largeToolOutput: `HEADER_LINE\n${'X'.repeat(24_000)}\nOMITTED_SENTINEL_555`,
    });

    const daemon = createDaemon({ dataDir, port: 0, customAdapters: [codexMock.adapter] });
    await daemon.start();
    cleanups.push(() => daemon.stop());

    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'ExtOcRepo');
    await installAndGrantPlugin(
      daemon,
      OPENCODE_PLUGIN_DIR,
      ['harness:driver:register', 'process:spawn:opencode', 'net:127.0.0.1', 'secrets:read:opencode', 'storage:plugin'],
      ws.id,
    );

    const runId = daemon.pluginManager.isolated?.getRunId('hm.adapter.opencode');
    const configureExternal = async (silentStreamTimeoutMs = 45_000) => {
      await daemon.app.inject({
        method: 'POST',
        url: '/api/v1/plugins/hm.adapter.opencode/ui-message',
        payload: {
          slotId: 'opencode-settings',
          slot: 'harness.settings',
          runId,
          payload: {
            action: 'saveConfig',
            config: {
              mode: 'external_server',
              serverUrl: baseUrl,
              serverPasswordSecretRef: 'opencode:server_password',
              silentStreamTimeoutMs,
            },
          },
        },
      });
    };

    const adapter = daemon.registry.get('opencode')!;

    // 1. Wrong password -> sanitized error & ZERO plaintext secret in message or logs
    daemon.pluginSecrets.set('opencode:server_password', `WRONG_${extPassword}`);
    await configureExternal();
    const badAuthProbe = await adapter.probe();
    expect(badAuthProbe.health).toBe('unauthenticated');
    expect(badAuthProbe.healthMessage).toBe('The OpenCode server rejected the server password.');
    expect(badAuthProbe.healthMessage).not.toContain(extPassword);

    // 2. 1.x HTML pseudo-200 rejection
    scenario = 'v1_html';
    daemon.pluginSecrets.set('opencode:server_password', extPassword);
    const v1Probe = await adapter.probe();
    expect(v1Probe.health).toBe('unavailable');
    expect(v1Probe.healthMessage).toBe('The server is not an OpenCode 2 server.');

    // 3. Subscribe-Before-POST ordering on external 2.x server
    scenario = 'ok';
    const readyProbe = await adapter.probe();
    expect(readyProbe.health).toBe('ready');

    const sess = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'opencode', permissionMode: 'manual' });
    await daemon.sessionManager.sendTurn(sess.id, 'Verify Subscribe-Before-POST');
    await waitFor(() => daemon.store.getSession(sess.id)?.status === 'idle');
    expect(orderLog[0]).toMatch(/^SSE_OPEN:/);
    expect(orderLog[1]).toMatch(/^POST_TURN:/);
    const completedMsg = daemon.store.getEventsAfter(sess.id, 0, 50).find((e) => e.type === 'message.assistant.completed');
    expect(completedMsg?.payload.text).toBe('First SSE frame! Done.');

    // 4. Unreadable terminal SSE frame settles without hanging
    scenario = 'unreadable_terminal';
    await daemon.sessionManager.sendTurn(sess.id, 'Trigger unreadable terminal');
    await waitFor(() => daemon.store.getSession(sess.id)?.status === 'idle');
    const eventsAfterUnreadable = daemon.store.getEventsAfter(sess.id, 0, 100);
    expect(eventsAfterUnreadable.some((e) => e.type === 'message.assistant.completed' && e.payload.text === 'Partial before unreadable terminal')).toBe(true);

    // 5. Silent stream timeout -> reconciliation poll succeeds (Case A) and times out cleanly (Case B)
    await configureExternal(250);
    scenario = 'silent_reconcile_ok';
    await daemon.sessionManager.sendTurn(sess.id, 'Trigger silent reconcile ok');
    await waitFor(() => daemon.store.getSession(sess.id)?.status === 'idle');
    const reconciledText = daemon.store.getEventsAfter(sess.id, 0, 150)
      .filter((e) => e.type === 'message.assistant.completed')
      .map((e) => String(e.payload.text));
    expect(reconciledText).toContain('Reconciled result after silence');

    scenario = 'silent_hang';
    await daemon.sessionManager.sendTurn(sess.id, 'Trigger silent hang');
    await waitFor(() => daemon.store.getSession(sess.id)?.status === 'error');
    const silentFailEv = daemon.store.getEventsAfter(sess.id, 0, 200).find(
      (e) => e.type === 'turn.failed' && e.payload.failureClass === 'silent_stream',
    );
    expect(silentFailEv).toBeDefined();

    // 6. Bidirectional Codex <-> OpenCode cross-engine handoff (inline + hm_session_read verification)
    await configureExternal(45_000);
    scenario = 'ok';
    const biSess = await daemon.sessionManager.createSession({ workspaceId: ws.id, harnessId: 'mock-codex', permissionMode: 'manual' });
    await daemon.sessionManager.sendTurn(biSess.id, 'Generate huge output from Codex');
    await waitFor(() => daemon.store.getSession(biSess.id)?.status === 'idle');

    // Verify large TurnBlock exists with outputOmitted: true and slice retrieval works (same store used by hm_session_read)
    const omittedBlock = daemon.sessionManager.getSessionTurnItems(biSess.id).find((i) => i.outputOmitted);
    expect(omittedBlock).toBeDefined();
    const slice = daemon.sessionManager.getSessionTurnItemSlice(biSess.id, omittedBlock!.itemId, { textOffset: 24_000, maxChars: 1_000 });
    expect(slice?.text).toContain('OMITTED_SENTINEL_555');

    const swOc = await daemon.sessionManager.switchHarness(biSess.id, { targetHarnessId: 'opencode' });
    expect(swOc.contextPreview.driverPlanned).toBe('prompt_envelope');
    await daemon.sessionManager.sendTurn(biSess.id, 'OpenCode follow-up turn');
    await waitFor(() => daemon.store.getSession(biSess.id)?.status === 'idle');
    expect(receivedTurnPrompts.some((p) => p.includes('hm_session_read') && p.includes(omittedBlock!.itemId))).toBe(true);

    // Switch back from OpenCode -> Codex and verify bidirectional delta propagation
    const swBack = await daemon.sessionManager.switchHarness(biSess.id, { targetHarnessId: 'mock-codex' });
    expect(swBack.contextPreview.unsyncedTurnCount).toBeGreaterThanOrEqual(1);
    await daemon.sessionManager.sendTurn(biSess.id, 'Codex follow-up after OpenCode');
    await waitFor(() => daemon.store.getSession(biSess.id)?.status === 'idle');
    expect(codexMock.receivedInputs.some((i) => (i.injectedItemsCount ?? 0) > 0)).toBe(true);

    // Zero secret leak across all plugin logs & canonical events
    const logDump = JSON.stringify(daemon.pluginManager.getLogs('hm.adapter.opencode'));
    expect(logDump).not.toContain(extPassword);

    // Disabling plugin disconnects cleanly WITHOUT killing the external server
    await daemon.pluginManager.togglePlugin('hm.adapter.opencode', false);
    expect(server.listening).toBe(true);
    expect(daemon.registry.get('opencode')).toBeUndefined();
  }, 35_000);

  it('zero vendor hardcoding guard: core runtime, protocol, plugin host, and frontend slots contain zero hardcoded deepseek or opencode branches', () => {
    const dirsToScan = [
      path.join(REPO_ROOT, 'packages', 'plugin-api', 'src'),
      path.join(REPO_ROOT, 'packages', 'protocol', 'src'),
      path.join(REPO_ROOT, 'packages', 'daemon', 'src'),
      path.join(REPO_ROOT, 'packages', 'web', 'src'),
    ];
    // Pre-existing V1 ACP catalog entry & modal placeholder hints in unmodified baseline files
    const preExistingBenignPaths = new Set([
      'packages/daemon/src/plugins/plugin-catalog.ts',
      'packages/web/src/components/Modals.tsx',
    ]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
          if (preExistingBenignPaths.has(rel)) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (/\b(?:deepseek|opencode)\b/i.test(text)) {
            hits.push(rel);
          }
        }
      }
    };
    for (const dir of dirsToScan) walk(dir);
    expect(hits).toEqual([]);
  });
});
