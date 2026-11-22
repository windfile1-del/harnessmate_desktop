import type {
  ApprovalRequest,
  Attachment,
  PermissionMode,
  ReasoningEffort,
  Session,
  WorkspaceFileEntry,
} from '@harnessmate/protocol';
import {
  AlertTriangle,
  ArrowRightLeft,
  ArrowUp,
  AtSign,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FileCode2,
  FileText,
  FolderGit2,
  GitBranch,
  Globe,
  ImagePlus,
  ListChecks,
  Loader2,
  PanelLeft,
  PanelRight,
  Paperclip,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Slash,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { daemonApi, resolveAttachmentUrl } from '../api/client';
import {
  formatTokenCount,
  HARNESS_META,
  PERMISSION_MODE_LABELS,
} from '../lib/harness-meta';
import {
  projectSessionEvents,
  type ProjectedSwitchEvent,
  type ProjectedToolCall,
  type ProjectedTurn,
} from '../lib/projector';
import { useAppStore } from '../stores/app-store';
import { HarnessBadge, StarLoomCrest } from './BrandMark';
import { HarnessSwitcher } from './HarnessSwitcher';
import { InspectorDrawer } from './InspectorDrawer';
import { MarkdownView } from './MarkdownView';
import { ModelPicker } from './ModelPicker';

const DRIVER_LABELS: Record<string, string> = {
  codex_inject_items: 'Codex 原生历史注入 (thread/inject_items)',
  acp_embedded_context: 'AGY ACP 原生资源块 (embeddedContext)',
  claude_sysfile_delta: 'Claude 系统约束 + 增量同步通道',
  prompt_envelope: '结构化上下文信封',
  native_warm: '原生热记忆（零重传）',
};

export function ChatStage() {
  const {
    sessions,
    harnesses,
    workspaces,
    slashCommands,
    selectedSessionId,
    eventsBySession,
    taskStateBySession,
    contextPreviewBySession,
    draftTextBySession,
    draftAttachmentsBySession,
    sidebarCollapsed,
    inspectorOpen,
    setSidebarCollapsed,
    setInspectorOpen,
    setInspectorTab,
    openModal,
    selectSession,
    sendTurn,
    switchHarness,
    failoverSession,
    interruptSession,
    updateSession,
    resolveApproval,
    setDraftText,
    addDraftAttachment,
    removeDraftAttachment,
    clearDraft,
    pushToast,
    isPluginEnabled,
  } = useAppStore();

  const session = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const harness = useMemo(
    () => (session ? harnesses.find((h) => h.id === session.harnessId) ?? null : null),
    [harnesses, session],
  );

  // Background sessions awaiting approval (Global Attention Strip)
  const otherAwaitingSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          s.id !== selectedSessionId &&
          (s.status === 'awaiting_approval' || s.pendingApprovalCount > 0),
      ),
    [sessions, selectedSessionId],
  );

  const events = session ? eventsBySession[session.id] ?? [] : [];
  const taskState = session ? taskStateBySession[session.id] ?? null : null;
  const contextPreview = session ? contextPreviewBySession[session.id] ?? null : null;
  const timeline = useMemo(
    () =>
      projectSessionEvents(
        events,
        session ? { id: session.harnessId, kind: session.harnessKind } : undefined,
      ),
    [events, session],
  );
  const readyAlternativeHarnesses = useMemo(
    () => harnesses.filter((h) => h.id !== session?.harnessId && h.health === 'ready'),
    [harnesses, session?.harnessId],
  );
  const autoFailoverEnabled = isPluginEnabled('core.auto-failover');
  const contextBridgeEnabled = isPluginEnabled('core.context-bridge');
  const taskLedgerEnabled = isPluginEnabled('core.task-ledger');

  const inputText = session ? draftTextBySession[session.id] ?? '' : '';
  const attachments = session ? draftAttachmentsBySession[session.id] ?? [] : [];

  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [draggingOver, setDraggingOver] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);

  // @file mention popover
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerItems, setFilePickerItems] = useState<WorkspaceFileEntry[]>([]);

  const scrollEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length, selectedSessionId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [inputText, selectedSessionId]);

  // Trigger workspace file search when @file picker is open
  useEffect(() => {
    if (!filePickerOpen || !session) return;
    const timer = window.setTimeout(() => {
      void daemonApi
        .searchSessionFiles(session.id, filePickerQuery)
        .then((res) => setFilePickerItems(res.files.slice(0, 14)))
        .catch(() => {});
    }, 100);
    return () => window.clearTimeout(timer);
  }, [filePickerOpen, filePickerQuery, session]);

  // Slash command autocomplete when input starts with "/"
  const slashMatches = useMemo(() => {
    const trimmed = inputText.trimStart();
    if (!trimmed.startsWith('/') || trimmed.includes('\n')) return [];
    const firstToken = trimmed.slice(1).split(/\s/)[0]?.toLowerCase() ?? '';
    if (trimmed.includes(' ')) return [];
    return slashCommands.filter((c) => c.command.toLowerCase().includes(firstToken));
  }, [inputText, slashCommands]);

  if (!session) {
    return (
      <AtelierWelcome
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        harnesses={harnesses}
        hasWorkspaces={workspaces.length > 0}
        onStartHarness={(harnessId) => openModal('new_session', harnessId)}
        onAddWorkspace={() => openModal('add_workspace')}
        onOpenPlugins={() => openModal('plugins')}
        onOpenUsage={() => openModal('usage')}
        onOpenPairing={() => openModal('remote_pairing')}
      />
    );
  }

  const isRunning = session.status === 'running' || session.status === 'awaiting_approval';
  const attachmentsEnabled = isPluginEnabled('core.attachments');

  const selectedModelMeta = harness?.models.find((m) => m.id === session.model) ?? null;
  const availableEfforts: ReasoningEffort[] =
    selectedModelMeta?.supportedEfforts && selectedModelMeta.supportedEfforts.length > 0
      ? selectedModelMeta.supportedEfforts
      : harness?.capabilities.reasoningEfforts ?? [];

  const handleUploadFiles = async (fileList: FileList | File[]) => {
    const filesArr = Array.from(fileList);
    if (filesArr.length === 0) return;
    setUploading(true);
    try {
      for (const file of filesArr) {
        const isImage = file.type.startsWith('image/');
        const base64 = await readFileAsBase64(file);
        const { attachment } = await daemonApi.uploadAttachment(session.id, {
          name: file.name || (isImage ? `screenshot-${Date.now()}.png` : `file-${Date.now()}`),
          kind: isImage ? 'image' : 'file_ref',
          mimeType: file.type || (isImage ? 'image/png' : 'application/octet-stream'),
          dataBase64: base64,
        });
        addDraftAttachment(session.id, attachment);
      }
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '添加附件失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled) return;
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void handleUploadFiles(files);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingOver(false);
    if (!attachmentsEnabled) return;
    if (e.dataTransfer.files?.length > 0) {
      void handleUploadFiles(e.dataTransfer.files);
    }
  };

  const handleInputChange = (val: string) => {
    setDraftText(session.id, val);
    // Open @file picker when user types "@" followed by non-space token at end
    const atMatch = val.match(/(?:^|\s)@([^\s@]*)$/);
    if (atMatch) {
      setFilePickerOpen(true);
      setFilePickerQuery(atMatch[1] ?? '');
    } else if (filePickerOpen) {
      setFilePickerOpen(false);
    }
  };

  const handleSelectMentionFile = (entry: WorkspaceFileEntry) => {
    const cleaned = inputText.replace(/(?:^|\s)@([^\s@]*)$/, (m) => (m.startsWith(' ') ? ' ' : ''));
    setDraftText(session.id, cleaned);
    setFilePickerOpen(false);
    addDraftAttachment(session.id, {
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      kind: 'file_ref',
      name: entry.name,
      path: entry.fullPath,
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
    });
    textareaRef.current?.focus();
  };

  const handleSend = async () => {
    const trimmed = inputText.trim();
    if ((!trimmed && attachments.length === 0) || sending || isRunning) return;
    setSending(true);
    const outgoingText = trimmed || '请结合附带的图片/文件进行分析。';
    const outgoingAtts = [...attachments];
    clearDraft(session.id);
    setFilePickerOpen(false);
    try {
      await sendTurn(session.id, outgoingText, outgoingAtts.length > 0 ? outgoingAtts : undefined);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleExport = async () => {
    try {
      const { filename, markdown } = await daemonApi.exportSessionMarkdown(session.id);
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      pushToast({ kind: 'success', title: `已导出 ${filename}` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '导出失败',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleTitleSave = async () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== session.title) {
      await updateSession(session.id, { title: trimmed });
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 overflow-hidden">
      <div className="atelier-canvas flex h-full min-w-0 flex-1 flex-col">
        {/* Minimalist Session Top Bar */}
        <header
          className="app-drag flex h-[54px] shrink-0 items-center justify-between gap-2 px-4"
          style={{
            borderBottom: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--bg-glass)',
            backdropFilter: 'blur(14px)',
          }}
        >
          <div className="app-no-drag flex min-w-0 items-center gap-2">
            {sidebarCollapsed && (
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                title="展开侧边栏"
                className="cursor-pointer rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                <PanelLeft size={16} />
              </button>
            )}

            <HarnessSwitcher
              session={session}
              harnesses={harnesses}
              disabled={isRunning}
              placement="bottom"
              onSwitch={(targetId) => void switchHarness(session.id, { targetHarnessId: targetId })}
            />

            {editingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void handleTitleSave()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleTitleSave();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                autoFocus
                className="w-[220px] rounded-md px-2 py-0.5 text-[13.5px] font-medium text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-focus)',
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(session.title);
                  setEditingTitle(true);
                }}
                title="点击重命名会话"
                className="cursor-pointer truncate text-[13.5px] font-medium tracking-tight text-[var(--text-primary)] hover:underline"
              >
                {session.title}
              </button>
            )}

            {/* Verified Active Model Badge (prevents silent model mismatch!) */}
            {session.actualModel && (
              <span
                title={
                  session.modelReroutedReason
                    ? `模型发生重路由: ${session.modelReroutedReason}`
                    : `CLI 后台已确认实际运行模型: ${session.actualModel}`
                }
                className="hidden items-center gap-1 rounded-full px-2 py-0.5 font-mono-code text-[10.5px] lg:inline-flex"
                style={{
                  backgroundColor: session.modelReroutedReason
                    ? 'var(--accent-star-soft)'
                    : 'var(--accent-emerald-soft)',
                  color: session.modelReroutedReason
                    ? 'var(--accent-star)'
                    : 'var(--accent-emerald)',
                  border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                }}
              >
                {session.modelReroutedReason ? (
                  <AlertTriangle size={10.5} />
                ) : (
                  <CheckCircle2 size={10.5} />
                )}
                <span className="max-w-[160px] truncate">{session.actualModel}</span>
              </span>
            )}

            {session.worktreeBranch && (
              <span
                className="hidden items-center gap-1 rounded-md px-2 py-0.5 font-mono-code text-[10.5px] xl:inline-flex"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                  color: 'var(--text-secondary)',
                }}
              >
                <GitBranch size={11} />
                {session.worktreeBranch}
              </span>
            )}
          </div>

          <div className="app-no-drag flex shrink-0 items-center gap-1.5">
            {session.usage && (
              <div
                className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 font-mono-code text-[10.5px] text-[var(--text-muted)] xl:flex"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <span>↑{formatTokenCount(session.usage.inputTokens)}</span>
                <span>↓{formatTokenCount(session.usage.outputTokens)}</span>
                {session.usage.costUsd !== undefined && session.usage.costUsd > 0 && (
                  <span className="text-[var(--accent-star)]">
                    ${session.usage.costUsd.toFixed(3)}
                  </span>
                )}
              </div>
            )}

            {taskLedgerEnabled && (
              <button
                type="button"
                onClick={() => {
                  setInspectorTab('task');
                  setInspectorOpen(true);
                }}
                title="查看与编辑任务状态账本（已同步至 .harnessmate/task-ledger.md）"
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                style={{ border: '1px solid var(--border-hairline)' }}
              >
                <ListChecks size={13} className="text-[var(--accent-indigo)]" />
                <span className="hidden lg:inline">任务账本</span>
                {taskState && taskState.steps.length > 0 && (
                  <span className="font-mono-code text-[10px] text-[var(--accent-emerald)]">
                    {taskState.steps.filter((s) => s.status === 'done').length}/{taskState.steps.length}
                  </span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => openModal('handoff')}
              title="切换执行引擎或分支为独立新会话"
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <ArrowRightLeft size={13} />
              <span className="hidden md:inline">交接</span>
            </button>

            <button
              type="button"
              onClick={() => void handleExport()}
              title="导出会话为 Markdown"
              className="inline-flex cursor-pointer items-center rounded-lg p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <Download size={13.5} />
            </button>

            <button
              type="button"
              onClick={() => setInspectorOpen(!inspectorOpen)}
              title="切换右侧检视抽屉（变更/文件/终端/日志）"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                backgroundColor: inspectorOpen ? 'var(--bg-active)' : 'transparent',
                color: inspectorOpen ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                border: `1px solid ${inspectorOpen ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
              }}
            >
              <PanelRight size={14} />
              <span className="hidden sm:inline">检视</span>
            </button>
          </div>
        </header>

        {/* Global Background Session Approval Jump Bar */}
        {otherAwaitingSessions.length > 0 && (
          <div
            className="flex shrink-0 items-center justify-between gap-2 px-4 py-1.5 text-[11.5px]"
            style={{
              backgroundColor: 'var(--accent-star-soft)',
              borderBottom: '1px solid color-mix(in srgb, var(--accent-star) 35%, transparent)',
              color: 'var(--accent-star)',
            }}
          >
            <span className="inline-flex items-center gap-1.5 truncate">
              <ShieldAlert size={13} />
              其他后台会话正在等待权限确认：{otherAwaitingSessions.map((s) => s.title).join('、')}
            </span>
            <button
              type="button"
              onClick={() => void selectSession(otherAwaitingSessions[0]!.id)}
              className="shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-medium underline"
            >
              立即前往
            </button>
          </div>
        )}

        {/* Pinned Pending Approvals Alert Bar */}
        {timeline.pendingApprovals.length > 0 && (
          <div className="shrink-0 px-4 pt-3">
            <div className="mx-auto max-w-[760px] space-y-2">
              {timeline.pendingApprovals.map((appr) => (
                <ApprovalCard
                  key={appr.id}
                  approval={appr}
                  pinned
                  onResolve={(decision) => void resolveApproval(appr.id, decision)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Main Conversation Stream */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-6">
          <div className="mx-auto max-w-[760px] space-y-7">
            {timeline.items.length === 0 ? (
              <SessionReadyPlaceholder
                session={session}
                onQuickPrompt={(t) => setDraftText(session.id, t)}
              />
            ) : (
              timeline.items.map((item) =>
                item.kind === 'switch' ? (
                  <HarnessSwitchDivider
                    key={`sw_${item.seq}`}
                    event={item}
                    onInspect={() => openModal('context_preview')}
                  />
                ) : (
                  <TurnBlock
                    key={item.turnId}
                    turn={item}
                    fallbackHarnessKind={session.harnessKind}
                    fallbackHarnessId={session.harnessId}
                    alternativeHarnesses={
                      autoFailoverEnabled && !isRunning ? readyAlternativeHarnesses : []
                    }
                    onFailover={(targetHarnessId) =>
                      void failoverSession(session.id, {
                        targetHarnessId,
                        retryLastFailedTurn: true,
                      })
                    }
                    onPreviewImage={(src) => setLightboxImg(src)}
                    onResolveApproval={(id, dec) => void resolveApproval(id, dec)}
                  />
                ),
              )
            )}
            <div ref={scrollEndRef} className="h-4" />
          </div>
        </div>

        {/* Floating Glass Composer Dock (Drag-Drop + Paste Image + @file + /slash + ModelPicker) */}
        <div className="shrink-0 px-4 pb-4 pt-1">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (attachmentsEnabled) setDraggingOver(true);
            }}
            onDragLeave={() => setDraggingOver(false)}
            onDrop={handleDrop}
            className="relative mx-auto max-w-[760px] rounded-2xl p-2.5 transition-all"
            style={{
              backgroundColor: 'var(--bg-glass)',
              backdropFilter: 'blur(18px)',
              border: `1px solid ${draggingOver ? 'var(--accent-indigo)' : 'var(--border-strong)'}`,
              boxShadow: draggingOver
                ? '0 0 0 3px var(--accent-indigo-soft), var(--shadow-float)'
                : 'var(--shadow-float)',
            }}
          >
            {/* Floating Slash Command Autocomplete */}
            {slashMatches.length > 0 && (
              <div
                className="animate-fade-up absolute right-0 bottom-full left-0 z-40 mb-2 overflow-hidden rounded-2xl p-1.5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'var(--shadow-float)',
                }}
              >
                <div className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  插件 Slash 工作流指令
                </div>
                <div className="max-h-[210px] overflow-y-auto">
                  {slashMatches.map((cmd) => (
                    <button
                      key={`${cmd.pluginId}-${cmd.command}`}
                      type="button"
                      onClick={() => {
                        setDraftText(session.id, `/${cmd.command} `);
                        textareaRef.current?.focus();
                      }}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono-code text-[12.5px] font-semibold text-[var(--accent-indigo)]">
                            /{cmd.command}
                          </span>
                          {cmd.argumentHint && (
                            <span className="font-mono-code text-[11px] text-[var(--text-muted)]">
                              {cmd.argumentHint}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-[11.5px] text-[var(--text-secondary)]">
                          {cmd.description}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]" style={{ backgroundColor: 'var(--bg-elevated)' }}>
                        {cmd.pluginName}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Floating @file Workspace Mention Popover */}
            {filePickerOpen && (
              <div
                className="animate-fade-up absolute right-0 bottom-full left-0 z-40 mb-2 overflow-hidden rounded-2xl p-1.5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'var(--shadow-float)',
                }}
              >
                <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <span>引用工作区文件 (@{filePickerQuery})</span>
                  <button
                    type="button"
                    onClick={() => setFilePickerOpen(false)}
                    className="cursor-pointer hover:text-[var(--text-primary)]"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="max-h-[210px] overflow-y-auto">
                  {filePickerItems.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[11.5px] text-[var(--text-muted)]">
                      无匹配文件
                    </div>
                  ) : (
                    filePickerItems.map((f) => (
                      <button
                        key={f.relativePath}
                        type="button"
                        onClick={() => handleSelectMentionFile(f)}
                        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <FileCode2 size={13} className="shrink-0 text-[var(--accent-indigo)]" />
                          <span className="font-mono-code truncate text-[12px] text-[var(--text-primary)]">
                            {f.relativePath}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono-code text-[10.5px] text-[var(--text-muted)]">
                          {(f.sizeBytes / 1024).toFixed(1)}KB
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Context Bridge Sync Status Strip (shown when active harness has un-synced delta turns) */}
            {contextBridgeEnabled && contextPreview && contextPreview.syncNeeded && (
              <div
                className="mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-[11px]"
                style={{
                  backgroundColor: 'var(--accent-indigo-soft)',
                  border: '1px solid color-mix(in srgb, var(--accent-indigo) 32%, transparent)',
                  color: 'var(--text-primary)',
                }}
              >
                <div className="flex min-w-0 items-center gap-1.5 truncate">
                  <Sparkles size={12} className="shrink-0 text-[var(--accent-indigo)]" />
                  <span className="truncate">
                    下条消息将通过{' '}
                    <strong className="font-medium text-[var(--accent-indigo)]">
                      {DRIVER_LABELS[contextPreview.driverPlanned] ?? contextPreview.driverPlanned}
                    </strong>{' '}
                    同步{' '}
                    {contextPreview.unsyncedTurnCount > 0
                      ? `${contextPreview.unsyncedTurnCount} 轮增量对话 + 任务账本`
                      : '任务账本'}{' '}
                    <span className="font-mono-code opacity-80">
                      (~{formatTokenCount(contextPreview.estimatedTokens)} tok)
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => openModal('context_preview')}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-indigo)] transition-colors hover:bg-[var(--bg-surface)]"
                >
                  <Eye size={11} />
                  预览上下文
                </button>
              </div>
            )}

            {/* Attachment Preview Strip */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 px-2 pt-1">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="group relative flex items-center gap-2 rounded-xl px-2 py-1.5 text-[11.5px]"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    {att.kind === 'image' && att.previewUrl ? (
                      <img
                        src={resolveAttachmentUrl(att.previewUrl)}
                        alt={att.name}
                        className="h-9 w-9 cursor-pointer rounded-lg object-cover"
                        onClick={() => setLightboxImg(resolveAttachmentUrl(att.previewUrl) ?? null)}
                      />
                    ) : (
                      <FileText size={14} className="shrink-0 text-[var(--accent-indigo)]" />
                    )}
                    <span className="max-w-[160px] truncate font-mono-code text-[11px] text-[var(--text-primary)]">
                      {att.relativePath || att.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeDraftAttachment(session.id, att.id)}
                      className="cursor-pointer rounded-full p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-rose)]"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.py,.kt,.java,.go,.rs,.yaml,.yml,.toml,.css,.html,.sql,.log,.csv"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleUploadFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                } else if (e.key === 'Escape') {
                  setFilePickerOpen(false);
                }
              }}
              placeholder={
                draggingOver
                  ? '松开鼠标即可附带图片或文件...'
                  : isRunning
                    ? 'Agent 正在执行本轮任务，可随时点击右侧停止...'
                    : `向 ${harness?.displayName ?? session.harnessId} 发送指令 · 输入 / 调用插件指令 · @ 引用文件 · Ctrl+V 贴图`
              }
              className="max-h-[180px] w-full resize-none bg-transparent px-2.5 py-1.5 text-[13.8px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />

            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1 pt-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {attachmentsEnabled && (
                  <>
                    <button
                      type="button"
                      disabled={uploading || isRunning}
                      onClick={() => fileInputRef.current?.click()}
                      title="上传图片或文件（也支持拖拽与 Ctrl+V 粘贴截图）"
                      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      {uploading ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <ImagePlus size={12.5} />
                      )}
                      <span className="hidden sm:inline">附件</span>
                    </button>

                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => {
                        setFilePickerOpen(!filePickerOpen);
                        setFilePickerQuery('');
                      }}
                      title="引用工作区文件 (@file)"
                      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                      style={{
                        backgroundColor: filePickerOpen ? 'var(--bg-active)' : 'var(--bg-elevated)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      <AtSign size={12.5} />
                    </button>
                  </>
                )}

                {slashCommands.length > 0 && (
                  <button
                    type="button"
                    disabled={isRunning}
                    onClick={() => {
                      setDraftText(session.id, '/');
                      textareaRef.current?.focus();
                    }}
                    title="插件斜杠指令 (/)"
                    className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <Slash size={12} />
                  </button>
                )}

                {/* Inline Unified Harness Switcher */}
                <HarnessSwitcher
                  session={session}
                  harnesses={harnesses}
                  disabled={isRunning}
                  placement="top"
                  onSwitch={(targetId) => void switchHarness(session.id, { targetHarnessId: targetId })}
                />

                {/* Searchable Grouped Real Model Picker */}
                {harness && harness.models.length > 0 && (
                  <ModelPicker
                    models={harness.models}
                    value={session.model}
                    defaultModelId={harness.defaultModelId}
                    disabled={isRunning}
                    placement="top"
                    onChange={(nextModel) => {
                      const nextMeta = harness.models.find((m) => m.id === nextModel);
                      const effortStillValid =
                        !session.reasoningEffort ||
                        !nextMeta?.supportedEfforts ||
                        nextMeta.supportedEfforts.includes(session.reasoningEffort);
                      void updateSession(session.id, {
                        model: nextModel,
                        ...(effortStillValid ? {} : { reasoningEffort: nextMeta?.defaultEffort ?? null }),
                      });
                    }}
                  />
                )}

                {/* Per-Model Dynamic Reasoning Effort Selector */}
                {availableEfforts.length > 0 && (
                  <select
                    value={session.reasoningEffort ?? ''}
                    disabled={isRunning}
                    onChange={(e) =>
                      void updateSession(session.id, {
                        reasoningEffort: (e.target.value || null) as ReasoningEffort | null,
                      })
                    }
                    className="cursor-pointer rounded-lg px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus:outline-none disabled:opacity-50"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <option value="">推理: 默认</option>
                    {availableEfforts.map((eff) => (
                      <option key={eff} value={eff}>
                        推理: {eff}
                      </option>
                    ))}
                  </select>
                )}

                {/* Permission Mode Selector */}
                <select
                  value={session.permissionMode}
                  disabled={isRunning}
                  onChange={(e) =>
                    void updateSession(session.id, {
                      permissionMode: e.target.value as PermissionMode,
                    })
                  }
                  className="cursor-pointer rounded-lg px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus:outline-none disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  {(harness?.capabilities.permissionModes ?? ['plan', 'accept_edits', 'auto']).map(
                    (mode) => (
                      <option key={mode} value={mode}>
                        模式: {PERMISSION_MODE_LABELS[mode]?.label ?? mode}
                      </option>
                    ),
                  )}
                </select>
              </div>

              <div className="flex items-center gap-2">
                {isRunning ? (
                  <button
                    type="button"
                    onClick={() => void interruptSession(session.id)}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[12px] font-medium text-white transition-all hover:opacity-90"
                    style={{ backgroundColor: 'var(--accent-rose)' }}
                  >
                    <Square size={11} fill="currentColor" />
                    <span>停止</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={(!inputText.trim() && attachments.length === 0) || sending}
                    onClick={() => void handleSend()}
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl text-white transition-all disabled:cursor-not-allowed disabled:opacity-35"
                    style={{ backgroundColor: 'var(--accent-indigo)' }}
                  >
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {inspectorOpen && <InspectorDrawer session={session} diagnostics={timeline.diagnostics} />}

      {/* Image Lightbox */}
      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ backgroundColor: 'rgba(4, 6, 12, 0.85)', backdropFilter: 'blur(8px)' }}
          onClick={() => setLightboxImg(null)}
        >
          <img
            src={lightboxImg}
            alt="Preview"
            className="max-h-[88vh] max-w-[90vw] rounded-2xl object-contain"
            style={{ boxShadow: 'var(--shadow-float)' }}
          />
        </div>
      )}
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function HarnessSwitchDivider({
  event,
  onInspect,
}: {
  event: ProjectedSwitchEvent;
  onInspect: () => void;
}) {
  const fromMeta = HARNESS_META[event.fromHarnessKind] ?? HARNESS_META.acp;
  const toMeta = HARNESS_META[event.toHarnessKind] ?? HARNESS_META.acp;

  return (
    <div className="animate-fade-up flex items-center gap-3 py-1">
      <div className="h-px flex-1" style={{ backgroundColor: 'var(--border-hairline)' }} />
      <button
        type="button"
        onClick={onInspect}
        title="点击预览当前会话上下文同步详情"
        className="inline-flex max-w-full cursor-pointer flex-wrap items-center justify-center gap-1.5 rounded-full px-3 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <Sparkles size={11} className="shrink-0 text-[var(--accent-star)]" />
        <span style={{ color: fromMeta.accentColor }} className="font-medium">
          {fromMeta.shortLabel}
        </span>
        <span className="opacity-50">→</span>
        <span style={{ color: toMeta.accentColor }} className="font-medium">
          {toMeta.shortLabel}
        </span>
        {event.toModel && (
          <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
            ({event.toModel})
          </span>
        )}
        <span className="opacity-40">·</span>
        <span className="text-[10.5px] text-[var(--text-muted)]">
          {event.isWarmBinding ? '增量同步' : '上下文同步'} {event.unsyncedTurnCount} 轮
          {event.estimatedTokens > 0 ? ` (~${formatTokenCount(event.estimatedTokens)} tok)` : ''}
        </span>
        {event.gitAnchor && (
          <>
            <span className="hidden opacity-40 sm:inline">·</span>
            <span className="hidden font-mono-code text-[10px] text-[var(--text-muted)] sm:inline">
              {event.gitAnchor}
            </span>
          </>
        )}
      </button>
      <div className="h-px flex-1" style={{ backgroundColor: 'var(--border-hairline)' }} />
    </div>
  );
}

function TurnBlock({
  turn,
  fallbackHarnessKind,
  fallbackHarnessId,
  alternativeHarnesses,
  onFailover,
  onPreviewImage,
  onResolveApproval,
}: {
  turn: ProjectedTurn;
  fallbackHarnessKind: Session['harnessKind'];
  fallbackHarnessId: string;
  alternativeHarnesses: Array<{ id: string; kind: Session['harnessKind']; displayName: string }>;
  onFailover: (targetHarnessId: string) => void;
  onPreviewImage: (src: string) => void;
  onResolveApproval: (id: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const effectiveKind = turn.harnessKind ?? fallbackHarnessKind;
  const effectiveId = turn.harnessId ?? fallbackHarnessId;
  const meta = HARNESS_META[effectiveKind] ?? HARNESS_META.acp;
  const turnModelLabel = turn.actualModel || turn.model;

  return (
    <div className="animate-fade-up space-y-4">
      {/* User Prompt + Attachments */}
      {(turn.userText || turn.userAttachments.length > 0) && (
        <div className="flex flex-col items-end gap-2">
          {turn.userAttachments.length > 0 && (
            <div className="flex max-w-[82%] flex-wrap justify-end gap-2">
              {turn.userAttachments.map((att) =>
                att.kind === 'image' && att.previewUrl ? (
                  <img
                    key={att.id}
                    src={resolveAttachmentUrl(att.previewUrl)}
                    alt={att.name}
                    onClick={() => onPreviewImage(resolveAttachmentUrl(att.previewUrl) ?? '')}
                    className="h-24 max-w-[180px] cursor-pointer rounded-xl object-cover transition-transform hover:scale-[1.02]"
                    style={{ border: '1px solid var(--border-strong)' }}
                  />
                ) : (
                  <span
                    key={att.id}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono-code text-[11px] text-[var(--text-secondary)]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <Paperclip size={11} className="text-[var(--accent-indigo)]" />
                    {att.relativePath || att.name}
                  </span>
                ),
              )}
            </div>
          )}

          {turn.userText && (
            <div
              className="max-w-[82%] rounded-2xl rounded-tr-md px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-[var(--text-primary)]"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
              }}
            >
              {turn.expandedCommand && (
                <span
                  className="mr-2 inline-flex items-center rounded-md px-1.5 py-0.5 font-mono-code text-[11px]"
                  style={{
                    backgroundColor: 'var(--accent-indigo-soft)',
                    color: 'var(--accent-indigo)',
                  }}
                >
                  {turn.expandedCommand}
                </span>
              )}
              {turn.userText}
            </div>
          )}
        </div>
      )}

      {/* Assistant Execution & Response Column (Per-Turn Harness & Confirmed Model Attribution) */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.accentColor }} />
          <span className="font-medium text-[var(--text-secondary)]">
            {meta.shortLabel || effectiveId}
          </span>
          {turnModelLabel && (
            <span
              className="rounded-md px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {turnModelLabel}
            </span>
          )}
          {turn.status === 'running' && (
            <span className="inline-flex items-center gap-1 text-[var(--accent-indigo)]">
              <Loader2 size={11.5} className="animate-spin" />
              执行中
            </span>
          )}
          {turn.status === 'cancelled' && (
            <span className="text-[var(--accent-star)]">已中止</span>
          )}
        </div>

        {turn.thinking && (
          <ThinkingAccordion
            text={turn.thinking}
            running={turn.status === 'running' && !turn.thinkingDone}
          />
        )}

        {turn.tools.length > 0 && (
          <div className="space-y-2">
            {turn.tools.map((tool) => (
              <ToolCallCard key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        )}

        {turn.approvals
          .filter((a) => a.status !== 'pending')
          .map((appr) => (
            <ApprovalCard
              key={appr.id}
              approval={appr}
              onResolve={(decision) => onResolveApproval(appr.id, decision)}
            />
          ))}

        {turn.assistantText && (
          <div className="pl-0.5">
            <MarkdownView content={turn.assistantText} />
          </div>
        )}

        {turn.status === 'failed' && turn.errorMessage && (
          <div
            className="space-y-2.5 rounded-xl px-3.5 py-3 text-[13px]"
            style={{
              backgroundColor: 'var(--accent-rose-soft)',
              border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
              color: 'var(--accent-rose)',
            }}
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <div className="min-w-0 break-words">{turn.errorMessage}</div>
            </div>

            {alternativeHarnesses.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-1.5 pt-2"
                style={{ borderTop: '1px solid color-mix(in srgb, var(--accent-rose) 22%, transparent)' }}
              >
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
                  <RefreshCw size={11} />
                  带着完整上下文一键换引擎续跑：
                </span>
                {alternativeHarnesses.slice(0, 3).map((alt) => {
                  const altMeta = HARNESS_META[alt.kind] ?? HARNESS_META.acp;
                  return (
                    <button
                      key={alt.id}
                      type="button"
                      onClick={() => onFailover(alt.id)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        border: '1px solid var(--border-strong)',
                      }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: altMeta.accentColor }}
                      />
                      <span>切换 {altMeta.shortLabel} 续跑</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingAccordion({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="overflow-hidden rounded-xl"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
      >
        <span className="inline-flex items-center gap-2">
          <Brain size={13.5} className="text-[var(--accent-indigo)]" />
          <span>{running ? '深度思考中...' : '查看思考轨迹'}</span>
        </span>
        {open ? <ChevronDown size={13.5} /> : <ChevronRight size={13.5} />}
      </button>
      {open && (
        <div
          className="max-h-[260px] overflow-y-auto px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ tool }: { tool: ProjectedToolCall }) {
  const [expanded, setExpanded] = useState(tool.status === 'error');

  const Icon =
    tool.toolKind === 'shell'
      ? Terminal
      : tool.toolKind === 'file_edit' || tool.toolKind === 'file_read'
        ? FileCode2
        : tool.toolKind === 'search'
          ? Search
          : tool.toolKind === 'web'
            ? Globe
            : Wrench;

  const hasDetails = Boolean(tool.output || tool.diff || tool.input);

  return (
    <div
      className="overflow-hidden rounded-xl transition-all"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center justify-between gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-default"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon size={13.5} className="shrink-0 text-[var(--text-secondary)]" />
          <span className="font-mono-code truncate text-[12px] text-[var(--text-primary)]">
            {tool.summary}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {tool.status === 'running' && (
            <Loader2 size={13} className="animate-spin text-[var(--accent-indigo)]" />
          )}
          {tool.status === 'success' && (
            <CheckCircle2 size={13} className="text-[var(--accent-emerald)]" />
          )}
          {tool.status === 'error' && <XCircle size={13} className="text-[var(--accent-rose)]" />}
          {hasDetails && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        </div>
      </button>

      {expanded && hasDetails && (
        <div
          className="space-y-2 p-3 font-mono-code text-[11.5px]"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            backgroundColor: 'var(--code-bg)',
          }}
        >
          {tool.diff && (
            <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap text-[var(--accent-emerald)]">
              {tool.diff}
            </pre>
          )}
          {tool.output && (
            <pre className="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap text-[var(--text-secondary)]">
              {tool.output}
            </pre>
          )}
          {!tool.output && !tool.diff && tool.input != null && (
            <pre className="m-0 max-h-[180px] overflow-auto whitespace-pre-wrap text-[var(--text-muted)]">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  pinned = false,
  onResolve,
}: {
  approval: ApprovalRequest;
  pinned?: boolean;
  onResolve: (decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const isPending = approval.status === 'pending';

  return (
    <div
      className="animate-fade-up overflow-hidden rounded-2xl p-3.5"
      style={{
        backgroundColor: isPending ? 'var(--bg-glass)' : 'var(--bg-surface)',
        backdropFilter: pinned ? 'blur(16px)' : undefined,
        border: `1px solid ${
          isPending
            ? 'color-mix(in srgb, var(--accent-star) 55%, transparent)'
            : 'var(--border-hairline)'
        }`,
        boxShadow: pinned ? 'var(--shadow-float)' : 'none',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {isPending ? (
            <ShieldAlert size={17} className="mt-0.5 shrink-0 text-[var(--accent-star)]" />
          ) : (
            <ShieldCheck
              size={16}
              className="mt-0.5 shrink-0"
              style={{
                color:
                  approval.status === 'approved' ? 'var(--accent-emerald)' : 'var(--accent-rose)',
              }}
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {isPending ? '需要权限确认' : approval.status === 'approved' ? '已批准操作' : '已拒绝操作'}
              </span>
              <span
                className="rounded-md px-1.5 py-0.5 font-mono-code text-[10.5px]"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                }}
              >
                {approval.toolName}
              </span>
              {approval.resolvedBy && (
                <span className="text-[11px] text-[var(--text-muted)]">
                  · 由{approval.resolvedBy === 'mobile' ? '手机端' : '桌面端'}裁决
                </span>
              )}
            </div>
            <p className="mt-1 font-mono-code text-[12px] break-all text-[var(--text-secondary)]">
              {approval.summary}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          {showRaw ? '收起参数' : '查看详情'}
        </button>
      </div>

      {showRaw && (
        <pre
          className="mt-2.5 max-h-[180px] overflow-auto rounded-xl p-2.5 font-mono-code text-[11px] text-[var(--text-secondary)]"
          style={{
            backgroundColor: 'var(--code-bg)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          {approval.diffPreview || JSON.stringify(approval.input, null, 2)}
        </pre>
      )}

      {isPending && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve('deny')}
            className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--accent-rose-soft)]"
            style={{
              color: 'var(--accent-rose)',
              border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
            }}
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => onResolve('allow_session')}
            className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
            }}
          >
            本会话信任
          </button>
          <button
            type="button"
            onClick={() => onResolve('allow_once')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12px] font-medium text-white transition-all hover:opacity-90"
            style={{ backgroundColor: 'var(--accent-emerald)' }}
          >
            <Check size={13} />
            <span>允许本次</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SessionReadyPlaceholder({
  session,
  onQuickPrompt,
}: {
  session: Session;
  onQuickPrompt: (prompt: string) => void;
}) {
  const suggestions = [
    '/review 检查当前工作区最近的代码改动',
    '/explain 分析当前工作区的核心架构与入口模块',
    '/test 运行自动化测试并定位潜在问题',
  ];

  return (
    <div className="py-10 text-center">
      <div className="mx-auto mb-3.5 inline-flex">
        <StarLoomCrest size={42} />
      </div>
      <h2 className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
        {session.title}
      </h2>
      <p className="mx-auto mt-1.5 max-w-[540px] break-all font-mono-code text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        {session.cwd}
      </p>

      <div
        className="mx-auto mt-6 grid max-w-[620px] gap-2.5"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))' }}
      >
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onQuickPrompt(s)}
            className="cursor-pointer rounded-xl p-3.5 text-left text-[12.4px] leading-relaxed text-[var(--text-secondary)] transition-all hover:-translate-y-0.5 hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
              boxShadow: 'var(--shadow-card)',
            }}
          >
            <Sparkles size={13} className="mb-2 text-[var(--accent-star)]" />
            <div>{s}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function AtelierWelcome({
  sidebarCollapsed,
  onExpandSidebar,
  harnesses,
  hasWorkspaces,
  onStartHarness,
  onAddWorkspace,
  onOpenPlugins,
  onOpenUsage,
  onOpenPairing,
}: {
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  harnesses: import('@harnessmate/protocol').HarnessInfo[];
  hasWorkspaces: boolean;
  onStartHarness: (harnessId: string) => void;
  onAddWorkspace: () => void;
  onOpenPlugins: () => void;
  onOpenUsage: () => void;
  onOpenPairing: () => void;
}) {
  return (
    <div className="atelier-canvas relative flex h-full flex-1 flex-col overflow-y-auto">
      {sidebarCollapsed && (
        <div className="p-4">
          <button
            type="button"
            onClick={onExpandSidebar}
            className="cursor-pointer rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <PanelLeft size={16} />
          </button>
        </div>
      )}

      <div className="m-auto w-full max-w-[780px] px-6 py-12">
        <div className="text-center">
          <div className="mx-auto mb-5 inline-flex">
            <StarLoomCrest size={52} />
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-[var(--text-primary)]">
            模块化微内核，编织全部 Agent Harness
          </h1>
          <p className="mx-auto mt-2.5 max-w-[540px] text-[13.8px] leading-relaxed text-[var(--text-secondary)]">
            实时同步本机 Codex、Antigravity、Claude Code 与任意 ACP CLI 的真实模型、账号限额与 MCP；
            所有能力均以插件方式按需装卸，并原生联动移动端 HarnessMate。
          </p>
        </div>

        {/* Live Probed Harness Launch Cards */}
        <div className="mt-9 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
          {harnesses.slice(0, 6).map((h) => {
            const meta = HARNESS_META[h.kind] ?? HARNESS_META.acp;
            const ready = h.health === 'ready';
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => onStartHarness(h.id)}
                className="group flex cursor-pointer flex-col justify-between rounded-2xl p-4 text-left transition-all hover:-translate-y-0.5"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <HarnessBadge kind={h.kind} label={h.displayName} />
                    <span
                      className="font-mono-code text-[11px] font-medium"
                      style={{
                        color: ready ? 'var(--accent-emerald)' : 'var(--text-muted)',
                      }}
                    >
                      {ready ? `v${h.version ?? 'ok'}` : '未检测到'}
                    </span>
                  </div>
                  <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                    {h.accountSummary || h.protocolLabel}
                  </p>
                </div>

                <div
                  className="mt-4 flex items-center justify-between pt-3 text-[11.5px]"
                  style={{ borderTop: '1px solid var(--border-hairline)' }}
                >
                  <span className="text-[var(--text-muted)]">
                    {h.models.length > 0 ? `${h.models.length} 个实时模型` : '默认配置'}
                  </span>
                  <span
                    className="font-medium transition-transform group-hover:translate-x-0.5"
                    style={{ color: meta.accentColor }}
                  >
                    启动会话 →
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Quick Studio Actions */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          {!hasWorkspaces && (
            <button
              type="button"
              onClick={onAddWorkspace}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-4 py-2 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)',
              }}
            >
              <FolderGit2 size={14} className="text-[var(--accent-indigo)]" />
              <span>添加本地工作区</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenPlugins}
            className="cursor-pointer rounded-xl px-3.5 py-2 text-[12.2px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            打开插件中心（按需安装功能）
          </button>
          <button
            type="button"
            onClick={onOpenUsage}
            className="cursor-pointer rounded-xl px-3.5 py-2 text-[12.2px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            查看多账号限额与用量
          </button>
          <button
            type="button"
            onClick={onOpenPairing}
            className="cursor-pointer rounded-xl px-3.5 py-2 text-[12.2px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            手机扫码远程联动
          </button>
        </div>
      </div>
    </div>
  );
}
