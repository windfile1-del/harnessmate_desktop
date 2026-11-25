import {
  CapabilityDescriptorSchema,
  type CapabilityActionDescriptor,
  type CapabilityDescriptor,
  type GateState,
  type PermissionMode,
  type ReasoningEffort,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import {
  BUILTIN_AGY_CAPABILITY_DEFINITIONS,
  buildCapabilityAliasMap,
  type NativeCapabilityDefinition,
  type NativeCommandActionMetadata,
  type NativeWorkflowDescriptorContribution,
  type ObservedAcpCommand,
  type ObservedAcpConfigOption,
  type ObservedRuntimeSignals,
} from './descriptors.js';

export interface BindingCatalogCacheKey {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly generation: string;
  readonly profileRef: string;
  readonly source: string;
  readonly effectiveModel: string;
  readonly effectivePermissionMode: string;
}

export interface ModelEffortOptionSnapshot {
  readonly currentModelId: string | null;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly displayName: string;
    readonly group?: string;
    readonly supportedEfforts?: readonly ReasoningEffort[];
  }>;
  readonly currentEffort: string | null;
  readonly availableEfforts: readonly ReasoningEffort[];
  readonly effortObserved: boolean;
  readonly currentModeId: string | null;
  readonly advertisedModes: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
}

export interface BindingCatalogSnapshot {
  readonly cacheKey: string;
  readonly binding: RuntimeBinding;
  readonly capabilitiesRevision: number;
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly signals: ObservedRuntimeSignals;
  readonly modelEffortOptions: ModelEffortOptionSnapshot;
  readonly unknownAdvertisedCommands: readonly ObservedAcpCommand[];
  readonly updatedAt: number;
}

const KNOWN_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeSlashName(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase();
}

export function buildBindingCatalogCacheKey(
  binding: RuntimeBinding,
  signals: ObservedRuntimeSignals,
): string {
  const parts: BindingCatalogCacheKey = {
    runtimeId: binding.runtimeId,
    sessionId: binding.sessionId,
    instanceId: binding.instanceId,
    generation: binding.generation,
    profileRef: signals.profileRef || binding.instanceId,
    source: signals.source ?? 'acp',
    effectiveModel: signals.effectiveModel ?? 'default',
    effectivePermissionMode: signals.effectivePermissionMode ?? 'manual',
  };
  return [
    parts.runtimeId,
    parts.sessionId,
    parts.instanceId,
    parts.generation,
    parts.profileRef,
    parts.source,
    parts.effectiveModel,
    parts.effectivePermissionMode,
  ].join('|');
}

function bindingSlotKey(binding: RuntimeBinding): string {
  return `${binding.runtimeId}::${binding.sessionId}::${binding.instanceId}::${binding.generation}`;
}

export function extractModelEffortOptions(
  signals: ObservedRuntimeSignals,
): ModelEffortOptionSnapshot {
  const configOptions: readonly ObservedAcpConfigOption[] = signals.configOptions ?? [];
  const modelOpt = configOptions.find((c) => c.id === 'model' || c.category === 'model');
  const effortOpt = configOptions.find(
    (c) => c.id === 'thought_level' || c.category === 'thought_level',
  );
  const modeOpt = configOptions.find((c) => c.id === 'mode' || c.category === 'mode');

  const modelMap = new Map<
    string,
    {
      id: string;
      displayName: string;
      group?: string;
      supportedEfforts?: readonly ReasoningEffort[];
    }
  >();

  for (const m of signals.observedModels ?? []) {
    modelMap.set(m.id, {
      id: m.id,
      displayName: m.displayName?.trim() || m.id,
      ...(m.group ? { group: m.group } : {}),
      ...(m.supportedEfforts && m.supportedEfforts.length > 0
        ? { supportedEfforts: [...m.supportedEfforts] }
        : {}),
    });
  }

  for (const choice of modelOpt?.options ?? []) {
    const existing = modelMap.get(choice.value);
    modelMap.set(choice.value, {
      id: choice.value,
      displayName: choice.name?.trim() || existing?.displayName || choice.value,
      ...(existing?.group ? { group: existing.group } : {}),
      ...(existing?.supportedEfforts ? { supportedEfforts: existing.supportedEfforts } : {}),
    });
  }

  const currentModelId = modelOpt?.currentValue ?? signals.effectiveModel ?? null;

  const availableEfforts: ReasoningEffort[] = [];
  for (const choice of effortOpt?.options ?? []) {
    const val = choice.value as ReasoningEffort;
    if (KNOWN_EFFORTS.has(val) && !availableEfforts.includes(val)) {
      availableEfforts.push(val);
    }
  }

  if (availableEfforts.length === 0 && currentModelId) {
    const cached = signals.observedEffortsByModel?.[currentModelId];
    for (const val of cached ?? []) {
      if (KNOWN_EFFORTS.has(val) && !availableEfforts.includes(val)) {
        availableEfforts.push(val);
      }
    }
  }

  if (currentModelId && availableEfforts.length > 0) {
    const existing = modelMap.get(currentModelId);
    if (existing) {
      modelMap.set(currentModelId, {
        ...existing,
        supportedEfforts: [...availableEfforts],
      });
    }
  }

  const advertisedModes: Array<{ id: string; name?: string }> = [];
  const seenModeIds = new Set<string>();
  for (const m of signals.advertisedModes ?? []) {
    if (!seenModeIds.has(m.id)) {
      seenModeIds.add(m.id);
      advertisedModes.push({ id: m.id, ...(m.name ? { name: m.name } : {}) });
    }
  }
  for (const choice of modeOpt?.options ?? []) {
    if (!seenModeIds.has(choice.value)) {
      seenModeIds.add(choice.value);
      advertisedModes.push({
        id: choice.value,
        ...(choice.name ? { name: choice.name } : {}),
      });
    }
  }

  return {
    currentModelId,
    models: [...modelMap.values()],
    currentEffort: effortOpt?.currentValue ?? null,
    availableEfforts,
    effortObserved: availableEfforts.length > 0,
    currentModeId: modeOpt?.currentValue ?? null,
    advertisedModes,
  };
}

function isTierEligible(
  tierName: string | null | undefined,
  eligibleTiers: readonly string[] | undefined,
): { eligible: boolean; reasonCode?: string } {
  if (!eligibleTiers || eligibleTiers.length === 0) {
    return { eligible: true };
  }
  const normalized = tierName?.trim().toLowerCase();
  if (!normalized) {
    // Unknown tier does not block an explicitly runtime-advertised workflow,
    // but if not advertised it remains gated by advertisement/not_tested.
    return { eligible: true };
  }
  const matched = eligibleTiers.some((tier) => normalized.includes(tier.toLowerCase()));
  if (!matched) {
    return { eligible: false, reasonCode: 'tier_ineligible' };
  }
  return { eligible: true };
}

function evaluateActionGate(
  def: NativeCapabilityDefinition,
  action: NativeCommandActionMetadata,
  signals: ObservedRuntimeSignals,
  advertisedState: boolean | null,
  modelEffort: ModelEffortOptionSnapshot,
): { gate: GateState; reasonCode?: string } {
  if (action.disallowAgyDesktopSource && signals.source === 'agy_desktop') {
    return { gate: 'unsupported', reasonCode: 'agy_desktop_source_unsupported' };
  }

  if (action.requiresAuthenticatedProfile && !signals.profileVerified) {
    return { gate: 'not_tested', reasonCode: 'profile_unauthenticated' };
  }

  if (
    action.disallowedPermissionModes &&
    signals.effectivePermissionMode &&
    action.disallowedPermissionModes.includes(signals.effectivePermissionMode)
  ) {
    return { gate: 'unsupported', reasonCode: 'permission_mode_restricted' };
  }

  const tierCheck = isTierEligible(signals.tierName, action.eligibleTiers);
  if (!tierCheck.eligible) {
    return { gate: 'unsupported', reasonCode: tierCheck.reasonCode };
  }

  // Special config lane rules: /effort requires actual observed thought_level options
  if (def.id === 'AGY-S12' && action.key === 'set_effort') {
    if (!modelEffort.effortObserved) {
      return { gate: 'unknown', reasonCode: 'effort_options_not_observed' };
    }
    return { gate: 'available' };
  }

  // Special live control rule: cancel requires an active live connection
  if (action.key === 'cancel') {
    if (signals.hasLiveConnection === false) {
      return { gate: 'unknown', reasonCode: 'no_live_connection' };
    }
    return { gate: 'available' };
  }

  if (action.requiresRuntimeAdvertisement) {
    if (advertisedState === false) {
      return { gate: 'unsupported', reasonCode: 'command_not_advertised_or_revoked' };
    }
    if (advertisedState === null) {
      return { gate: 'unknown', reasonCode: 'advertisement_not_observed' };
    }
    if (action.requiresLiveSession && signals.hasLiveConnection === false) {
      return { gate: 'unknown', reasonCode: 'no_live_connection' };
    }
    return { gate: 'available' };
  }

  if (action.requiresLiveSession && signals.hasLiveConnection === false) {
    return { gate: 'unknown', reasonCode: 'no_live_connection' };
  }

  if (action.lane === 'query' || action.lane === 'config' || action.lane === 'manager') {
    return { gate: 'available' };
  }

  return { gate: def.baseLaunch };
}

function summarizeDescriptorGate(
  actions: readonly CapabilityActionDescriptor[],
  fallback: GateState,
): GateState {
  if (actions.some((a) => a.gate === 'available')) return 'available';
  if (actions.some((a) => a.gate === 'upstream_limited')) return 'upstream_limited';
  if (actions.some((a) => a.gate === 'unsupported')) return 'unsupported';
  if (actions.some((a) => a.gate === 'not_tested')) return 'not_tested';
  if (actions.some((a) => a.gate === 'unknown')) return 'unknown';
  return fallback;
}

/**
 * Per-binding AGY Native Capability & Command Catalog service (NP-06).
 *
 * - Strictly isolated per `(runtimeId, sessionId, instanceId, generation)` and full cache key
 *   (profile, source, effective model, effective permission mode) so dual-account / multi-profile
 *   runtimes never cross-pollinate advertised commands or model/effort options.
 * - Merges runtime advertisements, official documentation metadata, and NP-08..NP-12 workflow
 *   descriptor contributions into versioned `CapabilityDescriptor[]` snapshots.
 * - Distinguishes `advertised: null` (never broadcast -> `unknown`) from `advertised: false`
 *   (explicitly omitted or revoked by an update, including empty `[]` -> degraded).
 * - Surfaces unknown dynamic slash commands as inspectable-only (`gate: 'unsupported'`),
 *   closing execution to prevent unsafe fallback.
 */
export class AgyNativeCommandCatalogService {
  private readonly contributions = new Map<string, NativeWorkflowDescriptorContribution>();
  private readonly byBindingSlot = new Map<string, BindingCatalogSnapshot>();

  constructor(
    private readonly baseDefinitions: readonly NativeCapabilityDefinition[] = BUILTIN_AGY_CAPABILITY_DEFINITIONS,
  ) {}

  /**
   * Registers or replaces a workflow descriptor contribution from NP-08..NP-12.
   * Contributors enrich descriptors without implementing separate global command executors.
   */
  registerWorkflowDescriptor(contribution: NativeWorkflowDescriptorContribution): () => void {
    this.contributions.set(contribution.capabilityId, contribution);
    return () => {
      if (this.contributions.get(contribution.capabilityId) === contribution) {
        this.contributions.delete(contribution.capabilityId);
      }
    };
  }

  listDefinitions(): readonly NativeCapabilityDefinition[] {
    const merged: NativeCapabilityDefinition[] = [];
    const seenIds = new Set<string>();

    for (const base of this.baseDefinitions) {
      seenIds.add(base.id);
      const contrib = this.contributions.get(base.id);
      if (!contrib) {
        merged.push(base);
        continue;
      }
      merged.push({
        ...base,
        ...(contrib.aliasIds ? { aliasIds: contrib.aliasIds } : {}),
        ...(contrib.slashName ? { slashName: contrib.slashName } : {}),
        ...(contrib.title ? { title: contrib.title } : {}),
        ...(contrib.description ? { description: contrib.description } : {}),
        ...(contrib.surfaces ? { surfaces: contrib.surfaces } : {}),
        ...(contrib.tierHint !== undefined ? { tierHint: contrib.tierHint } : {}),
        ...(contrib.versionNote !== undefined ? { versionNote: contrib.versionNote } : {}),
        ...(contrib.officialEntry ? { officialEntry: contrib.officialEntry } : {}),
        defaultEvidenceRefs: contrib.evidenceRefs
          ? [...new Set([...base.defaultEvidenceRefs, ...contrib.evidenceRefs])]
          : base.defaultEvidenceRefs,
        verifiedLevel:
          contrib.verifiedLevel !== undefined ? contrib.verifiedLevel : base.verifiedLevel,
        baseLaunch: contrib.launchGateOverride ?? base.baseLaunch,
        baseObserve: contrib.observeGateOverride ?? base.baseObserve,
        baseControl: contrib.controlGateOverride ?? base.baseControl,
        baseLocalRead: contrib.localReadGateOverride ?? base.baseLocalRead,
        actions: contrib.actions ?? base.actions,
      });
    }

    for (const [capId, contrib] of this.contributions.entries()) {
      if (seenIds.has(capId)) continue;
      merged.push({
        id: capId,
        aliasIds: contrib.aliasIds,
        slashName: contrib.slashName,
        title: contrib.title ?? capId,
        description: contrib.description ?? `Contributed workflow ${capId}`,
        surfaces: contrib.surfaces ?? ['cli', 'acp'],
        tierHint: contrib.tierHint,
        versionNote: contrib.versionNote,
        officialEntry: contrib.officialEntry ?? (contrib.slashName ? `/${contrib.slashName}` : capId),
        defaultEvidenceRefs: contrib.evidenceRefs ?? [],
        verifiedLevel: contrib.verifiedLevel ?? null,
        baseLaunch: contrib.launchGateOverride ?? 'not_tested',
        baseObserve: contrib.observeGateOverride ?? 'not_tested',
        baseControl: contrib.controlGateOverride ?? 'not_tested',
        baseLocalRead: contrib.localReadGateOverride ?? 'not_tested',
        actions: contrib.actions ?? [],
      });
    }

    return merged;
  }

  resolveCanonicalCapabilityId(idOrAlias: string): string {
    const aliasMap = buildCapabilityAliasMap(this.listDefinitions());
    return aliasMap.get(idOrAlias) ?? idOrAlias;
  }

  getActionMetadata(
    capabilityIdOrAlias: string,
    actionKey: string,
  ): { definition: NativeCapabilityDefinition; action: NativeCommandActionMetadata } | null {
    const canonicalId = this.resolveCanonicalCapabilityId(capabilityIdOrAlias);
    const def = this.listDefinitions().find((d) => d.id === canonicalId);
    if (!def) return null;
    const action = def.actions.find((a) => a.key === actionKey);
    if (!action) return null;
    return { definition: def, action };
  }

  /**
   * Updates observed runtime signals for a specific binding and recomputes its versioned
   * capability catalog. Increments `capabilitiesRevision` whenever the computed catalog
   * or cache key changes.
   */
  updateBindingSignals(
    binding: RuntimeBinding,
    patch: Partial<ObservedRuntimeSignals> & { readonly profileRef?: string },
  ): { readonly snapshot: BindingCatalogSnapshot; readonly changedDescriptorIds: string[] } {
    const slot = bindingSlotKey(binding);
    const prev = this.byBindingSlot.get(slot);

    const nextSignals: ObservedRuntimeSignals = {
      profileRef: patch.profileRef ?? prev?.signals.profileRef ?? binding.instanceId,
      profileVerified: patch.profileVerified ?? prev?.signals.profileVerified ?? false,
      ...(patch.cliVersion !== undefined
        ? { cliVersion: patch.cliVersion }
        : prev?.signals.cliVersion !== undefined
          ? { cliVersion: prev.signals.cliVersion }
          : {}),
      ...(patch.protocolVersion !== undefined
        ? { protocolVersion: patch.protocolVersion }
        : prev?.signals.protocolVersion !== undefined
          ? { protocolVersion: prev.signals.protocolVersion }
          : {}),
      ...(patch.authMethod !== undefined
        ? { authMethod: patch.authMethod }
        : prev?.signals.authMethod !== undefined
          ? { authMethod: prev.signals.authMethod }
          : {}),
      ...(patch.source !== undefined
        ? { source: patch.source }
        : prev?.signals.source !== undefined
          ? { source: prev.signals.source }
          : {}),
      ...(patch.tierName !== undefined
        ? { tierName: patch.tierName }
        : prev?.signals.tierName !== undefined
          ? { tierName: prev.signals.tierName }
          : {}),
      ...(patch.effectiveModel !== undefined
        ? { effectiveModel: patch.effectiveModel }
        : prev?.signals.effectiveModel !== undefined
          ? { effectiveModel: prev.signals.effectiveModel }
          : {}),
      ...(patch.effectivePermissionMode !== undefined
        ? { effectivePermissionMode: patch.effectivePermissionMode }
        : prev?.signals.effectivePermissionMode !== undefined
          ? { effectivePermissionMode: prev.signals.effectivePermissionMode }
          : {}),
      ...(patch.effectiveEnforcement !== undefined
        ? { effectiveEnforcement: patch.effectiveEnforcement }
        : prev?.signals.effectiveEnforcement !== undefined
          ? { effectiveEnforcement: prev.signals.effectiveEnforcement }
          : {}),
      ...(patch.advertisedModes !== undefined
        ? { advertisedModes: patch.advertisedModes }
        : prev?.signals.advertisedModes !== undefined
          ? { advertisedModes: prev.signals.advertisedModes }
          : {}),
      ...(patch.advertisedCommands !== undefined
        ? { advertisedCommands: patch.advertisedCommands }
        : prev?.signals.advertisedCommands !== undefined
          ? { advertisedCommands: prev.signals.advertisedCommands }
          : {}),
      ...(patch.configOptions !== undefined
        ? { configOptions: patch.configOptions }
        : prev?.signals.configOptions !== undefined
          ? { configOptions: prev.signals.configOptions }
          : {}),
      ...(patch.observedModels !== undefined
        ? { observedModels: patch.observedModels }
        : prev?.signals.observedModels !== undefined
          ? { observedModels: prev.signals.observedModels }
          : {}),
      ...(patch.observedEffortsByModel !== undefined
        ? { observedEffortsByModel: patch.observedEffortsByModel }
        : prev?.signals.observedEffortsByModel !== undefined
          ? { observedEffortsByModel: prev.signals.observedEffortsByModel }
          : {}),
      ...(patch.supportsActiveSteering !== undefined
        ? { supportsActiveSteering: patch.supportsActiveSteering }
        : prev?.signals.supportsActiveSteering !== undefined
          ? { supportsActiveSteering: prev.signals.supportsActiveSteering }
          : {}),
      ...(patch.hasLiveConnection !== undefined
        ? { hasLiveConnection: patch.hasLiveConnection }
        : prev?.signals.hasLiveConnection !== undefined
          ? { hasLiveConnection: prev.signals.hasLiveConnection }
          : {}),
    };

    const nextCacheKey = buildBindingCatalogCacheKey(binding, nextSignals);
    const provisionalRevision = prev ? prev.capabilitiesRevision + 1 : 1;
    const computed = this.buildDescriptors(nextSignals, provisionalRevision);
    const changedIds = this.diffDescriptors(prev?.descriptors ?? [], computed.descriptors);
    const revisionChanged = !prev || changedIds.length > 0 || prev.cacheKey !== nextCacheKey;
    const finalRevision = revisionChanged ? provisionalRevision : prev.capabilitiesRevision;

    const finalDescriptors =
      finalRevision === provisionalRevision
        ? computed.descriptors
        : computed.descriptors.map((d) => ({ ...d, snapshotRevision: finalRevision }));

    const snapshot: BindingCatalogSnapshot = {
      cacheKey: nextCacheKey,
      binding,
      capabilitiesRevision: finalRevision,
      descriptors: finalDescriptors,
      signals: nextSignals,
      modelEffortOptions: computed.modelEffortOptions,
      unknownAdvertisedCommands: computed.unknownAdvertisedCommands,
      updatedAt: Date.now(),
    };
    this.byBindingSlot.set(slot, snapshot);
    return {
      snapshot,
      changedDescriptorIds: revisionChanged ? changedIds : [],
    };
  }

  /**
   * Convenience helper for applying an ACP `available_commands_update` frame to a binding.
   * Passing an empty array `[]` explicitly revokes all dynamically advertised commands.
   */
  applyAdvertisedCommandsUpdate(
    binding: RuntimeBinding,
    commands: readonly ObservedAcpCommand[],
  ): { readonly snapshot: BindingCatalogSnapshot; readonly changedDescriptorIds: string[] } {
    return this.updateBindingSignals(binding, {
      advertisedCommands: commands.map((c) => ({
        name: normalizeSlashName(c.name),
        ...(c.description ? { description: c.description } : {}),
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      })),
    });
  }

  /**
   * Convenience helper for applying ACP `configOptions` (model / thought_level / mode).
   */
  applyConfigOptionsUpdate(
    binding: RuntimeBinding,
    configOptions: readonly ObservedAcpConfigOption[],
  ): { readonly snapshot: BindingCatalogSnapshot; readonly changedDescriptorIds: string[] } {
    const slot = bindingSlotKey(binding);
    const prev = this.byBindingSlot.get(slot);
    const modelOpt = configOptions.find((c) => c.id === 'model' || c.category === 'model');
    const effortOpt = configOptions.find(
      (c) => c.id === 'thought_level' || c.category === 'thought_level',
    );
    const currentModel = modelOpt?.currentValue ?? prev?.signals.effectiveModel ?? null;

    const nextEffortsByModel: Record<string, readonly ReasoningEffort[]> = {
      ...(prev?.signals.observedEffortsByModel ?? {}),
    };
    if (currentModel && effortOpt?.options) {
      const levels = effortOpt.options
        .map((o) => o.value as ReasoningEffort)
        .filter((v, i, arr) => KNOWN_EFFORTS.has(v) && arr.indexOf(v) === i);
      if (levels.length > 0) {
        nextEffortsByModel[currentModel] = levels;
      }
    }

    return this.updateBindingSignals(binding, {
      configOptions,
      ...(currentModel ? { effectiveModel: currentModel } : {}),
      observedEffortsByModel: nextEffortsByModel,
    });
  }

  invalidateBinding(binding: RuntimeBinding): void {
    this.byBindingSlot.delete(bindingSlotKey(binding));
  }

  getSnapshot(binding: RuntimeBinding): BindingCatalogSnapshot {
    const slot = bindingSlotKey(binding);
    const existing = this.byBindingSlot.get(slot);
    if (existing) return existing;

    // Unobserved binding returns an honest revision 0 snapshot without mutating other bindings.
    const defaultSignals: ObservedRuntimeSignals = {
      profileRef: binding.instanceId,
      profileVerified: false,
      advertisedCommands: null,
      hasLiveConnection: false,
    };
    const computed = this.buildDescriptors(defaultSignals, 0);
    return {
      cacheKey: buildBindingCatalogCacheKey(binding, defaultSignals),
      binding,
      capabilitiesRevision: 0,
      descriptors: computed.descriptors,
      signals: defaultSignals,
      modelEffortOptions: computed.modelEffortOptions,
      unknownAdvertisedCommands: computed.unknownAdvertisedCommands,
      updatedAt: Date.now(),
    };
  }

  getCapabilities(binding: RuntimeBinding): {
    readonly capabilitiesRevision: number;
    readonly descriptors: readonly CapabilityDescriptor[];
  } {
    const snap = this.getSnapshot(binding);
    return {
      capabilitiesRevision: snap.capabilitiesRevision,
      descriptors: snap.descriptors,
    };
  }

  private buildDescriptors(
    signals: ObservedRuntimeSignals,
    snapshotRevision: number,
  ): {
    descriptors: CapabilityDescriptor[];
    modelEffortOptions: ModelEffortOptionSnapshot;
    unknownAdvertisedCommands: ObservedAcpCommand[];
  } {
    const definitions = this.listDefinitions();
    const modelEffortOptions = extractModelEffortOptions(signals);
    const hasBroadcast = Array.isArray(signals.advertisedCommands);
    const advertisedMap = new Map<string, ObservedAcpCommand>();
    if (hasBroadcast) {
      for (const cmd of signals.advertisedCommands!) {
        const key = normalizeSlashName(cmd.name);
        if (key) advertisedMap.set(key, { ...cmd, name: key });
      }
    }

    const knownSlashNames = new Set<string>();
    const descriptors: CapabilityDescriptor[] = [];

    for (const def of definitions) {
      if (def.slashName) {
        knownSlashNames.add(normalizeSlashName(def.slashName));
      }
      for (const act of def.actions) {
        if (act.slashCommand) {
          knownSlashNames.add(normalizeSlashName(act.slashCommand.split(/\s+/)[0] ?? ''));
        }
      }

      let advertised: boolean | null = null;
      if (def.slashName) {
        if (hasBroadcast) {
          advertised = advertisedMap.has(normalizeSlashName(def.slashName));
        } else {
          advertised = null;
        }
      } else if (def.id === 'AGY-R01' || def.id === 'AGY-R10') {
        advertised = signals.hasLiveConnection ? true : null;
      }

      const actions: CapabilityActionDescriptor[] = def.actions.map((act) => {
        const evalResult = evaluateActionGate(def, act, signals, advertised, modelEffortOptions);
        return {
          key: act.key,
          lane: act.lane,
          gate: evalResult.gate,
          ...(evalResult.reasonCode ? { reasonCode: evalResult.reasonCode } : {}),
          label: act.label,
        };
      });

      const launchGate =
        def.actions.length > 0
          ? summarizeDescriptorGate(actions, def.baseLaunch)
          : def.baseLaunch;

      const controlGate: GateState =
        def.id === 'AGY-R01' || def.id === 'AGY-R10'
          ? signals.hasLiveConnection
            ? 'available'
            : 'unknown'
          : def.id === 'AGY-S12'
            ? modelEffortOptions.effortObserved
              ? 'available'
              : 'unknown'
            : def.baseControl;

      const evidenceRefs = [...def.defaultEvidenceRefs];
      if (advertised === true) {
        evidenceRefs.push('RUNTIME_ADVERTISED');
      }
      if (def.id === 'AGY-S12' && modelEffortOptions.effortObserved) {
        evidenceRefs.push('RUNTIME_CONFIG_OPTIONS');
      }

      descriptors.push(
        CapabilityDescriptorSchema.parse({
          id: def.id,
          snapshotRevision,
          surfaces: [...def.surfaces],
          ...(def.tierHint ? { tierHint: def.tierHint } : {}),
          ...(def.versionNote ? { versionNote: def.versionNote } : {}),
          advertised,
          launch: launchGate,
          observe: def.baseObserve,
          control: controlGate,
          localRead: def.baseLocalRead,
          actions,
          evidenceRefs: [...new Set(evidenceRefs)],
          verifiedLevel: def.verifiedLevel,
        }),
      );
    }

    // Surface unknown dynamically advertised slash commands as non-runnable descriptors
    // so users can inspect them while runtime execution remains strictly disabled.
    const unknownAdvertisedCommands: ObservedAcpCommand[] = [];
    if (hasBroadcast) {
      for (const [name, cmd] of advertisedMap.entries()) {
        if (knownSlashNames.has(name)) continue;
        unknownAdvertisedCommands.push(cmd);
        const safeId = `AGY-DYN-${name.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 48)}`;
        descriptors.push(
          CapabilityDescriptorSchema.parse({
            id: safeId,
            snapshotRevision,
            surfaces: ['cli', 'acp'],
            versionNote: `未验证动态命令 /${name}${cmd.description ? ` · ${cmd.description}` : ''}`.slice(
              0,
              240,
            ),
            advertised: true,
            launch: 'unsupported',
            observe: 'unknown',
            control: 'unsupported',
            localRead: 'not_tested',
            actions: [
              {
                key: 'run_unknown_dynamic',
                lane: 'live_workflow',
                gate: 'unsupported',
                reasonCode: 'unknown_dynamic_slash_disabled',
                label: `/${name}（未验证，已禁用运行）`,
              },
            ],
            evidenceRefs: ['RUNTIME_ADVERTISED_UNVERIFIED'],
            verifiedLevel: null,
          }),
        );
      }
    }

    return {
      descriptors,
      modelEffortOptions,
      unknownAdvertisedCommands,
    };
  }

  private diffDescriptors(
    prev: readonly CapabilityDescriptor[],
    next: readonly CapabilityDescriptor[],
  ): string[] {
    const prevById = new Map(prev.map((d) => [d.id, d]));
    const nextById = new Map(next.map((d) => [d.id, d]));
    const changed = new Set<string>();

    const stripRevision = (d: CapabilityDescriptor) => {
      const { snapshotRevision: _rev, ...rest } = d;
      return JSON.stringify(rest);
    };

    for (const [id, nextDesc] of nextById.entries()) {
      const prevDesc = prevById.get(id);
      if (!prevDesc || stripRevision(prevDesc) !== stripRevision(nextDesc)) {
        changed.add(id);
      }
    }
    for (const id of prevById.keys()) {
      if (!nextById.has(id)) {
        changed.add(id);
      }
    }
    return [...changed];
  }
}
