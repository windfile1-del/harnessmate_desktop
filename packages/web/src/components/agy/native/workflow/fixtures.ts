import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  ActivityId,
  BindingGeneration,
  CapabilityDescriptor,
  NativeAgentId,
  NativeRuntimeProjection,
  NativeWorkflowResourcePageResponse,
  RuntimeId,
  WorkId,
  WorkflowId,
} from '../../../../lib/native-client';
import type { NativeRequestDisplayMeta } from '../requests/types';
import { makeFixtureCapabilities } from '../shared';
import type {
  DynamicResultPreviewData,
  DynamicScriptPreviewData,
} from './types';

const BASE_TS = 1_764_100_000_000;

export interface DynamicWorkflowWebFixture {
  readonly projection: NativeRuntimeProjection;
  readonly capabilities: CapabilityDescriptor[];
  readonly approvals: ApprovalRequest[];
  readonly requestMetadataByApprovalId: Record<string, NativeRequestDisplayMeta>;
  readonly scriptPreviewByWorkflowId: Record<string, DynamicScriptPreviewData>;
  readonly resultPreviewByArtifactId: Record<string, DynamicResultPreviewData>;
  readonly stepErrorByStepId: Record<string, string>;
  readonly loadWorkflowResource: (
    workflowId: WorkflowId,
    resource: string,
    pageToken?: string | null,
  ) => Promise<NativeWorkflowResourcePageResponse>;
}

function makeEvidence(offsetMs = 0) {
  return {
    sourceKind: 'replay' as const,
    freshness: 'replay' as const,
    observedAt: BASE_TS + offsetMs,
  };
}

/**
 * T13 Parallel + Serial DAG fixture (two read-only tasks in parallel Phase 1 + serial synthesis Phase 2).
 */
export function createDynamicParallelSerialFixture(
  sessionId = 'sess_np11_parallel',
): DynamicWorkflowWebFixture {
  const runtimeId = 'rt_np11_1' as RuntimeId;
  const generation = 'gen_np11_1' as BindingGeneration;
  const activityId = 'act_np11_1' as ActivityId;
  const workflowId = 'wf_dyn_t13_parallel' as WorkflowId;
  const childA = 'ag_child_lint' as NativeAgentId;
  const childB = 'ag_child_schema' as NativeAgentId;

  const ev = makeEvidence(2_000);

  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    binding: { runtimeId, sessionId, instanceId: 'agy', generation },
    asOfSeq: 9,
    status: 'attached',
    capabilitiesRevision: 3,
    leaseReasons: [],
    activities: [
      {
        id: activityId,
        turnId: 'turn_t13_1',
        origin: 'user_turn',
        state: 'finished',
        summary: 'T13 并发+串行动态工作流（只读任务对照）',
        evidence: ev,
        updatedAt: BASE_TS + 9_000,
      },
    ],
    work: [
      {
        id: 'wk_step_lint' as WorkId,
        kind: 'workflow_step',
        originActivityId: activityId,
        ownerAgentId: childA,
        workflowId,
        blocking: 'detached',
        state: { kind: 'known', value: 'finished', evidence: ev },
        outcome: { kind: 'known', value: 'succeeded', evidence: ev },
        observedLabel: 'Read-only lint audit',
        revision: 2,
      },
      {
        id: 'wk_step_schema' as WorkId,
        kind: 'workflow_step',
        originActivityId: activityId,
        ownerAgentId: childB,
        workflowId,
        blocking: 'detached',
        state: { kind: 'known', value: 'finished', evidence: ev },
        outcome: { kind: 'known', value: 'succeeded', evidence: ev },
        observedLabel: 'Read-only schema check',
        revision: 2,
      },
    ],
    agents: [
      {
        id: childA,
        role: { kind: 'known', value: 'lint-auditor', evidence: ev },
        foreground: { kind: 'known', value: 'idle', evidence: ev },
        launchWorkIds: ['wk_step_lint' as WorkId],
        lineage: 'confirmed',
        revision: 1,
      },
      {
        id: childB,
        role: { kind: 'known', value: 'schema-checker', evidence: ev },
        foreground: { kind: 'known', value: 'idle', evidence: ev },
        launchWorkIds: ['wk_step_schema' as WorkId],
        lineage: 'confirmed',
        revision: 1,
      },
    ],
    relations: [],
    workflows: [
      {
        id: workflowId,
        originActivityId: activityId,
        state: { kind: 'known', value: 'finished', evidence: ev },
        detail: {
          kind: 'dynamic',
          scriptArtifactId: 'art_script_t13_parallel',
          steps: [
            {
              id: 'step_lint_ro',
              label: '并发节点 A · 只读 Lint 检查',
              state: { kind: 'known', value: 'finished', evidence: ev },
              agentIds: [childA],
            },
            {
              id: 'step_schema_ro',
              label: '并发节点 B · 只读 Schema 校验',
              state: { kind: 'known', value: 'finished', evidence: ev },
              agentIds: [childB],
            },
            {
              id: 'step_report_ro',
              label: '串行汇总节点 · 输出结构化报告',
              state: { kind: 'known', value: 'finished', evidence: ev },
              after: ['step_lint_ro', 'step_schema_ro'],
            },
          ],
          resultArtifactIds: ['art_res_t13_summary'],
        },
        revision: 4,
      },
    ],
    requestIds: [],
    receipts: {},
  };

  return {
    projection,
    capabilities: makeFixtureCapabilities({
      'AGY-W08': {
        observe: 'available',
        control: 'unknown',
        evidenceRefs: ['T13-synthetic'],
      },
    }),
    approvals: [],
    requestMetadataByApprovalId: {},
    scriptPreviewByWorkflowId: {
      [workflowId]: {
        artifactId: 'art_script_t13_parallel',
        approvalState: 'approved',
        language: 'python',
        previewLines: [
          'with phase("parallel_checks"):',
          '  lint_res = agent("Read-only lint check")',
          '  schema_res = agent("Read-only schema check")',
          'with phase("serial_summary"):',
          '  report = aggregate(lint_res, schema_res)',
        ],
        totalLines: 5,
        truncated: false,
        nextPageToken: null,
        sourceScopeNote: '只读文本预览（不执行 Python，批准经原生 Approval Router）',
        provenance: ev,
      },
    },
    resultPreviewByArtifactId: {
      art_res_t13_summary: {
        artifactId: 'art_res_t13_summary',
        title: 'T13 结构化验证报告',
        format: 'json_object',
        totalItems: 3,
        topLevelKeys: ['lintIssues', 'schemaWarnings', 'passed'],
        previewText: JSON.stringify(
          { lintIssues: 0, schemaWarnings: 0, passed: true },
          null,
          2,
        ),
        truncated: false,
        provenance: ev,
      },
    },
    stepErrorByStepId: {},
    loadWorkflowResource: async (wfId, resource, pageToken) => {
      if (resource === 'logs') {
        const page1 = !pageToken;
        return {
          schemaVersion: 1,
          workflowId: wfId,
          resource: 'logs',
          revision: 4,
          items: page1
            ? [
                {
                  kind: 'log_entry',
                  entryId: 'log_1',
                  seq: 1,
                  level: 'info',
                  summary: '[step_lint_ro] completed read-only lint check (0 issues)',
                  truncated: false,
                  createdAt: BASE_TS + 3000,
                  evidence: ev,
                },
              ]
            : [
                {
                  kind: 'log_entry',
                  entryId: 'log_2',
                  seq: 2,
                  level: 'info',
                  summary: '[step_report_ro] aggregated parallel results cleanly',
                  truncated: false,
                  createdAt: BASE_TS + 5000,
                  evidence: ev,
                },
              ],
          nextPageToken: page1 ? '1' : null,
          hasMore: page1,
        };
      }
      return {
        schemaVersion: 1,
        workflowId: wfId,
        resource,
        revision: 4,
        items: [
          {
            kind: 'artifact_ref',
            artifactId: 'art_res_t13_summary',
            title: 'T13 结构化验证报告',
            artifactKind: 'json',
            revision: 1,
            updatedAt: BASE_TS + 5000,
            evidence: ev,
          },
        ],
        nextPageToken: null,
        hasMore: false,
      };
    },
  };
}

/**
 * Denied script, missing DAG edges, partial failure, and AGY 1.5.16 forwarded question fixture.
 */
export function createDynamicDegradedAndForwardedFixture(
  sessionId = 'sess_np11_degraded',
  mode: 'missing_edges_partial_fail' | 'script_denied' | 'forwarded_1516_question' = 'missing_edges_partial_fail',
): DynamicWorkflowWebFixture {
  const runtimeId = 'rt_np11_2' as RuntimeId;
  const generation = 'gen_np11_2' as BindingGeneration;
  const activityId = 'act_np11_2' as ActivityId;
  const workflowId = 'wf_dyn_t13_degraded' as WorkflowId;
  const ev = makeEvidence(4_000);

  if (mode === 'script_denied') {
    return {
      projection: {
        schemaVersion: 1,
        binding: { runtimeId, sessionId, instanceId: 'agy', generation },
        asOfSeq: 3,
        status: 'attached',
        capabilitiesRevision: 2,
        activities: [
          {
            id: activityId,
            turnId: 'turn_denied',
            origin: 'user_turn',
            state: 'cancelled',
            summary: '脚本执行权限被用户拒绝',
            evidence: ev,
            updatedAt: BASE_TS + 4_000,
          },
        ],
        work: [],
        agents: [],
        relations: [],
        workflows: [
          {
            id: workflowId,
            originActivityId: activityId,
            state: { kind: 'known', value: 'cancelled', evidence: ev },
            detail: {
              kind: 'dynamic',
              scriptArtifactId: 'art_script_denied',
            },
            revision: 2,
          },
        ],
        requestIds: ['appr_script_denied'],
        receipts: {
          appr_script_denied: {
            approvalId: 'appr_script_denied',
            runtimeId,
            generation,
            kind: 'permission',
            activityId,
            targetLineage: 'confirmed',
            allowedOptionIds: ['allow_once', 'reject_once'],
            receiptState: 'cancelled',
            updatedAt: BASE_TS + 4_000,
            evidence: ev,
          },
        },
      },
      capabilities: makeFixtureCapabilities(),
      approvals: [],
      requestMetadataByApprovalId: {
        appr_script_denied: {
          scope: 'confirmed_workflow',
          workflowId,
          workflowKind: 'dynamic',
          toolName: 'run_workflow script approval',
          summary: '批准执行动态工作流脚本',
          provenanceReason: 'dynamic_workflow_confirmed_scope',
        },
      },
      scriptPreviewByWorkflowId: {
        [workflowId]: {
          artifactId: 'art_script_denied',
          approvalState: 'denied',
          approvalId: 'appr_script_denied',
          language: 'python',
          previewLines: ['parallel(task_a, task_b)'],
          totalLines: 1,
          truncated: false,
          nextPageToken: null,
          rawPathRedacted: true,
          sourceScopeNote: '已屏蔽未授权脚本路径，仅展示协议核准范围内的只读文本预览（不执行 Python）',
          provenance: ev,
        },
      },
      resultPreviewByArtifactId: {},
      stepErrorByStepId: {},
      loadWorkflowResource: async (wfId, resource) => ({
        schemaVersion: 1,
        workflowId: wfId,
        resource,
        revision: 2,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'dynamic_workflow_logs_not_observed',
      }),
    };
  }

  if (mode === 'forwarded_1516_question') {
    const apprId = 'appr_1516_q1';
    return {
      projection: {
        schemaVersion: 1,
        binding: { runtimeId, sessionId, instanceId: 'agy', generation },
        asOfSeq: 5,
        status: 'attached',
        capabilitiesRevision: 2,
        activities: [
          {
            id: activityId,
            turnId: 'turn_1516',
            origin: 'user_turn',
            state: 'requires_action',
            summary: 'AGY 1.5.16 转发工作流结构化问题',
            evidence: ev,
            updatedAt: BASE_TS + 5_000,
          },
        ],
        work: [],
        agents: [],
        relations: [],
        workflows: [
          {
            id: workflowId,
            originActivityId: activityId,
            state: { kind: 'known', value: 'requires_action', evidence: ev },
            detail: {
              kind: 'dynamic',
              scriptArtifactId: 'art_script_1516',
              steps: [
                {
                  id: 'step_select_scope',
                  label: '等待确认只读范围',
                  state: { kind: 'known', value: 'requires_action', evidence: ev },
                },
              ],
            },
            revision: 2,
          },
        ],
        requestIds: [apprId],
        receipts: {
          [apprId]: {
            approvalId: apprId,
            runtimeId,
            generation,
            kind: 'question',
            activityId,
            targetLineage: 'confirmed',
            allowedOptionIds: ['opt_docs_only', 'opt_cancel'],
            allowsFreeText: false,
            receiptState: 'pending',
            updatedAt: BASE_TS + 5_000,
            evidence: ev,
          },
        },
      },
      capabilities: makeFixtureCapabilities(),
      approvals: [],
      requestMetadataByApprovalId: {
        [apprId]: {
          scope: 'confirmed_workflow',
          targetLineage: 'confirmed',
          workflowId,
          workflowKind: 'dynamic',
          workflowLabel: 'T13 AGY 1.5.16 Workflow',
          isDetached: false,
          forwardedToParentSession: true,
          provenanceReason: 'dynamic_workflow_forwarded_via_parent_session',
          toolName: 'interaction',
          summary: '选择工作流只读检查范围（1.5.16 经父会话转发）',
          questionText: '选择工作流只读检查范围（1.5.16 经父会话转发）',
          options: [
            { optionId: 'opt_docs_only', name: '仅检查 docs/', kind: 'custom', scopeWidening: false },
            { optionId: 'opt_cancel', name: '取消工作流', kind: 'reject_once', scopeWidening: false },
          ],
          canAnswer: true,
          canCancel: true,
        },
      },
      scriptPreviewByWorkflowId: {
        [workflowId]: {
          artifactId: 'art_script_1516',
          approvalState: 'approved',
          language: 'python',
          previewLines: ['scope = ask_user("Choose read-only target")'],
          totalLines: 1,
          truncated: false,
          nextPageToken: null,
          provenance: ev,
        },
      },
      resultPreviewByArtifactId: {},
      stepErrorByStepId: {},
      loadWorkflowResource: async (wfId, resource) => ({
        schemaVersion: 1,
        workflowId: wfId,
        resource,
        revision: 2,
        items: [],
        nextPageToken: null,
        hasMore: false,
      }),
    };
  }

  // `missing_edges_partial_fail`: steps without `after` edges + Step A succeeded + Step B failed
  return {
    projection: {
      schemaVersion: 1,
      binding: { runtimeId, sessionId, instanceId: 'agy', generation },
      asOfSeq: 7,
      status: 'attached',
      capabilitiesRevision: 2,
      activities: [
        {
          id: activityId,
          turnId: 'turn_partial',
          origin: 'user_turn',
          state: 'failed',
          summary: '部分节点失败，保留已产出结果',
          evidence: ev,
          updatedAt: BASE_TS + 7_000,
        },
      ],
      work: [],
      agents: [],
      relations: [],
      workflows: [
        {
          id: workflowId,
          originActivityId: activityId,
          state: { kind: 'known', value: 'failed', evidence: ev },
          detail: {
            kind: 'dynamic',
            scriptArtifactId: 'art_script_partial',
            steps: [
              {
                id: 'step_ok',
                label: '节点 A · 成功输出',
                state: { kind: 'known', value: 'finished', evidence: ev },
              },
              {
                id: 'step_fail',
                label: '节点 B · 失败退出',
                state: { kind: 'known', value: 'failed', evidence: ev },
              },
            ],
            resultArtifactIds: ['art_res_partial_a'],
          },
          revision: 3,
        },
      ],
      requestIds: [],
      receipts: {},
    },
    capabilities: makeFixtureCapabilities(),
    approvals: [],
    requestMetadataByApprovalId: {},
    scriptPreviewByWorkflowId: {},
    resultPreviewByArtifactId: {
      art_res_partial_a: {
        artifactId: 'art_res_partial_a',
        title: '节点 A 部分结果',
        format: 'json_object',
        totalItems: 1,
        topLevelKeys: ['checkedFiles'],
        previewText: JSON.stringify({ checkedFiles: 12 }, null, 2),
        truncated: false,
        provenance: ev,
      },
    },
    stepErrorByStepId: {
      step_fail: 'Step exited with code 2',
    },
    loadWorkflowResource: async (wfId, resource) => ({
      schemaVersion: 1,
      workflowId: wfId,
      resource,
      revision: 3,
      items: [],
      nextPageToken: null,
      hasMore: false,
    }),
  };
}
