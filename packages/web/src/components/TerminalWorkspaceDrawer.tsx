import type { ManagedTerminalTab, Session } from '@harnessmate/protocol';
import {
  Activity,
  CornerDownLeft,
  Loader2,
  Paperclip,
  Plus,
  RotateCcw,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAnsiSegments, stripAnsiClient } from '../lib/ansi-render';
import { TERMINAL_WORKSPACE_CONTRACT } from '../api/peer-contracts';
import { useSlotItems } from '../slots';
import { useAppStore } from '../stores/app-store';

function normalizeCwd(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export interface TerminalWorkspaceDrawerViewProps {
  session: Session;
  terminals: readonly ManagedTerminalTab[];
  activeTerminalId: string | null;
  outputText: string;
  outputTruncated?: boolean;
  ptyAvailable: boolean;
  opening?: boolean;
  attaching?: boolean;
  commandInput: string;
  onSelectTerminal: (terminalId: string) => void;
  onOpenTerminal: () => void;
  onCloseTerminal: (terminalId: string) => void;
  onInterruptTerminal: (terminalId: string) => void;
  onRestartTerminal: (terminalId: string) => void;
  onCommandInputChange: (value: string) => void;
  onSubmitCommand: (command: string) => void;
  onAttachContextChip: (opts?: {
    selectedText?: string;
    lineStart?: number;
    lineEnd?: number;
    recentLines?: number;
  }) => void;
}

export function TerminalWorkspaceDrawerView({
  session,
  terminals,
  activeTerminalId,
  outputText,
  outputTruncated = false,
  ptyAvailable,
  opening = false,
  attaching = false,
  commandInput,
  onSelectTerminal,
  onOpenTerminal,
  onCloseTerminal,
  onInterruptTerminal,
  onRestartTerminal,
  onCommandInputChange,
  onSubmitCommand,
  onAttachContextChip,
}: TerminalWorkspaceDrawerViewProps) {
  const viewportRef = useRef<HTMLPreElement>(null);
  const [selectionHint, setSelectionHint] = useState<string>('');

  const activeTab = useMemo(
    () => terminals.find((t) => t.terminalId === activeTerminalId) ?? terminals[0] ?? null,
    [terminals, activeTerminalId],
  );

  const outputLines = useMemo(() => {
    if (!outputText) return [];
    const normalized = outputText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }, [outputText]);

  const handleCaptureSelection = useCallback(() => {
    if (typeof window === 'undefined' || !viewportRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelectionHint('');
      return;
    }
    const anchorInView = sel.anchorNode && viewportRef.current.contains(sel.anchorNode);
    const focusInView = sel.focusNode && viewportRef.current.contains(sel.focusNode);
    if (anchorInView && focusInView) {
      const cleaned = stripAnsiClient(sel.toString()).trim();
      setSelectionHint(cleaned);
    } else {
      setSelectionHint('');
    }
  }, []);

  const triggerAttach = useCallback(() => {
    if (!activeTab) return;
    if (selectionHint.trim()) {
      onAttachContextChip({ selectedText: selectionHint });
      setSelectionHint('');
      return;
    }
    onAttachContextChip({ recentLines: 50 });
  }, [activeTab, selectionHint, onAttachContextChip]);

  useEffect(() => {
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [outputText]);

  const activeBackendLabel = activeTab?.backend ?? (ptyAvailable ? 'pty' : 'pipe');

  return (
    <div
      data-testid="terminal-workspace-drawer"
      className="flex flex-col gap-2.5 text-[12px] text-[var(--text-secondary)]"
    >
      {/* Session CWD + Backend Mode Header */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-2.5 py-2"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Terminal size={12.5} className="shrink-0 text-[var(--accent-indigo)]" />
            <span className="font-medium text-[var(--text-primary)]">持久工作区终端</span>
            {session.worktreeBranch && (
              <span
                className="rounded-full px-1.5 py-0.5 font-mono-code text-[9.5px]"
                style={{
                  backgroundColor: 'var(--accent-indigo-soft)',
                  color: 'var(--accent-indigo)',
                }}
              >
                Worktree: {session.worktreeBranch}
              </span>
            )}
            <span
              data-testid="terminal-backend-badge"
              className="rounded px-1.5 py-0.5 font-mono-code text-[9.5px]"
              style={{
                backgroundColor:
                  activeBackendLabel === 'pty' ? 'var(--accent-emerald-soft)' : 'var(--bg-surface)',
                color:
                  activeBackendLabel === 'pty'
                    ? 'var(--accent-emerald)'
                    : 'var(--text-muted)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {activeBackendLabel}
            </span>
          </div>
          <div
            data-testid="terminal-session-cwd"
            title={activeTab?.cwd ?? session.cwd}
            className="truncate font-mono-code text-[10.5px] text-[var(--text-muted)]"
          >
            {activeTab?.cwd ?? session.cwd}
          </div>
        </div>

        <button
          type="button"
          data-testid="open-terminal-btn"
          disabled={opening}
          onClick={onOpenTerminal}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: 'var(--accent-indigo)' }}
        >
          {opening ? <Loader2 size={11.5} className="animate-spin" /> : <Plus size={12} />}
          <span>新建终端</span>
        </button>
      </div>

      {/* Multi-Tab Strip */}
      {terminals.length > 0 && (
        <div
          data-testid="terminal-tabs-bar"
          className="flex items-center gap-1 overflow-x-auto pb-0.5"
        >
          {terminals.map((tab) => {
            const isActive = tab.terminalId === activeTab?.terminalId;
            return (
              <div
                key={tab.terminalId}
                data-testid={`terminal-tab-${tab.terminalId}`}
                className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px]"
                style={{
                  backgroundColor: isActive ? 'var(--accent-indigo-soft)' : 'var(--bg-surface)',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: `1px solid ${isActive ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelectTerminal(tab.terminalId)}
                  className="inline-flex cursor-pointer items-center gap-1.5"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor:
                        tab.status === 'running' ? 'var(--accent-emerald)' : 'var(--text-muted)',
                    }}
                  />
                  <span className="font-mono-code">{tab.title}</span>
                  {tab.devServerHint && (
                    <span
                      className="rounded px-1 text-[9px]"
                      style={{
                        backgroundColor: 'var(--accent-emerald-soft)',
                        color: 'var(--accent-emerald)',
                      }}
                    >
                      {tab.devServerHint.framework}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`关闭终端 ${tab.title}`}
                  onClick={() => onCloseTerminal(tab.terminalId)}
                  className="cursor-pointer rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-rose)]"
                >
                  <X size={10.5} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Dev Server Hint Banner */}
      {activeTab?.devServerHint && (
        <div
          data-testid="terminal-dev-server-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'var(--accent-emerald-soft)',
            border: '1px solid color-mix(in srgb, var(--accent-emerald) 30%, transparent)',
          }}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <Activity size={12.5} className="shrink-0 text-[var(--accent-emerald)]" />
            <span className="font-medium text-[var(--text-primary)]">
              {activeTab.devServerHint.framework} 运行中
            </span>
            <code className="truncate font-mono-code text-[10px] text-[var(--text-secondary)]">
              {activeTab.devServerHint.command}
            </code>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onRestartTerminal(activeTab.terminalId)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <RotateCcw size={10.5} />
              <span>重启</span>
            </button>
            <button
              type="button"
              onClick={() => onInterruptTerminal(activeTab.terminalId)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--accent-rose)] hover:bg-[var(--bg-hover)]"
              style={{ border: '1px solid color-mix(in srgb, var(--accent-rose) 30%, transparent)' }}
            >
              <Square size={10} />
              <span>终止</span>
            </button>
          </div>
        </div>
      )}

      {/* Terminal Output Viewport (Pure-React Safe ANSI Rendering) */}
      {!activeTab ? (
        <div
          className="rounded-xl px-4 py-6 text-center text-[11.5px] text-[var(--text-muted)]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px dashed var(--border-hairline)',
          }}
        >
          当前工作目录暂无运行中终端，点击上方「新建终端」在{' '}
          <code className="font-mono-code text-[var(--text-secondary)]">{session.cwd}</code>{' '}
          启动交互 Shell。
        </div>
      ) : (
        <>
          <div
            className="overflow-hidden rounded-xl"
            style={{
              backgroundColor: '#0d1117',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-2.5 py-1.5 text-[10.5px] text-slate-300">
              <div className="flex items-center gap-2 font-mono-code">
                <span>
                  {activeTab.title} · PID {activeTab.pid}
                </span>
                <span>
                  {activeTab.status === 'running'
                    ? 'running'
                    : `exited (${activeTab.exitCode ?? 0})`}
                </span>
                {outputTruncated && (
                  <span className="text-amber-300">环形缓冲 512KB 已滚出早期行</span>
                )}
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="attach-terminal-chip-btn"
                  disabled={attaching}
                  onClick={triggerAttach}
                  title="将终端报错输出清洗 ANSI 并截断 ≤16KB 附加到对话输入框 (Ctrl+Shift+L)"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-indigo-500/25 px-2 py-0.5 text-[10.5px] font-medium text-indigo-200 hover:bg-indigo-500/40 disabled:opacity-45"
                >
                  {attaching ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Paperclip size={11} />
                  )}
                  <span>
                    {selectionHint.trim()
                      ? '附加选中输出到对话 (Ctrl+Shift+L)'
                      : '附加最近 50 行报错到对话 (Ctrl+Shift+L)'}
                  </span>
                </button>
              </div>
            </div>

            <pre
              ref={viewportRef}
              data-testid="terminal-output-viewport"
              onMouseUp={handleCaptureSelection}
              onKeyUp={handleCaptureSelection}
              className="max-h-64 min-h-[150px] overflow-auto p-2.5 font-mono-code text-[11px] leading-relaxed text-slate-200 select-text"
            >
              {outputLines.length === 0 ? (
                <span className="text-slate-500">等待终端输出...</span>
              ) : (
                outputLines.map((line, lineIdx) => {
                  const segments = parseAnsiSegments(line);
                  return (
                    <div key={lineIdx} className="flex gap-2">
                      <span className="w-7 shrink-0 select-none text-right text-[10px] text-slate-600">
                        {lineIdx + 1}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
                        {segments.length === 0
                          ? '\u00a0'
                          : segments.map((seg, segIdx) => (
                              <span
                                key={segIdx}
                                style={{
                                  ...(seg.style.color ? { color: seg.style.color } : {}),
                                  ...(seg.style.bgColor
                                    ? { backgroundColor: seg.style.bgColor }
                                    : {}),
                                  ...(seg.style.bold ? { fontWeight: 600 } : {}),
                                  ...(seg.style.dim ? { opacity: 0.72 } : {}),
                                }}
                              >
                                {seg.text}
                              </span>
                            ))}
                      </span>
                    </div>
                  );
                })
              )}
            </pre>
          </div>

          {/* Interactive Command Input + Controls */}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!commandInput.trim()) return;
              onSubmitCommand(commandInput);
            }}
          >
            <input
              data-testid="terminal-command-input"
              value={commandInput}
              disabled={activeTab.status !== 'running'}
              onChange={(e) => onCommandInputChange(e.target.value)}
              placeholder={
                activeTab.status === 'running'
                  ? '输入交互式命令（回车发送）...'
                  : '终端已退出，点击右侧重启...'
              }
              className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 font-mono-code text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none disabled:opacity-50"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            />
            <button
              type="submit"
              disabled={activeTab.status !== 'running' || !commandInput.trim()}
              title="发送命令"
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <CornerDownLeft size={12} />
            </button>
            <button
              type="button"
              data-testid="terminal-ctrl-c-btn"
              disabled={activeTab.status !== 'running'}
              onClick={() => onInterruptTerminal(activeTab.terminalId)}
              title="发送 Ctrl+C 中断当前命令"
              className="cursor-pointer rounded-lg px-2 py-1.5 font-mono-code text-[10.5px] text-[var(--accent-rose)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              Ctrl+C
            </button>
            <button
              type="button"
              data-testid="terminal-restart-btn"
              onClick={() => onRestartTerminal(activeTab.terminalId)}
              title="重启当前终端进程"
              className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <RotateCcw size={12} />
            </button>
          </form>
        </>
      )}
    </div>
  );
}

export function TerminalWorkspaceDrawer({ session }: { session: Session }) {
  const terminalsMap = useAppStore((s) => s.terminalsByWorkspace);
  const ptyAvailable = useAppStore((s) => s.terminalPtyAvailable);
  const outputMap = useAppStore((s) => s.terminalOutputById);
  const refreshWorkspaceTerminals = useAppStore((s) => s.refreshWorkspaceTerminals);
  const openWorkspaceTerminal = useAppStore((s) => s.openWorkspaceTerminal);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const restartTerminal = useAppStore((s) => s.restartTerminal);
  const interruptTerminal = useAppStore((s) => s.interruptTerminal);
  const sendTerminalInput = useAppStore((s) => s.sendTerminalInput);
  const subscribeTerminalOutput = useAppStore((s) => s.subscribeTerminalOutput);
  const attachTerminalContextChip = useAppStore((s) => s.attachTerminalContextChip);

  const workspaceTerminals = terminalsMap[session.workspaceId] ?? [];
  const cwdTerminals = useMemo(() => {
    const targetCwd = normalizeCwd(session.cwd);
    const matching = workspaceTerminals.filter((t) => normalizeCwd(t.cwd) === targetCwd);
    return matching.length > 0 ? matching : workspaceTerminals;
  }, [workspaceTerminals, session.cwd]);

  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [opening, setOpening] = useState(false);
  const [attaching, setAttaching] = useState(false);

  const activeTab = useMemo(
    () => cwdTerminals.find((t) => t.terminalId === selectedTabId) ?? cwdTerminals[0] ?? null,
    [cwdTerminals, selectedTabId],
  );
  const activeTerminalId = activeTab?.terminalId ?? null;

  useEffect(() => {
    void refreshWorkspaceTerminals(session.workspaceId);
  }, [session.workspaceId, session.cwd, refreshWorkspaceTerminals]);

  useEffect(() => {
    if (!activeTerminalId) return;
    return subscribeTerminalOutput(activeTerminalId);
  }, [activeTerminalId, subscribeTerminalOutput]);

  const handleAttachChip = useCallback(
    async (opts?: {
      selectedText?: string;
      lineStart?: number;
      lineEnd?: number;
      recentLines?: number;
    }) => {
      if (!activeTerminalId) return;
      setAttaching(true);
      try {
        await attachTerminalContextChip(session.id, activeTerminalId, opts ?? { recentLines: 50 });
      } finally {
        setAttaching(false);
      }
    },
    [activeTerminalId, session.id, attachTerminalContextChip],
  );

  // Global Ctrl+Shift+L hotkey while terminal drawer is open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l' && activeTerminalId) {
        e.preventDefault();
        const sel = window.getSelection()?.toString();
        const trimmedSel = sel ? stripAnsiClient(sel).trim() : '';
        void handleAttachChip(trimmedSel ? { selectedText: trimmedSel } : { recentLines: 50 });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTerminalId, handleAttachChip]);

  const outputEntry = activeTerminalId ? outputMap[activeTerminalId] : undefined;

  return (
    <TerminalWorkspaceDrawerView
      session={session}
      terminals={cwdTerminals}
      activeTerminalId={activeTerminalId}
      outputText={outputEntry?.text ?? ''}
      outputTruncated={outputEntry?.truncated ?? false}
      ptyAvailable={ptyAvailable}
      opening={opening}
      attaching={attaching}
      commandInput={commandInput}
      onSelectTerminal={(id) => setSelectedTabId(id)}
      onOpenTerminal={() => {
        setOpening(true);
        void openWorkspaceTerminal(session.workspaceId, {
          cwd: session.cwd,
          sessionId: session.id,
        })
          .then((tab) => {
            if (tab) setSelectedTabId(tab.terminalId);
          })
          .finally(() => setOpening(false));
      }}
      onCloseTerminal={(id) => void closeTerminal(session.workspaceId, id)}
      onInterruptTerminal={(id) => void interruptTerminal(id)}
      onRestartTerminal={(id) => void restartTerminal(id)}
      onCommandInputChange={setCommandInput}
      onSubmitCommand={(cmd) => {
        if (!activeTerminalId) return;
        setCommandInput('');
        void sendTerminalInput(activeTerminalId, `${cmd}\n`);
      }}
      onAttachContextChip={(opts) => void handleAttachChip(opts)}
    />
  );
}

export function TerminalStatusbarBadgeView({
  runningCount,
  onClick,
}: {
  runningCount: number;
  onClick?: () => void;
}) {
  const label = `${runningCount} Terminal${runningCount === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      data-testid="statusbar-terminal-badge"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      <Terminal size={11.5} className="text-[var(--accent-indigo)]" />
      <span className="font-mono-code">{label}</span>
    </button>
  );
}

export function TerminalStatusbarBadge({ session }: { session: Session | null }) {
  const terminalsByWorkspace = useAppStore((s) => s.terminalsByWorkspace);
  const resolveContractLocal = useAppStore((s) => s.resolveContractLocal);
  const openPluginPanel = useAppStore((s) => s.openPluginPanel);
  const inspectorTabItems = useSlotItems('inspector.tabs');
  const terminalTabKey = useMemo(() => {
    const slotMatch = inspectorTabItems.find(
      (item) => item.key === 'terminal-workspace' || item.id === 'terminal-workspace',
    );
    if (slotMatch) return slotMatch.registrationKey;
    const resolution = resolveContractLocal(TERMINAL_WORKSPACE_CONTRACT, {
      sessionId: session?.id,
      workspaceId: session?.workspaceId,
    });
    return resolution.instanceId
      ? `${resolution.instanceId}:terminal-workspace`
      : 'hm.plugin.terminal-workspace:terminal-workspace';
  }, [inspectorTabItems, resolveContractLocal, session?.id, session?.workspaceId]);

  const runningCount = useMemo(() => {
    if (session) {
      return (terminalsByWorkspace[session.workspaceId] ?? []).filter((t) => t.status === 'running')
        .length;
    }
    return Object.values(terminalsByWorkspace)
      .flat()
      .filter((t) => t.status === 'running').length;
  }, [terminalsByWorkspace, session]);

  return (
    <TerminalStatusbarBadgeView
      runningCount={runningCount}
      onClick={() => openPluginPanel(terminalTabKey)}
    />
  );
}
