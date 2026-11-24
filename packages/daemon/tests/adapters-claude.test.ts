import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessCapabilitiesV2Schema, HarnessInfoSchema } from '@harnessmate/protocol';
import {
  CLAUDE_AUTO_COMPACT_RESERVE_TOKENS,
  ClaudeSessionHandle,
  ClaudeStreamJsonAdapter,
  buildClaudeOptionDescriptors,
  classifyClaudeError,
  classifyClaudeModelGroup,
  claudeProviderTurnTokenUsage,
  mergeClaudeStreamUsage,
  readClaudeLocalSettings,
} from '../src/harnesses/claude-adapter.js';
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

describe('ClaudeStreamJsonAdapter (hm.adapter.claude) V2 & Offline NDJSON Replay', () => {
  it('exposes capabilitiesV2, presentation, dynamic optionDescriptors, and zero vendor hardcoding', () => {
    const adapter = new ClaudeStreamJsonAdapter(undefined, {
      instanceId: 'claude-custom',
      displayName: 'Claude Custom',
      description: 'Isolated Claude instance',
    });
    expect(adapter.driverId).toBe('claude');
    expect(adapter.continuationKey).toBe('claude:instance:claude-custom');

    const capsV2 = HarnessCapabilitiesV2Schema.parse(adapter.capabilitiesV2);
    expect(capsV2.transport).toBe('stream_json');
    expect(capsV2.historyInjectionMode).toBe('sysfile_delta');
    expect(capsV2.supportsDynamicOptions).toBe(true);
    expect(capsV2.optionDescriptors.map((d) => d.key)).toEqual([
      'effort',
      'thinking',
      'contextWindow',
      'fastMode',
    ]);
    expect(adapter.presentation).toEqual({
      shortLabel: 'Claude',
      accentColor: 'var(--accent-clay)',
      softBg: 'var(--accent-clay-soft)',
      tagline: 'Claude Code · Stream JSON',
    });

    const opts = buildClaudeOptionDescriptors({
      effort: 'high',
      thinking: false,
      contextWindow: '1m',
      fastMode: true,
    });
    expect(opts).toHaveLength(4);
    expect(opts[1]).toMatchObject({ kind: 'boolean', key: 'thinking', defaultValue: false });
    expect(opts[2]).toMatchObject({ kind: 'select', key: 'contextWindow', defaultValue: '1m' });
    expect(opts[3]).toMatchObject({ kind: 'boolean', key: 'fastMode', defaultValue: true });

    // Zero Magpie / WorkBuddy / our-free-model hardcoding
    expect(classifyClaudeModelGroup('auto/best', 'routing group')).toBe('Auto Routing');
    expect(classifyClaudeModelGroup('our-free-model/qwen', 'Qwen')).toBe('our-free-model');
    expect(classifyClaudeModelGroup('workbuddy-v1', 'WorkBuddy')).toBe('Anthropic Claude');
    expect(
      classifyClaudeModelGroup('partner/model-x', 'Partner X', [
        { prefix: 'partner/', groupLabel: 'Partner Gateway' },
      ]),
    ).toBe('Partner Gateway');

    // Verify source file itself does not contain removed hardcoded vendor strings
    const claudeSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/harnesses/claude-adapter.ts'),
      'utf8',
    );
    expect(claudeSrc).not.toMatch(/Magpie|WorkBuddy|our-free-model\//);
  });

  it('computes 5m/1h cache TTL, autoCompactThreshold, merged stream usage, and error codes', () => {
    const merged = mergeClaudeStreamUsage(
      { input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 200 } },
      { output_tokens: 55, cache_read_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 400 } },
    );
    const nowMs = 1_700_000_000_000;
    const oneHour = claudeProviderTurnTokenUsage(merged, {
      model: 'claude-sonnet-4-6[1m]',
      totalCostUsd: 0.012,
      nowMs,
    });
    expect(oneHour.promptCacheTtlMs).toBe(3_600_000);
    expect(oneHour.promptCacheExpiresAt).toBe(nowMs + 3_600_000);
    expect(oneHour.contextWindow).toBe(1_000_000);
    expect(oneHour.autoCompactThreshold).toBe(1_000_000 - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS);

    const fiveMin = claudeProviderTurnTokenUsage(
      { input_tokens: 50, output_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 300 } },
      { nowMs },
    );
    expect(fiveMin.promptCacheTtlMs).toBe(300_000);
    expect(fiveMin.promptCacheExpiresAt).toBe(nowMs + 300_000);
    expect(fiveMin.contextWindow).toBe(200_000);
    expect(fiveMin.autoCompactThreshold).toBe(200_000 - 33_000);

    expect(classifyClaudeError('No conversation found with session ID abc')).toBe(
      'conversation_not_found',
    );
    expect(
      classifyClaudeError('--dangerously-skip-permissions cannot be used with root/sudo privileges'),
    ).toBe('root_bypass_refused');
    expect(classifyClaudeError('API 429 rate limit reached')).toBe('usage_limit');
    expect(classifyClaudeError('refused_before_prompt')).toBe('refused_before_prompt');
  });

  it('isolates CLAUDE_CONFIG_DIR + auth env, detects unauthenticated, and degrades --system-prompt-snapshot via --help', async () => {
    const tmp = makeTempDir('hm-claude-probe-');
    const dirA = path.join(tmp, 'cfg-a');
    const dirB = path.join(tmp, 'cfg-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(
      path.join(dirA, 'settings.json'),
      JSON.stringify({
        model: 'custom/sonnet-gw',
        env: { ANTHROPIC_BASE_URL: 'https://gw-a.example.com' },
        modelPicker: {
          options: [{ model: 'custom/sonnet-gw', label: 'Gateway Sonnet' }],
        },
      }),
      'utf8',
    );
    // dirB has no settings.json

    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevAuth = process.env.ANTHROPIC_AUTH_TOKEN;
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    const prevLocalTok = process.env.HARNESSMATE_LOCAL_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-host-leak';
    process.env.ANTHROPIC_AUTH_TOKEN = 'host-auth-token';
    process.env.ANTHROPIC_BASE_URL = 'https://host.example.com';
    process.env.HARNESSMATE_LOCAL_TOKEN = 'hm-secret';

    const callsLog = path.join(tmp, 'claude-calls.jsonl');
    const mockBin = writeReplayCliWrapper(
      tmp,
      'mock-claude-probe',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify({
        args,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
        HARNESSMATE_LOCAL_TOKEN: process.env.HARNESSMATE_LOCAL_TOKEN ?? null,
      }) + '\\n');
      if (args.includes('--version')) {
        process.stdout.write('2.1.111 (Claude Code)\\n');
        process.exit(0);
      }
      if (args.includes('auth') && args.includes('status')) {
        const loggedIn = Boolean(process.env.CLAUDE_CONFIG_DIR?.includes('cfg-a'));
        process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'oauth' : undefined }) + '\\n');
        process.exit(0);
      }
      if (args.includes('--help')) {
        // Older Claude CLI without --system-prompt-snapshot
        process.stdout.write('Usage: claude [options]\\n  --append-system-prompt\\n');
        process.exit(0);
      }
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.type === 'user') {
          process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'c_old_cli' }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
        }
      });
      `,
    );

    try {
      const settingsA = readClaudeLocalSettings(dirA, [
        { prefix: 'custom/', groupLabel: 'Custom Rule Group' },
      ]);
      expect(settingsA.models[0]?.group).toBe('Custom Rule Group');
      expect(settingsA.gatewayUrl).toBe('https://gw-a.example.com');

      const settingsB = readClaudeLocalSettings(dirB);
      expect(settingsB.gatewayUrl).toBeNull();

      const adapterA = new ClaudeStreamJsonAdapter(mockBin, {
        instanceId: 'claude-a',
        configDir: dirA,
        apiBaseUrl: 'https://gw-a.example.com',
        authToken: 'tok-a',
        modelGroupRules: [{ prefix: 'custom/', groupLabel: 'Custom Rule Group' }],
      });
      const adapterB = new ClaudeStreamJsonAdapter(mockBin, {
        instanceId: 'claude-b',
        configDir: dirB,
      });

      const infoA = await adapterA.probe();
      const infoB = await adapterB.probePassive();

      HarnessInfoSchema.parse(infoA);
      HarnessInfoSchema.parse(infoB);

      expect(infoA.health).toBe('ready');
      expect(infoA.continuationKey).toBe(`claude:home:${path.resolve(dirA)}`);
      expect(infoA.optionDescriptors?.map((d) => d.key)).toEqual([
        'effort',
        'thinking',
        'contextWindow',
        'fastMode',
      ]);
      // dirB is loggedIn: false and has no isolated api key/gateway -> unauthenticated
      expect(infoB.health).toBe('unauthenticated');

      // Launch session with handoffContinuity: --system-prompt-snapshot MUST be omitted on older CLI
      const handle = await adapterA.createSession({
        cwd: tmp,
        permissionMode: 'accept_edits',
        handoffContinuity: true,
      });
      const sessionEvents: NormalizedAdapterEvent[] = [];
      handle.onEvent((ev) => sessionEvents.push(ev));
      await handle.sendTurn({ turnId: 't_old_cli', text: 'hello' });
      await waitFor(() => sessionEvents.some((e) => e.type === 'turn.completed'));
      await handle.dispose();

      const calls = fs
        .readFileSync(callsLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      const sessionCall = calls.find((c) => (c.args as string[]).includes('stream-json'));
      expect(sessionCall).toBeDefined();
      expect(sessionCall?.args as string[]).not.toContain('--system-prompt-snapshot');
      expect(sessionCall?.args as string[]).toContain('--append-system-prompt');
      expect(sessionCall).toMatchObject({
        CLAUDE_CONFIG_DIR: path.resolve(dirA),
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_AUTH_TOKEN: 'tok-a',
        ANTHROPIC_BASE_URL: 'https://gw-a.example.com',
        HARNESSMATE_LOCAL_TOKEN: null,
      });

      const probeB = calls.find((c) => c.CLAUDE_CONFIG_DIR === path.resolve(dirB));
      expect(probeB).toMatchObject({
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_AUTH_TOKEN: null,
        ANTHROPIC_BASE_URL: null,
      });
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevAuth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevAuth;
      if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prevBase;
      if (prevLocalTok === undefined) delete process.env.HARNESSMATE_LOCAL_TOKEN;
      else process.env.HARNESSMATE_LOCAL_TOKEN = prevLocalTok;
    }
  }, 25_000);

  it('replays stream-json thinking.signature redaction, cache metrics, AskUserQuestion, rate_limit_event, forkSession, and refusedBeforePrompt', async () => {
    const tmp = makeTempDir('hm-claude-replay-');
    const responsesLog = path.join(tmp, 'claude-responses.jsonl');

    const mockBin = writeReplayCliWrapper(
      tmp,
      'mock-claude-stream',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const args = process.argv.slice(2);
      if (args.includes('--fork-session') && args.includes('--resume')) {
        process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_forked_888' }) + '\\n');
        process.exit(0);
      }
      const rl = readline.createInterface({ input: process.stdin });
      let currentPrompt = '';
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.type === 'user') {
          currentPrompt = typeof msg.message?.content === 'string' ? msg.message.content : '';
          if (currentPrompt === 'sig_cache_question') {
            process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_sess_1', model: 'claude-sonnet-4-6' }) + '\\n');
            process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking', signature: 'ErcC_SECRET_SIG_DO_NOT_LEAK' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Reasoning safely.' } } }) + '\\n');
            process.stdout.write(JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'thinking', thinking: 'Reasoning safely.', signature: 'ErcC_SECRET_SIG_DO_NOT_LEAK' }] } }) + '\\n');
            process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'ask_1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which environment?', options: [{ label: 'Staging' }, { label: 'Prod' }] }] } } }) + '\\n');
          } else if (currentPrompt === 'rate_limit_case') {
            process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1.0 } }) + '\\n');
            process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Rate limit reached' }) + '\\n');
          } else if (currentPrompt === 'refused_pre_prompt') {
            process.stderr.write('Invalid flag before prompt\\n');
            process.exit(2);
          }
        } else if (msg.type === 'control_response') {
          fs.appendFileSync(${JSON.stringify(responsesLog)}, JSON.stringify(msg) + '\\n');
          process.stdout.write(JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Selected answer applied.',
            total_cost_usd: 0.015,
            usage: {
              input_tokens: 250,
              output_tokens: 80,
              cache_read_input_tokens: 600,
              cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 0 },
            },
          }) + '\\n');
        }
      });
      `,
    );

    const adapter = new ClaudeStreamJsonAdapter(mockBin);
    const handle = (await adapter.createSession({
      cwd: tmp,
      permissionMode: 'accept_edits',
    })) as ClaudeSessionHandle;
    const events: NormalizedAdapterEvent[] = [];
    handle.onEvent((ev) => events.push(ev));

    try {
      await handle.sendTurn({ turnId: 't_1', text: 'sig_cache_question' });
      const approval = await waitFor(() =>
        events.find((e) => e.type === 'approval.requested' && e.toolName === 'AskUserQuestion'),
      );
      if (approval.type === 'approval.requested') {
        await handle.resolveApproval(approval.nativeRequestId, 'allow_once', 'Staging');
      }
      await waitFor(() => events.some((e) => e.type === 'turn.completed' && e.turnId === 't_1'));

      // Thinking signature must NOT leak into thinking.completed text
      const thinkingCompleted = events.find((e) => e.type === 'thinking.completed');
      expect(thinkingCompleted && thinkingCompleted.type === 'thinking.completed' ? thinkingCompleted.text : '').toBe(
        'Reasoning safely.',
      );
      expect(JSON.stringify(thinkingCompleted)).not.toContain('ErcC_SECRET_SIG_DO_NOT_LEAK');

      const sigExt = events.find(
        (e) => e.type === 'turn_block.ext' && e.blockType === 'ext:claude.thinking_signature',
      );
      expect(sigExt).toMatchObject({ payload: { redactedSignature: true } });

      // Cache metrics ext block
      const cacheExt = events.find(
        (e) => e.type === 'turn_block.ext' && e.blockType === 'ext:claude.cache_metrics',
      );
      expect(cacheExt).toMatchObject({
        payload: {
          ephemeral5mInputTokens: 150,
          promptCacheTtlMs: 300_000,
          contextWindow: 200_000,
          autoCompactThreshold: 167_000,
        },
      });

      // AskUserQuestion answers passed back in control_response
      const ctrlResp = JSON.parse(fs.readFileSync(responsesLog, 'utf8').trim()) as {
        response: { response: { updatedInput: { answers: Record<string, string> } } };
      };
      expect(ctrlResp.response.response.updatedInput.answers['Which environment?']).toBe('Staging');

      // forkSession
      const forked = await handle.forkSession();
      expect(forked.nativeSessionId).toBe('claude_forked_888');

      // rate_limit_event -> usage_limit
      await handle.sendTurn({ turnId: 't_rl', text: 'rate_limit_case' });
      await waitFor(() => events.some((e) => e.type === 'turn.failed' && e.turnId === 't_rl'));
      expect(events.find((e) => e.type === 'turn.failed' && e.turnId === 't_rl')).toMatchObject({
        code: 'usage_limit',
      });

      // refusedBeforePrompt on non-zero exit before any prompt events
      await handle.sendTurn({ turnId: 't_refused', text: 'refused_pre_prompt' });
      await waitFor(() => events.some((e) => e.type === 'turn.failed' && e.turnId === 't_refused'));
      expect(events.find((e) => e.type === 'turn.failed' && e.turnId === 't_refused')).toMatchObject({
        code: 'refused_before_prompt',
      });
      expect(handle.getLastRefusedBeforePrompt()).toBe(true);
    } finally {
      await handle.dispose();
    }
  }, 15_000);
});
