import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessCapabilitiesV2Schema, HarnessInfoSchema } from '@harnessmate/protocol';
import {
  AcpAdapter,
  AcpSessionHandle,
  isAcpAuthRequiredError,
  mapAcpConfigOptionsToDescriptors,
  parseAcpModelCatalog,
} from '../src/harnesses/acp-adapter.js';
import { inspectAgyCommand } from '../src/harnesses/agy-commands.js';
import { JsonRpcResponseError } from '../src/harnesses/jsonrpc.js';
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

describe('AcpAdapter (hm.adapter.acp: strict_acp & antigravity) V2 & Offline NDJSON Replay', () => {
  it('separates strict_acp and antigravity flavors cleanly while preserving instanceof AcpAdapter', () => {
    const strictAdapter = new AcpAdapter({
      id: 'gemini-acp',
      kind: 'acp',
      flavor: 'strict_acp',
      displayName: 'Gemini ACP',
      description: 'Standard ACP agent',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
    const agyAdapter = new AcpAdapter({
      id: 'agy',
      kind: 'agy',
      displayName: 'Antigravity',
      description: 'AGY ACP',
      command: 'agy',
      args: ['acp', '--stdio'],
      appDataDir: 'C:\\agy-profile-1',
    });

    expect(strictAdapter instanceof AcpAdapter).toBe(true);
    expect(agyAdapter instanceof AcpAdapter).toBe(true);
    expect(strictAdapter.driverId).toBe('acp');
    expect(agyAdapter.driverId).toBe('agy');
    expect(strictAdapter.continuationKey).toBe('acp:instance:gemini-acp');
    expect(agyAdapter.continuationKey).toBe(`agy:home:${path.resolve('C:\\agy-profile-1')}`);

    const strictCaps = HarnessCapabilitiesV2Schema.parse(strictAdapter.capabilitiesV2);
    const agyCaps = HarnessCapabilitiesV2Schema.parse(agyAdapter.capabilitiesV2);
    expect(strictCaps.transport).toBe('acp_stdio');
    expect(strictCaps.historyInjectionMode).toBe('embedded_context');
    expect(strictCaps.supportsDynamicOptions).toBe(true);
    expect(strictCaps.permissionModes).toEqual(['plan', 'accept_edits', 'auto']);
    expect(agyCaps.permissionModes).toEqual(['plan', 'manual', 'accept_edits', 'auto']);

    expect(strictAdapter.presentation).toEqual({
      shortLabel: 'ACP',
      accentColor: 'var(--accent-star)',
      softBg: 'var(--accent-star-soft)',
      tagline: 'Custom ACP Agent',
    });
    expect(agyAdapter.presentation).toEqual({
      shortLabel: 'AGY',
      accentColor: 'var(--accent-indigo)',
      softBg: 'var(--accent-indigo-soft)',
      tagline: 'Antigravity · Native ACP',
    });

    // Verify StrictAcpFlavorPolicy & AcpSessionHandle contain zero agy/antigravity conditionals
    const acpSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/harnesses/acp-adapter.ts'),
      'utf8',
    );
    const runtimeSlice = acpSrc.slice(acpSrc.indexOf('export class AcpSessionHandle'));
    expect(runtimeSlice).not.toMatch(/\bagyBinary\b|\bantigravity\b|\bagyDataDirectory\b/);

    const descriptors = mapAcpConfigOptionsToDescriptors([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'gemini-3-pro',
        options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
      },
      {
        id: 'auto_approve',
        name: 'Auto Approve',
        type: 'boolean',
        currentValue: 'false',
      },
    ]);
    expect(descriptors).toEqual([
      {
        key: 'model',
        label: 'Model',
        kind: 'select',
        defaultValue: 'gemini-3-pro',
        options: [{ value: 'gemini-3-pro', label: 'Gemini 3 Pro' }],
      },
      {
        key: 'auto_approve',
        label: 'Auto Approve',
        kind: 'boolean',
        defaultValue: false,
      },
    ]);

    const catalog = parseAcpModelCatalog({
      models: {
        currentModelId: 'gemini-3-pro-high',
        availableModels: [{ modelId: 'gemini-3-pro-high' }, { modelId: 'gemini-3-pro-low' }],
      },
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'gemini-3-pro',
          options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
        },
      ],
    });
    expect(catalog.defaultModelId).toBe('gemini-3-pro');
    expect(catalog.models[0]?.supportedEfforts).toEqual(['high', 'low']);

    expect(isAcpAuthRequiredError(new JsonRpcResponseError('Auth required', -32000))).toBe(true);
  });

  it('performs passive probe without calling session/new, never calls agy models in strict_acp, and propagates agy-commands env', async () => {
    const tmp = makeTempDir('hm-acp-probe-');
    const callsLog = path.join(tmp, 'acp-probe-calls.jsonl');
    const mockBin = writeReplayCliWrapper(
      tmp,
      'mock-strict-acp',
      `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify({
        args,
        CUSTOM_ENV: process.env.CUSTOM_ACP_KEY ?? null,
        HARNESSMATE_LOCAL_TOKEN: process.env.HARNESSMATE_LOCAL_TOKEN ?? null,
      }) + '\\n');
      if (args.includes('--version')) {
        process.stdout.write('strict-acp-agent 1.2.3\\n');
        process.exit(0);
      }
      if (args.includes('/usage')) {
        process.stdout.write(JSON.stringify({ status: 'OK', command: { name: 'usage', data: { description: 'OK' } } }) + '\\n');
        process.exit(0);
      }
      `,
    );

    const prevToken = process.env.HARNESSMATE_LOCAL_TOKEN;
    process.env.HARNESSMATE_LOCAL_TOKEN = 'host-secret';
    try {
      const strictAdapter = new AcpAdapter({
        id: 'strict-1',
        kind: 'acp',
        flavor: 'strict_acp',
        displayName: 'Strict ACP',
        description: 'Pure ACP',
        command: mockBin,
        args: ['--acp'],
        envWhitelist: { CUSTOM_ACP_KEY: 'acp-val' },
      });

      const info = await strictAdapter.probe();
      HarnessInfoSchema.parse(info);
      expect(info.health).toBe('ready');
      expect(info.version).toBe('1.2.3');

      const calls = fs
        .readFileSync(callsLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(['--version']);
      expect(calls[0]?.CUSTOM_ENV).toBe('acp-val');
      expect(calls[0]?.HARNESSMATE_LOCAL_TOKEN).toBeNull();

      // Verify agy-commands.ts passes isolated env + --app-data-dir
      const agyUsage = await inspectAgyCommand(mockBin, tmp, '/usage', {
        env: { CUSTOM_ACP_KEY: 'agy-isolated' },
        appDataDir: 'antigravity-alt',
      });
      expect(agyUsage).toEqual({ description: 'OK' });
      const allCalls = fs
        .readFileSync(callsLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(allCalls[1]?.args as string[]).toContain('--app-data-dir');
      expect(allCalls[1]?.args as string[]).toContain('antigravity-alt');
      expect(allCalls[1]?.CUSTOM_ENV).toBe('agy-isolated');
    } finally {
      if (prevToken === undefined) delete process.env.HARNESSMATE_LOCAL_TOKEN;
      else process.env.HARNESSMATE_LOCAL_TOKEN = prevToken;
    }
  }, 25_000);

  it('replays config_option_update, stale option skip, plan, available_commands_update, embeddedContext inline retry, and strict permission forwarding', async () => {
    const tmp = makeTempDir('hm-acp-replay-1-');
    const reqLog = path.join(tmp, 'acp-requests.jsonl');
    const mockScript = path.join(tmp, 'replay-strict-acp.mjs');

    fs.writeFileSync(
      mockScript,
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const reqLog = ${JSON.stringify(reqLog)};
      const rl = readline.createInterface({ input: process.stdin });
      let pendingPromptId = null;
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        fs.appendFileSync(reqLog, JSON.stringify({ method: msg.method, id: msg.id, params: msg.params, result: msg.result }) + '\\n');
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: 1,
              authMethods: [{ id: 'oauth2', name: 'OAuth2' }],
              agentCapabilities: { promptCapabilities: { embeddedContext: true } },
            },
          }) + '\\n');
        } else if (msg.method === 'authenticate') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 'acp_s1',
              configOptions: [
                { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'm-1', options: [{ value: 'm-1', name: 'M1' }] },
                { id: 'thought_level', category: 'thought_level', name: 'Thought Level', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
              ],
            },
          }) + '\\n');
        } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          const blocks = msg.params?.prompt ?? [];
          const hasResource = blocks.some((b) => b.type === 'resource');
          if (hasResource) {
            // Reject embeddedContext resource block so adapter automatically retries inline
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32602, message: 'embeddedContext resource block unsupported' },
            }) + '\\n');
            return;
          }
          pendingPromptId = msg.id;
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'plan', description: 'Show plan' }, { name: 'review' }],
              },
            },
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [
                  { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'm-1', options: [{ value: 'm-1', name: 'M1' }, { value: 'm-2', name: 'M2' }] },
                ],
              },
            },
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'plan',
                entries: [{ content: 'Inspect files', status: 'completed' }, { content: 'Run tests', status: 'in_progress' }],
              },
            },
          }) + '\\n');
          // Request permission: strict_acp must forward honestly even in auto mode!
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 501,
            method: 'session/request_permission',
            params: {
              toolCall: { title: 'Write file', kind: 'edit' },
              options: [{ optionId: 'allow_1', kind: 'allow_once' }, { optionId: 'deny_1', kind: 'reject_once' }],
            },
          }) + '\\n');
        } else if (msg.id === 501 && msg.result) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Inline retry + permission ok.' } } },
          }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } }) + '\\n');
        }
      });
      `,
      'utf8',
    );

    const adapter = new AcpAdapter({
      id: 'strict-replay',
      kind: 'acp',
      flavor: 'strict_acp',
      displayName: 'Strict Replay ACP',
      description: 'Strict ACP',
      command: process.execPath,
      args: [mockScript],
      authenticateEagerly: true,
    });

    const handle = (await adapter.createSession({
      cwd: tmp,
      permissionMode: 'auto',
      // Stale/unadvertised reasoningEffort 'ultra' should skip gracefully with warn diagnostic!
      reasoningEffort: 'ultra',
    })) as AcpSessionHandle;

    const events: NormalizedAdapterEvent[] = [];
    handle.onEvent((ev) => {
      events.push(ev);
      if (ev.type === 'approval.requested') {
        void handle.resolveApproval(ev.nativeRequestId, 'allow_once');
      }
    });

    try {
      // Stale config option key skips gracefully returning false without throwing
      expect(await handle.setConfigOption('stale_removed_option', 'foo')).toBe(false);

      const res = await handle.sendTurn({
        turnId: 't_acp_1',
        text: 'Do work',
        contextSync: {
          deltaMarkdown: 'Previous turn summary',
          portableItems: [],
          isWarmBinding: true,
        },
      });
      expect(res.driverUsed).toBe('acp_embedded_context');

      await waitFor(() => events.some((e) => e.type === 'turn.completed' && e.turnId === 't_acp_1'));

      // Strict ACP forwarded permission honestly instead of spoofing auto-allow
      expect(events.some((e) => e.type === 'approval.requested')).toBe(true);
      // Plan mapped to ext:acp.plan
      expect(
        events.find((e) => e.type === 'turn_block.ext' && e.blockType === 'ext:acp.plan'),
      ).toMatchObject({
        title: 'Plan',
        payload: { entries: [{ content: 'Inspect files', status: 'completed' }, { content: 'Run tests', status: 'in_progress' }] },
      });
      // available_commands_update refreshed nativeCommands
      expect(adapter.capabilitiesV2.nativeCommands).toEqual(['plan', 'review']);
      // config_option_update refreshed optionDescriptors live on adapter
      expect(adapter.optionDescriptors[0]).toMatchObject({
        key: 'model',
        options: [
          { value: 'm-1', label: 'M1' },
          { value: 'm-2', label: 'M2' },
        ],
      });
      // embeddedContext fallback updated capabilitiesV2.historyInjectionMode
      expect(adapter.capabilitiesV2.historyInjectionMode).toBe('inline');
      expect(
        events.some(
          (e) =>
            e.type === 'diagnostic.log' &&
            e.level === 'warn' &&
            e.message.includes('embeddedContext'),
        ),
      ).toBe(true);

      const recorded = fs
        .readFileSync(reqLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
      expect(recorded.some((r) => r.method === 'authenticate')).toBe(true);
      const promptCalls = recorded.filter((r) => r.method === 'session/prompt');
      expect(promptCalls).toHaveLength(2);
      expect((promptCalls[1]?.params?.prompt as Array<{ type: string; text?: string }>)[0]?.type).toBe(
        'text',
      );
      expect(
        (promptCalls[1]?.params?.prompt as Array<{ type: string; text?: string }>)[0]?.text,
      ).toContain('Previous turn summary');
    } finally {
      await handle.dispose();
    }
  }, 15_000);

  it('resolves session/load via sessionLoadReplayIdleGap and maps auth_required to unauthenticated health + turn.failed', async () => {
    const tmp = makeTempDir('hm-acp-replay-2-');
    const mockLoadIdleScript = path.join(tmp, 'replay-load-idle.mjs');

    fs.writeFileSync(
      mockLoadIdleScript,
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (msg.method === 'session/load') {
          // Stream replay chunks and intentionally NEVER reply to session/load RPC
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Replayed user' } } },
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed assistant' } } },
          }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp_auth_s' } }) + '\\n');
        } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'Authentication required' },
          }) + '\\n');
        }
      });
      `,
      'utf8',
    );

    const mockBin = writeReplayCliWrapper(
      tmp,
      'mock-acp-auth-bin',
      `
      const args = process.argv.slice(2);
      if (args.includes('--version')) {
        process.stdout.write('acp-auth 2.0.0\\n');
        process.exit(0);
      }
      await import(${JSON.stringify('file://' + mockLoadIdleScript.replace(/\\/g, '/'))});
      `,
    );

    const adapter = new AcpAdapter({
      id: 'acp-idle-auth',
      kind: 'acp',
      flavor: 'strict_acp',
      displayName: 'ACP Idle & Auth',
      description: 'ACP test',
      command: mockBin,
      args: [],
      sessionLoadReplayIdleMs: 120,
    });

    // 1. sessionLoadReplayIdleGap resolves session/load in ~120ms without waiting 25s
    const start = Date.now();
    const resumedHandle = await adapter.createSession({
      cwd: tmp,
      permissionMode: 'accept_edits',
      nativeSessionId: 'hist_sess_42',
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);
    expect(resumedHandle.nativeSessionId).toBe('hist_sess_42');
    await resumedHandle.dispose();

    // 2. auth_required (-32000) sets turn.failed code='unauthenticated' and probePassive() health='unauthenticated'
    const authHandle = await adapter.createSession({
      cwd: tmp,
      permissionMode: 'accept_edits',
    });
    const events: NormalizedAdapterEvent[] = [];
    authHandle.onEvent((ev) => events.push(ev));
    try {
      await authHandle.sendTurn({ turnId: 't_auth', text: 'hello' });
      await waitFor(() => events.some((e) => e.type === 'turn.failed' && e.turnId === 't_auth'));
      expect(events.find((e) => e.type === 'turn.failed' && e.turnId === 't_auth')).toMatchObject({
        code: 'unauthenticated',
      });
      const probeAfterAuth = await adapter.probePassive();
      expect(probeAfterAuth.health).toBe('unauthenticated');
    } finally {
      await authHandle.dispose();
    }
  }, 15_000);
});
