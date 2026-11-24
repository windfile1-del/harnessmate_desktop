import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgyModelEffortCache,
  buildAgySessionRestorePatch,
  extractThoughtLevelsFromConfigOptions,
  resolveAgyTurnConfig,
} from '../src/harnesses/agy/agy-config-scope.js';
import { AgyAdapter, AntigravityAcpFlavorPolicy } from '../src/harnesses/agy/agy-driver.js';
import { DEFAULT_AGY_APP_DATA_DIR_NAME } from '../src/harnesses/agy/agy-launch-context.js';
import type { NormalizedAdapterEvent } from '../src/harnesses/types.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

describe('3-tier AGY config scope resolver', () => {
  it('merges AccountDefaults < Session < Turn and computes restore patch', () => {
    const resolved = resolveAgyTurnConfig({
      accountDefaults: {
        defaultModel: 'gemini-pro-orchestrator-neon',
        defaultEffort: 'medium',
        defaultPermissionMode: 'accept_edits',
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: [],
      },
      session: {
        model: 'gemini-3.1-pro-preview',
      },
      turn: {
        reasoningEffort: 'xhigh',
        permissionMode: 'plan',
      },
    });

    expect(resolved.hasTurnOverrides).toBe(true);
    expect(resolved.effectiveRequested.model).toBe('gemini-3.1-pro-preview');
    expect(resolved.effectiveRequested.reasoningEffort).toBe('xhigh');
    expect(resolved.effectiveRequested.permissionMode).toBe('plan');

    const restore = buildAgySessionRestorePatch({
      accountDefaults: {
        defaultModel: 'gemini-pro-orchestrator-neon',
        defaultEffort: 'medium',
        defaultPermissionMode: 'accept_edits',
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: [],
      },
      session: {
        model: 'gemini-3.1-pro-preview',
      },
      turn: {
        reasoningEffort: 'xhigh',
        permissionMode: 'plan',
      },
    });
    expect(restore).toEqual({
      reasoningEffort: 'medium',
      permissionMode: 'accept_edits',
    });

    const noTurnRestore = buildAgySessionRestorePatch({
      accountDefaults: {
        defaultModel: 'gemini-pro-orchestrator-neon',
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: [],
      },
      session: { model: 'gemini-pro-orchestrator-neon' },
    });
    expect(noTurnRestore).toBeNull();
  });

  it('extracts and caches per-model thought levels from backend configOptions', () => {
    const cache = new AgyModelEffortCache();
    const opts = [
      {
        id: 'thought_level',
        currentValue: 'high',
        options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    ];
    expect(extractThoughtLevelsFromConfigOptions(opts)).toEqual({
      currentLevel: 'high',
      availableLevels: ['low', 'medium', 'high', 'xhigh'],
    });
    cache.recordFromConfigOptions('gemini-3.1-pro-preview', opts);
    expect(cache.get('gemini-3.1-pro-preview')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});

describe('AntigravityAcpFlavorPolicy honesty & security metadata', () => {
  it('honestly marks auto as client_guard when backend does not advertise auto mode', () => {
    const policy = new AntigravityAcpFlavorPolicy();
    expect(policy.shouldEmitAvailableCommandsAsBlock()).toBe(false);

    const degraded = policy.resolveModeWithEnforcement(
      'auto',
      [{ id: 'default' }, { id: 'plan' }, { id: 'accept-edits' }],
      'auto',
    );
    expect(degraded).toEqual({ modeId: 'default', enforcement: 'client_guard' });

    const nativeAuto = policy.resolveModeWithEnforcement(
      'auto',
      [{ id: 'default' }, { id: 'auto' }, { id: 'plan' }],
      'auto',
    );
    expect(nativeAuto).toEqual({ modeId: 'auto', enforcement: 'native' });

    const warning = policy.extractPermissionSecurityWarning([
      {
        optionId: 'allow_once',
        kind: 'allow_once',
        _meta: { 'agy.security.warning': 'Command modifies files outside workspace' },
      },
    ]);
    expect(warning).toBe('Command modifies files outside workspace');
  });
});

describe('AgyAdapter live ACP dynamic thinking, commands & config confirmation', () => {
  it('tracks config.confirmed, per-model thought_level cache, and commands.updated without emitting chat command blocks', async () => {
    const tmp = makeTempDir('hm-agy-cfg-');
    const profilesRoot = path.join(tmp, 'profiles');
    const scriptPath = path.join(tmp, 'mock-agy-cfg.mjs');

    fs.writeFileSync(
      scriptPath,
      `
import readline from 'node:readline';

let currentModel = 'gemini-pro-orchestrator-neon';
let currentThought = 'medium';
function buildConfigOptions() {
  if (currentModel === 'gemini-3.1-pro-preview') {
    return [
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: currentModel,
        options: [
          { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator Neon' },
          { value: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' }
        ]
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        type: 'select',
        currentValue: currentThought,
        options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }]
      }
    ];
  }
  return [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: [
        { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator Neon' },
        { value: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' }
      ]
    },
    {
      id: 'thought_level',
      category: 'thought_level',
      type: 'select',
      currentValue: currentThought,
      options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
    }
  ];
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: 1, agentInfo: { name: 'antigravity', version: '1.5.14' }, agentCapabilities: {} }
    }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'agy-sess-cfg-1',
        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'plan' }, { id: 'accept-edits' }] },
        configOptions: buildConfigOptions(),
        _meta: { antigravity: { tier: { name: 'Google AI Pro' } } }
      }
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'agy-sess-cfg-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'review', description: 'Run AGY code review', input: { hint: '[scope]' } },
            { name: 'compact', description: 'Compact context' }
          ]
        }
      }
    }) + '\\n');
  } else if (msg.method === 'session/set_config_option') {
    if (msg.params?.configId === 'model') {
      currentModel = msg.params.value;
      currentThought = currentModel === 'gemini-3.1-pro-preview' ? 'high' : 'medium';
    } else if (msg.params?.configId === 'thought_level') {
      currentThought = msg.params.value;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { configOptions: buildConfigOptions() }
    }) + '\\n');
  } else if (msg.method === 'session/set_mode') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
`,
      'utf8',
    );

    const mockBin =
      process.platform === 'win32'
        ? (() => {
            const p = path.join(tmp, 'mock-agy.cmd');
            fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8');
            return p;
          })()
        : (() => {
            const p = path.join(tmp, 'mock-agy');
            fs.writeFileSync(p, `#!/bin/sh\nnode "${scriptPath}" "$@"\n`, 'utf8');
            fs.chmodSync(p, 0o755);
            return p;
          })();

    const adapter = new AgyAdapter({
      profile: {
        instanceId: 'agy',
        displayName: 'AGY',
        isolationMode: 'official_default',
        authMethod: 'oauth-personal',
        appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
        defaults: {
          defaultModel: 'gemini-pro-orchestrator-neon',
          defaultEffort: 'medium',
          defaultPermissionMode: 'auto',
          linkGlobalSkills: false,
          syncGlobalRules: false,
          additionalDirectories: [],
        },
        enabled: true,
      },
      profilesRootDir: profilesRoot,
      binaryOverride: mockBin,
      applyWindowsAcl: false,
    });

    const events: NormalizedAdapterEvent[] = [];
    const handle = await adapter.createSession({
      cwd: tmp,
      permissionMode: 'auto',
    });
    handle.onEvent((ev) => events.push(ev));

    // Allow async available_commands_update notification to flush
    await new Promise((r) => setTimeout(r, 150));

    expect(events.some((e) => e.type === 'turn_block.ext' && e.blockType === 'ext:acp.available_commands')).toBe(
      false,
    );
    expect(events.some((e) => e.type === 'commands.updated')).toBe(true);
    expect(adapter.getAdvertisedCommands().map((c) => c.name)).toEqual(['review', 'compact']);

    const initialCfgEvent = [...events].reverse().find((e) => e.type === 'config.confirmed');
    expect(initialCfgEvent).toBeDefined();
    if (initialCfgEvent?.type === 'config.confirmed') {
      expect(initialCfgEvent.model).toBe('gemini-pro-orchestrator-neon');
      expect(initialCfgEvent.thoughtLevel).toBe('medium');
      expect(initialCfgEvent.permissionEnforcement).toBe('client_guard');
    }

    await handle.updateConfig?.({
      model: 'gemini-3.1-pro-preview',
      reasoningEffort: 'xhigh',
    });

    const updatedCfgEvent = [...events].reverse().find((e) => e.type === 'config.confirmed');
    expect(updatedCfgEvent).toBeDefined();
    if (updatedCfgEvent?.type === 'config.confirmed') {
      expect(updatedCfgEvent.model).toBe('gemini-3.1-pro-preview');
      expect(updatedCfgEvent.thoughtLevel).toBe('xhigh');
      expect(updatedCfgEvent.availableThoughtLevels).toEqual(['low', 'high', 'xhigh']);
    }
    expect(adapter.getObservedEffortsForModel('gemini-3.1-pro-preview')).toEqual([
      'low',
      'high',
      'xhigh',
    ]);

    await handle.dispose();
  }, 15_000);
});
