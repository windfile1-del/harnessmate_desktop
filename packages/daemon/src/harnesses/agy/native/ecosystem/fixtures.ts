import type { AgyProfileConfig } from '@harnessmate/protocol';
import { createAgyLaunchContext } from '../../agy-launch-context.js';
import { AgyNativeEcosystemService } from './service.js';
import type { AgyEcosystemCatalogSnapshot } from './types.js';

export const NP13_SYNTHETIC_FIXTURE_SOURCE = 'synthetic' as const;

export function createAuthorizedProfileEcosystemFixture(opts?: {
  readonly workspaceRoot?: string;
  readonly profilesRootDir?: string;
  readonly userHome?: string;
}): AgyEcosystemCatalogSnapshot {
  const workspaceRoot = opts?.workspaceRoot ?? 'D:/repo';
  const profilesRootDir = opts?.profilesRootDir ?? 'D:/profiles';
  const userHome = opts?.userHome ?? 'D:/users/tester';

  const profile: AgyProfileConfig = {
    instanceId: 'agy-test-profile',
    displayName: 'Personal Test Profile',
    isolationMode: 'profile_isolated',
    geminiDir: `${profilesRootDir}/agy-test-profile`,
    authMethod: 'oauth-personal',
    appDataDirName: 'antigravity-cli',
    defaults: {
      defaultModel: 'gemini-3.8-flash',
      defaultEffort: 'medium',
      defaultPermissionMode: 'accept_edits',
      linkGlobalSkills: true,
      syncGlobalRules: true,
      additionalDirectories: [],
    },
    identity: {
      accountFingerprint: 'acct_fp_01',
      emailLabel: 'Personal Test Profile',
      tierName: 'Pro',
      tierId: 'pro',
      verifiedAt: 1_760_000_000_000,
    },
    enabled: true,
  };

  const launchContext = createAgyLaunchContext({
    instanceId: profile.instanceId,
    isolationMode: profile.isolationMode,
    authMethod: profile.authMethod,
    binaryPath: 'agy.exe',
    geminiDir: `${profilesRootDir}/agy-test-profile`,
    appDataDirName: profile.appDataDirName,
  });

  const service = new AgyNativeEcosystemService({
    gates: {
      ecosystemReadEnabled: true,
      customAgentsLocalScanEnabled: true,
      skillsDeepDiscoveryEnabled: true,
      rulesVerificationEnabled: true,
      hooksMetadataReadEnabled: true,
      pluginsAndMcpMetadataEnabled: true,
      officialOptInQueryEnabled: true,
      privateRuntimeReadEnabled: false,
    },
    now: () => 1_760_000_100_000,
  });

  return service.collectSnapshot({
    profile,
    launchContext,
    profilesRootDir,
    workspaceRoot,
    userHome,
    source: 'agy_cli',
    profileVerified: true,
    observedModels: [
      {
        id: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        group: 'Flash',
        supportedEfforts: ['low', 'medium', 'high'],
      },
    ],
    observedActual: {
      model: 'gemini-3.8-flash',
      reasoningEffort: 'medium',
      permissionMode: 'accept_edits',
      permissionEnforcement: 'native',
      observedModelIds: ['gemini-3.8-flash'],
      observedEffortsForCurrentModel: ['low', 'medium', 'high'],
    },
    harnessMateActivePluginsCount: 2,
    harnessMateSessionMcpServers: [{ name: 'hm-local-tools', transportKind: 'stdio' }],
  });
}

export function createFeatureOffEcosystemFixture(): AgyEcosystemCatalogSnapshot {
  const profile: AgyProfileConfig = {
    instanceId: 'agy',
    displayName: 'Antigravity 官方默认',
    isolationMode: 'official_default',
    authMethod: 'oauth-personal',
    appDataDirName: 'antigravity-cli',
    defaults: {
      linkGlobalSkills: true,
      syncGlobalRules: true,
      additionalDirectories: [],
    },
    enabled: true,
  };
  const launchContext = createAgyLaunchContext({
    instanceId: profile.instanceId,
    isolationMode: profile.isolationMode,
    authMethod: profile.authMethod,
    binaryPath: 'agy.exe',
    geminiDir: 'D:/users/tester/.gemini',
  });
  const service = new AgyNativeEcosystemService({ now: () => 1_760_000_000_000 });
  return service.collectSnapshot({
    profile,
    launchContext,
    profilesRootDir: 'D:/profiles',
    workspaceRoot: 'D:/repo',
    userHome: 'D:/users/tester',
  });
}
