import type {
  GitFileDiffResult,
  GitStatusSummary,
  Session,
  SessionCheckpointRecord,
} from '@harnessmate/protocol';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Columns2,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { daemonApi } from '../api/client';
import { useAppStore } from '../stores/app-store';

interface DiffLinePair {
  leftNum: string;
  leftText: string;
  leftKind: 'context' | 'del' | 'empty' | 'hunk';
  rightNum: string;
  rightText: string;
  rightKind: 'context' | 'add' | 'empty' | 'hunk';
}

export function parseUnifiedToSplitLines(unifiedDiff: string): DiffLinePair[] {
  const rows: DiffLinePair[] = [];
  let leftLine = 0;
  let rightLine = 0;
  const rawLines = unifiedDiff.split(/\r?\n/);

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i]!;
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode')
    ) {
      i += 1;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      leftLine = Number(hunkMatch[1]);
      rightLine = Number(hunkMatch[2]);
      rows.push({
        leftNum: '',
        leftText: line,
        leftKind: 'hunk',
        rightNum: '',
        rightText: line,
        rightKind: 'hunk',
      });
      i += 1;
      continue;
    }

    if (line.startsWith('-') || line.startsWith('+')) {
      const dels: Array<{ num: number; text: string }> = [];
      const adds: Array<{ num: number; text: string }> = [];
      while (i < rawLines.length && (rawLines[i]!.startsWith('-') || rawLines[i]!.startsWith('+'))) {
        const cur = rawLines[i]!;
        if (cur.startsWith('-')) {
          dels.push({ num: leftLine++, text: cur.slice(1) });
        } else {
          adds.push({ num: rightLine++, text: cur.slice(1) });
        }
        i += 1;
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let k = 0; k < maxLen; k += 1) {
        const d = dels[k];
        const a = adds[k];
        rows.push({
          leftNum: d ? String(d.num) : '',
          leftText: d ? d.text : '',
          leftKind: d ? 'del' : 'empty',
          rightNum: a ? String(a.num) : '',
          rightText: a ? a.text : '',
          rightKind: a ? 'add' : 'empty',
        });
      }
      continue;
    }

    if (line.startsWith(' ')) {
      rows.push({
        leftNum: String(leftLine++),
        leftText: line.slice(1),
        leftKind: 'context',
        rightNum: String(rightLine++),
        rightText: line.slice(1),
        rightKind: 'context',
      });
    }
    i += 1;
  }

  return rows;
}

export function DiffCodeViewer({
  diff,
  viewMode,
}: {
  diff: string;
  viewMode: 'unified' | 'split';
}) {
  const splitRows = useMemo(
    () => (viewMode === 'split' ? parseUnifiedToSplitLines(diff) : []),
    [diff, viewMode],
  );

  if (!diff.trim()) {
    return (
      <div className="px-3 py-5 text-center text-[11px] text-[var(--text-muted)]">
        暂无文本差异内容
      </div>
    );
  }

  if (viewMode === 'split') {
    return (
      <div
        data-testid="diff-view-split"
        className="max-h-[380px] overflow-auto font-mono-code text-[10.5px] leading-relaxed"
      >
        <table className="w-full border-collapse">
          <tbody>
            {splitRows.map((row, idx) =>
              row.leftKind === 'hunk' ? (
                <tr
                  key={idx}
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--accent-indigo)',
                  }}
                >
                  <td colSpan={4} className="px-2 py-0.5 text-[10px]">
                    {row.leftText}
                  </td>
                </tr>
              ) : (
                <tr key={idx} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="w-8 select-none px-1.5 py-0.5 text-right text-[9.5px] text-[var(--text-muted)]">
                    {row.leftNum}
                  </td>
                  <td
                    className="w-1/2 whitespace-pre-wrap break-all px-2 py-0.5"
                    style={{
                      backgroundColor:
                        row.leftKind === 'del' ? 'var(--accent-rose-soft)' : 'transparent',
                      color:
                        row.leftKind === 'del' ? 'var(--accent-rose)' : 'var(--text-secondary)',
                    }}
                  >
                    {row.leftText}
                  </td>
                  <td
                    className="w-8 select-none px-1.5 py-0.5 text-right text-[9.5px] text-[var(--text-muted)]"
                    style={{ borderLeft: '1px solid var(--border-hairline)' }}
                  >
                    {row.rightNum}
                  </td>
                  <td
                    className="w-1/2 whitespace-pre-wrap break-all px-2 py-0.5"
                    style={{
                      backgroundColor:
                        row.rightKind === 'add' ? 'var(--accent-emerald-soft)' : 'transparent',
                      color:
                        row.rightKind === 'add'
                          ? 'var(--accent-emerald)'
                          : 'var(--text-secondary)',
                    }}
                  >
                    {row.rightText}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <pre
      data-testid="diff-view-unified"
      className="max-h-[380px] overflow-auto p-2.5 font-mono-code text-[10.5px] leading-relaxed"
    >
      {diff.split('\n').map((line, i) => {
        const isAdd = line.startsWith('+') && !line.startsWith('+++');
        const isDel = line.startsWith('-') && !line.startsWith('---');
        const isHunk = line.startsWith('@@');
        return (
          <div
            key={i}
            className="whitespace-pre-wrap break-all px-1"
            style={{
              backgroundColor: isAdd
                ? 'var(--accent-emerald-soft)'
                : isDel
                  ? 'var(--accent-rose-soft)'
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
    </pre>
  );
}

export interface DiffInspectorPanelProps {
  session: Session;
  git: GitStatusSummary | null;
  onRefresh: () => void;
  /** Optional externally injected checkpoints (used in tests or standalone preview). */
  checkpointsOverride?: SessionCheckpointRecord[];
}

/**
 * V5 `inspector.diff` slot implementation:
 * - Unified / Split diff toggle
 * - File tree filter + lazy per-file diff loading (`getGitFileDiff`)
 * - Checkpoint comparison selector (`fromCheckpoint` vs `toCheckpoint` / Working Tree)
 * - Single-file discard with inline confirmation
 * - Explicit Commit / Push (no `--force`) / Pull / Create PR (`gh` CLI) delivery bar
 * - Non-Git empty state with optional 1-click `git init`
 */
export function DiffInspectorPanel({
  session,
  git,
  onRefresh,
  checkpointsOverride,
}: DiffInspectorPanelProps) {
  const storeCheckpoints = useAppStore((s) => s.checkpointsBySession[session.id]);
  const focusedCheckpoint = useAppStore((s) => s.focusedCheckpointDiff);
  const refreshCheckpoints = useAppStore((s) => s.refreshCheckpoints);
  const initSessionGit = useAppStore((s) => s.initSessionGit);
  const openModal = useAppStore((s) => s.openModal);
  const pushToast = useAppStore((s) => s.pushToast);

  const checkpoints = checkpointsOverride ?? storeCheckpoints ?? [];

  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
  const [compareMode, setCompareMode] = useState<'workdir' | 'checkpoint'>('workdir');
  const [fromCheckpointId, setFromCheckpointId] = useState<string>('');
  const [toCheckpointId, setToCheckpointId] = useState<string>('__workdir__');
  const [fileFilter, setFileFilter] = useState('');
  const [selectedFile, setSelectedFile] = useState<{ path: string; staged: boolean } | null>(null);
  const [fileDiff, setFileDiff] = useState<GitFileDiffResult | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);

  const [checkpointDiff, setCheckpointDiff] = useState<{
    diff: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  } | null>(null);
  const [checkpointDiffLoading, setCheckpointDiffLoading] = useState(false);

  const [confirmDiscardPath, setConfirmDiscardPath] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [commitDrawerOpen, setCommitDrawerOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [prDrawerOpen, setPrDrawerOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');

  useEffect(() => {
    if (!checkpointsOverride) {
      void refreshCheckpoints(session.id);
    }
  }, [session.id, refreshCheckpoints, checkpointsOverride]);

  // Honor external "查看 Diff" click from a CheckpointTurnBadge
  useEffect(() => {
    if (focusedCheckpoint && focusedCheckpoint.sessionId === session.id) {
      setCompareMode('checkpoint');
      setFromCheckpointId(focusedCheckpoint.fromCheckpointId);
      setToCheckpointId(focusedCheckpoint.toCheckpointId ?? '__workdir__');
    }
  }, [focusedCheckpoint, session.id]);

  // Auto-select first changed file when git status updates in workdir mode
  const filteredChanges = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    return (git?.changes ?? []).filter((c) => !q || c.path.toLowerCase().includes(q));
  }, [git?.changes, fileFilter]);

  useEffect(() => {
    if (compareMode !== 'workdir') return;
    if (
      selectedFile &&
      filteredChanges.some((c) => c.path === selectedFile.path && c.staged === selectedFile.staged)
    ) {
      return;
    }
    const first = filteredChanges[0];
    setSelectedFile(first ? { path: first.path, staged: first.staged } : null);
  }, [compareMode, filteredChanges, selectedFile]);

  // Per-file lazy diff fetch (eliminates 120KB monolithic truncation!)
  useEffect(() => {
    if (compareMode !== 'workdir' || !selectedFile || !git?.isGitRepo) {
      setFileDiff(null);
      return;
    }
    let active = true;
    setFileDiffLoading(true);
    void daemonApi
      .getGitFileDiff(session.id, selectedFile.path, selectedFile.staged)
      .then((res) => {
        if (active) setFileDiff(res);
      })
      .catch(() => {
        if (active) setFileDiff(null);
      })
      .finally(() => {
        if (active) setFileDiffLoading(false);
      });
    return () => {
      active = false;
    };
  }, [compareMode, selectedFile, session.id, git?.isGitRepo, git?.changes]);

  // Checkpoint-to-checkpoint / checkpoint-to-workdir diff fetch
  useEffect(() => {
    if (compareMode !== 'checkpoint' || !fromCheckpointId) {
      setCheckpointDiff(null);
      return;
    }
    let active = true;
    setCheckpointDiffLoading(true);
    void daemonApi
      .diffCheckpoints(session.id, {
        fromCheckpointId,
        toCheckpointId: toCheckpointId === '__workdir__' ? undefined : toCheckpointId,
      })
      .then((res) => {
        if (active) setCheckpointDiff(res);
      })
      .catch((err) => {
        if (active) {
          setCheckpointDiff(null);
          pushToast({
            kind: 'error',
            title: '加载检查点 Diff 失败',
            body: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        if (active) setCheckpointDiffLoading(false);
      });
    return () => {
      active = false;
    };
  }, [compareMode, fromCheckpointId, toCheckpointId, session.id, pushToast]);

  const handleDiscardFile = async (filePath: string) => {
    setBusyAction(`discard:${filePath}`);
    try {
      await daemonApi.discardGitFile(session.id, filePath);
      setConfirmDiscardPath(null);
      onRefresh();
      pushToast({ kind: 'info', title: `已放弃改动：${filePath}` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '放弃改动失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    setBusyAction('commit');
    try {
      const res = await daemonApi.gitCommit(session.id, {
        message: commitMessage.trim(),
        stageAll: true,
      });
      setCommitMessage('');
      setCommitDrawerOpen(false);
      onRefresh();
      pushToast({ kind: 'success', title: res.result.message });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '提交失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePush = async () => {
    setBusyAction('push');
    try {
      const res = await daemonApi.gitPush(session.id, { setUpstream: true });
      onRefresh();
      pushToast({ kind: 'success', title: res.result.message });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '推送失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePull = async () => {
    setBusyAction('pull');
    try {
      const res = await daemonApi.gitPull(session.id, {});
      onRefresh();
      pushToast({ kind: 'success', title: res.result.message });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '拉取失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreatePr = async () => {
    if (!prTitle.trim()) return;
    setBusyAction('pr');
    try {
      const res = await daemonApi.gitCreatePr(session.id, {
        title: prTitle.trim(),
        body: prBody.trim(),
        draft: false,
      });
      setPrTitle('');
      setPrBody('');
      setPrDrawerOpen(false);
      pushToast({ kind: 'success', title: res.result.message, body: res.result.prUrl ?? undefined });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '创建 PR 失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  // Non-Git empty state with optional 1-click `git init`
  if (!git || !git.isGitRepo) {
    return (
      <div
        data-testid="diff-non-git-empty"
        className="space-y-3 rounded-xl px-4 py-6 text-center"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px dashed var(--border-hairline)',
        }}
      >
        <GitBranch size={20} className="mx-auto text-[var(--text-muted)]" />
        <div className="space-y-1">
          <p className="text-[12.5px] font-medium text-[var(--text-primary)]">
            当前目录尚未初始化 Git 仓库
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">
            初始化后可启用自动隐藏检查点、Diff 检视、Worktree 隔离与一键安全回滚。
          </p>
        </div>
        <button
          type="button"
          disabled={busyAction === 'init'}
          onClick={async () => {
            setBusyAction('init');
            try {
              await initSessionGit(session.id);
              onRefresh();
            } finally {
              setBusyAction(null);
            }
          }}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: 'var(--accent-indigo)' }}
        >
          {busyAction === 'init' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <GitBranch size={12} />
          )}
          <span>初始化 Git 仓库 (git init)</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header Row: branch + Unified/Split toggle + Worktrees + Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <GitBranch size={13.5} className="shrink-0 text-[var(--accent-indigo)]" />
          <span className="truncate font-mono-code font-medium text-[var(--text-primary)]">
            {git.branch || 'HEAD'}
          </span>
          {(git.ahead > 0 || git.behind > 0) && (
            <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
              ↑{git.ahead} ↓{git.behind}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <div
            className="inline-flex overflow-hidden rounded-lg"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <button
              type="button"
              aria-label="Unified Diff"
              aria-pressed={viewMode === 'unified'}
              onClick={() => setViewMode('unified')}
              className="inline-flex cursor-pointer items-center gap-1 px-2 py-1 text-[10.5px]"
              style={{
                backgroundColor: viewMode === 'unified' ? 'var(--bg-active)' : 'transparent',
                color:
                  viewMode === 'unified' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              }}
            >
              <Rows3 size={11} />
              <span>Unified</span>
            </button>
            <button
              type="button"
              aria-label="Split Diff"
              aria-pressed={viewMode === 'split'}
              onClick={() => setViewMode('split')}
              className="inline-flex cursor-pointer items-center gap-1 px-2 py-1 text-[10.5px]"
              style={{
                backgroundColor: viewMode === 'split' ? 'var(--bg-active)' : 'transparent',
                color: viewMode === 'split' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                borderLeft: '1px solid var(--border-hairline)',
              }}
            >
              <Columns2 size={11} />
              <span>Split</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => openModal('worktrees')}
            title="管理 Git Worktree 与合并预检"
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <FolderGit2 size={11.5} />
            <span>Worktree</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onRefresh();
              void refreshCheckpoints(session.id);
            }}
            title="刷新变更与检查点"
            className="cursor-pointer rounded-lg p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Mode Switcher: Working Tree vs Checkpoint Diff */}
      <div className="flex items-center gap-1.5 text-[11px]">
        <button
          type="button"
          onClick={() => setCompareMode('workdir')}
          className="inline-flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg py-1 font-medium"
          style={{
            backgroundColor: compareMode === 'workdir' ? 'var(--bg-active)' : 'var(--bg-surface)',
            color: compareMode === 'workdir' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
            border: `1px solid ${
              compareMode === 'workdir' ? 'var(--border-focus)' : 'var(--border-hairline)'
            }`,
          }}
        >
          <FileDiff size={11.5} />
          <span>工作区 ({git.changes.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setCompareMode('checkpoint');
            if (!fromCheckpointId && checkpoints[0]) {
              setFromCheckpointId(checkpoints[0].checkpointId);
            }
          }}
          className="inline-flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg py-1 font-medium"
          style={{
            backgroundColor:
              compareMode === 'checkpoint' ? 'var(--bg-active)' : 'var(--bg-surface)',
            color:
              compareMode === 'checkpoint' ? 'var(--accent-indigo)' : 'var(--text-secondary)',
            border: `1px solid ${
              compareMode === 'checkpoint' ? 'var(--border-focus)' : 'var(--border-hairline)'
            }`,
          }}
        >
          <History size={11.5} />
          <span>检查点对比 ({checkpoints.length})</span>
        </button>
      </div>

      {/* Explicit User Delivery Bar: Commit / Push / Pull / PR */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setCommitDrawerOpen((v) => !v);
            setPrDrawerOpen(false);
          }}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <GitCommitHorizontal size={11.5} />
          <span>提交</span>
        </button>
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => void handlePush()}
          title="推送当前分支到远端（严格禁止 --force）"
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <ArrowUpFromLine size={11.5} />
          <span>推送</span>
        </button>
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => void handlePull()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <ArrowDownToLine size={11.5} />
          <span>拉取</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setPrDrawerOpen((v) => !v);
            setCommitDrawerOpen(false);
          }}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <GitPullRequest size={11.5} />
          <span>创建 PR</span>
        </button>
      </div>

      {/* Inline Commit Form */}
      {commitDrawerOpen && (
        <div
          className="space-y-2 rounded-xl p-2.5"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-focus)',
          }}
        >
          <input
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="输入 Commit Message..."
            className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setCommitDrawerOpen(false)}
              className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!commitMessage.trim() || busyAction === 'commit'}
              onClick={() => void handleCommit()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {busyAction === 'commit' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Check size={11} />
              )}
              <span>确认提交</span>
            </button>
          </div>
        </div>
      )}

      {/* Inline PR Form */}
      {prDrawerOpen && (
        <div
          className="space-y-2 rounded-xl p-2.5"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-focus)',
          }}
        >
          <input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder="PR 标题..."
            className="w-full rounded-lg px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          />
          <textarea
            rows={2}
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            placeholder="PR 描述（可选）..."
            className="w-full resize-none rounded-lg px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setPrDrawerOpen(false)}
              className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!prTitle.trim() || busyAction === 'pr'}
              onClick={() => void handleCreatePr()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {busyAction === 'pr' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <GitPullRequest size={11} />
              )}
              <span>通过 gh 创建 PR</span>
            </button>
          </div>
        </div>
      )}

      {compareMode === 'workdir' ? (
        git.changes.length === 0 ? (
          <div
            className="rounded-xl px-4 py-6 text-center text-[11.5px] text-[var(--text-muted)]"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px dashed var(--border-hairline)',
            }}
          >
            工作区干净，暂无未提交改动。
          </div>
        ) : (
          <div className="space-y-2.5">
            {/* File Filter */}
            <div
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
              <input
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                placeholder="筛选变更文件..."
                className="w-full bg-transparent text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>

            {/* File Tree List */}
            <div
              className="max-h-[180px] overflow-y-auto rounded-xl"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {filteredChanges.map((c) => {
                const isSelected =
                  selectedFile?.path === c.path && selectedFile?.staged === c.staged;
                return (
                  <div
                    key={`${c.staged ? 's' : 'u'}-${c.path}`}
                    className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 text-[11px]"
                    style={{
                      backgroundColor: isSelected ? 'var(--bg-active)' : 'transparent',
                      borderBottom: '1px solid var(--border-hairline)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedFile({ path: c.path, staged: c.staged })}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                    >
                      <span
                        className="shrink-0 font-mono-code text-[10px] font-semibold uppercase"
                        style={{
                          color:
                            c.status === 'added' || c.status === 'untracked'
                              ? 'var(--accent-emerald)'
                              : c.status === 'deleted'
                                ? 'var(--accent-rose)'
                                : 'var(--accent-star)',
                        }}
                      >
                        {c.status[0]}
                      </span>
                      <span className="truncate font-mono-code text-[var(--text-primary)]">
                        {c.path}
                      </span>
                      {c.staged && (
                        <span className="shrink-0 rounded px-1 text-[9px] text-[var(--accent-indigo)]">
                          staged
                        </span>
                      )}
                    </button>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {(c.additions !== undefined || c.deletions !== undefined) && (
                        <span className="font-mono-code text-[9.5px]">
                          <span className="text-[var(--accent-emerald)]">+{c.additions ?? 0}</span>{' '}
                          <span className="text-[var(--accent-rose)]">-{c.deletions ?? 0}</span>
                        </span>
                      )}
                      {confirmDiscardPath === c.path ? (
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => void handleDiscardFile(c.path)}
                          className="cursor-pointer rounded px-1.5 py-0.5 text-[9.5px] font-medium text-white"
                          style={{ backgroundColor: 'var(--accent-rose)' }}
                        >
                          确认放弃
                        </button>
                      ) : (
                        <button
                          type="button"
                          title={`放弃 ${c.path} 的未提交改动`}
                          onClick={() => setConfirmDiscardPath(c.path)}
                          className="cursor-pointer rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-rose)]"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Per-File Lazy Diff Viewer */}
            {selectedFile && (
              <div
                className="overflow-hidden rounded-xl"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-[10.5px]"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    borderBottom: '1px solid var(--border-hairline)',
                  }}
                >
                  <span className="truncate font-mono-code text-[var(--text-primary)]">
                    {selectedFile.path}
                  </span>
                  {fileDiff && (
                    <span className="shrink-0 font-mono-code text-[10px] text-[var(--text-muted)]">
                      {fileDiff.totalBytes} B{fileDiff.truncated ? ' · truncated' : ''}
                    </span>
                  )}
                </div>
                {fileDiffLoading ? (
                  <div className="flex items-center justify-center gap-1.5 py-6 text-[11px] text-[var(--text-muted)]">
                    <Loader2 size={13} className="animate-spin" />
                    <span>按需加载单文件差异中...</span>
                  </div>
                ) : fileDiff?.binary ? (
                  <div className="px-3 py-5 text-center text-[11px] text-[var(--text-muted)]">
                    二进制文件，暂不展示文本 Diff。
                  </div>
                ) : (
                  <DiffCodeViewer diff={fileDiff?.diff ?? ''} viewMode={viewMode} />
                )}
              </div>
            )}
          </div>
        )
      ) : (
        /* Checkpoint Comparison Mode */
        <div className="space-y-2.5">
          {checkpoints.length === 0 ? (
            <div
              className="rounded-xl px-4 py-6 text-center text-[11.5px] text-[var(--text-muted)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px dashed var(--border-hairline)',
              }}
            >
              尚无检查点记录。每轮对话修改文件后会自动生成零污染隐藏检查点。
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <label className="space-y-1">
                  <span className="text-[10px] text-[var(--text-muted)]">起始检查点</span>
                  <select
                    aria-label="选择起始检查点"
                    value={fromCheckpointId}
                    onChange={(e) => setFromCheckpointId(e.target.value)}
                    className="w-full rounded-lg px-2 py-1 text-[11px] text-[var(--text-primary)]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    {checkpoints.map((c) => (
                      <option key={c.checkpointId} value={c.checkpointId}>
                        Turn #{c.turnSeq} ({c.phase}) · +{c.insertions}/-{c.deletions}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="text-[10px] text-[var(--text-muted)]">对比目标</span>
                  <select
                    aria-label="选择目标检查点"
                    value={toCheckpointId}
                    onChange={(e) => setToCheckpointId(e.target.value)}
                    className="w-full rounded-lg px-2 py-1 text-[11px] text-[var(--text-primary)]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <option value="__workdir__">当前工作区 (Working Tree)</option>
                    {checkpoints.map((c) => (
                      <option key={c.checkpointId} value={c.checkpointId}>
                        Turn #{c.turnSeq} ({c.phase})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div
                className="overflow-hidden rounded-xl"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                {checkpointDiff && (
                  <div
                    className="flex items-center justify-between px-3 py-1.5 text-[10.5px]"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      borderBottom: '1px solid var(--border-hairline)',
                    }}
                  >
                    <span className="text-[var(--text-secondary)]">
                      共 {checkpointDiff.filesChanged} 个文件变更
                    </span>
                    <span className="font-mono-code text-[10px]">
                      <span className="text-[var(--accent-emerald)]">
                        +{checkpointDiff.insertions}
                      </span>{' '}
                      <span className="text-[var(--accent-rose)]">-{checkpointDiff.deletions}</span>
                    </span>
                  </div>
                )}
                {checkpointDiffLoading ? (
                  <div className="flex items-center justify-center gap-1.5 py-6 text-[11px] text-[var(--text-muted)]">
                    <Loader2 size={13} className="animate-spin" />
                    <span>计算检查点差异中...</span>
                  </div>
                ) : (
                  <DiffCodeViewer diff={checkpointDiff?.diff ?? ''} viewMode={viewMode} />
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
