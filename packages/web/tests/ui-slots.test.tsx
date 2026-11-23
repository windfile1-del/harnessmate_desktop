import type { ApprovalRequest, Session } from '@harnessmate/protocol';
import { normalizePluginSlotKey } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Slot,
  SlotErrorBoundary,
  SlotRegistry,
  SlotRegistryProvider,
  SlotSessionProvider,
  buildIframeSrcDoc,
} from '../src/slots';

const sampleSession: Session = {
  id: 'sess_1',
  workspaceId: 'ws_1',
  harnessId: 'codex',
  harnessKind: 'codex',
  participatingHarnesses: ['codex'],
  contextSyncMode: 'auto',
  cwd: '/repo',
  title: 'Refactor UI Slots',
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

const sampleApproval: ApprovalRequest = {
  id: 'appr_1',
  sessionId: 'sess_1',
  nativeRequestId: 'nat_1',
  toolName: 'Bash',
  toolKind: 'shell',
  summary: 'rm -rf dist',
  input: { command: 'rm -rf dist' },
  riskLevel: 'high',
  status: 'pending',
  createdAt: 1500,
};

describe('Typed UI Slots (P4)', () => {
  it('supports single, list, keyed, chain, and hoc cardinalities with deterministic ordering and disposers', () => {
    const registry = new SlotRegistry();

    // 1. single: lowest order wins
    const disposeTitleLow = registry.register({
      slot: 'session.header.title',
      id: 'low-priority',
      pluginId: 'p.a',
      pluginName: 'Plugin A',
      order: 200,
      render: ({ session }) => <span>Low:{session.title}</span>,
    });
    const disposeTitleHigh = registry.register({
      slot: 'session.header.title',
      id: 'high-priority',
      pluginId: 'p.b',
      pluginName: 'Plugin B',
      order: 10,
      render: ({ session }) => <span>High:{session.title}</span>,
    });

    const singleHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="session.header.title"
            slotProps={{ session: sampleSession, onRename: () => {} }}
            fallback={<span>Fallback</span>}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(singleHtml).toContain('High:Refactor UI Slots');
    expect(singleHtml).not.toContain('Low:');

    // Disposer removes winner so next item takes over
    disposeTitleHigh();
    const afterDisposeHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="session.header.title"
            slotProps={{ session: sampleSession, onRename: () => {} }}
            fallback={<span>Fallback</span>}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(afterDisposeHtml).toContain('Low:Refactor UI Slots');
    disposeTitleLow();

    // 2. list: rendered in ascending order
    registry.register({
      slot: 'statusbar.items',
      id: 'second',
      pluginId: 'p.b',
      pluginName: 'Plugin B',
      order: 20,
      render: () => <span>Item-2</span>,
    });
    registry.register({
      slot: 'statusbar.items',
      id: 'first',
      pluginId: 'p.a',
      pluginName: 'Plugin A',
      order: 10,
      render: () => <span>Item-1</span>,
    });
    const listHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={null}>
          <Slot name="statusbar.items" slotProps={{ session: null }} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(listHtml.indexOf('Item-1')).toBeGreaterThan(-1);
    expect(listHtml.indexOf('Item-2')).toBeGreaterThan(listHtml.indexOf('Item-1'));

    // 3. keyed: only matching key renders
    registry.register({
      slot: 'tool.result',
      id: 'bash-view',
      pluginId: 'p.bash',
      pluginName: 'Bash Viewer',
      key: 'Bash',
      render: ({ tool }) => <div>CustomBash:{tool.summary}</div>,
    });
    registry.register({
      slot: 'tool.result',
      id: 'edit-view',
      pluginId: 'p.edit',
      pluginName: 'Edit Viewer',
      key: 'Edit',
      render: () => <div>CustomEdit</div>,
    });
    const keyedHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="tool.result"
            matchKey="Bash"
            slotProps={{
              session: sampleSession,
              tool: {
                toolCallId: 'tc1',
                toolName: 'Bash',
                toolKind: 'shell',
                summary: 'pnpm test',
                status: 'success',
                startedAt: 1000,
              },
            }}
            fallback={<div>DefaultTool</div>}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(keyedHtml).toContain('CustomBash:pnpm test');
    expect(keyedHtml).not.toContain('CustomEdit');

    // 4. hoc: wraps children from outermost to innermost by order
    registry.register({
      slot: 'chat.message.wrapper',
      id: 'outer',
      pluginId: 'p.outer',
      pluginName: 'Outer Wrapper',
      order: 10,
      render: ({ children }) => <div data-wrap="outer">{children}</div>,
    });
    registry.register({
      slot: 'chat.message.wrapper',
      id: 'inner',
      pluginId: 'p.inner',
      pluginName: 'Inner Wrapper',
      order: 20,
      render: ({ children }) => <section data-wrap="inner">{children}</section>,
    });
    const hocHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="chat.message.wrapper"
            slotProps={{
              session: sampleSession,
              turn: {
                turnId: 't1',
                seq: 1,
                userText: 'hi',
                userAttachments: [],
                assistantText: 'hello',
                thinking: '',
                thinkingDone: true,
                tools: [],
                approvals: [],
                status: 'completed',
                createdAt: 1000,
              },
              children: null,
            }}
          >
            <p>MessageBody</p>
          </Slot>
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(hocHtml).toBe('<div data-wrap="outer"><section data-wrap="inner"><p>MessageBody</p></section></div>');
  });

  it('enforces session scope isolation and normalizes inspector.tab alias', () => {
    const registry = new SlotRegistry();
    expect(normalizePluginSlotKey('inspector.tab')).toBe('inspector.tabs');

    registry.register({
      slot: 'inspector.tabs',
      id: 'panel-1',
      pluginId: 'user.ui',
      pluginName: 'UI Plugin',
      render: ({ session }) => <div>Tab:{session.id}</div>,
    });

    // Without session, session-scoped slot returns empty
    expect(registry.getItems('inspector.tabs', { hasSession: false })).toHaveLength(0);
    // With session, slot returns registered item
    expect(registry.getItems('inspector.tabs', { hasSession: true })).toHaveLength(1);

    const noSessionHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={null}>
          <Slot
            name="session.header.title"
            slotProps={{ session: sampleSession, onRename: () => {} }}
            fallback={<span>NoSessionFallback</span>}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(noSessionHtml).toBe('<span>NoSessionFallback</span>');
  });

  it('isolates render failures in chain slots and error boundaries while reporting to SlotRegistry', () => {
    const registry = new SlotRegistry();

    // First item returns null (passes through), second throws, third handles it cleanly
    registry.register({
      slot: 'approval.detail',
      id: 'skip',
      pluginId: 'p.skip',
      pluginName: 'Skipper',
      order: 10,
      render: () => null,
    });
    registry.register({
      slot: 'approval.detail',
      id: 'broken',
      pluginId: 'p.broken',
      pluginName: 'Broken Renderer',
      order: 20,
      render: () => {
        throw new Error('Boom inside chain');
      },
    });
    registry.register({
      slot: 'approval.detail',
      id: 'healthy',
      pluginId: 'p.healthy',
      pluginName: 'Healthy Renderer',
      order: 30,
      render: ({ approval }) => <div>SafeDetail:{approval.toolName}</div>,
    });

    const chainHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="approval.detail"
            slotProps={{ session: sampleSession, approval: sampleApproval }}
            fallback={<div>FallbackDetail</div>}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );

    expect(chainHtml).toContain('SafeDetail:Bash');
    const failures = registry.getRenderFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pluginId).toBe('p.broken');
    expect(failures[0]?.message).toContain('Boom inside chain');

    // Verify SlotErrorBoundary reports failure via componentDidCatch and derives error state
    const boundary = new SlotErrorBoundary({
      registry,
      item: {
        pluginId: 'p.widget',
        pluginName: 'Broken Widget',
        slot: 'inspector.tabs',
        id: 'w1',
        title: 'Widget 1',
      },
      children: null,
    });
    const nextState = SlotErrorBoundary.getDerivedStateFromError(new Error('Widget crashed'));
    expect(nextState.error?.message).toBe('Widget crashed');
    boundary.componentDidCatch(new Error('Widget crashed'), { componentStack: '' });
    expect(registry.getRenderFailures().some((f) => f.pluginId === 'p.widget' && f.message === 'Widget crashed')).toBe(true);
  });

  it('builds sandboxed iframe srcDoc with strict CSP, theme CSS vars, and safe postMessage bridge', () => {
    const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'";
    const srcDoc = buildIframeSrcDoc({
      html: '<!doctype html><html><head><title>PR Guard</title></head><body><div id="root"></div></body></html>',
      csp,
      theme: 'dark',
      cssVars: {
        '--bg-surface': '#121623',
        '--text-primary': '#f2f4fb',
        '--invalid;inject': 'red',
      },
      pluginId: 'user.pr-guard',
      runId: 'run_123',
      slotId: 'pr-panel',
      slot: 'inspector.tabs',
      session: {
        id: 'sess_1',
        workspaceId: 'ws_1',
        harnessId: 'codex',
        harnessKind: 'codex',
        title: 'Test </script><script>alert(1)</script>',
        status: 'idle',
        model: 'gpt-5',
        permissionMode: 'manual',
        cwd: '/repo',
        createdAt: 1000,
        updatedAt: 2000,
      },
      props: { custom: true },
    });

    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain("connect-src &#39;none&#39;".replace(/&#39;/g, "'"));
    expect(srcDoc).toContain('--bg-surface: #121623;');
    expect(srcDoc).toContain('--text-primary: #f2f4fb;');
    expect(srcDoc).not.toContain('--invalid;inject');
    expect(srcDoc).toContain('window.harnessMate');
    expect(srcDoc).toContain('hm:rpc:request');
    expect(srcDoc).toContain('hm:theme');
    // Ensure script tag breakout is escaped
    expect(srcDoc).not.toContain('</script><script>alert(1)</script>');
    expect(srcDoc).toContain('\\u003c/script\\u003e');
  });
});
