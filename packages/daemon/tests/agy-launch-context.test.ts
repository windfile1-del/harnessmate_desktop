import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../src/harnesses/acp-adapter.js';
import {
  AGY_SSH_COMPAT_CONNECTION,
  AGY_STRIP_ENV_KEYS,
  DEFAULT_AGY_APP_DATA_DIR_NAME,
  createAgyLaunchContext,
} from '../src/harnesses/agy/agy-launch-context.js';
import {
  prepareAgyProfile,
  resolveAgyProfileDirectories,
  resolveManagedProfilePathSync,
} from '../src/harnesses/agy/agy-profile-manager.js';
import {
  AgyAdapter,
  classifyAgyModelGroup,
  createAgyDriverFactory,
} from '../src/harnesses/agy/agy-driver.js';
import { AgyAuthRequiredError, inspectAgyCommand } from '../src/harnesses/agy-commands.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';

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

describe('AgyLaunchContext', () => {
  it('strips leaked secrets and applies SSH_CONNECTION only for profile_isolated + oauth-personal', () => {
    const root = makeTempDir('hm-agy-ctx-');
    const dirs = resolveAgyProfileDirectories(root, 'agy-work');

    const isolatedPersonal = createAgyLaunchContext({
      instanceId: 'agy-work',
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      binaryPath: 'agy',
      geminiDir: dirs.geminiDir,
      runtimeTempDir: dirs.runtimeTempDir,
      platform: 'win32',
    });

    const baseEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      GEMINI_API_KEY: 'leaked-gemini-key',
      GOOGLE_API_KEY: 'leaked-google-key',
      GEMINI_HOME: 'C:\\stale\\gemini',
      AGY_ACP_FORCE_FILE_STORAGE: '9',
      HARNESSMATE_LOCAL_TOKEN: 'leaked-token',
      KEEP_SAFE_VAR: 'ok',
    };

    const personalBuilt = isolatedPersonal.buildEnv({
      baseEnv,
      extraEnv: { GEMINI_API_KEY: 'blocked-extra-secret', KEEP_SAFE_VAR: 'ok' },
    });
    for (const strippedKey of AGY_STRIP_ENV_KEYS) {
      expect(personalBuilt.unsetEnv).toContain(strippedKey);
      if (
        strippedKey !== 'GEMINI_HOME' &&
        strippedKey !== 'SSH_CONNECTION' &&
        strippedKey !== 'AGY_ACP_FORCE_FILE_STORAGE' &&
        strippedKey !== 'AGY_CLI_DISABLE_AUTO_UPDATE'
      ) {
        expect(personalBuilt.env[strippedKey]).toBeUndefined();
      }
    }
    expect(personalBuilt.env.GEMINI_HOME).toBe(dirs.geminiDir);
    expect(personalBuilt.env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1');
    expect(personalBuilt.env.SSH_CONNECTION).toBe(AGY_SSH_COMPAT_CONNECTION);
    expect(personalBuilt.env.KEEP_SAFE_VAR).toBe('ok');
    expect(personalBuilt.env.TEMP).toBe(dirs.runtimeTempDir);
    expect(personalBuilt.env.TMP).toBe(dirs.runtimeTempDir);

    const isolatedBusiness = createAgyLaunchContext({
      instanceId: 'agy-biz',
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-business',
      binaryPath: 'agy',
      geminiDir: dirs.geminiDir,
      runtimeTempDir: dirs.runtimeTempDir,
      platform: 'win32',
    });
    const businessBuilt = isolatedBusiness.buildEnv({
      baseEnv: { ...baseEnv, SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' },
    });
    expect(businessBuilt.env.SSH_CONNECTION).toBeUndefined();

    const officialDefault = createAgyLaunchContext({
      instanceId: 'agy',
      isolationMode: 'official_default',
      authMethod: 'oauth-personal',
      binaryPath: 'agy',
      geminiDir: path.join(root, 'default-gemini'),
      platform: 'win32',
    });
    const officialBuilt = officialDefault.buildEnv({
      baseEnv: { ...baseEnv, SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' },
    });
    expect(officialBuilt.env.SSH_CONNECTION).toBeUndefined();
    expect(officialBuilt.env.GEMINI_HOME).toBeUndefined();
    expect(officialBuilt.env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
  });

  it('builds consistent ACP args (including login vs runtime) and omits ACP-only flags from top-level CLI args', () => {
    const root = makeTempDir('hm-agy-args-');
    const ctx = createAgyLaunchContext({
      instanceId: 'agy-a',
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      binaryPath: 'agy',
      geminiDir: path.join(root, 'agy-a', 'gemini'),
      appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
    });

    const acpRuntimeArgs = ctx.buildAcpArgs({
      additionalDirectories: ['/repo/extra'],
      sandbox: true,
    });
    expect(acpRuntimeArgs).toContain('acp');
    expect(acpRuntimeArgs).toContain('--stdio');
    expect(acpRuntimeArgs).toContain('--gemini-dir');
    expect(acpRuntimeArgs).toContain(path.join(root, 'agy-a', 'gemini'));
    expect(acpRuntimeArgs).toContain('--app-data-dir');
    expect(acpRuntimeArgs).toContain(DEFAULT_AGY_APP_DATA_DIR_NAME);
    expect(acpRuntimeArgs).toContain('--sandbox');
    expect(acpRuntimeArgs).toContain('--add-dir');
    expect(acpRuntimeArgs).toContain('/repo/extra');

    const acpLoginArgs = ctx.buildAcpArgs({ login: true });
    expect(acpLoginArgs).toContain('acp');
    expect(acpLoginArgs).toContain('--login');
    expect(acpLoginArgs).not.toContain('--stdio');
    expect(acpLoginArgs).toContain('--gemini-dir');
    expect(acpLoginArgs).toContain('--app-data-dir');

    const cliArgs = ctx.buildCliArgs(['-p', '/usage', '--output-format', 'json']);
    expect(cliArgs).toEqual(['-p', '/usage', '--output-format', 'json']);
    expect(cliArgs).not.toContain('--gemini-dir');
    expect(cliArgs).not.toContain('--app-data-dir');
  });
});

describe('AgyProfileManager', () => {
  it('prepares isolated directory layout, preserves settings & local rule edits, and guards managed paths', () => {
    const tmp = makeTempDir('hm-agy-prof-');
    const profilesRoot = path.join(tmp, 'agy-profiles');
    const userHome = path.join(tmp, 'user-home');

    // Populate global AGY files
    const globalGemini = path.join(userHome, '.gemini');
    const globalSkills = path.join(globalGemini, 'skills', 'demo-skill');
    fs.mkdirSync(globalSkills, { recursive: true });
    fs.writeFileSync(path.join(globalSkills, 'SKILL.md'), '# Demo Skill', 'utf8');
    fs.writeFileSync(path.join(globalGemini, 'AGENTS.md'), '# Global Agents v1', 'utf8');
    fs.writeFileSync(path.join(globalGemini, 'GEMINI.md'), '# Global Gemini v1', 'utf8');
    fs.mkdirSync(path.join(globalGemini, 'config'), { recursive: true });
    fs.writeFileSync(path.join(globalGemini, 'config', 'skills.json'), '{"enabled":true}', 'utf8');

    const profileDirs = resolveAgyProfileDirectories(profilesRoot, 'agy-alpha');
    const initialAppDataPath = path.join(profileDirs.geminiDir, DEFAULT_AGY_APP_DATA_DIR_NAME);
    fs.mkdirSync(initialAppDataPath, { recursive: true });
    fs.writeFileSync(
      path.join(initialAppDataPath, 'settings.json'),
      JSON.stringify({ theme: 'dark', auth: { type: 'stale' } }),
      'utf8',
    );

    const profileCfg = {
      instanceId: 'agy-alpha',
      displayName: 'Alpha Account',
      isolationMode: 'profile_isolated' as const,
      authMethod: 'oauth-personal' as const,
      appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
      enabled: true,
      defaults: {
        defaultPermissionMode: 'manual' as const,
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: [],
      },
    };

    const prepared = prepareAgyProfile(profileCfg, {
      profilesRootDir: profilesRoot,
      userHome,
      applyWindowsAcl: false,
    });

    expect(prepared.geminiDir).toBe(profileDirs.geminiDir);
    expect(fs.existsSync(prepared.runtimeTempDir)).toBe(true);

    // Non-auth settings preserved while auth.type updated without storing any secret token
    const settingsPath = path.join(prepared.appDataPath, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      theme?: string;
      auth?: { type?: string };
    };
    expect(settings.theme).toBe('dark');
    expect(settings.auth?.type).toBe('oauth-personal');

    // Global skill is linked/accessible and rule files are synced
    expect(
      fs.existsSync(path.join(prepared.geminiDir, 'skills', 'demo-skill', 'SKILL.md')),
    ).toBe(true);
    expect(fs.readFileSync(path.join(prepared.geminiDir, 'AGENTS.md'), 'utf8')).toBe(
      '# Global Agents v1',
    );

    // Local edit to AGENTS.md must not be overwritten on subsequent prepare
    fs.writeFileSync(path.join(prepared.geminiDir, 'AGENTS.md'), '# Profile Custom Edit', 'utf8');
    fs.writeFileSync(path.join(globalGemini, 'AGENTS.md'), '# Global Agents v2', 'utf8');
    prepareAgyProfile(profileCfg, {
      profilesRootDir: profilesRoot,
      userHome,
      applyWindowsAcl: false,
    });
    expect(fs.readFileSync(path.join(prepared.geminiDir, 'AGENTS.md'), 'utf8')).toBe(
      '# Profile Custom Edit',
    );

    // Path traversal & symlink safety checks
    expect(
      resolveManagedProfilePathSync(prepared.geminiDir, ['..', 'escape.txt'], 'file'),
    ).toBeUndefined();
    expect(
      resolveManagedProfilePathSync(
        prepared.geminiDir,
        [prepared.appDataDirName, 'settings.json'],
        'file',
      )?.path,
    ).toBe(fs.realpathSync(settingsPath));
  });
});

describe('inspectAgyCommand auth pre-check and stderr fast-abort', () => {
  it('throws AgyAuthRequiredError immediately without spawning when isolated profile has no token file', async () => {
    const tmp = makeTempDir('hm-agy-cmd-precheck-');
    const callsLog = path.join(tmp, 'calls.log');
    const scriptPath = path.join(tmp, 'mock-agy.mjs');
    fs.writeFileSync(
      scriptPath,
      `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(callsLog)}, 'called\\n');`,
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

    const ctx = createAgyLaunchContext({
      instanceId: 'agy-unauth',
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      binaryPath: mockBin,
      geminiDir: path.join(tmp, 'empty-gemini'),
    });

    await expect(
      inspectAgyCommand(mockBin, tmp, '/usage', { launchContext: ctx }),
    ).rejects.toBeInstanceOf(AgyAuthRequiredError);
    expect(fs.existsSync(callsLog)).toBe(false);
  });

  it('fast-aborts with AgyAuthRequiredError when CLI prints Authentication required on stderr', async () => {
    const tmp = makeTempDir('hm-agy-cmd-stderr-');
    const geminiDir = path.join(tmp, 'gemini');
    const ctx = createAgyLaunchContext({
      instanceId: 'agy-auth-prompt',
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      binaryPath: 'agy',
      geminiDir,
    });
    fs.mkdirSync(path.dirname(ctx.tokenFilePath), { recursive: true });
    fs.writeFileSync(ctx.tokenFilePath, '{}', 'utf8');

    const spawnedFlag = path.join(tmp, 'spawned.flag');
    const scriptPath = path.join(tmp, 'mock-agy-hanging.mjs');
    fs.writeFileSync(
      scriptPath,
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(spawnedFlag)}, '1');
process.stderr.write('Authentication required: Please login first\\n');
setTimeout(() => {}, 15000);`,
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

    const started = Date.now();
    await expect(
      inspectAgyCommand(mockBin, tmp, '/usage', { launchContext: ctx }),
    ).rejects.toBeInstanceOf(AgyAuthRequiredError);
    expect(fs.existsSync(spawnedFlag)).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });
});

describe('AgyDriver & HarnessRegistry integration', () => {
  it('classifies orchestrator/provider model groups, keeps AgyAdapter instanceof AcpAdapter, and registers multiple isolated instances', async () => {
    const tmp = makeTempDir('hm-agy-driver-');
    const profilesRoot = path.join(tmp, 'agy-profiles');
    const fakeBin = path.join(tmp, process.platform === 'win32' ? 'agy.cmd' : 'agy');
    fs.writeFileSync(fakeBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') {
      fs.chmodSync(fakeBin, 0o755);
    }

    expect(classifyAgyModelGroup('gemini-pro-orchestrator-v1')).toBe(
      'Orchestrator (Planner + Executor)',
    );
    expect(classifyAgyModelGroup('gemini-3.1-pro-preview')).toBe('Google Gemini');
    expect(classifyAgyModelGroup('claude-sonnet-4-6')).toBe('Anthropic Claude (via AGY)');
    expect(classifyAgyModelGroup('gpt-5-codex')).toBe('OpenAI (via AGY)');
    expect(classifyAgyModelGroup('custom-model')).toBe('Other Models');

    const registry = new HarnessRegistry();
    registry.registerDriver(
      'agy',
      createAgyDriverFactory({
        profilesRootDir: profilesRoot,
        binaryOverride: fakeBin,
      }),
    );

    const instA = registry.registerInstance({
      instanceId: 'agy-a',
      driverId: 'agy',
      displayName: 'AGY Account A',
      enabled: true,
    });
    const instB = registry.registerInstance({
      instanceId: 'agy-b',
      driverId: 'agy',
      displayName: 'AGY Account B',
      enabled: true,
    });

    expect(instA).toBeInstanceOf(AgyAdapter);
    expect(instA).toBeInstanceOf(AcpAdapter);
    expect(instB).toBeInstanceOf(AgyAdapter);

    const ctxA = (instA as AgyAdapter).getLaunchContextSync();
    const ctxB = (instB as AgyAdapter).getLaunchContextSync();
    expect(ctxA.geminiDir).not.toBe(ctxB.geminiDir);

    expect(instA.continuationKey).toBeDefined();
    expect(instB.continuationKey).toBeDefined();
    expect(instA.continuationKey).not.toBe(instB.continuationKey);

    const passiveA = await (instA as AgyAdapter).probePassive();
    expect(passiveA.binaryPath).not.toBeNull();
    expect(passiveA.health).toBe('unauthenticated');
    expect(registry.listAdapters().map((a) => a.id)).toEqual(['agy-a', 'agy-b']);
  });
});
