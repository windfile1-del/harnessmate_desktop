import type {
  AgyAuthMethod,
  AgyIsolationMode,
  PermissionMode,
  ReasoningEffort,
} from '@harnessmate/protocol';
import type { CapabilityDescriptor, GateState } from '../../../../lib/native-client';

export type SettingsSectionId = 'account' | 'models' | 'agents' | 'ecosystem' | 'projects';

export type EcosystemNamespaceDto = 'agy_native' | 'harnessmate';

export type EcosystemScopeLevelDto =
  | 'account_profile'
  | 'project_workspace'
  | 'session_runtime'
  | 'machine_global'
  | 'organization_policy';

export type EcosystemAccessPolicyDto =
  | 'read_only'
  | 'hm_profile_managed'
  | 'official_cli_opt_in'
  | 'official_app_or_cli_only'
  | 'prohibited';

export interface AgyEcosystemFeatureGatesDto {
  readonly ecosystemReadEnabled: boolean;
  readonly customAgentsLocalScanEnabled: boolean;
  readonly skillsDeepDiscoveryEnabled: boolean;
  readonly rulesVerificationEnabled: boolean;
  readonly hooksMetadataReadEnabled: boolean;
  readonly pluginsAndMcpMetadataEnabled: boolean;
  readonly officialOptInQueryEnabled: boolean;
  readonly privateRuntimeReadEnabled: boolean;
}

export interface EcosystemReadWriteScopeEntryDto {
  readonly domain: string;
  readonly namespace: EcosystemNamespaceDto;
  readonly scope: EcosystemScopeLevelDto;
  readonly access: EcosystemAccessPolicyDto;
  readonly note: string;
}

export interface AgyConfigFieldProvenanceDto<T> {
  readonly requested: T;
  readonly sourceTier: 'account_defaults' | 'session_override' | 'turn_override' | 'fallback_default';
  readonly observedActual?: T | null;
  readonly drifted: boolean;
  readonly enforcement?: 'native' | 'client_guard' | 'unknown';
  readonly reasonCode?: string;
}

export interface AgyEffectiveConfigDto {
  readonly effectiveRequested: {
    readonly model: string | null;
    readonly reasoningEffort: ReasoningEffort | null;
    readonly permissionMode: PermissionMode;
    readonly configOptions: Record<string, string>;
  };
  readonly hasTurnOverrides: boolean;
  readonly provenance: {
    readonly model: AgyConfigFieldProvenanceDto<string | null>;
    readonly reasoningEffort: AgyConfigFieldProvenanceDto<ReasoningEffort | null>;
    readonly permissionMode: AgyConfigFieldProvenanceDto<PermissionMode>;
    readonly additionalDirectories: AgyConfigFieldProvenanceDto<readonly string[]>;
  };
  readonly policyViolations: readonly string[];
}

export interface AgyObservedModelDto {
  readonly id: string;
  readonly displayName?: string;
  readonly group?: string;
  readonly supportedEfforts?: readonly ReasoningEffort[];
  readonly allowedByPolicy: boolean;
}

export interface AgyCustomAgentDto {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly modelHint?: string;
  readonly toolsCount?: number;
  readonly toolNames?: readonly string[];
  readonly subagentsEnabled?: boolean;
  readonly scope: EcosystemScopeLevelDto;
  readonly sourceKind: string;
  readonly precedenceRank: number;
  readonly shadowedBy?: string;
  readonly redactedPath: string;
  readonly switchSemantics: 'new_session_or_fork_required';
  readonly launchFlag: '--agent';
  readonly officialEntry: string;
  readonly namespace: 'agy_native';
  readonly readOnly: true;
}

export interface AgySkillEntryDto {
  readonly name: string;
  readonly description?: string;
  readonly scope: EcosystemScopeLevelDto;
  readonly sourceKind: string;
  readonly precedenceRank: number;
  readonly shadowedBy?: string;
  readonly redactedPath: string;
  readonly namespace: 'agy_native';
  readonly versionNote?: string;
}

export interface AgySkillDuplicateDto {
  readonly name: string;
  readonly winnerSourceKind: string;
  readonly shadowedSources: readonly string[];
}

export interface AgyRuleEntryDto {
  readonly id: string;
  readonly name: string;
  readonly kind: 'agents_md' | 'gemini_md' | 'modular_rule' | 'rules_json';
  readonly scope: EcosystemScopeLevelDto;
  readonly sourceKind: string;
  readonly triggerMode: 'always_on' | 'model_decision' | 'unknown';
  readonly canonicalHash: string;
  readonly redactedPath: string;
  readonly acpRuntimeVerification: 'unverified_upstream_1540' | 'verified_live' | 'not_tested';
  readonly note: string;
  readonly namespace: 'agy_native';
}

export interface AgyHookMetadataDto {
  readonly eventName: string;
  readonly scope: EcosystemScopeLevelDto;
  readonly sourceKind: string;
  readonly handlerCount: number;
  readonly redactedPath: string;
  readonly organizationDisabled: boolean;
  readonly namespace: 'agy_native';
  readonly neverAutoExecutedByHm: true;
}

export interface AgyPluginMetadataDto {
  readonly name: string;
  readonly scope: EcosystemScopeLevelDto;
  readonly sourceKind: string;
  readonly enabled: boolean | null;
  readonly disabledByPolicy: boolean;
  readonly managedByOrgPolicy: boolean;
  readonly redactedPath: string;
  readonly namespace: 'agy_native';
  readonly officialEntry: string;
}

export interface AgyMcpServerDto {
  readonly name: string;
  readonly transportKind: 'stdio' | 'http' | 'sse' | 'unknown';
  readonly scope: 'global_shared' | 'project_local' | 'session_isolated';
  readonly namespace: EcosystemNamespaceDto;
  readonly hasSecretEnvRedacted: boolean;
  readonly hasAuthHeadersRedacted: boolean;
  readonly blockedByPolicy: boolean;
  readonly redactedSourcePath?: string;
}

export interface AgyProjectRootDto {
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

export interface AgyBoundarySurfaceDto {
  readonly capabilityId: string;
  readonly key:
    | 'billing_credits'
    | 'remote_control'
    | 'remote_agents'
    | 'ssh_workspace'
    | 'sidecars'
    | 'ide_sdk'
    | 'mcp_apps'
    | 'marketplace'
    | 'learn_customizations';
  readonly title: string;
  readonly namespace: 'agy_native';
  readonly gate: GateState;
  readonly nativeFeedAvailable: false;
  readonly hmManaged: false;
  readonly reason: string;
  readonly officialEntry: string;
  readonly officialDocUrl: string;
}

export interface AgyAdminPolicyDto {
  readonly detected: boolean;
  readonly source: 'none' | 'declared_input' | 'profile_settings_readonly';
  readonly disabledPlugins: readonly string[];
  readonly blockedMcpServers: readonly string[];
  readonly hooksDisabled: boolean;
  readonly allowedModels?: readonly string[];
  readonly permissionCeiling?: PermissionMode | null;
  readonly notes: readonly string[];
}

export interface AgyOptInQueryStateDto {
  readonly queryKind: 'usage' | 'skills' | 'agents';
  readonly executed: boolean;
  readonly provenance: 'official_cli_query' | 'blocked';
  readonly mutatedConversation: false;
  readonly profileInstanceId: string;
  readonly itemsCount?: number;
  readonly outputSummary?: string;
  readonly reasonCode?: string;
  readonly error?: string;
  readonly observedAt: number;
}

export interface AgyEcosystemCatalogSnapshotDto {
  readonly schemaVersion: 1;
  readonly snapshotRevision: number;
  readonly collectedAt: number;
  readonly gates: AgyEcosystemFeatureGatesDto;
  readonly gatesClosed: boolean;
  readonly identityScope: {
    readonly instanceId: string;
    readonly displayName: string;
    readonly isolationMode: AgyIsolationMode;
    readonly authMethod: AgyAuthMethod;
    readonly source: string;
    readonly profileVerified: boolean;
    readonly tierName: string | null;
    readonly accountFingerprint: string | null;
    readonly redactedGeminiDir: string;
    readonly appDataDirName: string;
    readonly enterpriseIssue1610Warning: boolean;
    readonly cacheKeyHash: string;
  };
  readonly readWriteBoundaries: readonly EcosystemReadWriteScopeEntryDto[];
  readonly effectiveConfig: AgyEffectiveConfigDto;
  readonly modelsSummary: {
    readonly observedModels: readonly AgyObservedModelDto[];
    readonly orchestratorNote: string;
  };
  readonly customAgents: {
    readonly items: readonly AgyCustomAgentDto[];
    readonly switchSemantics: 'new_session_or_fork_required';
    readonly note: string;
  };
  readonly skills: {
    readonly items: readonly AgySkillEntryDto[];
    readonly duplicates: readonly AgySkillDuplicateDto[];
    readonly precedenceRule: string;
    readonly profileSkillsLinked: boolean;
    readonly rejectedRootsCount: number;
  };
  readonly rules: {
    readonly items: readonly AgyRuleEntryDto[];
    readonly systemPromptInjectionProhibited: true;
    readonly acpVerificationNote: string;
  };
  readonly hooks: {
    readonly agyHooks: readonly AgyHookMetadataDto[];
    readonly harnessMateV5HooksCount: number;
    readonly organizationDisabled: boolean;
  };
  readonly plugins: {
    readonly agyPlugins: readonly AgyPluginMetadataDto[];
    readonly harnessMateActivePluginsCount: number;
    readonly separationNote: string;
  };
  readonly mcp: {
    readonly servers: readonly AgyMcpServerDto[];
    readonly nativeGlobalConfigPresent: boolean;
    readonly harnessMateSessionMcpCount: number;
    readonly note: string;
  };
  readonly projects: {
    readonly workspaceRoot: AgyProjectRootDto;
    readonly additionalDirectories: readonly AgyProjectRootDto[];
    readonly nativeProjectsScopeNote: string;
  };
  readonly adminPolicy: AgyAdminPolicyDto;
  readonly accountEcosystem: {
    readonly manualControlOnly: true;
    readonly autoRotationProhibited: true;
    readonly singleActiveAccountDeferred: true;
    readonly note: string;
  };
  readonly boundarySurfaces: readonly AgyBoundarySurfaceDto[];
  readonly noNativeFeedCapabilityIds: readonly string[];
  readonly descriptors: readonly CapabilityDescriptor[];
}
