import type { Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AgyWorkbenchRegistry,
  DEFAULT_WORKBENCH_ROUTE,
  registerDefaultWorkbenchViews,
  type NativeWorkbenchViewProps,
} from '../src/components/agy/native/shared';
import {
  SwarmStudioView,
  buildSwarmStudioViewModel,
  createStructuredSwarmProjectionFixture,
  createSwarmCapabilitiesFixture,
  createUpstreamLimitedSwarmProjectionFixture,
  filterEntriesBySource,
  groupBoardPostsIntoThreads,
  parseBoardResourcePosts,
  registerSwarmStudioView,
  resolveSafeSwarmControlCapability,
} from '../src/components/agy/native/swarm';

const baseSession: Session = {
  id: 'sess_np08_web',
  workspaceId: 'ws_1',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'NP-08 Swarm Studio UI Test',
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

function makeBaseProps(overrides?: Partial<NativeWorkbenchViewProps>): NativeWorkbenchViewProps {
  return {
    session: baseSession,
    projection: null,
    capabilities: createSwarmCapabilitiesFixture(2),
    pendingApprovals: [],
    route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'swarm' },
    isNarrowViewport: false,
    onNavigate: vi.fn(),
    onBackToChat: vi.fn(),
    onRefresh: vi.fn(),
    onResolveRequest: vi.fn(async () => ({})),
    onDispatchControl: vi.fn(async () => {}),
    loadWorkflowResource: vi.fn(async () => ({
      schemaVersion: 1 as const,
      workflowId: 'wfl_swarm_01' as never,
      resource: 'board',
      revision: 1,
      items: [],
      nextPageToken: null,
      hasMore: false,
      sourceUnavailableReason: 'acp_swarm_board_not_exposed',
    })),
    ...overrides,
  };
}

describe('NP-08 Swarm Studio view model, Workbench registration, and honest degradation [synthetic]', () => {
  it('registers NP-08 Swarm Studio at order 200 overriding default shell and computes honest badge counts', () => {
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);
    expect(registry.getView('swarm')?.owner).toBe('core.agy-workbench');

    const dispose = registerSwarmStudioView(registry);
    const view = registry.getView('swarm');
    expect(view?.owner).toBe('np-08');
    expect(view?.order).toBe(200);
    expect(view?.capabilityIds).toContain('AGY-W04');
    expect(view?.capabilityIds).toContain('AGY-W05');

    // Badge counts ONLY confirmed pending approvals (1, ignoring unconfirmed approval #2)
    const { projection, approvals } = createStructuredSwarmProjectionFixture();
    expect(view?.badgeCount?.(projection, approvals)).toBe(1);

    // Without approvals, badge counts ONLY actively running confirmed members (coordinator=1), NEVER idle/failed workers
    expect(view?.badgeCount?.(projection, [])).toBe(1);

    dispose();
    expect(registry.getView('swarm')?.owner).toBe('core.agy-workbench');
  });

  it('separates Coordinator/Workers/Verifiers/Unconfirmed, never counts idle as progress, and parses/groups Board threads by stable postId', () => {
    const { projection, approvals, boardPage1, boardPage2, ids } =
      createStructuredSwarmProjectionFixture();
    const model = buildSwarmStudioViewModel(
      projection,
      createSwarmCapabilitiesFixture(2),
      approvals,
      ids.workflowId,
    );

    expect(model.coordinator?.agent.id).toBe(ids.coordinatorId);
    expect(model.workers.map((w) => w.agent.id)).toEqual([ids.workerAlphaId, ids.workerIdleId]);
    expect(model.verifiers.map((v) => v.agent.id)).toEqual([ids.verifierId]);
    expect(model.unconfirmedMembers.map((u) => u.agent.id)).toEqual([ids.unconfirmedId]);

    // Honest counts: idle workers tracked separately, verifier failed counted, zero fake progress bar
    expect(model.counts.totalConfirmedMembers).toBe(3);
    expect(model.counts.idleCount).toBe(2); // workerIdle + verifier (foreground: idle)
    expect(model.counts.failedCount).toBe(1);
    expect(model.counts.requiresActionCount).toBe(1);
    expect(model.counts.hasFakeProgressBar).toBe(false);

    // Only confirmed worker approval is linked; unconfirmed request counted separately
    expect(model.linkedApprovals.map((a) => a.id)).toEqual(['appr_swarm_worker_01']);
    expect(model.unconfirmedApprovalCount).toBe(1);

    // Board stable-ID pagination merge + deduplication + thread grouping
    const merged1 = parseBoardResourcePosts(boardPage1);
    const mergedDup = parseBoardResourcePosts(boardPage1, merged1);
    expect(mergedDup).toHaveLength(2);
    const mergedAll = parseBoardResourcePosts(boardPage2, mergedDup);
    expect(mergedAll.map((p) => p.postId)).toEqual(['post_t10_001', 'post_t10_002', 'post_t10_003']);

    const threads = groupBoardPostsIntoThreads(mergedAll);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.rootPost?.postId).toBe('post_t10_001');
    expect(threads[0]!.replies.map((r) => r.postId)).toEqual(['post_t10_002', 'post_t10_003']);

    // Source filtering
    const liveOnly = filterEntriesBySource(mergedAll, 'live_protocol');
    expect(liveOnly).toHaveLength(3);
    expect(filterEntriesBySource(mergedAll, 'native_snapshot')).toHaveLength(0);
  });

  it('strictly disables controls when feed/capability is upstream_limited, target is unconfirmed, source is snapshot/replay, or runtime is disconnected', () => {
    const baseCaps = createSwarmCapabilitiesFixture(2);
    const liveEvidence = {
      sourceKind: 'live_protocol' as const,
      freshness: 'live' as const,
      observedAt: 1_764_200_000_000,
    };
    const snapEvidence = {
      sourceKind: 'native_snapshot' as const,
      freshness: 'snapshot' as const,
      observedAt: 1_764_200_000_000,
    };

    // 1. Upstream-limited capability -> blocked
    const upstreamBlocked = resolveSafeSwarmControlCapability({
      runtimeStatus: 'attached',
      targetConfirmed: true,
      targetEvidence: liveEvidence,
      capabilities: baseCaps,
      targetKind: 'workflow',
    });
    expect(upstreamBlocked.capability).toBeNull();
    expect(upstreamBlocked.blockReason).toContain('只读');

    // Create a synthetic capability that explicitly advertises control: available
    const availableCaps = [
      {
        ...baseCaps[0]!,
        control: 'available' as const,
        actions: [{ key: 'cancel', lane: 'manager' as const, gate: 'available' as const, label: '停止' }],
      },
    ];

    // 2. Attached + confirmed + live + available -> allowed
    const allowed = resolveSafeSwarmControlCapability({
      runtimeStatus: 'attached',
      targetConfirmed: true,
      targetEvidence: liveEvidence,
      capabilities: availableCaps,
      targetKind: 'agent',
    });
    expect(allowed.capability?.id).toBe('AGY-W04');

    // 3. Unconfirmed member -> blocked
    expect(
      resolveSafeSwarmControlCapability({
        runtimeStatus: 'attached',
        targetConfirmed: false,
        targetEvidence: liveEvidence,
        capabilities: availableCaps,
        targetKind: 'agent',
      }).capability,
    ).toBeNull();

    // 4. Snapshot-only evidence -> blocked
    expect(
      resolveSafeSwarmControlCapability({
        runtimeStatus: 'attached',
        targetConfirmed: true,
        targetEvidence: snapEvidence,
        capabilities: availableCaps,
        targetKind: 'agent',
      }).capability,
    ).toBeNull();

    // 5. Disconnected runtime -> blocked
    expect(
      resolveSafeSwarmControlCapability({
        runtimeStatus: 'disconnected',
        targetConfirmed: true,
        targetEvidence: liveEvidence,
        capabilities: availableCaps,
        targetKind: 'workflow',
      }).capability,
    ).toBeNull();
  });

  it('renders Overview, Workers, Board, Activity tabs, missing-Board official guidance, and zero fake progress', () => {
    const { projection, approvals, ids } = createStructuredSwarmProjectionFixture();

    // 1. Overview tab: coordinator, objective, honest counters, linked approval, control guard
    const overviewHtml = renderToStaticMarkup(
      <SwarmStudioView
        {...makeBaseProps({ projection, pendingApprovals: approvals })}
        initialTab="overview"
      />,
    );
    expect(overviewHtml).toContain('Swarm Coordinator');
    expect(overviewHtml).toContain('Verify Swarm worker wake, linked approvals, and Board threads');
    expect(overviewHtml).toContain('不计入成功进度');
    expect(overviewHtml).toContain('Run targeted unit tests for worker-alpha');
    expect(overviewHtml).toContain('另有 1 条来源未确认请求未挂接到 Worker');
    expect(overviewHtml).toContain('np08-workflow-control-guard');
    expect(overviewHtml).not.toContain('role="progressbar"');

    // 2. Workers tab: separates workers, verifiers, unconfirmed, and links worker approvals
    const workersHtml = renderToStaticMarkup(
      <SwarmStudioView
        {...makeBaseProps({
          projection,
          pendingApprovals: approvals,
          route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'swarm', selectedAgentId: ids.workerAlphaId },
        })}
        initialTab="workers"
      />,
    );
    expect(workersHtml).toContain('已证实 Workers (2)');
    expect(workersHtml).toContain('已证实 Verifiers (1)');
    expect(workersHtml).toContain('身份待确认 (1)');
    expect(workersHtml).toContain('不从工具标题生成 Worker');
    expect(workersHtml).toContain('已链接的子审批 (1)');
    expect(workersHtml).toContain('查看独立输出与时间线');

    // 3. Upstream-limited Board (missing ACP feed): honest message + official /swarm board + Alt+S + no post input
    const limitedProj = createUpstreamLimitedSwarmProjectionFixture();
    const limitedBoardHtml = renderToStaticMarkup(
      <SwarmStudioView
        {...makeBaseProps({ projection: limitedProj })}
        initialTab="board"
      />,
    );
    expect(limitedBoardHtml).toContain('当前 ACP 未提供 Board');
    expect(limitedBoardHtml).toContain('/swarm board');
    expect(limitedBoardHtml).toContain('Alt+S');
    expect(limitedBoardHtml).toContain('https://antigravity.google/docs/swarm/');
    expect(limitedBoardHtml).toContain('Board 视图严格只读');
    expect(limitedBoardHtml).not.toContain('<textarea');

    // 4. Upstream-limited Workers tab: explicitly zero workers, never fabricated from tool titles
    const limitedWorkersHtml = renderToStaticMarkup(
      <SwarmStudioView
        {...makeBaseProps({ projection: limitedProj, isNarrowViewport: true })}
        initialTab="workers"
      />,
    );
    expect(limitedWorkersHtml).toContain('已证实 Workers (0)');
    expect(limitedWorkersHtml).toContain('不会依据工具调用标题伪造 Worker');

    // 5. Activity tab: renders source filters and associated coordinator activities
    const activityHtml = renderToStaticMarkup(
      <SwarmStudioView
        {...makeBaseProps({ projection: limitedProj })}
        initialTab="activity"
      />,
    );
    expect(activityHtml).toContain('按来源筛选轨迹');
    expect(activityHtml).toContain('Coordinator running without ACP Board feed');

    // 6. Null projection degradation (never calls HM sub-sessions Swarm)
    const emptyHtml = renderToStaticMarkup(<SwarmStudioView {...makeBaseProps({ projection: null })} />);
    expect(emptyHtml).toContain('Swarm Studio 暂无原生投影');
    expect(emptyHtml).toContain('不会将多个 HarnessMate 子会话伪装为原生 Swarm');
  });
});
