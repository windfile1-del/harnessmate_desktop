import {
  Activity as ActivityIcon,
  ArrowLeft,
  Bot,
  CheckCircle2,
  FileText,
  Layers,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  coalesceTimelineEntries,
  type NativeTimelineEntry,
  type WorkflowId,
} from '../../../../lib/native-client';
import {
  ACTIVITY_ORIGIN_LABELS,
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EntityStatusBadge,
  EvidenceDetails,
  NativeActivityLink,
  NativeControlMenu,
  NativeRequestCard,
  NativeTimeline,
  WORK_KIND_LABELS,
  toneStyle,
  type NativeWorkbenchViewProps,
} from '../shared';
import { BoostEligibilityBanner } from './BoostEligibilityBanner';
import { deriveBoostStudioViewModel, parseBoostResourceItems } from './selectors';
import type {
  BoostCanonicalPhaseKind,
  BoostWorkflowResourceBundle,
} from './types';

const CANONICAL_PHASE_LABELS: Record<BoostCanonicalPhaseKind, string> = {
  initial: '初始实现 (initial)',
  improvement: '挑战修复 (improvement)',
  verification: '独立验证 (verification)',
};

interface ScopedTimelineState {
  scopeKey: string;
  entries: NativeTimelineEntry[];
  loading: boolean;
  nextPageToken: string | null;
  sourceUnavailable: boolean;
  sourceUnavailableReason?: string;
}

function useBoostActivityTimeline(
  activityId: string | null,
  bindingKey: string | null,
  loadTimeline?: NativeWorkbenchViewProps['loadTimeline'],
) {
  const scopeKey = activityId && bindingKey ? `${bindingKey}:activity:${activityId}` : '';
  const activeKeyRef = useRef(scopeKey);
  activeKeyRef.current = scopeKey;
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<ScopedTimelineState>({
    scopeKey,
    entries: [],
    loading: false,
    nextPageToken: null,
    sourceUnavailable: false,
  });

  useEffect(() => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

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
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [activityId, bindingKey, scopeKey, loadTimeline]);

  const loadMore = useCallback(() => {
    if (!activityId || !bindingKey || !loadTimeline) return;
    if (state.scopeKey !== scopeKey || !state.nextPageToken || state.loading) return;
    const reqKey = scopeKey;
    const token = state.nextPageToken;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: true } : prev));
    void loadTimeline({ kind: 'activity', id: activityId }, token, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
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
        if (controller.signal.aborted || activeKeyRef.current !== reqKey) return;
        setState((prev) => (prev.scopeKey === reqKey ? { ...prev, loading: false } : prev));
      });
  }, [activityId, bindingKey, loadTimeline, state.scopeKey, state.nextPageToken, state.loading, scopeKey]);

  const matches = state.scopeKey === scopeKey;
  return {
    entries: matches ? state.entries : [],
    loading: matches ? state.loading : Boolean(activityId && bindingKey && loadTimeline),
    hasMore: matches && Boolean(state.nextPageToken),
    sourceUnavailable: matches && state.sourceUnavailable,
    sourceUnavailableReason: matches ? state.sourceUnavailableReason : undefined,
    loadMore: matches && state.nextPageToken ? loadMore : undefined,
  };
}

function useBoostWorkflowResources(
  workflowId: WorkflowId | null,
  workflowRevision: number,
  bindingKey: string | null,
  loadWorkflowResource?: NativeWorkbenchViewProps['loadWorkflowResource'],
): BoostWorkflowResourceBundle | null {
  const reqScopeKey = workflowId && bindingKey ? `${bindingKey}:${workflowId}:${workflowRevision}` : '';
  const activeKeyRef = useRef(reqScopeKey);
  activeKeyRef.current = reqScopeKey;

  const [bundle, setBundle] = useState<BoostWorkflowResourceBundle | null>(null);

  useEffect(() => {
    if (!workflowId || !bindingKey || !loadWorkflowResource) {
      setBundle(null);
      return;
    }

    const expectedKey = reqScopeKey;
    const controller = new AbortController();
    setBundle({
      workflowId,
      logs: [],
      artifacts: [],
      phaseSummariesById: {},
      loading: true,
    });

    void Promise.allSettled([
      loadWorkflowResource(workflowId, 'logs', null, controller.signal),
      loadWorkflowResource(workflowId, 'artifacts', null, controller.signal),
      loadWorkflowResource(workflowId, 'phases', null, controller.signal),
    ]).then(([logsRes, artifactsRes, phasesRes]) => {
      if (controller.signal.aborted || activeKeyRef.current !== expectedKey) return;

      const parsedLogs =
        logsRes.status === 'fulfilled'
          ? parseBoostResourceItems('logs', logsRes.value.items)
          : { logs: [], artifacts: [], phaseSummariesById: {} };
      const parsedArtifacts =
        artifactsRes.status === 'fulfilled'
          ? parseBoostResourceItems('artifacts', artifactsRes.value.items)
          : { logs: [], artifacts: [], phaseSummariesById: {} };
      const parsedPhases =
        phasesRes.status === 'fulfilled'
          ? parseBoostResourceItems('phases', phasesRes.value.items)
          : { logs: [], artifacts: [], phaseSummariesById: {} };

      setBundle({
        workflowId,
        logs: parsedLogs.logs,
        logsUnavailableReason:
          logsRes.status === 'fulfilled'
            ? logsRes.value.sourceUnavailableReason
            : 'workflow_logs_unavailable',
        artifacts: parsedArtifacts.artifacts,
        artifactsUnavailableReason:
          artifactsRes.status === 'fulfilled'
            ? artifactsRes.value.sourceUnavailableReason
            : 'workflow_artifacts_unavailable',
        phaseSummariesById: parsedPhases.phaseSummariesById,
        loading: false,
      });
    });

    return () => {
      controller.abort();
    };
  }, [workflowId, workflowRevision, bindingKey, reqScopeKey, loadWorkflowResource]);

  if (!workflowId || !bundle || bundle.workflowId !== workflowId) return null;
  return bundle;
}

/**
 * NP-09 Boost Studio (`surface: 'boost'`).
 *
 * - Presents confirmed Boost launches, inspectable verification clues, observed native
 *   stages (ONLY when phase evidence exists), observable activities, and verified stop controls.
 * - Omits stage progress section completely when native runtime provides no phase fields.
 * - Preserves unknown stage/role labels verbatim without inferring progress or round counts.
 * - Displays deterministic plan/tier eligibility and never auto-upgrades to paid mode.
 */
export function BoostStudioView({
  projection,
  capabilities,
  pendingApprovals,
  route,
  isNarrowViewport,
  onNavigate,
  onBackToChat,
  onRefresh,
  onResolveRequest,
  onDispatchControl,
  loadTimeline,
  loadWorkflowResource,
}: NativeWorkbenchViewProps) {
  const bindingKey = projection
    ? `${projection.binding.runtimeId}:${projection.binding.generation}`
    : null;

  const initialModel = useMemo(
    () =>
      deriveBoostStudioViewModel(
        projection,
        capabilities,
        pendingApprovals,
        route.selectedWorkflowId,
      ),
    [projection, capabilities, pendingApprovals, route.selectedWorkflowId],
  );

  const resourceBundle = useBoostWorkflowResources(
    initialModel.activeWorkflow?.id ?? null,
    initialModel.activeWorkflow?.revision ?? 0,
    bindingKey,
    loadWorkflowResource,
  );

  const model = useMemo(
    () =>
      deriveBoostStudioViewModel(
        projection,
        capabilities,
        pendingApprovals,
        route.selectedWorkflowId,
        resourceBundle?.phaseSummariesById ?? {},
      ),
    [
      projection,
      capabilities,
      pendingApprovals,
      route.selectedWorkflowId,
      resourceBundle?.phaseSummariesById,
    ],
  );

  const selectedActivityId =
    model.relatedActivities.find((a) => a.id === route.selectedActivityId)?.id ??
    model.originActivity?.id ??
    model.relatedActivities[0]?.id ??
    null;

  const timeline = useBoostActivityTimeline(selectedActivityId, bindingKey, loadTimeline);

  const activeWorkflow = model.activeWorkflow;

  return (
    <div
      className={isNarrowViewport ? 'space-y-3' : 'space-y-4'}
      data-testid="np09-boost-studio"
    >
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBackToChat}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          >
            <ArrowLeft size={12} aria-hidden="true" />
            <span>返回主聊天</span>
          </button>
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--text-primary)]">
            <Sparkles size={13} className="text-[var(--accent-indigo)]" aria-hidden="true" />
            <span>Boost Studio</span>
          </span>
        </div>

        {model.boostWorkflows.length > 1 && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="选择 Boost 实例">
            {model.boostWorkflows.map((wf) => {
              const selected = activeWorkflow?.id === wf.id;
              return (
                <button
                  key={wf.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onNavigate({ selectedWorkflowId: wf.id })}
                  className="cursor-pointer rounded-lg border px-2 py-0.5 font-mono-code text-[10.5px]"
                  style={{
                    backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-surface)',
                    borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                    color: selected ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                  }}
                >
                  {wf.id}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 1. Eligibility & Plan / Tier Advertisement Banner */}
      <BoostEligibilityBanner model={model.eligibility} onRefresh={onRefresh} />

      {/* 2. Disconnected / No Active Boost Workflow Honest Degradation */}
      {!projection ? (
        <CapabilityUnavailable
          title="Boost Studio 暂无原生投影"
          gate="unknown"
          capabilityId="AGY-W06"
          reason="当前会话尚未连接到 AGY 原生运行时（或 native runtime 门控未开启）。Boost 需要活跃的 live ACP 会话，绝不自动升级付费模式或另起独立 CLI。"
          officialEntryHint={model.eligibility.officialEntryHint}
          officialDocUrl={model.eligibility.officialDocUrl}
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天"
        />
      ) : !activeWorkflow ? (
        <CapabilityUnavailable
          title="尚未观察到已证实的 Boost 运行"
          gate={model.eligibility.launchGate === 'available' ? model.eligibility.observeGate : model.eligibility.launchGate}
          capabilityId="AGY-W06"
          reason={
            model.eligibility.isEligibleToLaunch
              ? '当前会话尚未收到用户显式发起的 /boost 启动记录。空列表仅表示尚未观察到 Boost 实例，不代表后台已停止；请在主聊天模式选择器中显式选用 Boost 发起。'
              : model.eligibility.explanation
          }
          officialEntryHint={model.eligibility.officialEntryHint}
          officialDocUrl={model.eligibility.officialDocUrl}
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天保留原模式"
        />
      ) : (
        <>
          {/* 3. Confirmed Launch & Workflow Summary */}
          <section
            data-testid="np09-boost-run-summary"
            aria-label="已证实 Boost 运行概览"
            className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px]"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-[var(--accent-indigo-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-indigo)]">
                    已证实启动 · live_workflow
                  </span>
                  <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                    {activeWorkflow.id} · rev #{activeWorkflow.revision}
                  </span>
                </div>
                <p className="font-medium text-[var(--text-primary)]">
                  {activeWorkflow.detail.kind === 'boost' && activeWorkflow.detail.objective
                    ? activeWorkflow.detail.objective
                    : '已观测到原生 Boost 工作流（任务摘要未在协议中单独提供）'}
                </p>
              </div>
              <EntityStatusBadge kind="work" observed={activeWorkflow.state} />
            </div>

            {projection.status !== 'attached' && (
              <div
                data-testid="np09-boost-stale-warning"
                className="flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px]"
                style={{
                  backgroundColor: 'var(--accent-clay-soft)',
                  borderColor: 'color-mix(in srgb, var(--accent-clay) 35%, transparent)',
                  color: 'var(--accent-clay)',
                }}
              >
                <ShieldAlert size={13} aria-hidden="true" />
                <span>
                  当前原生连接为「{projection.status === 'reconciling' ? '校准中' : '已断开'}」，未决阶段与工作项保持最后观测/未知状态，不推定已完成或已取消。
                </span>
              </div>
            )}

            <EvidenceDetails
              evidence={model.workflowEvidence}
              reasonCode={model.workflowReasonCode}
              label={`工作流 ${activeWorkflow.id} 状态证据`}
            />
          </section>

          {/* 4. Observed Native Phases (STRICTLY ONLY when phase evidence exists!) */}
          {model.phases ? (
            <section
              data-testid="np09-boost-phases-section"
              aria-label="已观测 Boost 原生阶段"
              className="space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <Layers size={12} aria-hidden="true" />
                  <span>已观测原生阶段（只读 · 不推断轮数或进度）</span>
                </h3>
              </div>

              <div className="space-y-2">
                {model.phases.map((phase) => {
                  const isCanonical = phase.classification.kind === 'canonical';
                  const badgeTone = isCanonical
                    ? phase.classification.phaseKind === 'verification'
                      ? toneStyle('emerald')
                      : phase.classification.phaseKind === 'improvement'
                        ? toneStyle('star')
                        : toneStyle('indigo')
                    : toneStyle('muted');

                  return (
                    <article
                      key={phase.stage.id}
                      data-testid={`np09-boost-phase-${phase.stage.id}`}
                      data-phase-classification={
                        isCanonical ? phase.classification.phaseKind : 'observed_unknown'
                      }
                      className="space-y-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-[11.5px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span
                            className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              color: badgeTone.color,
                              backgroundColor: badgeTone.backgroundColor,
                              borderColor: badgeTone.borderColor,
                            }}
                          >
                            {isCanonical
                              ? CANONICAL_PHASE_LABELS[phase.classification.phaseKind]
                              : '已观测标签'}
                          </span>
                          <span className="truncate font-semibold text-[var(--text-primary)]">
                            {phase.stage.label}
                          </span>
                          <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                            {phase.stage.id}
                          </span>
                        </div>
                        <EntityStatusBadge kind="work" observed={phase.stage.state} compact />
                      </div>

                      {phase.summary && (
                        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                          {phase.summary}
                        </p>
                      )}

                      {phase.stage.after && phase.stage.after.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                          <span>已证实前置阶段：</span>
                          {phase.stage.after.map((depId) => (
                            <span
                              key={depId}
                              className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px]"
                            >
                              {depId}
                            </span>
                          ))}
                        </div>
                      )}

                      {phase.linkedAgents.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10.5px] text-[var(--text-muted)]">已确证子执行：</span>
                          {phase.linkedAgents.map((agent) => (
                            <button
                              key={agent.id}
                              type="button"
                              onClick={() =>
                                onNavigate({ surface: 'subagents', selectedAgentId: agent.id })
                              }
                              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                            >
                              <Bot size={11} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                              <span>
                                {agent.label?.kind === 'known'
                                  ? agent.label.value
                                  : agent.role?.kind === 'known'
                                    ? agent.role.value
                                    : agent.id}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}

                      <EvidenceDetails
                        evidence={phase.evidence}
                        reasonCode={phase.reasonCode}
                        label={`阶段 ${phase.stage.id} 观测证据`}
                      />
                    </article>
                  );
                })}
              </div>
            </section>
          ) : (
            <section
              data-testid="np09-boost-no-phases-notice"
              aria-label="未观测到 Boost 原生阶段"
              className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px] text-[var(--text-secondary)]"
            >
              <div className="font-medium text-[var(--text-primary)]">
                未收到原生 Boost 阶段字段 · 已省略阶段区块
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                当前 ACP 流未暴露结构化阶段列表，HarnessMate 不硬编码实现/挑战/修复/验证阶段，也不推断轮数或完成百分比；以下保留已证实的启动事实、可观察活动与验证线索。
              </p>
            </section>
          )}

          {/* 5. Inspectable Verification Clues & Artifacts */}
          <section
            data-testid="np09-boost-verification-clues"
            aria-label="可查验证线索与产物"
            className="space-y-2"
          >
            <h3 className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <CheckCircle2 size={12} aria-hidden="true" />
              <span>可查验证线索与观测日志</span>
            </h3>

            {resourceBundle?.loading ? (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11px] text-[var(--text-muted)]">
                正在读取 Boost 验证线索…
              </div>
            ) : resourceBundle && resourceBundle.logs.length > 0 ? (
              <div className="space-y-1.5">
                {resourceBundle.logs.map((clue) => {
                  const tone =
                    clue.level === 'error'
                      ? toneStyle('rose')
                      : clue.level === 'warn'
                        ? toneStyle('clay')
                        : toneStyle('indigo');
                  return (
                    <div
                      key={clue.id}
                      data-testid={`np09-boost-clue-${clue.id}`}
                      className="space-y-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-[11.5px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className="rounded px-1.5 py-0.5 font-mono-code text-[10px]"
                          style={{
                            color: tone.color,
                            backgroundColor: tone.backgroundColor,
                          }}
                        >
                          #{clue.seq} · {clue.level}
                        </span>
                        {clue.evidence && (
                          <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                            {clue.evidence.sourceKind} · {clue.evidence.freshness}
                          </span>
                        )}
                      </div>
                      <p className="leading-relaxed text-[var(--text-primary)]">{clue.summary}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]">
                <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
                <p className="mt-0.5 text-[10.5px]">
                  {resourceBundle?.logsUnavailableReason
                    ? `观测日志源暂不可用 (${resourceBundle.logsUnavailableReason})，请在下方活动与工作项中继续查看。`
                    : EMPTY_STATE_COPY.emptyListNotStopped}
                </p>
              </div>
            )}

            {resourceBundle && resourceBundle.artifacts.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  关联验证产物（只读引用）
                </div>
                {resourceBundle.artifacts.map((art) => (
                  <div
                    key={art.artifactId}
                    data-testid={`np09-boost-artifact-${art.artifactId}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-2 text-[11.5px]"
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                      <FileText size={12} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                      <span>{art.title}</span>
                    </span>
                    <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                      {art.artifactKind} · {art.artifactId} · rev #{art.revision}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 6. Pending Boost-Scoped Approvals (reusing NP-03/NP-07 request card) */}
          {model.relatedApprovals.length > 0 && (
            <section className="space-y-2" aria-label="Boost 关联待处理审批">
              <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                关联待处理原生请求 ({model.relatedApprovals.length})
              </h3>
              <div className="space-y-2">
                {model.relatedApprovals.map((appr) => {
                  const receipt = projection.receipts?.[appr.id] ?? null;
                  const owner = receipt?.agentId
                    ? projection.agents.find((a) => a.id === receipt.agentId) ?? null
                    : null;
                  return (
                    <NativeRequestCard
                      key={appr.id}
                      approval={appr}
                      receipt={receipt}
                      ownerAgent={owner}
                      onResolve={onResolveRequest}
                      onJumpToAgent={(agentId) =>
                        onNavigate({ surface: 'subagents', selectedAgentId: agentId })
                      }
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* 7. Observable Activities, Related Work & Subagent Roles (Lineage Separated) */}
          <section
            data-testid="np09-boost-activities-section"
            aria-label="可观察活动与关联工作项"
            className="space-y-2"
          >
            <h3 className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <ActivityIcon size={12} aria-hidden="true" />
              <span>
                可观察活动 ({model.relatedActivities.length}) · 关联工作项 ({model.relatedWork.length})
              </span>
            </h3>

            {model.originActivity && (
              <NativeActivityLink
                activity={model.originActivity}
                relatedWork={model.relatedWork[0] ?? null}
                pendingCount={model.relatedApprovals.length}
                onOpenWorkbench={(act) =>
                  onNavigate({ surface: 'runtime', selectedActivityId: act.id })
                }
              />
            )}

            {model.relatedWork.length > 0 && (
              <div className="space-y-1.5">
                {model.relatedWork.map((work) => (
                  <button
                    key={work.id}
                    type="button"
                    data-testid={`np09-boost-work-${work.id}`}
                    onClick={() => onNavigate({ surface: 'runtime', selectedWorkId: work.id })}
                    className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-left text-[11.5px] transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-[var(--text-primary)]">
                        {work.observedLabel ?? WORK_KIND_LABELS[work.kind]}
                      </span>
                      <span className="ml-1.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                        {work.id}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <EntityStatusBadge kind="blocking" blocking={work.blocking} compact />
                      <EntityStatusBadge kind="work" observed={work.state} compact />
                      {work.outcome && (
                        <EntityStatusBadge kind="outcome" observed={work.outcome} compact />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {model.relatedAgents.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  关联子 Agent（亲缘关系独立维护）
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {model.relatedAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() =>
                        onNavigate({ surface: 'subagents', selectedAgentId: agent.id })
                      }
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] hover:bg-[var(--bg-hover)]"
                    >
                      <Bot size={11.5} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                      <span className="font-medium text-[var(--text-primary)]">
                        {agent.role?.kind === 'known'
                          ? agent.role.value
                          : agent.label?.kind === 'known'
                            ? agent.label.value
                            : agent.id}
                      </span>
                      <EntityStatusBadge kind="lineage" lineage={agent.lineage} compact />
                      <EntityStatusBadge kind="foreground" observed={agent.foreground} compact />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {model.relatedActivities.length > 1 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {model.relatedActivities.map((act) => {
                  const selected = selectedActivityId === act.id;
                  return (
                    <button
                      key={act.id}
                      type="button"
                      onClick={() => onNavigate({ selectedActivityId: act.id })}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
                      style={{
                        backgroundColor: selected ? 'var(--bg-active)' : 'var(--bg-surface)',
                        borderColor: selected ? 'var(--border-focus)' : 'var(--border-hairline)',
                      }}
                    >
                      <span>{ACTIVITY_ORIGIN_LABELS[act.origin]}</span>
                      <EntityStatusBadge kind="activity" status={act.state} compact />
                    </button>
                  );
                })}
              </div>
            )}

            <NativeTimeline
              entries={timeline.entries}
              scopeLabel={selectedActivityId ? `Boost 活动 ${selectedActivityId}` : 'Boost 活动轨迹'}
              loading={timeline.loading}
              hasMore={timeline.hasMore}
              sourceNotProvided={timeline.sourceUnavailable}
              sourceUnavailableReason={
                timeline.sourceUnavailable
                  ? (timeline.sourceUnavailableReason ??
                    '当前连接未暴露分页活动轨迹，请返回主聊天观察原始流。')
                  : undefined
              }
              onLoadMore={timeline.loadMore}
            />
          </section>

          {/* 8. Stop / Interruption Control (Evidence-Gated) */}
          {model.stopTarget && (
            <section
              data-testid="np09-boost-stop-section"
              aria-label="Boost 停止与中断控制"
              className="space-y-1.5"
            >
              <NativeControlMenu
                target={{
                  type: model.stopTarget.targetType,
                  id: model.stopTarget.targetId,
                }}
                targetLabel={model.stopTarget.targetLabel}
                expectedRevision={model.stopTarget.expectedRevision}
                binding={projection.binding}
                capability={model.stopTarget.capability}
                onDispatchControl={onDispatchControl}
              />
              <p className="px-1 text-[10.5px] text-[var(--text-muted)]">
                {model.stopTarget.interruptionNote}
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
