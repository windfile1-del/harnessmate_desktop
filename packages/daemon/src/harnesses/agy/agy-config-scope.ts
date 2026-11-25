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

export type AgyConfigSourceTier =
  | 'account_defaults'
  | 'session_override'
  | 'turn_override'
  | 'fallback_default';

export interface AgyConfigFieldProvenance<T> {
  readonly requested: T;
  readonly sourceTier: AgyConfigSourceTier;
  readonly observedActual?: T | null;
  readonly drifted: boolean;
  readonly enforcement?: 'native' | 'client_guard' | 'unknown';
  readonly reasonCode?: string;
}

export interface AgyConfigReadWriteBoundary {
  readonly tier: 'account_defaults' | 'session_override' | 'turn_override' | 'native_private_files';
  readonly mode:
    | 'hm_profile_managed'
    | 'live_acp_rpc_when_advertised'
    | 'ephemeral_auto_restored'
    | 'read_only_never_mutated';
  readonly note: string;
}

export const AGY_CONFIG_READ_WRITE_BOUNDARIES: readonly AgyConfigReadWriteBoundary[] = Object.freeze([
  {
    tier: 'account_defaults',
    mode: 'hm_profile_managed',
    note: '账号级默认配置由 HarnessMate Profile 持久化管理，不回写用户 ~/.gemini 私有设置。',
  },
  {
    tier: 'session_override',
    mode: 'live_acp_rpc_when_advertised',
    note: '会话级模型/思考强度/权限仅在当前 live ACP 绑定广告且支持时通过 session config 应用。',
  },
  {
    tier: 'turn_override',
    mode: 'ephemeral_auto_restored',
    note: '单轮覆盖仅作用于当前请求上下文，结算后计算 restorePatch 恢复会话/账号基线。',
  },
  {
    tier: 'native_private_files',
    mode: 'read_only_never_mutated',
    note: '原生 Custom Agents、Rules、Skills、Hooks、MCP 与插件配置文件仅做受限只读检视，绝不改写。',
  },
]);

export interface AgyObservedConfigActuals {
  readonly model?: string | null;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly permissionMode?: PermissionMode | null;
  readonly permissionEnforcement?: 'native' | 'client_guard' | 'unknown';
  readonly observedModelIds?: readonly string[];
  readonly observedEffortsForCurrentModel?: readonly ReasoningEffort[];
  readonly adminPermissionCeiling?: PermissionMode | null;
  readonly adminAllowedModels?: readonly string[];
}

export interface AgyResolvedConfigWithProvenance extends AgyResolvedTurnConfig {
  readonly provenance: {
    readonly model: AgyConfigFieldProvenance<string | null>;
    readonly reasoningEffort: AgyConfigFieldProvenance<ReasoningEffort | null>;
    readonly permissionMode: AgyConfigFieldProvenance<PermissionMode>;
    readonly additionalDirectories: AgyConfigFieldProvenance<readonly string[]>;
  };
  readonly restorePatch: AgyScopeLayerPatch | null;
  readonly policyViolations: readonly string[];
  readonly readWriteBoundaries: readonly AgyConfigReadWriteBoundary[];
}

const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  manual: 1,
  accept_edits: 2,
  auto: 3,
};

/**
 * Resolves the 3-tier AGY configuration (`AccountDefaults` < `Session` < `Turn`)
 * together with field-level source provenance, drift detection against live
 * observed ACP actuals, organization policy checks, and explicit read/write scopes.
 */
export function resolveAgyConfigWithProvenance(opts: {
  accountDefaults?: AgyAccountDefaults;
  session?: AgyScopeLayerPatch;
  turn?: AgyScopeLayerPatch;
  fallbackPermissionMode?: PermissionMode;
  observedActual?: AgyObservedConfigActuals;
}): AgyResolvedConfigWithProvenance {
  const resolved = resolveAgyTurnConfig(opts);
  const restorePatch = buildAgySessionRestorePatch(opts);
  const observed = opts.observedActual;
  const policyViolations: string[] = [];

  const modelSourceTier: AgyConfigSourceTier =
    opts.turn?.model !== undefined
      ? 'turn_override'
      : opts.session?.model !== undefined
        ? 'session_override'
        : resolved.accountDefaults.defaultModel !== undefined
          ? 'account_defaults'
          : 'fallback_default';

  const effortSourceTier: AgyConfigSourceTier =
    opts.turn?.reasoningEffort !== undefined
      ? 'turn_override'
      : opts.session?.reasoningEffort !== undefined
        ? 'session_override'
        : resolved.accountDefaults.defaultEffort !== undefined
          ? 'account_defaults'
          : 'fallback_default';

  const permissionSourceTier: AgyConfigSourceTier =
    opts.turn?.permissionMode !== undefined
      ? 'turn_override'
      : opts.session?.permissionMode !== undefined
        ? 'session_override'
        : resolved.accountDefaults.defaultPermissionMode !== undefined
          ? 'account_defaults'
          : 'fallback_default';

  const reqModel = resolved.effectiveRequested.model;
  let modelDrifted = false;
  let modelReasonCode: string | undefined;
  if (
    reqModel &&
    observed?.adminAllowedModels &&
    observed.adminAllowedModels.length > 0 &&
    !observed.adminAllowedModels.includes(reqModel)
  ) {
    modelDrifted = true;
    modelReasonCode = 'blocked_by_admin_policy';
    policyViolations.push(`模型 ${reqModel} 不在组织允许列表中`);
  } else if (
    reqModel &&
    observed?.observedModelIds &&
    observed.observedModelIds.length > 0 &&
    !observed.observedModelIds.includes(reqModel)
  ) {
    modelDrifted = true;
    modelReasonCode = 'actual_model_mismatch';
  } else if (
    observed?.model !== undefined &&
    observed.model !== null &&
    reqModel !== null &&
    observed.model !== reqModel
  ) {
    modelDrifted = true;
    modelReasonCode = 'actual_model_mismatch';
  }

  const reqEffort = resolved.effectiveRequested.reasoningEffort;
  let effortDrifted = false;
  let effortReasonCode: string | undefined;
  if (
    reqEffort &&
    observed?.observedEffortsForCurrentModel &&
    observed.observedEffortsForCurrentModel.length > 0 &&
    !observed.observedEffortsForCurrentModel.includes(reqEffort)
  ) {
    effortDrifted = true;
    effortReasonCode = 'effort_not_in_observed_options';
  } else if (
    observed?.reasoningEffort !== undefined &&
    observed.reasoningEffort !== null &&
    reqEffort !== null &&
    observed.reasoningEffort !== reqEffort
  ) {
    effortDrifted = true;
    effortReasonCode = 'effort_not_in_observed_options';
  }

  const reqPerm = resolved.effectiveRequested.permissionMode;
  let permDrifted = false;
  let permReasonCode: string | undefined;
  if (
    observed?.adminPermissionCeiling &&
    PERMISSION_MODE_RANK[reqPerm] > PERMISSION_MODE_RANK[observed.adminPermissionCeiling]
  ) {
    permDrifted = true;
    permReasonCode = 'blocked_by_admin_policy';
    policyViolations.push(
      `权限模式 ${reqPerm} 超出组织上限 ${observed.adminPermissionCeiling}`,
    );
  } else if (observed?.permissionEnforcement === 'client_guard') {
    permDrifted = true;
    permReasonCode = 'permission_client_guard_degraded';
  } else if (
    observed?.permissionMode !== undefined &&
    observed.permissionMode !== null &&
    observed.permissionMode !== reqPerm
  ) {
    permDrifted = true;
    permReasonCode = 'actual_permission_mismatch';
  }

  const additionalDirectories = [...(resolved.accountDefaults.additionalDirectories ?? [])];

  return {
    ...resolved,
    provenance: {
      model: {
        requested: reqModel,
        sourceTier: modelSourceTier,
        observedActual: observed?.model ?? null,
        drifted: modelDrifted,
        ...(modelReasonCode ? { reasonCode: modelReasonCode } : {}),
      },
      reasoningEffort: {
        requested: reqEffort,
        sourceTier: effortSourceTier,
        observedActual: observed?.reasoningEffort ?? null,
        drifted: effortDrifted,
        ...(effortReasonCode ? { reasonCode: effortReasonCode } : {}),
      },
      permissionMode: {
        requested: reqPerm,
        sourceTier: permissionSourceTier,
        observedActual: observed?.permissionMode ?? null,
        drifted: permDrifted,
        enforcement: observed?.permissionEnforcement ?? 'unknown',
        ...(permReasonCode ? { reasonCode: permReasonCode } : {}),
      },
      additionalDirectories: {
        requested: additionalDirectories,
        sourceTier:
          opts.accountDefaults?.additionalDirectories !== undefined
            ? 'account_defaults'
            : 'fallback_default',
        observedActual: additionalDirectories,
        drifted: false,
      },
    },
    restorePatch,
    policyViolations,
    readWriteBoundaries: AGY_CONFIG_READ_WRITE_BOUNDARIES,
  };
}
