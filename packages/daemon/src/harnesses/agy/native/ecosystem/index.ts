export {
  DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
  type AdminPolicySnapshot,
  type AgyEcosystemCatalogSnapshot,
  type AgyEcosystemFeatureGates,
  type AgyPluginMetadataEntry,
  type BoundarySurfaceKey,
  type BoundarySurfaceStatus,
  type CustomAgentEntry,
  type EcosystemAccessPolicy,
  type EcosystemNamespace,
  type EcosystemReadWriteScopeEntry,
  type EcosystemScopeLevel,
  type HookMetadataEntry,
  type McpServerMetadataEntry,
  type ObservedModelDescriptor,
  type OptInOfficialQueryKind,
  type OptInOfficialQueryResult,
  type RuleDiscoveryEntry,
  type SkillDiscoveryEntry,
  type SkillDuplicateConflict,
  type SkillSourceKind,
  type ValidatedProjectRoot,
} from './types.js';

export {
  hashNormalizedPath,
  isPathWithinRoot,
  isSensitiveFileName,
  normalizePathForCompare,
  readSafeBoundedFile,
  redactPathForDto,
  resolveSafeChildPath,
  validateAuthorizedDirectory,
} from './path-guard.js';

export {
  buildBoundarySurfaces,
  discoverAgyPluginsMetadata,
  discoverCustomAgents,
  discoverHooksMetadata,
  discoverMcpMetadata,
  discoverRulesReadOnly,
  discoverSkillsWith1516Precedence,
  parseBoundedMarkdownFrontmatter,
  validateProjectRoots,
  type ParsedMarkdownFrontmatter,
} from './discovery.js';

export {
  NP13_NO_NATIVE_FEED_CAPABILITY_IDS,
  buildEcosystemCapabilityDescriptors,
  buildEcosystemDescriptorContributions,
  registerEcosystemCapabilityDescriptors,
} from './descriptors.js';

export {
  AgyNativeEcosystemService,
  NP13_READ_WRITE_BOUNDARIES,
  type CollectEcosystemCatalogInput,
  type OfficialCliQueryExecutor,
  type RunOptInOfficialQueryInput,
} from './service.js';

export {
  NP13_SYNTHETIC_FIXTURE_SOURCE,
  createAuthorizedProfileEcosystemFixture,
  createFeatureOffEcosystemFixture,
} from './fixtures.js';
