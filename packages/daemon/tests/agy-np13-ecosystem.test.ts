import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CapabilityDescriptorSchema,
  type AgyProfileConfig,
} from '@harnessmate/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgyConfigWithProvenance } from '../src/harnesses/agy/agy-config-scope.js';
import {
  collectAgyEcosystemSnapshot,
  collectNativeEcosystemCatalogSnapshot,
} from '../src/harnesses/agy/agy-ecosystem.js';
import { createAgyLaunchContext } from '../src/harnesses/agy/agy-launch-context.js';
import { inspectAgyProfileScopeBoundary } from '../src/harnesses/agy/agy-profile-manager.js';
import { AgyNativeCommandCatalogService } from '../src/harnesses/agy/native/commands/catalog.js';
import {
  AgyNativeEcosystemService,
  DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
  NP13_NO_NATIVE_FEED_CAPABILITY_IDS,
  NP13_SYNTHETIC_FIXTURE_SOURCE,
  buildEcosystemCapabilityDescriptors,
  createAuthorizedProfileEcosystemFixture,
  createFeatureOffEcosystemFixture,
  registerEcosystemCapabilityDescriptors,
  validateAuthorizedDirectory,
} from '../src/harnesses/agy/native/ecosystem/index.js';
import { mintAgyDispatchProvenance } from '../src/harnesses/agy/native/wiring/provenance.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFileEnsureDir(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeProfile(overrides: Partial<AgyProfileConfig> = {}): AgyProfileConfig {
  return {
    instanceId: overrides.instanceId ?? 'agy-work-alpha',
    displayName: overrides.displayName ?? 'Work Gmail',
    isolationMode: overrides.isolationMode ?? 'profile_isolated',
    authMethod: overrides.authMethod ?? 'oauth-personal',
    appDataDirName: overrides.appDataDirName ?? 'antigravity-cli',
    defaults: overrides.defaults ?? {
      defaultModel: 'gemini-3.8-flash',
      defaultEffort: 'medium',
      defaultPermissionMode: 'accept_edits',
      linkGlobalSkills: true,
      syncGlobalRules: true,
      additionalDirectories: [],
    },
    identity: overrides.identity ?? {
      accountFingerprint: 'fp_alpha_001',
      emailLabel: 'Work Gmail',
      tierName: 'Pro',
      verifiedAt: 1_760_000_000_000,
    },
    enabled: overrides.enabled ?? true,
    ...(overrides.geminiDir ? { geminiDir: overrides.geminiDir } : {}),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

describe('NP-13 Native Ecosystem, Custom Agents & Config Scope', () => {
  it('keeps default feature gates closed and preserves collectAgyEcosystemSnapshot compatibility', () => {
    expect(DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES.ecosystemReadEnabled).toBe(false);
    expect(DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES.officialOptInQueryEnabled).toBe(false);
    expect(DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES.privateRuntimeReadEnabled).toBe(false);
    expect(NP13_SYNTHETIC_FIXTURE_SOURCE).toBe('synthetic');

    const root = makeTempDir('hm-np13-off-');
    const userHome = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'workspace');
    const profilesRoot = path.join(root, 'profiles');
    const geminiDir = path.join(profilesRoot, 'p1');
    writeFileEnsureDir(path.join(workspaceRoot, '.agents', 'skills', 'deploy', 'SKILL.md'), '# Deploy');
    writeFileEnsureDir(path.join(geminiDir, 'AGENTS.md'), '# Rule');

    const profile = makeProfile({ geminiDir });
    const launchContext = createAgyLaunchContext({
      instanceId: profile.instanceId,
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      binaryPath: 'agy.exe',
      geminiDir,
    });

    const legacySnapshot = collectAgyEcosystemSnapshot({
      launchContext,
      workspaceRoot,
      additionalDirectories: [],
      harnessMateActivePluginsCount: 1,
      userHome,
    });
    expect(legacySnapshot.rules.profileFiles).toEqual(['AGENTS.md']);
    expect(legacySnapshot.skills.workspaceSkillsCount).toBe(1);
    expect(legacySnapshot.mcp.nativeScope).toBe('global_shared');

    const gatedSnapshot = collectNativeEcosystemCatalogSnapshot({
      profile,
      launchContext,
      profilesRootDir: profilesRoot,
      workspaceRoot,
      userHome,
    });
    expect(gatedSnapshot.gatesClosed).toBe(true);
    expect(gatedSnapshot.customAgents.items).toEqual([]);
    expect(gatedSnapshot.skills.items).toEqual([]);
    expect(gatedSnapshot.rules.items).toEqual([]);
    expect(gatedSnapshot.noNativeFeedCapabilityIds).toEqual(NP13_NO_NATIVE_FEED_CAPABILITY_IDS);
    expect(createFeatureOffEcosystemFixture().gatesClosed).toBe(true);
  });

  it('T01: resolves 3-tier config provenance without tier drift and flags actual mismatch', () => {
    const resolved = resolveAgyConfigWithProvenance({
      accountDefaults: {
        defaultModel: 'gemini-3.8-flash',
        defaultEffort: 'medium',
        defaultPermissionMode: 'accept_edits',
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: ['D:/docs'],
      },
      sessionOverrides: undefined,
      observedActual: undefined,
    });
    expect(resolved.provenance.model.sourceTier).toBe('account_defaults');

    const withOverrides = resolveAgyConfigWithProvenance({
      accountDefaults: {
        defaultModel: 'gemini-3.8-flash',
        defaultEffort: 'medium',
        defaultPermissionMode: 'accept_edits',
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: ['D:/docs'],
      },
      session: {
        permissionMode: 'auto',
      },
      turn: {
        reasoningEffort: 'xhigh',
      },
      observedActual: {
        model: 'gemini-3.8-flash',
        reasoningEffort: 'medium',
        permissionMode: 'manual',
        permissionEnforcement: 'client_guard',
        observedModelIds: ['gemini-3.8-flash'],
        observedEffortsForCurrentModel: ['low', 'medium', 'high'],
        adminPermissionCeiling: 'accept_edits',
      },
    });

    expect(withOverrides.provenance.model.sourceTier).toBe('account_defaults');
    expect(withOverrides.provenance.model.drifted).toBe(false);
    expect(withOverrides.provenance.reasoningEffort.sourceTier).toBe('turn_override');
    expect(withOverrides.provenance.reasoningEffort.drifted).toBe(true);
    expect(withOverrides.provenance.reasoningEffort.reasonCode).toBe('effort_not_in_observed_options');
    expect(withOverrides.provenance.permissionMode.sourceTier).toBe('session_override');
    expect(withOverrides.provenance.permissionMode.drifted).toBe(true);
    expect(withOverrides.provenance.permissionMode.reasonCode).toBe('blocked_by_admin_policy');
    expect(withOverrides.policyViolations.length).toBeGreaterThan(0);
    expect(withOverrides.restorePatch).toEqual({ reasoningEffort: 'medium' });
    expect(withOverrides.readWriteBoundaries.some((b) => b.mode === 'read_only_never_mutated')).toBe(
      true,
    );

    const fixture = createAuthorizedProfileEcosystemFixture();
    expect(fixture.modelsSummary.observedModels[0]?.id).toBe('gemini-3.8-flash');
    expect(fixture.descriptors.every((d) => CapabilityDescriptorSchema.safeParse(d).success)).toBe(
      true,
    );
  });

  it('T15: enforces AGY 1.5.16 skills precedence (workspace > .gemini > ~/.agents/skills) and custom agent fork semantics', () => {
    const root = makeTempDir('hm-np13-prec-');
    const userHome = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'workspace');
    const profilesRoot = path.join(root, 'profiles');
    const geminiDir = path.join(profilesRoot, 'p-alpha');

    // Duplicate skill `deploy-check` at all 3 tiers: workspace, ~/.gemini, ~/.agents/skills
    writeFileEnsureDir(
      path.join(workspaceRoot, '.agents', 'skills', 'deploy-check', 'SKILL.md'),
      '---\nname: deploy-check\ndescription: Workspace deploy\n---\nWorkspace instructions',
    );
    writeFileEnsureDir(
      path.join(userHome, '.gemini', 'skills', 'deploy-check', 'SKILL.md'),
      '---\nname: deploy-check\ndescription: Global gemini deploy\n---\nGemini instructions',
    );
    writeFileEnsureDir(
      path.join(userHome, '.agents', 'skills', 'deploy-check', 'SKILL.md'),
      '---\nname: deploy-check\ndescription: Global 1.5.16 agents deploy\n---\nAgents instructions',
    );

    // Duplicate skill `gemini-beats-agents` only in ~/.gemini and ~/.agents/skills
    writeFileEnsureDir(
      path.join(userHome, '.gemini', 'config', 'skills', 'gemini-beats-agents', 'SKILL.md'),
      '---\nname: gemini-beats-agents\ndescription: From .gemini/config\n---\n',
    );
    writeFileEnsureDir(
      path.join(userHome, '.agents', 'skills', 'gemini-beats-agents', 'SKILL.md'),
      '---\nname: gemini-beats-agents\ndescription: From .agents\n---\n',
    );

    // Custom agents: workspace shadows profile
    writeFileEnsureDir(
      path.join(workspaceRoot, '.agents', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Workspace reviewer\nmodel: gemini-3.8-flash\ntools:\n  - read_file\n---\nSECRET_PROMPT_BODY_DO_NOT_EXPOSE',
    );
    writeFileEnsureDir(
      path.join(geminiDir, 'config', 'agents', 'reviewer', 'agent.md'),
      '---\nname: reviewer\ndescription: Profile reviewer\n---\nBody',
    );
    writeFileEnsureDir(
      path.join(geminiDir, 'agents', 'docs-writer.md'),
      '---\nname: docs-writer\ndescription: Docs specialist\n---\nBody',
    );

    const profile = makeProfile({ geminiDir });
    const launchContext = createAgyLaunchContext({
      instanceId: profile.instanceId,
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      binaryPath: 'agy.exe',
      geminiDir,
    });

    const service = new AgyNativeEcosystemService({
      gates: {
        ecosystemReadEnabled: true,
        customAgentsLocalScanEnabled: true,
        skillsDeepDiscoveryEnabled: true,
      },
    });
    const snapshot = service.collectSnapshot({
      profile,
      launchContext,
      profilesRootDir: profilesRoot,
      workspaceRoot,
      userHome,
      source: 'agy_cli',
      profileVerified: true,
    });

    const deployEntries = snapshot.skills.items.filter((s) => s.name === 'deploy-check');
    expect(deployEntries).toHaveLength(3);
    expect(deployEntries[0]?.sourceKind).toBe('workspace_agents');
    expect(deployEntries[0]?.shadowedBy).toBeUndefined();
    expect(deployEntries[1]?.sourceKind).toBe('global_gemini');
    expect(deployEntries[1]?.shadowedBy).toBe('workspace_agents');
    expect(deployEntries[2]?.sourceKind).toBe('global_agents_1_5_16');
    expect(deployEntries[2]?.shadowedBy).toBe('workspace_agents');

    const geminiWinner = snapshot.skills.items.find(
      (s) => s.name === 'gemini-beats-agents' && !s.shadowedBy,
    );
    expect(geminiWinner?.sourceKind).toBe('global_gemini_config');
    const agentsShadowed = snapshot.skills.items.find(
      (s) => s.name === 'gemini-beats-agents' && s.sourceKind === 'global_agents_1_5_16',
    );
    expect(agentsShadowed?.shadowedBy).toBe('global_gemini_config');

    expect(snapshot.customAgents.switchSemantics).toBe('new_session_or_fork_required');
    expect(snapshot.customAgents.items.map((a) => `${a.name}:${a.sourceKind}:${a.shadowedBy ?? 'winner'}`)).toEqual([
      'reviewer:workspace_agents:winner',
      'reviewer:profile_gemini_config:workspace_agents',
      'docs-writer:profile_gemini:winner',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_PROMPT_BODY_DO_NOT_EXPOSE');
  });

  it('T15: reads Rules (#1540), Hooks, Plugins, MCP metadata with admin policy and secret redaction', () => {
    const root = makeTempDir('hm-np13-eco-');
    const userHome = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'workspace');
    const profilesRoot = path.join(root, 'profiles');
    const geminiDir = path.join(profilesRoot, 'p-eco');

    writeFileEnsureDir(path.join(workspaceRoot, 'AGENTS.md'), '# Always verify');
    writeFileEnsureDir(
      path.join(workspaceRoot, '.agents', 'rules', 'strict-ts.md'),
      '---\ntrigger: model_decision\n---\nUse strict TS',
    );
    writeFileEnsureDir(
      path.join(workspaceRoot, '.agents', 'hooks.json'),
      JSON.stringify({
        PreToolUse: [{ command: 'node SECRET_HOOK_CMD.js' }],
      }),
    );
    writeFileEnsureDir(
      path.join(geminiDir, 'config', 'plugins.json'),
      JSON.stringify({
        plugins: [
          { name: 'org-blocked-plugin', enabled: true },
          { name: 'allowed-plugin', enabled: true },
        ],
      }),
    );
    writeFileEnsureDir(
      path.join(userHome, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'corp-mcp': {
            url: 'https://mcp.example.com',
            headers: { Authorization: 'Bearer SUPER_SECRET_HEADER_VALUE' },
          },
          'local-stdio': {
            command: 'npx',
            args: ['tool'],
            env: { API_KEY: 'SUPER_SECRET_ENV_VALUE' },
          },
        },
      }),
    );
    // Fake private OAuth token that MUST never be read or leaked
    writeFileEnsureDir(
      path.join(geminiDir, 'antigravity-cli', 'antigravity-oauth-token'),
      'RAW_OAUTH_REFRESH_TOKEN_SHOULD_NEVER_APPEAR',
    );

    const profile = makeProfile({ geminiDir });
    const launchContext = createAgyLaunchContext({
      instanceId: profile.instanceId,
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      binaryPath: 'agy.exe',
      geminiDir,
    });

    const service = new AgyNativeEcosystemService({
      gates: {
        ecosystemReadEnabled: true,
        rulesVerificationEnabled: true,
        hooksMetadataReadEnabled: true,
        pluginsAndMcpMetadataEnabled: true,
      },
    });
    const snapshot = service.collectSnapshot({
      profile,
      launchContext,
      profilesRootDir: profilesRoot,
      workspaceRoot,
      userHome,
      adminPolicy: {
        detected: true,
        disabledPlugins: ['org-blocked-plugin'],
        blockedMcpServers: ['corp-mcp'],
        hooksDisabled: true,
      },
      harnessMateActivePluginsCount: 3,
      harnessMateSessionMcpServers: [{ name: 'hm-session-mcp', transportKind: 'stdio' }],
    });

    expect(snapshot.rules.systemPromptInjectionProhibited).toBe(true);
    expect(snapshot.rules.items.every((r) => r.acpRuntimeVerification === 'unverified_upstream_1540')).toBe(
      true,
    );
    expect(snapshot.hooks.agyHooks[0]?.eventName).toBe('PreToolUse');
    expect(snapshot.hooks.agyHooks[0]?.organizationDisabled).toBe(true);
    expect(snapshot.hooks.agyHooks[0]?.neverAutoExecutedByHm).toBe(true);
    expect(snapshot.hooks.harnessMateV5HooksCount).toBe(3);

    const blockedPlugin = snapshot.plugins.agyPlugins.find((p) => p.name === 'org-blocked-plugin');
    expect(blockedPlugin?.disabledByPolicy).toBe(true);
    expect(blockedPlugin?.enabled).toBe(false);

    const corpMcp = snapshot.mcp.servers.find((m) => m.name === 'corp-mcp');
    expect(corpMcp?.blockedByPolicy).toBe(true);
    expect(corpMcp?.hasAuthHeadersRedacted).toBe(true);
    const localMcp = snapshot.mcp.servers.find((m) => m.name === 'local-stdio');
    expect(localMcp?.hasSecretEnvRedacted).toBe(true);
    const hmMcp = snapshot.mcp.servers.find((m) => m.name === 'hm-session-mcp');
    expect(hmMcp?.namespace).toBe('harnessmate');
    expect(hmMcp?.scope).toBe('session_isolated');

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('SUPER_SECRET_HEADER_VALUE');
    expect(serialized).not.toContain('SUPER_SECRET_ENV_VALUE');
    expect(serialized).not.toContain('SECRET_HOOK_CMD');
    expect(serialized).not.toContain('RAW_OAUTH_REFRESH_TOKEN_SHOULD_NEVER_APPEAR');
    expect(serialized).not.toContain(userHome);
  });

  it('T15: isolates profiles sharing the same displayName and flags #1610 enterprise constraint', () => {
    const root = makeTempDir('hm-np13-dup-');
    const userHome = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'workspace');
    const profilesRoot = path.join(root, 'profiles');
    const geminiA = path.join(profilesRoot, 'alpha');
    const geminiB = path.join(profilesRoot, 'beta');

    writeFileEnsureDir(path.join(geminiA, 'config', 'agents', 'alpha-agent.md'), '---\nname: alpha-agent\n---\n');
    writeFileEnsureDir(path.join(geminiB, 'config', 'agents', 'beta-agent.md'), '---\nname: beta-agent\n---\n');
    writeFileEnsureDir(path.join(workspaceRoot, 'README.md'), 'ok');

    const profileA = makeProfile({
      instanceId: 'agy-work-1',
      displayName: 'Work Gmail',
      geminiDir: geminiA,
      identity: { accountFingerprint: 'fp_1', emailLabel: 'Work Gmail', tierName: 'Pro', verifiedAt: 1 },
    });
    const profileB = makeProfile({
      instanceId: 'agy-work-2',
      displayName: 'Work Gmail',
      authMethod: 'oauth-business',
      geminiDir: geminiB,
      identity: { accountFingerprint: 'fp_2', emailLabel: 'Work Gmail', tierName: 'Enterprise', verifiedAt: 1 },
    });

    const service = new AgyNativeEcosystemService({
      gates: {
        ecosystemReadEnabled: true,
        customAgentsLocalScanEnabled: true,
        officialOptInQueryEnabled: true,
      },
    });

    const snapA = service.collectSnapshot({
      profile: profileA,
      launchContext: createAgyLaunchContext({
        instanceId: profileA.instanceId,
        isolationMode: profileA.isolationMode,
        authMethod: profileA.authMethod,
        binaryPath: 'agy.exe',
        geminiDir: geminiA,
      }),
      profilesRootDir: profilesRoot,
      workspaceRoot,
      userHome,
      source: 'agy_cli',
    });

    const snapB = service.collectSnapshot({
      profile: profileB,
      launchContext: createAgyLaunchContext({
        instanceId: profileB.instanceId,
        isolationMode: profileB.isolationMode,
        authMethod: profileB.authMethod,
        binaryPath: 'agy.exe',
        geminiDir: geminiB,
      }),
      profilesRootDir: profilesRoot,
      workspaceRoot,
      userHome,
      source: 'agy_desktop',
    });

    expect(snapA.identityScope.cacheKeyHash).not.toBe(snapB.identityScope.cacheKeyHash);
    expect(snapA.customAgents.items.map((a) => a.name)).toEqual(['alpha-agent']);
    expect(snapB.customAgents.items.map((a) => a.name)).toEqual(['beta-agent']);
    expect(snapA.identityScope.enterpriseIssue1610Warning).toBe(false);
    expect(snapB.identityScope.enterpriseIssue1610Warning).toBe(true);
    expect(snapA.descriptors.find((d) => d.id === 'AGY-W03')?.actions[0]?.gate).toBe('available');
    expect(snapB.descriptors.find((d) => d.id === 'AGY-W03')?.actions[0]?.reasonCode).toBe(
      'desktop_source_unsupported',
    );
  });

  it('T15 / T17: rejects symlink/junction escape outside authorized roots and traversal paths', () => {
    const root = makeTempDir('hm-np13-sec-');
    const userHome = path.join(root, 'home');
    const profilesRoot = path.join(root, 'profiles');
    const workspaceRoot = path.join(root, 'workspace');
    const outsideSecretDir = path.join(root, 'outside-secret');
    const geminiDir = path.join(profilesRoot, 'p-sec');

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(outsideSecretDir, { recursive: true });
    fs.mkdirSync(path.join(geminiDir, 'config'), { recursive: true });
    writeFileEnsureDir(path.join(outsideSecretDir, 'evil', 'SKILL.md'), '---\nname: evil\n---\n');

    const escapeLink = path.join(geminiDir, 'config', 'skills');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(outsideSecretDir, escapeLink, linkType);

    const allowedExtra = path.join(root, 'allowed-extra');
    fs.mkdirSync(allowedExtra, { recursive: true });
    const escapeProjectLink = path.join(root, 'escape-add-dir');
    fs.symlinkSync(outsideSecretDir, escapeProjectLink, linkType);

    const profile = makeProfile({
      geminiDir,
      defaults: {
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: [allowedExtra, allowedExtra, escapeProjectLink, '../escape'],
      },
    });

    const inspection = inspectAgyProfileScopeBoundary(profile, {
      profilesRootDir: profilesRoot,
      userHome,
    });
    const configSkillsRoot = inspection.skillsRoots.find((r) => r.kind === 'profile_config_skills');
    expect(configSkillsRoot?.isSymlink).toBe(true);
    expect(configSkillsRoot?.symlinkSafe).toBe(false);
    expect(configSkillsRoot?.reasonCode).toBe('symlink_escape_rejected');

    expect(validateAuthorizedDirectory('../escape').reasonCode).toBe('traversal_rejected');

    const service = new AgyNativeEcosystemService({
      gates: {
        ecosystemReadEnabled: true,
        skillsDeepDiscoveryEnabled: true,
      },
    });
    const snapshot = service.collectSnapshot({
      profile,
      launchContext: createAgyLaunchContext({
        instanceId: profile.instanceId,
        isolationMode: profile.isolationMode,
        authMethod: profile.authMethod,
        binaryPath: 'agy.exe',
        geminiDir,
      }),
      profilesRootDir: profilesRoot,
      workspaceRoot,
      userHome,
    });

    expect(snapshot.skills.items.find((s) => s.name === 'evil')).toBeUndefined();
    expect(snapshot.skills.rejectedRootsCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.projects.additionalDirectories.map((d) => d.reasonCode)).toEqual([
      'ok',
      'duplicate_root',
      'symlink_escape_rejected',
      'traversal_rejected',
    ]);
  });

  it('T17: enforces opt-in official query provenance, profile isolation, and NP-06 catalog registration rollback', async () => {
    const root = makeTempDir('hm-np13-optin-');
    const profilesRoot = path.join(root, 'profiles');
    const workspaceRoot = path.join(root, 'workspace');
    const geminiDir = path.join(profilesRoot, 'p-opt');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(geminiDir, { recursive: true });

    const profile = makeProfile({ instanceId: 'agy-isolated-opt', geminiDir });
    const launchContext = createAgyLaunchContext({
      instanceId: profile.instanceId,
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      binaryPath: 'agy.exe',
      geminiDir,
    });

    const runSkillsQuery = vi.fn(async (ctx) => ({
      skills: [{ name: 'official-skill', description: `from:${ctx.instanceId}`, enabled: true }],
    }));

    const service = new AgyNativeEcosystemService({
      gates: { officialOptInQueryEnabled: false },
      officialQueryExecutor: { runSkillsQuery },
    });

    // Gate closed -> blocked
    const closedRes = await service.runOptInOfficialQuery({
      queryKind: 'skills',
      profile,
      launchContext,
      workspaceRoot,
      source: 'agy_cli',
      profileVerified: true,
      userOptInConfirmed: true,
      provenance: mintAgyDispatchProvenance('human_direct', 'desktop'),
    });
    expect(closedRes.executed).toBe(false);
    expect(closedRes.reasonCode).toBe('OPT_IN_QUERY_GATE_DISABLED');
    expect(runSkillsQuery).not.toHaveBeenCalled();

    service.setGates({ officialOptInQueryEnabled: true });

    // Missing user confirmation -> blocked
    const noConfirmRes = await service.runOptInOfficialQuery({
      queryKind: 'skills',
      profile,
      launchContext,
      workspaceRoot,
      source: 'agy_cli',
      profileVerified: true,
      userOptInConfirmed: false,
      provenance: mintAgyDispatchProvenance('human_direct', 'desktop'),
    });
    expect(noConfirmRes.reasonCode).toBe('USER_OPT_IN_REQUIRED');

    // Consumer provenance negative cases (forged + hm_orchestrator + plugin_automated)
    for (const badProv of [
      { channel: 'human_direct', actor: 'desktop' },
      mintAgyDispatchProvenance('hm_orchestrator_delegation', 'system'),
      mintAgyDispatchProvenance('auto_failover', 'system'),
      mintAgyDispatchProvenance('plugin_automated', 'plugin'),
    ]) {
      const blocked = await service.runOptInOfficialQuery({
        queryKind: 'skills',
        profile,
        launchContext,
        workspaceRoot,
        source: 'agy_cli',
        profileVerified: true,
        userOptInConfirmed: true,
        provenance: badProv,
      });
      expect(blocked.executed).toBe(false);
      expect(blocked.reasonCode).toBe('CONSUMER_PROVENANCE_BLOCKED');
    }

    // Valid direct user opt-in -> runs strictly with this profile's LaunchContext
    const okRes = await service.runOptInOfficialQuery({
      queryKind: 'skills',
      profile,
      launchContext,
      workspaceRoot,
      source: 'agy_cli',
      profileVerified: true,
      userOptInConfirmed: true,
      provenance: mintAgyDispatchProvenance('human_direct', 'desktop'),
    });
    expect(okRes.executed).toBe(true);
    expect(okRes.mutatedConversation).toBe(false);
    expect(okRes.profileInstanceId).toBe('agy-isolated-opt');
    expect(okRes.skills?.[0]?.description).toBe('from:agy-isolated-opt');
    expect(runSkillsQuery).toHaveBeenCalledTimes(1);

    // NP-06 catalog registration preserves built-in actions and cleanly disposes on rollback
    const catalog = new AgyNativeCommandCatalogService();
    const beforeSkillsAction = catalog.getActionMetadata('AGY-E01', 'query_skills');
    expect(beforeSkillsAction).not.toBeNull();

    const dispose = registerEcosystemCapabilityDescriptors(catalog, {
      ...DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
      ecosystemReadEnabled: true,
      customAgentsLocalScanEnabled: true,
    });
    expect(catalog.listDefinitions().some((d) => d.id === 'AGY-W03')).toBe(true);
    expect(catalog.getActionMetadata('AGY-E01', 'query_skills')).not.toBeNull();

    const descriptors = buildEcosystemCapabilityDescriptors(1, {
      ...DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
      ecosystemReadEnabled: true,
    });
    expect(descriptors.every((d) => CapabilityDescriptorSchema.safeParse(d).success)).toBe(true);

    dispose();
    expect(catalog.listDefinitions().some((d) => d.id === 'AGY-W03')).toBe(false);
  });
});
