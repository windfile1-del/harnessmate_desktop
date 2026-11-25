export {
  BUILTIN_AGY_CAPABILITY_DEFINITIONS,
  LIVE_ONLY_INTERACTIVE_WORKFLOW_COMMANDS,
  buildCapabilityAliasMap,
  type NativeCapabilityDefinition,
  type NativeCommandActionMetadata,
  type NativeCommandArgSpec,
  type NativeWorkflowDescriptorContribution,
  type ObservedAcpCommand,
  type ObservedAcpConfigOption,
  type ObservedRuntimeSignals,
} from './descriptors.js';

export {
  AgyNativeCommandCatalogService,
  buildBindingCatalogCacheKey,
  extractModelEffortOptions,
  type BindingCatalogCacheKey,
  type BindingCatalogSnapshot,
  type ModelEffortOptionSnapshot,
} from './catalog.js';

export {
  AgyNativeCommandRouter,
  NativeCommandRouterError,
  type AgyNativeCommandRouterDeps,
  type LiveWorkflowDispatchInput,
  type LiveWorkflowDispatchResult,
  type NativeConfigApplyInput,
  type NativeConfigApplyResult,
  type NativeManagerSnapshotData,
  type NativeQueryResult,
} from './router.js';

export {
  NP06_SYNTHETIC_FIXTURE_SOURCE,
  SYNTHETIC_ACP_COMMANDS_FULL,
  SYNTHETIC_ACP_COMMANDS_WITH_UNKNOWN,
  SYNTHETIC_CONFIG_OPTIONS_FLASH,
  makeSyntheticBinding,
  makeSyntheticVerifiedSignals,
} from './fixtures.js';
