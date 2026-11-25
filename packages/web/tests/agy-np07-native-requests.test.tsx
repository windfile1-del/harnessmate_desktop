import type { ApprovalRequest } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ActivityId,
  BindingGeneration,
  NativeAgentId,
  NativeRuntimeProjection,
  RuntimeId,
  WorkflowId,
} from '../src/lib/native-client';
import {
  NativeElicitationForm,
  NativeRequestDetailCard,
  NativeRequestQueuePanel,
  buildCancelledPayload,
  buildFormSubmittedPayload,
  buildSelectedOptionPayload,
  selectHistoricalNativeRequestReceipts,
  selectNativeRequestsForSession,
  selectPendingNativeRequests,
  validateElicitationDraft,
  type NativeElicitationFormSpecView,
  type NativeRequestDisplayMeta,
} from '../src/components/agy/native/requests';

const RUNTIME_ID = 'nrt_np07_ui' as RuntimeId;
const GEN_CUR = 'gen_cur' as BindingGeneration;
const GEN_OLD = 'gen_old' as BindingGeneration;
const CHILD_AGENT = 'agt_child_1' as NativeAgentId;
const ACT_CHILD = 'act_child_1' as ActivityId;
const ACT_DETACHED = 'act_bg_1' as ActivityId;
const WF_ID = 'wf_dyn_1' as WorkflowId;

function makeProjection(overrides?: Partial<NativeRuntimeProjection>): NativeRuntimeProjection {
  return {
    schemaVersion: 1,
    enabled: true,
    binding: {
      runtimeId: RUNTIME_ID,
      sessionId: 'sess_np07_ui',
      instanceId: 'agy',
      generation: GEN_CUR,
    },
    asOfSeq: 5,
    status: 'attached',
    capabilitiesRevision: 1,
    activities: [
      {
        id: ACT_CHILD,
        turnId: null,
        origin: 'native_task',
        agentId: CHILD_AGENT,
        state: 'requires_action',
        summary: 'Security Reviewer child step',
        updatedAt: 2_000,
      },
      {
        id: ACT_DETACHED,
        turnId: null,
        origin: 'native_continuation',
        state: 'requires_action',
        summary: 'Background verification step',
        updatedAt: 2_000,
      },
    ],
    work: [],
    agents: [
      {
        id: CHILD_AGENT,
        label: {
          kind: 'known',
          value: 'Security Reviewer',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 1_500 },
        },
        foreground: {
          kind: 'known',
          value: 'requires_action',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 1_500 },
        },
        launchWorkIds: [],
        lineage: 'confirmed',
        revision: 1,
      },
    ],
    relations: [],
    workflows: [
      {
        id: WF_ID,
        originActivityId: ACT_DETACHED,
        state: {
          kind: 'known',
          value: 'requires_action',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 1_500 },
        },
        detail: { kind: 'dynamic' },
        revision: 1,
      },
    ],
    requestIds: ['appr_child_1', 'appr_unknown_2', 'appr_elicit_3'],
    receipts: {
      appr_child_1: {
        approvalId: 'appr_child_1',
        runtimeId: RUNTIME_ID,
        generation: GEN_CUR,
        kind: 'permission',
        agentId: CHILD_AGENT,
        activityId: ACT_CHILD,
        targetLineage: 'confirmed',
        allowedOptionIds: ['allow_once', 'reject_once'],
        allowsFreeText: false,
        receiptState: 'pending',
        receiptId: 'nrcpt_1',
        evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 2_000 },
        updatedAt: 2_000,
      },
      appr_unknown_2: {
        approvalId: 'appr_unknown_2',
        runtimeId: RUNTIME_ID,
        generation: GEN_CUR,
        kind: 'permission',
        targetLineage: 'unconfirmed',
        allowedOptionIds: ['reject_once'],
        allowsFreeText: false,
        receiptState: 'pending',
        receiptId: 'nrcpt_2',
        updatedAt: 1_900,
      },
      appr_elicit_3: {
        approvalId: 'appr_elicit_3',
        runtimeId: RUNTIME_ID,
        generation: GEN_CUR,
        kind: 'elicitation',
        activityId: ACT_DETACHED,
        targetLineage: 'confirmed',
        allowedOptionIds: ['decline'],
        allowsFreeText: true,
        receiptState: 'pending',
        receiptId: 'nrcpt_3',
        updatedAt: 1_800,
      },
      appr_hist_lost: {
        approvalId: 'appr_hist_lost',
        runtimeId: RUNTIME_ID,
        generation: GEN_OLD,
        kind: 'permission',
        targetLineage: 'confirmed',
        allowedOptionIds: ['allow_once'],
        receiptState: 'connection_lost',
        receiptId: 'nrcpt_old',
        updatedAt: 1_000,
      },
    },
    ...overrides,
  };
}

const sampleFormSpec: NativeElicitationFormSpecView = {
  message: 'Configure deployment release',
  mode: 'form',
  requiredFields: ['env', 'retries'],
  additionalProperties: false,
  supported: true,
  fields: [
    {
      name: 'env',
      type: 'string',
      title: 'Target Environment',
      required: true,
      enum: ['staging', 'prod'],
      enumNames: ['Staging', 'Production'],
    },
    {
      name: 'retries',
      type: 'integer',
      title: 'Max Retries',
      required: true,
      minimum: 1,
      maximum: 5,
    },
    {
      name: 'notifyEmail',
      type: 'string',
      title: 'Notify Email',
      required: false,
      format: 'email',
    },
    {
      name: 'dryRun',
      type: 'boolean',
      title: 'Dry Run',
      required: false,
      defaultValue: false,
    },
  ],
};

describe('NP-07 Web Selectors, Elicitation Form & Native Request Components', () => {
  it('projects pending & historical items cleanly, fences stale generation, and validates elicitation drafts', () => {
    const projection = makeProjection();
    const metadataByApprovalId: Record<string, NativeRequestDisplayMeta> = {
      appr_child_1: {
        scope: 'confirmed_child',
        targetLineage: 'confirmed',
        agentLabel: 'Security Reviewer',
        isDetached: true,
        forwardedToParentSession: true,
        toolName: 'git push --force',
        summary: 'git push --force origin main',
        riskLevel: 'critical',
        securityWarnings: ['Force push overwrites remote commits'],
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once', scopeWidening: false },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once', scopeWidening: false },
        ],
      },
      appr_unknown_2: {
        scope: 'unknown_child',
        targetLineage: 'unresolved',
        toolName: 'shell',
        summary: 'Mystery child command',
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once', scopeWidening: false },
          { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always', scopeWidening: true },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once', scopeWidening: false },
        ],
      },
      appr_elicit_3: {
        scope: 'confirmed_workflow',
        targetLineage: 'confirmed',
        workflowId: WF_ID,
        workflowKind: 'dynamic',
        workflowLabel: 'Release Workflow',
        formSpec: sampleFormSpec,
      },
    };

    const pending = selectPendingNativeRequests({ projection, metadataByApprovalId });
    const history = selectHistoricalNativeRequestReceipts({ projection, metadataByApprovalId });
    expect(pending.map((p) => p.approvalId)).toEqual(['appr_child_1', 'appr_unknown_2', 'appr_elicit_3']);
    expect(history.map((h) => h.approvalId)).toEqual(['appr_hist_lost']);

    const childItem = pending[0]!;
    expect(childItem.isActionable).toBe(true);
    expect(childItem.canAnswer).toBe(true);
    expect(childItem.isDetached).toBe(true);
    expect(childItem.forwardedToParentSession).toBe(true);
    expect(childItem.riskLevel).toBe('critical');

    const unknownItem = pending[1]!;
    expect(unknownItem.scope).toBe('unknown_child');
    expect(unknownItem.canAnswer).toBe(false);
    expect(unknownItem.canCancel).toBe(true);
    expect(unknownItem.allowedOptionIds).toEqual(['reject_once']);

    const histItem = history[0]!;
    expect(histItem.isGenerationCurrent).toBe(false);
    expect(histItem.isActionable).toBe(false);

    // Client-side elicitation validation mirrors backend constraints
    const invalidErrors = validateElicitationDraft(sampleFormSpec, {
      env: '',
      retries: 9,
      notifyEmail: 'bad-email',
    });
    expect(Object.keys(invalidErrors)).toEqual(['env', 'retries', 'notifyEmail']);

    const okErrors = validateElicitationDraft(sampleFormSpec, {
      env: 'staging',
      retries: 3,
      notifyEmail: 'ops@example.com',
      dryRun: true,
    });
    expect(okErrors).toEqual({});

    // Payload builders enforce ResolveNativeRequestInput contract
    expect(buildSelectedOptionPayload(GEN_CUR, 'allow_once')).toEqual({
      generation: GEN_CUR,
      outcome: 'selected',
      optionId: 'allow_once',
    });
    expect(buildCancelledPayload(GEN_CUR, 'stop')).toEqual({
      generation: GEN_CUR,
      outcome: 'cancelled',
      comment: 'stop',
    });
    expect(buildFormSubmittedPayload(GEN_CUR, { env: 'staging', retries: 2 })).toEqual({
      generation: GEN_CUR,
      outcome: 'form_submitted',
      formPayload: { env: 'staging', retries: 2 },
    });
  });

  it('renders confirmed child, security warning, critical double-confirm, unknown child block, fixed-option question, unsupported form, and reconnect-invalidated receipts', () => {
    const projection = makeProjection();
    const metadataByApprovalId: Record<string, NativeRequestDisplayMeta> = {
      appr_child_1: {
        scope: 'confirmed_child',
        targetLineage: 'confirmed',
        agentLabel: 'Security Reviewer',
        isDetached: true,
        forwardedToParentSession: true,
        toolName: 'git push --force',
        summary: 'git push --force origin main',
        riskLevel: 'critical',
        securityWarnings: ['Force push overwrites remote commits'],
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once', scopeWidening: false },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once', scopeWidening: false },
        ],
      },
      appr_unknown_2: {
        scope: 'unknown_child',
        targetLineage: 'unresolved',
        toolName: 'shell',
        summary: 'Mystery child command',
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once', scopeWidening: false },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once', scopeWidening: false },
        ],
      },
      appr_elicit_3: {
        scope: 'confirmed_workflow',
        targetLineage: 'confirmed',
        workflowId: WF_ID,
        workflowKind: 'dynamic',
        workflowLabel: 'Release Workflow',
        formSpec: sampleFormSpec,
      },
    };

    const html = renderToStaticMarkup(
      <NativeRequestQueuePanel
        projection={projection}
        metadataByApprovalId={metadataByApprovalId}
        onResolveNative={async () => ({ receiptState: 'response_written' })}
        onJumpToAgent={() => {}}
        onJumpToWorkflow={() => {}}
        onJumpToActivity={() => {}}
      />,
    );

    // Pending badge, confirmed child, detached indicator, forwarded badge, security warning, critical checkbox
    expect(html).toContain('3 项待处理');
    expect(html).toContain('子 Agent: Security Reviewer');
    expect(html).toContain('查看子 Agent');
    expect(html).toContain('脱离原轮次');
    expect(html).toContain('经父会话转发');
    expect(html).toContain('原生安全说明：Force push overwrites remote commits');
    expect(html).toContain('高危操作禁止单键误触');

    // Unknown child banner + hidden/restricted allow option notice
    expect(html).toContain('路由无法确证子 Agent 归属，已禁止放行/扩大授权');
    expect(html).toContain('已受限隐藏选项：Allow once (allow_once)');

    // Confirmed workflow + elicitation form fields
    expect(html).toContain('工作流: Release Workflow');
    expect(html).toContain('查看工作流');
    expect(html).toContain('Target Environment');
    expect(html).toContain('Max Retries');
    expect(html).toContain('提交表单');

    // Historical connection_lost receipt renders read-only notice without replay buttons
    expect(html).toContain('原连接已断开或运行代次已切换，旧授权已失效且不会在重连后重放');

    // Fixed-option question card renders radio native IDs and NO text input
    const qProjection = makeProjection({
      requestIds: ['appr_q_fixed', 'appr_q_zero'],
      receipts: {
        appr_q_fixed: {
          approvalId: 'appr_q_fixed',
          runtimeId: RUNTIME_ID,
          generation: GEN_CUR,
          kind: 'question',
          targetLineage: 'confirmed',
          allowedOptionIds: ['staging', 'production'],
          allowsFreeText: false,
          receiptState: 'pending',
          updatedAt: 3_000,
        },
        appr_q_zero: {
          approvalId: 'appr_q_zero',
          runtimeId: RUNTIME_ID,
          generation: GEN_CUR,
          kind: 'question',
          targetLineage: 'confirmed',
          allowedOptionIds: [],
          allowsFreeText: false,
          receiptState: 'pending',
          updatedAt: 2_900,
        },
      },
    });
    const approvals: ApprovalRequest[] = [
      {
        id: 'appr_q_fixed',
        sessionId: 'sess_np07_ui',
        nativeRequestId: 'nat_q_1',
        kind: 'user_question',
        toolName: 'interaction',
        toolKind: 'other',
        summary: 'Which environment?',
        input: {},
        riskLevel: 'low',
        questionSpec: {
          question: 'Which environment?',
          selectionMode: 'single',
          allowFreeText: false,
          options: [
            { id: 'staging', label: 'Staging' },
            { id: 'production', label: 'Production' },
          ],
        },
        status: 'pending',
        createdAt: 3_000,
      },
    ];
    const qItems = selectNativeRequestsForSession({
      projection: qProjection,
      approvals,
    });
    const fixedQHtml = renderToStaticMarkup(
      <NativeRequestDetailCard
        item={qItems.find((i) => i.approvalId === 'appr_q_fixed')!}
        onResolveNative={async () => ({ receiptState: 'response_written' })}
      />,
    );
    expect(fixedQHtml).toContain('id: staging');
    expect(fixedQHtml).toContain('id: production');
    expect(fixedQHtml).not.toContain('type="text"');

    const zeroQHtml = renderToStaticMarkup(
      <NativeRequestDetailCard
        item={qItems.find((i) => i.approvalId === 'appr_q_zero')!}
        onResolveNative={async () => ({ receiptState: 'cancelled' })}
      />,
    );
    expect(zeroQHtml).toContain('禁止以自由文本代填或隐式映射首个选项');
    expect(zeroQHtml).not.toContain('提交原生选择');

    // Unsupported elicitation form renders honest cancel-only notice
    const unsupFormHtml = renderToStaticMarkup(
      <NativeElicitationForm
        approvalId="appr_unsup"
        formSpec={{
          message: 'Nested object form',
          mode: 'form',
          fields: [],
          requiredFields: [],
          additionalProperties: false,
          supported: false,
          unsupportedReason: 'unsupported_elicitation_field:nested:object',
        }}
        canAnswer={false}
        canCancel={true}
        submitting={false}
        onSubmitForm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(unsupFormHtml).toContain('当前原生表单无法在协议中编码提交');
    expect(unsupFormHtml).toContain('unsupported_elicitation_field:nested:object');
    expect(unsupFormHtml).toContain('取消请求');

    // Disconnected / reconciling runtime shows reconnect notice and disables actions
    const reconcilingHtml = renderToStaticMarkup(
      <NativeRequestQueuePanel
        projection={makeProjection({ status: 'reconciling' })}
        metadataByApprovalId={metadataByApprovalId}
        onResolveNative={async () => ({ receiptState: 'connection_lost' })}
      />,
    );
    expect(reconcilingHtml).toContain('原生运行时正在重连校准，旧连接上的审批已失效且不会重放');
    expect(reconcilingHtml).toContain('data-actionable="false"');

    // Scoped filtering by agentId / workflowId & read-only receipt states (response_written, expired, delivery_unknown)
    const scopedAgentItems = selectNativeRequestsForSession({
      projection,
      metadataByApprovalId,
      filterAgentId: CHILD_AGENT,
    });
    expect(scopedAgentItems.map((i) => i.approvalId)).toEqual(['appr_child_1']);

    const scopedWorkflowItems = selectNativeRequestsForSession({
      projection,
      metadataByApprovalId,
      filterWorkflowId: WF_ID,
    });
    expect(scopedWorkflowItems.map((i) => i.approvalId)).toEqual(['appr_elicit_3']);

    const terminalProjection = makeProjection({
      requestIds: [],
      receipts: {
        appr_written: {
          approvalId: 'appr_written',
          runtimeId: RUNTIME_ID,
          generation: GEN_CUR,
          kind: 'permission',
          targetLineage: 'confirmed',
          allowedOptionIds: ['allow_once'],
          receiptState: 'response_written',
          receiptId: 'nrcpt_w',
          updatedAt: 5_000,
        },
        appr_expired: {
          approvalId: 'appr_expired',
          runtimeId: RUNTIME_ID,
          generation: GEN_CUR,
          kind: 'permission',
          targetLineage: 'confirmed',
          allowedOptionIds: ['allow_once'],
          receiptState: 'expired',
          receiptId: 'nrcpt_e',
          updatedAt: 4_000,
        },
        appr_unknown: {
          approvalId: 'appr_unknown',
          runtimeId: RUNTIME_ID,
          generation: GEN_CUR,
          kind: 'permission',
          targetLineage: 'confirmed',
          allowedOptionIds: ['allow_once'],
          receiptState: 'delivery_unknown',
          receiptId: 'nrcpt_u',
          updatedAt: 3_000,
        },
      },
    });
    const terminalHtml = renderToStaticMarkup(
      <NativeRequestQueuePanel projection={terminalProjection} />,
    );
    expect(terminalHtml).toContain('响应已写入原连接，等待原生后续帧确认实际执行结果');
    expect(terminalHtml).toContain('请求已超出限时自动失效，已向原连接回复取消且不可重放');
    expect(terminalHtml).toContain('写出响应期间发生异常或断连，送达结果不确定，严禁自动重放旧授权');
  });
});
