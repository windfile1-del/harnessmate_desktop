import type {
  AgyCustomAgentDto,
  AgyEcosystemCatalogSnapshotDto,
  AgyHookMetadataDto,
  AgyMcpServerDto,
  AgyPluginMetadataDto,
  AgyProjectRootDto,
  AgyRuleEntryDto,
  AgySkillEntryDto,
  EcosystemAccessPolicyDto,
  EcosystemNamespaceDto,
  EcosystemScopeLevelDto,
  SettingsSectionId,
} from './types';

export interface SettingsSectionMeta {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = Object.freeze([
  {
    id: 'account',
    label: '账户与认证',
    shortLabel: '账户',
    description: '隔离模式、手动登录/切换边界与 #1610 企业约束',
  },
  {
    id: 'models',
    label: '模型与配置',
    shortLabel: '模型',
    description: 'AccountDefaults < Session < Turn 三层作用域与策略约束',
  },
  {
    id: 'agents',
    label: '原生 Agents',
    shortLabel: 'Agents',
    description: 'Custom Agents 只读发现与会话 Fork 切换说明',
  },
  {
    id: 'ecosystem',
    label: '生态与边界',
    shortLabel: '生态',
    description: 'Skills 1.5.16 / Rules #1540 / Hooks / Plugins / MCP / 无原生 Feed 项',
  },
  {
    id: 'projects',
    label: '项目与目录',
    shortLabel: '项目',
    description: '工作区根与附加目录授权校验',
  },
]);

export const SOURCE_TIER_LABELS: Record<
  'account_defaults' | 'session_override' | 'turn_override' | 'fallback_default',
  string
> = {
  account_defaults: '账号默认 (AccountDefaults)',
  session_override: '会话覆盖 (Session)',
  turn_override: '单轮覆盖 (Turn)',
  fallback_default: '默认回退 (Fallback)',
};

export const NAMESPACE_LABELS: Record<EcosystemNamespaceDto, string> = {
  agy_native: 'AGY 原生',
  harnessmate: 'HarnessMate',
};

export const SCOPE_LEVEL_LABELS: Record<EcosystemScopeLevelDto, string> = {
  account_profile: 'Profile 级',
  project_workspace: '项目工作区',
  session_runtime: '会话运行时',
  machine_global: '本机全局',
  organization_policy: '组织/管理员策略',
};

export const ACCESS_POLICY_LABELS: Record<EcosystemAccessPolicyDto, string> = {
  read_only: '只读',
  hm_profile_managed: 'HM Profile 托管',
  official_cli_opt_in: '官方 Opt-in 查询',
  official_app_or_cli_only: '仅限官方 App/CLI',
  prohibited: '禁止代理',
};

export const PROJECT_REASON_LABELS: Record<AgyProjectRootDto['reasonCode'], string> = {
  ok: '已授权',
  missing: '路径不存在',
  not_directory: '非目录',
  symlink_escape_rejected: '符号链接越界已拦截',
  traversal_rejected: '路径遍历已拦截',
  duplicate_root: '重复目录已去重',
};

export interface AgySettingsViewModel {
  readonly gatesClosed: boolean;
  readonly agyNativeCount: number;
  readonly harnessMateCount: number;
  readonly shadowedSkillsCount: number;
  readonly policyRestrictionCount: number;
  readonly invalidProjectRootsCount: number;
  readonly customAgents: readonly AgyCustomAgentDto[];
  readonly skills: readonly AgySkillEntryDto[];
  readonly rules: readonly AgyRuleEntryDto[];
  readonly agyHooks: readonly AgyHookMetadataDto[];
  readonly agyPlugins: readonly AgyPluginMetadataDto[];
  readonly mcpServers: readonly AgyMcpServerDto[];
}

export function buildAgySettingsViewModel(
  snapshot: AgyEcosystemCatalogSnapshotDto | null,
  opts?: {
    readonly searchQuery?: string;
    readonly namespaceFilter?: 'all' | EcosystemNamespaceDto;
  },
): AgySettingsViewModel {
  if (!snapshot) {
    return {
      gatesClosed: true,
      agyNativeCount: 0,
      harnessMateCount: 0,
      shadowedSkillsCount: 0,
      policyRestrictionCount: 0,
      invalidProjectRootsCount: 0,
      customAgents: [],
      skills: [],
      rules: [],
      agyHooks: [],
      agyPlugins: [],
      mcpServers: [],
    };
  }

  const query = opts?.searchQuery?.trim().toLowerCase() ?? '';
  const nsFilter = opts?.namespaceFilter ?? 'all';
  const matchesQuery = (parts: ReadonlyArray<string | undefined>): boolean => {
    if (!query) return true;
    return parts.some((p) => p?.toLowerCase().includes(query));
  };
  const allowNs = (ns: EcosystemNamespaceDto): boolean => nsFilter === 'all' || nsFilter === ns;

  const customAgents = snapshot.customAgents.items.filter(
    (a) => allowNs(a.namespace) && matchesQuery([a.name, a.description, a.sourceKind, a.redactedPath]),
  );
  const skills = snapshot.skills.items.filter(
    (s) => allowNs(s.namespace) && matchesQuery([s.name, s.description, s.sourceKind, s.redactedPath]),
  );
  const rules = snapshot.rules.items.filter(
    (r) => allowNs(r.namespace) && matchesQuery([r.name, r.kind, r.sourceKind, r.redactedPath]),
  );
  const agyHooks = snapshot.hooks.agyHooks.filter(
    (h) => allowNs(h.namespace) && matchesQuery([h.eventName, h.sourceKind, h.redactedPath]),
  );
  const agyPlugins = snapshot.plugins.agyPlugins.filter(
    (p) => allowNs(p.namespace) && matchesQuery([p.name, p.sourceKind, p.redactedPath]),
  );
  const mcpServers = snapshot.mcp.servers.filter(
    (m) => allowNs(m.namespace) && matchesQuery([m.name, m.transportKind, m.scope, m.redactedSourcePath]),
  );

  const agyNativeMcpCount = snapshot.mcp.servers.filter((m) => m.namespace === 'agy_native').length;
  const hmMcpCount = snapshot.mcp.servers.filter((m) => m.namespace === 'harnessmate').length;

  const agyNativeCount =
    snapshot.customAgents.items.length +
    snapshot.skills.items.length +
    snapshot.rules.items.length +
    snapshot.hooks.agyHooks.length +
    snapshot.plugins.agyPlugins.length +
    agyNativeMcpCount;

  const harnessMateCount =
    snapshot.plugins.harnessMateActivePluginsCount +
    snapshot.hooks.harnessMateV5HooksCount +
    hmMcpCount;

  const shadowedSkillsCount = snapshot.skills.items.filter((s) => Boolean(s.shadowedBy)).length;

  const policyRestrictionCount =
    snapshot.adminPolicy.disabledPlugins.length +
    snapshot.adminPolicy.blockedMcpServers.length +
    (snapshot.adminPolicy.hooksDisabled ? 1 : 0) +
    (snapshot.adminPolicy.permissionCeiling ? 1 : 0) +
    (snapshot.adminPolicy.allowedModels ? 1 : 0);

  const invalidProjectRootsCount =
    (snapshot.projects.workspaceRoot.allowed ? 0 : 1) +
    snapshot.projects.additionalDirectories.filter((d) => !d.allowed).length;

  return {
    gatesClosed: snapshot.gatesClosed,
    agyNativeCount,
    harnessMateCount,
    shadowedSkillsCount,
    policyRestrictionCount,
    invalidProjectRootsCount,
    customAgents,
    skills,
    rules,
    agyHooks,
    agyPlugins,
    mcpServers,
  };
}
