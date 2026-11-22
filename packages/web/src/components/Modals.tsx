import type { PermissionMode, ReasoningEffort } from '@harnessmate/protocol';
import {
  Check,
  Copy,
  FolderOpen,
  GitBranch,
  History,
  Plus,
  QrCode,
  RefreshCw,
  Shield,
  Smartphone,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState, type ReactNode } from 'react';
import { formatRelativeTime, PERMISSION_MODE_LABELS } from '../lib/harness-meta';
import { useAppStore } from '../stores/app-store';
import { HarnessBadge } from './BrandMark';
import { ModelPicker } from './ModelPicker';
import {
  CommandPaletteModal,
  ContextPreviewModal,
  HandoffModal,
  McpHubModal,
  PluginStudioModal,
  UsageDashboardModal,
} from './StudioModals';

export function ModalHost() {
  const { activeModal, openModal } = useAppStore();
  if (!activeModal) return null;

  const isWide =
    activeModal === 'plugins' ||
    activeModal === 'mcp' ||
    activeModal === 'usage' ||
    activeModal === 'context_preview';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(4, 6, 12, 0.64)', backdropFilter: 'blur(8px)' }}
      onClick={() => openModal(null)}
    >
      <div
        className={`animate-fade-up w-full overflow-hidden rounded-2xl ${
          isWide ? 'max-w-[720px]' : 'max-w-[600px]'
        }`}
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-strong)',
          boxShadow: 'var(--shadow-float)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {activeModal === 'new_session' && <NewSessionModal onClose={() => openModal(null)} />}
        {activeModal === 'add_workspace' && <AddWorkspaceModal onClose={() => openModal(null)} />}
        {activeModal === 'harnesses' && <HarnessCenterModal onClose={() => openModal(null)} />}
        {activeModal === 'remote_pairing' && <RemotePairingModal onClose={() => openModal(null)} />}
        {activeModal === 'plugins' && <PluginStudioModal onClose={() => openModal(null)} />}
        {activeModal === 'mcp' && <McpHubModal onClose={() => openModal(null)} />}
        {activeModal === 'usage' && <UsageDashboardModal onClose={() => openModal(null)} />}
        {activeModal === 'handoff' && <HandoffModal onClose={() => openModal(null)} />}
        {activeModal === 'context_preview' && (
          <ContextPreviewModal onClose={() => openModal(null)} />
        )}
        {activeModal === 'command_palette' && <CommandPaletteModal onClose={() => openModal(null)} />}
      </div>
    </div>
  );
}

function ModalHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="flex items-start justify-between gap-4 px-5 py-4"
      style={{ borderBottom: '1px solid var(--border-hairline)' }}
    >
      <div>
        <h3 className="text-[15.5px] font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h3>
        {subtitle && <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{subtitle}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function NewSessionModal({ onClose }: { onClose: () => void }) {
  const {
    harnesses,
    workspaces,
    selectedWorkspaceId,
    newSessionPresetHarnessId,
    discoveredSessions,
    loadDiscoveredSessions,
    createSession,
    addWorkspace,
    pushToast,
  } = useAppStore();

  const [tab, setTab] = useState<'new' | 'resume'>('new');
  const [workspaceId, setWorkspaceId] = useState(
    selectedWorkspaceId ?? workspaces[0]?.id ?? '',
  );
  const [newPath, setNewPath] = useState('');
  const [harnessId, setHarnessId] = useState(
    newSessionPresetHarnessId ?? harnesses.find((h) => h.health === 'ready')?.id ?? harnesses[0]?.id ?? 'codex',
  );
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<ReasoningEffort | ''>('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('accept_edits');
  const [createWorktree, setCreateWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selectedHarness = harnesses.find((h) => h.id === harnessId);
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId);
  const selectedModelMeta = selectedHarness?.models.find((m) => m.id === model) ?? null;
  const availableEfforts =
    selectedModelMeta?.supportedEfforts && selectedModelMeta.supportedEfforts.length > 0
      ? selectedModelMeta.supportedEfforts
      : selectedHarness?.capabilities.reasoningEfforts ?? [];

  useEffect(() => {
    if (tab === 'resume') {
      void loadDiscoveredSessions();
    }
  }, [tab, loadDiscoveredSessions]);

  const handlePickFolder = async () => {
    const picked = await window.harnessMateBridge?.pickDirectory();
    if (picked) {
      const ws = await addWorkspace(picked);
      setWorkspaceId(ws.id);
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      let targetWsId = workspaceId;
      if (!targetWsId && newPath.trim()) {
        const ws = await addWorkspace(newPath.trim());
        targetWsId = ws.id;
      }
      if (!targetWsId) {
        pushToast({ kind: 'warning', title: '请先选择或输入本地工作区目录' });
        return;
      }

      await createSession({
        workspaceId: targetWsId,
        harnessId,
        model: model || null,
        reasoningEffort: effort || null,
        permissionMode,
        createWorktree: createWorktree && Boolean(selectedWorkspace?.isGitRepo),
        worktreeBranch: worktreeBranch.trim() || undefined,
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '创建会话失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleResumeDiscovered = async (item: (typeof discoveredSessions)[number]) => {
    setSubmitting(true);
    try {
      let targetWsId = workspaceId;
      if (item.cwd) {
        const ws = await addWorkspace(item.cwd);
        targetWsId = ws.id;
      }
      if (!targetWsId) {
        pushToast({ kind: 'warning', title: '请先在左侧添加一个工作区以挂载该历史会话' });
        return;
      }
      await createSession({
        workspaceId: targetWsId,
        harnessId: item.harnessKind,
        title: item.title,
        nativeSessionId: item.nativeSessionId,
        permissionMode: 'accept_edits',
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '接管历史会话失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <ModalHeader
        title="新建共享任务会话"
        subtitle="所有 CLI 引擎共享同一会话与任务账本，进入对话后可随时无缝切换 Codex / AGY / Claude"
        onClose={onClose}
      />

      <div className="flex gap-2 px-5 pt-3">
        <SegmentBtn active={tab === 'new'} onClick={() => setTab('new')}>
          <Plus size={13} />
          新建会话
        </SegmentBtn>
        <SegmentBtn active={tab === 'resume'} onClick={() => setTab('resume')}>
          <History size={13} />
          接管本机 CLI 历史
        </SegmentBtn>
      </div>

      {tab === 'new' ? (
        <div className="space-y-4 p-5">
          {/* Workspace */}
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
              本地工作区目录
            </label>
            {workspaces.length > 0 ? (
              <div className="flex gap-2">
                <select
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  className="flex-1 rounded-xl px-3 py-2 text-[13px] text-[var(--text-primary)] focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} — {w.rootPath}
                    </option>
                  ))}
                </select>
                {window.harnessMateBridge && (
                  <button
                    type="button"
                    onClick={() => void handlePickFolder()}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    style={{ border: '1px solid var(--border-hairline)' }}
                  >
                    <FolderOpen size={14} />
                    选择文件夹
                  </button>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="输入绝对路径，例如 D:\Projects\my-app"
                  className="font-mono-code flex-1 rounded-xl px-3 py-2 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                />
                {window.harnessMateBridge && (
                  <button
                    type="button"
                    onClick={() => void handlePickFolder()}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    style={{ border: '1px solid var(--border-hairline)' }}
                  >
                    <FolderOpen size={14} />
                    浏览
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Harness Cards */}
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
              初始执笔引擎（随时可在会话内无缝切换）
            </label>
            <div className="grid grid-cols-3 gap-2">
              {harnesses.map((h) => {
                const active = harnessId === h.id;
                const ready = h.health === 'ready';
                return (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => {
                      setHarnessId(h.id);
                      setModel(null);
                      setEffort('');
                    }}
                    className="flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 text-left transition-all"
                    style={{
                      backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                      border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                      opacity: ready ? 1 : 0.65,
                    }}
                  >
                    <HarnessBadge kind={h.kind} label={h.displayName} compact />
                    <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                      {ready ? `v${h.version ?? 'ready'} · ${h.models.length} 模型` : '未安装'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Grouped Searchable Model + Effort + Mode */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[11px] text-[var(--text-muted)]">实时模型目录</label>
              <ModelPicker
                models={selectedHarness?.models ?? []}
                value={model}
                defaultModelId={selectedHarness?.defaultModelId}
                placement="bottom"
                onChange={(nextModel) => {
                  setModel(nextModel);
                  setEffort('');
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-[var(--text-muted)]">推理强度</label>
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value as ReasoningEffort | '')}
                className="w-full rounded-xl px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <option value="">默认</option>
                {availableEfforts.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-[var(--text-muted)]">权限策略</label>
              <select
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                className="w-full rounded-xl px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                {(
                  selectedHarness?.capabilities.permissionModes ?? ['plan', 'accept_edits', 'auto']
                ).map((mode) => (
                  <option key={mode} value={mode}>
                    {PERMISSION_MODE_LABELS[mode]?.label ?? mode}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Optional Git Worktree Isolation */}
          {selectedWorkspace?.isGitRepo && (
            <div
              className="rounded-xl p-3"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <label className="flex cursor-pointer items-center justify-between gap-2 text-[12.5px]">
                <span className="inline-flex items-center gap-2 text-[var(--text-primary)]">
                  <GitBranch size={14} className="text-[var(--accent-indigo)]" />
                  创建独立 Git Worktree（多 Agent 并行防文件冲突）
                </span>
                <input
                  type="checkbox"
                  checked={createWorktree}
                  onChange={(e) => setCreateWorktree(e.target.checked)}
                />
              </label>
              {createWorktree && (
                <input
                  value={worktreeBranch}
                  onChange={(e) => setWorktreeBranch(e.target.value)}
                  placeholder="可选新分支名，留空自动生成 hm/..."
                  className="font-mono-code mt-2.5 w-full rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--border-hairline)',
                  }}
                />
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-xl px-4 py-2 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleSubmit()}
              className="cursor-pointer rounded-xl px-4 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {submitting ? '启动中...' : '创建并进入对话'}
            </button>
          </div>
        </div>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto p-5">
          {discoveredSessions.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-[var(--text-muted)]">
              暂未在 `~/.codex`、`~/.claude` 或 `~/.gemini/antigravity-cli` 发现可恢复会话。
            </div>
          ) : (
            discoveredSessions.map((item) => (
              <div
                key={`${item.harnessKind}-${item.nativeSessionId}`}
                className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <HarnessBadge kind={item.harnessKind} compact />
                    <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                      {item.title}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono-code text-[11px] text-[var(--text-muted)]">
                    {item.cwd ?? item.nativeSessionId} · {formatRelativeTime(item.updatedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleResumeDiscovered(item)}
                  className="shrink-0 cursor-pointer rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-[var(--accent-indigo)] transition-colors hover:bg-[var(--bg-active)]"
                  style={{ border: '1px solid var(--border-focus)' }}
                >
                  接管恢复
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AddWorkspaceModal({ onClose }: { onClose: () => void }) {
  const { addWorkspace, pushToast } = useAppStore();
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const handlePick = async () => {
    const picked = await window.harnessMateBridge?.pickDirectory();
    if (picked) setRootPath(picked);
  };

  const handleSave = async () => {
    if (!rootPath.trim()) return;
    setBusy(true);
    try {
      await addWorkspace(rootPath.trim(), name.trim() || undefined);
      onClose();
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '添加工作区失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ModalHeader title="添加本地项目工作区" subtitle="为多 Harness 会话指定本地根目录" onClose={onClose} />
      <div className="space-y-4 p-5">
        <div>
          <label className="mb-1.5 block text-[12px] text-[var(--text-secondary)]">目录路径</label>
          <div className="flex gap-2">
            <input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="例如 D:\Code\my-project"
              className="font-mono-code flex-1 rounded-xl px-3 py-2 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            />
            {window.harnessMateBridge && (
              <button
                type="button"
                onClick={() => void handlePick()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                style={{ border: '1px solid var(--border-hairline)' }}
              >
                <FolderOpen size={14} />
                浏览
              </button>
            )}
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] text-[var(--text-secondary)]">
            显示名称（可选）
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="默认使用文件夹名"
            className="w-full rounded-xl px-3 py-2 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl px-4 py-2 text-[12.5px] text-[var(--text-secondary)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!rootPath.trim() || busy}
            onClick={() => void handleSave()}
            className="cursor-pointer rounded-xl px-4 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent-indigo)' }}
          >
            确认添加
          </button>
        </div>
      </div>
    </div>
  );
}

function HarnessCenterModal({ onClose }: { onClose: () => void }) {
  const { harnesses, refreshHarnesses, registerCustomHarness, deleteCustomHarness, pushToast } =
    useAppStore();
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [customArgs, setCustomArgs] = useState('acp --stdio');

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshHarnesses();
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddCustom = async () => {
    if (!customId.trim() || !customName.trim() || !customCmd.trim()) return;
    try {
      await registerCustomHarness({
        id: customId.trim().toLowerCase(),
        displayName: customName.trim(),
        description: `Custom ACP CLI (${customCmd.trim()})`,
        command: customCmd.trim(),
        args: customArgs.trim().split(/\s+/).filter(Boolean),
      });
      setShowAdd(false);
      setCustomId('');
      setCustomName('');
      setCustomCmd('');
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '注册失败',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div>
      <ModalHeader
        title="本机 CLI Harness 引擎管理"
        subtitle="实时探测本机 CLI 版本、订阅身份与动态模型目录，并支持注册任意 ACP CLI"
        onClose={onClose}
      />

      <div className="max-h-[480px] space-y-3 overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            重新探测 CLI 与模型
          </button>

          <button
            type="button"
            onClick={() => setShowAdd(!showAdd)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-active)]"
            style={{ border: '1px solid var(--border-focus)' }}
          >
            <Plus size={13} />
            注册自定义 ACP CLI
          </button>
        </div>

        {showAdd && (
          <div
            className="space-y-2.5 rounded-xl p-3.5"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <input
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="ID (如 opencode)"
                className="font-mono-code rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="显示名 (如 OpenCode CLI)"
                className="rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={customCmd}
                onChange={(e) => setCustomCmd(e.target.value)}
                placeholder="可执行命令 (如 opencode)"
                className="font-mono-code rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
              <input
                value={customArgs}
                onChange={(e) => setCustomArgs(e.target.value)}
                placeholder="ACP 参数 (如 acp --stdio)"
                className="font-mono-code rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleAddCustom()}
                className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium text-white"
                style={{ backgroundColor: 'var(--accent-indigo)' }}
              >
                保存并探测
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2.5">
          {harnesses.map((h) => {
            const ready = h.health === 'ready';
            return (
              <div
                key={h.id}
                className="rounded-xl p-3.5"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <HarnessBadge kind={h.kind} label={h.displayName} />
                    <span
                      className="text-[11.5px] font-medium"
                      style={{
                        color: ready ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                      }}
                    >
                      {ready ? `就绪 · v${h.version ?? 'ok'} · ${h.models.length} 模型` : '不可用'}
                    </span>
                  </div>
                  {h.isCustom && (
                    <button
                      type="button"
                      onClick={() => void deleteCustomHarness(h.id)}
                      className="cursor-pointer rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent-rose)]"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>

                <div className="mt-2 space-y-1 text-[11.5px] text-[var(--text-secondary)]">
                  <div>协议：{h.protocolLabel}</div>
                  {h.accountSummary && <div>账号 / 网关：{h.accountSummary}</div>}
                  <div className="font-mono-code truncate text-[11px] text-[var(--text-muted)]">
                    路径：{h.binaryPath ?? h.healthMessage ?? '未找到'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RemotePairingModal({ onClose }: { onClose: () => void }) {
  const {
    remoteStatus,
    refreshRemoteStatus,
    toggleLanAccess,
    generatePairingCode,
    revokeDevice,
  } = useAppStore();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    void refreshRemoteStatus();
  }, [refreshRemoteStatus]);

  const copyText = (key: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1500);
  };

  const activeDevices = (remoteStatus?.pairedDevices ?? []).filter((d) => !d.revokedAt);

  return (
    <div>
      <ModalHeader
        title="移动端 HarnessMate 远程联动"
        subtitle="HM-Remote v1 · 局域网显式授权 + Tailscale 直连 · 跨端实时会话与权限审批"
        onClose={onClose}
      />

      <div className="max-h-[520px] space-y-4 overflow-y-auto p-5">
        <div
          className="flex items-center justify-between gap-4 rounded-xl p-3.5"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-start gap-2.5">
            <Wifi
              size={16}
              className="mt-0.5 shrink-0"
              style={{
                color: remoteStatus?.lanEnabled ? 'var(--accent-emerald)' : 'var(--text-muted)',
              }}
            />
            <div>
              <div className="text-[13px] font-medium text-[var(--text-primary)]">
                开启局域网 / Tailscale 远程访问
              </div>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                默认仅监听 127.0.0.1；开启后外部设备仍须通过一次性配对码换取设备 Token 才可访问。
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void toggleLanAccess(!remoteStatus?.lanEnabled)}
            className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors"
            style={{
              backgroundColor: remoteStatus?.lanEnabled
                ? 'var(--accent-emerald)'
                : 'var(--border-strong)',
            }}
          >
            <span
              className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform"
              style={{
                transform: remoteStatus?.lanEnabled ? 'translateX(20px)' : 'translateX(0)',
              }}
            />
          </button>
        </div>

        {remoteStatus && (
          <div
            className="space-y-2 rounded-xl p-3.5 text-[12px]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              <span>桌面节点地址（端口 {remoteStatus.port}）</span>
              <span className="font-mono-code">{remoteStatus.desktopName}</span>
            </div>

            {[
              ...remoteStatus.tailscaleAddresses.map((ip) => ({ label: 'Tailscale', url: `http://${ip}:${remoteStatus.port}` })),
              ...remoteStatus.lanAddresses.map((ip) => ({ label: '局域网', url: `http://${ip}:${remoteStatus.port}` })),
            ].map((ep) => (
              <div
                key={ep.url}
                className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
                style={{ backgroundColor: 'var(--bg-surface)' }}
              >
                <div className="flex items-center gap-2 font-mono-code text-[12px]">
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-indigo)]"
                    style={{ backgroundColor: 'var(--accent-indigo-soft)' }}
                  >
                    {ep.label}
                  </span>
                  <span className="text-[var(--text-primary)]">{ep.url}</span>
                </div>
                <button
                  type="button"
                  onClick={() => copyText(ep.url, ep.url)}
                  className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {copiedKey === ep.url ? (
                    <Check size={13} className="text-[var(--accent-emerald)]" />
                  ) : (
                    <Copy size={13} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className="rounded-2xl p-4"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
              <QrCode size={15} className="text-[var(--accent-star)]" />
              <span>配对新移动设备</span>
            </div>
            <button
              type="button"
              onClick={() => void generatePairingCode()}
              className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium text-white"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {remoteStatus?.activePairing ? '刷新配对码' : '生成配对二维码'}
            </button>
          </div>

          {remoteStatus?.activePairing && (
            <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row">
              <div className="rounded-xl bg-white p-3">
                <QRCodeSVG value={remoteStatus.activePairing.qrUri} size={136} />
              </div>
              <div className="flex-1 space-y-2 text-center sm:text-left">
                <div className="text-[11.5px] text-[var(--text-muted)]">6 位一次性配对短码（5 分钟有效）</div>
                <div className="font-mono-code text-[28px] font-bold tracking-[0.22em] text-[var(--accent-star)]">
                  {remoteStatus.activePairing.code}
                </div>
                <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                  在移动端 HarnessMate「远程桌面」中扫描二维码或输入上方地址与配对码，即可远程接管桌面会话与工具审批。
                </p>
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-secondary)]">
            <Shield size={13} />
            <span>已配对设备（{activeDevices.length}）</span>
          </div>
          {activeDevices.length === 0 ? (
            <div
              className="rounded-xl p-3.5 text-center text-[12px] text-[var(--text-muted)]"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              尚未配对任何移动设备
            </div>
          ) : (
            <div className="space-y-1.5">
              {activeDevices.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-xl px-3.5 py-2.5"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <Smartphone size={14} className="text-[var(--accent-emerald)]" />
                    <div>
                      <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                        {d.deviceName}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        {d.platform} · 最近活跃 {d.lastSeenAt ? formatRelativeTime(d.lastSeenAt) : '从未'}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void revokeDevice(d.id)}
                    className="cursor-pointer rounded-lg px-2.5 py-1 text-[11.5px] text-[var(--accent-rose)] hover:bg-[var(--accent-rose-soft)]"
                  >
                    吊销
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SegmentBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
      style={{
        backgroundColor: active ? 'var(--bg-active)' : 'transparent',
        color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
      }}
    >
      {children}
    </button>
  );
}
