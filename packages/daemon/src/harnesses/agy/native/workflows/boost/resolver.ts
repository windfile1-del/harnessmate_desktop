import {
  sanitizeObservedForPublic,
  toPublicEvidenceDto,
  type Evidence,
  type GateState,
  type Observed,
} from '@harnessmate/protocol';
import type {
  NativeWorkflowDescriptorContribution,
  ObservedRuntimeSignals,
} from '../../commands/descriptors.js';
import {
  BOOST_CAPABILITY_ALIAS,
  BOOST_CAPABILITY_ID,
  BOOST_OFFICIAL_DOC_URL,
  BOOST_SLASH_COMMAND,
  type BoostEligibilityDto,
  type BoostEligibilityResolution,
  type BoostLaunchValidationInput,
  type BoostLaunchValidationResult,
  type BoostPhaseClassification,
  type BoostPreservedIntentGuidance,
  type BoostServerDenialRecord,
} from './types.js';

export const BOOST_ELIGIBLE_TIERS = ['pro', 'ultra', 'enterprise', 'business'] as const;

const OFFICIAL_BOOST_ENTRY = '官方 App / CLI /boost <task>';

const CANONICAL_INITIAL_PATTERNS = [
  /^initial$/i,
  /^initial[_ -]?(implementation|draft|pass|solve|attempt|build)$/i,
  /^implement(ation)?$/i,
];

const CANONICAL_IMPROVEMENT_PATTERNS = [
  /^improvement$/i,
  /^improve$/i,
  /^challenge$/i,
  /^critique[_ -]?and[_ -]?fix$/i,
  /^fix(es)?$/i,
  /^refin(e|ement)$/i,
  /^revision$/i,
];

const CANONICAL_VERIFICATION_PATTERNS = [
  /^verification$/i,
  /^verify$/i,
  /^verifier$/i,
  /^independent[_ -]?verification$/i,
  /^final[_ -]?verification$/i,
];

/**
 * Classifies an observed Boost phase or role label.
 * ONLY maps to the canonical internal enum (`initial` | `improvement` | `verification`)
 * when an explicit structured signal matches; all other values are preserved as
 * `observed_unknown` with their sanitized observed label and zero progress/round inference.
 */
export function classifyBoostSignalLabel(
  rawSignal: string,
  explicitCanonicalHint?: string | null,
): BoostPhaseClassification {
  const observedLabel = sanitizeBoostLabel(rawSignal);
  const candidates = [explicitCanonicalHint?.trim(), observedLabel].filter(
    (item): item is string => Boolean(item && item.length > 0),
  );

  for (const candidate of candidates) {
    if (CANONICAL_INITIAL_PATTERNS.some((re) => re.test(candidate))) {
      return { kind: 'canonical', phaseKind: 'initial', observedLabel };
    }
    if (CANONICAL_IMPROVEMENT_PATTERNS.some((re) => re.test(candidate))) {
      return { kind: 'canonical', phaseKind: 'improvement', observedLabel };
    }
    if (CANONICAL_VERIFICATION_PATTERNS.some((re) => re.test(candidate))) {
      return { kind: 'canonical', phaseKind: 'verification', observedLabel };
    }
  }

  return {
    kind: 'observed_unknown',
    observedLabel,
  };
}

export function sanitizeBoostLabel(raw: string, maxLength = 160): string {
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '[redacted-path]')
    .replace(/(?:Bearer\s+|ya29\.|AIza)[A-Za-z0-9._-]+/gi, '[redacted-secret]')
    .trim();
  if (!cleaned) return 'observed_label';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

export function sanitizeBoostSummary(raw: string, maxLength = 400): string {
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '[redacted-path]')
    .replace(/(?:Bearer\s+|ya29\.|AIza)[A-Za-z0-9._-]+/gi, '[redacted-secret]')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

export function isTierStringEligibleForBoost(tierName: string | null | undefined): boolean | null {
  const normalized = tierName?.trim().toLowerCase();
  if (!normalized) return null;
  if (BOOST_ELIGIBLE_TIERS.some((tier) => normalized.includes(tier))) {
    return true;
  }
  return false;
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '').toLowerCase();
}

function buildPreservedIntentGuidance(
  originalModeIntent: string,
  reasonCode: string,
  message: string,
): BoostPreservedIntentGuidance {
  return {
    originalModeIntent: originalModeIntent || 'normal',
    draftPreserved: true,
    autoUpgradeBlocked: true,
    reasonCode,
    message,
    officialEntry: OFFICIAL_BOOST_ENTRY,
    officialDocUrl: BOOST_OFFICIAL_DOC_URL,
  };
}

/**
 * Resolves Boost eligibility from actual per-binding runtime signals, model/tier
 * advertisements, and any observed server denial.
 *
 * Guarantees:
 * - Deterministic ineligibility prompt when unverified, tier-ineligible, unadvertised,
 *   desktop-source, or server-denied.
 * - Preserves the user's original mode intent and draft.
 * - NEVER auto-upgrades to paid Boost mode.
 */
export function resolveBoostEligibility(
  signals: ObservedRuntimeSignals,
  opts?: {
    readonly serverDenial?: BoostServerDenialRecord | null;
    readonly explicitPaidOptIn?: boolean;
    readonly originalModeIntent?: string;
    readonly nowMs?: number;
  },
): BoostEligibilityResolution {
  const nowMs = opts?.nowMs ?? Date.now();
  const originalModeIntent = opts?.originalModeIntent ?? 'normal';
  const serverDenial = opts?.serverDenial ?? null;

  const modelObserved: Observed<string> = signals.effectiveModel?.trim()
    ? {
        kind: 'known',
        value: signals.effectiveModel.trim(),
        evidence: {
          kind: 'host_observation',
          observedAt: nowMs,
          reasonCode: 'binding_effective_model',
        },
      }
    : {
        kind: 'unknown',
        reasonCode: 'effective_model_not_observed',
      };

  const tierObserved: Observed<string> = signals.tierName?.trim()
    ? {
        kind: 'known',
        value: signals.tierName.trim(),
        evidence: {
          kind: 'host_observation',
          observedAt: nowMs,
          reasonCode: 'binding_tier_advertisement',
        },
      }
    : {
        kind: 'unknown',
        reasonCode: 'tier_not_observed',
      };

  let boostAdvertised: boolean | null = null;
  if (Array.isArray(signals.advertisedCommands)) {
    boostAdvertised = signals.advertisedCommands.some(
      (cmd) => normalizeCommandName(cmd.name) === 'boost',
    );
  }

  const evidenceRefs: string[] = ['E01'];
  if (boostAdvertised === true) evidenceRefs.push('RUNTIME_ADVERTISED');
  if (signals.tierName?.trim()) evidenceRefs.push('RUNTIME_TIER_OBSERVED');
  if (signals.effectiveModel?.trim()) evidenceRefs.push('RUNTIME_MODEL_OBSERVED');
  if (serverDenial) evidenceRefs.push('RUNTIME_SERVER_DENIED');

  const observeGate: GateState = 'upstream_limited';
  const controlGate: GateState = 'unknown';

  if (signals.source === 'agy_desktop') {
    return {
      status: 'desktop_source_unsupported',
      eligible: false,
      canLaunchNow: false,
      launchGate: 'unsupported',
      observeGate,
      controlGate,
      boostAdvertised,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        'agy_desktop_source_unsupported',
        '当前会话来源为 AGY Desktop，ACP 端不支持直接发起 /boost；已保留原始模式与草稿，请在官方 App/CLI 中执行。',
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  if (!signals.profileVerified) {
    return {
      status: 'unverified_profile',
      eligible: false,
      canLaunchNow: false,
      launchGate: 'not_tested',
      observeGate,
      controlGate,
      boostAdvertised,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        'profile_unauthenticated',
        '当前 Profile 尚未通过官方登录验证，无法核实 Boost 计划资格；已保留原始模式与草稿，请先完成官方登录。',
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  if (serverDenial) {
    return {
      status: 'ineligible_server_denied',
      eligible: false,
      canLaunchNow: false,
      launchGate: 'unsupported',
      observeGate,
      controlGate,
      boostAdvertised,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        `server_denied:${serverDenial.category}`,
        `AGY 服务端已拒绝本次 Boost 请求（${serverDenial.message}）；已保留原始模式「${originalModeIntent}」与草稿，不会自动升级付费计划或切换账号。`,
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  const tierEligible = isTierStringEligibleForBoost(signals.tierName);
  if (tierEligible === false) {
    return {
      status: 'ineligible_tier',
      eligible: false,
      canLaunchNow: false,
      launchGate: 'unsupported',
      observeGate,
      controlGate,
      boostAdvertised,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial: null,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        'tier_ineligible',
        `当前观测计划「${signals.tierName}」未包含 Boost 资格（需 Pro / Ultra / Enterprise 等符合条件的计划）；已保留原始模式「${originalModeIntent}」与草稿，不会自动升级到付费模式。`,
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  if (boostAdvertised === false) {
    return {
      status: 'not_advertised',
      eligible: false,
      canLaunchNow: false,
      launchGate: 'unsupported',
      observeGate,
      controlGate,
      boostAdvertised,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial: null,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        'command_not_advertised_or_revoked',
        '当前 ACP 会话的 available_commands_update 未广告 /boost（或已被撤销）；已保留原始模式与草稿，禁用直接发起。',
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  if (boostAdvertised === null) {
    return {
      status: 'advertisement_unknown',
      eligible: false,
      canLaunchNow: false,
      launchGate: 'unknown',
      observeGate,
      controlGate,
      boostAdvertised,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial: null,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        'advertisement_not_observed',
        '当前绑定尚未收到原生命令广告广播，无法确认 /boost 是否可用；已保留原始模式与草稿，请刷新能力探测。',
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  if (signals.hasLiveConnection === false) {
    return {
      status: 'no_live_connection',
      eligible: false,
      canLaunchNow: false,
      launchGate: 'unknown',
      observeGate,
      controlGate,
      boostAdvertised,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial: null,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        'no_live_connection',
        '当前会话没有活跃的 live ACP 连接，禁止通过独立辅助 CLI 进程替代 Boost；已保留原始模式与草稿。',
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  if (opts?.explicitPaidOptIn === false) {
    return {
      status: 'paid_opt_in_required',
      eligible: true,
      canLaunchNow: false,
      launchGate: 'available',
      observeGate,
      controlGate,
      boostAdvertised: true,
      modelObserved,
      tierObserved,
      autoUpgradeBlocked: true,
      serverDenial: null,
      guidance: buildPreservedIntentGuidance(
        originalModeIntent,
        'explicit_paid_opt_in_required',
        'Boost 属于按需付费增强模式；默认保持原始模式，不自动升级，仅在用户显式选用 live_workflow 并确认发送 /boost 时触发。',
      ),
      evidenceRefs,
      evaluatedAt: nowMs,
    };
  }

  return {
    status: 'eligible_advertised',
    eligible: true,
    canLaunchNow: true,
    launchGate: 'available',
    observeGate,
    controlGate,
    boostAdvertised: true,
    modelObserved,
    tierObserved,
    autoUpgradeBlocked: true,
    serverDenial: null,
    guidance: buildPreservedIntentGuidance(
      'boost',
      'eligible_live_workflow',
      '当前绑定已观测到 /boost 广告且满足资格边界；仅在用户显式提交时通过同一 live ACP 会话单次发送。',
    ),
    evidenceRefs,
    evaluatedAt: nowMs,
  };
}

/**
 * Validates that a Boost launch strictly obeys NP-09 boundaries:
 * - User-initiated and explicitly selected on `live_workflow` lane
 * - Never model-spontaneous, never auto-upgraded to paid mode, never routed to a separate CLI instance
 * - Preserves `/boost <task>` slash prefix with ordered attachment references after it
 */
export function validateBoostLaunchIntent(
  input: BoostLaunchValidationInput,
): BoostLaunchValidationResult {
  const { eligibility } = input;

  if (!input.userInitiated) {
    return {
      ok: false,
      statusCode: 403,
      code: 'FORBIDDEN',
      reasonCode: 'model_spontaneous_boost_forbidden',
      message: '禁止模型或后台自动发起 Boost；必须由用户直接触发。',
      guidance: buildPreservedIntentGuidance(
        eligibility.guidance.originalModeIntent,
        'model_spontaneous_boost_forbidden',
        '已阻止非用户发起的 Boost 触发；保留当前会话模式不变。',
      ),
    };
  }

  if (input.autoUpgradeAttempt) {
    return {
      ok: false,
      statusCode: 403,
      code: 'FORBIDDEN',
      reasonCode: 'auto_paid_upgrade_forbidden',
      message: '默认禁止自动升级到付费 Boost 模式；已保留原始模式意图。',
      guidance: buildPreservedIntentGuidance(
        eligibility.guidance.originalModeIntent,
        'auto_paid_upgrade_forbidden',
        '未自动升级到付费模式；如需使用请手动选择 Boost 模式并显式提交。',
      ),
    };
  }

  if (input.useAuxiliaryCli) {
    return {
      ok: false,
      statusCode: 422,
      code: 'UNSUPPORTED_ACTION',
      reasonCode: 'separate_cli_instance_forbidden',
      message: '禁止以独立 AGY CLI 实例替代同会话 live ACP Boost。',
      guidance: buildPreservedIntentGuidance(
        eligibility.guidance.originalModeIntent,
        'separate_cli_instance_forbidden',
        'Boost 必须在同一活跃 ACP 会话中执行，不可落入独立辅助 CLI。',
      ),
    };
  }

  if (input.lane !== 'live_workflow' || !input.explicitUserSelection) {
    return {
      ok: false,
      statusCode: 422,
      code: 'UNSUPPORTED_ACTION',
      reasonCode: 'explicit_live_workflow_selection_required',
      message: 'Boost 只能由用户显式选用 live_workflow 通道发起。',
      guidance: buildPreservedIntentGuidance(
        eligibility.guidance.originalModeIntent,
        'explicit_live_workflow_selection_required',
        '请选择 Boost 模式并通过 live_workflow 显式提交；原模式意图与草稿保持不变。',
      ),
    };
  }

  if (!eligibility.eligible || !eligibility.canLaunchNow) {
    return {
      ok: false,
      statusCode: 422,
      code: 'UNSUPPORTED_ACTION',
      reasonCode: eligibility.guidance.reasonCode,
      message: eligibility.guidance.message,
      guidance: eligibility.guidance,
    };
  }

  const trimmedTask = input.task.trim();
  if (!trimmedTask) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_REQUEST',
      reasonCode: 'boost_task_required',
      message: '发起 /boost 必须提供非空任务目标。',
      guidance: buildPreservedIntentGuidance(
        eligibility.guidance.originalModeIntent,
        'boost_task_required',
        '请输入需要深度实现与验证的 Boost 任务目标后再发送。',
      ),
    };
  }
  if (trimmedTask.length > 1000) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_REQUEST',
      reasonCode: 'boost_task_too_long',
      message: 'Boost 任务目标长度超过 1000 字符上限。',
      guidance: eligibility.guidance,
    };
  }

  // Strip duplicate leading /boost if caller passed raw slash text
  const normalizedTask = trimmedTask.replace(/^\/boost\b\s*/i, '').trim();
  if (!normalizedTask) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_REQUEST',
      reasonCode: 'boost_task_required',
      message: '发起 /boost 必须提供具体任务内容，不能仅发送空指令。',
      guidance: eligibility.guidance,
    };
  }

  const attachmentIds = (input.attachmentIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return {
    ok: true,
    promptText: `${BOOST_SLASH_COMMAND} ${normalizedTask}`,
    attachmentIds,
    lane: 'live_workflow',
    capabilityId: BOOST_CAPABILITY_ID,
    actionKey: 'launch_boost',
  };
}

/**
 * Inspects a wire error or ACP update payload for deterministic server-side Boost denials
 * (entitlement/tier, plan upgrade required, quota/credits exhausted, org policy, or permission denied).
 */
export function detectBoostServerDenial(
  wire: unknown,
  evidence: Evidence,
  nowMs = Date.now(),
): BoostServerDenialRecord | null {
  if (!wire || typeof wire !== 'object') return null;
  const obj = wire as Record<string, unknown>;

  const errorObj =
    obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : null;
  const paramsObj =
    obj.params && typeof obj.params === 'object' ? (obj.params as Record<string, unknown>) : null;
  const updateObj =
    paramsObj?.update && typeof paramsObj.update === 'object'
      ? (paramsObj.update as Record<string, unknown>)
      : paramsObj;

  let rawCode = '';
  let rawMessage = '';

  if (errorObj) {
    rawCode = String(errorObj.code ?? '');
    rawMessage = typeof errorObj.message === 'string' ? errorObj.message : '';
    const dataObj =
      errorObj.data && typeof errorObj.data === 'object'
        ? (errorObj.data as Record<string, unknown>)
        : null;
    if (dataObj && typeof dataObj.reason === 'string') {
      rawCode = dataObj.reason;
    } else if (dataObj && typeof dataObj.code === 'string') {
      rawCode = dataObj.code;
    }
  } else if (updateObj) {
    const statusStr = String(updateObj.status ?? updateObj.outcome ?? '').toLowerCase();
    const deniedFlag = updateObj.denied === true || statusStr === 'denied' || statusStr === 'rejected';
    const workflowKind = String(
      updateObj.workflowKind ??
        (updateObj._meta && typeof updateObj._meta === 'object'
          ? (updateObj._meta as Record<string, unknown>).workflowKind
          : '') ??
        '',
    ).toLowerCase();
    const errorField =
      updateObj.error && typeof updateObj.error === 'object'
        ? (updateObj.error as Record<string, unknown>)
        : null;
    if (!deniedFlag && !errorField) return null;
    if (workflowKind && workflowKind !== 'boost') return null;

    rawCode = String(
      errorField?.code ?? updateObj.reasonCode ?? updateObj.denialCode ?? statusStr ?? 'server_denied',
    );
    rawMessage = String(
      errorField?.message ?? updateObj.message ?? updateObj.reason ?? 'Boost request denied by server',
    );
  } else {
    return null;
  }

  const combined = `${rawCode} ${rawMessage}`.toLowerCase();
  if (!combined.trim()) return null;

  let category: BoostServerDenialRecord['category'] | null = null;
  if (/(plan_required|upgrade|tier|subscription|paid|entitle|not_eligible|pro_required|ultra)/i.test(combined)) {
    category = 'plan_required';
  } else if (/(quota|credit|budget|limit_exceeded|rate_limit|insufficient)/i.test(combined)) {
    category = 'quota';
  } else if (/(policy|admin|org|enterprise_disabled|disabled_by_admin)/i.test(combined)) {
    category = 'policy';
  } else if (/(permission|forbidden|unauthorized|denied|rejected|-32000)/i.test(combined)) {
    category = 'permission_denied';
  } else if (errorObj) {
    category = 'unknown_denial';
  }

  if (!category) return null;

  return {
    code: sanitizeBoostLabel(rawCode || category, 80),
    message: sanitizeBoostSummary(rawMessage || 'AGY server denied Boost execution', 240),
    category,
    observedAt: nowMs,
    evidence,
  };
}

/**
 * Converts internal `BoostEligibilityResolution` to a strictly allowlisted public DTO.
 */
export function sanitizeBoostEligibilityForPublic(
  resolution: BoostEligibilityResolution,
  nowMs = Date.now(),
): BoostEligibilityDto {
  return {
    status: resolution.status,
    eligible: resolution.eligible,
    canLaunchNow: resolution.canLaunchNow,
    launchGate: resolution.launchGate,
    observeGate: resolution.observeGate,
    controlGate: resolution.controlGate,
    boostAdvertised: resolution.boostAdvertised,
    modelObserved: sanitizeObservedForPublic(resolution.modelObserved, nowMs),
    tierObserved: sanitizeObservedForPublic(resolution.tierObserved, nowMs),
    autoUpgradeBlocked: true,
    serverDenial: resolution.serverDenial
      ? {
          code: resolution.serverDenial.code,
          category: resolution.serverDenial.category,
          message: resolution.serverDenial.message,
          evidence: toPublicEvidenceDto(resolution.serverDenial.evidence, nowMs),
        }
      : null,
    guidance: { ...resolution.guidance },
    evidenceRefs: [...resolution.evidenceRefs],
    evaluatedAt: resolution.evaluatedAt,
  };
}

/**
 * Contributes the NP-09 Boost descriptor metadata to NP-06's `AgyNativeCommandCatalogService`
 * without creating any separate global command executor.
 */
export function createBoostCapabilityContribution(opts?: {
  readonly evidenceRefs?: readonly string[];
  readonly versionNote?: string;
}): NativeWorkflowDescriptorContribution {
  return {
    contributorId: 'np-09.boost',
    capabilityId: BOOST_CAPABILITY_ID,
    aliasIds: [BOOST_CAPABILITY_ALIAS],
    slashName: 'boost',
    title: 'Boost 多段推理与深度验证',
    description:
      '按需通过同一 live ACP 会话发起 /boost，只读呈现经证据确认的原生阶段、验证线索与停止状态；无资格时保持原始模式意图且绝不自动升级付费计划。',
    surfaces: ['desktop', 'cli', 'acp'],
    tierHint: 'Pro/Ultra',
    versionNote:
      opts?.versionNote ??
      'NP-09 离线 observer 与 Studio 就绪；真机付费验证需账号资格与单场景预算授权',
    officialEntry: OFFICIAL_BOOST_ENTRY,
    evidenceRefs: ['E01', ...(opts?.evidenceRefs ?? [])],
    verifiedLevel: null,
    launchGateOverride: 'not_tested',
    observeGateOverride: 'upstream_limited',
    controlGateOverride: 'unknown',
    localReadGateOverride: 'not_tested',
    actions: [
      {
        key: 'launch_boost',
        lane: 'live_workflow',
        label: '发起 Boost (/boost)',
        slashCommand: BOOST_SLASH_COMMAND,
        argumentHint: '<深度任务>',
        officialEntry: OFFICIAL_BOOST_ENTRY,
        description:
          '用户显式选用 live_workflow 并在当前 live ACP 会话单次发送 /boost <task>（不自动升级付费计划，不落入辅助 CLI）。',
        requiresLiveSession: true,
        requiresRuntimeAdvertisement: true,
        requiresAuthenticatedProfile: true,
        disallowAgyDesktopSource: true,
        eligibleTiers: BOOST_ELIGIBLE_TIERS,
        supportsAttachments: true,
        args: [
          {
            name: 'task',
            required: true,
            type: 'string',
            maxLength: 1000,
            description: 'Boost 任务目标',
          },
        ],
      },
    ],
  };
}
