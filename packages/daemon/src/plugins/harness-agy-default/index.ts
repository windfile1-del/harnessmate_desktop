import fs from 'node:fs';
import path from 'node:path';
import {
  AGY_ACCOUNTS_CONTRACT,
  AGY_ACCOUNTS_CONTRACT_VERSION,
  AGY_RUNTIME_CONTRACT,
  AGY_RUNTIME_CONTRACT_VERSION,
  HARNESS_DRIVER_AGY_CONTRACT,
  HARNESS_DRIVER_CONTRACT,
  HARNESS_DRIVER_CONTRACT_VERSION,
  type AgyAccountAuthStateDto,
  type AgyAccountInstanceDto,
  type AgyAccountProfileSummaryDto,
  type AgyAccountsServiceV1,
  type AgyDispatchProvenanceDto,
  type AgyProviderIdentity,
  type AgyRuntimeBindingDto,
  type AgyRuntimeServiceV1,
  type AgyRuntimeStreamIdentity,
  type AgyTurnSettlementDecisionDto,
  type DriverCommandCapability,
  type DriverRegistrationEntry,
  type HarnessDriverProviderServiceV1,
  type ServiceMethodResult,
} from '@harnessmate/plugin-api';
import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  NativeCommandRequestSchema,
  NativeCommandResponseSchema,
  NativeControlRequestSchema,
  NativeControlResponseSchema,
  NativeEventsResponseSchema,
  NativeRequestDetailsResponseSchema,
  NativeSnapshotResponseSchema,
  NativeTimelineResponseSchema,
  NativeWorkflowResourceKindSchema,
  NativeWorkflowResourceResponseSchema,
  ResolveNativeRequestInputSchema,
  ResolveNativeRequestResponseSchema,
  UpsertAgyInstanceRequestSchema,
  asBindingGeneration,
  asRuntimeId,
  asWorkflowId,
  type AgyAuthState,
  type AgyProfileConfig,
  type CapabilityDescriptor,
  type NativeControlTargetType,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import type { DaemonPersistedConfig } from '../../config.js';
import { EffectOutboxWorker } from '../../core/effect-outbox.js';
import type { SessionManager } from '../../core/session-manager.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import { listAgySessionArtifacts, readAgySessionArtifact } from '../../harnesses/agy/agy-artifacts.js';
import { AgyAuthService } from '../../harnesses/agy/agy-auth-service.js';
import { listAgySubagentRecords, readAgySubagentDetail } from '../../harnesses/agy/agy-child-work.js';
import { AgyAdapter, createAgyDriverFactory } from '../../harnesses/agy/agy-driver.js';
import { collectAgyEcosystemSnapshot } from '../../harnesses/agy/agy-ecosystem.js';
import { resolveAgyProfileDirectories } from '../../harnesses/agy/agy-profile-manager.js';
import { wireAgyNativeRuntime } from '../../harnesses/agy/native/wiring/composition.js';
import { NativePersistenceError, computePayloadDigest } from '../../harnesses/agy/native/wiring/persistence.js';
import {
  evaluateAgyConsumerProvenance,
  mintAgyDispatchProvenance,
} from '../../harnesses/agy/native/wiring/provenance.js';
import { AgyNativeRuntimeRegistry } from '../../harnesses/agy/native/wiring/registry.js';
import type {
  AgyNativeFeatureFlags,
  NativeRuntimeHooks,
  NativeTurnSettlementSink,
} from '../../harnesses/agy/native/wiring/types.js';
import { sanitizeInstanceEnv, type HarnessRegistry } from '../../harnesses/registry.js';
import type { AdapterSessionHandle, HarnessAdapter } from '../../harnesses/types.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { PluginManager } from '../plugin-manager.js';

export const HARNESS_AGY_PLUGIN_ID = 'core.harness.agy';
export const HARNESS_AGY_DEFAULT_INSTANCE_ID = 'harness-agy';
export const AGY_RUNTIME_INTERNAL_SERVICE = 'agy.runtime.internal';

export const AGY_SUPPORTED_COMMANDS: DriverCommandCapability[] = [
  { command: 'model', description: '查看列表或切换当前会话的模型', argumentHint: '[模型 ID | default]', supported: true, source: 'builtin' },
  { command: 'plan', description: '进入计划模式，或用 off 退出', argumentHint: '[任务 | off]', supported: true, source: 'builtin' },
  { command: 'usage', description: '查看底层 CLI 提供的用量或额度', supported: true, source: 'builtin' },
  { command: 'compact', description: '压缩原生会话的模型上下文', supported: true, source: 'builtin' },
  { command: 'goal', description: '查看或设置原生目标', argumentHint: '[目标 | status | pause | resume | clear]', supported: true, source: 'builtin' },
  { command: 'skills', description: '列出此工作区可调用的原生技能', supported: true, source: 'builtin' },
  { command: 'skill', description: '调用指定技能', argumentHint: '<名称> [参数]', supported: true, source: 'builtin' },
];

export interface AgyRuntimeInternalHandle {
  readonly pluginId: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly nativeRegistry: AgyNativeRuntimeRegistry;
  readonly authService: AgyAuthService;
  readonly outboxWorker: EffectOutboxWorker;
  readonly provenancePolicy: 'strict_consumer_oauth' | 'permissive';
  resolvePreparedHooks(bindingRef: string): NativeRuntimeHooks | undefined;
  createObservatoryHooks(sessionId: string, harnessId: string): NativeRuntimeHooks | undefined;
  bindTurnSettlementSink(sink: NativeTurnSettlementSink): void;
  getAdapterByHarnessId(harnessId: string): AgyAdapter | undefined;
  listManagedHarnessIds(): string[];
  isAccepting(): boolean;
}

export interface CreateAgyDriverPluginParams {
  store: HarnessMateStore;
  registry: HarnessRegistry;
  config: DaemonPersistedConfig;
  profilesRootDir: string;
  overrides?: readonly HarnessAdapter[];
  initialNativeFeatureFlags?: Partial<AgyNativeFeatureFlags>;
  getSessionManager?: () => SessionManager | undefined;
  getPluginManager?: () => PluginManager | undefined;
  onConfigSave?: () => void;
  onAuthStateChanged?: (state: AgyAuthState) => void;
  onUsageCacheInvalidate?: (harnessId: string) => void;
  onCloseHarnessSessions?: (harnessId: string) => Promise<void>;
  getPendingSettlementSink?: () => NativeTurnSettlementSink | undefined;
}

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr(code: string, message: string): ServiceMethodResult<never> {
  return { ok: false, error: { code, message } };
}

function toAuthStateDto(
  state: AgyAuthState,
  pluginInstanceId: string,
  profileInstanceId: string,
): AgyAccountAuthStateDto {
  return {
    instanceId: state.instanceId,
    profileInstanceId,
    pluginInstanceId,
    phase: state.phase,
    flowId: state.flowId ?? null,
    authUrl: state.authorizationUrl ?? null,
    message: state.message ?? null,
    error: state.phase === 'failed' ? (state.message ?? null) : null,
    updatedAt: Date.now(),
  };
}

function toProfileSummaryDto(profile: AgyProfileConfig): AgyAccountProfileSummaryDto {
  return {
    instanceId: profile.instanceId,
    displayName: profile.displayName,
    description: profile.description,
    isolationMode: profile.isolationMode,
    authMethod: profile.authMethod,
    geminiDir: profile.geminiDir,
    appDataDirName: profile.appDataDirName,
    binaryPath: profile.binaryPath,
    gcpProject: profile.gcpProject,
    gcpLocation: profile.gcpLocation,
    enabled: profile.enabled,
    identity: profile.identity ? { ...profile.identity } : null,
    defaults: profile.defaults ? { ...profile.defaults } : undefined,
  };
}

function isControlAuthorizedByCatalog(
  descriptors: readonly CapabilityDescriptor[],
  targetType: NativeControlTargetType,
  action: string,
): boolean {
  const targetMatchesDescriptor = (descId: string): boolean => {
    switch (targetType) {
      case 'runtime':
        return ['AGY-R01', 'AGY-R10', 'agy.acp.v1', 'agy.reactive.background'].includes(descId);
      case 'activity':
      case 'work':
        return (
          descId === 'agy.acp.v1' ||
          descId.startsWith('agy.reactive') ||
          descId.startsWith('agy.workflow.')
        );
      case 'agent':
        return descId === 'agy.subagents' || descId.startsWith('agy.workflow.swarm');
      case 'workflow':
        return descId.startsWith('agy.workflow.');
    }
  };

  for (const desc of descriptors) {
    if (desc.control !== 'available') continue;
    if (!targetMatchesDescriptor(desc.id)) continue;
    if (desc.actions.length > 0) {
      const matched = desc.actions.find(
        (a) => (a.key === action || (action === 'stop' && a.key === 'cancel')) && a.gate === 'available',
      );
      if (matched) return true;
    } else {
      return true;
    }
  }
  return false;
}

function createLazySessionManagerProxy(
  getSessionManager?: () => SessionManager | undefined,
): SessionManager {
  return new Proxy({} as SessionManager, {
    get(_target, prop) {
      const real = getSessionManager?.();
      if (!real) {
        if (prop === 'getSession') return () => null;
        if (prop === 'getRequestBroker') return () => { throw new Error('Request provider unavailable'); };
        return undefined;
      }
      const value = (real as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });
}

function wrapAgyAdapterLifecycle(
  base: HarnessAdapter,
  identity: {
    pluginId: string;
    instanceId: string;
    runId: string;
    supportedCommands: DriverCommandCapability[];
  },
  activeHandles: Set<AdapterSessionHandle>,
  isAccepting: () => boolean,
): HarnessAdapter {
  // Preserve AgyAdapter prototype/methods if base is AgyAdapter so internal AGY plugin consumers work cleanly
  base.providerPluginId = identity.pluginId;
  base.providerInstanceId = identity.instanceId;
  base.providerRunId = identity.runId;
  if (!base.supportedCommands) {
    (base as { supportedCommands?: DriverCommandCapability[] }).supportedCommands = identity.supportedCommands;
  }

  const originalCreateSession = base.createSession.bind(base);
  base.createSession = async (sessionConfig) => {
    if (!isAccepting()) {
      throw new Error(`AGY 插件实例 (${identity.instanceId}) 已停止接收新会话`);
    }
    const handle = await originalCreateSession(sessionConfig);
    activeHandles.add(handle);
    const originalDispose = handle.dispose.bind(handle);
    handle.dispose = async () => {
      activeHandles.delete(handle);
      return originalDispose();
    };
    return handle;
  };
  return base;
}

export function createAgyDriverPlugin(
  params: CreateAgyDriverPluginParams,
): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  let runSeq = 0;

  return {
    provides: [
      HARNESS_DRIVER_CONTRACT,
      HARNESS_DRIVER_AGY_CONTRACT,
      AGY_RUNTIME_CONTRACT,
      AGY_ACCOUNTS_CONTRACT,
      'harness.agy',
      AGY_RUNTIME_INTERNAL_SERVICE,
    ],
    apply(ctx, settings) {
      ctx.host?.setRegistryBridge(params.registry);
      const providerInstanceId = ctx.instanceId ?? HARNESS_AGY_DEFAULT_INSTANCE_ID;
      const isPrimaryInstance =
        providerInstanceId === HARNESS_AGY_DEFAULT_INSTANCE_ID ||
        providerInstanceId === HARNESS_AGY_PLUGIN_ID;
      const runId = `agy-run-${++runSeq}`;
      let accepting = true;
      let configRevision = 1;

      const cfg = (settings ?? {}) as {
        harnessId?: string;
        instances?: import('@harnessmate/protocol').HarnessInstanceConfig[];
        profiles?: AgyProfileConfig[];
        profileInstanceId?: string;
        displayName?: string;
        description?: string;
        binaryPath?: string;
        homeDir?: string;
        geminiDir?: string;
        profilesRootDir?: string;
        appDataDirName?: string;
        authMethod?: AgyProfileConfig['authMethod'];
        isolationMode?: AgyProfileConfig['isolationMode'];
        gcpProject?: string;
        gcpLocation?: string;
        envWhitelist?: Record<string, string>;
        provenancePolicy?: 'strict_consumer_oauth' | 'permissive';
        nativeFeatureFlags?: Partial<AgyNativeFeatureFlags>;
      };

      const provenancePolicy: 'strict_consumer_oauth' | 'permissive' =
        cfg.provenancePolicy === 'permissive' ? 'permissive' : 'strict_consumer_oauth';
      const instanceProfilesRootDir =
        cfg.profilesRootDir?.trim() ||
        (isPrimaryInstance
          ? params.profilesRootDir
          : path.join(params.profilesRootDir, '__plugin_instances', providerInstanceId.replace(/[^a-z0-9._-]/gi, '_')));

      // Own native persistence schema + outbox + registry + wiring inside this plugin instance
      const nativeRegistry = new AgyNativeRuntimeRegistry(params.store, {
        ...params.initialNativeFeatureFlags,
        ...cfg.nativeFeatureFlags,
      });
      nativeRegistry.persistence.ensureProviderMappingSchema();
      if (isPrimaryInstance) {
        nativeRegistry.persistence.markAttachedBindingsReconcilingOnStartup();
      } else {
        nativeRegistry.persistence.markProviderBindingsReconciling(providerInstanceId);
      }

      const outboxWorker = new EffectOutboxWorker(params.store);
      const lazySessionManager = createLazySessionManagerProxy(params.getSessionManager);
      const disposeNativeWiring = wireAgyNativeRuntime(
        nativeRegistry,
        lazySessionManager,
        params.registry,
        {
          ...params.config.binaryOverrides,
          ...(cfg.binaryPath ? { agy: cfg.binaryPath } : {}),
        },
        providerInstanceId,
      );

      // Re-attach host settlement sink if SessionManager already registered one
      const pendingSink = params.getPendingSettlementSink?.();
      if (pendingSink) {
        nativeRegistry.bindTurnSettlementSink(pendingSink);
      }

      // Managed adapters and local profile store for THIS plugin instance
      const activeHandles = new Set<AdapterSessionHandle>();
      const registeredEntries = new Map<string, { harnessId: string; profileInstanceId: string; adapter: HarnessAdapter }>();
      const localProfiles = new Map<string, AgyProfileConfig>();
      const preparedHooksByRef = new Map<string, NativeRuntimeHooks>();
      const acknowledgedSettlements = new Set<string>();
      let hookRefSeq = 0;

      const getProfileLookup = (profileId: string): AgyProfileConfig | undefined => {
        if (localProfiles.has(profileId)) return localProfiles.get(profileId);
        if (isPrimaryInstance) {
          return (params.config.agyProfiles ?? []).find((p) => p.instanceId === profileId);
        }
        return undefined;
      };

      const driverFactory = createAgyDriverFactory({
        profilesRootDir: instanceProfilesRootDir,
        binaryOverride: cfg.binaryPath ?? params.config.binaryOverrides.agy,
        getProfileConfig: getProfileLookup,
      });

      const registerSingleAgyAdapter = (opts: {
        harnessId: string;
        profileInstanceId: string;
        isDefault: boolean;
        adapter: HarnessAdapter;
        profile?: AgyProfileConfig;
        instanceConfig?: {
          binaryPath?: string;
          homeDir?: string;
          displayName?: string;
          description?: string;
          envWhitelist?: Record<string, string>;
          enabled?: boolean;
        };
      }) => {
        const wrapped = wrapAgyAdapterLifecycle(
          opts.adapter,
          {
            pluginId: HARNESS_AGY_PLUGIN_ID,
            instanceId: providerInstanceId,
            runId,
            supportedCommands: AGY_SUPPORTED_COMMANDS,
          },
          activeHandles,
          () => accepting,
        );
        if (opts.profile) {
          localProfiles.set(opts.profileInstanceId, opts.profile);
        }
        params.registry.registerProviderDriver({
          pluginId: HARNESS_AGY_PLUGIN_ID,
          providerInstanceId,
          providerRunId: runId,
          driverId: 'agy',
          harnessId: opts.harnessId,
          isDefault: opts.isDefault,
          adapter: wrapped,
          instanceConfig: {
            binaryPath: opts.instanceConfig?.binaryPath ?? opts.profile?.binaryPath ?? cfg.binaryPath ?? params.config.binaryOverrides.agy,
            homeDir: opts.instanceConfig?.homeDir ?? opts.profile?.geminiDir ?? cfg.geminiDir ?? cfg.homeDir,
            displayName: opts.instanceConfig?.displayName ?? wrapped.displayName,
            description: opts.instanceConfig?.description ?? wrapped.description,
            envWhitelist: opts.instanceConfig?.envWhitelist ?? cfg.envWhitelist,
            enabled: opts.instanceConfig?.enabled ?? opts.profile?.enabled ?? true,
          },
        });
        registeredEntries.set(opts.harnessId, {
          harnessId: opts.harnessId,
          profileInstanceId: opts.profileInstanceId,
          adapter: wrapped,
        });
        return wrapped;
      };

      const buildAgyAdapterFromProfile = (profile: AgyProfileConfig): AgyAdapter => {
        const sanitizedEnv = sanitizeInstanceEnv(cfg.envWhitelist);
        return new AgyAdapter({
          profile,
          profilesRootDir: instanceProfilesRootDir,
          binaryOverride: profile.binaryPath ?? cfg.binaryPath ?? params.config.binaryOverrides.agy,
          envWhitelist: sanitizedEnv,
        });
      };

      // Primary instance registers default 'agy' + legacy agyProfiles + legacy harnessInstances(driverId='agy')
      let primaryAdapter: HarnessAdapter;
      if (isPrimaryInstance) {
        const profiles = cfg.profiles ?? params.config.agyProfiles ?? [];
        const overrideAgy = params.overrides?.find((candidate) => candidate.id === 'agy');
        const primaryProfile = profiles.find((p) => p.instanceId === 'agy');
        const primaryHarnessId = cfg.harnessId?.trim() || 'agy';

        const resolvedPrimaryProfile: AgyProfileConfig = primaryProfile ?? {
          instanceId: primaryHarnessId,
          displayName: cfg.displayName ?? 'Antigravity CLI',
          description: cfg.description ?? 'Google Antigravity CLI via native Agent Client Protocol (ACP)',
          isolationMode: cfg.isolationMode ?? (cfg.geminiDir || cfg.homeDir ? 'profile_isolated' : 'official_default'),
          authMethod: cfg.authMethod ?? 'oauth-personal',
          geminiDir: cfg.geminiDir ?? cfg.homeDir,
          appDataDirName: cfg.appDataDirName ?? 'antigravity',
          binaryPath: cfg.binaryPath ?? params.config.binaryOverrides.agy,
          gcpProject: cfg.gcpProject,
          gcpLocation: cfg.gcpLocation,
          defaults: {
            linkGlobalSkills: true,
            syncGlobalRules: true,
            additionalDirectories: [],
          },
          enabled: true,
        };

        if (overrideAgy) {
          primaryAdapter = registerSingleAgyAdapter({
            harnessId: primaryHarnessId,
            profileInstanceId: 'agy',
            isDefault: true,
            adapter: overrideAgy,
            profile: resolvedPrimaryProfile,
          });
        } else {
          primaryAdapter = registerSingleAgyAdapter({
            harnessId: primaryHarnessId,
            profileInstanceId: resolvedPrimaryProfile.instanceId,
            isDefault: true,
            adapter: buildAgyAdapterFromProfile(resolvedPrimaryProfile),
            profile: resolvedPrimaryProfile,
          });
        }

        for (const profile of profiles) {
          if (profile.instanceId === 'agy' || !profile.enabled) continue;
          registerSingleAgyAdapter({
            harnessId: profile.instanceId,
            profileInstanceId: profile.instanceId,
            isDefault: false,
            adapter: buildAgyAdapterFromProfile(profile),
            profile,
          });
        }

        for (const instance of cfg.instances ?? params.config.harnessInstances ?? []) {
          if (instance.driverId !== 'agy' || !instance.enabled) continue;
          if (registeredEntries.has(instance.instanceId)) continue;
          const adapter = driverFactory({
            ...instance,
            continuationKey: instance.continuationKey ?? `agy:instance:${instance.instanceId}`,
            sanitizedEnv: sanitizeInstanceEnv(instance.envWhitelist),
          });
          registerSingleAgyAdapter({
            harnessId: instance.instanceId,
            profileInstanceId: instance.instanceId,
            isDefault: false,
            adapter,
            instanceConfig: instance,
          });
        }
      } else {
        // Secondary multi-instance of core.harness.agy (independent CLI, homeDir, profilesRootDir, account)
        const targetProfileId = cfg.profileInstanceId?.trim() || cfg.harnessId?.trim() || providerInstanceId;
        const targetHarnessId = cfg.harnessId?.trim() || providerInstanceId;
        const secondaryProfile: AgyProfileConfig = {
          instanceId: targetProfileId,
          displayName: cfg.displayName ?? `Antigravity (${providerInstanceId})`,
          description: cfg.description ?? `Isolated AGY plugin instance (${providerInstanceId})`,
          isolationMode: cfg.isolationMode ?? 'profile_isolated',
          authMethod: cfg.authMethod ?? 'oauth-personal',
          geminiDir: cfg.geminiDir ?? cfg.homeDir,
          appDataDirName: cfg.appDataDirName ?? 'antigravity',
          binaryPath: cfg.binaryPath ?? params.config.binaryOverrides.agy,
          gcpProject: cfg.gcpProject,
          gcpLocation: cfg.gcpLocation,
          defaults: {
            linkGlobalSkills: true,
            syncGlobalRules: true,
            additionalDirectories: [],
          },
          enabled: true,
        };
        primaryAdapter = registerSingleAgyAdapter({
          harnessId: targetHarnessId,
          profileInstanceId: targetProfileId,
          isDefault: false,
          adapter: buildAgyAdapterFromProfile(secondaryProfile),
          profile: secondaryProfile,
        });
      }

      // Per-instance AgyAuthService scoped strictly to adapters owned by THIS plugin instance
      const getOwnedAgyAdapter = (id: string): AgyAdapter | undefined => {
        const direct = registeredEntries.get(id);
        if (direct && direct.adapter instanceof AgyAdapter) return direct.adapter;
        for (const entry of registeredEntries.values()) {
          if (entry.profileInstanceId === id && entry.adapter instanceof AgyAdapter) {
            return entry.adapter;
          }
        }
        return undefined;
      };

      const authService = new AgyAuthService({
        getAdapter: getOwnedAgyAdapter,
        stopInstanceSessions: async (id) => {
          const entry = registeredEntries.get(id) ?? [...registeredEntries.values()].find((e) => e.profileInstanceId === id);
          const harnessId = entry?.harnessId ?? id;
          if (params.onCloseHarnessSessions) {
            await params.onCloseHarnessSessions(harnessId);
          } else {
            await params.getSessionManager?.()?.closeSessionsForHarness(harnessId);
          }
        },
        onIdentityUpdated: (id, identity) => {
          const existingLocal = localProfiles.get(id);
          if (existingLocal) {
            localProfiles.set(id, { ...existingLocal, identity });
          }
          if (isPrimaryInstance) {
            const idx = params.config.agyProfiles.findIndex((p) => p.instanceId === id);
            if (idx >= 0) {
              params.config.agyProfiles[idx] = { ...params.config.agyProfiles[idx]!, identity };
              params.onConfigSave?.();
            }
          }
          configRevision += 1;
        },
        onUsageCacheInvalidate: (id) => {
          params.onUsageCacheInvalidate?.(id);
        },
        onStateChanged: (state) => {
          params.onAuthStateChanged?.(state);
          ctx.services?.publish(AGY_ACCOUNTS_CONTRACT, {
            event: 'auth_state_changed',
            pluginInstanceId: providerInstanceId,
            runId,
            state: toAuthStateDto(state, providerInstanceId, state.instanceId),
          });
        },
      });

      // Publish native runtime events over peer service channel
      const activeRuntimeEventUnsubs = new Set<() => void>();

      const buildIdentityFor = (
        harnessId: string,
        binding?: RuntimeBinding | null,
        nativeSessionId?: string | null,
      ): AgyProviderIdentity => {
        const entry = registeredEntries.get(harnessId);
        return {
          pluginId: HARNESS_AGY_PLUGIN_ID,
          pluginInstanceId: providerInstanceId,
          driverProviderInstanceId: providerInstanceId,
          runId,
          profileInstanceId: entry?.profileInstanceId ?? harnessId,
          harnessId,
          nativeSessionId: nativeSessionId ?? null,
          runtimeId: binding?.runtimeId ?? null,
          generation: binding?.generation ?? null,
        };
      };

      const buildStreamFor = (binding: RuntimeBinding): AgyRuntimeStreamIdentity => ({
        providerInstanceId,
        runId,
        runtimeId: binding.runtimeId,
        generation: binding.generation,
        sessionId: binding.sessionId,
        harnessId: binding.instanceId,
      });

      const resolveSessionOrError = (
        sessionId: string,
      ):
        | { ok: false; error: ServiceMethodResult<never> }
        | { ok: true; session: NonNullable<ReturnType<HarnessMateStore['getSession']>>; adapter: AgyAdapter | null } => {
        if (!accepting) {
          return { ok: false, error: peerErr('plugin_disabled', `AGY 运行时插件实例 (${providerInstanceId}) 已停用`) };
        }
        const schema = nativeRegistry.getSchemaStatus();
        if (!schema.compatible) {
          return {
            ok: false,
            error: peerErr(
              'NATIVE_SCHEMA_NEWER_THAN_READER',
              `Native runtime schema version ${schema.storedVersion} is newer than supported version ${schema.supportedVersion}`,
            ),
          };
        }
        const session = params.getSessionManager?.()?.getSession(sessionId) ?? params.store.getSession(sessionId);
        if (!session) {
          return { ok: false, error: peerErr('NOT_FOUND', 'Session not found') };
        }
        if (session.harnessKind !== 'agy') {
          return { ok: false, error: peerErr('UNSUPPORTED_ACTION', 'Native AGY runtime routes are only available for AGY sessions') };
        }
        const rawAdapter = params.registry.get(session.harnessId);
        const adapter = getOwnedAgyAdapter(session.harnessId) ?? (rawAdapter instanceof AgyAdapter ? rawAdapter : null);
        return { ok: true, session, adapter };
      };

      const verifyProvenanceInternal = (
        harnessId: string,
        driverId: string,
        provenance?: AgyDispatchProvenanceDto | null,
      ) => {
        if (provenancePolicy === 'permissive') {
          return {
            allowed: true,
            policyMode: 'permissive' as const,
            channel: provenance?.channel ?? 'unverified_forged',
          };
        }
        const adapter = getOwnedAgyAdapter(harnessId);
        const profile = adapter?.getProfile() ?? localProfiles.get(harnessId) ?? null;
        const sealedProof = provenance?.verifiedByHost
          ? mintAgyDispatchProvenance(provenance.channel, provenance.actor, provenance.reason)
          : undefined;
        const decision = evaluateAgyConsumerProvenance(
          {
            instanceId: harnessId,
            driverId,
            profile,
          },
          sealedProof,
        );
        return {
          allowed: decision.allowed,
          ...(decision.code ? { code: decision.code } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
          policyMode: 'strict_consumer_oauth' as const,
          channel: decision.channel,
        };
      };

      // ── 1. HarnessDriverProviderServiceV1 ──────────────────────────────
      const toRegEntry = (item: { harnessId: string; adapter: HarnessAdapter }): DriverRegistrationEntry => ({
        key: `${providerInstanceId}::agy::${item.harnessId}`,
        pluginId: HARNESS_AGY_PLUGIN_ID,
        instanceId: providerInstanceId,
        driverId: 'agy',
        harnessId: item.harnessId,
        runId,
        displayName: item.adapter.displayName,
        description: item.adapter.description,
        protocolLabel: item.adapter.protocolLabel,
        continuationKey: item.adapter.continuationKey,
        isDefault: isPrimaryInstance && item.harnessId === primaryAdapter.id,
        capabilities: item.adapter.capabilities,
        capabilitiesV2: item.adapter.capabilitiesV2,
        presentation: item.adapter.presentation,
        supportedCommands: item.adapter.supportedCommands ?? AGY_SUPPORTED_COMMANDS,
      });

      const driverService: HarnessDriverProviderServiceV1 = {
        async getProviderInfo() {
          return peerOk({
            pluginId: HARNESS_AGY_PLUGIN_ID,
            instanceId: providerInstanceId,
            runId,
            driverIds: ['agy'],
            harnessIds: [...registeredEntries.keys()],
          });
        },
        async listHarnessInstances() {
          return peerOk({
            instances: [...registeredEntries.values()].map(toRegEntry),
          });
        },
        async probe(req) {
          const targets = [...registeredEntries.values()].filter(
            (r) => !req?.harnessId || r.harnessId === req.harnessId,
          );
          const probes = await Promise.all(
            targets.map(async (r) => {
              const info = await (!req?.forceRefresh && r.adapter.probePassive
                ? r.adapter.probePassive()
                : r.adapter.probe());
              return {
                harnessId: r.harnessId,
                driverId: 'agy',
                providerPluginId: HARNESS_AGY_PLUGIN_ID,
                providerInstanceId,
                providerRunId: runId,
                binaryPath: info.binaryPath,
                version: info.version,
                health: info.health,
                healthMessage: info.healthMessage,
                models: info.models,
                defaultModelId: info.defaultModelId,
                accountSummary: info.accountSummary,
                supportedCommands: r.adapter.supportedCommands ?? AGY_SUPPORTED_COMMANDS,
              };
            }),
          );
          return peerOk({ probes });
        },
        async readUsageLimits(req) {
          const target = [...registeredEntries.values()].find(
            (r) => !req?.harnessId || r.harnessId === req.harnessId,
          );
          if (!target?.adapter.readUsageLimits) {
            return peerErr('not_supported', 'AGY 驱动未实现额度查询');
          }
          const usage = await target.adapter.readUsageLimits();
          return peerOk({
            harnessId: target.harnessId,
            driverId: 'agy',
            providerInstanceId,
            loggedIn: usage.loggedIn,
            accountLabel: usage.accountLabel,
            planType: usage.planType,
            authMethod: usage.authMethod,
            billingTier: usage.billingTier,
            gatewayUrl: usage.gatewayUrl,
            rateLimits: usage.rateLimits,
            error: usage.error,
          });
        },
        async listCommands() {
          return peerOk({ commands: AGY_SUPPORTED_COMMANDS });
        },
      };

      // ── 2. AgyRuntimeServiceV1 (`agy.runtime.v1`) ─────────────────────
      const runtimeService: AgyRuntimeServiceV1 = {
        async getProviderInfo() {
          const flags = nativeRegistry.getFeatureFlags();
          const schema = nativeRegistry.getSchemaStatus();
          return peerOk({
            pluginId: HARNESS_AGY_PLUGIN_ID,
            instanceId: providerInstanceId,
            driverProviderInstanceId: providerInstanceId,
            runId,
            acceptingCommands: accepting,
            featureFlags: { ...flags },
            schemaStatus: {
              component: schema.component,
              supportedVersion: schema.supportedVersion,
              storedVersion: schema.storedVersion,
              compatible: schema.compatible,
            },
            provenancePolicy,
            legacyApprovalBridge: {
              mode: 'unified_requests',
              owner: 'agy.runtime.v1',
              handoffTarget: 'runtime.requests.v1',
              supportsCasResolution: true,
              supportsNativeOptions: true,
              supportsDeadlines: true,
            },
          });
        },

        async getSnapshot({ sessionId, harnessId }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const targetHarnessId = harnessId ?? resolved.session.harnessId;
          const projection = nativeRegistry.getProjectionForSession(resolved.session.id, targetHarnessId);
          const snapshot = NativeSnapshotResponseSchema.parse({
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            contractRevision: AGY_NATIVE_CONTRACT_REVISION,
            enabled: projection.enabled,
            projection,
          });
          return peerOk({
            snapshot: snapshot as unknown as Record<string, unknown>,
            provider: buildIdentityFor(targetHarnessId, projection.binding, resolved.session.nativeSessionId),
            stream: buildStreamFor(projection.binding),
          });
        },

        async getCapabilities({ sessionId, harnessId }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const targetHarnessId = harnessId ?? resolved.session.harnessId;
          const capabilities = nativeRegistry.getCapabilitiesForSession(resolved.session.id, targetHarnessId);
          return peerOk({
            capabilities: capabilities as unknown as Record<string, unknown>,
            provider: buildIdentityFor(targetHarnessId, capabilities.binding, resolved.session.nativeSessionId),
          });
        },

        async readEvents({ sessionId, harnessId, afterSeq, limit, cursor, generation }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const targetHarnessId = harnessId ?? resolved.session.harnessId;
          const res = nativeRegistry.readEventsForSession(resolved.session.id, targetHarnessId, {
            afterSeq: afterSeq ?? 0,
            limit: limit ?? 200,
            cursor,
            expectedGeneration: generation ? asBindingGeneration(generation) : undefined,
          });
          if (res.resyncRequired) {
            return peerOk({
              resyncRequired: true,
              reason: res.reason,
              latestSeq: res.latestSeq,
              currentGeneration: res.currentGeneration,
            });
          }
          const validated = NativeEventsResponseSchema.parse({
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            binding: res.binding,
            runtimeId: res.runtimeId,
            generation: res.generation,
            asOfSeq: res.asOfSeq,
            events: res.events,
            nextSeq: res.nextSeq,
            nextCursor: res.nextCursor,
            hasMore: res.hasMore,
          });
          return peerOk({
            ...(validated as unknown as Record<string, unknown>),
            stream: buildStreamFor(res.binding),
          });
        },

        async readTimeline({ sessionId, scopeKind, scopeId, pageToken, limit }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const projection = nativeRegistry.getProjectionForSession(resolved.session.id, resolved.session.harnessId);
          const flags = nativeRegistry.getFeatureFlags();
          const reader = flags.enabled ? nativeRegistry.getTimelineReaderPort() : null;
          const page = reader
            ? reader.readTimeline({
                binding: projection.binding,
                scopeKind,
                scopeId,
                pageToken,
                limit: limit ?? 100,
              })
            : {
                revision: projection.asOfSeq,
                items: [],
                nextPageToken: null,
                hasMore: false,
                sourceUnavailableReason: flags.enabled
                  ? 'timeline_reader_unregistered'
                  : 'native_runtime_disabled',
              };
          const validated = NativeTimelineResponseSchema.parse({
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            binding: projection.binding,
            scopeKind,
            scopeId,
            revision: page.revision,
            items: [...page.items],
            nextPageToken: page.nextPageToken,
            hasMore: page.hasMore,
            ...(page.sourceUnavailableReason ? { sourceUnavailableReason: page.sourceUnavailableReason } : {}),
          });
          return peerOk(validated as unknown as Record<string, unknown>);
        },

        async readWorkflowResource({ sessionId, workflowId, resource, pageToken, limit }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const parsedResource = NativeWorkflowResourceKindSchema.safeParse(resource);
          if (!parsedResource.success) {
            return peerErr('INVALID_REQUEST', 'Workflow resource must be one of: board, phases, logs, artifacts');
          }
          const projection = nativeRegistry.getProjectionForSession(resolved.session.id, resolved.session.harnessId);
          const parsedWorkflowId = asWorkflowId(workflowId);
          const flags = nativeRegistry.getFeatureFlags();
          const reader = flags.enabled ? nativeRegistry.getWorkflowResourceReaderPort() : null;
          const page = reader
            ? reader.readWorkflowResource({
                binding: projection.binding,
                workflowId: parsedWorkflowId,
                resource: parsedResource.data,
                pageToken,
                limit: limit ?? 100,
              })
            : {
                revision: projection.asOfSeq,
                available: false,
                sourceUnavailableReason: flags.enabled
                  ? 'workflow_resource_not_available'
                  : 'native_runtime_disabled',
                items: [],
                nextPageToken: null,
                hasMore: false,
              };
          const validated = NativeWorkflowResourceResponseSchema.safeParse({
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            binding: projection.binding,
            workflowId: parsedWorkflowId,
            resource: parsedResource.data,
            revision: page.revision,
            available: page.available,
            ...(page.sourceUnavailableReason ? { sourceUnavailableReason: page.sourceUnavailableReason } : {}),
            items: [...page.items],
            nextPageToken: page.nextPageToken,
            hasMore: page.hasMore,
          });
          if (!validated.success) {
            return peerOk({
              __nativeError: {
                statusCode: 500,
                code: 'INVALID_REQUEST',
                message: 'Workflow resource reader returned payload failing public DTO allowlist validation',
              },
            });
          }
          return peerOk(validated.data as unknown as Record<string, unknown>);
        },

        async submitCommand({ sessionId, body, provenance }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const flags = nativeRegistry.getFeatureFlags();
          if (!flags.enabled || !flags.nativeCommands) {
            return peerErr('NATIVE_RUNTIME_DISABLED', 'Native AGY command routing is currently disabled by feature gate');
          }
          const parsed = NativeCommandRequestSchema.safeParse(body);
          if (!parsed.success) {
            return peerErr('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid native command payload');
          }
          const prov = verifyProvenanceInternal(
            resolved.session.harnessId,
            resolved.session.harnessKind,
            provenance ?? {
              channel: 'human_direct',
              actor: 'desktop',
              issuedAt: Date.now(),
              reason: 'agy.runtime.v1.submitCommand',
              verifiedByHost: true,
            },
          );
          if (!prov.allowed) {
            return peerErr('CONSUMER_PROVENANCE_BLOCKED', ('reason' in prov && prov.reason) ? prov.reason : 'Consumer provenance blocked');
          }
          const binding = nativeRegistry.getActiveBinding(resolved.session.id, resolved.session.harnessId);
          if (!binding || binding.generation !== parsed.data.bindingGeneration) {
            return peerOk({
              __nativeError: {
                statusCode: 409,
                code: 'STALE_BINDING',
                message: 'Binding generation does not match active runtime generation',
                retryable: true,
                details: { currentGeneration: binding?.generation ?? null },
              },
            });
          }
          const caps = nativeRegistry.getCapabilitiesForSession(resolved.session.id, resolved.session.harnessId);
          if (caps.capabilitiesRevision !== parsed.data.catalogRevision) {
            return peerOk({
              __nativeError: {
                statusCode: 409,
                code: 'STALE_BINDING',
                message: 'Capability catalog revision is stale; refresh capabilities before retrying',
                retryable: true,
                details: { currentCatalogRevision: caps.capabilitiesRevision },
              },
            });
          }
          const router = nativeRegistry.getCommandRouterPort();
          if (!router) {
            return peerOk({
              __nativeError: {
                statusCode: 422,
                code: 'UNSUPPORTED_ACTION',
                message: 'No native command router is registered for this runtime',
              },
            });
          }
          const descriptor = caps.descriptors.find((d) => d.id === parsed.data.capabilityId);
          const action = descriptor?.actions.find((a) => a.key === parsed.data.actionKey);
          if (!descriptor || !action || action.gate !== 'available') {
            return peerOk({
              __nativeError: {
                statusCode: 422,
                code: 'UNSUPPORTED_ACTION',
                message: `Action "${parsed.data.actionKey}" on capability "${parsed.data.capabilityId}" is not available`,
                details: { gate: action?.gate ?? 'unsupported' },
              },
            });
          }
          const digest = computePayloadDigest({
            bindingGeneration: parsed.data.bindingGeneration,
            catalogRevision: parsed.data.catalogRevision,
            capabilityId: parsed.data.capabilityId,
            actionKey: parsed.data.actionKey,
            args: parsed.data.args,
          });
          let claimed;
          try {
            claimed = nativeRegistry.persistence.claimIdempotentReceipt({
              binding,
              kind: 'command',
              idempotencyKey: parsed.data.idempotencyKey,
              payloadDigest: digest,
            });
          } catch (err) {
            if (err instanceof NativePersistenceError) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: err.code === 'IDEMPOTENCY_CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'STALE_BINDING',
                  message: err.message,
                  retryable: err.code === 'STALE_BINDING',
                },
              });
            }
            throw err;
          }
          if (claimed.replayed) {
            if (claimed.receipt.state === 'completed' && claimed.receipt.responseJson) {
              const cached = NativeCommandResponseSchema.safeParse(claimed.receipt.responseJson);
              if (cached.success) {
                return peerOk({
                  statusCode: cached.data.kind === 'accepted' ? 202 : 200,
                  body: cached.data,
                });
              }
            }
            if (claimed.receipt.state === 'claimed') {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'BUSY',
                  message: 'A command with this idempotencyKey is currently in flight',
                  retryable: true,
                  details: { receiptId: claimed.receipt.receiptId, receiptState: 'claimed' },
                },
              });
            }
            return peerOk({
              __nativeError: {
                statusCode: 409,
                code: 'DELIVERY_UNKNOWN',
                message: 'Previous execution for this idempotencyKey did not finish cleanly; inspect runtime state before issuing a new key',
                retryable: false,
                details: { receiptId: claimed.receipt.receiptId, receiptState: claimed.receipt.state },
              },
            });
          }
          try {
            const rawResponse = await router.executeCommand({
              binding,
              request: parsed.data,
              receiptId: claimed.receipt.receiptId,
            });
            const validatedResponse = NativeCommandResponseSchema.parse(rawResponse);
            const completed = nativeRegistry.persistence.completeIdempotentReceipt(
              claimed.receipt.receiptId,
              'completed',
              validatedResponse,
            );
            if (!completed) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'DELIVERY_UNKNOWN',
                  message: 'Runtime changed before its receipt could be completed',
                  retryable: false,
                  details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
                },
              });
            }
            return peerOk({
              statusCode: validatedResponse.kind === 'accepted' ? 202 : 200,
              body: validatedResponse,
            });
          } catch {
            nativeRegistry.persistence.completeIdempotentReceipt(
              claimed.receipt.receiptId,
              'delivery_unknown',
              { error: 'command_execution_failed' },
            );
            return peerOk({
              __nativeError: {
                statusCode: 500,
                code: 'DELIVERY_UNKNOWN',
                message: 'Command execution failed after dispatch claim; outcome is uncertain',
                retryable: false,
                details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
              },
            });
          }
        },

        async dispatchControl({ sessionId, body }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const flags = nativeRegistry.getFeatureFlags();
          if (!flags.enabled || !flags.nativeCommands) {
            return peerErr('NATIVE_RUNTIME_DISABLED', 'Native AGY control operations are currently disabled by feature gate');
          }
          const parsed = NativeControlRequestSchema.safeParse(body);
          if (!parsed.success) {
            return peerErr('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid native control payload');
          }
          const binding = nativeRegistry.getActiveBinding(resolved.session.id, resolved.session.harnessId);
          if (!binding || binding.generation !== parsed.data.generation) {
            return peerOk({
              __nativeError: {
                statusCode: 409,
                code: 'STALE_BINDING',
                message: 'Binding generation does not match active runtime generation',
                retryable: true,
                details: { currentGeneration: binding?.generation ?? null },
              },
            });
          }
          const router = nativeRegistry.getCommandRouterPort();
          if (!router) {
            return peerOk({
              __nativeError: {
                statusCode: 422,
                code: 'UNSUPPORTED_ACTION',
                message: 'No native control handler is registered for this runtime',
              },
            });
          }
          const caps = nativeRegistry.getCapabilitiesForSession(resolved.session.id, resolved.session.harnessId);
          if (!isControlAuthorizedByCatalog(caps.descriptors, parsed.data.target.type, parsed.data.action)) {
            return peerOk({
              __nativeError: {
                statusCode: 422,
                code: 'UNSUPPORTED_ACTION',
                message: `Control action "${parsed.data.action}" on target type "${parsed.data.target.type}" is not authorized by current capability descriptors`,
              },
            });
          }
          if (parsed.data.target.type === 'runtime') {
            if (parsed.data.target.id !== binding.runtimeId) {
              return peerOk({
                __nativeError: {
                  statusCode: 404,
                  code: 'NOT_FOUND',
                  message: 'Control target runtime does not match session binding',
                },
              });
            }
            const storedBinding = nativeRegistry.persistence.getBinding(binding.runtimeId);
            if (!storedBinding || storedBinding.asOfSeq !== parsed.data.expectedRevision) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'STALE_BINDING',
                  message: 'Expected runtime revision does not match current binding revision',
                  retryable: true,
                  details: { actualRevision: storedBinding?.asOfSeq ?? 0 },
                },
              });
            }
          } else {
            const entityMeta = nativeRegistry.persistence.getEntityMeta(
              binding.runtimeId,
              parsed.data.target.type,
              parsed.data.target.id,
            );
            if (!entityMeta) {
              return peerOk({
                __nativeError: {
                  statusCode: 404,
                  code: 'NOT_FOUND',
                  message: `Control target ${parsed.data.target.type}:${parsed.data.target.id} was not found in active runtime`,
                },
              });
            }
            if (entityMeta.generation !== binding.generation) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'STALE_BINDING',
                  message: 'Control target belongs to an older generation and cannot be controlled',
                  retryable: false,
                },
              });
            }
            if (entityMeta.revision !== parsed.data.expectedRevision) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'STALE_BINDING',
                  message: 'Control target revision mismatch',
                  retryable: true,
                  details: { actualRevision: entityMeta.revision },
                },
              });
            }
          }
          const digest = computePayloadDigest({
            generation: parsed.data.generation,
            target: parsed.data.target,
            action: parsed.data.action,
            expectedRevision: parsed.data.expectedRevision,
          });
          let claimed;
          try {
            claimed = nativeRegistry.persistence.claimIdempotentReceipt({
              binding,
              kind: 'control',
              idempotencyKey: parsed.data.idempotencyKey,
              payloadDigest: digest,
            });
          } catch (err) {
            if (err instanceof NativePersistenceError) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: err.code === 'IDEMPOTENCY_CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'STALE_BINDING',
                  message: err.message,
                  retryable: err.code === 'STALE_BINDING',
                },
              });
            }
            throw err;
          }
          if (claimed.replayed) {
            if (claimed.receipt.state === 'completed' && claimed.receipt.responseJson) {
              const cached = NativeControlResponseSchema.safeParse(claimed.receipt.responseJson);
              if (cached.success) return peerOk({ statusCode: 200, body: cached.data });
            }
            if (claimed.receipt.state === 'claimed') {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'BUSY',
                  message: 'A control request with this idempotencyKey is currently in flight',
                  retryable: true,
                  details: { receiptId: claimed.receipt.receiptId, receiptState: 'claimed' },
                },
              });
            }
            return peerOk({
              __nativeError: {
                statusCode: 409,
                code: 'DELIVERY_UNKNOWN',
                message: 'Previous control execution for this idempotencyKey did not finish cleanly',
                retryable: false,
                details: { receiptId: claimed.receipt.receiptId, receiptState: claimed.receipt.state },
              },
            });
          }
          try {
            const rawResponse = await router.executeControl({
              binding,
              request: parsed.data,
              receiptId: claimed.receipt.receiptId,
            });
            const validatedResponse = NativeControlResponseSchema.parse(rawResponse);
            const completed = nativeRegistry.persistence.completeIdempotentReceipt(
              claimed.receipt.receiptId,
              'completed',
              validatedResponse,
            );
            if (!completed) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'DELIVERY_UNKNOWN',
                  message: 'Runtime changed before its receipt could be completed',
                  retryable: false,
                  details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
                },
              });
            }
            return peerOk({ statusCode: 200, body: validatedResponse });
          } catch {
            nativeRegistry.persistence.completeIdempotentReceipt(
              claimed.receipt.receiptId,
              'delivery_unknown',
              { error: 'control_execution_failed' },
            );
            return peerOk({
              __nativeError: {
                statusCode: 500,
                code: 'DELIVERY_UNKNOWN',
                message: 'Control execution failed after dispatch claim; outcome is uncertain',
                retryable: false,
                details: { receiptId: claimed.receipt.receiptId, receiptState: 'delivery_unknown' },
              },
            });
          }
        },

        async getRequestDetails({ sessionId }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const flags = nativeRegistry.getFeatureFlags();
          if (!flags.enabled || !flags.nativePermissions) {
            return peerErr('NATIVE_RUNTIME_DISABLED', 'Native request routing is disabled');
          }
          const binding = nativeRegistry.getActiveBinding(resolved.session.id, resolved.session.harnessId);
          if (!binding) {
            return peerErr('NOT_FOUND', 'No native binding for this session');
          }
          const parsed = NativeRequestDetailsResponseSchema.parse({
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            binding,
            requests: nativeRegistry.getPermissionPort()?.listRequestDetails?.(binding) ?? [],
          });
          return peerOk(parsed as unknown as Record<string, unknown>);
        },

        async resolveNativeRequest({ sessionId, requestId: approvalId, body }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          const flags = nativeRegistry.getFeatureFlags();
          if (!flags.enabled || !flags.nativePermissions) {
            return peerErr('NATIVE_RUNTIME_DISABLED', 'Native AGY request routing is currently disabled by feature gate');
          }
          const parsed = ResolveNativeRequestInputSchema.safeParse(body);
          if (!parsed.success) {
            return peerErr('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid native request resolution payload');
          }
          const binding = nativeRegistry.getActiveBinding(resolved.session.id, resolved.session.harnessId);
          if (!binding || binding.generation !== parsed.data.generation) {
            return peerOk({
              __nativeError: {
                statusCode: 409,
                code: 'STALE_BINDING',
                message: 'Approval generation does not match active runtime generation',
                retryable: false,
                details: { currentGeneration: binding?.generation ?? null },
              },
            });
          }
          const permissionPort = nativeRegistry.getPermissionPort();
          if (!permissionPort) {
            return peerOk({
              __nativeError: {
                statusCode: 422,
                code: 'UNSUPPORTED_ACTION',
                message: 'No native permission router is registered for this runtime',
              },
            });
          }
          const pendingList = permissionPort.listPendingRequests(binding);
          const matchingPending = pendingList.find(
            (p) =>
              p.approvalId === approvalId &&
              p.runtimeId === binding.runtimeId &&
              p.generation === binding.generation,
          );
          if (!matchingPending) {
            const existingReceipt = nativeRegistry.persistence.getApprovalReceiptByApprovalId(approvalId);
            if (existingReceipt && existingReceipt.sessionId === resolved.session.id) {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'ALREADY_RESOLVED',
                  message: `Native request "${approvalId}" is no longer pending (state: ${existingReceipt.state})`,
                  retryable: false,
                  details: {
                    receiptId: existingReceipt.receiptId,
                    receiptState: existingReceipt.state,
                  },
                },
              });
            }
            return peerOk({
              __nativeError: {
                statusCode: 404,
                code: 'NOT_FOUND',
                message: `Pending native request "${approvalId}" was not found for the active runtime generation`,
              },
            });
          }
          if (parsed.data.outcome === 'selected') {
            if (!parsed.data.optionId || !matchingPending.allowedOptionIds.includes(parsed.data.optionId)) {
              return peerOk({
                __nativeError: {
                  statusCode: 400,
                  code: 'INVALID_REQUEST',
                  message: 'Selected optionId is not in the request allowedOptionIds',
                },
              });
            }
          }
          if (
            parsed.data.outcome === 'form_submitted' &&
            matchingPending.kind !== 'elicitation' &&
            !matchingPending.allowsFreeText
          ) {
            return peerOk({
              __nativeError: {
                statusCode: 400,
                code: 'INVALID_REQUEST',
                message: 'Free-form payload is not accepted for fixed-option permission requests',
              },
            });
          }
          const validation = permissionPort.validateResolutionInput?.(binding, approvalId, parsed.data);
          if (validation && !validation.valid) {
            if (validation.errorCode === 'STALE_GENERATION') {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'STALE_BINDING',
                  message: 'Native request belongs to a different binding',
                },
              });
            }
            if (validation.errorCode === 'REQUEST_NOT_PENDING' || validation.errorCode === 'REQUEST_EXPIRED') {
              return peerOk({
                __nativeError: {
                  statusCode: 409,
                  code: 'ALREADY_RESOLVED',
                  message: 'Native request is no longer pending',
                },
              });
            }
            return peerOk({
              __nativeError: {
                statusCode: 400,
                code: 'INVALID_REQUEST',
                message: 'Invalid option or form for the pending native request',
              },
            });
          }
          if (!permissionPort.resolveWithCas) return peerErr('UNSUPPORTED_ACTION', 'Unified request routing unavailable');
          const outcome = await permissionPort.resolveWithCas({ binding, approvalId, request: parsed.data, resolvedBy: 'desktop' });
          return peerOk({ statusCode: outcome.conflict ? 409 : 200, body: ResolveNativeRequestResponseSchema.parse({
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION, ...outcome }) });
        },

        async listSubagents({ sessionId }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          if (!resolved.adapter) {
            return peerErr('UNSUPPORTED_ACTION', 'Session is not bound to an AGY adapter');
          }
          if (!resolved.session.nativeSessionId) {
            return peerOk({ subagents: [] });
          }
          const launchCtx = resolved.adapter.getLaunchContextSync();
          return peerOk({
            subagents: listAgySubagentRecords(launchCtx.appDataPath, resolved.session.nativeSessionId) as unknown as Array<Record<string, unknown>>,
          });
        },

        async readSubagentDetail({ sessionId, subagentId }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          if (!resolved.adapter) {
            return peerErr('UNSUPPORTED_ACTION', 'Session is not bound to an AGY adapter');
          }
          if (!resolved.session.nativeSessionId) {
            return peerErr('NOT_FOUND', 'Native session not initialized');
          }
          const launchCtx = resolved.adapter.getLaunchContextSync();
          const detail = readAgySubagentDetail(launchCtx.appDataPath, resolved.session.nativeSessionId, subagentId);
          if (!detail) {
            return peerErr('NOT_FOUND', 'Subagent trace not found');
          }
          return peerOk({ subagent: detail as unknown as Record<string, unknown> });
        },

        async listArtifacts({ sessionId }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          if (!resolved.adapter) {
            return peerErr('UNSUPPORTED_ACTION', 'Session is not bound to an AGY adapter');
          }
          if (!resolved.session.nativeSessionId) {
            return peerOk({ artifacts: [] });
          }
          const launchCtx = resolved.adapter.getLaunchContextSync();
          return peerOk({
            artifacts: listAgySessionArtifacts(launchCtx.appDataPath, resolved.session.nativeSessionId) as unknown as Array<Record<string, unknown>>,
          });
        },

        async readArtifact({ sessionId, name }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          if (!resolved.adapter) {
            return peerErr('UNSUPPORTED_ACTION', 'Session is not bound to an AGY adapter');
          }
          if (!resolved.session.nativeSessionId) {
            return peerErr('NOT_FOUND', 'Native session not initialized');
          }
          const launchCtx = resolved.adapter.getLaunchContextSync();
          const artifact = readAgySessionArtifact(launchCtx.appDataPath, resolved.session.nativeSessionId, name);
          if (!artifact) {
            return peerErr('NOT_FOUND', 'Artifact not found');
          }
          return peerOk({ artifact: artifact as unknown as Record<string, unknown> });
        },

        async getEcosystem({ sessionId }) {
          const resolved = resolveSessionOrError(sessionId);
          if (!resolved.ok) return resolved.error;
          if (!resolved.adapter) {
            return peerErr('UNSUPPORTED_ACTION', 'Session is not bound to an AGY adapter');
          }
          const profile = resolved.adapter.getProfile();
          const snapshot = collectAgyEcosystemSnapshot({
            launchContext: resolved.adapter.getLaunchContextSync(),
            workspaceRoot: resolved.session.cwd,
            additionalDirectories: profile.defaults?.additionalDirectories ?? [],
            harnessMateActivePluginsCount:
              params.getPluginManager?.()?.listInstalled().filter((p) => p.enabled).length ?? 0,
          });
          return peerOk({ ecosystem: snapshot as unknown as Record<string, unknown> });
        },

        async prepareSessionBinding({ sessionId, harnessId, sourceRef, driverProviderInstanceId }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 运行时插件实例 (${providerInstanceId}) 已停用`);
          }
          const stored = nativeRegistry.ensureRuntimeBinding({
            sessionId,
            instanceId: harnessId,
            profileRef: registeredEntries.get(harnessId)?.profileInstanceId ?? harnessId,
            sourceRef,
            advanceGeneration: true,
            status: 'attached',
          });
          nativeRegistry.persistence.upsertProviderMapping({
            runtimeId: stored.runtimeId,
            driverProviderInstanceId: driverProviderInstanceId ?? providerInstanceId,
            runtimeProviderInstanceId: providerInstanceId,
            runtimeRunId: runId,
            profileInstanceId: registeredEntries.get(harnessId)?.profileInstanceId ?? harnessId,
            harnessId,
          });
          const binding: RuntimeBinding = {
            runtimeId: stored.runtimeId,
            sessionId: stored.sessionId,
            instanceId: stored.instanceId,
            generation: stored.generation,
          };
          const bindingRef = `agy-hook:${providerInstanceId}:${runId}:${++hookRefSeq}`;
          preparedHooksByRef.set(bindingRef, nativeRegistry.createAdapterRuntimeHooks(binding));

          // Mirror native events onto peer service channel for this session
          const unsub = nativeRegistry.subscribeSession(sessionId, (event) => {
            ctx.services?.publish(AGY_RUNTIME_CONTRACT, {
              event: 'native_event',
              providerInstanceId,
              runId,
              sessionId,
              nativeEvent: event,
            });
          });
          activeRuntimeEventUnsubs.add(unsub);

          const bindingDto: AgyRuntimeBindingDto = {
            runtimeId: binding.runtimeId,
            sessionId: binding.sessionId,
            instanceId: binding.instanceId,
            generation: binding.generation,
            driverProviderInstanceId: driverProviderInstanceId ?? providerInstanceId,
            runtimeProviderInstanceId: providerInstanceId,
            runtimeRunId: runId,
            bindingRevision: stored.bindingRevision,
          };
          return peerOk({
            binding: bindingDto,
            bindingRef,
            stream: buildStreamFor(binding),
          });
        },

        async notifyReconnect({ binding, mode }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 运行时插件实例 (${providerInstanceId}) 已停用`);
          }
          nativeRegistry.notifyReconnect(
            {
              runtimeId: asRuntimeId(binding.runtimeId),
              sessionId: binding.sessionId,
              instanceId: binding.instanceId,
              generation: asBindingGeneration(binding.generation),
            },
            mode,
          );
          return peerOk({ ok: true as const });
        },

        async notifyCancelRequested({ binding, target }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 运行时插件实例 (${providerInstanceId}) 已停用`);
          }
          nativeRegistry.notifyCancelRequested(
            {
              runtimeId: asRuntimeId(binding.runtimeId),
              sessionId: binding.sessionId,
              instanceId: binding.instanceId,
              generation: asBindingGeneration(binding.generation),
            },
            target,
          );
          return peerOk({ ok: true as const });
        },

        async decideTurnSettlement({ turnId, binding }) {
          const runtimeBinding: RuntimeBinding | null = binding
            ? {
                runtimeId: asRuntimeId(binding.runtimeId),
                sessionId: binding.sessionId,
                instanceId: binding.instanceId,
                generation: asBindingGeneration(binding.generation),
              }
            : null;
          const decision = nativeRegistry.decideTurnSettlement(turnId, runtimeBinding);
          const action: AgyTurnSettlementDecisionDto['action'] =
            decision?.kind === 'held' ? 'hold' : 'settle';
          return peerOk({
            action,
            turnId,
            binding,
            reason: decision?.kind === 'held' ? decision.reasonIds.join(',') : undefined,
            settlementRef:
              action === 'hold' && binding
                ? `settle:${providerInstanceId}:${runId}:${binding.runtimeId}:${turnId}`
                : null,
            providerInstanceId,
            providerRunId: runId,
          });
        },

        async getActiveBinding({ sessionId, harnessId }) {
          const active = nativeRegistry.getActiveBinding(sessionId, harnessId);
          if (!active) return peerOk({ binding: null });
          const mapping = nativeRegistry.persistence.getProviderMapping(active.runtimeId);
          return peerOk({
            binding: {
              runtimeId: active.runtimeId,
              sessionId: active.sessionId,
              instanceId: active.instanceId,
              generation: active.generation,
              driverProviderInstanceId: mapping?.driverProviderInstanceId ?? providerInstanceId,
              runtimeProviderInstanceId: mapping?.runtimeProviderInstanceId ?? providerInstanceId,
              runtimeRunId: mapping?.runtimeRunId ?? runId,
            },
          });
        },

        async acknowledgeSettlement({ settlementRef }) {
          if (acknowledgedSettlements.has(settlementRef)) {
            return peerOk({ acknowledged: false });
          }
          acknowledgedSettlements.add(settlementRef);
          return peerOk({ acknowledged: true });
        },

        async verifyDispatchProvenance({ harnessId, driverId, provenance }) {
          return peerOk(verifyProvenanceInternal(harnessId, driverId, provenance));
        },
      };

      // ── 3. AgyAccountsServiceV1 (`agy.accounts.v1`) ───────────────────
      const accountsService: AgyAccountsServiceV1 = {
        async getProviderInfo() {
          return peerOk({
            pluginId: HARNESS_AGY_PLUGIN_ID,
            instanceId: providerInstanceId,
            runId,
            configRevision,
            provenancePolicy,
            managedHarnessIds: [...registeredEntries.keys()],
          });
        },

        async listInstances() {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          const instances: AgyAccountInstanceDto[] = [];
          for (const entry of registeredEntries.values()) {
            const profile =
              entry.adapter instanceof AgyAdapter
                ? entry.adapter.getProfile()
                : localProfiles.get(entry.profileInstanceId);
            if (!profile) continue;
            const authState = authService.getState(entry.profileInstanceId);
            instances.push({
              identity: buildIdentityFor(entry.harnessId),
              profile: toProfileSummaryDto(profile),
              authState: toAuthStateDto(authState, providerInstanceId, entry.profileInstanceId),
              configRevision,
            });
          }
          return peerOk({ instances, configRevision });
        },

        async upsertInstance({ profile: rawProfile }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          const parsed = UpsertAgyInstanceRequestSchema.safeParse(rawProfile);
          if (!parsed.success) {
            return peerErr('invalid_request', parsed.error.issues[0]?.message ?? 'Invalid AGY profile payload');
          }
          const req = parsed.data;
          if (req.instanceId === 'codex' || req.instanceId === 'claude') {
            return peerErr('conflict', `Harness ID "${req.instanceId}" 已被其他引擎保留`);
          }
          const existingAdapter = params.registry.get(req.instanceId);
          if (
            existingAdapter &&
            existingAdapter.driverId !== 'agy' &&
            existingAdapter.kind !== 'agy'
          ) {
            return peerErr('conflict', `Harness ID "${req.instanceId}" 已被其他引擎占用`);
          }

          const existingIdx = isPrimaryInstance
            ? params.config.agyProfiles.findIndex((p) => p.instanceId === req.instanceId)
            : -1;
          const existingProfile =
            existingIdx >= 0 ? params.config.agyProfiles[existingIdx] : localProfiles.get(req.instanceId);
          const isolationMode =
            req.instanceId === 'agy' && isPrimaryInstance
              ? (req.isolationMode ?? existingProfile?.isolationMode ?? 'official_default')
              : 'profile_isolated';

          const profile: AgyProfileConfig = {
            instanceId: req.instanceId,
            displayName: req.displayName,
            description: req.description,
            isolationMode,
            authMethod: req.authMethod,
            geminiDir: req.geminiDir?.trim() || existingProfile?.geminiDir,
            appDataDirName: req.appDataDirName,
            binaryPath: req.binaryPath?.trim() || undefined,
            gcpProject: req.gcpProject?.trim() || undefined,
            gcpLocation: req.gcpLocation?.trim() || undefined,
            defaults: req.defaults ?? existingProfile?.defaults ?? {
              linkGlobalSkills: true,
              syncGlobalRules: true,
              additionalDirectories: [],
            },
            identity: existingProfile?.identity,
            enabled: req.enabled,
          };

          localProfiles.set(profile.instanceId, profile);
          if (isPrimaryInstance) {
            if (existingIdx >= 0) {
              params.config.agyProfiles[existingIdx] = profile;
            } else {
              params.config.agyProfiles.push(profile);
            }
            params.onConfigSave?.();
          }

          if (params.onCloseHarnessSessions) {
            await params.onCloseHarnessSessions(profile.instanceId);
          } else {
            await params.getSessionManager?.()?.closeSessionsForHarness(profile.instanceId);
          }

          if (profile.enabled) {
            registerSingleAgyAdapter({
              harnessId: profile.instanceId,
              profileInstanceId: profile.instanceId,
              isDefault: isPrimaryInstance && profile.instanceId === 'agy',
              adapter: buildAgyAdapterFromProfile(profile),
              profile,
            });
          } else {
            registeredEntries.delete(profile.instanceId);
            params.registry.unregisterProviderDriver(providerInstanceId, 'agy', profile.instanceId);
          }
          params.onUsageCacheInvalidate?.(profile.instanceId);
          configRevision += 1;

          const authState = authService.getState(profile.instanceId);
          return peerOk({
            profile: toProfileSummaryDto(profile),
            authState: toAuthStateDto(authState, providerInstanceId, profile.instanceId),
            identity: buildIdentityFor(profile.instanceId),
            configRevision,
          });
        },

        async deleteInstance({ profileInstanceId, purgeData }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          if (profileInstanceId === 'agy' && isPrimaryInstance) {
            return peerErr('invalid_request', '不能删除内置主 AGY 实例，仅可删除自定义隔离账号或修改其模式。');
          }
          const idx = isPrimaryInstance
            ? params.config.agyProfiles.findIndex((p) => p.instanceId === profileInstanceId)
            : -1;
          const existingAdapter = getOwnedAgyAdapter(profileInstanceId);
          if (idx < 0 && !existingAdapter && !localProfiles.has(profileInstanceId)) {
            return peerErr('not_found', 'AGY profile not found');
          }

          await authService.cancelLogin(profileInstanceId).catch(() => {});
          if (params.onCloseHarnessSessions) {
            await params.onCloseHarnessSessions(profileInstanceId);
          } else {
            await params.getSessionManager?.()?.closeSessionsForHarness(profileInstanceId);
          }

          localProfiles.delete(profileInstanceId);
          if (isPrimaryInstance && idx >= 0) {
            params.config.agyProfiles.splice(idx, 1);
            params.onConfigSave?.();
          }
          registeredEntries.delete(profileInstanceId);
          params.registry.unregisterProviderDriver(providerInstanceId, 'agy', profileInstanceId);
          params.onUsageCacheInvalidate?.(profileInstanceId);

          if (purgeData) {
            const dirs = resolveAgyProfileDirectories(instanceProfilesRootDir, profileInstanceId);
            const profilesRootResolved = path.resolve(instanceProfilesRootDir);
            if (path.resolve(dirs.geminiDir).startsWith(`${profilesRootResolved}${path.sep}`)) {
              fs.rmSync(dirs.geminiDir, { recursive: true, force: true });
            }
            if (path.resolve(dirs.runtimeTempDir).startsWith(`${profilesRootResolved}${path.sep}`)) {
              fs.rmSync(dirs.runtimeTempDir, { recursive: true, force: true });
            }
          }
          configRevision += 1;
          return peerOk({
            deleted: true,
            instanceId: profileInstanceId,
            configRevision,
          });
        },

        async getAuthState({ profileInstanceId }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          if (!getOwnedAgyAdapter(profileInstanceId)) {
            return peerErr('not_found', 'AGY instance not found');
          }
          const state = authService.getState(profileInstanceId);
          return peerOk({ state: toAuthStateDto(state, providerInstanceId, profileInstanceId) });
        },

        async startLogin({ profileInstanceId }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          try {
            const state = await authService.startLogin(profileInstanceId);
            return peerOk({ state: toAuthStateDto(state, providerInstanceId, profileInstanceId) });
          } catch (err) {
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },

        async respondLogin({ profileInstanceId, flowId, codeOrUrl }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          try {
            const state = await authService.respondLogin(profileInstanceId, flowId, codeOrUrl);
            return peerOk({ state: toAuthStateDto(state, providerInstanceId, profileInstanceId) });
          } catch (err) {
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },

        async cancelLogin({ profileInstanceId, flowId }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          const state = await authService.cancelLogin(profileInstanceId, flowId);
          return peerOk({ state: toAuthStateDto(state, providerInstanceId, profileInstanceId) });
        },

        async logout({ profileInstanceId, confirmSharedKeyring }) {
          if (!accepting) {
            return peerErr('plugin_disabled', `AGY 账号插件实例 (${providerInstanceId}) 已停用`);
          }
          try {
            const state = await authService.logout(profileInstanceId, { confirmSharedKeyring });
            return peerOk({ state: toAuthStateDto(state, providerInstanceId, profileInstanceId) });
          } catch (err) {
            return peerErr('invalid_request', err instanceof Error ? err.message : String(err));
          }
        },
      };

      const internalHandle: AgyRuntimeInternalHandle = {
        pluginId: HARNESS_AGY_PLUGIN_ID,
        instanceId: providerInstanceId,
        runId,
        nativeRegistry,
        authService,
        outboxWorker,
        provenancePolicy,
        resolvePreparedHooks: (bindingRef) => preparedHooksByRef.get(bindingRef),
        createObservatoryHooks: (sessionId, harnessId) =>
          nativeRegistry.createObservatoryOnlyHooks(sessionId, harnessId),
        bindTurnSettlementSink: (sink) => nativeRegistry.bindTurnSettlementSink(sink),
        getAdapterByHarnessId: getOwnedAgyAdapter,
        listManagedHarnessIds: () => [...registeredEntries.keys()],
        isAccepting: () => accepting,
      };

      // Provide all public peer services + legacy compat aliases
      ctx.provide(HARNESS_DRIVER_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'agy', harnessId: primaryAdapter.id },
        runId,
      });
      ctx.provide(HARNESS_DRIVER_AGY_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'agy', harnessId: primaryAdapter.id },
        runId,
      });
      ctx.provide(AGY_RUNTIME_CONTRACT, runtimeService, {
        version: AGY_RUNTIME_CONTRACT_VERSION,
        metadata: { driverId: 'agy', harnessId: primaryAdapter.id, provenancePolicy },
        runId,
      });
      ctx.provide(AGY_ACCOUNTS_CONTRACT, accountsService, {
        version: AGY_ACCOUNTS_CONTRACT_VERSION,
        metadata: { driverId: 'agy', harnessId: primaryAdapter.id, profilesRootDir: instanceProfilesRootDir },
        runId,
      });
      ctx.provide('harness.agy', primaryAdapter);
      ctx.provide(AGY_RUNTIME_INTERNAL_SERVICE, internalHandle);

      // Plugin-scoped HTTP routes (`/api/v1/plugins/:instanceId/...`)
      ctx.routes?.register('/status', async () => ({
        status: 200,
        body: {
          ok: true,
          pluginId: HARNESS_AGY_PLUGIN_ID,
          instanceId: providerInstanceId,
          runId,
          accepting,
          provenancePolicy,
          harnessIds: [...registeredEntries.keys()],
        },
      }));
      ctx.routes?.register('/instances', async () => ({
        status: 200,
        body: await accountsService.listInstances(),
      }));
      ctx.routes?.register('/native/snapshot', async (req) => ({
        status: 200,
        body: await runtimeService.getSnapshot({
          sessionId: String(req.query.sessionId ?? (req.body as { sessionId?: string } | undefined)?.sessionId ?? ''),
        }),
      }));

      // Full lifecycle teardown: stop accepting, record recoverable state, clean connections/auth/observers/handles ONLY for this instance
      ctx.effect(() => () => {
        accepting = false;
        for (const unsub of activeRuntimeEventUnsubs) {
          try {
            unsub();
          } catch {
            // ignore
          }
        }
        activeRuntimeEventUnsubs.clear();
        preparedHooksByRef.clear();
        try {
          nativeRegistry.persistence.markProviderBindingsReconciling(providerInstanceId);
        } catch {
          // ignore if DB already closed
        }
        try {
          disposeNativeWiring();
        } catch {
          // ignore
        }
        void authService.dispose().catch(() => {});
        for (const handle of [...activeHandles]) {
          void handle.dispose().catch(() => {});
        }
        activeHandles.clear();
        params.registry.unregisterProviderDriver(providerInstanceId);
        registeredEntries.clear();
      });
    },
  };
}
