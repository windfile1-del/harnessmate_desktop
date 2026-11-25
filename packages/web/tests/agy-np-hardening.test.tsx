import type { ApprovalRequest, HarnessInfo, Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgyArtifactReviewPanel } from '../src/components/agy/AgyArtifactReviewPanel';
import { AgySettingsSlot } from '../src/components/agy/AgySettingsSlot';
import {
  AgyArtifactReviewWorkspace,
  SafeArtifactContentView,
  createReadOnlyArtifactWorkspaceFixture,
  parseSafeMarkdown,
} from '../src/components/agy/native/review';
import {
  AgyWorkbenchShell,
  NativeTimeline,
  computeNextTabIndex,
  computeVirtualWindow,
  createLiveReactiveFixture,
  createStressFixture,
  createStubNativeTransport,
  handleDialogTabTrap,
  makeFixtureCapabilities,
  shouldWorkbenchHandleEscape,
  DEFAULT_WORKBENCH_ROUTE,
  registerDefaultWorkbenchViews,
  AgyWorkbenchRegistry,
} from '../src/components/agy/native/shared';
import { SubagentManagerView } from '../src/components/agy/native/child/SubagentManagerView';
import { NativeRequestQueuePanel } from '../src/components/agy/native/requests/NativeRequestQueuePanel';
import {
  NativeFeedController,
  applyNativeEventBatch,
  type NativeCanonicalEvent,
} from '../src/lib/native-client';
import { useAppStore } from '../src/stores/app-store';
import { ApiHttpError, daemonApi } from '../src/api/client';

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

const initialStoreState = useAppStore.getState();

afterEach(() => {
  useAppStore.getState().setNativeTransport(null);
  useAppStore.setState(initialStoreState, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const sampleAgySession: Session = {
  id: 'sess_np16_web_1',
  workspaceId: 'ws_np16',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/AppDataCache/np16-web/repo',
  title: 'NP-16 Web Hardening Session',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 1,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1_000,
  updatedAt: 2_000,
};

function makeAgyHarness(id: string): HarnessInfo {
  return {
    id,
    kind: 'agy',
    driverId: 'agy',
    instanceId: id,
    continuationKey: `agy:${id}`,
    displayName: 'Antigravity',
    description: 'AGY profile',
    protocolLabel: 'ACP',
    binaryPath: 'agy.exe',
    version: '1.5.17',
    health: 'ready',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      permissionModes: ['manual', 'accept_edits', 'plan'],
      sessionResume: true,
      sessionFork: false,
      imageInput: true,
      subagents: true,
    },
    models: [{ id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportsReasoningEffort: true }],
    defaultModelId: 'gemini-3.8-flash',
    isCustom: id !== 'agy',
  };
}

describe('NP-16 T17 · Artifact Safe View and Sandbox Boundaries', () => {
  it('neutralizes XSS/javascript-URL/external-image payloads in Artifact Safe View and preserves legacy default-off gates', () => {
    const evilMarkdown = [
      '# Plan Audit',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<svg onload="fetch(\'https://evil.invalid\')"></svg>',
      '<img src="x" onerror="alert(2)">',
      '[Click Me](javascript:alert(3))',
      '![Beacon](https://evil.invalid/t.png)',
      '[Allowed Doc](https://antigravity.google/docs/permissions/)',
    ].join('\n');

    const parsed = parseSafeMarkdown(evilMarkdown);
    expect(parsed.rawHtmlDetected).toBe(true);
    expect(parsed.blockedLinksCount).toBe(1);
    expect(parsed.blockedImagesCount).toBe(1);

    const fixture = createReadOnlyArtifactWorkspaceFixture();
    const viewHtml = renderToStaticMarkup(
      <SafeArtifactContentView
        summary={fixture.artifacts[0]!}
        content={{ ...fixture.selectedContent!, content: evilMarkdown }}
        runtimeStatus="attached"
        featureGates={fixture.featureGates}
        reviewCapability={fixture.reviewCapability}
      />,
    );
    expect(viewHtml).not.toContain('<iframe');
    expect(viewHtml).not.toContain('<svg onload');
    expect(viewHtml).not.toContain('href="javascript:');
    expect(viewHtml).toContain('https://antigravity.google/docs/permissions/');

    // Default UI gate-off check on AgyArtifactReviewPanel & AgySettingsSlot
    const legacyReviewHtml = renderToStaticMarkup(
      <AgyArtifactReviewPanel
        session={sampleAgySession}
        initialArtifacts={[]}
        initialContent={null}
      />,
    );
    expect(legacyReviewHtml).not.toContain('AGY Artifact &amp; Review Workspace');
    expect(legacyReviewHtml).not.toContain('np14-native-approve-btn');

    const gateOffWorkspaceHtml = renderToStaticMarkup(<AgyArtifactReviewWorkspace {...fixture} />);
    expect(gateOffWorkspaceHtml).not.toContain('np14-native-approve-btn');

    const defaultSettingsHtml = renderToStaticMarkup(
      <AgySettingsSlot
        harness={makeAgyHarness('agy')}
        onRefresh={() => {}}
        initialEntries={[
          {
            profile: {
              instanceId: 'agy',
              displayName: 'Antigravity',
              isolationMode: 'official_default',
              authMethod: 'oauth-personal',
              appDataDirName: 'antigravity-cli',
              defaults: {},
              enabled: true,
            },
            authState: {
              instanceId: 'agy',
              isolationMode: 'official_default',
              authMethod: 'oauth-personal',
              phase: 'idle',
            },
          },
        ]}
      />,
    );
    expect(defaultSettingsHtml).not.toContain('np13-native-settings-workspace');
    expect(defaultSettingsHtml).not.toContain('toggle-agy-native-ecosystem');
  });
});

describe('NP-16 T18 · Web Scale Virtualization, Focus, Overflow Observability & Scope Isolation', () => {
  it('reduces 10,000 events deterministically, virtualizes 10k timeline DOM rows, and handles 100 agents + 20 pending requests', () => {
    const stress = createStressFixture({
      sessionId: sampleAgySession.id,
      agentCount: 100,
      eventCount: 10_000,
      pendingRequestCount: 20,
    });
    const caps = makeFixtureCapabilities();

    let proj = stress.projection;
    for (let offset = 0; offset < stress.events.length; offset += 500) {
      proj = applyNativeEventBatch(proj, stress.events.slice(offset, offset + 500)).projection;
    }
    expect(proj.asOfSeq).toBe(10_000);
    expect(proj.agents).toHaveLength(101); // root coordinator + 100 workers
    expect(proj.requestIds).toHaveLength(20);

    // Virtual window bounds rendered DOM rows regardless of 10k list length
    const midWindow = computeVirtualWindow(stress.timelineEntries.length, 24_000, 360, 76, 6);
    expect(midWindow.renderedCount).toBeLessThanOrEqual(20);

    const timelineHtml = renderToStaticMarkup(
      <NativeTimeline entries={stress.timelineEntries} scopeLabel="10k Virtual Timeline" />,
    );
    expect(timelineHtml).toContain('data-total-entries="10000"');
    const renderedAttr = /data-rendered-entries="(\d+)"/.exec(timelineHtml);
    expect(Number(renderedAttr?.[1] ?? '999')).toBeLessThanOrEqual(20);

    // 100-agent tree & 20 concurrent request queue render cleanly
    const subagentHtml = renderToStaticMarkup(
      <SubagentManagerView
        session={sampleAgySession}
        projection={proj}
        syncState={{
          phase: 'live',
          resyncCount: 0,
          droppedStaleEvents: 0,
          lastSyncedAt: 2_000,
          lastError: null,
          incompleteReason: null,
        }}
        capabilities={caps}
        pendingApprovals={stress.approvals}
        route={DEFAULT_WORKBENCH_ROUTE}
        onNavigate={() => {}}
        onRefresh={() => {}}
        onBackToChat={() => {}}
        onSubmitCommand={async () => true}
        onDispatchControl={async () => {}}
        onResolveRequest={async () => {}}
        loadTimeline={async () => ({
          schemaVersion: 1,
          scopeKind: 'agent',
          scopeId: 'ag_stress_root',
          revision: 1,
          items: [],
          nextPageToken: null,
          hasMore: false,
        })}
      />,
    );
    expect(subagentHtml).toContain('已确证父子树 (101)');

    const reqHtml = renderToStaticMarkup(
      <NativeRequestQueuePanel
        title="20 Concurrent Requests"
        projection={proj}
        approvals={stress.approvals}
      />,
    );
    expect(reqHtml).toContain('20 项待处理');
  });

  it('surfaces disconnect & page-limit overflow in NativeFeedController & Workbench UI and clears scope on toggle/session switch', async () => {
    const { projection: snap, capabilities } = createLiveReactiveFixture(sampleAgySession.id);
    const rt = snap.binding.runtimeId;
    const gen = snap.binding.generation;
    const evEvidence = {
      sourceKind: 'live_protocol' as const,
      freshness: 'fresh' as const,
      observedAt: 1_764_000_000_000,
    };

    // 15 events across pageSize=2, max pageLimit=3 -> must stop honestly with `page_limit_reached`
    const pagedEvents: NativeCanonicalEvent[] = Array.from({ length: 15 }, (_, idx) => ({
      schemaVersion: 1,
      runtimeId: rt,
      generation: gen,
      seq: snap.asOfSeq + idx + 1,
      turnId: null,
      createdAt: 1_764_000_000_000 + idx,
      type: 'native.work.changed',
      payload: {
        work: {
          id: `wk_page_${idx}` as never,
          kind: 'finite_command',
          blocking: 'confirmed_blocking',
          state: { kind: 'known', value: 'running', evidence: evEvidence },
          observedLabel: `task-${idx}`,
          revision: idx + 1,
        },
      },
    }));

    const transport = createStubNativeTransport({
      snapshot: snap,
      capabilities,
      events: pagedEvents,
      pageSize: 2,
    });
    const controller = new NativeFeedController({
      sessionId: sampleAgySession.id,
      transport,
      batchWindowMs: 0,
      pageLimit: 2,
      maxPages: 3,
      onUpdate: () => {},
    });
    await controller.hydrate();
    const overflowSnap = controller.getSnapshot();
    expect(overflowSnap.syncState.phase).toBe('incomplete');
    expect(overflowSnap.syncState.incompleteReason).toBe('page_limit_reached');
    controller.dispose();

    // Workbench shell renders BOTH disconnected state notice and incomplete sync notice
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);
    const disconnectedHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        registry={registry}
        session={sampleAgySession}
        projection={{ ...snap, status: 'disconnected' }}
        syncState={overflowSnap.syncState}
        capabilities={capabilities}
        pendingApprovals={[]}
        route={{ surface: 'runtime', layout: 'split' }}
        onNavigate={() => {}}
        onRefresh={() => {}}
        onBackToChat={() => {}}
        onSubmitCommand={async () => true}
        onDispatchControl={async () => {}}
        onResolveRequest={async () => {}}
      />,
    );
    expect(disconnectedHtml).toContain('数据未完成同步');
    expect(disconnectedHtml).toContain('观测连接已断开');

    // Focus helpers preserve accessibility traps and never hijack IME or nested menus
    expect(shouldWorkbenchHandleEscape({ key: 'Escape', defaultPrevented: false, isComposing: true }, null)).toBe(false);
    expect(computeNextTabIndex('ArrowRight', 6, 7)).toBe(0);
    expect(computeNextTabIndex('ArrowLeft', 0, 7)).toBe(6);

    const preventDefault = vi.fn();
    const firstFocus = vi.fn();
    const lastFocus = vi.fn();
    const fakeFirst = {
      tagName: 'BUTTON',
      tabIndex: 0,
      hasAttribute: () => false,
      getAttribute: () => null,
      focus: firstFocus,
    } as unknown as HTMLElement;
    const fakeLast = {
      tagName: 'BUTTON',
      tabIndex: 0,
      hasAttribute: () => false,
      getAttribute: () => null,
      focus: lastFocus,
    } as unknown as HTMLElement;
    const fakeContainer = {
      querySelectorAll: () => [fakeFirst, fakeLast],
      contains: (el: Element | null) => el === fakeFirst || el === fakeLast,
      focus: vi.fn(),
    } as unknown as HTMLElement;
    handleDialogTabTrap({ key: 'Tab', shiftKey: false, preventDefault }, fakeContainer, fakeLast);
    expect(firstFocus).toHaveBeenCalledOnce();

    // Concurrent resolve conflict refreshes state cleanly without leaving stale pending approval
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const resolveMock = vi
      .spyOn(daemonApi, 'resolveRuntimeRequest')
      .mockRejectedValueOnce(new ApiHttpError('already resolved', 409, { code: 'ALREADY_RESOLVED', resolvedBy: 'mobile' }));

    const reqApproval: ApprovalRequest = {
      id: 'appr_race_1',
      sessionId: sampleAgySession.id,
      nativeRequestId: 'nat_1',
      toolName: 'Bash',
      toolKind: 'shell',
      summary: 'Concurrent race test',
      input: {},
      riskLevel: 'high',
      status: 'pending',
      createdAt: 1000,
    };

    useAppStore.setState({
      agyNativeWorkbenchEnabled: true,
      sessions: [sampleAgySession],
      pendingApprovals: [reqApproval],
      nativeRuntimeBySession: {
        [sampleAgySession.id]: {
          projection: snap,
          capabilities,
          syncState: {
            phase: 'live',
            resyncCount: 0,
            droppedStaleEvents: 0,
            lastSyncedAt: 1000,
            lastError: null,
            incompleteReason: null,
          },
          route: DEFAULT_WORKBENCH_ROUTE,
          commandReceipts: [],
        },
      },
    });

    const outcome = await useAppStore.getState().resolveRuntimeRequest('appr_race_1', {
      decision: 'allow_once',
      resolvedBy: 'desktop',
    });
    expect(outcome).toEqual({ conflict: true, resolvedBy: 'mobile' });
    expect(resolveMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().pendingApprovals).toHaveLength(0);

    // Clear session / disable native gate resets scope state cleanly
    useAppStore.getState().clearNativeSessionState(sampleAgySession.id);
    expect(useAppStore.getState().nativeRuntimeBySession[sampleAgySession.id]).toBeUndefined();

    useAppStore.getState().setAgyNativeWorkbenchEnabled(false);
    expect(useAppStore.getState().agyNativeWorkbenchEnabled).toBe(false);
  });
});
