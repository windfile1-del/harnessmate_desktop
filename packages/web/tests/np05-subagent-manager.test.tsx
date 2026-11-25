import type { ApprovalRequest, Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ChildTimelinePanel,
  SubagentManagerView,
  buildAgentBreadcrumbs,
  buildSubagentTreeProjection,
  registerSubagentManagerView,
  resolveSafeChildControlCapability,
} from '../src/components/agy/native/child';
import {
  AgyWorkbenchRegistry,
  DEFAULT_WORKBENCH_ROUTE,
  makeFixtureCapabilities,
  registerDefaultWorkbenchViews,
  type NativeWorkbenchViewProps,
} from '../src/components/agy/native/shared';
import type {
  AgentIdentity,
  BindingGeneration,
  NativeAgentId,
  NativeRuntimeProjection,
  RuntimeId,
  WorkId,
} from '../src/lib/native-client';

const baseSession: Session = {
  id: 'sess_np05_web',
  workspaceId: 'ws_1',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'NP-05 Subagent Manager UI Test',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 1,
  usage: null,
  pendingApprovalCount: 1,
  createdAt: 1000,
  updatedAt: 2000,
};

function createRichChildProjection(): {
  projection: NativeRuntimeProjection;
  approvals: ApprovalRequest[];
  ids: {
    root: NativeAgentId;
    childLive: NativeAgentId;
    childSameRole: NativeAgentId;
    grandchild: NativeAgentId;
    snapshotChild: NativeAgentId;
    unresolvedChild: NativeAgentId;
    conflictingChild: NativeAgentId;
  };
} {
  const now = 1_764_000_000_000;
  const runtimeId = 'nrt_np05_web' as RuntimeId;
  const generation = 'gen_np05_1' as BindingGeneration;
  const root = 'agt_root_01' as NativeAgentId;
  const childLive = 'agt_child_live_a' as NativeAgentId;
  const childSameRole = 'agt_child_live_b' as NativeAgentId;
  const grandchild = 'agt_grandchild_a1' as NativeAgentId;
  const snapshotChild = 'agt_child_snap_01' as NativeAgentId;
  const unresolvedChild = 'agt_child_unresolved_01' as NativeAgentId;
  const conflictingChild = 'agt_child_conflict_01' as NativeAgentId;
  const workConfirmed = 'wrk_batch_confirmed' as WorkId;
  const workUnresolved = 'wrk_batch_unresolved' as WorkId;

  const liveEvidence = {
    sourceKind: 'live_protocol' as const,
    freshness: 'live' as const,
    observedAt: now,
  };
  const snapEvidence = {
    sourceKind: 'native_snapshot' as const,
    freshness: 'snapshot' as const,
    observedAt: now,
  };

  const agents: AgentIdentity[] = [
    {
      id: root,
      role: { kind: 'known', value: 'primary', evidence: liveEvidence },
      label: { kind: 'known', value: '主 Agent', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'idle', evidence: liveEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 1,
    },
    {
      id: childLive,
      role: { kind: 'known', value: 'Codebase Researcher', evidence: liveEvidence },
      label: { kind: 'known', value: 'Codebase Researcher', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'running', evidence: liveEvidence },
      status: { kind: 'known', value: 'running', evidence: liveEvidence },
      launchWorkIds: [workConfirmed],
      lineage: 'confirmed',
      revision: 3,
    },
    {
      id: childSameRole,
      role: { kind: 'known', value: 'Codebase Researcher', evidence: liveEvidence },
      label: { kind: 'known', value: 'Codebase Researcher', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'idle', evidence: liveEvidence },
      status: { kind: 'known', value: 'waiting', evidence: liveEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 2,
    },
    {
      id: grandchild,
      role: { kind: 'known', value: 'Verifier', evidence: liveEvidence },
      label: { kind: 'known', value: 'Verifier', evidence: liveEvidence },
      foreground: { kind: 'known', value: 'running', evidence: liveEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 1,
    },
    {
      id: snapshotChild,
      role: { kind: 'known', value: 'Snapshot Worker', evidence: snapEvidence },
      label: { kind: 'known', value: 'Snapshot Worker', evidence: snapEvidence },
      foreground: { kind: 'known', value: 'idle', evidence: snapEvidence },
      status: { kind: 'known', value: 'waiting', evidence: snapEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 1,
    },
    {
      id: unresolvedChild,
      role: { kind: 'known', value: 'Pending Researcher', evidence: liveEvidence },
      foreground: { kind: 'unknown', reasonCode: 'no_child_session_id_observed' },
      launchWorkIds: [workUnresolved],
      lineage: 'unresolved',
      revision: 1,
    },
    {
      id: conflictingChild,
      role: { kind: 'known', value: 'Conflicting Worker', evidence: liveEvidence },
      foreground: { kind: 'unknown', reasonCode: 'relation_parent_conflict' },
      launchWorkIds: [],
      lineage: 'conflicting',
      revision: 1,
    },
  ];

  const projection: NativeRuntimeProjection = {
    schemaVersion: 1,
    enabled: true,
    binding: { runtimeId, sessionId: baseSession.id, instanceId: 'agy', generation },
    asOfSeq: 12,
    status: 'attached',
    capabilitiesRevision: 2,
    activities: [],
    work: [
      {
        id: workConfirmed,
        kind: 'subagent',
        ownerAgentId: root,
        blocking: 'confirmed_blocking',
        state: { kind: 'known', value: 'running', evidence: liveEvidence },
        observedLabel: 'Codebase Researcher',
        revision: 1,
      },
      {
        id: workUnresolved,
        kind: 'subagent',
        ownerAgentId: root,
        blocking: 'unknown',
        state: { kind: 'known', value: 'running', evidence: liveEvidence },
        observedLabel: 'Pending Researcher',
        revision: 1,
      },
    ],
    agents,
    relations: [
      {
        parentAgentId: root,
        childAgentId: childLive,
        confidence: 'protocol_confirmed',
        launchWorkId: workConfirmed,
        evidence: liveEvidence,
      },
      {
        parentAgentId: root,
        childAgentId: childSameRole,
        confidence: 'protocol_confirmed',
        evidence: liveEvidence,
      },
      {
        parentAgentId: childLive,
        childAgentId: grandchild,
        confidence: 'protocol_confirmed',
        evidence: liveEvidence,
      },
      {
        parentAgentId: root,
        childAgentId: snapshotChild,
        confidence: 'snapshot_confirmed',
        evidence: snapEvidence,
      },
    ],
    workflows: [],
    requestIds: ['appr_child_01'],
    receipts: {
      appr_child_01: {
        approvalId: 'appr_child_01',
        runtimeId,
        generation,
        kind: 'permission',
        agentId: childLive,
        targetLineage: 'confirmed',
        allowedOptionIds: ['allow_once', 'reject_once'],
        receiptState: 'pending',
        updatedAt: now,
      },
    },
  };

  const approvals: ApprovalRequest[] = [
    {
      id: 'appr_child_01',
      sessionId: baseSession.id,
      turnId: 'turn_1',
      kind: 'tool_approval',
      toolName: 'run_command',
      summary: 'Run unit tests in child workspace',
      riskLevel: 'medium',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    },
  ];

  return {
    projection,
    approvals,
    ids: {
      root,
      childLive,
      childSameRole,
      grandchild,
      snapshotChild,
      unresolvedChild,
      conflictingChild,
    },
  };
}

function makeBaseProps(overrides?: Partial<NativeWorkbenchViewProps>): NativeWorkbenchViewProps {
  return {
    session: baseSession,
    projection: null,
    capabilities: makeFixtureCapabilities(1),
    pendingApprovals: [],
    route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'subagents' },
    isNarrowViewport: false,
    onNavigate: vi.fn(),
    onBackToChat: vi.fn(),
    onRefresh: vi.fn(),
    onResolveRequest: vi.fn(async () => ({})),
    onDispatchControl: vi.fn(async () => {}),
    loadTimeline: vi.fn(async () => ({
      schemaVersion: 1 as const,
      scopeKind: 'agent' as const,
      scopeId: 'agt_child_live_a',
      revision: 1,
      items: [],
      nextPageToken: null,
      hasMore: false,
      sourceUnavailableReason: 'child_transcript_source_not_provided',
    })),
    ...overrides,
  };
}

describe('NP-05 Subagent Manager view model, safe controls, and Workbench registration [synthetic]', () => {
  it('registers NP-05 view at order 200 overriding default degraded shell at order 900', () => {
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);
    expect(registry.getView('subagents')?.owner).toBe('core.agy-workbench');

    const dispose = registerSubagentManagerView(registry);
    expect(registry.getView('subagents')?.owner).toBe('np-05');
    expect(registry.getView('subagents')?.order).toBe(200);

    dispose();
    expect(registry.getView('subagents')?.owner).toBe('core.agy-workbench');
  });

  it('builds acyclic parent-child tree, breadcrumbs, identical roles with distinct IDs, and separates launch batches', () => {
    const { projection, approvals, ids } = createRichChildProjection();
    const tree = buildSubagentTreeProjection(projection, approvals);

    expect(tree.rootNodes).toHaveLength(1);
    expect(tree.rootNodes[0]?.agent.id).toBe(ids.root);
    // Two identical roles ("Codebase Researcher") stay distinct nodes!
    const researcherNodes = tree.flattenedTree.filter((n) => n.displayName === 'Codebase Researcher');
    expect(researcherNodes.map((n) => n.agent.id).sort()).toEqual([ids.childLive, ids.childSameRole].sort());

    // Grandchild depth is 2 and breadcrumbs trace root -> childLive -> grandchild
    const gcNode = tree.flattenedTree.find((n) => n.agent.id === ids.grandchild)!;
    expect(gcNode.depth).toBe(2);
    const crumbs = buildAgentBreadcrumbs(projection, ids.grandchild);
    expect(crumbs.map((c) => c.id)).toEqual([ids.root, ids.childLive, ids.grandchild]);

    // Unresolved & conflicting are separated from confirmed parent tree
    expect(tree.unresolvedOrConflicting.map((n) => n.agent.id).sort()).toEqual(
      [ids.conflictingChild, ids.unresolvedChild].sort(),
    );

    // Launch batches distinguish confirmed vs unresolved
    expect(tree.launchBatches).toHaveLength(2);
    expect(tree.launchBatches.find((b) => b.isIdentityConfirmed)?.linkedAgent?.id).toBe(ids.childLive);
    expect(tree.launchBatches.find((b) => !b.isIdentityConfirmed)?.linkedAgent?.id).toBe(ids.unresolvedChild);
  });

  it('strictly disables dangerous controls for unknown/unresolved/conflicting/snapshot-only/disconnected children', () => {
    const { projection, approvals, ids } = createRichChildProjection();
    const tree = buildSubagentTreeProjection(projection, approvals);
    const capsWithChildCancel = [
      ...makeFixtureCapabilities(2),
      {
        id: 'agy.subagents',
        snapshotRevision: 2,
        surfaces: ['cli' as const, 'acp' as const],
        advertised: true,
        launch: 'available' as const,
        observe: 'available' as const,
        control: 'available' as const,
        localRead: 'available' as const,
        actions: [{ key: 'cancel', lane: 'manager' as const, gate: 'available' as const, label: '停止子 Agent' }],
        evidenceRefs: ['synthetic'],
        verifiedLevel: null,
      },
    ];

    const findNode = (id: NativeAgentId) =>
      [...tree.flattenedTree, ...tree.unresolvedOrConflicting].find((n) => n.agent.id === id)!;

    // 1. Confirmed live child with advertised cancel -> allowed
    const liveOk = resolveSafeChildControlCapability({
      agent: findNode(ids.childLive).agent,
      relation: findNode(ids.childLive).relation,
      isPrimaryRoot: false,
      runtimeStatus: 'attached',
      capabilities: capsWithChildCancel,
    });
    expect(liveOk.capability?.id).toBe('agy.subagents');

    // 2. Unresolved child -> BLOCKED
    const unresolvedBlocked = resolveSafeChildControlCapability({
      agent: findNode(ids.unresolvedChild).agent,
      relation: null,
      isPrimaryRoot: false,
      runtimeStatus: 'attached',
      capabilities: capsWithChildCancel,
    });
    expect(unresolvedBlocked.capability).toBeNull();
    expect(unresolvedBlocked.blockReason).toContain('禁用危险控件');

    // 3. Conflicting child -> BLOCKED
    const conflictBlocked = resolveSafeChildControlCapability({
      agent: findNode(ids.conflictingChild).agent,
      relation: null,
      isPrimaryRoot: false,
      runtimeStatus: 'attached',
      capabilities: capsWithChildCancel,
    });
    expect(conflictBlocked.capability).toBeNull();

    // 4. Snapshot-only read-only child -> BLOCKED
    const snapBlocked = resolveSafeChildControlCapability({
      agent: findNode(ids.snapshotChild).agent,
      relation: findNode(ids.snapshotChild).relation,
      isPrimaryRoot: false,
      runtimeStatus: 'attached',
      capabilities: capsWithChildCancel,
    });
    expect(snapBlocked.capability).toBeNull();
    expect(snapBlocked.blockReason).toContain('只读快照');

    // 5. Disconnected runtime -> BLOCKED even for confirmed child
    const discBlocked = resolveSafeChildControlCapability({
      agent: findNode(ids.childLive).agent,
      relation: findNode(ids.childLive).relation,
      isPrimaryRoot: false,
      runtimeStatus: 'disconnected',
      capabilities: capsWithChildCancel,
    });
    expect(discBlocked.capability).toBeNull();
  });

  it('renders SubagentManagerView with main-agent return, parent tree, batches, pending approvals, read-only provenance, and no-data fallback', () => {
    const { projection, approvals, ids } = createRichChildProjection();

    // 1. Live confirmed child selected (with pending approval + breadcrumbs + batches)
    const htmlLive = renderToStaticMarkup(
      <SubagentManagerView
        {...makeBaseProps({
          projection,
          pendingApprovals: approvals,
          route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'subagents', selectedAgentId: ids.childLive },
        })}
      />,
    );
    expect(htmlLive).toContain('返回主 Agent 聊天');
    expect(htmlLive).toContain('已确证父子树');
    expect(htmlLive).toContain('委派批次');
    expect(htmlLive).toContain('已观察到委派 · 身份待确认');
    expect(htmlLive).toContain('需操作的原生请求 (1)');
    expect(htmlLive).toContain('Run unit tests in child workspace');
    expect(htmlLive).toContain('无原生子对话输入 · 回主 Agent 交互');
    expect(htmlLive).toContain('np05-breadcrumbs');

    // 2. Snapshot read-only child selected: clearly marks read-only provenance & blocks controls
    const htmlSnap = renderToStaticMarkup(
      <SubagentManagerView
        {...makeBaseProps({
          projection,
          pendingApprovals: approvals,
          route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'subagents', selectedAgentId: ids.snapshotChild },
        })}
      />,
    );
    expect(htmlSnap).toContain('data-source-readonly="true"');
    expect(htmlSnap).toContain('只读原生快照（只读）');
    expect(htmlSnap).toContain('只读快照');

    // 3. Unresolved child selected: explicitly warns and disables controls
    const htmlUnresolved = renderToStaticMarkup(
      <SubagentManagerView
        {...makeBaseProps({
          projection,
          pendingApprovals: approvals,
          route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'subagents', selectedAgentId: ids.unresolvedChild },
          isNarrowViewport: true,
        })}
      />,
    );
    expect(htmlUnresolved).toContain('已观察到委派 · 身份待确认');
    expect(htmlUnresolved).toContain('禁用危险控件');

    // 4. Null projection honest no-data degradation (never fabricates from HM subagent_runs)
    const htmlEmpty = renderToStaticMarkup(<SubagentManagerView {...makeBaseProps({ projection: null })} />);
    expect(htmlEmpty).toContain('Subagent Manager 暂无原生数据');
    expect(htmlEmpty).toContain('/agents');

    // 5. ChildTimelinePanel renders honest read-only source badge for confirmed child
    const timelineHtml = renderToStaticMarkup(
      <ChildTimelinePanel
        agent={projection.agents.find((a) => a.id === ids.snapshotChild)!}
        displayName="Snapshot Worker"
        bindingKey="nrt_np05_web:gen_np05_1"
        provenance={{ sourceKind: 'native_snapshot', freshness: 'snapshot', observedAt: 1_764_000_000_000 }}
        isReadOnlySnapshotOnly={true}
        onBackToChat={vi.fn()}
      />,
    );
    expect(timelineHtml).toContain('np05-child-timeline-panel');
    expect(timelineHtml).toContain('只读原生快照（只读）');
  });
});
