import type { Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgyWorkbenchRegistry,
  DEFAULT_WORKBENCH_ROUTE,
  registerDefaultWorkbenchViews,
  type NativeWorkbenchViewProps,
} from '../src/components/agy/native/shared';
import {
  BoostEligibilityBanner,
  BoostStudioView,
  classifyBoostStageLabel,
  createBoostWithPhasesFixture,
  createBoostWithoutPhasesFixture,
  deriveBoostEligibilityBanner,
  deriveBoostStudioViewModel,
  makeBoostUiCapabilities,
  parseBoostResourceItems,
  registerBoostStudioView,
} from '../src/components/agy/native/boost';

function makeSession(): Session {
  return {
    id: 'sess_np09_ui',
    workspaceId: 'ws_1',
    title: 'Boost T11 Verification Session',
    harnessId: 'agy_pro',
    harnessKind: 'agy',
    status: 'running',
    permissionMode: 'manual',
    permissionEnforcement: 'native',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
  } as Session;
}

function makeViewProps(
  overrides?: Partial<NativeWorkbenchViewProps>,
): NativeWorkbenchViewProps {
  return {
    session: makeSession(),
    projection: createBoostWithPhasesFixture(),
    capabilities: makeBoostUiCapabilities({ eligible: true }),
    pendingApprovals: [],
    route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'boost' },
    isNarrowViewport: false,
    onNavigate: () => {},
    onBackToChat: () => {},
    onRefresh: () => {},
    onResolveRequest: async () => ({}),
    onDispatchControl: async () => {},
    ...overrides,
  };
}

describe('NP-09 Boost Studio UI, Workbench registration, and degradation boundaries', () => {
  it('registers Boost Studio into AgyWorkbenchRegistry overriding default order=900 degraded shell and computes badge count', () => {
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);
    expect(registry.getView('boost')?.owner).toBe('core.agy-workbench');

    const dispose = registerBoostStudioView(registry);
    const view = registry.getView('boost');
    expect(view?.owner).toBe('np-09.boost-studio');
    expect(view?.order).toBe(200);
    expect(view?.capabilityIds).toContain('AGY-W06');

    const runningProj = createBoostWithoutPhasesFixture();
    expect(view?.badgeCount?.(runningProj, [])).toBe(1);
    expect(view?.badgeCount?.(null, [])).toBe(0);

    dispose();
    expect(registry.getView('boost')?.owner).toBe('core.agy-workbench');
  });

  it('classifies canonical initial/improvement/verification labels strictly and preserves unknown labels verbatim without inferring progress', () => {
    expect(classifyBoostStageLabel('initial')).toEqual({
      kind: 'canonical',
      phaseKind: 'initial',
      label: 'initial',
    });
    expect(classifyBoostStageLabel('Challenge & Fix')).toEqual({
      kind: 'observed_unknown',
      label: 'Challenge & Fix',
    });
    expect(classifyBoostStageLabel('improvement')).toEqual({
      kind: 'canonical',
      phaseKind: 'improvement',
      label: 'improvement',
    });
    expect(classifyBoostStageLabel('verification')).toEqual({
      kind: 'canonical',
      phaseKind: 'verification',
      label: 'verification',
    });
    expect(classifyBoostStageLabel('Adversarial Critic Audit')).toEqual({
      kind: 'observed_unknown',
      label: 'Adversarial Critic Audit',
    });
  });

  it('renders deterministic ineligibility guidance and explicit no-auto-upgrade notice for Free tier or unadvertised sessions', () => {
    const freeModel = deriveBoostEligibilityBanner(
      makeBoostUiCapabilities({
        eligible: false,
        advertised: false,
        reasonCode: 'tier_ineligible',
        tierHint: 'Free',
      }),
    );
    expect(freeModel.isEligibleToLaunch).toBe(false);
    expect(freeModel.launchGate).toBe('unsupported');
    expect(freeModel.reasonCode).toBe('tier_ineligible');

    const html = renderToStaticMarkup(<BoostEligibilityBanner model={freeModel} />);
    expect(html).toContain('当前账号计划未包含 Boost 资格');
    expect(html).toContain('默认不自动升级到付费模式');
    expect(html).toContain('AGY-W06');
  });

  it('renders Boost Studio with observed phases (canonical + unknown label), verified child jump, activities, and root cancel control', () => {
    const props = makeViewProps();
    const vm = deriveBoostStudioViewModel(props.projection, props.capabilities, []);
    expect(vm.phases).toHaveLength(3);
    expect(vm.phases?.[0]?.classification).toEqual({
      kind: 'canonical',
      phaseKind: 'initial',
      label: 'initial',
    });
    expect(vm.phases?.[1]?.classification).toEqual({
      kind: 'observed_unknown',
      label: 'Adversarial Critic Audit',
    });
    expect(vm.phases?.[2]?.linkedAgents).toHaveLength(1);
    expect(vm.stopTarget?.targetType).toBe('runtime');

    const html = renderToStaticMarkup(<BoostStudioView {...props} />);
    expect(html).toContain('data-testid="np09-boost-studio"');
    expect(html).toContain('data-testid="np09-boost-phases-section"');
    expect(html).toContain('Adversarial Critic Audit');
    expect(html).toContain('已观测标签');
    expect(html).toContain('独立验证 (verification)');
    expect(html).toContain('Independent Verifier');
    expect(html).toContain('data-testid="np09-boost-stop-section"');
    expect(html).toContain('停止当前原生会话');
    // Must never render fabricated percentage progress bars
    expect(html).not.toContain('role="progressbar"');
  });

  it('omits phase section completely when Boost workflow has no native phases while preserving confirmed launch & observable activities', () => {
    const props = makeViewProps({
      projection: createBoostWithoutPhasesFixture(),
      isNarrowViewport: true,
    });
    const vm = deriveBoostStudioViewModel(props.projection, props.capabilities, []);
    expect(vm.phases).toBeNull();
    expect(vm.originActivity).not.toBeNull();
    expect(vm.relatedWork).toHaveLength(1);

    const html = renderToStaticMarkup(<BoostStudioView {...props} />);
    expect(html).not.toContain('data-testid="np09-boost-phases-section"');
    expect(html).toContain('data-testid="np09-boost-no-phases-notice"');
    expect(html).toContain('已证实启动 · live_workflow');
    expect(html).toContain('无原生阶段字段的 Boost 运行回放');
    expect(html).toContain('data-testid="np09-boost-activities-section"');
  });

  it('renders honest degradation for disconnected/empty projections and parses allowlisted Boost workflow resources', () => {
    const noProjHtml = renderToStaticMarkup(
      <BoostStudioView
        {...makeViewProps({
          projection: null,
          capabilities: makeBoostUiCapabilities({
            eligible: false,
            advertised: null,
            reasonCode: 'profile_unauthenticated',
          }),
        })}
      />,
    );
    expect(noProjHtml).toContain('Boost Studio 暂无原生投影');
    expect(noProjHtml).toContain('data-testid="capability-unavailable"');

    const staleProj = {
      ...createBoostWithoutPhasesFixture(),
      status: 'disconnected' as const,
    };
    const staleHtml = renderToStaticMarkup(<BoostStudioView {...makeViewProps({ projection: staleProj })} />);
    expect(staleHtml).toContain('data-testid="np09-boost-stale-warning"');

    const parsedLogs = parseBoostResourceItems('logs', [
      {
        kind: 'log_entry',
        entryId: 'bclue_1',
        seq: 1,
        level: 'info',
        summary: '已证实 /boost 启动: 核验边界',
        createdAt: 1_700_000_000_000,
      },
    ]);
    expect(parsedLogs.logs).toHaveLength(1);
    expect(parsedLogs.logs[0]?.id).toBe('bclue_1');

    const parsedArtifacts = parseBoostResourceItems('artifacts', [
      {
        kind: 'artifact_ref',
        artifactId: 'art_boost_1',
        title: 'Verification Summary',
        artifactKind: 'markdown',
        revision: 1,
        updatedAt: 1_700_000_005_000,
      },
    ]);
    expect(parsedArtifacts.artifacts).toHaveLength(1);
    expect(parsedArtifacts.artifacts[0]?.title).toBe('Verification Summary');
  });
});
