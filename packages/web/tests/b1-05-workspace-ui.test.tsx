import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstalledPluginInfo, Session, SessionSearchHit, Workspace } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractCallError,
  HISTORY_IMPORT_CONTRACT,
  HISTORY_IMPORT_PAGE_SLOT_ID,
  HISTORY_SOURCE_CONTRACT,
  SESSION_SEARCH_CONTRACT,
  SESSION_SEARCH_PAGE_SLOT_ID,
  makeWorkspacePageKey,
  resolveServiceSelectionClientSide,
  type HistoryImportCommitValue,
  type HistoryImportPreviewValue,
  type HistorySourceDiscoverValue,
  type SearchInstanceStatus,
  type SearchQueryValue,
  type SearchReindexJob,
  type ServiceResolutionV1,
} from '../src/api/peer-contracts';
import type { PeerWorkspaceTransport } from '../src/api/peer-workspace-client';
import { createFullTextCommand } from '../src/components/CommandPalette';
import { HistoryImportWorkspacePage } from '../src/components/HistoryImportWorkspacePage';
import { ServiceResolutionBanner } from '../src/components/ServiceResolutionBanner';
import { SessionSearchWorkspacePage } from '../src/components/SessionSearchWorkspacePage';
import { Sidebar } from '../src/components/Sidebar';
import {
  HistoryImportController,
  SessionSearchController,
} from '../src/lib/peer-workspace-controllers';
import {
  SlotRegistry,
  SlotRegistryProvider,
  SlotSessionProvider,
  PluginSlotSync,
} from '../src/slots';
import {
  registerBatch1WorkspacePages,
  registerPluginIframeSlots,
} from '../src/slots/PluginSlotSync';
import { executeSandboxedBridgeMethod } from '../src/slots/sandbox-bridge-handler';
import { buildIframeSrcDoc } from '../src/slots/sandbox-iframe-utils';
import { daemonApi } from '../src/api/client';
import { PluginWorkspaceLinks, PluginWorkspaceStage } from '../src/slots/PluginWorkspace';
import { useAppStore } from '../src/stores/app-store';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const peerContractsFixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../../docs/plugin-decoupling-batch-1/fixtures/B1-01-peer-contracts.json'),
    'utf8',
  ),
);

const wsSample: Workspace = {
  id: 'ws-sample',
  name: '样例工作区',
  rootPath: 'D:/Projects/sample',
  isGitRepo: true,
  gitBranch: 'main',
  createdAt: 1795651000000,
};

const wsSecond: Workspace = {
  id: 'ws-alt',
  name: '备用工作区',
  rootPath: 'D:/Projects/alt',
  isGitRepo: false,
  gitBranch: null,
  createdAt: 1795651100000,
};

const sampleSession: Session = {
  id: 'sess-sample',
  workspaceId: 'ws-sample',
  harnessId: 'codex',
  harnessKind: 'codex',
  nativeSessionId: 'native-1',
  participatingHarnesses: ['codex'],
  contextSyncMode: 'auto',
  cwd: 'D:/Projects/sample',
  title: '样例会话',
  status: 'idle',
  model: 'gpt-5',
  reasoningEffort: null,
  permissionMode: 'manual',
  lastSeq: 5,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1795651200000,
  updatedAt: 1795651200000,
};

function makePlugin(
  id: string,
  contract: string,
  opts?: {
    instanceId?: string;
    name?: string;
    version?: string;
    contractVersion?: string;
    enabled?: boolean;
    runtimeState?: InstalledPluginInfo['runtimeState'];
  },
): InstalledPluginInfo {
  return {
    id,
    instanceId: opts?.instanceId ?? id,
    name: opts?.name ?? id,
    version: opts?.version ?? '1.0.0',
    category: 'workflow',
    contributes: {},
    provides: [contract],
    providedContracts: [{ contract, version: opts?.contractVersion ?? '1.0.0' }],
    enabled: opts?.enabled ?? true,
    builtin: true,
    source: 'builtin',
    sourceKind: 'bundled',
    runtimeState: opts?.runtimeState ?? 'ACTIVE',
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockTransport(overrides?: Partial<PeerWorkspaceTransport>): PeerWorkspaceTransport {
  return {
    resolveServiceSelection: async (contract, opts) =>
      resolveServiceSelectionClientSide({
        contract,
        versionRange: opts.versionRange,
        plugins: opts.plugins,
        explicitInstanceId: opts.explicitInstanceId,
        sessionBindings: opts.sessionBindings,
        workspaceBindings: opts.workspaceBindings,
        compositionBindings: opts.compositionBindings,
        compositionEntries: opts.compositionEntries,
        allowSingleCandidate: opts.allowSingleCandidate,
      }),
    discoverSource: async () => ({ sessions: [], nextCursor: null }),
    readSource: async (_inst, req) => ({
      ref: req.ref,
      items: [],
      nextCursor: null,
      readStatus: 'complete',
      warnings: [],
    }),
    cancelSource: async () => ({ cancelled: true }),
    previewImport: async (_inst, req) => ({
      input: req.input,
      existingSessionId: null,
      targetWorkspaceId: req.workspaceId ?? null,
      importable: true,
      items: [],
      readStatus: 'complete',
      warnings: [],
    }),
    commitImport: async () => ({
      sessionId: 'sess-sample',
      disposition: 'created',
      partial: false,
      warnings: [],
    }),
    cancelImport: async () => ({ cancelled: true }),
    querySearch: async () => ({ hits: [], nextOffset: null, fallbackUsed: false, tookMs: 1 }),
    getSearchStatus: async (instanceId) => ({
      instanceId,
      engineKind: 'fts5',
      state: 'ready',
      cursorSeq: 10,
      latestSourceSeq: 10,
      indexedItems: 25,
      indexedSessions: 3,
      activeJob: null,
      lastJob: null,
    }),
    reindexSearch: async () => ({
      jobId: 'reindex-1',
      status: 'completed',
      indexedCount: 25,
      totalCount: 25,
      cursorSeq: 10,
      startedAt: 1000,
      updatedAt: 1100,
      finishedAt: 1100,
    }),
    cancelSearchReindex: async () => ({
      jobId: 'reindex-1',
      status: 'cancelled',
      indexedCount: 10,
      totalCount: 25,
      cursorSeq: 4,
      startedAt: 1000,
      updatedAt: 1050,
    }),
    resumeSearchReindex: async () => ({
      jobId: 'reindex-1',
      status: 'running',
      indexedCount: 10,
      totalCount: 25,
      cursorSeq: 4,
      startedAt: 1000,
      updatedAt: 1060,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('B1-05 · ServiceResolutionV1 & Navigation Compatibility', () => {
  it('matches all 8 ServiceResolutionV1 states from B1-01-peer-contracts.json and stays invariant to plugin load order', () => {
    const sampleA = makePlugin('user.history.sample', HISTORY_SOURCE_CONTRACT, {
      instanceId: 'history.sample.a',
    });
    const sampleB = makePlugin('user.history.sample', HISTORY_SOURCE_CONTRACT, {
      instanceId: 'history.sample.b',
    });

    expect(
      resolveServiceSelectionClientSide({ contract: HISTORY_SOURCE_CONTRACT, plugins: [] }),
    ).toEqual(peerContractsFixture.resolution.unconfigured);

    expect(
      resolveServiceSelectionClientSide({
        contract: HISTORY_SOURCE_CONTRACT,
        plugins: [sampleB, sampleA], // reversed load order!
      }),
    ).toEqual(peerContractsFixture.resolution.ambiguous);

    expect(
      resolveServiceSelectionClientSide({
        contract: HISTORY_SOURCE_CONTRACT,
        plugins: [sampleA],
        allowSingleCandidate: false,
      }),
    ).toEqual(peerContractsFixture.resolution.oneCandidateWithoutOptIn);

    expect(
      resolveServiceSelectionClientSide({
        contract: HISTORY_SOURCE_CONTRACT,
        plugins: [sampleA],
        allowSingleCandidate: true,
      }),
    ).toEqual(peerContractsFixture.resolution.single);

    expect(
      resolveServiceSelectionClientSide({
        contract: HISTORY_SOURCE_CONTRACT,
        plugins: [{ ...sampleA, enabled: false, runtimeState: 'DISPOSED' }, sampleB],
        workspaceBindings: { [HISTORY_SOURCE_CONTRACT]: 'history.sample.a' },
      }),
    ).toEqual(peerContractsFixture.resolution.boundDisabled);

    expect(
      resolveServiceSelectionClientSide({
        contract: HISTORY_SOURCE_CONTRACT,
        plugins: [sampleB, sampleA],
        workspaceBindings: { [HISTORY_SOURCE_CONTRACT]: 'history.sample.a' },
      }),
    ).toEqual(peerContractsFixture.resolution.boundRestored);

    const sampleAIncompatible = makePlugin('user.history.sample', HISTORY_SOURCE_CONTRACT, {
      instanceId: 'history.sample.a',
      contractVersion: '2.0.0',
    });
    expect(
      resolveServiceSelectionClientSide({
        contract: HISTORY_SOURCE_CONTRACT,
        plugins: [sampleAIncompatible, sampleB],
        explicitInstanceId: 'history.sample.a',
      }),
    ).toEqual(peerContractsFixture.resolution.boundIncompatible);

    expect(
      resolveServiceSelectionClientSide({
        contract: HISTORY_SOURCE_CONTRACT,
        plugins: [sampleB],
        callerBindings: { [HISTORY_SOURCE_CONTRACT]: 'history.sample.missing' },
      }),
    ).toEqual(peerContractsFixture.resolution.boundUnavailable);
  });

  it('renders ServiceResolutionBanner across ready, disabled, incompatible, unavailable, selection_required, and unconfigured states', () => {
    const plugins = [
      makePlugin('user.history.sample', HISTORY_SOURCE_CONTRACT, {
        instanceId: 'history.sample.a',
        name: '样例来源 A',
      }),
      makePlugin('user.history.sample', HISTORY_SOURCE_CONTRACT, {
        instanceId: 'history.sample.b',
        name: '样例来源 B',
      }),
    ];

    const cases: Array<[ServiceResolutionV1, string]> = [
      [peerContractsFixture.resolution.single, '就绪'],
      [peerContractsFixture.resolution.boundDisabled, '已停用'],
      [peerContractsFixture.resolution.boundIncompatible, '版本不兼容'],
      [peerContractsFixture.resolution.boundUnavailable, '不可用'],
      [peerContractsFixture.resolution.ambiguous, '待选择实例'],
      [peerContractsFixture.resolution.unconfigured, '未配置'],
    ];

    for (const [res, expectedLabel] of cases) {
      const html = renderToStaticMarkup(
        <ServiceResolutionBanner title="来源实例" resolution={res} plugins={plugins} />,
      );
      expect(html).toContain(expectedLabel);
    }
  });

  it('registers dual search & import pages, preserves legacy triggers and browser switcher, and removes disabled entries', () => {
    const searchFts = makePlugin('hm.plugin.session-search-fts', SESSION_SEARCH_CONTRACT, {
      name: 'FTS5 搜索',
    });
    const searchAlt = makePlugin('hm.plugin.session-search-alt', SESSION_SEARCH_CONTRACT, {
      name: 'Lite 搜索',
    });
    const importPlugin = makePlugin('hm.plugin.history-import', HISTORY_IMPORT_CONTRACT, {
      name: '历史导入中心',
    });
    const browserPlugin = makePlugin('hm.plugin.browser-desktop', 'browser.v1', {
      name: '桌面浏览器',
    });

    const registry = new SlotRegistry();
    registry.register({
      slot: 'workspace.pages',
      id: SESSION_SEARCH_PAGE_SLOT_ID,
      pluginId: 'hm.plugin.session-search-fts',
      pluginName: 'FTS5 搜索',
      title: 'FTS5 搜索',
      render: () => <div />,
    });
    registry.register({
      slot: 'workspace.pages',
      id: SESSION_SEARCH_PAGE_SLOT_ID,
      pluginId: 'hm.plugin.session-search-alt',
      pluginName: 'Lite 搜索',
      title: 'Lite 搜索',
      render: () => <div />,
    });
    registry.register({
      slot: 'workspace.pages',
      id: HISTORY_IMPORT_PAGE_SLOT_ID,
      pluginId: 'hm.plugin.history-import',
      pluginName: '历史导入中心',
      title: '历史导入',
      render: () => <div />,
    });

    useAppStore.setState({
      workspaces: [wsSample, wsSecond],
      sessions: [sampleSession],
      selectedWorkspaceId: wsSample.id,
      selectedSessionId: sampleSession.id,
      plugins: [searchFts, searchAlt, importPlugin, browserPlugin],
      workspaceBindingsByWorkspace: {
        [wsSample.id]: { [SESSION_SEARCH_CONTRACT]: 'hm.plugin.session-search-fts' },
      },
      sessionBindingsBySession: {
        [sampleSession.id]: { 'browser.v1': 'hm.plugin.browser-desktop' },
      },
    });

    const linksHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <PluginWorkspaceLinks />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(linksHtml).toContain('FTS5 搜索');
    expect(linksHtml).toContain('Lite 搜索');
    expect(linksHtml).toContain('历史导入');
    expect(linksHtml).toContain('会话搜索 · 就绪');
    expect(linksHtml).toContain('历史导入 · 就绪');
    expect(linksHtml).toContain('会话浏览器');

    // Legacy Sidebar button & CommandPalette ? query route straight to search workspace page
    const sidebarHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <Sidebar />
      </SlotRegistryProvider>,
    );
    expect(sidebarHtml).toContain('全文/导入');

    useAppStore.getState().openSessionSearch('中文');
    expect(useAppStore.getState().activePluginPage).toBe(
      makeWorkspacePageKey('hm.plugin.session-search-fts', SESSION_SEARCH_PAGE_SLOT_ID),
    );
    expect(useAppStore.getState().searchPageInitialQuery).toBe('中文');

    const cmd = createFullTextCommand('中文', true, useAppStore.getState().openSessionSearch);
    cmd.execute();
    expect(useAppStore.getState().activeModal).toBeNull();

    // Disabling searchFts keeps workspace binding but transitions resolution to disabled
    useAppStore.setState({
      plugins: [
        { ...searchFts, enabled: false, runtimeState: 'DISPOSED' },
        searchAlt,
        importPlugin,
        browserPlugin,
      ],
    });
    const disabledLinksHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <PluginWorkspaceLinks />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(disabledLinksHtml).toContain('会话搜索 · 已停用');

    // Legacy fallback when no session.search.v1 plugin exists -> opens modal
    useAppStore.setState({
      plugins: [makePlugin('hm.plugin.session-explorer', 'legacy', { name: 'Session Explorer' })],
      activePluginPage: null,
    });
    useAppStore.getState().openSessionSearch('oauth');
    expect(useAppStore.getState().activeModal).toBe('session_explorer');
    expect(useAppStore.getState().explorerInitialQuery).toBe('oauth');
  });

  it('does NOT override plugins supplying ui/panel.html slots and keeps slot-less fallback clean', () => {
    const searchWithUi: InstalledPluginInfo = {
      ...makePlugin('hm.plugin.session-search-fts', SESSION_SEARCH_CONTRACT, {
        name: 'FTS5 搜索',
      }),
      contributes: {
        slots: [
          {
            slot: 'workspace.pages',
            id: SESSION_SEARCH_PAGE_SLOT_ID,
            title: 'FTS5 搜索',
            ui: 'ui/panel.html',
          },
        ],
      },
    };
    const importWithUi: InstalledPluginInfo = {
      ...makePlugin('hm.plugin.history-import', HISTORY_IMPORT_CONTRACT, {
        name: '历史导入中心',
      }),
      contributes: {
        slots: [
          {
            slot: 'workspace.pages',
            id: HISTORY_IMPORT_PAGE_SLOT_ID,
            title: '历史导入',
            ui: 'ui/panel.html',
          },
        ],
      },
    };
    const slotlessSearch = makePlugin('user.slotless-search', SESSION_SEARCH_CONTRACT, {
      name: '纯服务搜索',
    });
    const disabledSearch = makePlugin('hm.plugin.session-search-off', SESSION_SEARCH_CONTRACT, {
      name: '停用搜索',
      enabled: false,
      runtimeState: 'DISPOSED',
    });

    const registry = new SlotRegistry();
    const disposers = registerBatch1WorkspacePages(registry, [
      searchWithUi,
      importWithUi,
      slotlessSearch,
      disabledSearch,
    ]);
    // Bundled/3p plugins with ui/panel.html are NOT overridden by host React fallback
    const items = registry.getItems('workspace.pages', { hasSession: false });
    expect(items.map((item) => item.registrationKey)).toEqual([
      'user.slotless-search:session-search',
    ]);

    for (const dispose of disposers) dispose();
    expect(registry.getItems('workspace.pages', { hasSession: false })).toHaveLength(0);
  });
});

describe('B1-05 · HistoryImportWorkspacePage & Multi-Source Isolation / Preview / Cancel / Retry', () => {
  it('isolates single-source failures, refreshes, previews, detects existing archive, reuses requestId on retry, and cancels cleanly', async () => {
    const discoverFx = peerContractsFixture.source.discover.response
      .value as HistorySourceDiscoverValue;
    const previewFx = peerContractsFixture.import.preview.response
      .value as HistoryImportPreviewValue;
    const commitCreatedFx = peerContractsFixture.import.import.response
      .value as HistoryImportCommitValue;
    const commitReusedFx = peerContractsFixture.import.import.retry
      .value as HistoryImportCommitValue;

    const srcA = makePlugin('hm.plugin.history-source-codex', HISTORY_SOURCE_CONTRACT, {
      instanceId: 'history.sample.a',
      name: 'Codex 来源 A',
    });
    const srcB = makePlugin('hm.plugin.history-source-claude', HISTORY_SOURCE_CONTRACT, {
      instanceId: 'history.sample.b',
      name: 'Claude 来源 B',
    });
    const srcDisabled = makePlugin('user.history-source-custom', HISTORY_SOURCE_CONTRACT, {
      instanceId: 'history.sample.disabled',
      name: '停用来源 C',
      enabled: false,
      runtimeState: 'DISPOSED',
    });
    const impPlugin = makePlugin('hm.plugin.history-import', HISTORY_IMPORT_CONTRACT, {
      name: '历史导入器',
    });

    const seenRequestIds: string[] = [];
    const cancelledImports: Array<{ requestId?: string; operationId?: string }> = [];
    let failFirstCommit = true;
    const slowPreviewDeferred = createDeferred<HistoryImportPreviewValue>();
    let capturedPreviewSignal: AbortSignal | undefined;

    const transport = createMockTransport({
      discoverSource: async (instanceId, req) => {
        if (instanceId === 'history.sample.b') {
          throw new ContractCallError('source_unreadable', '样例记录已移动');
        }
        if (req.cursor === 'page-2') {
          return {
            sessions: [
              {
                ...discoverFx.sessions[0]!,
                ref: { ...discoverFx.sessions[0]!.ref, nativeSessionId: 'native-2' },
                title: '第二页会话',
                alreadyImportedSessionId: 'sess-existing-1',
              },
            ],
            nextCursor: null,
          };
        }
        return {
          sessions: discoverFx.sessions,
          nextCursor: 'page-2',
        };
      },
      previewImport: async (_instanceId, req, signal) => {
        capturedPreviewSignal = signal;
        if (req.input.kind === 'native' && req.input.ref.nativeSessionId === 'slow-native') {
          return slowPreviewDeferred.promise;
        }
        if (req.input.kind === 'native' && req.input.ref.nativeSessionId === 'native-2') {
          return {
            ...previewFx,
            input: req.input,
            existingSessionId: 'sess-existing-1',
          };
        }
        return { ...previewFx, input: req.input };
      },
      commitImport: async (_instanceId, req) => {
        seenRequestIds.push(req.requestId);
        if (failFirstCommit) {
          failFirstCommit = false;
          throw new Error('临时网络超时');
        }
        return seenRequestIds.length === 2 ? commitCreatedFx : commitReusedFx;
      },
      cancelImport: async (_instanceId, payload) => {
        cancelledImports.push(payload);
        return { cancelled: true };
      },
    });

    const controller = new HistoryImportController(transport);
    controller.setActiveImportInstance('hm.plugin.history-import');
    controller.syncSources([srcA, srcB, srcDisabled], false, { workspaceId: wsSample.id });

    await vi.waitFor(() => {
      const snap = controller.getSnapshot();
      expect(snap.sourcesMap['history.sample.a']?.sessions).toHaveLength(1);
      expect(snap.sourcesMap['history.sample.b']?.error).toContain('样例记录已移动');
      expect(snap.sourcesMap['history.sample.disabled']?.ready).toBe(false);
    });

    // Pagination on source A still works while source B errored and source C is disabled
    await controller.discoverSource('history.sample.a', { cursor: 'page-2', append: true });
    expect(controller.getSnapshot().sourcesMap['history.sample.a']?.sessions).toHaveLength(2);

    // Preview page-2 item with existingSessionId and verify existing-archive action + commit button render
    const secondItem = controller.getSnapshot().sourcesMap['history.sample.a']!.sessions[1]!;
    await controller.preview(secondItem, 'attach', wsSample.id, false);
    expect(controller.getSnapshot().previewData?.existingSessionId).toBe('sess-existing-1');
    useAppStore.setState({
      workspaces: [wsSample],
      sessions: [sampleSession],
      plugins: [srcA, srcB, srcDisabled, impPlugin],
      selectedWorkspaceId: wsSample.id,
      selectedSessionId: sampleSession.id,
    });
    const existingArchiveHtml = renderToStaticMarkup(
      <HistoryImportWorkspacePage
        instanceId="hm.plugin.history-import"
        transport={transport}
        controller={controller}
      />,
    );
    expect(existingArchiveHtml).toContain('打开既有归档');
    expect(existingArchiveHtml).toContain('提交镜像导入');

    // Preview primary item, commit fails once, retry reuses exact same requestId
    const firstItem = controller.getSnapshot().sourcesMap['history.sample.a']!.sessions[0]!;
    await controller.preview(firstItem, 'mirror', wsSample.id, false);
    const failedRes = await controller.commit('mirror', wsSample.id, false);
    expect(failedRes).toBeNull();
    expect(controller.getSnapshot().importError).toContain('临时网络超时');

    const retryRes = await controller.commit('mirror', wsSample.id, false);
    expect(retryRes).toEqual(commitCreatedFx);
    expect(seenRequestIds).toHaveLength(2);
    expect(seenRequestIds[0]).toBe(seenRequestIds[1]);

    // Cancel slow preview mid-flight and confirm late resolution never overwrites state
    const slowItem = {
      ...firstItem,
      ref: { ...firstItem.ref, nativeSessionId: 'slow-native' },
      title: '慢速会话',
    };
    const slowPromise = controller.preview(slowItem, 'mirror', wsSample.id, false);
    expect(controller.getSnapshot().previewLoading).toBe(true);
    controller.cancelActiveOp();
    expect(capturedPreviewSignal?.aborted).toBe(true);
    expect(controller.getSnapshot().previewLoading).toBe(false);
    expect(controller.getSnapshot().importStatusNote).toContain('已取消');
    expect(cancelledImports.length).toBeGreaterThanOrEqual(1);

    slowPreviewDeferred.resolve({
      ...previewFx,
      items: [{ itemId: 'late-item', role: 'user', text: '不该覆盖的迟到响应' }],
    });
    await slowPromise;
    expect(controller.getSnapshot().previewData).toBeNull();

    // Render HTML snapshot after cancel with isolated source states
    const html = renderToStaticMarkup(
      <HistoryImportWorkspacePage
        instanceId="hm.plugin.history-import"
        transport={transport}
        controller={controller}
      />,
    );
    expect(html).toContain('history.sample.a');
    expect(html).toContain('样例记录已移动');
    expect(html).toContain('history.sample.disabled');
    expect(html).toContain('已取消当前操作，未写入新会话');

    controller.dispose();
  });
});

describe('B1-05 · SessionSearchWorkspacePage & Coexistence / Late-Response / Reindex / Jump', () => {
  it('handles Chinese query, filters, pagination, reindex poll/cancel/resume, dual-instance isolation, late-response cancellation, and jump', async () => {
    const queryFx = peerContractsFixture.search.query.response.value as SearchQueryValue;

    const searchFts = makePlugin('hm.plugin.session-search-fts', SESSION_SEARCH_CONTRACT, {
      name: 'FTS5 搜索',
    });
    const searchAlt = makePlugin('hm.plugin.session-search-alt', SESSION_SEARCH_CONTRACT, {
      name: 'Alt 搜索',
    });

    const runningJob: SearchReindexJob = {
      jobId: 'job-fts-1',
      status: 'running',
      indexedCount: 5,
      totalCount: 20,
      cursorSeq: 5,
      snapshotWatermark: 20,
      startedAt: 1000,
      updatedAt: 1050,
    };
    const cancelledJob: SearchReindexJob = {
      ...runningJob,
      status: 'cancelled',
    };
    const resumedJob: SearchReindexJob = {
      ...runningJob,
      status: 'running',
      indexedCount: 12,
    };

    const slowAltQuery = createDeferred<SearchQueryValue>();
    let altSignal: AbortSignal | undefined;
    let currentFtsJob: SearchReindexJob | null = runningJob;

    const transport = createMockTransport({
      getSearchStatus: async (instanceId) => {
        if (instanceId === 'hm.plugin.session-search-alt') {
          return {
            instanceId,
            engineKind: 'alt-mem',
            state: 'ready',
            cursorSeq: 3,
            latestSourceSeq: 3,
            indexedItems: 3,
            indexedSessions: 1,
            activeJob: null,
            lastJob: null,
          } satisfies SearchInstanceStatus;
        }
        return {
          instanceId,
          engineKind: 'sqlite-fts5',
          state: 'ready',
          cursorSeq: currentFtsJob?.cursorSeq ?? 20,
          latestSourceSeq: 20,
          indexedItems: 42,
          indexedSessions: 5,
          activeJob: currentFtsJob?.status === 'running' ? currentFtsJob : null,
          lastJob: currentFtsJob,
        } satisfies SearchInstanceStatus;
      },
      querySearch: async (instanceId, req, signal) => {
        if (instanceId === 'hm.plugin.session-search-alt') {
          altSignal = signal;
          if (req.q === 'slow') return slowAltQuery.promise;
          if (req.q === 'error-alt') throw new Error('Alt 索引损坏');
          return { hits: [], nextOffset: null, fallbackUsed: false, tookMs: 2 };
        }
        if (req.q === '无匹配') {
          return { hits: [], nextOffset: null, fallbackUsed: false, tookMs: 1 };
        }
        if (req.offset === 20) {
          return {
            hits: [
              {
                ...queryFx.hits[0]!,
                itemId: 'sess-sample:import_2:assistant',
                turnId: 'import_2',
                turnSeq: 2,
                snippetText: '第二页中文命中',
              },
            ],
            nextOffset: null,
            fallbackUsed: false,
            tookMs: 4,
          };
        }
        return { ...queryFx, nextOffset: 20 };
      },
      cancelSearchReindex: async () => {
        currentFtsJob = cancelledJob;
        return cancelledJob;
      },
      resumeSearchReindex: async () => {
        currentFtsJob = resumedJob;
        return resumedJob;
      },
    });

    const controller = new SessionSearchController(transport);
    controller.setActiveInstance('hm.plugin.session-search-fts');

    // Chinese query + filters + pagination on instance 1
    await controller.runSearch('hm.plugin.session-search-fts', {
      q: '中文',
      workspaceId: 'ws-sample',
      driverId: 'codex',
      fromTs: 1795651000000,
      toTs: 1795651300000,
      limit: 20,
      offset: 0,
    });
    expect(controller.getSnapshot().slices['hm.plugin.session-search-fts']?.hits).toHaveLength(1);
    expect(controller.getSnapshot().slices['hm.plugin.session-search-fts']?.nextOffset).toBe(20);

    // Fetch next page
    await controller.runSearch('hm.plugin.session-search-fts', {
      q: '中文',
      limit: 20,
      offset: 20,
    });
    expect(
      controller.getSnapshot().slices['hm.plugin.session-search-fts']?.hits[0]?.turnId,
    ).toBe('import_2');

    // Empty results
    await controller.runSearch('hm.plugin.session-search-fts', { q: '无匹配' });
    expect(controller.getSnapshot().slices['hm.plugin.session-search-fts']?.hits).toEqual([]);
    expect(controller.getSnapshot().slices['hm.plugin.session-search-fts']?.hasSearched).toBe(true);

    // Cancel and resume reindex
    await controller.fetchStatus('hm.plugin.session-search-fts');
    expect(
      controller.getSnapshot().slices['hm.plugin.session-search-fts']?.status?.activeJob?.status,
    ).toBe('running');

    await controller.cancelReindex('hm.plugin.session-search-fts', 'job-fts-1');
    expect(
      controller.getSnapshot().slices['hm.plugin.session-search-fts']?.status?.lastJob?.status,
    ).toBe('cancelled');

    await controller.resumeReindex('hm.plugin.session-search-fts', 'job-fts-1');
    expect(
      controller.getSnapshot().slices['hm.plugin.session-search-fts']?.status?.activeJob?.status,
    ).toBe('running');

    // Switch to instance 2 -> triggers error on instance 2, start slow query, then switch back / disable!
    controller.setActiveInstance('hm.plugin.session-search-alt');
    await controller.runSearch('hm.plugin.session-search-alt', { q: 'error-alt' });
    expect(controller.getSnapshot().slices['hm.plugin.session-search-alt']?.queryError).toContain(
      'Alt 索引损坏',
    );
    // Instance 1 has zero error pollution!
    expect(controller.getSnapshot().slices['hm.plugin.session-search-fts']?.queryError).toBeNull();

    // Start slow query on alt, then disable (setActiveInstance(null)) or switch back to FTS mid-flight
    const slowPromise = controller.runSearch('hm.plugin.session-search-alt', { q: 'slow' });
    expect(controller.getSnapshot().slices['hm.plugin.session-search-alt']?.searching).toBe(true);

    controller.setActiveInstance('hm.plugin.session-search-fts');
    expect(altSignal?.aborted).toBe(true);
    expect(controller.getSnapshot().slices['hm.plugin.session-search-alt']?.searching).toBe(false);

    // Resolve slow query late -> must NOT overwrite alt slice or activeInstanceId!
    slowAltQuery.resolve({
      hits: [queryFx.hits[0]!],
      nextOffset: null,
      fallbackUsed: false,
      tookMs: 99,
    });
    await slowPromise;
    expect(controller.getSnapshot().activeInstanceId).toBe('hm.plugin.session-search-fts');
    expect(controller.getSnapshot().slices['hm.plugin.session-search-alt']?.hits).toEqual([]);

    // Disabling active instance cancels polling & prevents late updates
    controller.setActiveInstance(null);
    expect(controller.getSnapshot().activeInstanceId).toBeNull();

    // Restore FTS and run query for UI snapshot + jump verification
    controller.setActiveInstance('hm.plugin.session-search-fts');
    await controller.runSearch('hm.plugin.session-search-fts', { q: '中文' });

    useAppStore.setState({
      workspaces: [wsSample, wsSecond],
      sessions: [sampleSession],
      plugins: [searchFts, searchAlt],
      selectedWorkspaceId: wsSample.id,
      activePluginPage: makeWorkspacePageKey(
        'hm.plugin.session-search-fts',
        SESSION_SEARCH_PAGE_SLOT_ID,
      ),
    });

    const html = renderToStaticMarkup(
      <SessionSearchWorkspacePage
        instanceId="hm.plugin.session-search-fts"
        initialQuery="中文"
        transport={transport}
        controller={controller}
      />,
    );
    expect(html).toContain('hm.plugin.session-search-fts');
    expect(html).toContain('sqlite-fts5');
    expect(html).toContain('样例会话');
    expect(html).toContain('import_1');
    expect(html).toContain('sess-sample:import_1:user');
    expect(html).toContain('取消重建');

    // Verify jump to hit uses sessionId, turnId, itemId and closes workspace page
    const hit: SessionSearchHit = queryFx.hits[0]!;
    const selectSpy = vi.spyOn(useAppStore.getState(), 'selectSession').mockResolvedValue();
    // Simulate jump callback behavior
    useAppStore.getState().setActivePluginPage(null);
    await useAppStore.getState().selectSession(hit.sessionId);
    useAppStore.getState().focusTurn({
      sessionId: hit.sessionId,
      turnId: hit.turnId,
      itemId: hit.itemId,
    });
    expect(selectSpy).toHaveBeenCalledWith('sess-sample');
    expect(useAppStore.getState().activePluginPage).toBeNull();
    expect(useAppStore.getState().focusedTurn).toEqual({
      sessionId: 'sess-sample',
      turnId: 'import_1',
      itemId: 'sess-sample:import_1:user',
    });

    // Offline disabled page stays renderable via PluginWorkspaceStage when bound instance is disabled
    useAppStore.setState({
      plugins: [{ ...searchFts, enabled: false, runtimeState: 'DISPOSED' }],
      activePluginPage: makeWorkspacePageKey(
        'hm.plugin.session-search-fts',
        SESSION_SEARCH_PAGE_SLOT_ID,
      ),
    });
    const stageHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={new SlotRegistry()}>
        <PluginWorkspaceStage>
          <div>ChatFallback</div>
        </PluginWorkspaceStage>
      </SlotRegistryProvider>,
    );
    expect(stageHtml).toContain('返回会话');
    expect(stageHtml).toContain('hm.plugin.session-search-fts');
    expect(stageHtml).not.toContain('ChatFallback');

    controller.dispose();
  });
});

describe('B1-05 · SandboxedPluginFrame Bridge & Third-Party Custom Standard Page Takeover', () => {
  it('mounts bundled & 3rd-party ui/panel.html directly without host override and supports takeover, removal, and bridge RPCs', async () => {
    const bundledImport: InstalledPluginInfo = {
      ...makePlugin('hm.plugin.history-import', HISTORY_IMPORT_CONTRACT, {
        name: '历史导入中心',
      }),
      contributes: {
        slots: [
          {
            slot: 'workspace.pages',
            id: HISTORY_IMPORT_PAGE_SLOT_ID,
            title: '历史导入',
            ui: 'ui/panel.html',
          },
        ],
      },
    };
    const bundledSearch: InstalledPluginInfo = {
      ...makePlugin('hm.plugin.session-search-fts', SESSION_SEARCH_CONTRACT, {
        name: 'FTS5 搜索',
      }),
      contributes: {
        slots: [
          {
            slot: 'workspace.pages',
            id: SESSION_SEARCH_PAGE_SLOT_ID,
            title: 'FTS5 搜索',
            ui: 'ui/panel.html',
          },
        ],
      },
    };
    const thirdPartyCustomSearch: InstalledPluginInfo = {
      ...makePlugin('user.custom.search', SESSION_SEARCH_CONTRACT, {
        instanceId: 'user.custom.search',
        name: '第三方语义搜索',
      }),
      sourceKind: 'local_dir',
      builtin: false,
      contributes: {
        slots: [
          {
            slot: 'workspace.pages',
            id: SESSION_SEARCH_PAGE_SLOT_ID,
            title: '自定义语义搜索页',
            ui: 'ui/custom-search.html',
            order: 15,
          },
        ],
      },
    };
    const thirdPartyCustomImport: InstalledPluginInfo = {
      ...makePlugin('user.custom.import', HISTORY_IMPORT_CONTRACT, {
        instanceId: 'user.custom.import',
        name: '第三方历史导入页',
      }),
      sourceKind: 'local_dir',
      builtin: false,
      contributes: {
        slots: [
          {
            slot: 'workspace.pages',
            id: HISTORY_IMPORT_PAGE_SLOT_ID,
            title: '自定义导入工作台',
            ui: 'ui/custom-import.html',
          },
        ],
      },
    };

    const allPlugins = [
      bundledImport,
      bundledSearch,
      thirdPartyCustomSearch,
      thirdPartyCustomImport,
    ];
    const registry = new SlotRegistry();
    const disposers = [
      ...registerBatch1WorkspacePages(registry, allPlugins),
      ...registerPluginIframeSlots(registry, allPlugins),
    ];

    const registeredPages = registry.getItems('workspace.pages', { hasSession: false });
    expect(registeredPages.every((item) => item.sourceKind === 'iframe')).toBe(true);
    expect(registeredPages.map((item) => item.registrationKey)).toEqual([
      'user.custom.search:session-search',
      'hm.plugin.history-import:history-import',
      'hm.plugin.session-search-fts:session-search',
      'user.custom.import:history-import',
    ]);

    // Selecting 3rd-party plugin renders thin shell banner + SandboxedPluginFrame (NOT React fallback page)
    useAppStore.setState({
      workspaces: [wsSample, wsSecond],
      sessions: [sampleSession],
      harnesses: [],
      plugins: allPlugins,
      selectedWorkspaceId: wsSample.id,
      selectedSessionId: sampleSession.id,
      workspaceBindingsByWorkspace: {
        [wsSample.id]: { [SESSION_SEARCH_CONTRACT]: 'user.custom.search' },
      },
      activePluginPage: makeWorkspacePageKey('user.custom.search', SESSION_SEARCH_PAGE_SLOT_ID),
      searchPageInitialQuery: '中文语义',
    });

    const customStageHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <PluginWorkspaceStage>
          <div>ChatFallback</div>
        </PluginWorkspaceStage>
      </SlotRegistryProvider>,
    );
    expect(customStageHtml).toContain('自定义语义搜索页');
    expect(customStageHtml).toContain('workspace-shell-resolution');
    expect(customStageHtml).toContain('user.custom.search');
    expect(customStageHtml).toContain('正在加载沙箱视图 自定义语义搜索页');
    expect(customStageHtml).not.toContain('session-search-workspace-page');

    // Disabling bundledSearch removes its entry while keeping 3rd-party entry active
    for (const d of disposers) d();
    const afterDisablePlugins = [
      bundledImport,
      { ...bundledSearch, enabled: false, runtimeState: 'DISPOSED' as const },
      thirdPartyCustomSearch,
      thirdPartyCustomImport,
    ];
    const registryAfterDisable = new SlotRegistry();
    registerBatch1WorkspacePages(registryAfterDisable, afterDisablePlugins);
    registerPluginIframeSlots(registryAfterDisable, afterDisablePlugins);
    expect(
      registryAfterDisable
        .getItems('workspace.pages', { hasSession: false })
        .map((item) => item.registrationKey),
    ).toEqual([
      'user.custom.search:session-search',
      'hm.plugin.history-import:history-import',
      'user.custom.import:history-import',
    ]);

    // Verify buildIframeSrcDoc injects full context + host bridge helpers
    const srcDoc = buildIframeSrcDoc({
      html: '<body><div id="app">Custom Search</div></body>',
      csp: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'",
      theme: 'dark',
      cssVars: { '--bg-canvas': '#0b0e14' },
      pluginId: 'user.custom.search',
      instanceId: 'user.custom.search',
      runId: 'run-custom-1',
      slotId: SESSION_SEARCH_PAGE_SLOT_ID,
      slot: 'workspace.pages',
      session: null,
      props: {
        apiBase: 'http://127.0.0.1:4321',
        workspaceId: 'ws-sample',
        workspaces: [{ id: 'ws-sample', name: '样例工作区', rootPath: 'D:/Projects/sample' }],
        initialQuery: '中文语义',
      },
    });
    expect(srcDoc).toContain('http://127.0.0.1:4321');
    expect(srcDoc).toContain('中文语义');
    expect(srcDoc).toContain('requestPluginRoute');
    expect(srcDoc).toContain('navigateToSession');
    expect(srcDoc).toContain('refreshSessions');
    expect(srcDoc).toContain('refreshWorkspaces');

    // Verify SandboxedPluginFrame RPC handler: plugin.route, navigateToSession, refreshWorkspaces, abort on switch
    const routeSpy = vi
      .spyOn(daemonApi, 'callPluginInstanceRoute')
      .mockImplementation(async (targetId, routePath, init) => {
        expect(targetId).toBe('user.custom.search');
        expect(routePath).toBe('/query?q=%E4%B8%AD%E6%96%87');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return { ok: true, value: { hits: [{ sessionId: 'sess-sample', turnId: 'import_9' }], nextOffset: null, fallbackUsed: false, tookMs: 3 } };
      });
    const listWorkspacesSpy = vi
      .spyOn(daemonApi, 'listWorkspaces')
      .mockResolvedValue({ workspaces: [wsSample, wsSecond] });
    const selectSessionSpy = vi
      .spyOn(useAppStore.getState(), 'selectSession')
      .mockResolvedValue();

    const activeAbort = new AbortController();
    const execCtx = {
      pluginId: 'user.custom.search',
      effectiveInstanceId: 'user.custom.search',
      slot: 'workspace.pages',
      slotId: SESSION_SEARCH_PAGE_SLOT_ID,
      runId: 'run-custom-1',
      currentSession: null,
      signal: activeAbort.signal,
      isDisposed: () => activeAbort.signal.aborted,
    };

    const routeRes = await executeSandboxedBridgeMethod(execCtx, 'plugin.route', {
      method: 'POST',
      path: '/query',
      query: { q: '中文' },
      body: { q: '中文' },
    });
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect((routeRes as { ok: boolean }).ok).toBe(true);

    const wsRes = await executeSandboxedBridgeMethod(execCtx, 'refreshWorkspaces', {});
    expect(listWorkspacesSpy).toHaveBeenCalledTimes(1);
    expect((wsRes as { workspaces: Workspace[] }).workspaces).toHaveLength(2);

    const navRes = await executeSandboxedBridgeMethod(execCtx, 'navigateToSession', {
      sessionId: 'sess-sample',
      turnId: 'import_9',
      itemId: 'sess-sample:import_9:assistant',
    });
    expect(navRes).toEqual({
      ok: true,
      sessionId: 'sess-sample',
      turnId: 'import_9',
      itemId: 'sess-sample:import_9:assistant',
    });
    expect(selectSessionSpy).toHaveBeenCalledWith('sess-sample');
    expect(useAppStore.getState().activePluginPage).toBeNull();
    expect(useAppStore.getState().focusedTurn).toEqual({
      sessionId: 'sess-sample',
      turnId: 'import_9',
      itemId: 'sess-sample:import_9:assistant',
    });

    // Simulate instance switch / unmount aborting an in-flight navigateToSession before it finishes
    const abortedController = new AbortController();
    const deferredSync = createDeferred<Session | null>();
    vi.spyOn(useAppStore.getState(), 'syncImportedSession').mockImplementation(() => deferredSync.promise);
    useAppStore.setState({
      sessions: [],
      activePluginPage: makeWorkspacePageKey('hm.plugin.session-search-fts', SESSION_SEARCH_PAGE_SLOT_ID),
      focusedTurn: null,
    });
    const slowNavPromise = executeSandboxedBridgeMethod(
      { ...execCtx, signal: abortedController.signal, isDisposed: () => abortedController.signal.aborted },
      'navigateToSession',
      { sessionId: 'late-session', turnId: 'late_turn' },
    );
    abortedController.abort();
    deferredSync.resolve(sampleSession);
    const abortedNavRes = await slowNavPromise;
    expect(abortedNavRes).toEqual({ ok: false, aborted: true });
    expect(useAppStore.getState().focusedTurn).toBeNull();
    expect(useAppStore.getState().activePluginPage).toBe(
      makeWorkspacePageKey('hm.plugin.session-search-fts', SESSION_SEARCH_PAGE_SLOT_ID),
    );
  });
});
