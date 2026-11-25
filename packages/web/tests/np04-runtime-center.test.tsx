import type { Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgyWorkbenchRegistry,
  AgyWorkbenchShell,
  DEFAULT_WORKBENCH_ROUTE,
  createCrashedDisconnectedFixture,
  createLiveReactiveFixture,
  createStaleReconcilingFixture,
  createUnknownFixture,
  registerDefaultWorkbenchViews,
} from '../src/components/agy/native/shared';
import {
  AgyNativeRuntimeCenter,
  deriveRuntimeBannerModel,
  deriveStopStatusSummary,
  deriveStopTargetCandidates,
  formatHonestWorkOutcome,
  registerAgyNativeRuntimeView,
} from '../src/components/agy/native/runtime';
import type { NativeWork } from '../src/lib/native-client';

const sampleSession: Session = {
  id: 'sess_np04_web',
  workspaceId: 'ws_1',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'NP-04 Runtime Center UI Test',
  status: 'running',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 5,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

describe('NP-04 Native Runtime Center Frontend Components & View Model', () => {
  it('registers into AgyWorkbenchRegistry (order=100) and overrides NP-03 default degraded shell without touching ChatStage', () => {
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);
    const dispose = registerAgyNativeRuntimeView(registry);

    const view = registry.getView('runtime');
    expect(view?.owner).toBe('np-04.runtime-center');
    expect(view?.order).toBe(100);

    const live = createLiveReactiveFixture(sampleSession.id);
    const html = renderToStaticMarkup(
      <AgyWorkbenchShell
        registry={registry}
        session={sampleSession}
        projection={live.projection}
        capabilities={live.capabilities}
        pendingApprovals={live.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );

    expect(html).toContain('np04-native-runtime-center');
    expect(html).toContain('np04-runtime-status-banner');
    expect(html).toContain('np04-stop-panel');
    // Distinct finite vs daemon badges
    expect(html).toContain('有限命令');
    expect(html).toContain('常驻 Daemon');
    expect(html).toContain('阻塞轮次');
    expect(html).toContain('已分离');

    dispose();
    expect(registry.getView('runtime')?.owner).not.toBe('np-04.runtime-center');
  });

  it('surfaces top banner states accurately: waiting_background, requires_action, reconnecting, and disconnected', () => {
    // 1. Requires user action (live fixture has pending approval)
    const live = createLiveReactiveFixture(sampleSession.id);
    const reqBanner = deriveRuntimeBannerModel(live.projection, null, live.approvals);
    expect(reqBanner.phase).toBe('requires_action');
    expect(reqBanner.headline).toContain('需要用户处理');
    expect(reqBanner.blockingFiniteCount).toBe(1);
    expect(reqBanner.detachedDaemonCount).toBe(1);

    // 2. Waiting background when no pending approvals remain and activity is waiting_background
    const waitProj = {
      ...live.projection,
      requestIds: [],
      receipts: {},
      activities: live.projection.activities.map((a) =>
        a.state === 'requires_action' ? { ...a, state: 'waiting_background' as const } : a,
      ),
    };
    const waitBanner = deriveRuntimeBannerModel(waitProj, null, []);
    expect(waitBanner.phase).toBe('waiting_background');
    expect(waitBanner.headline).toContain('等待有限后台任务');

    // 3. Reconnecting / reconciling
    const stale = createStaleReconcilingFixture(sampleSession.id);
    const reconBanner = deriveRuntimeBannerModel(stale.projection, null, []);
    expect(reconBanner.phase).toBe('reconnecting');
    expect(reconBanner.showReconnectAction).toBe(true);

    // 4. Disconnected
    const crashed = createCrashedDisconnectedFixture(sampleSession.id);
    const discBanner = deriveRuntimeBannerModel(crashed.projection, null, []);
    expect(discBanner.phase).toBe('disconnected');
    expect(discBanner.showReconnectAction).toBe(true);

    const crashedHtml = renderToStaticMarkup(
      <AgyNativeRuntimeCenter
        session={sampleSession}
        projection={crashed.projection}
        capabilities={crashed.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={true}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(crashedHtml).toContain('观测连接已断开');
    expect(crashedHtml).toContain('重新连接 / 刷新快照');
  });

  it('never displays unissued success when work finished without confirmed outcome or is unknown/stale', () => {
    const baseEv = {
      sourceKind: 'live_protocol' as const,
      freshness: 'live' as const,
      observedAt: 1000,
    };

    const finishedNoOutcome: NativeWork = {
      id: 'wrk_no_outcome' as NativeWork['id'],
      kind: 'finite_command',
      blocking: 'confirmed_blocking',
      state: { kind: 'known', value: 'finished', evidence: baseEv },
      outcome: { kind: 'unknown', reasonCode: 'outcome_not_reported_by_wire' },
      observedLabel: 'Run shell without exitCode',
      revision: 2,
    };
    const resNoOutcome = formatHonestWorkOutcome(finishedNoOutcome);
    expect(resNoOutcome.modelConfirmedSuccess).toBe(false);
    expect(resNoOutcome.label).not.toContain('成功');

    const unknownWork: NativeWork = {
      id: 'wrk_unk' as NativeWork['id'],
      kind: 'unknown',
      blocking: 'unknown',
      state: { kind: 'unknown', reasonCode: 'observation_timeout' },
      revision: 1,
    };
    const resUnknown = formatHonestWorkOutcome(unknownWork);
    expect(resUnknown.modelConfirmedSuccess).toBe(false);
    expect(resUnknown.label).toContain('未知');

    const confirmedSuccessWork: NativeWork = {
      id: 'wrk_ok' as NativeWork['id'],
      kind: 'finite_command',
      blocking: 'confirmed_blocking',
      state: { kind: 'known', value: 'finished', evidence: baseEv },
      outcome: { kind: 'known', value: 'succeeded', evidence: baseEv },
      revision: 2,
    };
    const resOk = formatHonestWorkOutcome(confirmedSuccessWork);
    expect(resOk.modelConfirmedSuccess).toBe(true);
    expect(resOk.label).toBe('已证实成功');

    // Render projection containing finished-without-outcome work -> MUST NOT show 已证实成功
    const unkFixture = createUnknownFixture(sampleSession.id);
    const proj = {
      ...unkFixture.projection,
      work: [finishedNoOutcome, unknownWork],
    };
    const html = renderToStaticMarkup(
      <AgyNativeRuntimeCenter
        session={sampleSession}
        projection={proj}
        capabilities={unkFixture.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(html).not.toContain('已证实成功');
    expect(html).toContain('结果未由协议证实');
    expect(html).toContain('状态未知（不推断成功）');
  });

  it('tracks Stop target, waiting confirmation, confirmed cancelled, unconfirmed unknown, and capability gate boundary', () => {
    const live = createLiveReactiveFixture(sampleSession.id);
    const candidates = deriveStopTargetCandidates(
      live.projection,
      live.projection.work[0] ?? null,
      live.projection.activities[0] ?? null,
    );
    expect(candidates.map((c) => c.target.type)).toEqual(['runtime', 'work', 'activity']);

    const workTarget = candidates[1]!;

    // 1. Waiting confirmation after Stop requested
    const waiting = deriveStopStatusSummary({
      target: workTarget,
      projection: live.projection,
      localRequested: true,
      localSubmitting: false,
      localError: null,
    });
    expect(waiting.phase).toBe('waiting_confirmation');
    expect(waiting.headline).toContain('等待原生确认');

    // 2. Confirmed cancelled when projection receives native `cancelled`
    const confirmedProj = {
      ...live.projection,
      work: live.projection.work.map((w, idx) =>
        idx === 0
          ? {
              ...w,
              state: {
                kind: 'known' as const,
                value: 'cancelled' as const,
                evidence: {
                  sourceKind: 'live_protocol' as const,
                  freshness: 'live' as const,
                  observedAt: 2000,
                },
              },
            }
          : w,
      ),
    };
    const confirmed = deriveStopStatusSummary({
      target: workTarget,
      projection: confirmedProj,
      localRequested: true,
      localSubmitting: false,
      localError: null,
    });
    expect(confirmed.phase).toBe('confirmed_cancelled');
    expect(confirmed.headline).toContain('已收到原生取消确认');

    // 3. Grace expired -> stale/unknown (MUST NOT show confirmed cancelled!)
    const unconfirmedProj = {
      ...live.projection,
      work: live.projection.work.map((w, idx) =>
        idx === 0
          ? {
              ...w,
              state: {
                kind: 'stale' as const,
                last: 'running' as const,
                reasonCode: 'cancel_grace_expired',
              },
            }
          : w,
      ),
    };
    const unconfirmed = deriveStopStatusSummary({
      target: workTarget,
      projection: unconfirmedProj,
      localRequested: true,
      localSubmitting: false,
      localError: null,
    });
    expect(unconfirmed.phase).toBe('unconfirmed_unknown');
    expect(unconfirmed.headline).toContain('状态未确认');

    // 4. Without verified control capability, Stop button stays disabled with read-only notice
    const unk = createUnknownFixture(sampleSession.id);
    const readOnlyHtml = renderToStaticMarkup(
      <AgyNativeRuntimeCenter
        session={sampleSession}
        projection={unk.projection}
        capabilities={unk.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(readOnlyHtml).toContain('当前绑定尚未开放已验证的原生停止控制');
    expect(readOnlyHtml).toContain('disabled=""');
  });
});
