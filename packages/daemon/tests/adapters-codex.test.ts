import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessCapabilitiesV2Schema, HarnessInfoSchema } from '@harnessmate/protocol';
import {
  CodexAppServerAdapter,
  CodexSessionHandle,
  buildCodexOptionDescriptors,
  classifyCodexError,
  classifyCodexModelGroup,
  normalizeCodexPatchDiff,
  readCodexConfigDefaultModel,
} from '../src/harnesses/codex-adapter.js';
import type { NormalizedAdapterEvent } from '../src/harnesses/types.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeReplayCliWrapper(dir: string, name: string, jsSource: string): string {
  const scriptPath = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(scriptPath, jsSource, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = path.join(dir, `${name}.sh`);
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore windows cleanup lock
    }
  }
});

describe('CodexAppServerAdapter (hm.adapter.codex) V2 & Offline NDJSON Replay', () => {
  it('exposes flat capabilitiesV2, presentation, dynamic optionDescriptors, and zero Magpie hardcoding', () => {
    const adapter = new CodexAppServerAdapter();
    expect(adapter.driverId).toBe('codex');
    expect(adapter.continuationKey).toBe('codex:instance:codex');

    const parsedCaps = HarnessCapabilitiesV2Schema.parse(adapter.capabilitiesV2);
    expect(parsedCaps.transport).toBe('jsonrpc_stdio');
    expect(parsedCaps.historyInjectionMode).toBe('native_items');
    expect(parsedCaps.supportsNativeRollback).toBe(true);
    expect(parsedCaps.supportsActiveSteering).toBe(true);
    expect(parsedCaps.supportsUsageLimits).toBe(true);
    expect(parsedCaps.supportsDynamicOptions).toBe(true);
    expect(parsedCaps.nativeCommands).toEqual(
      expect.arrayContaining(['goal', 'skills', 'compact', 'fork', 'rollback', 'steer']),
    );
    expect(parsedCaps.optionDescriptors.map((d) => d.key)).toEqual([
      'reasoningEffort',
      'serviceTier',
    ]);

    expect(adapter.presentation).toEqual({
      shortLabel: 'Codex',
      accentColor: 'var(--accent-emerald)',
      softBg: 'var(--accent-emerald-soft)',
      tagline: 'OpenAI Codex · App Server',
    });

    const dynamicOpts = buildCodexOptionDescriptors(
      [
        {
          id: 'gpt-5-codex',
          displayName: 'GPT-5 Codex',
          isDefault: true,
          defaultEffort: 'high',
          supportedEfforts: ['medium', 'high', 'xhigh'],
        },
      ],
      'gpt-5-codex',
      'fast',
    );
    expect(dynamicOpts[0]).toMatchObject({
      kind: 'select',
      key: 'reasoningEffort',
      defaultValue: 'high',
      options: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Xhigh' },
      ],
    });
    expect(dynamicOpts[1]).toMatchObject({
      kind: 'select',
      key: 'serviceTier',
      defaultValue: 'fast',
    });

    expect(classifyCodexModelGroup('auto/best', 'Auto routing group')).toBe('Auto Routing');
    expect(classifyCodexModelGroup('auto/best', 'Auto routing group')).not.toMatch(/magpie/i);
    expect(classifyCodexModelGroup('gpt-5-codex', 'GPT-5 Codex')).toBe('OpenAI Codex');
  });

  it('normalizes multi-file patches with diff --git headers and classifies Codex errors', () => {
    const rawMultiFilePatch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    const normalized = normalizeCodexPatchDiff(rawMultiFilePatch);
    expect(normalized).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(normalized).toContain('diff --git a/src/b.ts b/src/b.ts');

    const headerlessSingle = '@@ -1 +1 @@\n-foo\n+bar';
    expect(normalizeCodexPatchDiff(headerlessSingle, 'src/single.ts')).toContain(
      'diff --git a/src/single.ts b/src/single.ts',
    );

    expect(classifyCodexError('invalid_encrypted_content while resuming')).toBe(
      'invalid_encrypted_content',
    );
    expect(classifyCodexError('429 rate limit exceeded')).toBe('usage_limit');
    expect(classifyCodexError('Rollout file is already locked by another process')).toBe(
      'native_thread_in_use',
    );
    expect(classifyCodexError('Unexpected upstream timeout')).toBe('provider_error');
  });

  it('performs true passive probing with 0 app-server spawns and isolates CODEX_HOME + env', async () => {
    const tmp = makeTempDir('hm-codex-probe-');
    const homeA = path.join(tmp, 'home-a');
    const homeB = path.join(tmp, 'home-b');
    fs.mkdirSync(homeA, { recursive: true });
    fs.mkdirSync(homeB, { recursive: true });
    fs.writeFileSync(path.join(homeA, 'config.toml'), 'model = "gpt-5.3-codex"\n', 'utf8');
    fs.writeFileSync(path.join(homeA, 'auth.json'), JSON.stringify({ email: 'a@example.com', planType: 'pro' }), 'utf8');
    // homeB intentionally has NO config.toml!

    const prevHostCodexHome = process.env.CODEX_HOME;
    const prevHostApiKey = process.env.OPENAI_API_KEY;
    const prevHostLocalToken = process.env.HARNESSMATE_LOCAL_TOKEN;
    const prevHostDataDir = process.env.HARNESSMATE_DATA_DIR;
    process.env.CODEX_HOME = homeA;
    process.env.OPENAI_API_KEY = 'sk-host-secret-must-not-leak';
    process.env.HARNESSMATE_LOCAL_TOKEN = 'host-local-token-must-not-leak';
    process.env.HARNESSMATE_DATA_DIR = 'C:\\host-data-dir';

    const invocationsLog = path.join(tmp, 'invocations.jsonl');
    const mockBin = writeReplayCliWrapper(
      tmp,
      'codex-probe-mock',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(invocationsLog)}, JSON.stringify({
        args,
        CODEX_HOME: process.env.CODEX_HOME ?? null,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
        HARNESSMATE_LOCAL_TOKEN: process.env.HARNESSMATE_LOCAL_TOKEN ?? null,
        HARNESSMATE_DATA_DIR: process.env.HARNESSMATE_DATA_DIR ?? null,
      }) + '\\n');
      if (args.includes('--version')) {
        process.stdout.write('codex-cli 0.156.1\\n');
        process.exit(0);
      }
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'model/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              data: [{
                id: 'gpt-5.4-codex',
                displayName: 'GPT-5.4 Codex',
                isDefault: true,
                defaultReasoningEffort: 'xhigh',
                supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }],
              }],
            },
          }) + '\\n');
        } else if (msg.method === 'account/read') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { account: { email: 'live@example.com', planType: 'team' } },
          }) + '\\n');
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        }
      });
      `,
    );

    try {
      // Explicit codexHome MUST NOT fall back to process.env.CODEX_HOME or ~/.codex/config.toml
      expect(readCodexConfigDefaultModel(homeB)).toBeNull();
      expect(readCodexConfigDefaultModel(homeA)).toBe('gpt-5.3-codex');

      const adapterA = new CodexAppServerAdapter(mockBin, ['app-server', '--stdio'], {
        instanceId: 'codex-a',
        displayName: 'Codex A',
        codexHome: homeA,
        envWhitelist: { CUSTOM_FLAG: 'alpha' },
      });
      const adapterB = new CodexAppServerAdapter(mockBin, ['app-server', '--stdio'], {
        instanceId: 'codex-b',
        displayName: 'Codex B',
        codexHome: homeB,
        envWhitelist: { OPENAI_API_KEY: 'sk-instance-b-only' },
        defaultServiceTier: 'fast',
      });

      expect(adapterA.continuationKey).toBe(`codex:home:${path.resolve(homeA)}`);
      expect(adapterB.continuationKey).toBe(`codex:home:${path.resolve(homeB)}`);

      const infoA = await adapterA.probe();
      const infoB = await adapterB.probePassive();

      HarnessInfoSchema.parse(infoA);
      HarnessInfoSchema.parse(infoB);

      expect(infoA.defaultModelId).toBe('gpt-5.3-codex');
      expect(infoA.accountSummary).toBe('a@example.com · pro');
      expect(infoB.defaultModelId).toBeNull();
      expect(infoB.optionDescriptors?.map((d) => d.key)).toEqual(['reasoningEffort', 'serviceTier']);
      expect(infoB.capabilitiesV2?.optionDescriptors.map((d) => d.key)).toEqual([
        'reasoningEffort',
        'serviceTier',
      ]);

      // Passive probes MUST NOT have launched app-server
      const callsBeforeLive = fs
        .readFileSync(invocationsLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(callsBeforeLive).toHaveLength(2);
      expect(callsBeforeLive.every((c) => (c.args as string[]).includes('--version'))).toBe(true);
      expect(callsBeforeLive.some((c) => (c.args as string[]).includes('app-server'))).toBe(false);
      // Host secrets stripped; adapterA had host OPENAI_API_KEY stripped!
      expect(callsBeforeLive[0]).toMatchObject({
        CODEX_HOME: path.resolve(homeA),
        OPENAI_API_KEY: null,
        HARNESSMATE_LOCAL_TOKEN: null,
        HARNESSMATE_DATA_DIR: null,
      });
      expect(callsBeforeLive[1]).toMatchObject({
        CODEX_HOME: path.resolve(homeB),
        OPENAI_API_KEY: 'sk-instance-b-only',
        HARNESSMATE_LOCAL_TOKEN: null,
      });

      // Explicit live metadata probe propagates CODEX_HOME + updates cachedLiveProbe for probePassive()
      const liveA = await adapterA.probeAppServerMetadata(undefined, false);
      expect(liveA.defaultModelId).toBe('gpt-5.4-codex');
      const infoAAfterLive = await adapterA.probePassive();
      expect(infoAAfterLive.defaultModelId).toBe('gpt-5.4-codex');
      expect(infoAAfterLive.optionDescriptors?.[0]).toMatchObject({
        key: 'reasoningEffort',
        defaultValue: 'xhigh',
      });
    } finally {
      if (prevHostCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHostCodexHome;
      if (prevHostApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevHostApiKey;
      if (prevHostLocalToken === undefined) delete process.env.HARNESSMATE_LOCAL_TOKEN;
      else process.env.HARNESSMATE_LOCAL_TOKEN = prevHostLocalToken;
      if (prevHostDataDir === undefined) delete process.env.HARNESSMATE_DATA_DIR;
      else process.env.HARNESSMATE_DATA_DIR = prevHostDataDir;
    }
  }, 25_000);

  it('replays basic_turn, context_telemetry, multi-file patch, steer/fork/rollback, and native commands via NDJSON', async () => {
    const tmp = makeTempDir('hm-codex-replay-1-');
    const requestsLog = path.join(tmp, 'requests.jsonl');

    // Recorded NDJSON fixture events per method
    const fixtures = {
      basicTurnNotifications: [
        { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 'nt_1' } } },
        { jsonrpc: '2.0', method: 'item/started', params: { item: { id: 'cmd_1', type: 'commandExecution', command: 'pnpm test', processId: 'pid_77' } } },
        { jsonrpc: '2.0', method: 'item/fileChange/patchUpdated', params: { itemId: 'fc_1', path: 'src/app.ts', patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b' } },
        { jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { tokenUsage: { modelContextWindow: 200000, last: { inputTokens: 1200, outputTokens: 350, cachedInputTokens: 400, reasoningOutputTokens: 90, totalTokens: 1550 } } } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'Done.' } },
        { jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'cmd_1', type: 'commandExecution', status: 'completed', aggregatedOutput: 'ok' } } },
        { jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'msg_1', type: 'agentMessage', text: 'Done.' } } },
        { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'nt_1', status: 'completed' } } },
      ],
    };

    const mockScript = path.join(tmp, 'replay-codex.mjs');
    fs.writeFileSync(
      mockScript,
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const fixtures = ${JSON.stringify(fixtures)};
      const reqLog = ${JSON.stringify(requestsLog)};
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        fs.appendFileSync(reqLog, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'thread/start') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_1', model: 'gpt-5.4' } } }) + '\\n');
        } else if (msg.method === 'turn/start') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'nt_1' } } }) + '\\n');
          if (msg.params?.input?.[0]?.text === 'basic') {
            for (const frame of fixtures.basicTurnNotifications) {
              process.stdout.write(JSON.stringify(frame) + '\\n');
            }
          } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 'nt_steer' } } }) + '\\n');
          }
        } else if (msg.method === 'turn/steer') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'nt_steer', status: 'completed' } } }) + '\\n');
        } else if (msg.method === 'thread/fork') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_fork_2' } } }) + '\\n');
        } else if (msg.method === 'thread/rollback') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'skills/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { data: [{ skills: [{ name: 'tdd', description: 'Test driven' }] }] } }) + '\\n');
        } else if (msg.method === 'thread/goal/set') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { goal: { objective: msg.params.objective, status: 'active' } } }) + '\\n');
        } else if (msg.method === 'thread/compact/start') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        }
      });
      `,
      'utf8',
    );

    const adapter = new CodexAppServerAdapter(process.execPath, [mockScript], {
      defaultServiceTier: 'fast',
    });
    const handle = (await adapter.createSession({
      cwd: tmp,
      permissionMode: 'accept_edits',
    })) as CodexSessionHandle;
    const events: NormalizedAdapterEvent[] = [];
    handle.onEvent((ev) => events.push(ev));

    try {
      await handle.sendTurn({ turnId: 'turn_1', text: 'basic' });
      await waitFor(() => events.some((e) => e.type === 'turn.completed' && e.turnId === 'turn_1'));

      const patchDelta = events.find((e) => e.type === 'tool.call.delta' && e.diffDelta);
      expect(patchDelta && patchDelta.type === 'tool.call.delta' ? patchDelta.diffDelta : '').toContain(
        'diff --git a/src/app.ts b/src/app.ts',
      );

      const telemetry = events.find(
        (e) => e.type === 'turn_block.ext' && e.blockType === 'ext:codex.context_telemetry',
      );
      expect(telemetry).toMatchObject({
        type: 'turn_block.ext',
        blockType: 'ext:codex.context_telemetry',
        payload: {
          modelContextWindow: 200000,
          cachedInputTokens: 400,
          reasoningOutputTokens: 90,
          totalTokens: 1550,
        },
      });

      // Steer, fork, rollback, native commands
      await handle.sendTurn({ turnId: 'turn_2', text: 'steer_target' });
      await waitFor(() => events.some((e) => e.type === 'turn.started' && e.turnId === 'turn_2'));
      await handle.runNativeCommand('steer', 'focus on tests');
      await waitFor(() => events.some((e) => e.type === 'turn.completed' && e.turnId === 'turn_2'));

      const forked = await handle.forkNativeSession();
      expect(forked.nativeSessionId).toBe('thr_fork_2');
      await handle.rollbackThread(2);
      expect(await handle.runNativeCommand('skills', '')).toContain('tdd');
      expect(await handle.runNativeCommand('goal', 'Ship M1A')).toContain('Ship M1A');
      expect(await handle.runNativeCommand('compact', '')).toContain('compaction');

      const recorded = fs
        .readFileSync(requestsLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { method: string; params?: Record<string, unknown> });

      const initReq = recorded.find((r) => r.method === 'initialize');
      expect(initReq?.params).toMatchObject({
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ['turn/diff/updated'],
        },
      });
      const startReq = recorded.find((r) => r.method === 'thread/start');
      expect(startReq?.params?.serviceTier).toBe('fast');
      expect(recorded.some((r) => r.method === 'turn/steer')).toBe(true);
      expect(recorded.some((r) => r.method === 'thread/fork')).toBe(true);
      expect(recorded.find((r) => r.method === 'thread/rollback')?.params).toEqual({
        threadId: 'thr_1',
        numTurns: 2,
      });
    } finally {
      await handle.dispose();
    }
  }, 15_000);

  it('handles interrupt + backgroundTerminals/terminate, early-stop before turn/started, inject_items fallback, and error codes', async () => {
    const tmp = makeTempDir('hm-codex-replay-2-');
    const reqLog = path.join(tmp, 'edge-requests.jsonl');
    const mockScript = path.join(tmp, 'replay-codex-edge.mjs');

    fs.writeFileSync(
      mockScript,
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const reqLog = ${JSON.stringify(reqLog)};
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        fs.appendFileSync(reqLog, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'thread/resume') {
          if (msg.params?.threadId === 'locked_thread') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Thread rollout is already locked by another CLI' } }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId } } }) + '\\n');
          }
        } else if (msg.method === 'thread/start') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_edge' } } }) + '\\n');
        } else if (msg.method === 'thread/inject_items') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
        } else if (msg.method === 'turn/start') {
          const text = msg.params?.input?.[0]?.text ?? '';
          if (text.includes('early_stop')) {
            setTimeout(() => {
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'nt_early' } } }) + '\\n');
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr_edge', turn: { id: 'nt_early' } } }) + '\\n');
            }, 60);
          } else if (text.includes('mid_tool')) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'nt_mid' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr_edge', turn: { id: 'nt_mid' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { item: { id: 'bg_cmd_1', type: 'commandExecution', command: 'sleep 30', processId: 'bg_proc_99' } } }) + '\\n');
          } else if (text.includes('encrypted_err')) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'nt_enc' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'nt_enc', status: 'failed', error: { message: 'invalid_encrypted_content in thread history' } } } }) + '\\n');
          } else if (text.includes('quota_err')) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'nt_quota' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'nt_quota', status: 'failed', error: { message: '429 usage limit exceeded' } } } }) + '\\n');
          }
        } else if (msg.method === 'turn/interrupt' || msg.method === 'thread/backgroundTerminals/terminate') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        }
      });
      `,
      'utf8',
    );

    const adapter = new CodexAppServerAdapter(process.execPath, [mockScript]);

    // 1. Thread lock conflict throws E_NATIVE_THREAD_IN_USE without silently falling back to thread/start
    await expect(
      adapter.createSession({
        cwd: tmp,
        permissionMode: 'manual',
        nativeSessionId: 'locked_thread',
        requireNativeResume: false,
      }),
    ).rejects.toThrow(/E_NATIVE_THREAD_IN_USE/);

    const handle = await adapter.createSession({ cwd: tmp, permissionMode: 'accept_edits' });
    const events: NormalizedAdapterEvent[] = [];
    handle.onEvent((ev) => events.push(ev));

    try {
      // 2. inject_items -32601 fallback
      const driver = await handle.injectContext?.({
        deltaMarkdown: 'history',
        portableItems: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        isWarmBinding: true,
      });
      expect(driver).toBe('prompt_envelope');

      // 3. Mid-tool interrupt terminates background terminals
      await handle.sendTurn({ turnId: 't_mid', text: 'mid_tool' });
      await waitFor(() =>
        events.some((e) => e.type === 'tool.call.started' && e.toolCallId === 'bg_cmd_1'),
      );
      await handle.interrupt();
      expect(events.some((e) => e.type === 'turn.cancelled' && e.turnId === 't_mid')).toBe(true);

      // 4. Early-stop interrupt queued before turn/started / currentNativeTurnId arrives
      const earlyPromise = handle.sendTurn({ turnId: 't_early', text: 'early_stop' });
      await new Promise((r) => setTimeout(r, 15));
      await handle.interrupt();
      await earlyPromise;
      await new Promise((r) => setTimeout(r, 90));

      // 5. Classified errors
      await handle.sendTurn({ turnId: 't_enc', text: 'encrypted_err' });
      await waitFor(() => events.some((e) => e.type === 'turn.failed' && e.turnId === 't_enc'));
      expect(events.find((e) => e.type === 'turn.failed' && e.turnId === 't_enc')).toMatchObject({
        code: 'invalid_encrypted_content',
      });

      await handle.sendTurn({ turnId: 't_quota', text: 'quota_err' });
      await waitFor(() => events.some((e) => e.type === 'turn.failed' && e.turnId === 't_quota'));
      expect(events.find((e) => e.type === 'turn.failed' && e.turnId === 't_quota')).toMatchObject({
        code: 'usage_limit',
      });

      const recorded = fs
        .readFileSync(reqLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { method: string; params?: Record<string, unknown> });

      expect(
        recorded.some(
          (r) =>
            r.method === 'thread/backgroundTerminals/terminate' &&
            Array.isArray(r.params?.processIds) &&
            r.params.processIds.includes('bg_proc_99'),
        ),
      ).toBe(true);
      expect(
        recorded.some(
          (r) => r.method === 'turn/interrupt' && r.params?.turnId === 'nt_early',
        ),
      ).toBe(true);
    } finally {
      await handle.dispose();
    }
  }, 15_000);
});
