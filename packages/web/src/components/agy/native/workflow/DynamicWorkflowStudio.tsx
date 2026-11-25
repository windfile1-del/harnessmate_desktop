import { Workflow } from 'lucide-react';
import { useState } from 'react';
import { defaultNativeTransport } from '../../../../lib/native-client';
import { NativeRequestQueuePanel } from '../requests/NativeRequestQueuePanel';
import { selectNativeRequestsForSession } from '../requests/selectors';
import {
  CapabilityUnavailable,
  EntityStatusBadge,
  EvidenceDetails,
  NativeControlMenu,
  toneStyle,
} from '../shared';
import { DynamicWorkflowGraphOrTimeline } from './DynamicWorkflowGraphOrTimeline';
import { DynamicWorkflowResultsAndLogs } from './DynamicWorkflowResultsAndLogs';
import { DynamicWorkflowScriptReview } from './DynamicWorkflowScriptReview';
import type {
  DynamicWorkflowResourceItemView,
  DynamicWorkflowStudioProps,
} from './types';
import {
  deriveDynamicWorkflowBanner,
  deriveScriptApprovalState,
  findDynamicWorkflowCapability,
  selectDynamicWorkflows,
} from './view-model';

/**
 * NP-11 Dynamic Workflow Studio (`surface: 'dynamic'`).
 *
 * Registers into `AgyWorkbenchRegistry` (`order: 110`) to override NP-03's built-in
 * degraded shell (`order: 900`) with zero modifications to `ChatStage`, `App.tsx`, or `app-store`.
 *
 * Guarantees:
 * - Never reads unapproved script paths or executes Python in the client.
 * - Never fabricates DAG dependency graphs when explicit `after` edges are absent.
 * - Surfaces denied scripts, partial failures, AGY 1.5.16 forwarded questions, and stale/disconnected states honestly.
 */
export function DynamicWorkflowStudio({
  session,
  projection,
  capabilities,
  pendingApprovals,
  route,
  isNarrowViewport,
  onNavigate,
  onBackToChat,
  onRefresh,
  onDispatchControl,
  loadWorkflowResource,
  requestMetadataByApprovalId,
  scriptPreviewByWorkflowId,
  resultPreviewByArtifactId,
  stepErrorByStepId,
  onResolveNativeRequest,
  onLoadMoreScriptPreview,
}: DynamicWorkflowStudioProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loadedLogs, setLoadedLogs] = useState<readonly DynamicWorkflowResourceItemView[]>([]);

  const dynamicCap = findDynamicWorkflowCapability(capabilities);

  if (!projection) {
    return (
      <div data-testid="np11-dynamic-workflow-studio" className="space-y-3">
        <CapabilityUnavailable
          title="Dynamic Workflow · 原生运行时尚未连接"
          gate="unknown"
          capabilityId="AGY-W08"
          reason="当前会话尚未接收到原生运行时快照（或 native runtime 门控处于关闭状态）。既有对话与工作区数据不受影响。"
          officialEntryHint="在官方 CLI 中运行 /run-workflow <task> 或 /tasks 查看动态工作流。"
          officialDocUrl="https://antigravity.google/docs/dynamic-workflows/"
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天"
        />
      </div>
    );
  }

  const dynamicWorkflows = selectDynamicWorkflows(projection.workflows);
  if (dynamicWorkflows.length === 0) {
    return (
      <div data-testid="np11-dynamic-workflow-studio" className="space-y-3">
        <CapabilityUnavailable
          title={`Dynamic Workflow · ${dynamicCap ? '按实时证据门控' : '尚未观察到工作流'}`}
          gate={dynamicCap?.observe ?? 'upstream_limited'}
          capabilityId="AGY-W08"
          reason="当前会话尚未观察到动态工作流（/run-workflow）运行实例；空列表不能证明远端任务已停止。"
          officialEntryHint="在官方 App/CLI 中输入 /run-workflow <task>；脚本批准与执行轨迹将经原生 ACP 流汇报。"
          officialDocUrl="https://antigravity.google/docs/dynamic-workflows/"
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天观察原始流"
        />
      </div>
    );
  }

  const selectedWorkflow =
    dynamicWorkflows.find((wf) => wf.id === route.selectedWorkflowId) ?? dynamicWorkflows[0]!;
  const detail = selectedWorkflow.detail.kind === 'dynamic' ? selectedWorkflow.detail : null;
  const bindingKey = `${projection.binding.runtimeId}:${projection.binding.generation}`;

  const workflowRequests = selectNativeRequestsForSession({
    projection,
    approvals: pendingApprovals,
    metadataByApprovalId: requestMetadataByApprovalId,
    filterWorkflowId: selectedWorkflow.id,
  });

  const scriptPreview = scriptPreviewByWorkflowId?.[selectedWorkflow.id] ?? null;
  const scriptApprovalState = deriveScriptApprovalState(
    selectedWorkflow,
    workflowRequests,
    scriptPreview?.approvalState,
  );

  const banner = deriveDynamicWorkflowBanner({
    workflow: selectedWorkflow,
    runtimeStatus: projection.status,
    workflowRequests,
    scriptApprovalState,
  });
  const bannerStyle = toneStyle(banner.tone);

  const resolveHandler =
    onResolveNativeRequest ??
    ((approvalId, req) =>
      defaultNativeTransport.resolveNativeRequest(session.id, approvalId, req));

  return (
    <div
      data-testid="np11-dynamic-workflow-studio"
      data-narrow={isNarrowViewport ? 'true' : 'false'}
      className="space-y-3.5"
    >
      {/* Workflow switcher when multiple dynamic workflow runs exist in this binding */}
      {dynamicWorkflows.length > 1 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="切换动态工作流实例"
        >
          {dynamicWorkflows.map((wf) => {
            const active = wf.id === selectedWorkflow.id;
            return (
              <button
                key={wf.id}
                type="button"
                data-testid={`np11-wf-tab-${wf.id}`}
                aria-pressed={active}
                onClick={() => {
                  setSelectedStepId(null);
                  onNavigate({ selectedWorkflowId: wf.id });
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px]"
                style={{
                  backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-surface)',
                  borderColor: active ? 'var(--border-focus)' : 'var(--border-hairline)',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <Workflow size={11.5} aria-hidden="true" />
                <span className="font-mono-code">{wf.id}</span>
                <EntityStatusBadge kind="work" observed={wf.state} compact />
              </button>
            );
          })}
        </div>
      )}

      {/* Top Honest Lifecycle Banner */}
      <section
        data-testid="np11-workflow-banner"
        data-phase={banner.phase}
        aria-label="动态工作流状态摘要"
        className="space-y-2 rounded-2xl border p-3 text-[12px]"
        style={bannerStyle}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Workflow size={15} aria-hidden="true" />
            <h2 className="text-[13px] font-semibold">{banner.headline}</h2>
            <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
              {selectedWorkflow.id}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <EntityStatusBadge kind="runtime" status={projection.status} compact />
            <EntityStatusBadge kind="work" observed={selectedWorkflow.state} compact />
          </div>
        </div>
        <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
          {banner.detail}
        </p>
      </section>

      {/* Workflow-scoped Pending Approvals & AGY 1.5.16 Forwarded Questions */}
      {workflowRequests.length > 0 && (
        <NativeRequestQueuePanel
          title="工作流脚本批准与 1.5.16 问题转发"
          projection={projection}
          approvals={pendingApprovals}
          metadataByApprovalId={requestMetadataByApprovalId}
          filterWorkflowId={selectedWorkflow.id}
          onResolveNative={resolveHandler}
          onJumpToAgent={(agentId) =>
            onNavigate({ surface: 'subagents', selectedAgentId: agentId })
          }
          onJumpToActivity={(activityId) =>
            onNavigate({ surface: 'runtime', selectedActivityId: activityId })
          }
        />
      )}

      {/* Read-Only Script Review Panel */}
      <DynamicWorkflowScriptReview
        workflowId={selectedWorkflow.id}
        scriptArtifactId={detail?.scriptArtifactId}
        approvalState={scriptApprovalState}
        preview={scriptPreview}
        onLoadMorePreview={onLoadMoreScriptPreview}
      />

      {/* Verified DAG Layers OR Honest Sortable Timeline Fallback */}
      <DynamicWorkflowGraphOrTimeline
        workflow={selectedWorkflow}
        works={projection.work}
        requests={workflowRequests}
        logItems={loadedLogs}
        selectedStepId={selectedStepId}
        stepErrorByStepId={stepErrorByStepId}
        onSelectStep={setSelectedStepId}
        onJumpToAgent={(agentId) =>
          onNavigate({ surface: 'subagents', selectedAgentId: agentId })
        }
      />

      {/* Paginated Results, Structured Outputs, and Logs */}
      <DynamicWorkflowResultsAndLogs
        workflow={selectedWorkflow}
        bindingKey={bindingKey}
        resultPreviewByArtifactId={resultPreviewByArtifactId}
        loadWorkflowResource={loadWorkflowResource}
        onLogsLoaded={setLoadedLogs}
      />

      {/* Capability-Gated Native Control Bar + Provenance */}
      <NativeControlMenu
        target={{ type: 'workflow', id: selectedWorkflow.id }}
        targetLabel={selectedWorkflow.id}
        expectedRevision={selectedWorkflow.revision}
        binding={projection.binding}
        capability={dynamicCap ?? null}
        onDispatchControl={onDispatchControl}
      />

      <EvidenceDetails
        evidence={
          selectedWorkflow.state.kind === 'known'
            ? selectedWorkflow.state.evidence
            : selectedWorkflow.state.kind === 'stale'
              ? selectedWorkflow.state.evidence
              : null
        }
        reasonCode={
          selectedWorkflow.state.kind !== 'known' ? selectedWorkflow.state.reasonCode : undefined
        }
        evidenceRefs={dynamicCap?.evidenceRefs}
        label={`动态工作流 ${selectedWorkflow.id} 观测证据`}
      />
    </div>
  );
}
