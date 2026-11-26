import type { InstalledPluginInfo, Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelRecoveryView } from '../src/components/KernelRecoveryView';
import { FilePreviewBody } from '../src/components/FilePreviewBody';
import { daemonApi } from '../src/api/client';
import { SlotRegistry, SlotRegistryProvider, SlotSessionProvider } from '../src/slots';
import { PluginWorkspaceLinks } from '../src/slots/PluginWorkspace';
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

const sampleSession: Session = {
  id: 'sess_peer_1',
  workspaceId: 'ws_peer_1',
  harnessId: 'codex',
  harnessKind: 'codex',
  nativeSessionId: null,
  participatingHarnesses: ['codex'],
  contextSyncMode: 'auto',
  cwd: '/repo/peer',
  title: 'Peer Plugin Session',
  status: 'idle',
  model: 'gpt-5',
  reasoningEffort: null,
  permissionMode: 'manual',
  lastSeq: 1,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Peer Plugin Web UI', () => {
  it('renders KernelRecoveryView when emptyComposition is active and supports restore actions', async () => {
    const restoreSpy = vi.spyOn(daemonApi, 'restorePluginComposition').mockResolvedValue({
      plugins: [],
      catalog: [],
      slashCommands: [],
      mcpPresets: [],
      pluginsDir: '/plugins',
      emptyComposition: false,
    });

    const html = renderToStaticMarkup(<KernelRecoveryView />);
    expect(html).toContain('内核恢复模式（空业务组合）');
    expect(html).toContain('重新启用预装组合');
    expect(html).toContain('恢复上一套配置');
    expect(html).toContain('打开插件恢复中心');

    await useAppStore.getState().restorePluginComposition('empty');
    await useAppStore.getState().restorePluginComposition('builtin');
    expect(restoreSpy).toHaveBeenNthCalledWith(1, 'empty');
    expect(restoreSpy).toHaveBeenNthCalledWith(2, 'builtin');
    expect(useAppStore.getState().emptyComposition).toBe(false);
  });

  it('renders simultaneous dual browser workspace pages and session browser switcher in PluginWorkspaceLinks', async () => {
    const registry = new SlotRegistry();
    registry.register({
      slot: 'workspace.pages',
      id: 'desktop-browser',
      pluginId: 'hm.plugin.browser-desktop',
      pluginName: '桌面浏览器',
      title: '桌面浏览器',
      render: () => <div />,
    });
    registry.register({
      slot: 'workspace.pages',
      id: 'headless-browser',
      pluginId: 'hm.plugin.browser-headless',
      pluginName: '无头浏览器',
      title: '无头浏览器',
      render: () => <div />,
    });

    const plugins: InstalledPluginInfo[] = [
      {
        id: 'hm.plugin.browser-desktop',
        instanceId: 'hm.plugin.browser-desktop',
        name: '桌面浏览器',
        version: '1.0.0',
        category: 'ui',
        contributes: {},
        provides: ['browser.v1'],
        providedContracts: [{ contract: 'browser.v1', version: '1.0.0' }],
        enabled: true,
        builtin: true,
        source: 'builtin',
        sourceKind: 'bundled',
        runtimeState: 'ACTIVE',
      },
      {
        id: 'hm.plugin.browser-headless',
        instanceId: 'hm.plugin.browser-headless',
        name: '无头浏览器',
        version: '1.0.0',
        category: 'ui',
        contributes: {},
        provides: ['browser.v1'],
        providedContracts: [{ contract: 'browser.v1', version: '1.0.0' }],
        enabled: true,
        builtin: true,
        source: 'builtin',
        sourceKind: 'bundled',
        runtimeState: 'ACTIVE',
      },
    ];

    useAppStore.setState({
      selectedSessionId: sampleSession.id,
      plugins,
      sessionBindingsBySession: {
        [sampleSession.id]: { 'browser.v1': 'hm.plugin.browser-headless' },
      },
    });

    const html = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <PluginWorkspaceLinks />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );

    expect(html).toContain('桌面浏览器');
    expect(html).toContain('无头浏览器');
    expect(html).toContain('会话浏览器');
    expect(html).toContain('hm.plugin.browser-desktop');
    expect(html).toContain('hm.plugin.browser-headless');

    const bindSpy = vi.spyOn(daemonApi, 'setSessionBinding').mockResolvedValue({
      sessionId: sampleSession.id,
      resolved: { contract: 'browser.v1', instanceId: 'hm.plugin.browser-desktop', source: 'session' },
    });
    await useAppStore.getState().setSessionBinding(sampleSession.id, 'browser.v1', 'hm.plugin.browser-desktop');
    expect(bindSpy).toHaveBeenCalledWith(sampleSession.id, 'browser.v1', 'hm.plugin.browser-desktop');
    expect(useAppStore.getState().sessionBindingsBySession[sampleSession.id]?.['browser.v1']).toBe('hm.plugin.browser-desktop');
  });

  it('renders both text and markdown FilePreviewBody viewers preserving highlighted line', () => {
    const content = '# Heading\nline2\ntarget line 3';
    const textHtml = renderToStaticMarkup(
      <FilePreviewBody
        content={content}
        line={3}
        truncated={false}
        preview={{
          version: 1,
          format: 'text',
          content,
          line: 3,
          pluginId: 'hm.plugin.file-preview-text',
          instanceId: 'hm.plugin.file-preview-text',
          pluginName: '文本文件预览',
        }}
        onOpenFile={() => {}}
        onRenderError={() => {}}
      />,
    );
    const mdHtml = renderToStaticMarkup(
      <FilePreviewBody
        content={content}
        line={3}
        truncated={false}
        preview={{
          version: 1,
          format: 'markdown',
          content,
          line: 3,
          pluginId: 'hm.plugin.file-preview-markdown',
          instanceId: 'hm.plugin.file-preview-markdown',
          pluginName: 'Markdown 文件预览',
        }}
        onOpenFile={() => {}}
        onRenderError={() => {}}
      />,
    );

    expect(textHtml).toContain('data-file-preview-line="3"');
    expect(mdHtml).toContain('<h1');
    expect(mdHtml).toContain('data-file-preview-line="3"');
  });
});
