import type {
  GitDryRunMergeResult,
  GitWorktreeEntry,
  ManagedTerminalTab,
  Workspace,
  WorkspaceSetupScriptInfo,
} from '@harnessmate/protocol';
import {
  AlertTriangle,
  CheckCircle2,
  FolderGit2,
  GitBranch,
  GitMerge,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiHttpError, daemonApi } from '../api/client';
import { useAppStore } from '../stores/app-store';

export interface WorktreeManagerModalProps {
  onClose: () => void;
  /** Optional overrides for standalone unit testing. */
  workspacesOverride?: Workspace[];
  initialWorktrees?: GitWorktreeEntry[];
  initialSetupScript?: WorkspaceSetupScriptInfo;
  initialDryRunResult?: GitDryRunMergeResult | null;
  initialBlockingTerminals?: Record<string, ManagedTerminalTab[]>;
}

export function WorktreeManagerModal({
  onClose,
  workspacesOverride,
  initialWorktrees,
  initialSetupScript,
  initialDryRunResult = null,
  initialBlockingTerminals = {},
}: WorktreeManagerModalProps) {
  const storeWorkspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const pushToast = useAppStore((s) => s.pushToast);

  const workspaces = workspacesOverride ?? storeWorkspaces;
  const gitWorkspaces = workspaces.filter((w) => w.isGitRepo);
  const [workspaceId, setWorkspaceId] = useState(
    selectedWorkspaceId && gitWorkspaces.some((w) => w.id === selectedWorkspaceId)
      ? selectedWorkspaceId
      : gitWorkspaces[0]?.id ?? workspaces[0]?.id ?? '',
  );

  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>(initialWorktrees ?? []);
  const [setupScript, setSetupScript] = useState<WorkspaceSetupScriptInfo | null>(
    initialSetupScript ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<GitDryRunMergeResult | null>(
    initialDryRunResult,
  );
  const [dryRunTargetBranch, setDryRunTargetBranch] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [blockingTerminalsByPath, setBlockingTerminalsByPath] = useState<
    Record<string, ManagedTerminalTab[]>
  >(initialBlockingTerminals);

  const loadWorkspaceWorktrees = useCallback(async () => {
    if (!workspaceId || initialWorktrees) return;
    setLoading(true);
    try {
      const res = await daemonApi.listWorktrees(workspaceId);
      setWorktrees(res.worktrees);
      setSetupScript(res.setupScript);
      setBlockingTerminalsByPath(res.blockingTerminalsByPath ?? {});
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '加载 Worktree 列表失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, initialWorktrees, pushToast]);

  useEffect(() => {
    void loadWorkspaceWorktrees();
  }, [loadWorkspaceWorktrees]);

  const mainWorktree = worktrees.find((w) => w.isMain) ?? worktrees[0];
  const defaultBaseBranch = mainWorktree?.branch || 'main';

  const handleCreateWorktree = async () => {
    if (!workspaceId || !branchName.trim()) return;
    setBusy('create');
    try {
      const res = await daemonApi.createWorktree(workspaceId, {
        branchName: branchName.trim(),
        baseBranch: baseBranch.trim() || undefined,
      });
      setWorktrees(res.worktrees);
      setBranchName('');
      pushToast({
        kind: 'success',
        title: `已创建 Worktree (${res.created.branch})`,
        body: res.created.worktreePath,
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '创建 Worktree 失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveWorktree = async (wt: GitWorktreeEntry) => {
    if (!workspaceId) return;
    setBusy(`remove:${wt.path}`);
    setRemoveError(null);
    try {
      const res = await daemonApi.removeWorktree(workspaceId, wt.path, false);
      setWorktrees(res.worktrees);
      pushToast({ kind: 'info', title: res.result.message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRemoveError(msg);
      if (err instanceof ApiHttpError && err.code === 'E_WORKTREE_BUSY') {
        const list = err.payload?.blockingTerminals;
        if (Array.isArray(list)) {
          setBlockingTerminalsByPath((prev) => ({
            ...prev,
            [wt.path]: list as ManagedTerminalTab[],
          }));
        }
      }
      pushToast({ kind: 'error', title: '移除 Worktree 失败', body: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleReleaseBlockingTerminals = async (targetPath: string) => {
    setBusy(`release:${targetPath}`);
    try {
      const res = await daemonApi.releaseTerminalsUnderPath(targetPath);
      setBlockingTerminalsByPath((prev) => {
        const next = { ...prev };
        delete next[targetPath];
        return next;
      });
      setRemoveError(null);
      pushToast({
        kind: 'success',
        title: `已释放 ${res.releasedCount} 个占用终端`,
        body: '现在可以安全移除 Worktree 目录。',
      });
      await loadWorkspaceWorktrees();
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '释放占用终端失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleDryRunMerge = async (headBranch: string) => {
    if (!workspaceId) return;
    setBusy(`merge:${headBranch}`);
    setDryRunTargetBranch(headBranch);
    try {
      const res = await daemonApi.dryRunMerge(workspaceId, {
        baseBranch: defaultBaseBranch,
        headBranch,
      });
      setDryRunResult(res);
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '合并冲突预检失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleToggleSetupTrust = async (trusted: boolean) => {
    if (!workspaceId || !setupScript?.sha256) return;
    setBusy('trust');
    try {
      const res = await daemonApi.setSetupScriptTrust(workspaceId, {
        sha256: setupScript.sha256,
        trusted,
      });
      setSetupScript(res.setupScript);
      pushToast({
        kind: trusted ? 'success' : 'info',
        title: trusted ? '已信任当前 .harnessmate/setup 脚本哈希' : '已撤销脚本信任',
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '更新信任状态失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRunSetupScript = async (targetPath?: string) => {
    if (!workspaceId) return;
    setBusy('run_setup');
    try {
      const res = await daemonApi.runSetupScript(workspaceId, targetPath);
      pushToast({ kind: 'success', title: res.result.message });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '执行 Setup 脚本被拦截或失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex max-h-[82vh] flex-col">
      {/* Header */}
      <div
        className="flex items-start justify-between gap-4 px-5 py-4"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div>
          <h3 className="flex items-center gap-2 text-[15.5px] font-semibold tracking-tight text-[var(--text-primary)]">
            <FolderGit2 size={16} className="text-[var(--accent-indigo)]" />
            <span>Git Worktree 管理器与安全脚本信任边界</span>
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            多分支隔离并行开发、无副作用合并冲突预检 (merge-tree) 与 .harnessmate/setup SHA-256 信任门禁
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭 Worktree 管理器"
          onClick={onClose}
          className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-5 text-[12px]">
        {/* Workspace Selector */}
        <div className="flex items-center gap-2">
          <select
            aria-label="选择 Git 工作区"
            value={workspaceId}
            onChange={(e) => {
              setWorkspaceId(e.target.value);
              setDryRunResult(null);
              setRemoveError(null);
              setBlockingTerminalsByPath({});
            }}
            className="flex-1 rounded-xl px-3 py-2 text-[12px] text-[var(--text-primary)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name} ({ws.rootPath}) {ws.isGitRepo ? '' : '· 非 Git'}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void loadWorkspaceWorktrees()}
            className="inline-flex cursor-pointer items-center gap-1 rounded-xl px-3 py-2 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <RefreshCw size={12.5} className={loading ? 'animate-spin' : ''} />
            <span>刷新</span>
          </button>
        </div>

        {/* Create Worktree Form */}
        <div
          className="rounded-xl p-3"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="mb-2 text-[11.5px] font-medium text-[var(--text-primary)]">
            新建隔离 Worktree
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="新分支名（例如 feat/auth-v2）"
              className="min-w-[180px] flex-1 rounded-lg px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            />
            <input
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder={`基础分支（默认 ${defaultBaseBranch}）`}
              className="w-[170px] rounded-lg px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            />
            <button
              type="button"
              disabled={!branchName.trim() || busy === 'create'}
              onClick={() => void handleCreateWorktree()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {busy === 'create' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Plus size={12.5} />
              )}
              <span>创建</span>
            </button>
          </div>
        </div>

        {removeError && (
          <div
            className="flex items-start gap-2 rounded-xl px-3 py-2 text-[11.5px] text-[var(--accent-rose)]"
            style={{
              backgroundColor: 'var(--accent-rose-soft)',
              border: '1px solid color-mix(in srgb, var(--accent-rose) 30%, transparent)',
            }}
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{removeError}</span>
          </div>
        )}

        {/* Worktree List */}
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            已托管 Worktree ({worktrees.length})
          </div>
          {worktrees.length === 0 ? (
            <div
              className="rounded-xl px-4 py-5 text-center text-[11.5px] text-[var(--text-muted)]"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px dashed var(--border-hairline)',
              }}
            >
              当前工作区暂无 Worktree 记录
            </div>
          ) : (
            worktrees.map((wt) => (
              <div
                key={wt.path}
                data-testid={`worktree-row-${wt.branch || wt.headSha}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <GitBranch size={13} className="shrink-0 text-[var(--accent-indigo)]" />
                    <span className="font-mono-code font-medium text-[var(--text-primary)]">
                      {wt.branch || '(detached)'}
                    </span>
                    {wt.isMain && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[9.5px] font-medium"
                        style={{
                          backgroundColor: 'var(--accent-indigo-soft)',
                          color: 'var(--accent-indigo)',
                        }}
                      >
                        主仓库
                      </span>
                    )}
                    {wt.dirtyCount > 0 && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[9.5px]"
                        style={{
                          backgroundColor: 'var(--accent-star-soft)',
                          color: 'var(--accent-star)',
                        }}
                      >
                        {wt.dirtyCount} 处未提交
                      </span>
                    )}
                    {wt.linkedSessionIds.length > 0 && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[9.5px]"
                        style={{
                          backgroundColor: 'var(--accent-emerald-soft)',
                          color: 'var(--accent-emerald)',
                        }}
                      >
                        关联 {wt.linkedSessionIds.length} 个会话
                      </span>
                    )}
                    {(blockingTerminalsByPath[wt.path]?.length ?? 0) > 0 && (
                      <span
                        data-testid="worktree-terminal-busy-badge"
                        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px]"
                        style={{
                          backgroundColor: 'var(--accent-rose-soft)',
                          color: 'var(--accent-rose)',
                        }}
                      >
                        <Terminal size={10} />
                        <span>
                          占用中 ({blockingTerminalsByPath[wt.path]!.map((t) => t.title).join(', ')})
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono-code text-[10.5px] text-[var(--text-muted)]">
                    {wt.path} · {(wt.headSha ?? '').slice(0, 8)}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {!wt.isMain && (blockingTerminalsByPath[wt.path]?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      data-testid="release-worktree-terminals-btn"
                      disabled={busy !== null}
                      onClick={() => void handleReleaseBlockingTerminals(wt.path)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-[var(--accent-star)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
                      style={{
                        border: '1px solid color-mix(in srgb, var(--accent-star) 38%, transparent)',
                      }}
                    >
                      {busy === `release:${wt.path}` ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Terminal size={11.5} />
                      )}
                      <span>一键释放占用终端</span>
                    </button>
                  )}
                  {!wt.isMain && wt.branch && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void handleDryRunMerge(wt.branch!)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-45"
                      style={{ border: '1px solid var(--border-hairline)' }}
                    >
                      {busy === `merge:${wt.branch}` ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <GitMerge size={11.5} />
                      )}
                      <span>合并预检</span>
                    </button>
                  )}
                  {!wt.isMain && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void handleRemoveWorktree(wt)}
                      title="安全清理 Worktree（遇文件占用将提示并执行 prune）"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--accent-rose)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
                      style={{
                        border: '1px solid color-mix(in srgb, var(--accent-rose) 30%, transparent)',
                      }}
                    >
                      <Trash2 size={11.5} />
                      <span>安全移除</span>
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Dry-Run Merge Pre-check Result */}
        {dryRunResult && (
          <div
            data-testid="dry-run-merge-result"
            className="space-y-1.5 rounded-xl p-3"
            style={{
              backgroundColor: !dryRunResult.supported
                ? 'var(--bg-elevated)'
                : !dryRunResult.hasConflicts
                  ? 'var(--accent-emerald-soft)'
                  : 'var(--accent-rose-soft)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <div className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
              {!dryRunResult.supported ? (
                <AlertTriangle size={14} className="text-[var(--accent-star)]" />
              ) : !dryRunResult.hasConflicts ? (
                <CheckCircle2 size={14} className="text-[var(--accent-emerald)]" />
              ) : (
                <AlertTriangle size={14} className="text-[var(--accent-rose)]" />
              )}
              <span>
                合并预检{dryRunTargetBranch ? ` (${dryRunTargetBranch} → ${defaultBaseBranch})` : ''}
              </span>
              {dryRunResult.gitVersion && (
                <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                  git {dryRunResult.gitVersion}
                </span>
              )}
            </div>
            <p className="text-[11.5px] text-[var(--text-secondary)]">{dryRunResult.message}</p>
            {dryRunResult.conflictFiles.length > 0 && (
              <ul className="ml-4 list-disc font-mono-code text-[11px] text-[var(--accent-rose)]">
                {dryRunResult.conflictFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* .harnessmate/setup Script Trust Boundary */}
        <div
          data-testid="setup-script-panel"
          className="space-y-2.5 rounded-xl p-3.5"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {setupScript?.trusted ? (
                <ShieldCheck size={15} className="text-[var(--accent-emerald)]" />
              ) : (
                <ShieldAlert size={15} className="text-[var(--accent-star)]" />
              )}
              <span className="font-medium text-[var(--text-primary)]">
                .harnessmate/setup 初始化脚本信任边界
              </span>
            </div>
            {setupScript?.exists && (
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: setupScript.trusted
                    ? 'var(--accent-emerald-soft)'
                    : 'var(--accent-star-soft)',
                  color: setupScript.trusted ? 'var(--accent-emerald)' : 'var(--accent-star)',
                }}
              >
                {setupScript.trusted ? '已信任此 SHA-256' : '未信任（禁止自动执行）'}
              </span>
            )}
          </div>

          {!setupScript || !setupScript.exists ? (
            <p className="text-[11px] text-[var(--text-muted)]">
              当前仓库未检测到 <code className="font-mono-code">.harnessmate/setup</code>（或{' '}
              <code className="font-mono-code">.ps1</code> / <code className="font-mono-code">.sh</code>
              ）脚本。
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono-code text-[10.5px] text-[var(--text-muted)]">
                <span>路径：{setupScript.relativePath}</span>
                <span>SHA-256: {setupScript.sha256}</span>
              </div>

              <pre
                data-testid="setup-script-content"
                className="max-h-40 overflow-auto rounded-lg p-2.5 font-mono-code text-[10.5px] text-[var(--text-primary)]"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                {setupScript.content}
              </pre>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10.5px] text-[var(--text-muted)]">
                  脚本内容任何改动都将使 SHA-256 失效并重新要求人工审查授权。
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void handleToggleSetupTrust(!setupScript.trusted)}
                    className="cursor-pointer rounded-lg px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                    style={{ border: '1px solid var(--border-strong)' }}
                  >
                    {setupScript.trusted ? '撤销信任' : '审查并信任此脚本'}
                  </button>
                  <button
                    type="button"
                    disabled={!setupScript.trusted || busy !== null}
                    onClick={() => void handleRunSetupScript()}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
                    style={{ backgroundColor: 'var(--accent-indigo)' }}
                  >
                    {busy === 'run_setup' ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Play size={11} />
                    )}
                    <span>运行脚本</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
