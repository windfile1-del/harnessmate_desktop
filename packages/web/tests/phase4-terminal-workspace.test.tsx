import type {
  GitWorktreeEntry,
  ManagedTerminalTab,
  Session,
  TerminalContextChip,
  Workspace,
} from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerPendingTerminalContexts } from '../src/components/TerminalContextInlineChip';
import {
  TerminalStatusbarBadgeView,
  TerminalWorkspaceDrawerView,
} from '../src/components/TerminalWorkspaceDrawer';
import { WorktreeManagerModal } from '../src/components/WorktreeManagerModal';
import { daemonApi } from '../src/api/client';
import { parseAnsiSegments } from '../src/lib/ansi-render';
import { SlotRegistry, SlotRegistryProvider } from '../src/slots';
import { useAppStore } from '../src/stores/app-store';

const sampleWorkspace: Workspace = {
  id: 'ws_term_1',
  name: 'demo-repo',
  rootPath: '/repo/demo',
  isGitRepo: true,
  gitBranch: 'main',
  createdAt: 1_700_000_000_000,
};

const sampleSession: Session = {
  id: 'sess_term_1',
  workspaceId: sampleWorkspace.id,
  harnessId: 'codex-main',
  harnessKind: 'codex',
  nativeSessionId: null,
  participatingHarnesses: ['codex-main'],
  contextSyncMode: 'auto',
  cwd: '/repo/demo/.worktrees/feat-fix',
  worktreeBranch: 'feat-fix',
  title: 'Terminal Integration Session',
  status: 'idle',
  model: 'gpt-5',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 10,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_010_000,
};

const sampleTab1: ManagedTerminalTab = {
  terminalId: 'term_1',
  workspaceId: sampleWorkspace.id,
  cwd: '/repo/demo/.worktrees/feat-fix',
  title: 'Terminal #1',
  shell: '/bin/bash',
  pid: 4242,
  backend: 'pipe',
  status: 'running',
  exitCode: null,
  ringBufferBytes: 256,
  devServerHint: {
    command: 'pnpm dev',
    framework: 'Dev Server',
    detectedAt: 1_700_000_005_000,
  },
  createdAt: 1_700_000_000_000,
};

const sampleTab2: ManagedTerminalTab = {
  terminalId: 'term_2',
  workspaceId: sampleWorkspace.id,
  cwd: '/repo/demo/.worktrees/feat-fix',
  title: 'Terminal #2',
  shell: '/bin/bash',
  pid: 4243,
  backend: 'pty',
  status: 'running',
  exitCode: null,
  ringBufferBytes: 64,
  devServerHint: null,
  createdAt: 1_700_000_002_000,
};

describe('Phase 4.2 Frontend: TerminalWorkspaceDrawer, Inline Chips & Worktree Release UI', () => {
  it('renders multi-tab terminal drawer with Worktree CWD, backend indicator, dev server banner, and XSS-safe pure React ANSI spans', () => {
    const ansiAndXssOutput = [
      '\x1b[31mFAIL\x1b[0m tests/auth.test.ts',
      '\x1b[33mTypeError\x1b[0m: <script>alert("xss")</script> is not a function',
      '\x1b[32m✓\x1b[0m recovered step',
    ].join('\n');

    const segments = parseAnsiSegments(ansiAndXssOutput);
    expect(segments.some((s) => s.text === 'FAIL' && s.style.color)).toBe(true);

    const html = renderToStaticMarkup(
      <TerminalWorkspaceDrawerView
        session={sampleSession}
        terminals={[sampleTab1, sampleTab2]}
        activeTerminalId="term_1"
        outputText={ansiAndXssOutput}
        outputTruncated={false}
        ptyAvailable={false}
        commandInput=""
        onSelectTerminal={() => {}}
        onOpenTerminal={() => {}}
        onCloseTerminal={() => {}}
        onInterruptTerminal={() => {}}
        onRestartTerminal={() => {}}
        onCommandInputChange={() => {}}
        onSubmitCommand={() => {}}
        onAttachContextChip={() => {}}
      />,
    );

    expect(html).toContain('data-testid="terminal-workspace-drawer"');
    expect(html).toContain('/repo/demo/.worktrees/feat-fix');
    expect(html).toContain('Worktree: feat-fix');
    expect(html).toContain('Terminal #1');
    expect(html).toContain('Terminal #2');
    expect(html).toContain('Dev Server 运行中');
    expect(html).toContain('pnpm dev');
    expect(html).toContain('data-testid="terminal-backend-badge"');
    expect(html).toContain('pipe');
    expect(html).toContain('附加最近 50 行报错到对话 (Ctrl+Shift+L)');

    // Raw ANSI escapes stripped and HTML tags safely escaped (zero dangerouslySetInnerHTML)
    expect(html).not.toContain('\x1b[');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('renders multiple TerminalContextInlineChip pills with line ranges, truncation & expanded previews', () => {
    const chips: TerminalContextChip[] = [
      {
        id: 'tchip_1',
        terminalId: 'term_1',
        terminalTitle: 'Terminal #1',
        cwd: '/repo/demo/.worktrees/feat-fix',
        lineStart: 118,
        lineEnd: 164,
        cleanText: 'Error: Cannot read properties of undefined\n  at login (auth.ts:44)',
        truncated: false,
        exitCode: 1,
      },
      {
        id: 'tchip_2',
        terminalId: 'term_2',
        terminalTitle: 'Terminal #2',
        cwd: '/repo/demo/.worktrees/feat-fix',
        lineStart: 20,
        lineEnd: 69,
        cleanText: '... [truncated earlier output]\nerror[E0308]: mismatched types',
        truncated: true,
        exitCode: 101,
      },
    ];

    const html = renderToStaticMarkup(
      <ComposerPendingTerminalContexts
        chips={chips}
        onRemove={() => {}}
        defaultExpandedIds={['tchip_1']}
      />,
    );

    expect(html).toContain('data-testid="composer-terminal-chips"');
    expect(html).toContain('Terminal #1 · lines 118–164');
    expect(html).toContain('Terminal #2 · lines 20–69');
    expect(html).toContain('exit 1');
    expect(html).toContain('截断 ≤16KB');
    expect(html).toContain('data-testid="terminal-context-chip-preview-tchip_1"');
    expect(html).toContain('Error: Cannot read properties of undefined');
    expect(html).toContain('移除终端上下文 Terminal #1');
    expect(html).toContain('移除终端上下文 Terminal #2');
  });

  it('mounts TerminalWorkspaceDrawer & statusbar badge via SlotRegistry only when registered', () => {
    const registry = new SlotRegistry();
    const disposeTab = registry.register({
      slot: 'inspector.tabs',
      id: 'terminal-workspace',
      pluginId: 'hm.plugin.terminal-workspace',
      pluginName: 'Integrated Terminal Workspace',
      title: '集成终端',
      key: 'terminal-workspace',
      order: 85,
      sourceKind: 'builtin',
      render: () => (
        <TerminalWorkspaceDrawerView
          session={sampleSession}
          terminals={[sampleTab1, sampleTab2]}
          activeTerminalId="term_1"
          outputText="ready"
          ptyAvailable={false}
          commandInput=""
          onSelectTerminal={() => {}}
          onOpenTerminal={() => {}}
          onCloseTerminal={() => {}}
          onInterruptTerminal={() => {}}
          onRestartTerminal={() => {}}
          onCommandInputChange={() => {}}
          onSubmitCommand={() => {}}
          onAttachContextChip={() => {}}
        />
      ),
    });
    const disposeStatus = registry.register({
      slot: 'statusbar.items',
      id: 'terminal-workspace-count',
      pluginId: 'hm.plugin.terminal-workspace',
      pluginName: 'Integrated Terminal Workspace',
      title: '托管终端计数',
      order: 100,
      sourceKind: 'builtin',
      render: () => <TerminalStatusbarBadgeView runningCount={2} />,
    });

    const tabItems = registry.getItems('inspector.tabs', {
      hasSession: true,
      matchKey: 'terminal-workspace',
    });
    const statusItems = registry.getItems('statusbar.items', { hasSession: false });
    expect(tabItems).toHaveLength(1);
    expect(statusItems).toHaveLength(1);

    const statusHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        {statusItems[0]!.render({ session: sampleSession })}
      </SlotRegistryProvider>,
    );
    expect(statusHtml).toContain('data-testid="statusbar-terminal-badge"');
    expect(statusHtml).toContain('2 Terminals');

    disposeTab();
    disposeStatus();
    expect(registry.getItems('inspector.tabs', { hasSession: true })).toHaveLength(0);
    expect(registry.getItems('statusbar.items', { hasSession: false })).toHaveLength(0);
  });

  it('shows blocking terminal warning and 1-click release button inside WorktreeManagerModal', () => {
    const worktrees: GitWorktreeEntry[] = [
      {
        path: sampleWorkspace.rootPath,
        headSha: 'aaaa1111bbbb2222',
        branch: 'main',
        isMain: true,
        isBare: false,
        locked: false,
        prunable: false,
        dirtyCount: 0,
        linkedSessionIds: [],
      },
      {
        path: sampleTab1.cwd,
        headSha: 'cccc3333dddd4444',
        branch: 'feat-fix',
        isMain: false,
        isBare: false,
        locked: false,
        prunable: false,
        dirtyCount: 1,
        linkedSessionIds: [sampleSession.id],
      },
    ];

    const html = renderToStaticMarkup(
      <WorktreeManagerModal
        onClose={() => {}}
        workspacesOverride={[sampleWorkspace]}
        initialWorktrees={worktrees}
        initialBlockingTerminals={{ [sampleTab1.cwd]: [sampleTab1] }}
      />,
    );

    expect(html).toContain('data-testid="worktree-terminal-busy-badge"');
    expect(html).toContain('Terminal #1');
    expect(html).toContain('data-testid="release-worktree-terminals-btn"');
    expect(html).toContain('一键释放占用终端');
  });

  it('stores, clears, and forwards terminalContexts via Zustand store and daemonApi.sendTurn', async () => {
    const chip: TerminalContextChip = {
      id: 'tchip_send_1',
      terminalId: 'term_1',
      terminalTitle: 'Terminal #1',
      cwd: sampleSession.cwd,
      lineStart: 10,
      lineEnd: 25,
      cleanText: 'Error: Test failure line',
      truncated: false,
      exitCode: 1,
    };

    const store = useAppStore.getState();
    store.addPendingTerminalChip(sampleSession.id, chip);
    expect(useAppStore.getState().pendingTerminalChipsBySession[sampleSession.id]).toHaveLength(1);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ turnId: 'turn_1' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await daemonApi.sendTurn(sampleSession.id, 'Fix failure', undefined, {
        terminalContexts: [chip],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const bodyJson = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        terminalContexts?: TerminalContextChip[];
      };
      expect(bodyJson.terminalContexts).toHaveLength(1);
      expect(bodyJson.terminalContexts?.[0]?.id).toBe('tchip_send_1');
    } finally {
      vi.unstubAllGlobals();
    }

    useAppStore.getState().clearDraft(sampleSession.id);
    expect(useAppStore.getState().pendingTerminalChipsBySession[sampleSession.id]).toEqual([]);
  });
});
