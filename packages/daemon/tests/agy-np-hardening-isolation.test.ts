import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgyProfileConfig,
} from '@harnessmate/protocol';
import { FailoverCoordinator } from '../src/core/failover-service.js';
import { OrchestratorError, OrchestratorService } from '../src/core/orchestrator-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { listAgySessionArtifacts, readAgySessionArtifact } from '../src/harnesses/agy/agy-artifacts.js';
import { validateGoogleOAuthUrl } from '../src/harnesses/agy/agy-auth-service.js';
import { AgyAdapter } from '../src/harnesses/agy/agy-driver.js';
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
  AgyConsumerProvenanceError,
  assertAgyConsumerProvenance,
  evaluateAgyConsumerProvenance,
  mintAgyDispatchProvenance,
} from '../src/harnesses/agy/native/wiring/index.js';
import { readAgyIndexedHistoryDetailedFromRoot } from '../src/harnesses/history-scanner.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type { HarnessAdapter, NormalizedAdapterEvent } from '../src/harnesses/types.js';

const tempDirs: string[] = [];
const openStores: HarnessMateStore[] = [];

function makeTempDir(prefix: string): string {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeJunction(targetDir: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

function makeFakeCodexAdapter(id = 'codex'): HarnessAdapter {
  return {
    id,
    kind: 'codex',
    driverId: 'codex',
    displayName: 'Codex',
    description: 'Fake Codex',
    protocolLabel: 'fake',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium'],
      permissionModes: ['manual'],
      sessionResume: false,
      sessionFork: false,
      imageInput: false,
      subagents: false,
    },
    async probe() {
      return {
        id,
        kind: 'codex',
        driverId: 'codex',
        displayName: 'Codex',
        description: 'Fake Codex',
        protocolLabel: 'fake',
        binaryPath: 'codex',
        version: '1.0.0',
        health: 'ready',
        capabilities: this.capabilities,
        models: [],
        defaultModelId: null,
        accountSummary: null,
      };
    },
    async createSession() {
      let listener: ((ev: NormalizedAdapterEvent) => void) | undefined;
      return {
        nativeSessionId: 'codex_fake_1',
        onEvent(fn) {
          listener = fn;
          return () => {
            listener = undefined;
          };
        },
        async sendTurn({ turnId }) {
          listener?.({ type: 'turn.started', turnId });
          listener?.({ type: 'turn.failed', turnId, code: 'usage_limit', message: 'rate limit 429' });
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
      };
    },
  };
}

function makeStubOAuthAgyAdapter(
  profilesRootDir: string,
  instanceId: string,
  authMethod: 'oauth-personal' | 'gemini-api-key' = 'oauth-personal',
  turnLog: Array<{ turnId: string; text: string }> = [],
): AgyAdapter {
  const adapter = new AgyAdapter({
    profile: {
      instanceId,
      displayName: `AGY (${instanceId})`,
      isolationMode: 'profile_isolated',
      authMethod,
      appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
      defaults: {
        linkGlobalSkills: false,
        syncGlobalRules: false,
        additionalDirectories: [],
      },
      enabled: true,
    },
    profilesRootDir,
    applyWindowsAcl: false,
  });

  adapter.probe = async () => ({
    id: instanceId,
    kind: 'agy',
    driverId: 'agy',
    instanceId,
    displayName: `AGY (${instanceId})`,
    description: 'Stub OAuth AGY Adapter',
    protocolLabel: 'ACP',
    binaryPath: 'agy.exe',
    version: '1.5.17',
    health: 'ready',
    capabilities: adapter.capabilities,
    models: [{ id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportsReasoningEffort: true }],
    defaultModelId: 'gemini-3.8-flash',
    accountSummary: null,
    isCustom: instanceId !== 'agy',
  });

  adapter.createSession = async () => {
    let listener: ((ev: NormalizedAdapterEvent) => void) | undefined;
    return {
      nativeSessionId: `nat_${instanceId}_1`,
      onEvent(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      async sendTurn({ turnId, text }) {
        turnLog.push({ turnId, text });
        listener?.({ type: 'turn.started', turnId });
        listener?.({ type: 'message.assistant.delta', turnId, text: 'stub ok' });
        listener?.({ type: 'turn.completed', turnId });
      },
      async interrupt() {},
      async resolveApproval() {},
      async setPermissionMode() {},
      async dispose() {},
    };
  };

  return adapter;
}

afterEach(async () => {
  while (openStores.length > 0) {
    openStores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Ignore transient Windows handle lock on temp dir teardown
      }
    }
  }
});

describe('NP-16 T15 · Windows Profile Isolation, Auth Separation, Junction/Path Boundaries & Immutable Reads', () => {
  it('separates multiple profiles with identical displayName, strips host auth env, and gates unauthenticated oauth-personal launch', () => {
    const tmp = makeTempDir('hm-np16-prof-');
    const profilesRoot = path.join(tmp, 'profiles');
    const userHome = path.join(tmp, 'home');

    const profileA: AgyProfileConfig = {
      instanceId: 'agy-account-a',
      displayName: 'Personal Google Account',
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
      defaults: { linkGlobalSkills: false, syncGlobalRules: false, additionalDirectories: [] },
      enabled: true,
    };
    const profileB: AgyProfileConfig = {
      ...profileA,
      instanceId: 'agy-account-b',
      displayName: 'Personal Google Account', // identical displayName must stay strictly isolated
    };

    const prepA = prepareAgyProfile(profileA, { profilesRootDir: profilesRoot, userHome, applyWindowsAcl: false });
    const prepB = prepareAgyProfile(profileB, { profilesRootDir: profilesRoot, userHome, applyWindowsAcl: false });
    expect(prepA.geminiDir).not.toBe(prepB.geminiDir);

    const ctxA = createAgyLaunchContext({
      instanceId: profileA.instanceId,
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      binaryPath: 'agy.exe',
      geminiDir: prepA.geminiDir,
      runtimeTempDir: prepA.runtimeTempDir,
      platform: 'win32',
    });
    const ctxB = createAgyLaunchContext({
      instanceId: profileB.instanceId,
      isolationMode: 'profile_isolated',
      authMethod: 'oauth-personal',
      binaryPath: 'agy.exe',
      geminiDir: prepB.geminiDir,
      runtimeTempDir: prepB.runtimeTempDir,
      platform: 'win32',
    });

    // Place token only in profileA; profileB must remain unauthenticated
    fs.mkdirSync(prepA.appDataPath, { recursive: true });
    fs.writeFileSync(path.join(prepA.appDataPath, 'antigravity-oauth-token'), 'synthetic_tok_a', 'utf8');
    expect(ctxA.hasLocalTokenFile()).toBe(true);
    expect(ctxB.hasLocalTokenFile()).toBe(false);

    const built = ctxB.buildEnv({
      baseEnv: {
        PATH: process.env.PATH,
        GEMINI_API_KEY: 'host-leaked-api-key',
        GEMINI_CLI_OAUTH_TOKEN: 'host-leaked-oauth-token',
        GOOGLE_APPLICATION_CREDENTIALS: 'C:\\victim\\creds.json',
      },
      extraEnv: { GEMINI_API_KEY: 'extra-blocked' },
    });
    for (const k of AGY_STRIP_ENV_KEYS) {
      expect(built.unsetEnv).toContain(k);
    }
    expect(built.env.GEMINI_API_KEY).toBeUndefined();
    expect(built.env.GEMINI_CLI_OAUTH_TOKEN).toBeUndefined();
    expect(built.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(built.env.GEMINI_HOME).toBe(prepB.geminiDir);
    expect(built.env.SSH_CONNECTION).toBe(AGY_SSH_COMPAT_CONNECTION);

    // OAuth URL guard blocks spoofed origins and plain PKCE downgrade
    expect(() =>
      validateGoogleOAuthUrl(
        'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fevil.invalid&code_challenge=c&code_challenge_method=S256&state=s',
      ),
    ).toThrow();
    expect(() =>
      validateGoogleOAuthUrl(
        'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&code_challenge=c&code_challenge_method=plain&state=s',
      ),
    ).toThrow();
  });

  it('opens AGY SQLite read-only (?immutable=1) without creating WAL/SHM side effects and blocks Windows junctions in history/artifacts', () => {
    const tmp = makeTempDir('hm-np16-imm-');
    const agyRoot = path.join(tmp, 'agy-cli');
    const outsideDir = path.join(tmp, 'outside-secret');
    fs.mkdirSync(agyRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const convId = '11111111-2222-4333-8444-555555555555';
    const dbPath = path.join(agyRoot, 'conversation_summaries.db');
    const extDb = new DatabaseSync(dbPath);
    extDb.exec(`
      CREATE TABLE conversations_fts (
        conversation_id TEXT,
        chunk_index INTEGER,
        user_body TEXT,
        agent_body TEXT,
        user_step_byte_offsets TEXT,
        agent_step_byte_offsets TEXT
      );
      INSERT INTO conversations_fts VALUES (
        '${convId}',
        0,
        'Hello AGY',
        'Hi from immutable',
        '[[0,0]]',
        '[[1,0]]'
      );
    `);
    extDb.close();

    // Ensure no -wal / -shm exist before read, and none are created after read
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    const readRes = readAgyIndexedHistoryDetailedFromRoot(agyRoot, convId);
    expect(readRes.rootVerified).toBe(true);
    expect(readRes.messages.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    // Brain artifacts & traversal/junction defense
    const brainSess = path.join(agyRoot, 'brain', 'sess_safe');
    fs.mkdirSync(brainSess, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'leak.md'), '# SECRET', 'utf8');
    fs.writeFileSync(path.join(brainSess, 'plan.md'), '# Safe Plan', 'utf8');
    fs.writeFileSync(path.join(brainSess, 'xss.html'), '<script>alert(1)</script>', 'utf8');
    fs.writeFileSync(path.join(brainSess, 'bad_nul.txt'), Buffer.from('ok\x00bin'));

    const artifacts = listAgySessionArtifacts(agyRoot, 'sess_safe');
    expect(artifacts.map((a) => a.name)).toContain('plan.md');
    expect(artifacts.some((a) => a.name === 'xss.html')).toBe(false);
    expect(readAgySessionArtifact(agyRoot, 'sess_safe', '../outside-secret/leak.md')).toBeNull();
    expect(readAgySessionArtifact(agyRoot, 'sess_safe', 'xss.html')).toBeNull();
    expect(readAgySessionArtifact(agyRoot, 'sess_safe', 'bad_nul.txt')).toBeNull();

    // Junction inside managed root / brain must be rejected
    const junctionHistoryRoot = path.join(tmp, 'root-with-junction');
    fs.mkdirSync(junctionHistoryRoot, { recursive: true });
    const convJunction = path.join(junctionHistoryRoot, 'conversations');
    if (createFakeJunction(outsideDir, convJunction)) {
      const dirs = resolveAgyProfileDirectories(tmp, 'p-check');
      fs.mkdirSync(dirs.geminiDir, { recursive: true });
      const brainJunction = path.join(brainSess, 'linked');
      if (createFakeJunction(outsideDir, brainJunction)) {
        expect(resolveManagedProfilePathSync(brainSess, ['linked', 'leak.md'], 'file')).toBeUndefined();
      }
      // Indexed history under junctioned root DB symlink
      const jBrain = path.join(agyRoot, 'brain', 'j_escape');
      if (createFakeJunction(outsideDir, jBrain)) {
        expect(listAgySessionArtifacts(agyRoot, 'j_escape')).toEqual([]);
      }
    }
  });
});

describe('NP-16 T17 · Consumer OAuth Provenance Boundaries', () => {
  it('enforces unforgeable provenance in Orchestrator and Failover recommendation', async () => {
    const tmp = makeTempDir('hm-np16-prov-ok-');
    const store = new HarnessMateStore(path.join(tmp, 'prov.sqlite'));
    openStores.push(store);
    const registry = new HarnessRegistry();
    registry.register(makeFakeCodexAdapter('codex'));
    registry.register(makeStubOAuthAgyAdapter(path.join(tmp, 'profiles'), 'agy-oauth', 'oauth-personal'));
    registry.register(makeStubOAuthAgyAdapter(path.join(tmp, 'profiles'), 'agy-api', 'gemini-api-key'));

    const ws = store.createWorkspace({
      id: 'ws_p1',
      name: 'WS',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: 1000,
    });
    store.createSession({
      id: 'sess_parent_codex',
      workspaceId: ws.id,
      harnessId: 'codex',
      harnessKind: 'codex',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'Codex Parent',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Forged object rejected
    expect(() =>
      assertAgyConsumerProvenance(
        { instanceId: 'agy-oauth', driverId: 'agy', authMethod: 'oauth-personal' },
        { channel: 'human_direct', actor: 'desktop', issuedAt: Date.now() },
      ),
    ).toThrowError(AgyConsumerProvenanceError);

    // Orchestrator rejects consumer OAuth delegation
    const orch = new OrchestratorService(store, registry);
    orch.attachHooks({
      isOrchestratorEnabled: () => true,
      getGitService: () => undefined,
      createChildSession: async () => {
        throw new Error('must not create child');
      },
      sendTurn: async () => {},
      stopSession: async () => {},
      emitCanonical: () => {},
      publishAttention: () => {},
      getTaskLedger: () => undefined,
    });
    await expect(
      orch.delegateTask('sess_parent_codex', {
        targetInstanceId: 'agy-oauth',
        roleTitle: 'Sub',
        prompt: 'Inspect',
        isolation: 'read_only',
      }),
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'E_CONSUMER_PROVENANCE_BLOCKED' } satisfies Partial<OrchestratorError>);

    // FailoverCoordinator downgrades auto_failover targeting consumer OAuth AGY
    const failover = new FailoverCoordinator(store, registry, () => undefined);
    failover.setPolicy({ mode: 'auto_any', priorityChain: ['agy-oauth'], maxAutoSwitchesPerSession: 2 });
    const rec = failover.recommendFailover('sess_parent_codex', 'codex', 'rate_limited');
    expect(rec.recommendedInstanceId).toBe('agy-oauth');
    expect(rec.canAutoFailover).toBe(false);

    // Non-consumer API key & human_direct allowed
    expect(
      evaluateAgyConsumerProvenance(
        { instanceId: 'agy-api', driverId: 'agy', authMethod: 'gemini-api-key' },
        mintAgyDispatchProvenance('hm_orchestrator_delegation', 'system'),
      ).allowed,
    ).toBe(true);
    expect(
      evaluateAgyConsumerProvenance(
        { instanceId: 'agy-oauth', driverId: 'agy', authMethod: 'oauth-personal' },
        mintAgyDispatchProvenance('human_direct', 'desktop'),
      ).allowed,
    ).toBe(true);
  });
});
