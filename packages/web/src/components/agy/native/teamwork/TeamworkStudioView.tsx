import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  FolderLock,
  FolderOpen,
  HelpCircle,
  Layers,
  Lock,
  Milestone,
  RefreshCw,
  Shield,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coalesceTimelineEntries,
  type NativeStage,
  type NativeTimelineEntry,
} from '../../../../lib/native-client';
import {
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EntityStatusBadge,
  EvidenceDetails,
  NativeRequestCard,
  NativeTimeline,
  toneStyle,
  type NativeWorkbenchViewProps,
} from '../shared';
import { TeamworkPromptArtifactPanel } from './TeamworkPromptArtifactPanel';
import {
  TEAMWORK_DEFAULT_OFFICIAL_HINT,
  TEAMWORK_OFFICIAL_DOC_URL,
  TEAMWORK_ROLE_LABELS,
  deriveTeamworkApprovalGate,
  deriveTeamworkProjectScope,
  deriveTeamworkRoles,
  deriveTeamworkScopingRequests,
  findTeamworkCapability,
  parseWorkflowResourceArtifacts,
  parseWorkflowResourceAuditLogs,
  parseWorkflowResourcePhases,
  selectActiveTeamworkWorkflow,
  selectTeamworkWorkflows,
} from './teamwork-view-model';
import type {
  TeamworkArtifactItemView,
  TeamworkAuditEntryView,
  TeamworkStudioProps,
} from './types';

type TeamworkSectionTab = 'all' | 'scoping' | 'prompt' | 'milestones' | 'roles_artifacts';

interface ScopedTimelineState {
  scopeKey: string;
  entries: NativeTimelineEntry[];
  loading: boolean;
  nextPageToken: string | null;
  sourceUnavailable: boolean;
  sourceUnavailableReason?: string;
}

function useScopingTimeline(
  activityId: string | null,
  bindingKey: string | null,
  loadTimeline?: NativeWorkbenchViewProps['loadTimeline'],
) {
  const scopeKey = activityId && bindingKey ? `${bindingKey}:activity:${activityId}` : '';
  const activeKeyRef = useRef(scopeKey);
  activeKeyRef.current = scopeKey;

  const [state, setState] = useState<ScopedTimelineState>({
    scopeKey,
    entries: [],
    loading: false,
    nextPageToken: null,
    sourceUnavailable: false,
  });

  useEffect(() => {
    if (!activityId || !bindingKey || !loadTimeline) {
      setState({
        scopeKey,
        entries: [],
        loading: false,
        nextPageToken: null,
        sourceUnavailable: false,
      });
      return;
    }

    const reqKey = scopeKey;
    const controller = new AbortController();
    setState({
      scopeKey: reqKey,
      entries: [],
      loading: true,
      nextPageToken: null,
      sourceUnavailable: false,
    });

    void loadTimeline({ kind: 'activity', id: activityId }, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
        setState({
          scopeKey: reqKey,
          entries: coalesceTimelineEntries([], page.items),
          loading: false,
          nextPageToken: page.nextPageToken,
          sourceUnavailable: Boolean(page.sourceUnavailableReason),
          sourceUnavailableReason: page.sourceUnavailableReason,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
        setState({
          scopeKey: reqKey,
          entries: [],
          loading: false,
          nextPageToken: null,
          sourceUnavailable: true,
        });
      });

    return () => {
      controller.abort();
    };
  }, [activityId, bindingKey, scopeKey, loadTimeline]);

  const loadMore = useCallback(() => {
    if (!activityId || !bindingKey || !loadTimeline || !state.nextPageToken || state.loading) {
      return;
    }
    const reqKey = scopeKey;
    const token = state.nextPageToken;
    setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: true } : prev));
    void loadTimeline({ kind: 'activity', id: activityId }, token)
      .then((page) => {
        if (activeKeyRef.current !== reqKey) return;
        setState((prev) =>
          prev.scopeKey === reqKey
            ? {
                ...prev,
                entries: coalesceTimelineEntries(prev.entries, page.items),
                nextPageToken: page.nextPageToken,
                loading: false,
              }
            : prev,
        );
      })
      .catch(() => {
        if (activeKeyRef.current !== reqKey) return;
        setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: false } : prev));
      });
  }, [activityId, bindingKey, loadTimeline, scopeKey, state.nextPageToken, state.loading]);

  const matches = state.scopeKey === scopeKey;
  return {
    entries: matches ? state.entries : [],
    loading: matches ? state.loading : false,
    hasMore: matches && Boolean(state.nextPageToken),
    sourceUnavailable: matches && state.sourceUnavailable,
    sourceUnavailableReason: matches ? state.sourceUnavailableReason : undefined,
    loadMore: matches && state.nextPageToken ? loadMore : undefined,
  };
}

function auditVerdictStyle(verdict: TeamworkAuditEntryView['verdict']) {
  switch (verdict) {
    case 'passed':
      return { label: '审计通过', style: toneStyle('emerald') };
    case 'changes_requested':
      return { label: '需修订', style: toneStyle('star') };
    case 'failed':
      return { label: '审计失败', style: toneStyle('rose') };
    case 'cancelled':
      return { label: '已取消', style: toneStyle('muted') };
    case 'pending':
      return { label: '审计中', style: toneStyle('indigo') };
    default:
      return { label: '状态未知', style: toneStyle('muted') };
  }
}

/**
 * Full-width Teamwork Studio Project Page (NP-10).
 *
 * Sections:
 * 1. Project Header & HM Workspace vs Native Teamwork Project Scope boundary
 * 2. Scoping Interview (progressive Q&A backed by NP-07 requests/receipts + scoped timeline)
 * 3. Prompt Artifact & Formal Approval Gate (NP-14 disabled seam + official App guidance)
 * 4. Milestones & Audit Gates (hides milestone chart when no milestone evidence exists)
 * 5. Confirmed Roles (Sentinel, Project Orchestrator, Workers, Auditors) & Artifacts
 */
export function TeamworkStudioView(props: TeamworkStudioProps) {
  const {
    session,
    projection,
    capabilities,
    pendingApprovals,
    route,
    isNarrowViewport,
    onNavigate,
    onBackToChat,
    onRefresh,
    onResolveRequest,
    loadTimeline,
    loadWorkflowResource,
    teamworkFeatureEnabled = true,
    reviewControl,
    projectScopeOverride,
    scopingItemsOverride,
    auditEntriesOverride,
    artifactsOverride,
    approvalGateOverride,
    commandDiscoveryState,
  } = props;

  const [sectionTab, setSectionTab] = useState<TeamworkSectionTab>('all');
  const [resourcePhases, setResourcePhases] = useState<NativeStage[]>([]);
  const [resourceArtifacts, setResourceArtifacts] = useState<TeamworkArtifactItemView[]>([]);
  const [resourceAuditLogs, setResourceAuditLogs] = useState<TeamworkAuditEntryView[]>([]);

  const teamworkCap = useMemo(() => findTeamworkCapability(capabilities), [capabilities]);
  const workflows = useMemo(() => selectTeamworkWorkflows(projection), [projection]);
  const activeWorkflow = useMemo(
    () => selectActiveTeamworkWorkflow(projection, route.selectedWorkflowId),
    [projection, route.selectedWorkflowId],
  );

  const bindingKey = projection
    ? `${projection.binding.runtimeId}:${projection.binding.generation}`
    : null;

  // Load paginated workflow resources (phases, artifacts, logs) when supported
  useEffect(() => {
    if (!activeWorkflow || !loadWorkflowResource) {
      setResourcePhases([]);
      setResourceArtifacts([]);
      setResourceAuditLogs([]);
      return;
    }
    const controller = new AbortController();
    const wfId = activeWorkflow.id;
    const promptArtId = activeWorkflow.detail.promptArtifactId;

    void Promise.allSettled([
      loadWorkflowResource(wfId, 'phases', null, controller.signal),
      loadWorkflowResource(wfId, 'artifacts', null, controller.signal),
      loadWorkflowResource(wfId, 'logs', null, controller.signal),
    ]).then(([phasesRes, artifactsRes, logsRes]) => {
      if (controller.signal.aborted) return;
      if (phasesRes.status === 'fulfilled') {
        setResourcePhases(parseWorkflowResourcePhases(phasesRes.value.items));
      }
      if (artifactsRes.status === 'fulfilled') {
        setResourceArtifacts(
          parseWorkflowResourceArtifacts(artifactsRes.value.items, promptArtId),
        );
      }
      if (logsRes.status === 'fulfilled') {
        setResourceAuditLogs(parseWorkflowResourceAuditLogs(logsRes.value.items));
      }
    });

    return () => {
      controller.abort();
    };
  }, [activeWorkflow?.id, activeWorkflow?.revision, activeWorkflow?.detail.promptArtifactId, loadWorkflowResource]);

  const scopingActivityId = activeWorkflow?.detail.scopingActivityId ?? null;
  const scopingTimeline = useScopingTimeline(scopingActivityId, bindingKey, loadTimeline);

  const { confirmedRoles, unconfirmedCandidates } = useMemo(
    () => deriveTeamworkRoles(projection, activeWorkflow),
    [projection, activeWorkflow],
  );

  const { pendingScopingApprovals, scopingReceipts } = useMemo(
    () => deriveTeamworkScopingRequests(projection, pendingApprovals, activeWorkflow),
    [projection, pendingApprovals, activeWorkflow],
  );

  const { gateState, canActNativeApproval, disabledReason } = useMemo(
    () =>
      deriveTeamworkApprovalGate({
        projection,
        workflow: activeWorkflow,
        capability: teamworkCap,
        reviewControl,
        teamworkFeatureEnabled,
        override: approvalGateOverride,
      }),
    [projection, activeWorkflow, teamworkCap, reviewControl, teamworkFeatureEnabled, approvalGateOverride],
  );

  const projectScope = useMemo(
    () => deriveTeamworkProjectScope(session, activeWorkflow, projectScopeOverride),
    [session, activeWorkflow, projectScopeOverride],
  );

  const milestones: readonly NativeStage[] = useMemo(() => {
    if (gateState === 'rejected' || gateState === 'cancelled' || gateState === 'expired') {
      return [];
    }
    if (activeWorkflow?.detail.milestones && activeWorkflow.detail.milestones.length > 0) {
      return activeWorkflow.detail.milestones;
    }
    return resourcePhases;
  }, [activeWorkflow?.detail.milestones, resourcePhases, gateState]);

  const artifacts: readonly TeamworkArtifactItemView[] = useMemo(() => {
    if (artifactsOverride && artifactsOverride.length > 0) return artifactsOverride;
    if (resourceArtifacts.length > 0) return resourceArtifacts;
    if (activeWorkflow?.detail.promptArtifactId) {
      return [
        {
          artifactId: activeWorkflow.detail.promptArtifactId,
          title: reviewControl?.promptArtifactTitle ?? 'Teamwork Prompt Artifact',
          artifactKind: 'markdown',
          isPromptArtifact: true,
          revision: reviewControl?.promptArtifactRevision ?? 1,
          updatedAt: 0,
        },
      ];
    }
    return [];
  }, [
    artifactsOverride,
    resourceArtifacts,
    activeWorkflow?.detail.promptArtifactId,
    reviewControl?.promptArtifactTitle,
    reviewControl?.promptArtifactRevision,
  ]);

  const auditEntries: readonly TeamworkAuditEntryView[] = useMemo(() => {
    if (auditEntriesOverride && auditEntriesOverride.length > 0) return auditEntriesOverride;
    return resourceAuditLogs;
  }, [auditEntriesOverride, resourceAuditLogs]);

  const isReadOnlyMode =
    !teamworkFeatureEnabled ||
    projection?.status !== 'attached' ||
    gateState === 'rejected' ||
    gateState === 'cancelled';

  const workflowEvidence =
    activeWorkflow?.state.kind === 'known'
      ? activeWorkflow.state.evidence
      : activeWorkflow?.state.kind === 'stale'
        ? activeWorkflow.state.evidence
        : null;

  // Empty / Unobserved state
  if (!projection || !activeWorkflow) {
    return (
      <div
        data-testid="np10-teamwork-studio"
        data-teamwork-state="empty"
        className="space-y-3"
      >
        {commandDiscoveryState === 'legacy_preview_unverified' && (
          <div
            data-testid="np10-legacy-preview-warning"
            className="flex items-start gap-2 rounded-xl px-3 py-2 text-[11.5px]"
            style={{
              backgroundColor: 'var(--accent-clay-soft)',
              color: 'var(--accent-clay)',
            }}
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              仅观测到旧命令名 /teamwork-preview：HarnessMate 仅跟踪当前官方 /teamwork，不假定 preview 别名可用。
            </span>
          </div>
        )}

        <CapabilityUnavailable
          title="Teamwork Studio · 尚未观察到原生 Teamwork 项目"
          gate={teamworkCap?.observe ?? 'upstream_limited'}
          capabilityId="AGY-W07"
          reason={
            !projection
              ? '当前会话尚未接收到原生运行时快照（或 native runtime 门控关闭）。不猜测或本地创建 Teamwork 项目目录。'
              : '当前会话尚未观察到活跃的 /teamwork 工作流实例。空列表不能证明原生侧已停止；仅基于原生协议或授权事件展示项目、角色与里程碑。'
          }
          officialEntryHint={TEAMWORK_DEFAULT_OFFICIAL_HINT}
          officialDocUrl={TEAMWORK_OFFICIAL_DOC_URL}
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回关联会话聊天"
        />
      </div>
    );
  }

  const showSection = (tab: Exclude<TeamworkSectionTab, 'all'>) =>
    sectionTab === 'all' || sectionTab === tab;

  return (
    <div
      data-testid="np10-teamwork-studio"
      data-teamwork-state={gateState}
      data-readonly={String(isReadOnlyMode)}
      data-narrow={String(isNarrowViewport)}
      className="space-y-4 text-[12px]"
    >
      {/* Top Project Header */}
      <header className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Layers size={16} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
            <h2 className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
              {projectScope.nativeProjectCreated && projectScope.nativeProjectLabel
                ? projectScope.nativeProjectLabel
                : 'Teamwork 项目（待原生确认）'}
            </h2>
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
              {activeWorkflow.id}
            </span>
            <EntityStatusBadge kind="work" observed={activeWorkflow.state} compact />
            <EntityStatusBadge kind="runtime" status={projection.status} compact />
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onBackToChat}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <ArrowLeft size={12} aria-hidden="true" />
              <span>返回关联会话</span>
            </button>
            <button
              type="button"
              aria-label="刷新 Teamwork 状态"
              onClick={onRefresh}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <RefreshCw size={12} aria-hidden="true" />
              <span>刷新</span>
            </button>
          </div>
        </div>

        {/* Multi-workflow selector if more than one Teamwork workflow exists */}
        {workflows.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="切换 Teamwork 实例">
            {workflows.map((wf) => (
              <button
                key={wf.id}
                type="button"
                onClick={() => onNavigate({ selectedWorkflowId: wf.id })}
                className="cursor-pointer rounded-lg border px-2 py-0.5 font-mono-code text-[10.5px]"
                style={{
                  backgroundColor:
                    wf.id === activeWorkflow.id ? 'var(--bg-active)' : 'var(--bg-elevated)',
                  borderColor:
                    wf.id === activeWorkflow.id ? 'var(--border-focus)' : 'var(--border-hairline)',
                  color:
                    wf.id === activeWorkflow.id ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                }}
              >
                {wf.detail.projectLabel ?? wf.id}
              </button>
            ))}
          </div>
        )}

        {/* Feature Gate / Read-only Rollback Banner */}
        {!teamworkFeatureEnabled && (
          <div
            data-testid="np10-feature-disabled-banner"
            className="flex items-start gap-2 rounded-xl px-3 py-2 text-[11.5px]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
          >
            <Lock size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <span>
              Teamwork 交互门控已关闭：已呈现的访谈、Prompt Artifact、角色与里程碑历史保持只读，不再发起或提交新控制。
            </span>
          </div>
        )}

        {/* Disconnected / Reconciling Stale Banner */}
        {projection.status !== 'attached' && (
          <div
            data-testid="np10-runtime-stale-banner"
            className="flex items-start gap-2 rounded-xl px-3 py-2 text-[11.5px]"
            style={{
              backgroundColor: 'var(--accent-clay-soft)',
              color: 'var(--accent-clay)',
            }}
          >
            <WifiOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {projection.status === 'reconciling'
                ? '正在重连校准原生 Teamwork 状态：保留最后观测记录，旧审批与待决问题不会自动重放。'
                : '原生观测连接已断开：无法推断后台 Teamwork 项目已停止；所有待审批项已冻结为只读历史。'}
            </span>
          </div>
        )}

        {/* HM Workspace Scope vs Native Teamwork Project Directory Separation */}
        <div
          data-testid="np10-scope-boundary"
          className="grid grid-cols-1 gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 md:grid-cols-2"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <Shield size={11.5} aria-hidden="true" />
              <span>HarnessMate 会话工作区 (HM Scope)</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--text-primary)]">
              <span className="font-medium">{projectScope.hmWorkspaceLabel}</span>
              <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                与原生 Teamwork 目录隔离
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {projectScope.pathOpenAuthorized ? (
                  <FolderOpen size={11.5} className="text-[var(--accent-emerald)]" aria-hidden="true" />
                ) : (
                  <FolderLock size={11.5} className="text-[var(--accent-clay)]" aria-hidden="true" />
                )}
                <span>AGY 原生 Teamwork 项目目录</span>
              </span>
              <span
                data-testid="np10-path-access-gate"
                className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                style={toneStyle(
                  projectScope.pathOpenAuthorized
                    ? 'emerald'
                    : projectScope.nativeProjectCreated
                      ? 'clay'
                      : 'muted',
                )}
              >
                {projectScope.pathOpenAuthorized
                  ? '已授权只读打开'
                  : projectScope.nativeProjectCreated
                    ? '需明确路径授权'
                    : '未创建项目'}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11.5px] text-[var(--text-secondary)]">
                {projectScope.nativeProjectCreated
                  ? `${projectScope.nativeProjectLabel ?? 'Teamwork Project'}（来源：原生事件，不暴露原始主机路径）`
                  : '等待 Prompt Artifact 正式批准并由原生端创建项目目录（HM 不代建目录）'}
              </span>

              <button
                type="button"
                data-testid="np10-open-project-path-btn"
                disabled={
                  !projectScope.pathOpenAuthorized ||
                  isReadOnlyMode ||
                  !projectScope.onOpenAuthorizedProjectPath
                }
                onClick={() => projectScope.onOpenAuthorizedProjectPath?.()}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                title={
                  projectScope.pathOpenAuthorized
                    ? '在已授权根目录边界内打开项目目录'
                    : `路径未获授权（${projectScope.authorizationReasonCode}），禁止打开猜测路径`
                }
              >
                <FolderOpen size={11} aria-hidden="true" />
                <span>打开已授权目录</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Section Filter Bar (especially useful at 480px narrow viewport & full-width scanning) */}
      <nav
        aria-label="Teamwork 项目分区导航"
        className="flex flex-wrap items-center gap-1.5"
      >
        {(
          [
            { id: 'all', label: '全览项目页' },
            { id: 'scoping', label: `访谈 (${(scopingItemsOverride?.length ?? scopingReceipts.length) + pendingScopingApprovals.length})` },
            { id: 'prompt', label: 'Prompt Artifact' },
            { id: 'milestones', label: `里程碑与审计 (${milestones.length})` },
            { id: 'roles_artifacts', label: `角色与产物 (${confirmedRoles.length}/${artifacts.length})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={sectionTab === tab.id}
            onClick={() => setSectionTab(tab.id)}
            className="cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={{
              backgroundColor: sectionTab === tab.id ? 'var(--bg-active)' : 'var(--bg-surface)',
              borderColor: sectionTab === tab.id ? 'var(--border-focus)' : 'var(--border-hairline)',
              color: sectionTab === tab.id ? 'var(--accent-indigo)' : 'var(--text-secondary)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Main Full-Width Two-Column Project Grid */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left Column: Scoping Interview + Prompt Artifact Approval Gate */}
        <div className="space-y-4 xl:col-span-5">
          {showSection('scoping') && (
            <section
              data-testid="np10-scoping-section"
              aria-label="Teamwork 需求访谈"
              className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <HelpCircle size={14.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                  <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                    需求访谈 (Scoping Interview)
                  </h3>
                </div>
                {scopingActivityId && (
                  <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                    {scopingActivityId}
                  </span>
                )}
              </div>

              {/* Active NP-07 pending scoping requests */}
              {pendingScopingApprovals.length > 0 && (
                <div className="space-y-2">
                  {pendingScopingApprovals.map((appr) => {
                    const receipt = projection.receipts?.[appr.id] ?? null;
                    return (
                      <NativeRequestCard
                        key={appr.id}
                        approval={appr}
                        receipt={receipt}
                        onResolve={isReadOnlyMode ? undefined : onResolveRequest}
                      />
                    );
                  })}
                </div>
              )}

              {/* Structured scoping question progression (idempotent records) */}
              {scopingItemsOverride && scopingItemsOverride.length > 0 ? (
                <div className="space-y-1.5" data-testid="np10-scoping-questions-list">
                  {scopingItemsOverride.map((q) => (
                    <div
                      key={q.questionId}
                      className="space-y-1 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="font-medium text-[var(--text-primary)]">
                          Q{q.occurrence} · {q.promptSummary}
                        </span>
                        <EntityStatusBadge kind="receipt" state={q.receiptState} compact />
                      </div>
                      {q.selectedOptionLabel && (
                        <div className="text-[11px] text-[var(--accent-indigo)]">
                          已选回答：{q.selectedOptionLabel}
                        </div>
                      )}
                      {q.duplicateDeliveriesIgnored !== undefined && q.duplicateDeliveriesIgnored > 0 && (
                        <div className="font-mono-code text-[10px] text-[var(--text-muted)]">
                          幂等去重：已忽略 {q.duplicateDeliveriesIgnored} 次重复投递
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : scopingReceipts.length > 0 ? (
                <div className="space-y-1.5">
                  {scopingReceipts
                    .filter((r) => !pendingScopingApprovals.some((a) => a.id === r.approvalId))
                    .map((receipt) => (
                      <NativeRequestCard key={receipt.approvalId} receipt={receipt} />
                    ))}
                </div>
              ) : pendingScopingApprovals.length === 0 ? (
                <p className="text-[11.5px] text-[var(--text-muted)]">
                  {EMPTY_STATE_COPY.noActivityObserved}（访谈问题经 NP-07 结构化请求与回执逐题展示）。
                </p>
              ) : null}

              {scopingActivityId && (
                <NativeTimeline
                  entries={scopingTimeline.entries}
                  scopeLabel={`访谈活动 ${scopingActivityId}`}
                  loading={scopingTimeline.loading}
                  hasMore={scopingTimeline.hasMore}
                  onLoadMore={scopingTimeline.loadMore}
                  sourceNotProvided={scopingTimeline.sourceUnavailable}
                  sourceUnavailableReason={
                    scopingTimeline.sourceUnavailableReason ??
                    '当前连接未提供访谈活动分页时间线，请在主聊天查看原始流。'
                  }
                />
              )}
            </section>
          )}

          {showSection('prompt') && (
            <TeamworkPromptArtifactPanel
              promptArtifactId={activeWorkflow.detail.promptArtifactId}
              gateState={gateState}
              canActNativeApproval={canActNativeApproval}
              disabledReason={disabledReason}
              reviewControl={reviewControl}
              evidence={workflowEvidence}
              onRefresh={onRefresh}
            />
          )}
        </div>

        {/* Right Column: Milestones / Audit + Confirmed Roles + Artifacts */}
        <div className="space-y-4 xl:col-span-7">
          {showSection('milestones') && (
            <section
              data-testid="np10-milestones-section"
              aria-label="Teamwork 里程碑与审计"
              className="space-y-3 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Milestone size={14.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                  <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                    项目里程碑 (Milestones)
                  </h3>
                </div>
                <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                  已观测 {milestones.length} 项
                </span>
              </div>

              {milestones.length === 0 ? (
                <div
                  data-testid="np10-milestones-hidden-notice"
                  className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px] text-[var(--text-muted)]"
                >
                  {gateState === 'rejected' || gateState === 'cancelled' || gateState === 'expired'
                    ? 'Prompt Artifact 未获批准，未创建任何里程碑，已隐藏里程碑图表。'
                    : '尚未收到原生里程碑证据，已隐藏进度图表；不从助手文本推测阶段或完成度。'}
                </div>
              ) : (
                <ol className="space-y-2" data-testid="np10-milestones-list">
                  {milestones.map((ms, idx) => (
                    <li
                      key={ms.id}
                      data-testid={`np10-milestone-${ms.id}`}
                      className="space-y-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                            M{idx + 1}
                          </span>
                          <span className="truncate font-medium text-[var(--text-primary)]">
                            {ms.label}
                          </span>
                        </div>
                        <EntityStatusBadge kind="work" observed={ms.state} compact />
                      </div>

                      {ms.after && ms.after.length > 0 && (
                        <div className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                          前置依赖：{ms.after.join(', ')}
                        </div>
                      )}

                      {ms.agentIds && ms.agentIds.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10.5px] text-[var(--text-muted)]">已证实参与角色：</span>
                          {ms.agentIds.map((agentId) => (
                            <button
                              key={agentId}
                              type="button"
                              onClick={() =>
                                onNavigate({ surface: 'subagents', selectedAgentId: agentId })
                              }
                              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                            >
                              <Bot size={10} aria-hidden="true" />
                              <span>{agentId}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              {/* Audit Trail */}
              <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5">
                <div className="flex items-center gap-1.5">
                  <ClipboardCheck size={14} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                  <h4 className="text-[12px] font-semibold text-[var(--text-primary)]">
                    审计门控与事件轨迹 (Audit Gates)
                  </h4>
                </div>
                {auditEntries.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-muted)]">
                    尚未观测到原生审计门控结果。
                  </p>
                ) : (
                  <div className="space-y-1.5" data-testid="np10-audit-list">
                    {auditEntries.map((audit) => {
                      const badge = auditVerdictStyle(audit.verdict);
                      return (
                        <div
                          key={audit.auditId}
                          className="space-y-1 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <span className="font-medium text-[var(--text-primary)]">
                              {audit.label}
                            </span>
                            <span
                              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
                              style={badge.style}
                            >
                              {audit.verdict === 'passed' && (
                                <CheckCircle2 size={10.5} aria-hidden="true" />
                              )}
                              <span>{badge.label}</span>
                            </span>
                          </div>
                          {audit.summary && (
                            <p className="text-[11px] text-[var(--text-secondary)]">
                              {audit.summary}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {showSection('roles_artifacts') && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Confirmed Roles (Sentinel, Project Orchestrator, Workers, Auditors) */}
              <section
                data-testid="np10-roles-section"
                aria-label="已证实的 Teamwork 角色"
                className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck size={14.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                    <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                      已证实角色 ({confirmedRoles.length})
                    </h3>
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)]">仅显示亲缘确证</span>
                </div>

                {confirmedRoles.length === 0 ? (
                  <p className="text-[11.5px] text-[var(--text-muted)]">
                    尚未观测到亲缘确证的 Sentinel、Project Orchestrator 或 Auditor 角色。
                  </p>
                ) : (
                  <div className="space-y-1.5" data-testid="np10-confirmed-roles-list">
                    {confirmedRoles.map((role) => (
                      <div
                        key={role.agentId}
                        data-testid={`np10-role-${role.roleKind}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded bg-[var(--accent-indigo-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-indigo)]">
                              {TEAMWORK_ROLE_LABELS[role.roleKind]}
                            </span>
                            <span className="truncate font-medium text-[var(--text-primary)]">
                              {role.displayLabel}
                            </span>
                          </div>
                          <div className="mt-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                            {role.agentId}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <EntityStatusBadge kind="foreground" observed={role.foreground} compact />
                          <button
                            type="button"
                            onClick={() =>
                              onNavigate({ surface: 'subagents', selectedAgentId: role.agentId })
                            }
                            className="inline-flex cursor-pointer items-center gap-0.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                          >
                            <span>轨迹</span>
                            <ArrowUpRight size={10.5} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {unconfirmedCandidates.length > 0 && (
                  <div
                    data-testid="np10-unconfirmed-roles-section"
                    className="space-y-1.5 border-t border-[var(--border-hairline)] pt-2"
                  >
                    <div className="text-[10.5px] font-medium text-[var(--accent-clay)]">
                      未确证角色候选 ({unconfirmedCandidates.length} · 不计入正式角色)
                    </div>
                    {unconfirmedCandidates.map((cand) => (
                      <div
                        key={cand.agentId}
                        className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px]"
                      >
                        <span className="truncate text-[var(--text-secondary)]">
                          {cand.displayLabel}
                        </span>
                        <EntityStatusBadge kind="lineage" lineage={cand.lineage} compact />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Artifacts */}
              <section
                data-testid="np10-artifacts-section"
                aria-label="Teamwork 产物列表"
                className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <FileText size={14.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                    <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                      项目产物 ({artifacts.length})
                    </h3>
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)]">不透明 ID 只读</span>
                </div>

                {artifacts.length === 0 ? (
                  <p className="text-[11.5px] text-[var(--text-muted)]">
                    尚未观测到 Teamwork 产物引用。
                  </p>
                ) : (
                  <div className="space-y-1.5" data-testid="np10-artifacts-list">
                    {artifacts.map((art) => (
                      <div
                        key={art.artifactId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px]"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-medium text-[var(--text-primary)]">
                              {art.title}
                            </span>
                            {art.isPromptArtifact && (
                              <span className="rounded bg-[var(--accent-indigo-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-indigo)]">
                                Prompt Artifact
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                            {art.artifactId} · {art.artifactKind} · rev {art.revision}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {/* Provenance footer */}
      <EvidenceDetails
        evidence={workflowEvidence}
        reasonCode={activeWorkflow.state.kind !== 'known' ? activeWorkflow.state.reasonCode : undefined}
        evidenceRefs={teamworkCap?.evidenceRefs ?? ['AGY-W07']}
        label="Teamwork 工作流观测证据"
      />
    </div>
  );
}
