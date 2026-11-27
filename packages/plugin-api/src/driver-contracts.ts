import type {
  PublicHarnessCapabilities,
  PublicHarnessCapabilitiesV2,
  PublicHarnessHealth,
  PublicHarnessModelInfo,
  PublicHarnessPresentationMeta,
  PublicRateLimitWindow,
  ServiceMethodResult,
} from './context.js';

export const HARNESS_DRIVER_CONTRACT = 'harness.driver.v1';
export const HARNESS_DRIVER_CONTRACT_VERSION = '1.0.0';

export const HARNESS_DRIVER_CODEX_CONTRACT = 'harness.driver.codex.v1';
export const HARNESS_DRIVER_CLAUDE_CONTRACT = 'harness.driver.claude.v1';
export const HARNESS_DRIVER_ACP_CONTRACT = 'harness.driver.acp.v1';
export const HARNESS_DRIVER_AGY_CONTRACT = 'harness.driver.agy.v1';

export function harnessDriverCategoryContract(driverId: string): string {
  const normalized = driverId.trim().toLowerCase();
  return `harness.driver.${normalized}.v1`;
}

export interface DriverProviderIdentity {
  pluginId: string;
  instanceId: string;
  driverId: string;
  harnessId: string;
  runId: string;
  continuationKey?: string;
}

export interface DriverCommandCapability {
  command: string;
  description: string;
  argumentHint?: string;
  supported: boolean;
  reason?: string;
  source?: 'builtin' | 'driver' | 'native_advertised';
}

export interface DriverCommandReceipt {
  command: string;
  status: 'executed' | 'queued_turn' | 'unsupported' | 'rejected';
  output: string;
  turnId?: string;
  confirmed?: Record<string, unknown>;
  reason?: string;
}

export interface DriverConfigReceipt {
  harnessId: string;
  driverId: string;
  providerInstanceId: string;
  runId: string;
  requested: Record<string, unknown>;
  confirmed: Record<string, unknown>;
  status: 'applied' | 'pending_next_session' | 'unsupported' | 'rejected';
  note?: string;
}

export interface DriverRegistrationEntry {
  key: string;
  pluginId: string;
  instanceId: string;
  driverId: string;
  harnessId: string;
  runId: string;
  displayName: string;
  description: string;
  protocolLabel: string;
  continuationKey?: string;
  isDefault?: boolean;
  isCustom?: boolean;
  capabilities: PublicHarnessCapabilities;
  capabilitiesV2?: PublicHarnessCapabilitiesV2;
  presentation?: PublicHarnessPresentationMeta;
  supportedCommands?: DriverCommandCapability[];
}

export interface DriverProbeSnapshotDto {
  harnessId: string;
  driverId: string;
  providerPluginId: string;
  providerInstanceId: string;
  providerRunId: string;
  binaryPath: string | null;
  version: string | null;
  health: PublicHarnessHealth;
  healthMessage?: string;
  models: PublicHarnessModelInfo[];
  defaultModelId?: string | null;
  accountSummary?: string | null;
  supportedCommands?: DriverCommandCapability[];
}

export interface DriverUsageLimitSnapshotDto {
  harnessId: string;
  driverId: string;
  providerInstanceId: string;
  loggedIn: boolean;
  accountLabel: string | null;
  planType: string | null;
  authMethod: string | null;
  billingTier?: 'subscription' | 'api_payg' | 'local_free' | 'unknown';
  gatewayUrl?: string | null;
  rateLimits: PublicRateLimitWindow[];
  error?: string | null;
}

export interface HarnessDriverProviderServiceV1 {
  getProviderInfo(): Promise<
    ServiceMethodResult<{
      pluginId: string;
      instanceId: string;
      runId: string;
      driverIds: string[];
      harnessIds: string[];
    }>
  >;
  listHarnessInstances(): Promise<ServiceMethodResult<{ instances: DriverRegistrationEntry[] }>>;
  probe(request?: { harnessId?: string; forceRefresh?: boolean }): Promise<
    ServiceMethodResult<{ probes: DriverProbeSnapshotDto[] }>
  >;
  readUsageLimits?(request?: { harnessId?: string }): Promise<ServiceMethodResult<DriverUsageLimitSnapshotDto>>;
  listCommands?(request?: { harnessId?: string }): Promise<
    ServiceMethodResult<{ commands: DriverCommandCapability[] }>
  >;
  runCommand?(request: {
    sessionId: string;
    harnessId: string;
    command: string;
    args?: string;
  }): Promise<ServiceMethodResult<DriverCommandReceipt>>;
}
