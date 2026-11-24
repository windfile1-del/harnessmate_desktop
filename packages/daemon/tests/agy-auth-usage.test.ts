import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FailoverCoordinator } from '../src/core/failover-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import {
  AgyAuthService,
  parseAndValidateAgyLoginResponse,
  validateGoogleOAuthUrl,
} from '../src/harnesses/agy/agy-auth-service.js';
import { AgyAdapter, createAgyDriverFactory } from '../src/harnesses/agy/agy-driver.js';
import {
  DEFAULT_AGY_APP_DATA_DIR_NAME,
  createAgyLaunchContext,
} from '../src/harnesses/agy/agy-launch-context.js';
import { probeAgyUsageViaCli } from '../src/harnesses/agy/agy-usage.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type { HarnessAdapter, AdapterSessionConfig } from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];
const activeAuthServices: AgyAuthService[] = [];
const activeStores: HarnessMateStore[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeAuthServices.length > 0) {
    const svc = activeAuthServices.pop();
    await svc?.dispose().catch(() => {});
  }
  while (activeDaemons.length > 0) {
    const daemon = activeDaemons.pop();
    await daemon?.stop().catch(() => {});
  }
  while (activeStores.length > 0) {
    const st = activeStores.pop();
    try {
      st?.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

function createMockAgyBinary(tmp: string): { binaryPath: string; logPath: string } {
  const logPath = path.join(tmp, 'mock-agy-auth.log');
  const scriptPath = path.join(tmp, 'mock-agy-auth.mjs');
  const validOAuthUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=test&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&code_challenge=abc123&code_challenge_method=S256&state=state-xyz';

  fs.writeFileSync(
    scriptPath,
    `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const geminiHome = process.env.GEMINI_HOME || '';
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, geminiHome, ssh: process.env.SSH_CONNECTION || null }) + '\\n');

if (args.includes('acp') && args.includes('--login')) {
  process.stdout.write('Please visit the URL to log in:\\n${validOAuthUrl}\\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.once('line', (line) => {
    const gdIdx = args.indexOf('--gemini-dir');
    const adIdx = args.indexOf('--app-data-dir');
    const gDir = gdIdx >= 0 ? args[gdIdx + 1] : geminiHome;
    const adName = adIdx >= 0 ? args[adIdx + 1] : 'antigravity-cli';
    const tokenFile = path.join(gDir, adName, 'antigravity-oauth-token');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ code: line.trim(), ok: true }), 'utf8');
    rl.close();
    process.exit(0);
  });
} else if (args.includes('acp')) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'antigravity', version: '1.5.14' },
          agentCapabilities: { promptCapabilities: { embeddedContext: true } }
        }
      }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'native-agy-1',
          models: { currentModelId: 'gemini-3.1-pro-preview', availableModels: [{ modelId: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' }] },
          _meta: { antigravity: { tier: { name: 'Google AI Pro' } } }
        }
      }) + '\\n');
    } else if (msg.method === 'logout') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    }
  });
} else if (args.includes('/usage')) {
  process.stdout.write(JSON.stringify({
    command: {
      name: 'usage',
      data: {
        tier: 'Google AI Pro',
        account: 'alice@example.com',
        groups: [
          {
            id: 'gemini',
            name: 'Gemini',
            buckets: [{ id: 'pro', name: 'Gemini Pro', window: '5h', remaining_fraction: 0.75, reset_time: '2026-11-25T10:00:00Z' }]
          }
        ]
      }
    }
  }) + '\\n');
} else if (args.includes('--version')) {
  process.stdout.write('1.5.14\\n');
} else {
  process.exit(0);
}
`,
    'utf8',
  );

  if (process.platform === 'win32') {
    const bin = path.join(tmp, 'agy.cmd');
    fs.writeFileSync(bin, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8');
    return { binaryPath: bin, logPath };
  }
  const bin = path.join(tmp, 'agy');
  fs.writeFileSync(bin, `#!/bin/sh\nnode "${scriptPath}" "$@"\n`, 'utf8');
  fs.chmodSync(bin, 0o755);
  return { binaryPath: bin, logPath };
}

describe('AGY OAuth URL & response validation', () => {
  it('accepts official Google PKCE OAuth URL and rejects spoofed hosts or downgrade attacks', () => {
    const valid = validateGoogleOAuthUrl(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&code_challenge=xyz&code_challenge_method=S256&state=s-1',
    );
    expect(valid.state).toBe('s-1');

    expect(() =>
      validateGoogleOAuthUrl(
        'https://evil.example.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&code_challenge=xyz&code_challenge_method=S256&state=s-1',
      ),
    ).toThrow();
    expect(() =>
      validateGoogleOAuthUrl(
        'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&code_challenge=xyz&code_challenge_method=plain&state=s-1',
      ),
    ).toThrow();
    expect(() =>
      validateGoogleOAuthUrl(
        'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fattacker.test%2Fcb&code_challenge=xyz&code_challenge_method=S256&state=s-1',
      ),
    ).toThrow();
  });

  it('validates callback URL state/code/error and blocks CRLF injection', () => {
    expect(
      parseAndValidateAgyLoginResponse(
        'https://antigravity.google/oauth-callback?code=auth-123&state=s-1',
        's-1',
      ),
    ).toBe('https://antigravity.google/oauth-callback?code=auth-123&state=s-1');

    expect(() =>
      parseAndValidateAgyLoginResponse(
        'https://antigravity.google/oauth-callback?code=auth-123&state=wrong-state',
        's-1',
      ),
    ).toThrow();
    expect(() =>
      parseAndValidateAgyLoginResponse(
        'https://antigravity.google/oauth-callback?error=access_denied&state=s-1',
        's-1',
      ),
    ).toThrow();
    expect(() =>
      parseAndValidateAgyLoginResponse('code-line-1\ncode-line-2', 's-1'),
    ).toThrow();
  });
});

describe('AgyAuthService & probeAgyUsageViaCli', () => {
  it('runs startLogin -> waiting_code -> respondLogin -> authenticated -> /usage -> logout cleanly on isolated profile', async () => {
    const tmp = makeTempDir('hm-agy-auth-');
    const profilesRoot = path.join(tmp, 'agy-profiles');
    const { binaryPath } = createMockAgyBinary(tmp);

    const adapter = new AgyAdapter({
      profile: {
        instanceId: 'agy-work',
        displayName: 'AGY Work',
        isolationMode: 'profile_isolated',
        authMethod: 'oauth-personal',
        appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
        defaults: { linkGlobalSkills: false, syncGlobalRules: false, additionalDirectories: [] },
        enabled: true,
      },
      profilesRootDir: profilesRoot,
      binaryOverride: binaryPath,
      applyWindowsAcl: false,
    });

    const stateTransitions: string[] = [];
    const authService = new AgyAuthService({
      getAdapter: (id) => (id === 'agy-work' ? adapter : undefined),
      stopInstanceSessions: async () => {},
      onStateChanged: (st) => stateTransitions.push(st.phase),
    });
    activeAuthServices.push(authService);

    expect(authService.getState('agy-work').phase).toBe('unauthenticated');

    // Unauthenticated isolated profile must fast-return usage without spawning CLI
    const preUsage = await adapter.readUsageLimits();
    expect(preUsage.loggedIn).toBe(false);
    expect(preUsage.error).toContain('尚未登录');

    const started = await authService.startLogin('agy-work');
    expect(started.phase).toBe('waiting_code');
    expect(started.flowId).toBeTruthy();
    expect(started.authorizationUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');

    const finished = await authService.respondLogin(
      'agy-work',
      started.flowId!,
      'https://antigravity.google/oauth-callback?code=auth-ok&state=state-xyz',
    );
    expect(finished.phase).toBe('authenticated');
    expect(finished.identity?.tierName).toBe('Google AI Pro');
    expect(adapter.getLaunchContextSync().hasLocalTokenFile()).toBe(true);
    expect(stateTransitions).toEqual(['starting', 'waiting_code', 'verifying', 'authenticated']);

    const usage = await adapter.readUsageLimits();
    expect(usage.loggedIn).toBe(true);
    expect(usage.planType).toBe('Google AI Pro');
    expect(usage.accountLabel).toBe('alice@example.com');
    expect(usage.rateLimits).toHaveLength(1);
    expect(usage.rateLimits[0]?.usedPercent).toBe(25);

    const loggedOut = await authService.logout('agy-work');
    expect(loggedOut.phase).toBe('unauthenticated');
    expect(adapter.getLaunchContextSync().hasLocalTokenFile()).toBe(false);
  }, 15_000);

  it('requires explicit confirmation before logging out official_default shared keyring', async () => {
    const tmp = makeTempDir('hm-agy-default-logout-');
    const profilesRoot = path.join(tmp, 'agy-profiles');
    const { binaryPath } = createMockAgyBinary(tmp);

    const adapter = new AgyAdapter({
      profile: {
        instanceId: 'agy',
        displayName: 'AGY Default',
        isolationMode: 'official_default',
        authMethod: 'oauth-personal',
        appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
        defaults: { linkGlobalSkills: false, syncGlobalRules: false, additionalDirectories: [] },
        enabled: true,
      },
      profilesRootDir: profilesRoot,
      binaryOverride: binaryPath,
      applyWindowsAcl: false,
    });

    const authService = new AgyAuthService({
      getAdapter: (id) => (id === 'agy' ? adapter : undefined),
      stopInstanceSessions: async () => {},
    });
    activeAuthServices.push(authService);

    await expect(authService.logout('agy')).rejects.toThrow(/confirmSharedKeyring/);
    const res = await authService.logout('agy', { confirmSharedKeyring: true });
    expect(res.phase).toBe('unauthenticated');
  });

  it('maps probeAgyUsageViaCli error payloads gracefully', async () => {
    const tmp = makeTempDir('hm-agy-usage-unauth-');
    const ctx = createAgyLaunchContext({
      instanceId: 'agy-empty',
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      binaryPath: 'agy',
      geminiDir: path.join(tmp, 'empty'),
    });
    const res = await probeAgyUsageViaCli(ctx);
    expect(res.loggedIn).toBe(false);
    expect(res.rateLimits).toEqual([]);
  });
});

describe('FailoverCoordinator manual-only AGY switch guard', () => {
  it('forces manual-only switch between two AGY accounts while allowing cross-driver auto-failover', () => {
    const tmp = makeTempDir('hm-agy-failover-guard-');
    const store = new HarnessMateStore(path.join(tmp, 'test.db'));
    activeStores.push(store);
    const registry = new HarnessRegistry();

    const makeFakeAdapter = (id: string, kind: 'agy' | 'codex' | 'claude'): HarnessAdapter => ({
      id,
      kind,
      driverId: kind,
      displayName: id,
      description: id,
      protocolLabel: 'test',
      capabilities: {
        streaming: true,
        interactiveApproval: true,
        reasoningEfforts: [],
        permissionModes: ['manual'],
        sessionResume: false,
        sessionFork: false,
        imageInput: false,
        subagents: false,
      },
      probePassive: async () => ({
        id,
        kind,
        displayName: id,
        description: id,
        protocolLabel: 'test',
        binaryPath: null,
        version: null,
        health: 'ready',
        capabilities: {
          streaming: true,
          interactiveApproval: true,
          reasoningEfforts: [],
          permissionModes: ['manual'],
          sessionResume: false,
          sessionFork: false,
          imageInput: false,
          subagents: false,
        },
        models: [],
        defaultModelId: null,
      }),
      probe: async () => {
        throw new Error('unused');
      },
      createSession: async (_cfg: AdapterSessionConfig) => {
        throw new Error('unused');
      },
    });

    registry.registerDriver('agy', createAgyDriverFactory({ profilesRootDir: path.join(tmp, 'agy') }));
    registry.registerInstance({ instanceId: 'agy', driverId: 'agy', displayName: 'AGY Main', enabled: true });
    registry.registerInstance({ instanceId: 'agy-alt', driverId: 'agy', displayName: 'AGY Alt', enabled: true });
    registry.register(makeFakeAdapter('codex', 'codex'));
    registry.register(makeFakeAdapter('claude', 'claude'));

    const coordinator = new FailoverCoordinator(store, registry, () => undefined);
    coordinator.setPolicy({
      mode: 'auto_any',
      priorityChain: ['agy-alt', 'claude'],
      maxAutoSwitchesPerSession: 3,
    });

    const agyToAgy = coordinator.recommendFailover('sess-1', 'agy', 'usage_limit', {
      unavailableInstances: new Set(['claude', 'codex']),
    });
    expect(agyToAgy.recommendedInstanceId).toBe('agy-alt');
    expect(agyToAgy.canAutoFailover).toBe(false);
    expect(agyToAgy.downgradedToManualReason).toContain('禁止自动额度轮换');

    const codexToClaude = coordinator.recommendFailover('sess-2', 'codex', 'usage_limit', {
      unavailableInstances: new Set(['agy', 'agy-alt']),
    });
    expect(codexToClaude.recommendedInstanceId).toBe('claude');
    expect(codexToClaude.canAutoFailover).toBe(true);
    store.close();
  });
});

describe('Daemon HTTP routes for AGY instance CRUD & auth state', () => {
  it('creates, lists, inspects auth state, and deletes isolated AGY profiles cleanly', async () => {
    const tmp = makeTempDir('hm-agy-http-');
    const dataDir = path.join(tmp, 'data');
    const { binaryPath } = createMockAgyBinary(tmp);

    const daemon = createDaemon({
      dataDir,
      port: 0,
      binaryOverrides: { agy: binaryPath },
    });
    activeDaemons.push(daemon);
    await daemon.start();

    const createRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/agy/instances',
      payload: {
        instanceId: 'agy-personal',
        displayName: 'AGY Personal',
        authMethod: 'oauth-personal',
      },
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json() as {
      profile: { instanceId: string; isolationMode: string };
      authState: { phase: string };
    };
    expect(created.profile.instanceId).toBe('agy-personal');
    expect(created.profile.isolationMode).toBe('profile_isolated');
    expect(created.authState.phase).toBe('unauthenticated');

    const listRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/harnesses/agy/instances',
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json() as { instances: Array<{ profile: { instanceId: string } }> };
    expect(listBody.instances.map((i) => i.profile.instanceId)).toContain('agy-personal');

    const authStateRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/harnesses/agy/instances/agy-personal/auth/state',
    });
    expect(authStateRes.statusCode).toBe(200);
    expect((authStateRes.json() as { state: { phase: string } }).state.phase).toBe('unauthenticated');

    // Cannot hijack reserved harness IDs or delete primary 'agy'
    const hijackRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/harnesses/agy/instances',
      payload: { instanceId: 'codex', displayName: 'Bad' },
    });
    expect(hijackRes.statusCode).toBe(409);

    const delPrimary = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/v1/harnesses/agy/instances/agy',
    });
    expect(delPrimary.statusCode).toBe(400);

    const delRes = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/v1/harnesses/agy/instances/agy-personal?purgeData=1',
    });
    expect(delRes.statusCode).toBe(200);
    expect((delRes.json() as { deleted: boolean }).deleted).toBe(true);
  }, 20_000);
});
