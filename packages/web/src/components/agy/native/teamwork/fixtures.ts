import type { ApprovalRequest, Session } from '@harnessmate/protocol';
import type {
  ActivityId,
  BindingGeneration,
  CapabilityDescriptor,
  NativeAgentId,
  NativeRuntimeProjection,
  RuntimeId,
  WorkflowId,
} from '../../../../lib/native-client';
import type {
  TeamworkArtifactItemView,
  TeamworkAuditEntryView,
  TeamworkProjectScopeView,
  TeamworkScopingItemView,
} from './types';

const RUNTIME_ID = 'nrt_teamwork_ui_1' as RuntimeId;
const GEN_CUR = 'gen_tw_1' as BindingGeneration;
const WF_ID = 'wf_teamwork_ui_1' as WorkflowId;
const ACT_ORIGIN = 'act_tw_origin_1' as ActivityId;
const ACT_SCOPING = 'act_tw_scoping_1' as ActivityId;
const AGT_SENTINEL = 'agt_tw_sentinel_1' as NativeAgentId;
const AGT_ORCHESTRATOR = 'agt_tw_orchestrator_1' as NativeAgentId;
const AGT_AUDITOR = 'agt_tw_auditor_1' as NativeAgentId;
const AGT_UNCONFIRMED = 'agt_tw_candidate_1' as NativeAgentId;

export function createTeamworkSessionFixture(): Session {
  return {
    id: 'sess_teamwork_ui_1',
    workspaceId: 'ws_hm_desktop',
    harnessKind: 'agy',
    harnessId: 'agy',
    title: 'Teamwork Migration Session',
    status: 'idle',
    permissionMode: 'manual',
    createdAt: 1000,
    updatedAt: 2000,
  } as Session;
}

export function createTeamworkCapabilitiesFixture(
  overrides?: Partial<CapabilityDescriptor>,
): CapabilityDescriptor[] {
  return [
    {
      id: 'AGY-W07',
      snapshotRevision: 2,
      surfaces: ['desktop', 'cli', 'acp'],
      tierHint: 'Pro/Ultra',
      versionNote: 'Only /teamwork is tracked; legacy /teamwork-preview is unverified',
      advertised: true,
      launch: 'not_tested',
      observe: 'upstream_limited',
      control: 'upstream_limited',
      localRead: 'not_tested',
      actions: [
        {
          key: 'launch_teamwork',
          lane: 'live_workflow',
          gate: 'not_tested',
          label: '发起 Teamwork (/teamwork)',
        },
      ],
      evidenceRefs: ['E01', 'T12-synthetic'],
      verifiedLevel: null,
      ...overrides,
    },
  ];
}

export function createTeamworkPromptReviewDegradedFixture(): {
  projection: NativeRuntimeProjection;
  pendingApprovals: ApprovalRequest[];
  scopingItems: TeamworkScopingItemView[];
} {
  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    enabled: true,
    binding: {
      runtimeId: RUNTIME_ID,
      sessionId: 'sess_teamwork_ui_1',
      instanceId: 'agy',
      generation: GEN_CUR,
    },
    asOfSeq: 8,
    status: 'attached',
    capabilitiesRevision: 2,
    activities: [
      {
        id: ACT_SCOPING,
        turnId: null,
        origin: 'native_task',
        state: 'requires_action',
        summary: 'Teamwork scoping & Prompt Artifact review',
        updatedAt: 20_050,
      },
    ],
    work: [],
    agents: [],
    relations: [],
    workflows: [
      {
        id: WF_ID,
        originActivityId: ACT_ORIGIN,
        state: {
          kind: 'known',
          value: 'requires_action',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_050 },
        },
        detail: {
          kind: 'teamwork',
          scopingActivityId: ACT_SCOPING,
          promptArtifactId: 'art_tw_prompt_v1',
        },
        revision: 3,
      },
    ],
    requestIds: ['appr_tw_q1'],
    receipts: {
      appr_tw_q1: {
        approvalId: 'appr_tw_q1',
        runtimeId: RUNTIME_ID,
        generation: GEN_CUR,
        kind: 'question',
        activityId: ACT_SCOPING,
        targetLineage: 'confirmed',
        allowedOptionIds: ['opt_win', 'opt_linux'],
        receiptState: 'response_written',
        receiptId: 'nrcpt_tw_q1',
        evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_030 },
        updatedAt: 20_030,
      },
    },
  };

  return {
    projection,
    pendingApprovals: [],
    scopingItems: [
      {
        questionId: 'tw_q_1',
        approvalId: 'appr_tw_q1',
        promptSummary: 'Target deployment platform for Teamwork project?',
        receiptState: 'response_written',
        selectedOptionLabel: 'Windows Desktop',
        occurrence: 1,
        duplicateDeliveriesIgnored: 1,
      },
    ],
  };
}

export function createTeamworkRejectedFixture(): NativeRuntimeProjection {
  return {
    schemaVersion: 1,
    enabled: true,
    binding: {
      runtimeId: RUNTIME_ID,
      sessionId: 'sess_teamwork_ui_1',
      instanceId: 'agy',
      generation: GEN_CUR,
    },
    asOfSeq: 10,
    status: 'attached',
    capabilitiesRevision: 2,
    activities: [],
    work: [],
    agents: [],
    relations: [],
    workflows: [
      {
        id: WF_ID,
        originActivityId: ACT_ORIGIN,
        state: {
          kind: 'known',
          value: 'cancelled',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_100 },
        },
        detail: {
          kind: 'teamwork',
          scopingActivityId: ACT_SCOPING,
          promptArtifactId: 'art_tw_prompt_rejected',
        },
        revision: 4,
      },
    ],
    requestIds: [],
    receipts: {},
  };
}

export function createTeamworkApprovedMilestone1Fixture(): {
  projection: NativeRuntimeProjection;
  projectScope: TeamworkProjectScopeView;
  auditEntries: TeamworkAuditEntryView[];
  artifacts: TeamworkArtifactItemView[];
} {
  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    enabled: true,
    binding: {
      runtimeId: RUNTIME_ID,
      sessionId: 'sess_teamwork_ui_1',
      instanceId: 'agy',
      generation: GEN_CUR,
    },
    asOfSeq: 18,
    status: 'attached',
    capabilitiesRevision: 2,
    activities: [
      {
        id: ACT_SCOPING,
        turnId: null,
        origin: 'native_task',
        state: 'finished',
        summary: 'Scoping completed',
        updatedAt: 20_040,
      },
    ],
    work: [],
    agents: [
      {
        id: AGT_SENTINEL,
        role: {
          kind: 'known',
          value: 'Sentinel',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_100 },
        },
        label: {
          kind: 'known',
          value: 'Sentinel · Policy Guard',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_100 },
        },
        foreground: {
          kind: 'known',
          value: 'running',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_100 },
        },
        launchWorkIds: [],
        lineage: 'confirmed',
        revision: 1,
      },
      {
        id: AGT_ORCHESTRATOR,
        role: {
          kind: 'known',
          value: 'Project Orchestrator',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_110 },
        },
        label: {
          kind: 'known',
          value: 'Project Orchestrator',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_110 },
        },
        foreground: {
          kind: 'known',
          value: 'running',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_110 },
        },
        launchWorkIds: [],
        lineage: 'confirmed',
        revision: 1,
      },
      {
        id: AGT_AUDITOR,
        role: {
          kind: 'known',
          value: 'Auditor',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_120 },
        },
        label: {
          kind: 'known',
          value: 'Milestone 1 Auditor',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_120 },
        },
        foreground: {
          kind: 'known',
          value: 'idle',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_120 },
        },
        launchWorkIds: [],
        lineage: 'confirmed',
        revision: 1,
      },
      {
        id: AGT_UNCONFIRMED,
        role: {
          kind: 'known',
          value: 'Worker',
          evidence: { sourceKind: 'host_observation', freshness: 'host', observedAt: 20_125 },
        },
        label: {
          kind: 'known',
          value: 'Unverified Launch Candidate',
          evidence: { sourceKind: 'host_observation', freshness: 'host', observedAt: 20_125 },
        },
        foreground: {
          kind: 'unknown',
          reasonCode: 'child_identity_unresolved',
        },
        launchWorkIds: [],
        lineage: 'unresolved',
        revision: 1,
      },
    ],
    relations: [],
    workflows: [
      {
        id: WF_ID,
        originActivityId: ACT_ORIGIN,
        state: {
          kind: 'known',
          value: 'running',
          evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_150 },
        },
        detail: {
          kind: 'teamwork',
          scopingActivityId: ACT_SCOPING,
          promptArtifactId: 'art_tw_prompt_approved',
          projectLabel: 'payments-migration-v2',
          milestones: [
            {
              id: 'ms_1',
              label: 'Milestone 1 · Ledger Schema & Adapter',
              state: {
                kind: 'known',
                value: 'running',
                evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 20_150 },
              },
              agentIds: [AGT_ORCHESTRATOR, AGT_AUDITOR],
            },
          ],
        },
        revision: 6,
      },
    ],
    requestIds: [],
    receipts: {},
  };

  return {
    projection,
    projectScope: {
      hmWorkspaceLabel: 'harnessmate_desktop',
      hmWorkspaceId: 'ws_hm_desktop',
      nativeProjectCreated: true,
      nativeProjectLabel: 'payments-migration-v2',
      nativeProjectScopeId: 'tw_proj_payments',
      scopeRelationship: 'distinct_from_hm_workspace',
      pathAccessGate: 'requires_explicit_authorization',
      pathOpenAuthorized: false,
      authorizationReasonCode: 'native_project_outside_authorized_roots',
    },
    auditEntries: [
      {
        auditId: 'aud_ms1_1',
        milestoneId: 'ms_1',
        label: 'Milestone 1 Security & Spec Audit',
        verdict: 'passed',
        auditorAgentId: AGT_AUDITOR,
        artifactId: 'art_ms1_audit_report',
        summary: 'All schema invariants verified.',
      },
    ],
    artifacts: [
      {
        artifactId: 'art_tw_prompt_approved',
        title: 'Payments Migration Prompt Artifact',
        artifactKind: 'markdown',
        isPromptArtifact: true,
        revision: 1,
        updatedAt: 20_050,
      },
      {
        artifactId: 'art_ms1_audit_report',
        title: 'Milestone 1 Audit Report',
        artifactKind: 'markdown',
        ownerAgentId: AGT_AUDITOR,
        revision: 1,
        updatedAt: 20_140,
      },
    ],
  };
}

export function createTeamworkDisconnectedStaleFixture(): NativeRuntimeProjection {
  const { projection } = createTeamworkApprovedMilestone1Fixture();
  return {
    ...projection,
    status: 'disconnected',
    workflows: projection.workflows.map((wf) => ({
      ...wf,
      state: {
        kind: 'stale',
        last: 'running',
        reasonCode: 'transport_disconnected',
      },
    })),
  };
}
