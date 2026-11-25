import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AgyProfileConfig, PermissionMode, ReasoningEffort } from '@harnessmate/protocol';
import {
  resolveAgyConfigWithProvenance,
  type AgyObservedConfigActuals,
  type AgyScopeLayerPatch,
} from '../../agy-config-scope.js';
import type { AgyLaunchContext } from '../../agy-launch-context.js';
import { inspectAgyProfileScopeBoundary } from '../../agy-profile-manager.js';
import {
  AgyConsumerProvenanceError,
  assertAgyConsumerProvenance,
} from '../wiring/provenance.js';
import {
  NP13_NO_NATIVE_FEED_CAPABILITY_IDS,
  buildEcosystemCapabilityDescriptors,
} from './descriptors.js';
import {
  buildBoundarySurfaces,
  discoverAgyPluginsMetadata,
  discoverCustomAgents,
  discoverHooksMetadata,
  discoverMcpMetadata,
  discoverRulesReadOnly,
  discoverSkillsWith1516Precedence,
  validateProjectRoots,
} from './discovery.js';
import { readSafeBoundedFile, redactPathForDto } from './path-guard.js';
import {
  DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
  type AdminPolicySnapshot,
  type AgyEcosystemCatalogSnapshot,
  type AgyEcosystemFeatureGates,
  type EcosystemReadWriteScopeEntry,
  type ObservedModelDescriptor,
  type OptInOfficialQueryKind,
  type OptInOfficialQueryResult,
} from './types.js';

export const NP13_READ_WRITE_BOUNDARIES: readonly EcosystemReadWriteScopeEntry[] = Object.freeze([
  {
    domain: 'AccountDefaults (Profile 配置)',
    namespace: 'harnessmate',
    scope: 'account_profile',
    access: 'hm_profile_managed',
    note: '仅保存在 HarnessMate Profile 配置中，绝不回写 ~/.gemini 私有设置；不自动换号。',
  },
  {
    domain: 'Session / Turn 运行配置覆盖',
    namespace: 'harnessmate',
    scope: 'session_runtime',
    access: 'hm_profile_managed',
    note: 'Turn 覆盖用后通过 restorePatch 恢复基线，不污染 AccountDefaults。',
  },
  {
    domain: 'Custom Agents / Skills / Rules',
    namespace: 'agy_native',
    scope: 'project_workspace',
    access: 'read_only',
    note: '按 1.5.16 优先级与路径哈希只读发现；不注入 System Prompt，不修改用户私有文件。',
  },
  {
    domain: 'AGY Hooks / AGY Plugins',
    namespace: 'agy_native',
    scope: 'account_profile',
    access: 'read_only',
    note: '仅读取事件名、插件名与管理员禁用标记；与 HarnessMate V5 插件双轨隔离，HM 绝不执行 AGY Hooks。',
  },
  {
    domain: 'AGY MCP (global_shared) vs HM Session MCP',
    namespace: 'agy_native',
    scope: 'machine_global',
    access: 'read_only',
    note: 'AGY mcp_config.json 跨 Profile 共享且密钥已脱敏；HM 会话级 MCP 严格隔离。',
  },
  {
    domain: '官方 Opt-in 只读查询 (/usage /skills agy agents)',
    namespace: 'agy_native',
    scope: 'account_profile',
    access: 'official_cli_opt_in',
    note: '仅在开关打开且用户显式确认后，于当前绑定 Profile 隔离上下文运行，不写入 conversation。',
  },
  {
    domain: 'Billing / Remote Control / Remote Agents / SSH / Sidecars / IDE SDK',
    namespace: 'agy_native',
    scope: 'organization_policy',
    access: 'official_app_or_cli_only',
    note: '无原生 ACP feed 或未获授权；仅展示只读边界与官方入口，禁止 HM 代为开启。',
  },
]);

export interface OfficialCliQueryExecutor {
  readonly runUsageQuery?: (
    ctx: AgyLaunchContext,
    cwd: string,
  ) => Promise<{ readonly output: string; readonly tierName?: string | null }>;
  readonly runSkillsQuery?: (
    ctx: AgyLaunchContext,
    cwd: string,
  ) => Promise<{
    readonly skills: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly enabled?: boolean;
    }>;
    readonly output?: string;
  }>;
  readonly runAgentsQuery?: (
    ctx: AgyLaunchContext,
    cwd: string,
  ) => Promise<{
    readonly agents: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
    }>;
    readonly output?: string;
  }>;
}

export interface CollectEcosystemCatalogInput {
  readonly profile: AgyProfileConfig;
  readonly launchContext: AgyLaunchContext;
  readonly profilesRootDir: string;
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly source?: 'agy_cli' | 'agy_desktop' | 'agy_ide' | 'acp' | string;
  readonly profileVerified?: boolean;
  readonly sessionOverrides?: AgyScopeLayerPatch;
  readonly turnOverrides?: AgyScopeLayerPatch;
  readonly fallbackPermissionMode?: PermissionMode;
  readonly observedActual?: AgyObservedConfigActuals;
  readonly observedModels?: ReadonlyArray<{
    readonly id: string;
    readonly displayName?: string;
    readonly group?: string;
    readonly supportedEfforts?: readonly ReasoningEffort[];
  }>;
  readonly adminPolicy?: Partial<AdminPolicySnapshot>;
  readonly harnessMateActivePluginsCount?: number;
  readonly harnessMateSessionMcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly transportKind?: 'stdio' | 'http' | 'sse' | 'unknown';
  }>;
  readonly rulesVerifiedLive?: boolean;
  readonly userHome?: string;
  readonly platform?: NodeJS.Platform;
}

export interface RunOptInOfficialQueryInput {
  readonly queryKind: OptInOfficialQueryKind;
  readonly profile: AgyProfileConfig;
  readonly launchContext: AgyLaunchContext;
  readonly workspaceRoot: string;
  readonly source?: string;
  readonly profileVerified: boolean;
  readonly userOptInConfirmed: boolean;
  readonly provenance: unknown;
}

interface CachedSnapshotEntry {
  readonly cacheKeyHash: string;
  readonly snapshot: AgyEcosystemCatalogSnapshot;
}

function readProfileDeclaredAdminPolicy(
  launchContext: AgyLaunchContext,
  platform: NodeJS.Platform,
): Partial<AdminPolicySnapshot> {
  const fileRes = readSafeBoundedFile(
    launchContext.geminiDir,
    [launchContext.appDataDirName, 'policy.json'],
    { platform, maxBytes: 16_384 },
  );
  if (!fileRes.ok) return {};
  try {
    const parsed = JSON.parse(fileRes.content) as Record<string, unknown>;
    const disabledPlugins = Array.isArray(parsed.disabledPlugins)
      ? parsed.disabledPlugins.filter((v): v is string => typeof v === 'string')
      : [];
    const blockedMcpServers = Array.isArray(parsed.blockedMcpServers)
      ? parsed.blockedMcpServers.filter((v): v is string => typeof v === 'string')
      : [];
    const allowedModels = Array.isArray(parsed.allowedModels)
      ? parsed.allowedModels.filter((v): v is string => typeof v === 'string')
      : undefined;
    const hooksDisabled = parsed.hooksDisabled === true;
    const perm = parsed.permissionCeiling;
    const permissionCeiling: PermissionMode | null =
      perm === 'plan' || perm === 'manual' || perm === 'accept_edits' || perm === 'auto'
        ? perm
        : null;
    return {
      detected:
        disabledPlugins.length > 0 ||
        blockedMcpServers.length > 0 ||
        hooksDisabled ||
        Boolean(allowedModels && allowedModels.length > 0) ||
        permissionCeiling !== null,
      source: 'profile_settings_readonly',
      disabledPlugins,
      blockedMcpServers,
      hooksDisabled,
      ...(allowedModels ? { allowedModels } : {}),
      ...(permissionCeiling ? { permissionCeiling } : {}),
      notes: ['读取自受管 Profile 目录只读 policy.json'],
    };
  } catch {
    return {};
  }
}

function resolveAdminPolicy(
  inputPolicy: Partial<AdminPolicySnapshot> | undefined,
  launchContext: AgyLaunchContext,
  platform: NodeJS.Platform,
): AdminPolicySnapshot {
  const filePolicy = readProfileDeclaredAdminPolicy(launchContext, platform);
  const disabledPlugins = Array.from(
    new Set([...(filePolicy.disabledPlugins ?? []), ...(inputPolicy?.disabledPlugins ?? [])]),
  );
  const blockedMcpServers = Array.from(
    new Set([...(filePolicy.blockedMcpServers ?? []), ...(inputPolicy?.blockedMcpServers ?? [])]),
  );
  const hooksDisabled = Boolean(inputPolicy?.hooksDisabled ?? filePolicy.hooksDisabled);
  const allowedModels = inputPolicy?.allowedModels ?? filePolicy.allowedModels;
  const permissionCeiling =
    inputPolicy?.permissionCeiling !== undefined
      ? inputPolicy.permissionCeiling
      : filePolicy.permissionCeiling ?? null;

  const detected = Boolean(
    inputPolicy?.detected ||
      filePolicy.detected ||
      disabledPlugins.length > 0 ||
      blockedMcpServers.length > 0 ||
      hooksDisabled ||
      (allowedModels && allowedModels.length > 0) ||
      permissionCeiling !== null,
  );

  const notes = [
    ...(filePolicy.notes ?? []),
    ...(inputPolicy?.notes ?? []),
    ...(detected ? [] : ['未检测到额外组织/管理员限制策略']),
  ];

  return {
    detected,
    source: inputPolicy?.detected
      ? 'declared_input'
      : filePolicy.detected
        ? 'profile_settings_readonly'
        : 'none',
    disabledPlugins,
    blockedMcpServers,
    hooksDisabled,
    ...(allowedModels ? { allowedModels } : {}),
    permissionCeiling,
    notes,
  };
}

/**
 * Profile/source/workspace-scoped read-only native ecosystem service (NP-13).
 *
 * - Default feature gates are ALL `false` (strict fail-closed + lossless rollback).
 * - Never reads or exposes OAuth tokens, raw credential files, or raw host home paths.
 * - Never mutates user private `~/.gemini` or workspace `.agents` files.
 */
export class AgyNativeEcosystemService {
  private gates: AgyEcosystemFeatureGates;
  private readonly officialQueryExecutor?: OfficialCliQueryExecutor;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedSnapshotEntry>();
  private revisionCounter = 0;

  constructor(opts?: {
    readonly gates?: Partial<AgyEcosystemFeatureGates>;
    readonly officialQueryExecutor?: OfficialCliQueryExecutor;
    readonly now?: () => number;
  }) {
    this.gates = {
      ...DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES,
      ...(opts?.gates ?? {}),
    };
    this.officialQueryExecutor = opts?.officialQueryExecutor;
    this.now = opts?.now ?? (() => Date.now());
  }

  getGates(): Readonly<AgyEcosystemFeatureGates> {
    return { ...this.gates };
  }

  setGates(patch: Partial<AgyEcosystemFeatureGates>): Readonly<AgyEcosystemFeatureGates> {
    this.gates = {
      ...this.gates,
      ...patch,
    };
    this.cache.clear();
    return this.getGates();
  }

  invalidateProfile(instanceId: string): void {
    const prefix = `${instanceId}::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  collectSnapshot(input: CollectEcosystemCatalogInput): AgyEcosystemCatalogSnapshot {
    const platform = input.platform ?? process.platform;
    const userHome = input.userHome ?? os.homedir();
    const source = input.source ?? 'acp';
    const profileVerified = Boolean(input.profileVerified ?? input.profile.identity?.verifiedAt);
    const tierName = input.profile.identity?.tierName ?? null;
    const accountFingerprint = input.profile.identity?.accountFingerprint ?? null;
    const additionalDirs = input.profile.defaults?.additionalDirectories ?? [];
    const hmPluginsCount = input.harnessMateActivePluginsCount ?? 0;
    const hmSessionMcp = input.harnessMateSessionMcpServers ?? [];

    const scopeInspection = inspectAgyProfileScopeBoundary(input.profile, {
      profilesRootDir: input.profilesRootDir,
      userHome,
      platform,
    });

    const adminPolicy = resolveAdminPolicy(input.adminPolicy, input.launchContext, platform);

    const cacheSlotKey = [
      input.profile.instanceId,
      input.launchContext.geminiDir,
      source,
      path.resolve(input.workspaceRoot),
    ].join('::');

    const cachePayloadHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          instanceId: input.profile.instanceId,
          displayName: input.profile.displayName,
          isolationMode: input.profile.isolationMode,
          authMethod: input.profile.authMethod,
          geminiDir: input.launchContext.geminiDir,
          appDataDirName: input.launchContext.appDataDirName,
          accountFingerprint,
          tierName,
          profileVerified,
          source,
          workspaceRoot: path.resolve(input.workspaceRoot),
          additionalDirs,
          sessionOverrides: input.sessionOverrides ?? null,
          turnOverrides: input.turnOverrides ?? null,
          observedActual: input.observedActual ?? null,
          observedModels: input.observedModels ?? null,
          adminPolicy,
          hmPluginsCount,
          hmSessionMcp,
          gates: this.gates,
          rulesVerifiedLive: Boolean(input.rulesVerifiedLive),
        }),
        'utf8',
      )
      .digest('hex')
      .slice(0, 16);

    const cached = this.cache.get(cacheSlotKey);
    if (cached && cached.cacheKeyHash === cachePayloadHash) {
      return cached.snapshot;
    }

    this.revisionCounter += 1;
    const snapshotRevision = this.revisionCounter;
    const collectedAt = this.now();

    const effectiveObserved: AgyObservedConfigActuals = {
      ...(input.observedActual ?? {}),
      ...(adminPolicy.permissionCeiling
        ? { adminPermissionCeiling: adminPolicy.permissionCeiling }
        : {}),
      ...(adminPolicy.allowedModels ? { adminAllowedModels: adminPolicy.allowedModels } : {}),
    };

    const effectiveConfig = resolveAgyConfigWithProvenance({
      accountDefaults: input.profile.defaults,
      session: input.sessionOverrides,
      turn: input.turnOverrides,
      fallbackPermissionMode: input.fallbackPermissionMode,
      observedActual: effectiveObserved,
    });

    const allowedModelsSet = adminPolicy.allowedModels
      ? new Set(adminPolicy.allowedModels)
      : null;
    const observedModels: ObservedModelDescriptor[] = (input.observedModels ?? []).map((m) => ({
      id: m.id,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.group ? { group: m.group } : {}),
      ...(m.supportedEfforts ? { supportedEfforts: m.supportedEfforts } : {}),
      allowedByPolicy: allowedModelsSet ? allowedModelsSet.has(m.id) : true,
    }));

    const gatesClosed = !this.gates.ecosystemReadEnabled;

    const projects = validateProjectRoots({
      workspaceRoot: input.workspaceRoot,
      additionalDirectories: gatesClosed ? [] : additionalDirs,
      geminiDir: input.launchContext.geminiDir,
      userHome,
      platform,
    });

    const customAgentsItems =
      !gatesClosed && this.gates.customAgentsLocalScanEnabled
        ? discoverCustomAgents({
            workspaceRoot: input.workspaceRoot,
            geminiDir: input.launchContext.geminiDir,
            userHome,
            platform,
          })
        : [];

    const skillsResult =
      !gatesClosed && this.gates.skillsDeepDiscoveryEnabled
        ? discoverSkillsWith1516Precedence({
            workspaceRoot: input.workspaceRoot,
            cwd: input.cwd,
            geminiDir: input.launchContext.geminiDir,
            userHome,
            isolationMode: input.profile.isolationMode,
            linkGlobalSkills: scopeInspection.linkGlobalSkills,
            platform,
          })
        : {
            items: [],
            duplicates: [],
            rejectedRootsCount: scopeInspection.skillsRoots.filter((r) => !r.symlinkSafe).length,
          };

    const rulesItems =
      !gatesClosed && this.gates.rulesVerificationEnabled
        ? discoverRulesReadOnly({
            workspaceRoot: input.workspaceRoot,
            geminiDir: input.launchContext.geminiDir,
            userHome,
            rulesVerifiedLive: input.rulesVerifiedLive,
            platform,
          })
        : [];

    const agyHooks =
      !gatesClosed && this.gates.hooksMetadataReadEnabled
        ? discoverHooksMetadata({
            workspaceRoot: input.workspaceRoot,
            geminiDir: input.launchContext.geminiDir,
            userHome,
            isolationMode: input.profile.isolationMode,
            adminPolicy,
            platform,
          })
        : [];

    const agyPlugins =
      !gatesClosed && this.gates.pluginsAndMcpMetadataEnabled
        ? discoverAgyPluginsMetadata({
            workspaceRoot: input.workspaceRoot,
            geminiDir: input.launchContext.geminiDir,
            userHome,
            adminPolicy,
            platform,
          })
        : [];

    const mcpResult =
      !gatesClosed && this.gates.pluginsAndMcpMetadataEnabled
        ? discoverMcpMetadata({
            workspaceRoot: input.workspaceRoot,
            geminiDir: input.launchContext.geminiDir,
            userHome,
            adminPolicy,
            harnessMateSessionMcpServers: hmSessionMcp,
            platform,
          })
        : {
            servers: hmSessionMcp.map((s) => ({
              name: s.name,
              transportKind: s.transportKind ?? ('unknown' as const),
              scope: 'session_isolated' as const,
              namespace: 'harnessmate' as const,
              hasSecretEnvRedacted: false,
              hasAuthHeadersRedacted: false,
              blockedByPolicy: false,
            })),
            nativeGlobalConfigPresent: false,
          };

    const snapshot: AgyEcosystemCatalogSnapshot = {
      schemaVersion: 1,
      snapshotRevision,
      collectedAt,
      gates: { ...this.gates },
      gatesClosed,
      identityScope: {
        instanceId: input.profile.instanceId,
        displayName: input.profile.displayName,
        isolationMode: input.profile.isolationMode,
        authMethod: input.profile.authMethod,
        source,
        profileVerified,
        tierName,
        accountFingerprint,
        redactedGeminiDir: redactPathForDto(input.launchContext.geminiDir, {
          workspaceRoot: input.workspaceRoot,
          geminiDir: input.launchContext.geminiDir,
          userHome,
          platform,
        }),
        appDataDirName: input.launchContext.appDataDirName,
        enterpriseIssue1610Warning: scopeInspection.enterpriseIssue1610Affected,
        cacheKeyHash: cachePayloadHash,
      },
      readWriteBoundaries: NP13_READ_WRITE_BOUNDARIES,
      effectiveConfig,
      modelsSummary: {
        observedModels,
        orchestratorNote:
          'Native Orchestrator (Planner/Executor) 依赖账号计划与实机 ACP 配置广播，未观测字段不推测。',
      },
      customAgents: {
        items: customAgentsItems,
        switchSemantics: 'new_session_or_fork_required',
        note: '切换主 Custom Agent 可能需要新建会话或原生 Fork；当前 ACP 未暴露统一切换 RPC。',
      },
      skills: {
        items: skillsResult.items,
        duplicates: skillsResult.duplicates,
        precedenceRule: '工作区 (.agents > .agent) > Profile/.gemini > ~/.gemini > ~/.agents/skills (1.5.16)',
        profileSkillsLinked: scopeInspection.skillsRoots.some(
          (r) => r.kind.startsWith('profile_') && r.present && r.symlinkSafe,
        ),
        rejectedRootsCount: skillsResult.rejectedRootsCount,
      },
      rules: {
        items: rulesItems,
        systemPromptInjectionProhibited: true,
        acpVerificationNote: input.rulesVerifiedLive
          ? '当前绑定已复验 Rules 读取；只读呈现，不改写 System Prompt。'
          : '受上游 CLI #1540 报告影响，ACP 运行时是否应用 Rules 待真机复验；严禁注入 System Prompt。',
      },
      hooks: {
        agyHooks,
        harnessMateV5HooksCount: hmPluginsCount,
        organizationDisabled: adminPolicy.hooksDisabled,
      },
      plugins: {
        agyPlugins,
        harnessMateActivePluginsCount: hmPluginsCount,
        separationNote: 'AGY Plugins 与 HarnessMate V5 插件独立管理、互不共享权限、钩子或存储。',
      },
      mcp: {
        servers: mcpResult.servers,
        nativeGlobalConfigPresent: mcpResult.nativeGlobalConfigPresent,
        harnessMateSessionMcpCount: hmSessionMcp.length,
        note: 'AGY mcp_config.json 为本机全局跨 Profile 共享（所有密钥/环境变量已脱敏）；HarnessMate 会话级 MCP 严格隔离。',
      },
      projects: {
        workspaceRoot: projects.workspaceRoot,
        additionalDirectories: projects.additionalDirectories,
        nativeProjectsScopeNote: '仅校验本地已授权工作区与附加目录，不自动写入原生 project 文件。',
      },
      adminPolicy,
      accountEcosystem: {
        manualControlOnly: true,
        autoRotationProhibited: true,
        singleActiveAccountDeferred: true,
        note: '账户登录、登出与切换仅支持用户手动操作；禁止自动换号、读凭据 Token，本期不添单活切换（U07）。',
      },
      boundarySurfaces: buildBoundarySurfaces(),
      noNativeFeedCapabilityIds: NP13_NO_NATIVE_FEED_CAPABILITY_IDS,
      descriptors: buildEcosystemCapabilityDescriptors(snapshotRevision, this.gates, {
        profileVerified,
        source,
        tierName,
      }),
    };

    this.cache.set(cacheSlotKey, {
      cacheKeyHash: cachePayloadHash,
      snapshot,
    });
    return snapshot;
  }

  /**
   * Executes a strictly profile-scoped, user-confirmed opt-in official CLI read query
   * (`/usage`, `/skills`, `agy agents`) without mutating any conversation or falling back
   * to the default `'agy'` profile.
   */
  async runOptInOfficialQuery(
    input: RunOptInOfficialQueryInput,
  ): Promise<OptInOfficialQueryResult> {
    const observedAt = this.now();

    if (!this.gates.officialOptInQueryEnabled) {
      return {
        queryKind: input.queryKind,
        executed: false,
        provenance: 'blocked',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        reasonCode: 'OPT_IN_QUERY_GATE_DISABLED',
        error: '官方 Opt-in 生态查询门控默认关闭（U04/安全回滚边界）。',
        observedAt,
      };
    }

    if (!input.userOptInConfirmed) {
      return {
        queryKind: input.queryKind,
        executed: false,
        provenance: 'blocked',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        reasonCode: 'USER_OPT_IN_REQUIRED',
        error: '必须由用户明确确认后才可执行官方 CLI 查询。',
        observedAt,
      };
    }

    try {
      assertAgyConsumerProvenance(
        {
          instanceId: input.profile.instanceId,
          driverId: 'agy',
          authMethod: input.profile.authMethod,
          profile: input.profile,
        },
        input.provenance,
      );
    } catch (err) {
      const message =
        err instanceof AgyConsumerProvenanceError
          ? err.message
          : 'Consumer provenance blocked';
      return {
        queryKind: input.queryKind,
        executed: false,
        provenance: 'blocked',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        reasonCode: 'CONSUMER_PROVENANCE_BLOCKED',
        error: message,
        observedAt,
      };
    }

    if (input.source === 'agy_desktop' && input.queryKind !== 'usage') {
      return {
        queryKind: input.queryKind,
        executed: false,
        provenance: 'blocked',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        reasonCode: 'SOURCE_DESKTOP_UNSUPPORTED_FOR_CLI_QUERY',
        error: 'agy_desktop 来源会话不支持执行 CLI /skills 或 agy agents 子查询。',
        observedAt,
      };
    }

    if (
      input.profile.isolationMode === 'profile_isolated' &&
      input.profile.authMethod === 'oauth-personal' &&
      !input.profileVerified
    ) {
      return {
        queryKind: input.queryKind,
        executed: false,
        provenance: 'blocked',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        reasonCode: 'PROFILE_UNAUTHENTICATED',
        error: '隔离账号尚未完成官方登录，请先在设置中手动授权后再执行查询。',
        observedAt,
      };
    }

    if (!this.officialQueryExecutor) {
      return {
        queryKind: input.queryKind,
        executed: false,
        provenance: 'blocked',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        reasonCode: 'QUERY_EXECUTOR_NOT_WIRED',
        error: '当前运行环境未挂载官方 CLI 只读查询执行器。',
        observedAt,
      };
    }

    if (input.queryKind === 'usage') {
      if (!this.officialQueryExecutor.runUsageQuery) {
        return {
          queryKind: 'usage',
          executed: false,
          provenance: 'blocked',
          mutatedConversation: false,
          profileInstanceId: input.profile.instanceId,
          reasonCode: 'QUERY_EXECUTOR_NOT_WIRED',
          error: '未配置 /usage 查询器。',
          observedAt,
        };
      }
      const res = await this.officialQueryExecutor.runUsageQuery(
        input.launchContext,
        input.workspaceRoot,
      );
      return {
        queryKind: 'usage',
        executed: true,
        provenance: 'official_cli_query',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        outputSummary: res.output,
        observedAt: this.now(),
      };
    }

    if (input.queryKind === 'skills') {
      if (!this.officialQueryExecutor.runSkillsQuery) {
        return {
          queryKind: 'skills',
          executed: false,
          provenance: 'blocked',
          mutatedConversation: false,
          profileInstanceId: input.profile.instanceId,
          reasonCode: 'QUERY_EXECUTOR_NOT_WIRED',
          error: '未配置 /skills 查询器。',
          observedAt,
        };
      }
      const res = await this.officialQueryExecutor.runSkillsQuery(
        input.launchContext,
        input.workspaceRoot,
      );
      return {
        queryKind: 'skills',
        executed: true,
        provenance: 'official_cli_query',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        itemsCount: res.skills.length,
        skills: res.skills,
        ...(res.output ? { outputSummary: res.output } : {}),
        observedAt: this.now(),
      };
    }

    if (!this.officialQueryExecutor.runAgentsQuery) {
      return {
        queryKind: 'agents',
        executed: false,
        provenance: 'blocked',
        mutatedConversation: false,
        profileInstanceId: input.profile.instanceId,
        reasonCode: 'QUERY_EXECUTOR_NOT_WIRED',
        error: '未配置 agy agents 查询器。',
        observedAt,
      };
    }
    const res = await this.officialQueryExecutor.runAgentsQuery(
      input.launchContext,
      input.workspaceRoot,
    );
    return {
      queryKind: 'agents',
      executed: true,
      provenance: 'official_cli_query',
      mutatedConversation: false,
      profileInstanceId: input.profile.instanceId,
      itemsCount: res.agents.length,
      agents: res.agents,
      ...(res.output ? { outputSummary: res.output } : {}),
      observedAt: this.now(),
    };
  }
}
