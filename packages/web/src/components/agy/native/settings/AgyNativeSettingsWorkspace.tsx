import {
  AlertTriangle,
  Bot,
  FolderCheck,
  GitBranch,
  Layers,
  Lock,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { useState } from 'react';
import { CapabilityUnavailable } from '../shared/CapabilityUnavailable';
import { EntityStatusBadge } from '../shared/EntityStatusBadge';
import { computeNextTabIndex } from '../shared/focus-utils';
import {
  ACCESS_POLICY_LABELS,
  NAMESPACE_LABELS,
  PROJECT_REASON_LABELS,
  SCOPE_LEVEL_LABELS,
  SETTINGS_SECTIONS,
  SOURCE_TIER_LABELS,
  buildAgySettingsViewModel,
} from './selectors';
import type {
  AgyEcosystemCatalogSnapshotDto,
  AgyOptInQueryStateDto,
  EcosystemNamespaceDto,
  SettingsSectionId,
} from './types';

export interface AgyNativeSettingsWorkspaceProps {
  readonly snapshot: AgyEcosystemCatalogSnapshotDto | null;
  readonly initialSection?: SettingsSectionId;
  readonly onRequestOptInQuery?: (kind: 'usage' | 'skills' | 'agents') => void;
  readonly latestOptInResult?: AgyOptInQueryStateDto | null;
  readonly onRefresh?: () => void;
}

function NamespacePill({ namespace }: { readonly namespace: EcosystemNamespaceDto }) {
  const isNative = namespace === 'agy_native';
  return (
    <span
      data-testid={`namespace-pill-${namespace}`}
      className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        backgroundColor: isNative ? 'var(--accent-indigo-soft)' : 'var(--accent-emerald-soft)',
        color: isNative ? 'var(--accent-indigo)' : 'var(--accent-emerald)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      {NAMESPACE_LABELS[namespace]}
    </span>
  );
}

export function AgyNativeSettingsWorkspace({
  snapshot,
  initialSection = 'account',
  onRequestOptInQuery,
  latestOptInResult,
  onRefresh,
}: AgyNativeSettingsWorkspaceProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const [searchQuery, setSearchQuery] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState<'all' | EcosystemNamespaceDto>('all');

  const vm = buildAgySettingsViewModel(snapshot, { searchQuery, namespaceFilter });

  const handleTabKeyDown = (key: string, idx: number) => {
    const nextIdx = computeNextTabIndex(key, idx, SETTINGS_SECTIONS.length);
    if (nextIdx !== null) {
      const next = SETTINGS_SECTIONS[nextIdx];
      if (next) setActiveSection(next.id);
    }
  };

  if (!snapshot) {
    return (
      <div data-testid="agy-native-settings-workspace" className="space-y-2.5 text-[11.5px]">
        <CapabilityUnavailable
          title="AGY 原生生态与配置发现未加载"
          gate="not_tested"
          capabilityId="AGY-E01..E10"
          reason="当前尚未获取 Profile/工作区生态快照；既有手动账号管理与 HarnessMate 功能保持可用。"
          officialEntryHint="可通过官方 CLI /skills、/agents、/mcp 或展开已授权 Profile 查看。"
          onRefresh={onRefresh}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="agy-native-settings-workspace"
      className="space-y-3 rounded-xl p-3 text-[11.5px]"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      {/* Header: Identity scope & namespace boundary */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-[var(--text-primary)]">
              {snapshot.identityScope.displayName}
            </span>
            <span className="font-mono-code rounded border border-[var(--border-hairline)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
              {snapshot.identityScope.instanceId}
            </span>
            <span className="font-mono-code rounded border border-[var(--border-hairline)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
              source: {snapshot.identityScope.source}
            </span>
            {snapshot.identityScope.tierName && (
              <span className="font-mono-code rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)]">
                {snapshot.identityScope.tierName}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--text-muted)]">
            <span>目录：{snapshot.identityScope.redactedGeminiDir}</span>
            <span>AGY 原生项：{vm.agyNativeCount}</span>
            <span>HM 生态项：{vm.harnessMateCount}</span>
            <span>rev.{snapshot.snapshotRevision}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">
            <Lock size={10} aria-hidden="true" />
            私有文件只读
          </span>
          {vm.policyRestrictionCount > 0 && (
            <span
              data-testid="admin-policy-badge"
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                color: 'var(--accent-star)',
              }}
            >
              <ShieldAlert size={10} aria-hidden="true" />
              组织限制 {vm.policyRestrictionCount}
            </span>
          )}
        </div>
      </div>

      {/* Section tabs */}
      <div
        role="tablist"
        aria-label="AGY 原生生态与配置分区"
        className="flex flex-wrap gap-1 border-b border-[var(--border-hairline)] pb-2"
      >
        {SETTINGS_SECTIONS.map((sec, idx) => {
          const selected = activeSection === sec.id;
          return (
            <button
              key={sec.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`settings-tab-${sec.id}`}
              onClick={() => setActiveSection(sec.id)}
              onKeyDown={(e) => handleTabKeyDown(e.key, idx)}
              className="cursor-pointer rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                backgroundColor: selected ? 'var(--accent-indigo)' : 'var(--bg-surface)',
                color: selected ? '#ffffff' : 'var(--text-secondary)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {sec.label}
            </button>
          );
        })}
      </div>

      {/* Honest feature-off gate notice */}
      {snapshot.gatesClosed && (
        <CapabilityUnavailable
          title="扩展生态本地扫描门控默认关闭（U04）"
          gate="not_tested"
          capabilityId="AGY-E01..E05"
          reason="当前仅展示受控三层配置基线与已知边界；本地 Rules/Skills/Hooks/Plugins/MCP 深扫已安全关闭，既有 Profile 与 HarnessMate 功能不受影响。"
          officialEntryHint="开启对应生态读开关或使用官方 CLI 手动查询。"
          onRefresh={onRefresh}
        />
      )}

      {/* Section 1: Account & Auth */}
      {activeSection === 'account' && (
        <section
          role="tabpanel"
          aria-label="账户与认证"
          data-testid="settings-panel-account"
          className="space-y-2"
        >
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
                <UserCheck size={12} aria-hidden="true" />
                手动账户生态与认证隔离（AGY-S14）
              </span>
              <EntityStatusBadge
                kind="gate"
                gate={snapshot.identityScope.profileVerified ? 'available' : 'unknown'}
                compact
              />
            </div>
            <p className="text-[11px] text-[var(--text-secondary)]">{snapshot.accountEcosystem.note}</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 text-[10.5px] text-[var(--text-muted)]">
              <div>隔离模式：{snapshot.identityScope.isolationMode}</div>
              <div>认证方式：{snapshot.identityScope.authMethod}</div>
              <div>
                授权状态：{snapshot.identityScope.profileVerified ? '已登录验证' : '未验证 / 需手动登录'}
              </div>
              <div>应用分区：{snapshot.identityScope.appDataDirName}</div>
            </div>
          </div>

          {snapshot.identityScope.enterpriseIssue1610Warning && (
            <div
              data-testid="issue-1610-warning"
              className="flex items-start gap-1.5 rounded-lg p-2 text-[11px]"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                color: 'var(--accent-star)',
              }}
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                受上游 CLI issue #1610 约束，企业 OAuth（oauth-business）不支持多账号并发文件隔离；请手动使用官方单环境或独立机器。
              </span>
            </div>
          )}

          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
            <div className="font-medium text-[var(--text-primary)]">读写范围公布</div>
            {snapshot.readWriteBoundaries.map((b) => (
              <div
                key={b.domain}
                className="flex flex-wrap items-center justify-between gap-1 border-t border-[var(--border-hairline)] pt-1.5 text-[10.5px]"
              >
                <div className="flex items-center gap-1.5">
                  <NamespacePill namespace={b.namespace} />
                  <span className="font-medium text-[var(--text-primary)]">{b.domain}</span>
                  <span className="text-[var(--text-muted)]">({SCOPE_LEVEL_LABELS[b.scope]})</span>
                </div>
                <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                  {ACCESS_POLICY_LABELS[b.access]}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Section 2: Models & 3-tier Config Scope */}
      {activeSection === 'models' && (
        <section
          role="tabpanel"
          aria-label="模型与配置"
          data-testid="settings-panel-models"
          className="space-y-2"
        >
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
                <Layers size={12} aria-hidden="true" />
                三层作用域解析（AccountDefaults &lt; Session &lt; Turn）
              </span>
              {snapshot.effectiveConfig.hasTurnOverrides && (
                <span className="rounded bg-[var(--accent-indigo-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent-indigo)]">
                  含单轮临时覆盖（结算后自动还原）
                </span>
              )}
            </div>

            <div className="space-y-1.5 text-[11px]">
              {(
                [
                  {
                    label: '模型 (Model)',
                    prov: snapshot.effectiveConfig.provenance.model,
                    val: snapshot.effectiveConfig.provenance.model.requested ?? '未指定（沿用服务端默认）',
                  },
                  {
                    label: '思考强度 (Effort)',
                    prov: snapshot.effectiveConfig.provenance.reasoningEffort,
                    val: snapshot.effectiveConfig.provenance.reasoningEffort.requested ?? '未指定',
                  },
                  {
                    label: '权限模式 (Permission)',
                    prov: snapshot.effectiveConfig.provenance.permissionMode,
                    val: snapshot.effectiveConfig.provenance.permissionMode.requested,
                  },
                ] as const
              ).map((row) => (
                <div
                  key={row.label}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-hairline)] px-2 py-1.5"
                >
                  <div>
                    <div className="font-medium text-[var(--text-primary)]">{row.label}</div>
                    <div className="text-[10px] text-[var(--text-muted)]">
                      来源：{SOURCE_TIER_LABELS[row.prov.sourceTier]}
                      {row.prov.observedActual ? ` · 实测：${String(row.prov.observedActual)}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono-code text-[10.5px] text-[var(--text-primary)]">
                      {String(row.val)}
                    </span>
                    {row.prov.drifted && (
                      <span
                        data-testid="config-drift-badge"
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: 'var(--accent-star-soft)',
                          color: 'var(--accent-star)',
                        }}
                      >
                        {row.prov.reasonCode ?? 'drifted'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {snapshot.effectiveConfig.policyViolations.length > 0 && (
              <div
                data-testid="policy-violations-box"
                className="rounded p-2 text-[10.5px]"
                style={{
                  backgroundColor: 'var(--accent-rose-soft)',
                  color: 'var(--accent-rose)',
                }}
              >
                {snapshot.effectiveConfig.policyViolations.join('；')}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
            <div className="font-medium text-[var(--text-primary)]">
              当前 Profile 实际观测模型（AGY-S10 / AGY-S11 / AGY-S12）
            </div>
            {snapshot.modelsSummary.observedModels.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">
                尚未从已登录会话观测到可用模型列表与思考强度选项。
              </p>
            ) : (
              <div className="space-y-1">
                {snapshot.modelsSummary.observedModels.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-hairline)] px-2 py-1"
                  >
                    <div>
                      <span className="font-medium text-[var(--text-primary)]">
                        {m.displayName ?? m.id}
                      </span>
                      <span className="ml-1.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                        {m.id}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 text-[10px]">
                      {m.supportedEfforts && m.supportedEfforts.length > 0 && (
                        <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                          effort: {m.supportedEfforts.join('/')}
                        </span>
                      )}
                      {!m.allowedByPolicy && (
                        <span className="rounded bg-[var(--accent-rose-soft)] px-1.5 py-0.5 text-[var(--accent-rose)]">
                          组织策略限制
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10.5px] text-[var(--text-muted)]">
              {snapshot.modelsSummary.orchestratorNote}
            </p>
          </div>
        </section>
      )}

      {/* Section 3: Custom Agents */}
      {activeSection === 'agents' && (
        <section
          role="tabpanel"
          aria-label="原生 Agents"
          data-testid="settings-panel-agents"
          className="space-y-2"
        >
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
                <Bot size={12} aria-hidden="true" />
                Custom Agents 自定义角色（AGY-W03）
              </span>
              <div className="flex items-center gap-1.5">
                <NamespacePill namespace="agy_native" />
                {onRequestOptInQuery && (
                  <button
                    type="button"
                    disabled={!snapshot.gates.officialOptInQueryEnabled}
                    onClick={() => onRequestOptInQuery('agents')}
                    className="cursor-pointer rounded border border-[var(--border-hairline)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Opt-in 查询 agy agents
                  </button>
                )}
              </div>
            </div>

            <div
              className="flex items-start gap-1.5 rounded p-2 text-[10.5px]"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                color: 'var(--accent-star)',
              }}
            >
              <GitBranch size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{snapshot.customAgents.note}</span>
            </div>

            {vm.customAgents.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">
                当前作用域未发现 Custom Agents 定义（支持工作区 `.agents/agents` 与 Profile `~/.gemini/config/agents`）。
              </p>
            ) : (
              <div className="space-y-1.5">
                {vm.customAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="rounded border border-[var(--border-hairline)] p-2 space-y-1"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-[var(--text-primary)]">{agent.name}</span>
                        <NamespacePill namespace={agent.namespace} />
                        <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                          {SCOPE_LEVEL_LABELS[agent.scope]}
                        </span>
                        {agent.shadowedBy && (
                          <span className="rounded bg-[var(--accent-star-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent-star)]">
                            已被 {agent.shadowedBy} 覆盖
                          </span>
                        )}
                      </div>
                      <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                        {agent.launchFlag} {agent.name}
                      </span>
                    </div>
                    {agent.description && (
                      <p className="text-[10.5px] text-[var(--text-secondary)]">{agent.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-muted)]">
                      <span>路径：{agent.redactedPath}</span>
                      {agent.modelHint && <span>模型提示：{agent.modelHint}</span>}
                      <span>切换语义：新建会话 / Fork</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Section 4: Ecosystem (Skills / Rules / Hooks / Plugins / MCP / No-Native-Feed) */}
      {activeSection === 'ecosystem' && (
        <section
          role="tabpanel"
          aria-label="生态与边界"
          data-testid="settings-panel-ecosystem"
          className="space-y-2.5"
        >
          {/* Search and namespace filter */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative flex-1 min-w-[160px]">
              <Search
                size={12}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="筛选生态项"
                placeholder="搜索 Skills / Rules / Hooks / Plugins / MCP"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] py-1 pl-6 pr-2 text-[11px] text-[var(--text-primary)]"
              />
            </div>
            <div className="flex items-center gap-1">
              {(
                [
                  { id: 'all', label: '全部' },
                  { id: 'agy_native', label: 'AGY 原生' },
                  { id: 'harnessmate', label: 'HarnessMate' },
                ] as const
              ).map((pill) => (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setNamespaceFilter(pill.id)}
                  className="cursor-pointer rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-[10.5px]"
                  style={{
                    backgroundColor:
                      namespaceFilter === pill.id ? 'var(--accent-indigo-soft)' : 'var(--bg-surface)',
                    color:
                      namespaceFilter === pill.id ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                  }}
                >
                  {pill.label}
                </button>
              ))}
            </div>
          </div>

          {/* Skills 1.5.16 */}
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
                <Sparkles size={12} aria-hidden="true" />
                Skills（{snapshot.skills.precedenceRule}）
              </span>
              {onRequestOptInQuery && (
                <button
                  type="button"
                  disabled={!snapshot.gates.officialOptInQueryEnabled}
                  onClick={() => onRequestOptInQuery('skills')}
                  className="cursor-pointer rounded border border-[var(--border-hairline)] px-2 py-0.5 text-[10.5px] text-[var(--accent-indigo)] disabled:opacity-45"
                >
                  Opt-in 查询 /skills
                </button>
              )}
            </div>
            {vm.skills.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">暂无匹配的 Skills 条目。</p>
            ) : (
              <div className="space-y-1">
                {vm.skills.map((s) => (
                  <div
                    key={`${s.sourceKind}:${s.name}:${s.redactedPath}`}
                    className="flex flex-wrap items-center justify-between gap-1.5 rounded border border-[var(--border-hairline)] px-2 py-1"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-[var(--text-primary)]">{s.name}</span>
                      <NamespacePill namespace={s.namespace} />
                      <span className="text-[10px] text-[var(--text-muted)]">{s.sourceKind}</span>
                      {s.shadowedBy && (
                        <span className="rounded bg-[var(--accent-star-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent-star)]">
                          被 {s.shadowedBy} 覆盖
                        </span>
                      )}
                    </div>
                    <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                      {s.redactedPath}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Rules (#1540) */}
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="font-medium text-[var(--text-primary)]">
                Rules 与 AGENTS.md / GEMINI.md（AGY-E02）
              </span>
              <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                严禁注入 System Prompt
              </span>
            </div>
            <p className="text-[10.5px] text-[var(--accent-star)]">
              {snapshot.rules.acpVerificationNote}
            </p>
            {vm.rules.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-1 rounded border border-[var(--border-hairline)] px-2 py-1 text-[10.5px]"
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-[var(--text-primary)]">{r.name}</span>
                  <NamespacePill namespace={r.namespace} />
                  <span className="text-[var(--text-muted)]">{r.triggerMode}</span>
                </div>
                <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                  {r.redactedPath}
                </span>
              </div>
            ))}
          </div>

          {/* Hooks & Plugins & MCP separation */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[var(--text-primary)]">Hooks 双轨隔离（AGY-E03）</span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  HM V5 启用: {snapshot.hooks.harnessMateV5HooksCount}
                </span>
              </div>
              {snapshot.hooks.organizationDisabled && (
                <div className="text-[10.5px] text-[var(--accent-rose)]">组织政策已禁用 AGY Hooks</div>
              )}
              {vm.agyHooks.length === 0 ? (
                <p className="text-[10.5px] text-[var(--text-muted)]">未发现 AGY hooks.json 声明。</p>
              ) : (
                vm.agyHooks.map((h) => (
                  <div
                    key={`${h.sourceKind}:${h.eventName}`}
                    className="flex items-center justify-between rounded border border-[var(--border-hairline)] px-2 py-1 text-[10.5px]"
                  >
                    <span className="font-mono-code text-[var(--text-primary)]">{h.eventName}</span>
                    <span className="text-[var(--text-muted)]">
                      {h.handlerCount} 个处理器 · 仅只读
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[var(--text-primary)]">
                  Plugins 双轨独立（AGY-E04）
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  HM 插件: {snapshot.plugins.harnessMateActivePluginsCount}
                </span>
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">{snapshot.plugins.separationNote}</p>
              {vm.agyPlugins.map((p) => (
                <div
                  key={`${p.sourceKind}:${p.name}`}
                  className="flex flex-wrap items-center justify-between gap-1 rounded border border-[var(--border-hairline)] px-2 py-1 text-[10.5px]"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-[var(--text-primary)]">{p.name}</span>
                    <NamespacePill namespace={p.namespace} />
                  </div>
                  {p.disabledByPolicy ? (
                    <span className="rounded bg-[var(--accent-rose-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent-rose)]">
                      管理员政策禁用
                    </span>
                  ) : (
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {p.enabled === false ? '已停用' : '已登记'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* MCP */}
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5">
            <div className="font-medium text-[var(--text-primary)]">MCP 作用域边界（AGY-E05）</div>
            <p className="text-[10.5px] text-[var(--text-muted)]">{snapshot.mcp.note}</p>
            {vm.mcpServers.map((srv) => (
              <div
                key={`${srv.namespace}:${srv.scope}:${srv.name}`}
                className="flex flex-wrap items-center justify-between gap-1.5 rounded border border-[var(--border-hairline)] px-2 py-1 text-[10.5px]"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-[var(--text-primary)]">{srv.name}</span>
                  <NamespacePill namespace={srv.namespace} />
                  <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                    {srv.scope} · {srv.transportKind}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-[10px]">
                  {(srv.hasSecretEnvRedacted || srv.hasAuthHeadersRedacted) && (
                    <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                      凭据已脱敏
                    </span>
                  )}
                  {srv.blockedByPolicy && (
                    <span className="rounded bg-[var(--accent-rose-soft)] px-1.5 py-0.5 text-[var(--accent-rose)]">
                      策略阻断
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Boundary / No-Native-Feed surfaces */}
          <div
            data-testid="boundary-surfaces-section"
            className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-1.5"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-[var(--text-primary)]">
                无原生 ACP Feed / 仅限官方入口的能力边界
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">
                共 {snapshot.boundarySurfaces.length} 项
              </span>
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {snapshot.boundarySurfaces.map((surf) => (
                <div
                  key={surf.key}
                  data-testid={`boundary-surface-${surf.key}`}
                  className="rounded border border-[var(--border-hairline)] p-2 space-y-1"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-[var(--text-primary)]">{surf.title}</span>
                    <EntityStatusBadge kind="gate" gate={surf.gate} compact />
                  </div>
                  <p className="text-[10.5px] text-[var(--text-secondary)]">{surf.reason}</p>
                  <div className="text-[10px] text-[var(--text-muted)]">
                    官方入口：{surf.officialEntry}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {latestOptInResult && (
            <div
              data-testid="opt-in-query-result"
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 text-[10.5px]"
            >
              <span className="font-medium text-[var(--text-primary)]">
                Opt-in 查询 ({latestOptInResult.queryKind})：
              </span>
              <span className="text-[var(--text-secondary)]">
                {latestOptInResult.executed
                  ? latestOptInResult.outputSummary ?? `已返回 ${latestOptInResult.itemsCount ?? 0} 项（未写入会话）`
                  : latestOptInResult.error ?? latestOptInResult.reasonCode}
              </span>
            </div>
          )}
        </section>
      )}

      {/* Section 5: Projects & Additional Directories */}
      {activeSection === 'projects' && (
        <section
          role="tabpanel"
          aria-label="项目与目录"
          data-testid="settings-panel-projects"
          className="space-y-2"
        >
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
                <FolderCheck size={12} aria-hidden="true" />
                工作区根与附加目录（AGY-S07 / AGY-S08）
              </span>
              {vm.invalidProjectRootsCount > 0 && (
                <span className="rounded bg-[var(--accent-rose-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent-rose)]">
                  已拦截 {vm.invalidProjectRootsCount} 个非法路径
                </span>
              )}
            </div>

            <div className="rounded border border-[var(--border-hairline)] px-2 py-1.5 flex items-center justify-between gap-2">
              <div>
                <div className="font-medium text-[var(--text-primary)]">主工作区根</div>
                <div className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                  {snapshot.projects.workspaceRoot.redactedPath}
                </div>
              </div>
              <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--accent-emerald)]">
                <ShieldCheck size={11} aria-hidden="true" />
                {PROJECT_REASON_LABELS[snapshot.projects.workspaceRoot.reasonCode]}
              </span>
            </div>

            {snapshot.projects.additionalDirectories.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">未配置账号默认附加目录。</p>
            ) : (
              <div className="space-y-1">
                {snapshot.projects.additionalDirectories.map((dir) => (
                  <div
                    key={`${dir.normalizedHash}:${dir.reasonCode}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-hairline)] px-2 py-1 text-[10.5px]"
                  >
                    <span className="font-mono-code text-[var(--text-secondary)]">
                      {dir.redactedPath}
                    </span>
                    <span
                      style={{
                        color: dir.allowed ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                      }}
                    >
                      {PROJECT_REASON_LABELS[dir.reasonCode]}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[10.5px] text-[var(--text-muted)]">
              {snapshot.projects.nativeProjectsScopeNote}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
