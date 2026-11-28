import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginInfo } from '@harnessmate/protocol';
import { APPLICATION_VIEW_CONTRACT } from '../src/api/peer-contracts';
import { parseFileLink } from '../src/lib/file-links';
import {
  UiContributionRegistry,
  contributionRegistry,
  installKernelContributionRuntime,
} from '../src/kernel/contribution-registry';
import { layoutBridge } from '../src/kernel/layout-bridge';
import { NavigationBus, navigationBus } from '../src/kernel/navigation-bus';
import { kernelRecoveryClient } from '../src/kernel/recovery-client';
import { ApplicationEntryHost } from '../src/kernel/ApplicationEntryHost';
import { KernelRecoveryView } from '../src/components/KernelRecoveryView';
import {
  LEGACY_SHELL_BRIDGE_ADAPTERS,
  invokeShell,
  shellSnapshot,
} from '../src/slots/shell-bridge';
import { createDefaultShellNavigationHandler } from '../src/plugins/shell-default/navigation';
import { useAppStore } from '../src/stores/app-store';
import { useKernelStore } from '../src/stores/kernel-store';

function makeLayoutPlugin(overrides: Partial<InstalledPluginInfo> & { id: string; name: string }): InstalledPluginInfo {
  return {
    version: '1.0.0',
    description: `${overrides.name} layout`,
    category: 'ui',
    enabled: true,
    builtin: false,
    sourceKind: 'bundled',
    runtimeState: 'ACTIVE',
    provides: [APPLICATION_VIEW_CONTRACT],
    providedContracts: [{ contract: APPLICATION_VIEW_CONTRACT, version: '1.0.0' }],
    contributes: {
      slots: [
        {
          slot: 'application.shell',
          id: 'shell',
          title: overrides.name,
          ui: 'ui/index.html',
          module: 'ui/module.mjs',
        },
      ],
    },
    ...overrides,
  } as InstalledPluginInfo;
}

function createFakeEventTarget() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    addEventListener(type: string, fn: (...args: unknown[]) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (...args: unknown[]) => void) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, event: unknown) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

function makeKeyEvent(overrides: Record<string, unknown>) {
  let defaultPrevented = false;
  return {
    key: '',
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault() {
      defaultPrevented = true;
    },
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe('B5-W1: Kernel Boundary & Static Ownership Guard (B5-A8)', () => {
  const webSrcRoot = path.resolve(__dirname, '../src');
  const kernelFiles = [
    'App.tsx',
    'components/KernelRecoveryView.tsx',
    'kernel/ApplicationEntryHost.tsx',
    'kernel/recovery-client.ts',
    'kernel/navigation-bus.ts',
    'kernel/contribution-registry.ts',
    'kernel/layout-bridge.ts',
    'stores/kernel-store.ts',
    'slots/KernelSlotSync.tsx',
    'slots/TrustedPluginModuleHost.tsx',
    'slots/SandboxedPluginFrame.tsx',
    'slots/BoundSessionSurface.tsx',
    'slots/shell-bridge.ts',
    'slots/sandbox-bridge-handler.ts',
    'slots/hooks.tsx',
  ];

  const forbiddenImports = [
    'stores/app-store',
    'components/Modal',
    'components/Sidebar',
    'components/InspectorDrawer',
    'components/ChatStage',
    'components/CommandPalette',
    'components/TriageInbox',
    'plugins/shell-default',
  ];

  it('guarantees kernel & recovery files never import app-store, ModalHost, Sidebar, or chat', () => {
    for (const rel of kernelFiles) {
      const content = fs.readFileSync(path.join(webSrcRoot, rel), 'utf8');
      for (const forbidden of forbiddenImports) {
        expect(content, `${rel} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('documents every remaining W2/W3 transitional shell-bridge adapter with callers, owner, and removal condition', () => {
    expect(LEGACY_SHELL_BRIDGE_ADAPTERS.length).toBeGreaterThan(0);
    for (const adapter of LEGACY_SHELL_BRIDGE_ADAPTERS) {
      expect(adapter.action).toBeTruthy();
      expect(adapter.callers.length).toBeGreaterThan(0);
      expect(['W2', 'W3']).toContain(adapter.owner);
      expect(adapter.removeWhen.length).toBeGreaterThan(10);
    }
  });
});

describe('B5-W1: File Links, NavigationBus & UiContributionRegistry (B5-A2)', () => {
  afterEach(() => {
    navigationBus.reset();
    contributionRegistry.reset();
    layoutBridge.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses Windows drive letters, file:// URIs, relative paths, spaces, Chinese characters, and line:col', () => {
    expect(parseFileLink('D:\\工作区\\带空格 文件.ts:42:7')).toEqual({
      path: 'D:/工作区/带空格 文件.ts',
      line: 42,
      column: 7,
    });
    expect(parseFileLink('file:///C:/repo/%E4%B8%AD%E6%96%87%20%E6%96%87%E6%A1%A3.md#L18C3')).toEqual({
      path: 'C:/repo/中文 文档.md',
      line: 18,
      column: 3,
    });
    expect(parseFileLink('file://localhost/D:/proj/src/app.ts:9:2')).toEqual({
      path: 'D:/proj/src/app.ts',
      line: 9,
      column: 2,
    });
    expect(parseFileLink('./src/中文 目录/index.tsx:10:5')).toEqual({
      path: './src/中文 目录/index.tsx',
      line: 10,
      column: 5,
    });
    expect(parseFileLink('https://example.com/docs')).toBeNull();
    expect(parseFileLink('/api/v1/sessions')).toBeNull();
  });

  it('routes generic navigation requests with placement and revokes handlers cleanly on layout unload', async () => {
    const bus = new NavigationBus();
    const unavail = await bus.navigate({ target: { kind: 'page', pageId: 'search' }, placement: 'primary' });
    expect(unavail.status).toBe('unavailable');
    expect(unavail.code).toBe('E_SERVICE_UNAVAILABLE');

    const received: unknown[] = [];
    const dispose = bus.registerHandler(
      { instanceId: 'hm.plugin.shell-lite', runId: 'r1' },
      (req) => {
        received.push(req);
        return {
          requestId: req.requestId,
          status: 'accepted',
          placement: req.placement ?? 'side',
          detail: { opened: true, path: req.context?.path },
        };
      },
    );

    const ok = await bus.navigate({
      target: { kind: 'file', uri: 'D:/repo/中文.md:12:4' },
      context: { path: 'D:/repo/中文.md', line: 12, column: 4 },
      placement: 'side',
    });
    expect(ok.status).toBe('accepted');
    expect(ok.handledByInstanceId).toBe('hm.plugin.shell-lite');
    expect(ok.placement).toBe('side');
    expect(received).toHaveLength(1);

    // Stale runId revocation does not affect active owner
    expect(bus.revokeByOwner('hm.plugin.shell-lite', 'stale-run')).toBe(false);
    expect(bus.getActiveOwner()?.runId).toBe('r1');

    // Disposing revokes handler so subsequent navigation returns unavailable
    dispose();
    const afterDispose = await bus.navigate({ target: { kind: 'file', uri: 'a.ts' } });
    expect(afterDispose.status).toBe('unavailable');
  });

  it('handles default shell navigation for file links, disabled files plugin, and external URLs without page jump', async () => {
    const openExternal = vi.fn(async () => {});
    vi.stubGlobal('window', { harnessMateBridge: { openExternal } });

    useAppStore.setState({
      sessions: [
        {
          id: 'sess_nav',
          workspaceId: 'ws_nav',
          harnessId: 'codex',
          harnessKind: 'codex',
          title: 'Nav Test',
          status: 'idle',
          model: null,
          reasoningEffort: null,
          permissionMode: 'accept_edits',
          cwd: 'D:/repo',
          nativeSessionId: null,
          participatingHarnesses: ['codex'],
          contextSyncMode: 'auto',
          lastSeq: 0,
          usage: null,
          pendingApprovalCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      selectedSessionId: 'sess_nav',
      plugins: [
        {
          id: 'core.terminal-runner',
          name: 'Workspace Files',
          version: '1.0.0',
          description: '',
          category: 'tool',
          enabled: true,
          builtin: true,
          runtimeState: 'ACTIVE',
          provides: ['workspace.files.v1'],
          contributes: {},
        } as InstalledPluginInfo,
      ],
    });

    const dispose = navigationBus.registerHandler(
      { instanceId: 'hm.plugin.shell-default', runId: 'r-nav' },
      createDefaultShellNavigationHandler(),
    );

    const fileOk = await navigationBus.navigate({
      target: { kind: 'file', uri: 'D:\\目录 带空格\\测试.ts:24:6' },
      placement: 'side',
    });
    expect(fileOk.status).toBe('accepted');
    expect(useAppStore.getState().inspectorTab).toBe('files');
    expect(useAppStore.getState().inspectorOpen).toBe(true);
    expect(useAppStore.getState().inspectorFile).toEqual({
      sessionId: 'sess_nav',
      path: 'D:/目录 带空格/测试.ts',
      line: 24,
      column: 6,
    });

    // External http link opens via external opener instead of file sidebar
    const extOk = await navigationBus.navigate({
      target: { kind: 'external', uri: 'https://example.com/docs' },
      placement: 'external',
    });
    expect(extOk.status).toBe('accepted');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');

    // Disabling workspace.files.v1 yields explicit unavailable without losing session
    useAppStore.setState({
      plugins: [
        {
          id: 'core.terminal-runner',
          name: 'Workspace Files',
          version: '1.0.0',
          description: '',
          category: 'tool',
          enabled: false,
          builtin: true,
          runtimeState: 'DISPOSED',
          provides: ['workspace.files.v1'],
          contributes: {},
        } as InstalledPluginInfo,
      ],
    });
    const fileDisabled = await navigationBus.navigate({
      target: { kind: 'file', uri: 'src/a.ts:3' },
      placement: 'side',
    });
    expect(fileDisabled.status).toBe('unavailable');
    expect(fileDisabled.code).toBe('E_PLUGIN_DISABLED');
    expect(useAppStore.getState().selectedSessionId).toBe('sess_nav');

    dispose();
  });

  it('handles IME composition, input focus guards, menu/tray sync, and revocation on layout switch', () => {
    const reg = new UiContributionRegistry();
    const syncedBatches: unknown[][] = [];
    let invokeCb: ((payload: { key: string; ownerInstanceId: string; ownerRunId: string }) => void) | undefined;
    const fakeWindow = Object.assign(createFakeEventTarget(), {
      harnessMateBridge: {
        pickDirectory: async () => null,
        openExternal: async () => {},
        notify: () => {},
        menu: {
          syncContributions: (items: unknown[]) => {
            syncedBatches.push(items);
          },
          onInvoke: (cb: (payload: { key: string; ownerInstanceId: string; ownerRunId: string }) => void) => {
            invokeCb = cb;
            return () => {
              invokeCb = undefined;
            };
          },
        },
      },
    });
    vi.stubGlobal('window', fakeWindow);

    const cleanupRuntime = installKernelContributionRuntime(reg, fakeWindow as unknown as Window);
    const onShortcut = vi.fn();
    const onPlainKey = vi.fn();
    const onTray = vi.fn();

    const ownerA = { instanceId: 'hm.plugin.shell-default', runId: 'run-a' };
    reg.register(ownerA, {
      id: 'toggle-sidebar',
      kind: 'shortcut',
      title: '切换侧栏',
      shortcut: 'Mod+B',
      execute: onShortcut,
    });
    reg.register(ownerA, {
      id: 'plain-j',
      kind: 'shortcut',
      title: '列表向下',
      shortcut: 'j',
      allowInInput: false,
      execute: onPlainKey,
    });
    reg.register(ownerA, {
      id: 'tray-new',
      kind: 'tray',
      title: '新建会话',
      shortcut: 'Mod+N',
      execute: onTray,
    });

    expect(syncedBatches.at(-1)?.length).toBe(1);

    // IME composing blocks shortcut via compositionstart
    fakeWindow.dispatch('compositionstart', {});
    fakeWindow.dispatch('keydown', makeKeyEvent({ key: 'b', ctrlKey: true }));
    expect(onShortcut).not.toHaveBeenCalled();
    fakeWindow.dispatch('compositionend', {});

    // IME keyCode 229 blocks shortcut
    expect(reg.dispatchShortcutEvent(makeKeyEvent({ key: 'b', ctrlKey: true, keyCode: 229 }), false)).toBe(false);
    expect(onShortcut).not.toHaveBeenCalled();

    // Non-Mod shortcut blocked inside <input>
    const inputTarget = { tagName: 'INPUT', isContentEditable: false };
    expect(reg.dispatchShortcutEvent(makeKeyEvent({ key: 'j', target: inputTarget }), false)).toBe(false);
    expect(onPlainKey).not.toHaveBeenCalled();

    // Normal Mod+B fires through window keydown listener
    const modB = makeKeyEvent({ key: 'b', ctrlKey: true });
    fakeWindow.dispatch('keydown', modB);
    expect(modB.defaultPrevented).toBe(true);
    expect(onShortcut).toHaveBeenCalledTimes(1);

    // Valid tray invoke fires
    invokeCb?.({
      key: 'hm.plugin.shell-default:tray:tray-new',
      ownerInstanceId: 'hm.plugin.shell-default',
      ownerRunId: 'run-a',
    });
    expect(onTray).toHaveBeenCalledTimes(1);

    // Revoking ownerA (simulating layout switch) removes all shortcuts & clears tray
    expect(reg.revokeByOwner('hm.plugin.shell-default', 'run-a')).toBe(3);
    expect(syncedBatches.at(-1)).toEqual([]);

    // Old shortcut and stale tray invocation no longer trigger
    fakeWindow.dispatch('keydown', makeKeyEvent({ key: 'b', ctrlKey: true }));
    expect(onShortcut).toHaveBeenCalledTimes(1);
    invokeCb?.({
      key: 'hm.plugin.shell-default:tray:tray-new',
      ownerInstanceId: 'hm.plugin.shell-default',
      ownerRunId: 'run-a',
    });
    expect(onTray).toHaveBeenCalledTimes(1);

    cleanupRuntime();
  });

  it('shell-bridge reads kernel + published layout state and routes actions via navigationBus', async () => {
    useKernelStore.setState({
      theme: 'light',
      connected: true,
      plugins: [],
      compositionBindings: { [APPLICATION_VIEW_CONTRACT]: 'hm.plugin.shell-lite' },
    });
    const detach = layoutBridge.attachOwner({ instanceId: 'hm.plugin.shell-lite', runId: 'r1' });
    layoutBridge.publishState(
      { instanceId: 'hm.plugin.shell-lite', runId: 'r1' },
      { selectedSessionId: 'sess_1', sidebarCollapsed: true },
    );
    const snap = shellSnapshot();
    expect(snap.theme).toBe('light');
    expect(snap.selectedSessionId).toBe('sess_1');
    expect(snap.sidebarCollapsed).toBe(true);

    const navSpy = vi.fn((req) => ({ requestId: req.requestId, status: 'accepted' as const }));
    const unregNav = navigationBus.registerHandler({ instanceId: 'hm.plugin.shell-lite', runId: 'r1' }, navSpy);
    const res = await invokeShell('selectSession', ['sess_2']);
    expect((res as { status: string }).status).toBe('accepted');
    expect(navSpy).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'session' }, context: { sessionId: 'sess_2' } }),
    );
    expect(() => invokeShell('unknownPrivateAction', [])).toThrow(/不属于公开界面能力/);

    unregNav();
    detach();
  });
});

describe('B5-W1: ApplicationEntryHost, KernelRecoveryView & External shell-lite (B5-A1 / B5-A8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useKernelStore.setState({
      loading: false,
      initialized: true,
      plugins: [],
      emptyComposition: false,
      compositionBindings: {},
      compositionEntries: [],
      applicationFailure: null,
      restartStatus: null,
    });
  });

  it('enters KernelRecoveryView for empty composition, unbound entry, disabled layout, and load failure — and uses identical loader for default vs external layouts', () => {
    const defaultLayout = makeLayoutPlugin({ id: 'hm.plugin.shell-default', name: '默认工作台布局' });
    const liteLayout = makeLayoutPlugin({
      id: 'hm.plugin.shell-lite',
      name: 'Shell Lite',
      sourceKind: 'installed',
    });

    // 1. Empty composition -> KernelRecoveryView
    useKernelStore.setState({
      loading: false,
      initialized: true,
      emptyComposition: true,
      plugins: [],
      compositionBindings: {},
      applicationFailure: null,
    });
    expect(renderToStaticMarkup(<ApplicationEntryHost />)).toContain('data-recovery-reason="empty_composition"');

    // 2. Entry unbound (even when default layout is installed — NO host fallback!)
    useKernelStore.setState({
      emptyComposition: false,
      plugins: [defaultLayout],
      compositionBindings: {},
      applicationFailure: null,
    });
    expect(renderToStaticMarkup(<ApplicationEntryHost />)).toContain('data-recovery-reason="entry_unbound"');

    // 3. Layout self-disabled -> KernelRecoveryView
    useKernelStore.setState({
      emptyComposition: false,
      plugins: [{ ...defaultLayout, enabled: false, runtimeState: 'DISPOSED' }],
      compositionBindings: { [APPLICATION_VIEW_CONTRACT]: 'hm.plugin.shell-default' },
      applicationFailure: null,
    });
    expect(renderToStaticMarkup(<ApplicationEntryHost />)).toContain('data-recovery-reason="entry_disabled"');

    // 4. Bad revision load failure -> KernelRecoveryView with error message
    useKernelStore.setState({
      emptyComposition: false,
      plugins: [defaultLayout],
      compositionBindings: { [APPLICATION_VIEW_CONTRACT]: 'hm.plugin.shell-default' },
      applicationFailure: {
        kind: 'load_failed',
        instanceId: 'hm.plugin.shell-default',
        message: 'module syntax error in revision r2',
      },
    });
    const failedHtml = renderToStaticMarkup(<ApplicationEntryHost />);
    expect(failedHtml).toContain('data-recovery-reason="load_failed"');
    expect(failedHtml).toContain('module syntax error in revision r2');

    // 5. Default layout AND external shell-lite mount through the EXACT SAME trusted-module loader path
    useKernelStore.setState({
      emptyComposition: false,
      plugins: [defaultLayout, liteLayout],
      compositionBindings: { [APPLICATION_VIEW_CONTRACT]: 'hm.plugin.shell-default' },
      applicationFailure: null,
    });
    const defaultHostHtml = renderToStaticMarkup(<ApplicationEntryHost />);
    expect(defaultHostHtml).toContain('data-application-entry="hm.plugin.shell-default"');
    expect(defaultHostHtml).toContain('data-application-mount-mode="trusted-module"');
    expect(defaultHostHtml).toContain('data-trusted-module-host="hm.plugin.shell-default:shell"');

    useKernelStore.setState({
      compositionBindings: { [APPLICATION_VIEW_CONTRACT]: 'hm.plugin.shell-lite' },
    });
    const liteHostHtml = renderToStaticMarkup(<ApplicationEntryHost />);
    expect(liteHostHtml).toContain('data-application-entry="hm.plugin.shell-lite"');
    expect(liteHostHtml).toContain('data-application-mount-mode="trusted-module"');
    expect(liteHostHtml).toContain('data-trusted-module-host="hm.plugin.shell-lite:shell"');
  });

  it('renders standalone KernelRecoveryView restart status & supports switchApplicationEntry restart_required status', async () => {
    const defaultLayout = makeLayoutPlugin({ id: 'hm.plugin.shell-default', name: '默认工作台布局' });
    const liteLayout = makeLayoutPlugin({ id: 'hm.plugin.shell-lite', name: 'Shell Lite', sourceKind: 'installed' });

    const html = renderToStaticMarkup(
      <KernelRecoveryView
        reasonKind="load_failed"
        failedInstanceId="hm.plugin.shell-lite"
        errorMessage="bad layout revision"
        restartRequired
        restartReason="需要重启宿主窗口"
      />,
    );
    expect(html).toContain('data-testid="kernel-restart-banner"');
    expect(html).toContain('需要重启宿主窗口');
    expect(html).toContain('恢复模式不依赖完整插件管理中心');

    vi.spyOn(kernelRecoveryClient, 'setCompositionBinding').mockResolvedValue({
      ok: true,
      composition: {
        bundles: ['harnessmate-core'],
        bindings: { [APPLICATION_VIEW_CONTRACT]: 'hm.plugin.shell-lite' },
        entries: [],
      },
    });
    useKernelStore.setState({
      plugins: [defaultLayout, liteLayout],
      compositionBindings: { [APPLICATION_VIEW_CONTRACT]: 'hm.plugin.shell-default' },
    });

    const switchRes = await useKernelStore.getState().switchApplicationEntry('hm.plugin.shell-lite', {
      requiresRestart: true,
      restartReason: '新布局需要重建窗口上下文',
    });
    expect(switchRes).toMatchObject({
      status: 'restart_required',
      instanceId: 'hm.plugin.shell-lite',
      previousInstanceId: 'hm.plugin.shell-default',
      restartRequired: true,
    });
    expect(useKernelStore.getState().restartStatus?.required).toBe(true);
  });

  it('validates external hm.plugin.shell-lite package exports mount() and avoids private host imports', async () => {
    const modPath = path.resolve(__dirname, '../../../plugins/examples/hm.plugin.shell-lite/ui/module.mjs');
    const source = fs.readFileSync(modPath, 'utf8');
    expect(source).not.toContain('useAppStore');
    expect(source).not.toContain('shell-default');
    expect(source).toContain('bridge.surfaces.mountBoundSurface');
    expect(source).toContain('bridge.surfaces.mountSlotItem');
    expect(source).toContain('bridge.navigation.registerHandler');
    expect(source).toContain('bridge.contributions.register');

    const mod = (await import(pathToFileURL(modPath).href)) as { mount?: unknown };
    expect(typeof mod.mount).toBe('function');

    // Execute mount() with a lightweight React mock root to verify clean render & unmount disposal
    const unmountSpy = vi.fn();
    const renderedElements: unknown[] = [];
    const React = await import('react');
    const dispose = (mod.mount as Function)({
      container: {},
      bridge: {
        instanceId: 'hm.plugin.shell-lite',
        runId: 'r1',
        kernel: { getSnapshot: () => ({ plugins: [], compositionBindings: {}, theme: 'dark' }), subscribe: () => () => {} },
        surfaces: { listSlots: () => [], onSlotsChanged: () => () => {} },
        application: { publishState: () => true, registerToastHandler: () => () => {} },
        navigation: { registerHandler: () => () => {} },
        contributions: { register: () => () => {} },
      },
      runtime: {
        react: React,
        reactDomClient: {
          createRoot: () => ({
            render: (el: unknown) => {
              renderedElements.push(el);
            },
            unmount: unmountSpy,
          }),
        },
      },
    });
    expect(renderedElements).toHaveLength(1);
    const renderedMarkup = renderToStaticMarkup(renderedElements[0] as React.ReactElement);
    expect(renderedMarkup).toContain('data-shell-layout="hm.plugin.shell-lite"');
    expect(renderedMarkup).toContain('data-testid="shell-lite-chat-stage"');
    dispose();
    expect(unmountSpy).toHaveBeenCalledTimes(1);
  });
});
