import { TaskLedgerSurface } from '../slots/TaskLedgerSurface';
import { useBoundSessionPlugin } from '../slots/BoundSessionSurface';
import { useShallow } from 'zustand/react/shallow';
import type { Session, WorkspaceFileEntry } from '@harnessmate/protocol';
import {
  AlertCircle,
  AtSign,
  BookOpen,
  Circle,
  Clock,
  FileCode2,
  FolderTree,
  GitBranch,
  Info,
  ListChecks,
  Loader2,
  Maximize2,
  Minimize2,
  Pin,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  ScrollText,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Slot, SlotErrorBoundary, useSlotItems, useSlotRegistry } from '../slots';
import {
  daemonApi,
  type FilePreviewViewerDto,
  type ProjectInstructionInfo,
  type RenderedFilePreview,
  type SessionFileViewResponse,
  type TerminalExecResult,
} from '../api/client';
import { formatTokenCount, resolveHarnessMeta } from '../lib/harness-meta';
import type { DiagnosticEntry } from '../lib/projector';
import type { FileLink } from '../lib/file-links';
import { useAppStore } from '../stores/app-store';
import { FilePreviewBody } from './FilePreviewBody';

export function InspectorDrawer({
  session,
  diagnostics,
}: {
  session: Session;
  diagnostics: DiagnosticEntry[];
}) {
  const {
    harnesses,
    inspectorTab,
    inspectorFile,
    openInspectorFile,
    closeInspectorFile,
    setInspectorTab,
    setInspectorOpen,
    selectedGit,
    selectedTaskState,
    selectedPluginPanel,
    openPluginPanel,
    refreshGitStatus,
    refreshTaskState,
    addDraftAttachment,
    pushToast,
    isPluginEnabled,
    plugins,
    pluginPermissionRevision,
    setSessionBinding,
  } = useAppStore(useShallow((state) => ({
    harnesses: state.harnesses,
    inspectorTab: state.inspectorTab,
    inspectorFile: state.inspectorFile,
    openInspectorFile: state.openInspectorFile,
    closeInspectorFile: state.closeInspectorFile,
    setInspectorTab: state.setInspectorTab,
    setInspectorOpen: state.setInspectorOpen,
    selectedGit: state.gitBySession[session.id],
    selectedTaskState: state.taskStateBySession[session.id],
    selectedPluginPanel: state.selectedPluginPanel,
    openPluginPanel: state.openPluginPanel,
    refreshGitStatus: state.refreshGitStatus,
    refreshTaskState: state.refreshTaskState,
    addDraftAttachment: state.addDraftAttachment,
    pushToast: state.pushToast,
    isPluginEnabled: state.isPluginEnabled,
    plugins: state.plugins,
    pluginPermissionRevision: state.pluginPermissionRevision,
    setSessionBinding: state.setSessionBinding,
  })));

  const slotRegistry = useSlotRegistry();
  const [widePluginPanel, setWidePluginPanel] = useState(false);
  const git = selectedGit ?? null;
  const taskState = selectedTaskState ?? null;
  const inspectorSlotItems = useSlotItems('inspector.tabs');
  const selectedSlotItem =
    inspectorSlotItems.find(({ registrationKey }) => registrationKey === selectedPluginPanel) ??
    inspectorSlotItems[0];
  const hasV1PanelSlot = inspectorSlotItems.some(({ sourceKind }) => sourceKind === 'v1-panel');

  const ledgerPlugin = useBoundSessionPlugin('session.ledger.v1', session);

  useEffect(() => {
    if (inspectorTab === 'plugins' && hasV1PanelSlot && !taskState) void refreshTaskState(session.id);
  }, [inspectorTab, session.id, taskState, refreshTaskState, hasV1PanelSlot]);

  // Files tab state
  const [fileQuery, setFileQuery] = useState('');
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [previewFile, setPreviewFile] = useState<{
    target: NonNullable<typeof inspectorFile>;
    relativePath: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const [selectedViewerId, setSelectedViewerId] = useState<string | undefined>(undefined);
  const [fileViewMeta, setFileViewMeta] = useState<Pick<
    SessionFileViewResponse,
    'resolvedInstanceId' | 'boundInstanceId' | 'boundSource' | 'dependencyStatus' | 'dependencyMessage' | 'availableViewers'
  > | null>(null);
  const activePreview = inspectorFile?.sessionId === session.id && previewFile?.target === inspectorFile ? previewFile : null;
  const [renderedPreview, setRenderedPreview] = useState<{
    source: NonNullable<typeof previewFile>;
    plugins: typeof plugins;
    permissionRevision: number;
    viewerId?: string;
    preview: RenderedFilePreview;
  }>();
  const clearRenderedPreview = useCallback(() => setRenderedPreview(undefined), []);
  const pluginPreview = renderedPreview?.source === activePreview
    && renderedPreview.plugins === plugins
    && renderedPreview.permissionRevision === pluginPermissionRevision
    && renderedPreview.viewerId === selectedViewerId
    ? renderedPreview.preview
    : undefined;
  const previewPath = activePreview?.relativePath;
  const openPreviewLink = useCallback(({ path, line }: FileLink) => {
    const directory = previewPath?.slice(0, previewPath.lastIndexOf('/') + 1) ?? '';
    openInspectorFile(session.id, /^(?:\/|[a-z]:\/)/i.test(path) ? path : directory + path, line);
  }, [previewPath, openInspectorFile, session.id]);
  const [filesLoading, setFilesLoading] = useState(false);

  // Terminal tab state
  const [cmdInput, setCmdInput] = useState('');
  const [cmdRunning, setCmdRunning] = useState(false);
  const [cmdHistory, setCmdHistory] = useState<TerminalExecResult[]>([]);

  // Project Rules & Skills state
  const [instructions, setInstructions] = useState<ProjectInstructionInfo[]>([]);

  useEffect(() => {
    if (inspectorTab === 'files') {
      setFilesLoading(true);
      void daemonApi
        .searchSessionFiles(session.id, fileQuery)
        .then((res) => setFiles(res.files))
        .catch(() => {})
        .finally(() => setFilesLoading(false));
    }
  }, [inspectorTab, session.id, fileQuery]);

  useEffect(() => {
    if (inspectorTab === 'info') {
      void daemonApi
        .getSessionRules(session.id)
        .then((res) => setInstructions(res.instructions))
        .catch(() => {});
    }
  }, [inspectorTab, session.id]);

  useEffect(() => {
    setSelectedViewerId(undefined);
  }, [inspectorFile?.sessionId, inspectorFile?.path, inspectorFile?.line]);

  useEffect(() => {
    if (inspectorTab !== 'files' || inspectorFile?.sessionId !== session.id) return;
    const controller = new AbortController();
    if (typeof daemonApi.getSessionFileView === 'function') {
      void daemonApi.getSessionFileView(
        session.id,
        inspectorFile.path,
        inspectorFile.line,
        selectedViewerId,
        controller.signal,
      ).then((res) => {
        if (controller.signal.aborted) return;
        const source = { ...res.file, target: inspectorFile };
        setPreviewFile(source);
        setFileViewMeta({
          resolvedInstanceId: res.resolvedInstanceId,
          boundInstanceId: res.boundInstanceId,
          boundSource: res.boundSource,
          dependencyStatus: res.dependencyStatus,
          dependencyMessage: res.dependencyMessage,
          availableViewers: res.availableViewers,
        });
        setRenderedPreview(res.preview
          ? { source, plugins, permissionRevision: pluginPermissionRevision, viewerId: selectedViewerId, preview: res.preview }
          : undefined);
      }).catch((err: unknown) => {
        if (!controller.signal.aborted) pushToast({
          kind: 'error',
          title: '无法读取文件',
          body: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      void daemonApi.readSessionFile(session.id, inspectorFile.path, controller.signal).then((res) => {
        if (!controller.signal.aborted) {
          setFileViewMeta(null);
          setPreviewFile({ ...res, target: inspectorFile });
        }
      }).catch((err: unknown) => {
        if (!controller.signal.aborted) pushToast({
          kind: 'error',
          title: '无法读取文件',
          body: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return () => controller.abort();
  }, [inspectorFile, inspectorTab, session.id, selectedViewerId, plugins, pluginPermissionRevision, pushToast]);

  useEffect(() => {
    if (typeof daemonApi.getSessionFileView === 'function') return;
    if (inspectorTab !== 'files' || !activePreview ||
      !plugins.some((plugin) => plugin.runtimeState === 'ACTIVE' && plugin.contributes.filePreview)) return;
    const controller = new AbortController();
    const { path, line } = activePreview.target;
    void daemonApi.renderSessionFile(session.id, path, line, controller.signal).then(({ preview }) => {
      if (!controller.signal.aborted) setRenderedPreview(preview
        ? { source: activePreview, plugins, permissionRevision: pluginPermissionRevision, preview }
        : undefined);
    }).catch(() => {});
    return () => controller.abort();
  }, [activePreview, inspectorTab, session.id, plugins, pluginPermissionRevision]);

  const handleAttachFile = (entry: WorkspaceFileEntry) => {
    addDraftAttachment(session.id, {
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      kind: 'file_ref',
      name: entry.name,
      path: entry.fullPath,
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
    });
    pushToast({ kind: 'info', title: `已添加引用 @${entry.relativePath}` });
  };

  const handleRunCommand = async (overrideCmd?: string) => {
    const cmd = (overrideCmd ?? cmdInput).trim();
    if (!cmd || cmdRunning) return;
    setCmdRunning(true);
    if (!overrideCmd) setCmdInput('');
    try {
      const { result } = await daemonApi.runSessionTerminal(session.id, cmd);
      setCmdHistory((prev) => [result, ...prev.slice(0, 14)]);
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '命令执行失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCmdRunning(false);
    }
  };

  return (
    <aside
      className="flex h-full shrink-0 flex-col"
      style={{
        width: inspectorTab === 'plugins' && widePluginPanel ? 'min(56vw, 820px)' : 340,
        backgroundColor: 'var(--bg-rail)',
        borderLeft: '1px solid var(--border-hairline)',
      }}
    >
      {/* Header Tabs */}
      <div
        className="flex items-center justify-between gap-1 px-2.5 py-2"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="flex flex-wrap items-center gap-0.5">
          {ledgerPlugin && (
            <TabBtn
              active={inspectorTab === 'task'}
              icon={<ListChecks size={12.5} />}
              label="任务"
              badge={taskState?.steps.length || undefined}
              onClick={() => setInspectorTab('task')}
            />
          )}
          {isPluginEnabled('core.git-inspector') && (
            <TabBtn
              active={inspectorTab === 'git'}
              icon={<GitBranch size={12.5} />}
              label="变更"
              badge={git?.changes.length || undefined}
              onClick={() => setInspectorTab('git')}
            />
          )}
          {isPluginEnabled('core.terminal-runner') && (
            <>
              <TabBtn
                active={inspectorTab === 'files'}
                icon={<FolderTree size={12.5} />}
                label="文件"
                onClick={() => setInspectorTab('files')}
              />
              <TabBtn
                active={inspectorTab === 'terminal'}
                icon={<Terminal size={12.5} />}
                label="终端"
                onClick={() => setInspectorTab('terminal')}
              />
            </>
          )}
          <TabBtn
            active={inspectorTab === 'diagnostics'}
            icon={<ScrollText size={12.5} />}
            label="日志"
            badge={diagnostics.length || undefined}
            onClick={() => setInspectorTab('diagnostics')}
          />
          <TabBtn
            active={inspectorTab === 'info'}
            icon={<Info size={12.5} />}
            label="详情"
            onClick={() => setInspectorTab('info')}
          />
          {(inspectorSlotItems.length > 0 || inspectorTab === 'plugins') && (
            <TabBtn
              active={inspectorTab === 'plugins'}
              icon={<Puzzle size={12.5} />}
              label="插件"
              badge={inspectorSlotItems.length || undefined}
              onClick={() => setInspectorTab('plugins')}
            />
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {inspectorTab === 'plugins' && (
            <button type="button" aria-label={widePluginPanel ? '还原插件面板宽度' : '扩大插件面板'}
              aria-pressed={widePluginPanel} onClick={() => setWidePluginPanel((value) => !value)}
              className="cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">
              {widePluginPanel ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          <button type="button" aria-label="关闭侧栏" onClick={() => setInspectorOpen(false)}
            className="cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3.5">
        {inspectorTab === 'plugins' && (
          <div className="space-y-3">
            {inspectorSlotItems.length > 1 && selectedSlotItem && (
              <select
                aria-label="选择插件面板"
                value={selectedSlotItem.registrationKey}
                onChange={(event) => openPluginPanel(event.target.value)}
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 text-[12px] text-[var(--text-primary)]"
              >
                {inspectorSlotItems.map((item) => (
                  <option key={item.registrationKey} value={item.registrationKey}>
                    {item.title ?? item.id} ({item.pluginName})
                  </option>
                ))}
              </select>
            )}
            {selectedSlotItem ? (
              <SlotErrorBoundary
                key={`${session.id}:${selectedSlotItem.registrationKey}`}
                registry={slotRegistry}
                item={selectedSlotItem}
              >
                {selectedSlotItem.render({ session })}
              </SlotErrorBoundary>
            ) : (
              <p className="text-[12px] text-[var(--text-muted)]">暂无已启用的插件面板</p>
            )}
          </div>
        )}
        {inspectorTab === 'task' && <TaskLedgerSurface session={session} plugin={ledgerPlugin} />}

        {inspectorTab === 'git' && (
          <Slot
            name="inspector.diff"
            slotProps={{
              session,
              git,
              onRefresh: () => void refreshGitStatus(session.id),
            }}
            fallback={
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                    <GitBranch size={13.5} className="text-[var(--accent-indigo)]" />
                    <span className="font-mono-code font-medium text-[var(--text-primary)]">
                      {git?.isGitRepo ? git.branch || 'HEAD' : '非 Git 仓库'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshGitStatus(session.id)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    <RefreshCw size={12} />
                    <span>刷新</span>
                  </button>
                </div>

                {!git || !git.isGitRepo ? (
                  <EmptyBox text="当前目录未检测到 Git 版本库，无法展示差异。" />
                ) : git.changes.length === 0 ? (
                  <EmptyBox text="工作区干净，暂无未提交改动。" />
                ) : (
                  <>
                    <div
                      className="overflow-hidden rounded-xl"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      {git.changes.map((c) => (
                        <div
                          key={`${c.staged ? 's' : 'u'}-${c.path}`}
                          className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11.5px]"
                          style={{ borderBottom: '1px solid var(--border-hairline)' }}
                        >
                          <span className="font-mono-code truncate text-[var(--text-primary)]">
                            {c.path}
                          </span>
                          <span
                            className="shrink-0 rounded px-1.5 py-0.5 font-mono-code text-[10px] uppercase"
                            style={{
                              color:
                                c.status === 'added' || c.status === 'untracked'
                                  ? 'var(--accent-emerald)'
                                  : c.status === 'deleted'
                                    ? 'var(--accent-rose)'
                                    : 'var(--accent-star)',
                              backgroundColor: 'var(--bg-elevated)',
                            }}
                          >
                            {c.status[0]}
                          </span>
                        </div>
                      ))}
                    </div>

                    {git.diff && (
                      <div
                        className="overflow-x-auto rounded-xl p-2.5 font-mono-code text-[11px] leading-relaxed"
                        style={{
                          backgroundColor: 'var(--code-bg)',
                          border: '1px solid var(--border-hairline)',
                        }}
                      >
                        {git.diff.split('\n').map((line, i) => {
                          const isAdd = line.startsWith('+') && !line.startsWith('+++');
                          const isDel = line.startsWith('-') && !line.startsWith('---');
                          const isHunk = line.startsWith('@@');
                          return (
                            <div
                              key={i}
                              className="whitespace-pre px-1.5"
                              style={{
                                backgroundColor: isAdd
                                  ? 'var(--diff-add-bg)'
                                  : isDel
                                    ? 'var(--diff-del-bg)'
                                    : 'transparent',
                                color: isAdd
                                  ? 'var(--accent-emerald)'
                                  : isDel
                                    ? 'var(--accent-rose)'
                                    : isHunk
                                      ? 'var(--accent-indigo)'
                                      : 'var(--text-secondary)',
                              }}
                            >
                              {line || ' '}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            }
          />
        )}

        {inspectorTab === 'files' && (
          <div className="space-y-3">
            <div
              className="flex items-center gap-2 rounded-xl px-2.5 py-1.5"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
              <input
                value={fileQuery}
                onChange={(e) => setFileQuery(e.target.value)}
                placeholder="筛选工作区文件..."
                className="w-full bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>

            {activePreview && (
              <div
                className="overflow-hidden rounded-xl"
                style={{
                  backgroundColor: 'var(--code-bg)',
                  border: '1px solid var(--border-strong)',
                }}
              >
                <div
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[11px]"
                  style={{ borderBottom: '1px solid var(--border-hairline)' }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono-code truncate text-[var(--accent-indigo)]">
                      {activePreview.relativePath}{activePreview.target.line ? `:${activePreview.target.line}` : ''}
                    </span>
                    {pluginPreview && <span className="truncate text-[var(--text-muted)]">{pluginPreview.pluginName}</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {fileViewMeta && fileViewMeta.availableViewers.length > 0 && (
                      <>
                        <select
                          aria-label="选择文件查看器"
                          value={selectedViewerId ?? fileViewMeta.resolvedInstanceId ?? fileViewMeta.boundInstanceId ?? ''}
                          onChange={(event) => {
                            const nextId = event.target.value || undefined;
                            setSelectedViewerId(nextId);
                          }}
                          className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)]"
                        >
                          {fileViewMeta.availableViewers.map((viewer: FilePreviewViewerDto) => (
                            <option key={viewer.instanceId} value={viewer.instanceId} disabled={!viewer.ready || !viewer.authorized}>
                              {viewer.name}{!viewer.ready ? '（未就绪）' : !viewer.authorized ? '（待授权）' : ''}
                            </option>
                          ))}
                        </select>
                        {(selectedViewerId ?? fileViewMeta.resolvedInstanceId) &&
                          (selectedViewerId ?? fileViewMeta.resolvedInstanceId) !== fileViewMeta.boundInstanceId && (
                          <button
                            type="button"
                            onClick={() => {
                              const targetViewer = selectedViewerId ?? fileViewMeta.resolvedInstanceId;
                              if (targetViewer) void setSessionBinding(session.id, 'filePreview.v1', targetViewer);
                            }}
                            className="cursor-pointer rounded border border-[var(--border-hairline)] px-1.5 py-0.5 text-[10.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                          >
                            设为会话默认
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      aria-label="关闭文件预览"
                      onClick={closeInspectorFile}
                      className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
                {fileViewMeta && (fileViewMeta.dependencyStatus === 'unavailable' || fileViewMeta.dependencyStatus === 'unauthorized' || fileViewMeta.dependencyStatus === 'failed') && (
                  <div
                    role="status"
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-[var(--accent-rose)]"
                    style={{
                      backgroundColor: 'var(--accent-rose-soft)',
                      borderBottom: '1px solid color-mix(in srgb, var(--accent-rose) 28%, transparent)',
                    }}
                  >
                    <span>{fileViewMeta.dependencyMessage ?? '当前文件查看器暂不可用，已回落纯文本内容。'}</span>
                    <div className="flex flex-wrap items-center gap-1">
                      {fileViewMeta.availableViewers
                        .filter((viewer) => viewer.ready && viewer.authorized)
                        .map((viewer) => (
                          <button
                            key={viewer.instanceId}
                            type="button"
                            onClick={() => {
                              setSelectedViewerId(viewer.instanceId);
                              void setSessionBinding(session.id, 'filePreview.v1', viewer.instanceId);
                            }}
                            className="cursor-pointer rounded bg-[var(--bg-surface)] px-2 py-0.5 text-[10.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                          >
                            切换到{viewer.name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
                <FilePreviewBody
                  key={activePreview.target.path}
                  content={activePreview.content}
                  line={activePreview.target.line}
                  truncated={activePreview.truncated}
                  preview={pluginPreview}
                  onOpenFile={openPreviewLink}
                  onRenderError={clearRenderedPreview}
                />
              </div>
            )}

            {filesLoading ? (
              <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">
                <Loader2 size={14} className="mx-auto animate-spin" />
              </div>
            ) : files.length === 0 ? (
              <EmptyBox text="未匹配到工作区文件" />
            ) : (
              <div
                className="overflow-hidden rounded-xl"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                {files.slice(0, 80).map((f) => (
                  <div
                    key={f.relativePath}
                    className="group flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11.5px] transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ borderBottom: '1px solid var(--border-hairline)' }}
                  >
                    <button
                      type="button"
                      onClick={() => openInspectorFile(session.id, f.relativePath)}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                    >
                      <FileCode2 size={12} className="shrink-0 text-[var(--text-muted)]" />
                      <span className="font-mono-code truncate text-[var(--text-primary)]">
                        {f.relativePath}
                      </span>
                    </button>
                    <button
                      type="button"
                      title="引用此文件到输入框"
                      onClick={() => handleAttachFile(f)}
                      className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--accent-indigo)] opacity-75 hover:bg-[var(--bg-active)] hover:opacity-100"
                    >
                      <AtSign size={10.5} />
                      引用
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {inspectorTab === 'terminal' && (
          <div className="space-y-3">
            <div className="flex gap-1.5">
              <input
                value={cmdInput}
                onChange={(e) => setCmdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleRunCommand();
                }}
                placeholder="在工作区执行命令，如 git status"
                className="font-mono-code flex-1 rounded-xl px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
              <button
                type="button"
                disabled={cmdRunning || !cmdInput.trim()}
                onClick={() => void handleRunCommand()}
                className="inline-flex cursor-pointer items-center gap-1 rounded-xl px-2.5 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-40"
                style={{ backgroundColor: 'var(--accent-indigo)' }}
              >
                {cmdRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {['git status -sb', 'git log -n 5 --oneline', 'pnpm test', `${session.harnessKind} --version`].map(
                (preset) => (
                  <button
                    key={preset}
                    type="button"
                    disabled={cmdRunning}
                    onClick={() => void handleRunCommand(preset)}
                    className="cursor-pointer rounded-lg px-2 py-1 font-mono-code text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    {preset}
                  </button>
                ),
              )}
            </div>

            {cmdHistory.length === 0 ? (
              <EmptyBox text="输入命令或点击快捷按钮，在当前会话目录内直接执行诊断与测试。" />
            ) : (
              <div className="space-y-2.5">
                {cmdHistory.map((res, idx) => (
                  <div
                    key={`${res.command}-${idx}`}
                    className="overflow-hidden rounded-xl"
                    style={{
                      backgroundColor: 'var(--code-bg)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div
                      className="flex items-center justify-between px-2.5 py-1.5 font-mono-code text-[10.5px]"
                      style={{ borderBottom: '1px solid var(--border-hairline)' }}
                    >
                      <span className="truncate text-[var(--text-primary)]">$ {res.command}</span>
                      <span
                        className="shrink-0"
                        style={{
                          color: res.exitCode === 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                        }}
                      >
                        exit {res.exitCode} · {res.durationMs}ms
                      </span>
                    </div>
                    <pre className="m-0 max-h-[200px] overflow-auto p-2.5 font-mono-code text-[11px] leading-relaxed text-[var(--text-secondary)]">
                      {res.stdout || res.stderr || '(无输出)'}
                      {res.stdout && res.stderr ? `\n--- stderr ---\n${res.stderr}` : ''}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {inspectorTab === 'diagnostics' && (
          <div className="space-y-1.5">
            {diagnostics.length === 0 ? (
              <EmptyBox text="暂无 CLI 诊断日志或非 JSON 启动输出。" />
            ) : (
              diagnostics.map((d) => (
                <div
                  key={d.seq}
                  className="rounded-lg px-2.5 py-2 font-mono-code text-[11px] leading-relaxed"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--border-hairline)',
                    color:
                      d.level === 'error'
                        ? 'var(--accent-rose)'
                        : d.level === 'warn'
                          ? 'var(--accent-star)'
                          : 'var(--text-secondary)',
                  }}
                >
                  <div className="mb-0.5 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                    <span className="uppercase">{d.stream}</span>
                    <span>#{d.seq}</span>
                  </div>
                  <div className="break-all">{d.message}</div>
                </div>
              ))
            )}
          </div>
        )}

        {inspectorTab === 'info' && (
          <div className="space-y-3">
            <div
              className="space-y-3 rounded-xl p-3.5 text-[12px]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <MetaRow label="会话 ID" value={session.id} mono />
              <MetaRow label="Harness 引擎" value={`${session.harnessId} (${session.harnessKind})`} />
              <MetaRow label="用户所选模型" value={session.model ?? '跟随 CLI 默认'} mono />
              <MetaRow
                label="CLI 实际确认模型"
                value={session.actualModel ?? '首轮调用后回传'}
                mono
              />
              {session.modelReroutedReason && (
                <MetaRow label="重路由原因" value={session.modelReroutedReason} />
              )}
              <MetaRow label="原生会话 ID" value={session.nativeSessionId ?? '首轮发送后分配'} mono />
              <MetaRow label="工作目录" value={session.cwd} mono />
              {session.worktreeBranch && (
                <MetaRow label="隔离 Worktree 分支" value={session.worktreeBranch} mono />
              )}
              <MetaRow label="事件序列游标" value={`seq #${session.lastSeq}`} mono />
              {session.usage && (
                <MetaRow
                  label="累计用量"
                  value={`In ${formatTokenCount(session.usage.inputTokens)} · Out ${formatTokenCount(session.usage.outputTokens)}${
                    session.usage.costUsd !== undefined ? ` · $${session.usage.costUsd.toFixed(4)}` : ''
                  }`}
                  mono
                />
              )}
            </div>

            {/* Auto-discovered Project Rules & Skills */}
            <div
              className="rounded-xl p-3.5"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <BookOpen size={12} className="text-[var(--accent-star)]" />
                <span>工作区规则与 Skills ({instructions.length})</span>
              </div>
              {instructions.length === 0 ? (
                <p className="text-[11.5px] text-[var(--text-muted)]">
                  未检测到 AGENTS.md / CLAUDE.md / Skills 目录
                </p>
              ) : (
                <div className="space-y-1.5">
                  {instructions.map((ins) => (
                    <div
                      key={ins.relativePath}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[11.5px]"
                      style={{ backgroundColor: 'var(--bg-elevated)' }}
                    >
                      <span className="font-mono-code truncate text-[var(--text-primary)]">
                        {ins.relativePath}
                      </span>
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] uppercase"
                        style={{
                          color: ins.kind === 'skill' ? 'var(--accent-indigo)' : 'var(--accent-star)',
                          backgroundColor: 'var(--bg-surface)',
                        }}
                      >
                        {ins.kind}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function EmptyBox({ text }: { text: string }) {
  return (
    <div
      className="rounded-xl p-4 text-center text-[12px] text-[var(--text-muted)]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      {text}
    </div>
  );
}

function TabBtn({
  active,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors"
      style={{
        backgroundColor: active ? 'var(--bg-surface)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'var(--border-hairline)' : 'transparent'}`,
      }}
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && (
        <span
          className="rounded-full px-1.5 text-[9.5px] tabular-nums"
          style={{
            backgroundColor: 'var(--accent-indigo-soft)',
            color: 'var(--accent-indigo)',
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div
        className={`mt-0.5 break-all text-[12px] text-[var(--text-primary)] ${
          mono ? 'font-mono-code' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
