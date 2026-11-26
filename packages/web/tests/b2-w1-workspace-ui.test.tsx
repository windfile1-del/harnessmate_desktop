import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstalledPluginInfo, Session, Workspace } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GIT_CHECKPOINT_CONTRACT,
  GIT_WORKSPACE_CONTRACT,
  SESSION_ATTACHMENTS_CONTRACT,
  TERMINAL_RUNNER_CONTRACT,
  TERMINAL_WORKSPACE_CONTRACT,
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_RULES_CONTRACT,
  isContractAvailableClientSide,
} from '../src/api/peer-contracts';
import { CommandPaletteModal } from '../src/components/CommandPalette';
import { InspectorDrawer } from '../src/components/InspectorDrawer';
import { Sidebar } from '../src/components/Sidebar';
import { TerminalStatusbarBadge } from '../src/components/TerminalWorkspaceDrawer';
import {
  PluginSlotSync,
  SlotRegistry,
  SlotRegistryProvider,
  SlotSessionProvider,
} from '../src/slots';
import { executeSandboxedBridgeMethod } from '../src/slots/sandbox-bridge-handler';
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
const w1Fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../../docs/plugin-decoupling-batch-2/fixtures/W1-peer-contracts.json'),
    'utf8',
  ),
);

const sampleWorkspace: Workspace = {
  id: 'ws_w1_ui',
  name: 'W1 Repo',
  rootPath: 'D:/Repo/示例 目录',
  isGitRepo: true,
  gitBranch: 'main',
  createdAt: 1795651000000,
};

const sessionOne: Session = {
  id: 'sess_w1_1',
  workspaceId: sampleWorkspace.id,
  harnessId: 'codex',
  harnessKind: 'codex',
  nativeSessionId: null,
  participatingHarnesses: ['codex'],
  contextSyncMode: 'auto',
  cwd: 'D:/Repo/示例 目录',
  title: 'Session One',
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

const sessionTwo: Session = {
  ...sessionOne,
  id: 'sess_w1_2',
  title: 'Session Two',
};

function makeW1Plugin(
  id: string,
  provides: string[],
  opts?: Partial<InstalledPluginInfo>,
): InstalledPluginInfo {
  return {
    id,
    instanceId: opts?.instanceId ?? id,
    name: opts?.name ?? id,
    version: '1.0.0',
    category: 'tool',
    contributes: opts?.contributes ?? {},
    provides,
    providedContracts: provides.map((contract) => ({ contract, version: '1.0.0' })),
    enabled: opts?.enabled ?? true,
    builtin: opts?.builtin ?? true,
    source: opts?.source ?? 'builtin',
    sourceKind: opts?.sourceKind ?? 'bundled',
    runtimeState: opts?.runtimeState ?? 'ACTIVE',
  };
}

function defaultW1Plugins(overrides?: { disableRules?: boolean; enableTermWs?: boolean }): InstalledPluginInfo[] {
  return [
    makeW1Plugin('core.git-inspector', [GIT_WORKSPACE_CONTRACT, GIT_CHECKPOINT_CONTRACT]),
    makeW1Plugin('core.terminal-runner', [WORKSPACE_FILES_CONTRACT, TERMINAL_RUNNER_CONTRACT]),
    makeW1Plugin('core.workspace-rules', [WORKSPACE_RULES_CONTRACT], {
      enabled: overrides?.disableRules ? false : true,
      runtimeState: overrides?.disableRules ? 'DISABLED' : 'ACTIVE',
    }),
    makeW1Plugin('core.attachments', [SESSION_ATTACHMENTS_CONTRACT]),
    makeW1Plugin('hm.plugin.terminal-workspace', [TERMINAL_WORKSPACE_CONTRACT], {
      enabled: overrides?.enableTermWs ?? false,
      runtimeState: overrides?.enableTermWs ? 'ACTIVE' : 'DISABLED',
    }),
  ];
}

const baselineState = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(
    {
      ...baselineState,
      workspaces: [sampleWorkspace],
      sessions: [sessionOne, sessionTwo],
      selectedWorkspaceId: sampleWorkspace.id,
      selectedSessionId: sessionOne.id,
      activePluginPage: null,
      inspectorOpen: false,
      inspectorTab: 'info',
      inspectorFile: null,
      inspectorFileError: null,
      plugins: defaultW1Plugins(),
      compositionBindings: {
        [GIT_WORKSPACE_CONTRACT]: 'core.git-inspector',
        [GIT_CHECKPOINT_CONTRACT]: 'core.git-inspector',
        [WORKSPACE_FILES_CONTRACT]: 'core.terminal-runner',
        [WORKSPACE_RULES_CONTRACT]: 'core.workspace-rules',
        [TERMINAL_RUNNER_CONTRACT]: 'core.terminal-runner',
        [SESSION_ATTACHMENTS_CONTRACT]: 'core.attachments',
        [TERMINAL_WORKSPACE_CONTRACT]: 'hm.plugin.terminal-workspace',
      },
      compositionEntries: [
        { id: 'core.git-inspector', name: 'Git', disabled: false },
        { id: 'core.terminal-runner', name: 'Runner & Files', disabled: false },
        { id: 'core.workspace-rules', name: 'Rules', disabled: false },
        { id: 'core.attachments', name: 'Attachments', disabled: false },
        { id: 'hm.plugin.terminal-workspace', name: 'Terminal', disabled: false },
      ],
      workspaceBindingsByWorkspace: {},
      sessionBindingsBySession: {},
      checkpointsBySession: {},
      gitBySession: {},
    },
    true,
  );
});

afterEach(() => {
  useAppStore.setState(baselineState, true);
  vi.restoreAllMocks();
});

describe('Batch 2 W1 · Frontend Navigation, Contract Gating & Custom Slot Overrides', () => {
  it('validates W1 peer contracts fixture and navigateToFile DTO while preserving active session', async () => {
    expect(Object.keys(w1Fixture.contracts)).toEqual([
      GIT_WORKSPACE_CONTRACT,
      GIT_CHECKPOINT_CONTRACT,
      TERMINAL_WORKSPACE_CONTRACT,
      TERMINAL_RUNNER_CONTRACT,
      WORKSPACE_FILES_CONTRACT,
      SESSION_ATTACHMENTS_CONTRACT,
      WORKSPACE_RULES_CONTRACT,
    ]);
    expect(w1Fixture.contracts[WORKSPACE_RULES_CONTRACT].defaultInstanceId).toBe('core.workspace-rules');

    // Windows drive path + Chinese + file:///#L syntax via sandbox bridge preserves selectedSessionId and closes activePluginPage
    useAppStore.setState({ activePluginPage: 'user.search:page' });
    const ac = new AbortController();
    const bridgeResult = (await executeSandboxedBridgeMethod(
      {
        pluginId: 'user.workspace-tools-lite',
        effectiveInstanceId: 'user.workspace-tools-lite',
        slot: 'inspector.files',
        slotId: 'lite-files-panel',
        runId: 'run-w1-ui',
        currentSession: sessionOne,
        signal: ac.signal,
        isDisposed: () => false,
      },
      'navigateToFile',
      {
        path: 'file:///D:/Repo/%E7%A4%BA%E4%BE%8B%20%E7%9B%AE%E5%BD%95/src/main.ts#L42',
      },
    )) as { opened: boolean; line?: number; sessionId: string | null };
    expect(bridgeResult.opened).toBe(true);
    expect(bridgeResult.line).toBe(42);
    expect(bridgeResult.sessionId).toBe(sessionOne.id);
    expect(useAppStore.getState().selectedSessionId).toBe(sessionOne.id);
    expect(useAppStore.getState().activePluginPage).toBeNull();
    expect(useAppStore.getState().inspectorTab).toBe('files');
    expect(useAppStore.getState().inspectorFile?.path).toContain('main.ts');
    expect(useAppStore.getState().inspectorFile?.line).toBe(42);

    // Rejects external http(s) URL without clearing or mutating session
    const httpAttempt = useAppStore.getState().navigateToFile({ path: 'https://example.com/docs' });
    expect(httpAttempt.opened).toBe(false);
    expect(useAppStore.getState().selectedSessionId).toBe(sessionOne.id);

    // Disabled workspace.files.v1 preserves selectedSessionId and sets inline inspectorFileError
    useAppStore.setState({
      plugins: defaultW1Plugins().map((p) =>
        p.id === 'core.terminal-runner' ? { ...p, enabled: false, runtimeState: 'DISABLED' } : p,
      ),
    });
    const disabledNav = useAppStore.getState().navigateToFile({
      path: 'src/app.ts:18',
      openInspector: true,
    });
    expect(disabledNav.opened).toBe(false);
    expect(disabledNav.errorCode).toBe('E_PLUGIN_DISABLED');
    expect(useAppStore.getState().selectedSessionId).toBe(sessionOne.id);
    expect(useAppStore.getState().inspectorTab).toBe('files');
    expect(useAppStore.getState().inspectorFileError?.code).toBe('E_PLUGIN_DISABLED');

    const disabledDrawerHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={new SlotRegistry()}>
        <SlotSessionProvider session={sessionOne}>
          <InspectorDrawer session={sessionOne} diagnostics={[]} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(disabledDrawerHtml).toContain('inspector-file-error');

    useAppStore.getState().closeInspectorFile();
    expect(useAppStore.getState().inspectorFileError).toBeNull();
  });

  it('switches slot owners cleanly between built-in panels and custom 3rd-party iframe UI overrides', () => {
    const altPlugin = makeW1Plugin(
      'user.workspace-tools-lite',
      [GIT_WORKSPACE_CONTRACT, WORKSPACE_FILES_CONTRACT, WORKSPACE_RULES_CONTRACT, TERMINAL_RUNNER_CONTRACT],
      {
        source: 'user',
        builtin: false,
        sourceKind: 'user',
        contributes: {
          slots: [
            { slot: 'inspector.diff', id: 'lite-diff', title: 'Lite Diff', ui: 'ui/diff.html' },
            { slot: 'inspector.files', id: 'lite-files', title: 'Lite Files', ui: 'ui/files.html' },
            { slot: 'inspector.rules', id: 'lite-rules', title: 'Lite Rules', ui: 'ui/rules.html' },
          ],
        },
      },
    );

    const registry = new SlotRegistry();
    renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sessionOne}>
          <PluginSlotSync />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );

    // Note: useEffect runs only on client; test slot helpers & InspectorDrawer fallback directly when alt iframe slot registered
    registry.register({
      slot: 'inspector.diff',
      id: 'lite-diff',
      pluginId: altPlugin.id,
      pluginName: altPlugin.name,
      sourceKind: 'iframe',
      render: () => <div data-testid="custom-diff-slot">Lite Diff Custom Frame</div>,
    });
    registry.register({
      slot: 'inspector.files',
      id: 'lite-files',
      pluginId: altPlugin.id,
      pluginName: altPlugin.name,
      sourceKind: 'iframe',
      render: () => <div data-testid="custom-files-slot">Lite Files Custom Frame</div>,
    });
    registry.register({
      slot: 'inspector.rules',
      id: 'lite-rules',
      pluginId: altPlugin.id,
      pluginName: altPlugin.name,
      sourceKind: 'iframe',
      render: () => <div data-testid="custom-rules-slot">Lite Rules Custom Frame</div>,
    });

    useAppStore.setState({ inspectorOpen: true, inspectorTab: 'files' });
    const customFilesHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sessionOne}>
          <InspectorDrawer session={sessionOne} diagnostics={[]} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(customFilesHtml).toContain('custom-files-slot');

    useAppStore.setState({ inspectorTab: 'info' });
    const customRulesHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sessionOne}>
          <InspectorDrawer session={sessionOne} diagnostics={[]} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(customRulesHtml).toContain('custom-rules-slot');
  });

  it('respects independent disabling of rules/git while preserving historical checkpoints, Sidebar, CommandPalette, and TerminalStatusbarBadge', () => {
    // Disabling core.workspace-rules hides rules capability while keeping files, terminal, and attachments enabled
    useAppStore.setState({
      plugins: defaultW1Plugins({ disableRules: true, enableTermWs: true }),
      inspectorOpen: true,
      inspectorTab: 'info',
    });

    const opts = {
      plugins: useAppStore.getState().plugins,
      compositionBindings: useAppStore.getState().compositionBindings,
      compositionEntries: useAppStore.getState().compositionEntries,
    };
    expect(isContractAvailableClientSide({ ...opts, contract: WORKSPACE_RULES_CONTRACT, legacyPluginId: 'core.workspace-rules' })).toBe(false);
    expect(isContractAvailableClientSide({ ...opts, contract: WORKSPACE_FILES_CONTRACT, legacyPluginId: 'core.terminal-runner' })).toBe(true);
    expect(isContractAvailableClientSide({ ...opts, contract: TERMINAL_RUNNER_CONTRACT, legacyPluginId: 'core.terminal-runner' })).toBe(true);
    expect(isContractAvailableClientSide({ ...opts, contract: SESSION_ATTACHMENTS_CONTRACT, legacyPluginId: 'core.attachments' })).toBe(true);
    expect(isContractAvailableClientSide({ ...opts, contract: TERMINAL_WORKSPACE_CONTRACT, legacyPluginId: 'hm.plugin.terminal-workspace', optionalDefaultOff: true })).toBe(true);

    const rulesDisabledDrawer = renderToStaticMarkup(
      <SlotRegistryProvider registry={new SlotRegistry()}>
        <SlotSessionProvider session={sessionOne}>
          <InspectorDrawer session={sessionOne} diagnostics={[]} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(rulesDisabledDrawer).toContain('工作区规则发现插件已停用');
    expect(rulesDisabledDrawer).toContain('文件');
    expect(rulesDisabledDrawer).toContain('终端');

    // Disabling Git hides Worktree dock tile in Sidebar, yet keeps '变更' tab when historical checkpoints exist
    useAppStore.setState({
      plugins: defaultW1Plugins().map((p) =>
        p.id === 'core.git-inspector' ? { ...p, enabled: false, runtimeState: 'DISABLED' } : p,
      ),
      checkpointsBySession: {
        [sessionOne.id]: [
          {
            checkpointId: 'ckpt_hist_1',
            sessionId: sessionOne.id,
            turnSeq: 1,
            phase: 'turn_post',
            gitRef: 'refs/harnessmate/checkpoints/sess_w1_1/ckpt_hist_1',
            treeSha: '1111111111111111111111111111111111111111',
            baseHeadSha: null,
            filesChanged: 1,
            insertions: 1,
            deletions: 0,
            skippedLargeFiles: [],
            createdAt: 1000,
          },
        ],
      },
    });

    const sidebarHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={new SlotRegistry()}>
        <SlotSessionProvider session={sessionOne}>
          <Sidebar />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(sidebarHtml).not.toContain('分支与预检');

    const drawerWithHistoryHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={new SlotRegistry()}>
        <SlotSessionProvider session={sessionOne}>
          <InspectorDrawer session={sessionOne} diagnostics={[]} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(drawerWithHistoryHtml).toContain('变更');

    // CommandPalette and TerminalStatusbarBadge render without error under custom terminal binding
    const altTerm = makeW1Plugin('user.terminal-lite', [TERMINAL_WORKSPACE_CONTRACT], {
      source: 'user',
      builtin: false,
    });
    useAppStore.setState({
      plugins: [...defaultW1Plugins(), altTerm],
      compositionBindings: {
        ...useAppStore.getState().compositionBindings,
        [TERMINAL_WORKSPACE_CONTRACT]: 'user.terminal-lite',
      },
      compositionEntries: [
        ...useAppStore.getState().compositionEntries,
        { id: 'user.terminal-lite', name: 'Lite Term', disabled: false },
      ],
    });
    const paletteHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={new SlotRegistry()}>
        <SlotSessionProvider session={sessionOne}>
          <CommandPaletteModal initialQuery="" onClose={() => {}} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(paletteHtml).toContain('打开 Worktree 管理');

    const badgeHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={new SlotRegistry()}>
        <SlotSessionProvider session={sessionOne}>
          <TerminalStatusbarBadge session={sessionOne} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(badgeHtml).toContain('statusbar-terminal-badge');
  });
});
