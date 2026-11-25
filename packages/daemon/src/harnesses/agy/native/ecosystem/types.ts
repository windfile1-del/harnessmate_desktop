import type {
  AgyAuthMethod,
  AgyIsolationMode,
  CapabilityDescriptor,
  GateState,
  PermissionMode,
  ReasoningEffort,
} from '@harnessmate/protocol';
import type { AgyResolvedConfigWithProvenance } from '../../agy-config-scope.js';

export interface AgyEcosystemFeatureGates {
  readonly ecosystemReadEnabled: boolean;
  readonly customAgentsLocalScanEnabled: boolean;
  readonly skillsDeepDiscoveryEnabled: boolean;
  readonly rulesVerificationEnabled: boolean;
  readonly hooksMetadataReadEnabled: boolean;
  readonly pluginsAndMcpMetadataEnabled: boolean;
  readonly officialOptInQueryEnabled: boolean;
  readonly privateRuntimeReadEnabled: boolean;
}

export const DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES: Readonly<AgyEcosystemFeatureGates> = Object.freeze({
  ecosystemReadEnabled: false,
  customAgentsLocalScanEnabled: false,
  skillsDeepDiscoveryEnabled: false,
  rulesVerificationEnabled: false,
  hooksMetadataReadEnabled: false,
  pluginsAndMcpMetadataEnabled: false,
  officialOptInQueryEnabled: false,
  privateRuntimeReadEnabled: false,
});

export type EcosystemNamespace = 'agy_native' | 'harnessmate';

export type EcosystemScopeLevel =
  | 'account_profile'
  | 'project_workspace'
  | 'session_runtime'
  | 'machine_global'
  | 'organization_policy';

export type EcosystemAccessPolicy =
  | 'read_only'
  | 'hm_profile_managed'
  | 'official_cli_opt_in'
  | 'official_app_or_cli_only'
  | 'prohibited';

export interface EcosystemReadWriteScopeEntry {
  readonly domain: string;
  readonly namespace: EcosystemNamespace;
  readonly scope: EcosystemScopeLevel;
  readonly access: EcosystemAccessPolicy;
  readonly note: string;
}

export interface CustomAgentEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly modelHint?: string;
  readonly toolsCount?: number;
  readonly toolNames?: readonly string[];
  readonly subagentsEnabled?: boolean;
  readonly scope: EcosystemScopeLevel;
  readonly sourceKind:
    | 'workspace_agents'
    | 'workspace_legacy_agent'
    | 'profile_gemini_config'
    | 'profile_gemini'
    | 'official_cli_query';
  readonly precedenceRank: number;
  readonly shadowedBy?: string;
  readonly redactedPath: string;
  readonly switchSemantics: 'new_session_or_fork_required';
  readonly launchFlag: '--agent';
  readonly officialEntry: 'agy agents · /agents';
  readonly namespace: 'agy_native';
  readonly readOnly: true;
}

export type SkillSourceKind =
  | 'workspace_agents'
  | 'workspace_legacy_agent'
  | 'profile_gemini_config'
  | 'profile_gemini'
  | 'profile_antigravity'
  | 'global_gemini_config'
  | 'global_gemini'
  | 'global_agents_1_5_16'
  | 'official_cli_query';

export interface SkillDiscoveryEntry {
  readonly name: string;
  readonly description?: string;
  readonly scope: EcosystemScopeLevel;
  readonly sourceKind: SkillSourceKind;
  readonly precedenceRank: number;
  readonly shadowedBy?: string;
  readonly redactedPath: string;
  readonly namespace: 'agy_native';
  readonly versionNote?: string;
}

export interface SkillDuplicateConflict {
  readonly name: string;
  readonly winnerSourceKind: SkillSourceKind;
  readonly shadowedSources: readonly SkillSourceKind[];
}

export interface RuleDiscoveryEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: 'agents_md' | 'gemini_md' | 'modular_rule' | 'rules_json';
  readonly scope: EcosystemScopeLevel;
  readonly sourceKind:
    | 'workspace_root'
    | 'workspace_agents'
    | 'workspace_legacy_agent'
    | 'profile_gemini'
    | 'profile_gemini_config';
  readonly triggerMode: 'always_on' | 'model_decision' | 'unknown';
  readonly canonicalHash: string;
  readonly redactedPath: string;
  readonly acpRuntimeVerification: 'unverified_upstream_1540' | 'verified_live' | 'not_tested';
  readonly note: string;
  readonly namespace: 'agy_native';
}

export interface HookMetadataEntry {
  readonly eventName: string;
  readonly scope: EcosystemScopeLevel;
  readonly sourceKind:
    | 'workspace_agents_hooks'
    | 'profile_gemini_hooks'
    | 'profile_gemini_config_hooks'
    | 'global_gemini_hooks';
  readonly handlerCount: number;
  readonly redactedPath: string;
  readonly organizationDisabled: boolean;
  readonly namespace: 'agy_native';
  readonly neverAutoExecutedByHm: true;
}

export interface AgyPluginMetadataEntry {
  readonly name: string;
  readonly scope: EcosystemScopeLevel;
  readonly sourceKind:
    | 'workspace_agents_plugins'
    | 'profile_gemini_config_plugins'
    | 'profile_gemini_plugins';
  readonly enabled: boolean | null;
  readonly disabledByPolicy: boolean;
  readonly managedByOrgPolicy: boolean;
  readonly redactedPath: string;
  readonly namespace: 'agy_native';
  readonly officialEntry: 'agy plugin · /plugin';
}

export interface McpServerMetadataEntry {
  readonly name: string;
  readonly transportKind: 'stdio' | 'http' | 'sse' | 'unknown';
  readonly scope: 'global_shared' | 'project_local' | 'session_isolated';
  readonly namespace: EcosystemNamespace;
  readonly hasSecretEnvRedacted: boolean;
  readonly hasAuthHeadersRedacted: boolean;
  readonly blockedByPolicy: boolean;
  readonly redactedSourcePath?: string;
}

export interface AdminPolicySnapshot {
  readonly detected: boolean;
  readonly source: 'none' | 'declared_input' | 'profile_settings_readonly';
  readonly disabledPlugins: readonly string[];
  readonly blockedMcpServers: readonly string[];
  readonly hooksDisabled: boolean;
  readonly allowedModels?: readonly string[];
  readonly permissionCeiling?: PermissionMode | null;
  readonly notes: readonly string[];
}

export interface ValidatedProjectRoot {
  readonly kind: 'workspace_root' | 'additional_directory';
  readonly sourceScope: 'session_runtime' | 'account_profile';
  readonly redactedPath: string;
  readonly normalizedHash: string;
  readonly allowed: boolean;
  readonly reasonCode:
    | 'ok'
    | 'missing'
    | 'not_directory'
    | 'symlink_escape_rejected'
    | 'traversal_rejected'
    | 'duplicate_root';
}

export type BoundarySurfaceKey =
  | 'billing_credits'
  | 'remote_control'
  | 'remote_agents'
  | 'ssh_workspace'
  | 'sidecars'
  | 'ide_sdk'
  | 'mcp_apps'
  | 'marketplace'
  | 'learn_customizations';

export interface BoundarySurfaceStatus {
  readonly capabilityId: string;
  readonly key: BoundarySurfaceKey;
  readonly title: string;
  readonly namespace: 'agy_native';
  readonly gate: GateState;
  readonly nativeFeedAvailable: false;
  readonly hmManaged: false;
  readonly reason: string;
  readonly officialEntry: string;
  readonly officialDocUrl: string;
}

export type OptInOfficialQueryKind = 'usage' | 'skills' | 'agents';

export interface OptInOfficialQueryResult {
  readonly queryKind: OptInOfficialQueryKind;
  readonly executed: boolean;
  readonly provenance: 'official_cli_query' | 'blocked';
  readonly mutatedConversation: false;
  readonly profileInstanceId: string;
  readonly itemsCount?: number;
  readonly outputSummary?: string;
  readonly skills?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly enabled?: boolean;
  }>;
  readonly agents?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
  }>;
  readonly reasonCode?: string;
  readonly error?: string;
  readonly observedAt: number;
}

export interface ObservedModelDescriptor {
  readonly id: string;
  readonly displayName?: string;
  readonly group?: string;
  readonly supportedEfforts?: readonly ReasoningEffort[];
  readonly allowedByPolicy: boolean;
}

export interface AgyEcosystemCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotRevision: number;
  readonly collectedAt: number;
  readonly gates: Readonly<AgyEcosystemFeatureGates>;
  readonly gatesClosed: boolean;
  readonly identityScope: {
    readonly instanceId: string;
    readonly displayName: string;
    readonly isolationMode: AgyIsolationMode;
    readonly authMethod: AgyAuthMethod;
    readonly source: 'agy_cli' | 'agy_desktop' | 'agy_ide' | 'acp' | string;
    readonly profileVerified: boolean;
    readonly tierName: string | null;
    readonly accountFingerprint: string | null;
    readonly redactedGeminiDir: string;
    readonly appDataDirName: string;
    readonly enterpriseIssue1610Warning: boolean;
    readonly cacheKeyHash: string;
  };
  readonly readWriteBoundaries: readonly EcosystemReadWriteScopeEntry[];
  readonly effectiveConfig: AgyResolvedConfigWithProvenance;
  readonly modelsSummary: {
    readonly observedModels: readonly ObservedModelDescriptor[];
    readonly orchestratorNote: string;
  };
  readonly customAgents: {
    readonly items: readonly CustomAgentEntry[];
    readonly switchSemantics: 'new_session_or_fork_required';
    readonly note: string;
  };
  readonly skills: {
    readonly items: readonly SkillDiscoveryEntry[];
    readonly duplicates: readonly SkillDuplicateConflict[];
    readonly precedenceRule: string;
    readonly profileSkillsLinked: boolean;
    readonly rejectedRootsCount: number;
  };
  readonly rules: {
    readonly items: readonly RuleDiscoveryEntry[];
    readonly systemPromptInjectionProhibited: true;
    readonly acpVerificationNote: string;
  };
  readonly hooks: {
    readonly agyHooks: readonly HookMetadataEntry[];
    readonly harnessMateV5HooksCount: number;
    readonly organizationDisabled: boolean;
  };
  readonly plugins: {
    readonly agyPlugins: readonly AgyPluginMetadataEntry[];
    readonly harnessMateActivePluginsCount: number;
    readonly separationNote: string;
  };
  readonly mcp: {
    readonly servers: readonly McpServerMetadataEntry[];
    readonly nativeGlobalConfigPresent: boolean;
    readonly harnessMateSessionMcpCount: number;
    readonly note: string;
  };
  readonly projects: {
    readonly workspaceRoot: ValidatedProjectRoot;
    readonly additionalDirectories: readonly ValidatedProjectRoot[];
    readonly nativeProjectsScopeNote: string;
  };
  readonly adminPolicy: AdminPolicySnapshot;
  readonly accountEcosystem: {
    readonly manualControlOnly: true;
    readonly autoRotationProhibited: true;
    readonly singleActiveAccountDeferred: true;
    readonly note: string;
  };
  readonly boundarySurfaces: readonly BoundarySurfaceStatus[];
  readonly noNativeFeedCapabilityIds: readonly string[];
  readonly descriptors: readonly CapabilityDescriptor[];
}
