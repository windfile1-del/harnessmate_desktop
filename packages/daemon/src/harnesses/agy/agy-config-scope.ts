import type {
  AgyAccountDefaults,
  PermissionMode,
  ReasoningEffort,
} from '@harnessmate/protocol';
import type { AcpConfigOption } from '../acp/strict-acp-adapter.js';

export interface AgyScopeLayerPatch {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  permissionMode?: PermissionMode;
  configOptions?: Record<string, string>;
}

export interface AgyResolvedTurnConfig {
  accountDefaults: AgyAccountDefaults;
  sessionOverrides: AgyScopeLayerPatch;
  turnOverrides?: AgyScopeLayerPatch;
  effectiveRequested: {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    permissionMode: PermissionMode;
    configOptions: Record<string, string>;
  };
  hasTurnOverrides: boolean;
}

/**
 * Resolves AGY configuration across the 3-tier hierarchy:
 * `AccountDefaults` < `Session` < `Turn`.
 */
export function resolveAgyTurnConfig(opts: {
  accountDefaults?: AgyAccountDefaults;
  session?: AgyScopeLayerPatch;
  turn?: AgyScopeLayerPatch;
  fallbackPermissionMode?: PermissionMode;
}): AgyResolvedTurnConfig {
  const accountDefaults: AgyAccountDefaults = opts.accountDefaults ?? {
    linkGlobalSkills: true,
    syncGlobalRules: true,
    additionalDirectories: [],
  };
  const sessionOverrides: AgyScopeLayerPatch = opts.session ?? {};
  const turnOverrides = opts.turn;

  const model =
    turnOverrides?.model !== undefined
      ? turnOverrides.model
      : sessionOverrides.model !== undefined
        ? sessionOverrides.model
        : accountDefaults.defaultModel ?? null;

  const reasoningEffort =
    turnOverrides?.reasoningEffort !== undefined
      ? turnOverrides.reasoningEffort
      : sessionOverrides.reasoningEffort !== undefined
        ? sessionOverrides.reasoningEffort
        : accountDefaults.defaultEffort ?? null;

  const permissionMode =
    turnOverrides?.permissionMode ??
    sessionOverrides.permissionMode ??
    accountDefaults.defaultPermissionMode ??
    opts.fallbackPermissionMode ??
    'accept_edits';

  const configOptions: Record<string, string> = {
    ...(sessionOverrides.configOptions ?? {}),
    ...(turnOverrides?.configOptions ?? {}),
  };

  const hasTurnOverrides = Boolean(
    turnOverrides &&
      (turnOverrides.model !== undefined ||
        turnOverrides.reasoningEffort !== undefined ||
        turnOverrides.permissionMode !== undefined ||
        (turnOverrides.configOptions && Object.keys(turnOverrides.configOptions).length > 0)),
  );

  return {
    accountDefaults,
    sessionOverrides,
    turnOverrides,
    effectiveRequested: {
      model,
      reasoningEffort,
      permissionMode,
      configOptions,
    },
    hasTurnOverrides,
  };
}

/**
 * Computes the restore patch to revert any ephemeral Turn-level overrides back
 * to the Session/Account baseline after a turn settles.
 */
export function buildAgySessionRestorePatch(opts: {
  accountDefaults?: AgyAccountDefaults;
  session?: AgyScopeLayerPatch;
  turn?: AgyScopeLayerPatch;
  fallbackPermissionMode?: PermissionMode;
}): AgyScopeLayerPatch | null {
  const resolved = resolveAgyTurnConfig(opts);
  if (!resolved.hasTurnOverrides) return null;

  const baseline = resolveAgyTurnConfig({
    accountDefaults: opts.accountDefaults,
    session: opts.session,
    fallbackPermissionMode: opts.fallbackPermissionMode,
  });

  const patch: AgyScopeLayerPatch = {};
  if (opts.turn?.model !== undefined && baseline.effectiveRequested.model !== opts.turn.model) {
    patch.model = baseline.effectiveRequested.model;
  }
  if (
    opts.turn?.reasoningEffort !== undefined &&
    baseline.effectiveRequested.reasoningEffort !== opts.turn.reasoningEffort
  ) {
    patch.reasoningEffort = baseline.effectiveRequested.reasoningEffort;
  }
  if (
    opts.turn?.permissionMode !== undefined &&
    baseline.effectiveRequested.permissionMode !== opts.turn.permissionMode
  ) {
    patch.permissionMode = baseline.effectiveRequested.permissionMode;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

const KNOWN_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

export function extractThoughtLevelsFromConfigOptions(
  configOptions: readonly AcpConfigOption[],
): { currentLevel: string | null; availableLevels: ReasoningEffort[] } {
  const effortOpt = configOptions.find(
    (c) => c.id === 'thought_level' || c.category === 'thought_level',
  );
  if (!effortOpt) {
    return { currentLevel: null, availableLevels: [] };
  }
  const availableLevels: ReasoningEffort[] = [];
  for (const choice of effortOpt.options ?? []) {
    const val = choice.value as ReasoningEffort;
    if (KNOWN_EFFORTS.has(val) && !availableLevels.includes(val)) {
      availableLevels.push(val);
    }
  }
  return {
    currentLevel: effortOpt.currentValue ?? null,
    availableLevels,
  };
}

/**
 * Per-model dynamic `thought_level` cache populated strictly from live backend
 * ACP `session/new` and `session/set_config_option` observations.
 */
export class AgyModelEffortCache {
  private readonly byModel = new Map<string, ReasoningEffort[]>();

  recordFromConfigOptions(
    modelId: string | null | undefined,
    configOptions: readonly AcpConfigOption[],
  ): void {
    const key = modelId?.trim();
    if (!key) return;
    const { availableLevels } = extractThoughtLevelsFromConfigOptions(configOptions);
    if (availableLevels.length > 0) {
      this.byModel.set(key, availableLevels);
    }
  }

  get(modelId: string): ReasoningEffort[] | undefined {
    return this.byModel.get(modelId);
  }
}
