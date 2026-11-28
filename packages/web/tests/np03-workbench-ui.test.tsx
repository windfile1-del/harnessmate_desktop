import type { HarnessInfo, Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgyComposerControls } from '../src/components/agy/AgyComposerControls';
import { AgyStudioBlockCard } from '../src/components/agy/AgyStudioBlocks';
import {
  AgyAgentModePicker,
  AgyWorkbenchRegistry,
  AgyWorkbenchShell,
  CapabilityUnavailable,
  DEFAULT_WORKBENCH_ROUTE,
  EntityStatusBadge,
  EvidenceDetails,
  NativeActivityLink,
  NativeControlMenu,
  NativeRequestCard,
  NativeTimeline,
  computeNextTabIndex,
  createCrashedDisconnectedFixture,
  createLiveReactiveFixture,
  createStaleReconcilingFixture,
  createStressFixture,
  createUnknownFixture,
  createUnsupportedStudiosFixture,
  focusFirstInContainer,
  handleDialogTabTrap,
  registerDefaultWorkbenchViews,
  resolveAgyModeOptions,
  shouldWorkbenchHandleEscape,
} from '../src/components/agy/native/shared';
import { ChatStage } from '../src/components/ChatStage';
import { SlotRegistryProvider, SlotSessionProvider } from '../src/slots';
import { useAppStore } from '../src/stores/app-store';

// This suite supplies a B4 native-workbench projection fixture. Product chat pages
// receive that DTO through the shell bridge; this server-render unit test shares
// the fixture store explicitly, without introducing a product fallback.
vi.mock('../src/plugins/chat-default/store', async () => ({
  useAppStore: (await import('../src/stores/app-store')).useAppStore,
}));

vi.mock('../src/stores/app-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/stores/app-store')>();
  const bound = original.useAppStore;
  return {
    ...original,
    useAppStore: Object.assign(
      (selector?: (state: ReturnType<typeof bound.getState>) => unknown) =>
        selector ? selector(bound.getState()) : bound.getState(),
      bound,
    ),
  };
});

const baseAgySession: Session = {
  id: 'sess_agy_np03_ui',
  workspaceId: 'ws_1',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'NP-03 Workbench UI Test',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 2,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

const baseAgyHarness: HarnessInfo = {
  id: 'agy',
  kind: 'agy',
  driverId: 'agy',
  instanceId: 'agy',
  continuationKey: 'agy:agy',
  displayName: 'Antigravity',
  description: 'Antigravity CLI',
  protocolLabel: 'ACP',
  binaryPath: 'agy.exe',
  version: '1.5.16',
  health: 'ready',
  capabilities: {
    streaming: true,
    interactiveApproval: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    permissionModes: ['manual', 'auto_edit', 'full_auto'],
    sessionResume: true,
    sessionFork: false,
    imageInput: true,
    subagents: true,
  },
  capabilitiesV2: {
    streaming: true,
    interactiveApproval: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    permissionModes: ['manual', 'auto_edit', 'full_auto'],
    sessionResume: true,
    sessionFork: false,
    imageInput: true,
    subagents: true,
    transport: 'acp_stdio',
    historyInjectionMode: 'native_items',
    supportsNativeRollback: false,
    supportsNativeFork: false,
    supportsActiveSteering: false,
    supportsUsageLimits: true,
    supportsDynamicOptions: true,
    nativeCommands: ['/plan', '/goal'],
    optionDescriptors: [],
  },
  models: [{ id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportsReasoningEffort: true }],
  defaultModelId: 'gemini-3.8-flash',
  isCustom: false,
};

const initialStoreSnapshot = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialStoreSnapshot, true);
});

describe('NP-03 AGY Native Workbench UI & Shared Components (03a/03b)', () => {
  it('defaults feature gate OFF to preserve AGY-5 components and legacy ChatStage behavior', () => {
    expect(useAppStore.getState().agyNativeWorkbenchEnabled).toBe(false);

    useAppStore.setState({
      harnesses: [baseAgyHarness],
      sessions: [baseAgySession],
      selectedSessionId: baseAgySession.id,
    });

    const composerHtml = renderToStaticMarkup(
      <AgyComposerControls session={baseAgySession} isRunning={false} />,
    );
    expect(composerHtml).not.toContain('agy-agent-mode-picker');

    const blockHtml = renderToStaticMarkup(
      <AgyStudioBlockCard
        session={baseAgySession}
        block={{
          blockId: 'b1',
          schemaVersion: 2,
          seq: 1,
          turnId: 't1',
          harnessInstanceId: 'agy',
          driverId: 'agy',
          status: 'running',
          createdAt: 1000,
          updatedAt: 1000,
          type: 'ext:agy.background_task',
          title: 'AGY 后台任务',
          fallbackSummary: 'running',
          payload: {},
        }}
      />,
    );
    expect(blockHtml).toContain('AGY 后台任务');
    expect(blockHtml).not.toContain('Runtime');

    const chatHtml = renderToStaticMarkup(
      <SlotRegistryProvider>
        <SlotSessionProvider session={baseAgySession}>
          <ChatStage />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(chatHtml).not.toContain('agy-runtime-topbar-trigger');
  });

  it('renders live reactive, unknown, stale, crashed, and unsupported fixtures honestly in AgyWorkbenchShell', () => {
    // 1. Live reactive fixture (blocking finite + detached daemon + confirmed child approval)
    const live = createLiveReactiveFixture(baseAgySession.id);
    const liveHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
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
    expect(liveHtml).toContain('pnpm test --filter web');
    expect(liveHtml).toContain('vite dev server (detached)');
    expect(liveHtml).toContain('阻塞轮次');
    expect(liveHtml).toContain('已分离');
    expect(liveHtml).toContain('子 Agent: Codebase Researcher');
    expect(liveHtml).toContain('查看子 Agent');

    // 2. Unknown / unauthenticated fixture
    const unk = createUnknownFixture(baseAgySession.id);
    const unkSubagentsHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={unk.projection}
        capabilities={unk.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'subagents' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(unkSubagentsHtml).toContain('已观察到委派 · 身份待确认');
    expect(unkSubagentsHtml).toContain('当前目标未获得已验证的原生控制能力，已保持只读边界。');

    // 3. Stale / reconciling fixture
    const stale = createStaleReconcilingFixture(baseAgySession.id);
    const staleHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={stale.projection}
        capabilities={stale.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(staleHtml).toContain('重连校准中');
    expect(staleHtml).toContain('旧:运行中');
    expect(staleHtml).toContain('送达未知');
    expect(staleHtml).toContain('来源未确认（保留原生作用域）');

    // 4. Crashed / disconnected fixture
    const crashed = createCrashedDisconnectedFixture(baseAgySession.id);
    const crashedHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={crashed.projection}
        capabilities={crashed.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(crashedHtml).toContain('观测连接已断开');
    expect(crashedHtml).toContain('连接丢失');
    expect(crashedHtml).toContain('原连接已断开，旧审批不会自动重放。');

    // 5. Unsupported / upstream_limited Studios (Swarm, Boost, Teamwork, Dynamic)
    const unsup = createUnsupportedStudiosFixture(baseAgySession.id);
    const swarmHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={unsup.projection}
        capabilities={unsup.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'swarm' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(swarmHtml).toContain('当前 ACP 未提供 Board');
    expect(swarmHtml).toContain('/swarm board');

    const boostHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={unsup.projection}
        capabilities={unsup.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'boost' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(boostHtml).toContain('未获得原生 Boost 阶段证据，已隐藏阶段进度条');

    const teamworkHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={unsup.projection}
        capabilities={unsup.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'teamwork' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(teamworkHtml).toContain('Teamwork 里程碑或原生批准路径未开放');

    const dynamicHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={unsup.projection}
        capabilities={unsup.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(dynamicHtml).toContain('未获得实际依赖图 (DAG)');
  });

  it('supports domain Studio registration override via AgyWorkbenchRegistry without modifying ChatStage', () => {
    const customRegistry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(customRegistry);

    const disposeSwarm = customRegistry.registerView({
      id: 'swarm',
      owner: 'np-08.swarm-studio',
      title: 'Swarm Studio (Domain)',
      shortTitle: 'Swarm',
      description: 'Domain registered Swarm Studio',
      capabilityIds: ['AGY-W04'],
      order: 100,
      render: ({ session }) => <div data-testid="np08-domain-swarm">Custom Swarm for {session.id}</div>,
    });

    const html = renderToStaticMarkup(
      <AgyWorkbenchShell
        registry={customRegistry}
        session={baseAgySession}
        projection={null}
        capabilities={[]}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'swarm' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(html).toContain('np08-domain-swarm');
    expect(html).toContain(`Custom Swarm for ${baseAgySession.id}`);

    // Disposing domain studio cleanly falls back to default degraded shell
    disposeSwarm();
    const fallbackHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        registry={customRegistry}
        session={baseAgySession}
        projection={null}
        capabilities={[]}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'swarm' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(fallbackHtml).not.toContain('np08-domain-swarm');
    expect(fallbackHtml).toContain('Swarm Studio');
  });

  it('renders narrow 480px modal sheet semantics, accessible tabs, and virtualized 10k timeline', () => {
    const narrowHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={null}
        capabilities={[]}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(narrowHtml).toContain('data-testid="agy-workbench-narrow-backdrop"');
    expect(narrowHtml).toContain('role="dialog"');
    expect(narrowHtml).toContain('aria-modal="true"');
    expect(narrowHtml).toContain('role="tablist"');
    expect(narrowHtml).toContain('role="tabpanel"');

    // Virtualized timeline with 10,000 entries renders bounded DOM nodes
    const { timelineEntries } = createStressFixture({ agentCount: 10, eventCount: 10_000, pendingRequestCount: 2 });
    const timelineHtml = renderToStaticMarkup(
      <NativeTimeline entries={timelineEntries} scopeLabel="T18 Stress Timeline" />,
    );
    expect(timelineHtml).toContain('data-total-entries="10000"');
    const renderedMatches = timelineHtml.match(/data-testid="native-timeline-item"/g) ?? [];
    expect(renderedMatches.length).toBeGreaterThan(0);
    expect(renderedMatches.length).toBeLessThanOrEqual(20);

    // Distinct empty states
    const noActivityHtml = renderToStaticMarkup(<NativeTimeline entries={[]} />);
    expect(noActivityHtml).toContain('尚未观察到活动');
    const noSourceHtml = renderToStaticMarkup(
      <NativeTimeline entries={[]} sourceNotProvided sourceUnavailableReason="ACP 未暴露" />,
    );
    expect(noSourceHtml).toContain('该来源不提供');
    expect(noSourceHtml).toContain('ACP 未暴露');
  });

  it('enforces honest gating on AgyAgentModePicker, NativeControlMenu, EvidenceDetails, and ChatStage integration', () => {
    const live = createLiveReactiveFixture(baseAgySession.id);

    // Unverified profile gates all workflow modes to not_tested
    const unverifiedModes = resolveAgyModeOptions(live.capabilities, false);
    expect(unverifiedModes.find((m) => m.id === 'normal')?.gate).toBe('available');
    expect(unverifiedModes.find((m) => m.id === 'swarm')?.gate).toBe('not_tested');

    // Verified profile reflects capability descriptors accurately
    const verifiedModes = resolveAgyModeOptions(live.capabilities, true);
    expect(verifiedModes.find((m) => m.id === 'swarm')?.gate).toBe('available');
    expect(verifiedModes.find((m) => m.id === 'boost')?.gate).toBe('not_tested');

    const pickerHtml = renderToStaticMarkup(
      <AgyAgentModePicker
        selectedModeId="swarm"
        capabilities={live.capabilities}
        profileVerified
        onSelectMode={() => {}}
      />,
    );
    expect(pickerHtml).toContain('模式: Swarm 协作');

    // Control menu enables Stop only when capability control is available
    const enabledCtrlHtml = renderToStaticMarkup(
      <NativeControlMenu
        target={{ type: 'work', id: 'wk_1' }}
        targetLabel="pnpm test"
        capability={live.capabilities.find((c) => c.id === 'AGY-R10')}
        onDispatchControl={async () => {}}
      />,
    );
    expect(enabledCtrlHtml).toContain('原生取消 (Stop)');

    const gatedCtrlHtml = renderToStaticMarkup(
      <NativeControlMenu
        target={{ type: 'agent', id: 'ag_1' }}
        targetLabel="child-1"
        capability={live.capabilities.find((c) => c.id === 'AGY-W01')}
        onDispatchControl={async () => {}}
      />,
    );
    expect(gatedCtrlHtml).toContain('当前目标未获得已验证的原生控制能力，已保持只读边界。');

    // Shared primitives smoke checks
    const evidenceHtml = renderToStaticMarkup(
      <EvidenceDetails
        defaultOpen
        evidence={{
          sourceKind: 'live_protocol',
          freshness: 'fresh',
          observedAt: 1_764_000_000_000,
          wireVariant: 'acp_v1',
        }}
        evidenceRefs={['E02']}
      />,
    );
    expect(evidenceHtml).toContain('Live ACP 协议帧');
    expect(evidenceHtml).toContain('E02');

    const badgeHtml = renderToStaticMarkup(<EntityStatusBadge kind="blocking" blocking="detached" />);
    expect(badgeHtml).toContain('独立后台');

    const unavailableHtml = renderToStaticMarkup(
      <CapabilityUnavailable title="Board 受限" gate="upstream_limited" reason="上游未暴露" />,
    );
    expect(unavailableHtml).toContain('上游协议受限');

    const linkHtml = renderToStaticMarkup(
      <NativeActivityLink
        activity={live.projection.activities[1]!}
        relatedWork={live.projection.work[0]}
        pendingCount={1}
        onOpenWorkbench={() => {}}
      />,
    );
    expect(linkHtml).toContain('原生续跑');
    expect(linkHtml).toContain('1 待处理');

    const reqHtml = renderToStaticMarkup(
      <NativeRequestCard
        approval={live.approvals[0]}
        receipt={live.projection.receipts?.appr_child_1}
        ownerAgent={live.projection.agents[1]}
        onResolve={async () => ({ conflict: false })}
      />,
    );
    expect(reqHtml).toContain('子 Agent: Codebase Researcher');
    expect(reqHtml).not.toContain('允许本次');
    expect(reqHtml).toContain('当前绑定的请求视图');

    // Full ChatStage integration when feature gate is enabled
    useAppStore.setState({
      agyNativeWorkbenchEnabled: true,
      harnesses: [baseAgyHarness],
      sessions: [{ ...baseAgySession, status: 'running' }],
      selectedSessionId: baseAgySession.id,
      draftTextBySession: { [baseAgySession.id]: 'draft preserved while busy' },
    });
    useAppStore.getState().ingestNativeProjectionFixture(baseAgySession.id, live.projection, live.capabilities);
    useAppStore.getState().setNativeWorkbenchRoute(baseAgySession.id, { surface: 'runtime', layout: 'split' });

    const chatEnabledHtml = renderToStaticMarkup(
      <SlotRegistryProvider>
        <SlotSessionProvider session={{ ...baseAgySession, status: 'running' }}>
          <ChatStage />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(chatEnabledHtml).not.toContain('data-testid="agy-runtime-topbar-trigger"'); // No bound AGY UI in this fixture.
    expect(chatEnabledHtml).not.toContain('data-testid="native-continuation-strip"'); // No bound AGY UI in this fixture.
    expect(chatEnabledHtml).not.toContain('data-testid="agy-workbench-shell"'); // No bound AGY UI in this fixture.
    expect(chatEnabledHtml).not.toContain('data-testid="agy-native-composer-status"'); // No bound AGY UI in this fixture.
    expect(chatEnabledHtml).not.toContain('查看正在进行的工作'); // No workbench bound in this fixture.
    expect(chatEnabledHtml).not.toContain('允许本次');
    expect(chatEnabledHtml).toContain('draft preserved while busy');
  });

  it('R4 03a focus utils: traps Tab/Shift+Tab inside narrow sheet, computes tablist navigation, and guards nested popovers on Escape', () => {
    const focusedLog: string[] = [];
    const makeFakeEl = (id: string, opts?: { disabled?: boolean; tabIndex?: number; hidden?: boolean; closestMatch?: boolean }) => {
      const el = {
        id,
        tabIndex: opts?.tabIndex ?? 0,
        hasAttribute: (name: string) =>
          (name === 'disabled' && Boolean(opts?.disabled)) ||
          (name === 'hidden' && Boolean(opts?.hidden)),
        getAttribute: () => null,
        focus: () => {
          focusedLog.push(id);
        },
        closest: () => (opts?.closestMatch ? {} : null),
      } as unknown as HTMLElement;
      return el;
    };

    const btnClose = makeFakeEl('close-btn');
    const tabRuntime = makeFakeEl('tab-runtime');
    const tabSubagents = makeFakeEl('tab-subagents');
    const disabledBtn = makeFakeEl('disabled-btn', { disabled: true });
    const outsideBtn = makeFakeEl('outside-bg-btn');

    const dialogNodes = [btnClose, tabRuntime, tabSubagents, disabledBtn];
    const container = {
      querySelectorAll: () => dialogNodes,
      querySelector: () => null,
      contains: (node: Node | null) => dialogNodes.includes(node as unknown as HTMLElement),
      focus: () => focusedLog.push('container'),
    } as unknown as HTMLElement;

    // 1. Focus enters preferred close button on narrow sheet open
    expect(focusFirstInContainer(container, btnClose)).toBe(btnClose);
    expect(focusedLog.at(-1)).toBe('close-btn');

    // 2. Tab at last focusable wraps to first; Shift+Tab at first wraps to last; outside element redirects inside
    let prevented = 0;
    const makeTabEvent = (shiftKey: boolean) => ({
      key: 'Tab',
      shiftKey,
      preventDefault: () => {
        prevented += 1;
      },
    });
    expect(handleDialogTabTrap(makeTabEvent(false), container, tabSubagents)).toBe(btnClose);
    expect(handleDialogTabTrap(makeTabEvent(true), container, btnClose)).toBe(tabSubagents);
    expect(handleDialogTabTrap(makeTabEvent(false), container, outsideBtn)).toBe(btnClose);
    expect(prevented).toBe(3);

    // 3. Tablist keyboard navigation supports ArrowRight, ArrowLeft, Home, End
    expect(computeNextTabIndex('ArrowRight', 0, 7)).toBe(1);
    expect(computeNextTabIndex('ArrowLeft', 0, 7)).toBe(6);
    expect(computeNextTabIndex('Home', 4, 7)).toBe(0);
    expect(computeNextTabIndex('End', 1, 7)).toBe(6);
    expect(computeNextTabIndex('Enter', 1, 7)).toBeNull();

    // 4. Escape respects defaultPrevented, IME composing, and nested listbox popovers
    expect(
      shouldWorkbenchHandleEscape({ key: 'Escape', defaultPrevented: false, isComposing: false }, container),
    ).toBe(true);
    expect(
      shouldWorkbenchHandleEscape({ key: 'Escape', defaultPrevented: true, isComposing: false }, container),
    ).toBe(false);
    expect(
      shouldWorkbenchHandleEscape({ key: 'Escape', defaultPrevented: false, isComposing: true }, container),
    ).toBe(false);
    const listboxItem = makeFakeEl('opt-1', { closestMatch: true });
    expect(
      shouldWorkbenchHandleEscape(
        { key: 'Escape', defaultPrevented: false, target: listboxItem },
        container,
      ),
    ).toBe(false);
  });

  it('R1/R3 UI regressions: surfaces incomplete sync banner, keeps legacy turn_bg visible when projection is absent, and provides detached fallback viewer when isolated', () => {
    const live = createLiveReactiveFixture(baseAgySession.id);

    // 1. Incomplete sync banner shown in Runtime Center when syncState.phase === 'incomplete'
    const incompleteHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={baseAgySession}
        projection={live.projection}
        syncState={{
          phase: 'incomplete',
          resyncCount: 2,
          droppedStaleEvents: 0,
          incompleteReason: 'seq_gap_unresolved',
          lastError: '事件补缺未完成，请点击重试同步。',
          lastSyncedAt: 1000,
        }}
        capabilities={live.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(incompleteHtml).toContain('数据未完成同步');
    expect(incompleteHtml).toContain('事件补缺未完成，请点击重试同步。');

    // 2. When gate is ON but native projection is absent, legacy turn_bg events MUST remain visible (not hidden)
    const legacyBgEvents = [
      {
        sessionId: baseAgySession.id,
        seq: 1,
        type: 'message.user' as const,
        turnId: 'turn_1',
        createdAt: 1000,
        payload: { text: 'Start job' },
      },
      {
        sessionId: baseAgySession.id,
        seq: 2,
        type: 'message.assistant.completed' as const,
        turnId: 'turn_bg',
        createdAt: 2000,
        payload: { text: 'Legacy background output preserved' },
      },
    ];
    useAppStore.setState({
      agyNativeWorkbenchEnabled: true,
      harnesses: [baseAgyHarness],
      sessions: [baseAgySession],
      selectedSessionId: baseAgySession.id,
      eventsBySession: { [baseAgySession.id]: legacyBgEvents },
      nativeRuntimeBySession: {},
    });
    const noProjHtml = renderToStaticMarkup(
      <SlotRegistryProvider>
        <SlotSessionProvider session={baseAgySession}>
          <ChatStage />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(noProjHtml).toContain('Legacy background output preserved');
    expect(noProjHtml).not.toContain('detached-native-fallback');

    // 3. When live native projection IS active, turn_bg is isolated AND accessible via detached-native-fallback
    useAppStore.getState().ingestNativeProjectionFixture(baseAgySession.id, live.projection, live.capabilities);
    const withLiveProjHtml = renderToStaticMarkup(
      <SlotRegistryProvider>
        <SlotSessionProvider session={baseAgySession}>
          <ChatStage />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(withLiveProjHtml).not.toContain('data-testid="detached-native-fallback"');
    expect(withLiveProjHtml).toContain('Legacy background output preserved'); // An unbound workbench cannot claim native history.
  });
});
