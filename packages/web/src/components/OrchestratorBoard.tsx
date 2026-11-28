import type {
  ApprovalRequest,
  DelegateSubagentRequest,
  GitDryRunMergeResult,
  HarnessInfo,
  OrchestratorBoardResponse,
  Session,
  SubagentDiffStat,
  SubagentIsolation,
  SubagentRunRecord,
} from '@harnessmate/protocol';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitMerge,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { resolveHarnessMeta } from '../lib/harness-meta';
import type { ExtensionTurnBlock } from '../lib/work-groups';
import { useAppStore } from '../stores/app-store';

const STATUS_BADGE: Record<
  SubagentRunRecord['status'],
  { label: string; color: string; bg: string }
> = {
  queued: { label: '排队中', color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' },
  running: { label: '运行中', color: 'var(--accent-indigo)', bg: 'var(--accent-indigo-soft)' },
  awaiting_approval: { label: '等待审批', color: 'var(--accent-star)', bg: 'var(--accent-star-soft)' },
  completed: { label: '已完成', color: 'var(--accent-emerald)', bg: 'var(--accent-emerald-soft)' },
  failed: { label: '失败', color: 'var(--accent-rose)', bg: 'var(--accent-rose-soft)' },
  stopped: { label: '已停止', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
};

const PERMISSION_LABEL: Record<string, string> = {
  plan: '只读规划',
  manual: '受控审批',
  accept_edits: '自动编辑',
  auto: '全自动',
};

function formatDiffStat(diffStat?: SubagentDiffStat | null): string | null {
  if (!diffStat) return null;
  if (diffStat.filesChanged === 0 && diffStat.insertions === 0 && diffStat.deletions === 0) {
    return '0 文件变更';
  }
  return `+${diffStat.insertions} -${diffStat.deletions} · ${diffStat.filesChanged} 文件`;
}

// ── 1. Parallel Execution Board (`inspector.tabs`, key: `orchestrator-board`) ──

export interface ParallelExecutionBoardViewProps {
  parentSession: Session;
  board: OrchestratorBoardResponse | null;
  harnesses: readonly HarnessInfo[];
  pendingApprovals: readonly ApprovalRequest[];
  onRefresh: () => void;
  onDelegate?: (req: DelegateSubagentRequest) => Promise<void> | void;
  onOpenChildSession: (childSessionId: string) => void;
  onOpenApproval: (childSessionId: string) => void;
  onStopSubagent: (subagentId: string) => void;
  onReviewMerge: (subagent: SubagentRunRecord) => void;
  onCleanupWorktree?: (subagentId: string) => void;
}

export function ParallelExecutionBoardView({
  parentSession,
  board,
  harnesses,
  pendingApprovals,
  onRefresh,
  onDelegate,
  onOpenChildSession,
  onOpenApproval,
  onStopSubagent,
  onReviewMerge,
  onCleanupWorktree,
}: ParallelExecutionBoardViewProps) {
  const [showDelegateForm, setShowDelegateForm] = useState(false);
  const [targetInstanceId, setTargetInstanceId] = useState(
    () => harnesses[0]?.id ?? parentSession.harnessId,
  );
  const [roleTitle, setRoleTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isolation, setIsolation] = useState<SubagentIsolation>('worktree_write');
  const [submitting, setSubmitting] = useState(false);

  const subagents = board?.subagents ?? [];
  const activeCount = board?.activeCount ?? 0;
  const maxConcurrent = board?.maxConcurrent ?? 4;
  const maxDepth = board?.maxDepth ?? 1;
  const currentDepth = board?.currentDepth ?? 0;
  const quotaReached = activeCount >= maxConcurrent;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onDelegate || !roleTitle.trim() || !prompt.trim() || !targetInstanceId) return;
    setSubmitting(true);
    try {
      await onDelegate({
        targetInstanceId,
        roleTitle: roleTitle.trim(),
        prompt: prompt.trim(),
        isolation,
      });
      setRoleTitle('');
      setPrompt('');
      setShowDelegateForm(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      data-testid="orchestrator-board"
      className="space-y-3 text-[12px] text-[var(--text-secondary)]"
    >
      {/* Header & Concurrency Pool Quota */}
      <div
        className="rounded-xl p-3"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Layers size={14} style={{ color: 'var(--accent-indigo)' }} className="shrink-0" />
            <span className="truncate font-semibold text-[var(--text-primary)]">
              并行编排看板
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              data-testid="orchestrator-quota"
              className="rounded-full px-2 py-0.5 font-mono-code text-[10.5px] font-medium"
              style={{
                backgroundColor: quotaReached
                  ? 'var(--accent-rose-soft)'
                  : 'var(--accent-indigo-soft)',
                color: quotaReached ? 'var(--accent-rose)' : 'var(--accent-indigo)',
              }}
            >
              {activeCount} / {maxConcurrent} 运行中
            </span>
            <button
              type="button"
              aria-label="刷新并行子任务"
              onClick={onRefresh}
              className="cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            >
              <RefreshCw size={12.5} />
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
          <span>
            父会话：<strong className="text-[var(--text-secondary)]">{parentSession.title}</strong>
          </span>
          <span className="font-mono-code text-[10.5px]">
            深度 {currentDepth}/{maxDepth} · 权限封顶 {PERMISSION_LABEL[parentSession.permissionMode] ?? parentSession.permissionMode}
          </span>
        </div>
        {onDelegate && (
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={quotaReached || currentDepth >= maxDepth}
              onClick={() => setShowDelegateForm((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                backgroundColor: 'var(--accent-indigo-soft)',
                color: 'var(--accent-indigo)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <Play size={11} />
              {showDelegateForm ? '收起派生表单' : '派生并行子任务'}
            </button>
            {quotaReached && (
              <span className="text-[10.5px]" style={{ color: 'var(--accent-rose)' }}>
                已达并发上限，请等待或停止子任务
              </span>
            )}
          </div>
        )}
      </div>

      {/* Optional Quick Delegation Form */}
      {showDelegateForm && onDelegate && (
        <form
          onSubmit={handleSubmit}
          className="space-y-2 rounded-xl p-3"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[11px]">
              <span className="text-[var(--text-muted)]">目标引擎实例</span>
              <select
                value={targetInstanceId}
                onChange={(e) => setTargetInstanceId(e.target.value)}
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11.5px] text-[var(--text-primary)]"
              >
                {harnesses.map((h) => {
                  const meta = resolveHarnessMeta({ harness: h }, harnesses);
                  return (
                    <option key={h.id} value={h.id}>
                      {meta.shortLabel} ({h.id})
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="space-y-1 text-[11px]">
              <span className="text-[var(--text-muted)]">隔离模式</span>
              <select
                value={isolation}
                onChange={(e) => setIsolation(e.target.value as SubagentIsolation)}
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11.5px] text-[var(--text-primary)]"
              >
                <option value="worktree_write">Worktree 隔离写入</option>
                <option value="read_only">只读调研 / 审查</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-[11px]">
            <span className="text-[var(--text-muted)]">子任务角色标题</span>
            <input
              type="text"
              required
              placeholder="如：后端 API 实现 / 单元测试编写 / 安全审查"
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)]"
            />
          </label>
          <label className="block space-y-1 text-[11px]">
            <span className="text-[var(--text-muted)]">子任务目标指令</span>
            <textarea
              required
              rows={3}
              placeholder="明确描述该子任务的边界与交付物..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)]"
            />
          </label>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setShowDelegateForm(false)}
              className="cursor-pointer rounded-lg px-2.5 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting || !roleTitle.trim() || !prompt.trim()}
              className="cursor-pointer rounded-lg px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {submitting ? '派生中…' : '立即派生'}
            </button>
          </div>
        </form>
      )}

      {/* Subagent Cards */}
      {subagents.length === 0 ? (
        <div
          className="rounded-xl p-4 text-center text-[11.5px] text-[var(--text-muted)]"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px dashed var(--border-hairline)',
          }}
        >
          当前会话暂无并行子任务。可通过上方按钮或主控模型调用{' '}
          <code className="font-mono-code text-[10.5px]">hm_delegate_task</code> 启动多引擎并行协作。
        </div>
      ) : (
        <div className="space-y-2.5">
          {subagents.map((sub) => {
            const harnessMeta = resolveHarnessMeta(
              { harnessId: sub.targetInstanceId, harnessKind: sub.targetDriverId },
              harnesses,
            );
            const statusStyle = STATUS_BADGE[sub.status] ?? STATUS_BADGE.stopped;
            const childPendingApprovals = pendingApprovals.filter(
              (a) => a.sessionId === sub.childSessionId && a.status === 'pending',
            );
            const blockingCount = Math.max(
              childPendingApprovals.length,
              sub.pendingApprovalCount ?? 0,
            );
            const isActive =
              sub.status === 'queued' ||
              sub.status === 'running' ||
              sub.status === 'awaiting_approval';
            const diffText = formatDiffStat(sub.diffStat);
            const canMergeBack =
              sub.isolation === 'worktree_write' &&
              Boolean(sub.branchName) &&
              !isActive &&
              !sub.mergedAt;

            return (
              <article
                key={sub.subagentId}
                data-testid={`subagent-card-${sub.subagentId}`}
                className="space-y-2 rounded-xl p-3"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border:
                    sub.status === 'awaiting_approval'
                      ? '1px solid var(--accent-star)'
                      : '1px solid var(--border-hairline)',
                }}
              >
                {/* Top row: Engine badge (zero-hardcoded) + Role + Status */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        data-testid={`subagent-engine-badge-${sub.subagentId}`}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono-code text-[10px] font-semibold"
                        style={{
                          backgroundColor: harnessMeta.softBg,
                          color: harnessMeta.accentColor,
                        }}
                      >
                        {harnessMeta.shortLabel}
                      </span>
                      <span className="truncate font-semibold text-[var(--text-primary)]">
                        {sub.roleTitle}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
                      <span className="font-mono-code">{sub.targetInstanceId}</span>
                      <span>·</span>
                      <span>{sub.isolation === 'worktree_write' ? 'Worktree 隔离' : '只读模式'}</span>
                      <span>·</span>
                      <span>权限: {PERMISSION_LABEL[sub.effectiveApprovalPolicy] ?? sub.effectiveApprovalPolicy}</span>
                    </div>
                  </div>
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                    style={{ backgroundColor: statusStyle.bg, color: statusStyle.color }}
                  >
                    {statusStyle.label}
                  </span>
                </div>

                {/* Branch & Diffstat */}
                {(sub.branchName || diffText) && (
                  <div className="flex flex-wrap items-center gap-2 font-mono-code text-[10.5px]">
                    {sub.branchName && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                        style={{
                          backgroundColor: 'var(--bg-surface)',
                          border: '1px solid var(--border-hairline)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <GitBranch size={11} />
                        {sub.branchName}
                      </span>
                    )}
                    {diffText && (
                      <span className="text-[var(--text-secondary)]">{diffText}</span>
                    )}
                    {sub.mergedAt && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                        style={{
                          backgroundColor: 'var(--accent-emerald-soft)',
                          color: 'var(--accent-emerald)',
                        }}
                      >
                        <CheckCircle2 size={11} />
                        已合回 {sub.mergedIntoBranch ?? sub.baseBranch ?? 'main'}
                      </span>
                    )}
                  </div>
                )}

                {/* Summary or Error */}
                {(sub.summary || sub.error) && (
                  <p
                    className="line-clamp-3 rounded-lg px-2 py-1.5 text-[11px]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      color: sub.error && !sub.summary ? 'var(--accent-rose)' : 'var(--text-secondary)',
                    }}
                  >
                    {sub.summary || sub.error}
                  </p>
                )}

                {/* Action Bar */}
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {(sub.status === 'awaiting_approval' || blockingCount > 0) && (
                    <button
                      type="button"
                      data-testid={`subagent-approval-btn-${sub.subagentId}`}
                      onClick={() => onOpenApproval(sub.childSessionId)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--accent-star-soft)',
                        color: 'var(--accent-star)',
                        border: '1px solid var(--accent-star)',
                      }}
                    >
                      <ShieldAlert size={11.5} />
                      前往审批{blockingCount > 0 ? ` (${blockingCount})` : ''}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onOpenChildSession(sub.childSessionId)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  >
                    <ExternalLink size={11} />
                    打开子会话
                  </button>

                  {isActive && (
                    <button
                      type="button"
                      data-testid={`subagent-stop-btn-${sub.subagentId}`}
                      onClick={() => onStopSubagent(sub.subagentId)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--accent-rose-soft)',
                        color: 'var(--accent-rose)',
                      }}
                    >
                      <Square size={10.5} />
                      停止
                    </button>
                  )}

                  {canMergeBack && (
                    <button
                      type="button"
                      data-testid={`subagent-merge-btn-${sub.subagentId}`}
                      onClick={() => onReviewMerge(sub)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--accent-emerald-soft)',
                        color: 'var(--accent-emerald)',
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      <GitMerge size={11.5} />
                      预检冲突并合回
                    </button>
                  )}

                  {sub.mergedAt && sub.worktreePath && !sub.worktreeCleaned && onCleanupWorktree && (
                    <button
                      type="button"
                      onClick={() => onCleanupWorktree(sub.subagentId)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                    >
                      <Trash2 size={11} />
                      清理 Worktree
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ParallelExecutionBoard({ session }: { session: Session }) {
  const {
    harnesses,
    orchestratorBoardBySession,
    refreshOrchestratorBoard,
    delegateSubagent,
    selectSession,
    stopSubagent,
    openSubagentMergeReview,
    cleanupSubagentWorktree,
  } = useAppStore();

  const board = orchestratorBoardBySession[session.id] ?? null;

  useEffect(() => {
    void refreshOrchestratorBoard(session.id);
  }, [session.id, refreshOrchestratorBoard]);

  return (
    <ParallelExecutionBoardView
      parentSession={session}
      board={board}
      harnesses={harnesses}
      pendingApprovals={[]}
      onRefresh={() => void refreshOrchestratorBoard(session.id)}
      onDelegate={async (req) => {
        await delegateSubagent(session.id, req);
      }}
      onOpenChildSession={(childId) => void selectSession(childId)}
      onOpenApproval={(childId) => void selectSession(childId)}
      onStopSubagent={(subagentId) => void stopSubagent(subagentId, session.id)}
      onReviewMerge={(sub) => void openSubagentMergeReview(sub)}
      onCleanupWorktree={(subagentId) =>
        void cleanupSubagentWorktree(subagentId, session.id, { force: true })
      }
    />
  );
}

// ── 2. Cohort Summary Chat Block Card (`chat.block`, key: `ext:orchestrator.cohort`) ──

export interface CohortBlockPayload {
  cohortId?: string;
  parentSessionId?: string;
  total?: number;
  completedCount?: number;
  failedCount?: number;
  stoppedCount?: number;
  runningCount?: number;
  subagents?: Array<Partial<SubagentRunRecord> & { subagentId: string }>;
}

export function OrchestratorCohortBlockCard({
  block,
  harnesses,
  onReviewMerge,
  onOpenChildSession,
}: {
  block: ExtensionTurnBlock;
  harnesses: readonly HarnessInfo[];
  onReviewMerge?: (subagent: SubagentRunRecord) => void;
  onOpenChildSession?: (childSessionId: string) => void;
}) {
  const payload = (block.payload ?? {}) as CohortBlockPayload;
  const subagents = Array.isArray(payload.subagents) ? payload.subagents : [];
  const total = payload.total ?? subagents.length;
  const completedCount =
    payload.completedCount ?? subagents.filter((s) => s.status === 'completed').length;
  const failedCount =
    payload.failedCount ?? subagents.filter((s) => s.status === 'failed').length;

  return (
    <div
      data-testid="orchestrator-cohort-card"
      className="my-2 overflow-hidden rounded-xl text-[12px]"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
      }}
    >
      {/* Header */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex items-center gap-1.5">
          <Layers size={13.5} style={{ color: 'var(--accent-indigo)' }} />
          <span className="font-semibold text-[var(--text-primary)]">
            {block.title || '并行协作批次摘要'}
          </span>
          {payload.cohortId && (
            <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
              {payload.cohortId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span
            className="rounded-full px-2 py-0.5 font-medium"
            style={{
              backgroundColor:
                failedCount > 0 ? 'var(--accent-star-soft)' : 'var(--accent-emerald-soft)',
              color: failedCount > 0 ? 'var(--accent-star)' : 'var(--accent-emerald)',
            }}
          >
            {completedCount} / {total} 完成
          </span>
        </div>
      </div>

      {/* Structured Cohort Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[11.5px]">
          <thead>
            <tr
              className="text-[10.5px] text-[var(--text-muted)]"
              style={{ borderBottom: '1px solid var(--border-hairline)' }}
            >
              <th className="px-3 py-1.5 font-medium">角色 / 引擎</th>
              <th className="px-3 py-1.5 font-medium">状态</th>
              <th className="px-3 py-1.5 font-medium">分支与 DiffStat</th>
              <th className="px-3 py-1.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {subagents.map((raw) => {
              const status = (raw.status ?? 'completed') as SubagentRunRecord['status'];
              const st = STATUS_BADGE[status] ?? STATUS_BADGE.stopped;
              const harnessMeta = resolveHarnessMeta(
                { harnessId: raw.targetInstanceId, harnessKind: raw.targetDriverId },
                harnesses,
              );
              const diffText = formatDiffStat(raw.diffStat ?? null);
              const isWorktreeMergeable =
                raw.isolation === 'worktree_write' &&
                Boolean(raw.branchName) &&
                !raw.mergedAt &&
                status !== 'running' &&
                status !== 'queued' &&
                status !== 'awaiting_approval';

              const fullRecord: SubagentRunRecord = {
                subagentId: raw.subagentId,
                cohortId: payload.cohortId ?? raw.cohortId ?? '',
                parentSessionId: payload.parentSessionId ?? raw.parentSessionId ?? '',
                childSessionId: raw.childSessionId ?? '',
                targetInstanceId: raw.targetInstanceId ?? '',
                targetDriverId: raw.targetDriverId,
                roleTitle: raw.roleTitle ?? raw.subagentId,
                prompt: raw.prompt ?? '',
                isolation: raw.isolation ?? 'read_only',
                worktreePath: raw.worktreePath ?? null,
                branchName: raw.branchName ?? null,
                baseBranch: raw.baseBranch ?? null,
                effectiveApprovalPolicy: raw.effectiveApprovalPolicy ?? 'manual',
                depth: raw.depth ?? 1,
                timeoutMs: raw.timeoutMs ?? 900_000,
                failFast: Boolean(raw.failFast),
                status,
                diffStat: raw.diffStat ?? null,
                summary: raw.summary ?? null,
                error: raw.error ?? null,
                mergedAt: raw.mergedAt ?? null,
                mergedIntoBranch: raw.mergedIntoBranch ?? null,
                worktreeCleaned: Boolean(raw.worktreeCleaned),
                createdAt: raw.createdAt ?? Date.now(),
                finishedAt: raw.finishedAt ?? null,
              };

              return (
                <tr
                  key={raw.subagentId}
                  style={{ borderBottom: '1px solid var(--border-hairline)' }}
                >
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="rounded px-1.5 py-0.5 font-mono-code text-[10px] font-semibold"
                        style={{
                          backgroundColor: harnessMeta.softBg,
                          color: harnessMeta.accentColor,
                        }}
                      >
                        {harnessMeta.shortLabel}
                      </span>
                      <span className="font-medium text-[var(--text-primary)]">
                        {raw.roleTitle ?? raw.subagentId}
                      </span>
                    </div>
                    {raw.summary && (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-muted)]">
                        {raw.summary}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                      style={{ backgroundColor: st.bg, color: st.color }}
                    >
                      {st.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top font-mono-code text-[10.5px]">
                    {raw.branchName ? (
                      <div className="space-y-0.5">
                        <div className="text-[var(--text-primary)]">{raw.branchName}</div>
                        {diffText && <div className="text-[var(--text-muted)]">{diffText}</div>}
                      </div>
                    ) : (
                      <span className="text-[var(--text-muted)]">read_only</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right align-top">
                    <div className="inline-flex flex-wrap justify-end gap-1.5">
                      {raw.mergedAt ? (
                        <span
                          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px]"
                          style={{
                            backgroundColor: 'var(--accent-emerald-soft)',
                            color: 'var(--accent-emerald)',
                          }}
                        >
                          <CheckCircle2 size={11} />
                          已合回
                        </span>
                      ) : (
                        isWorktreeMergeable &&
                        onReviewMerge && (
                          <button
                            type="button"
                            data-testid={`cohort-merge-btn-${raw.subagentId}`}
                            onClick={() => onReviewMerge(fullRecord)}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium"
                            style={{
                              backgroundColor: 'var(--accent-indigo-soft)',
                              color: 'var(--accent-indigo)',
                            }}
                          >
                            <GitMerge size={11.5} />
                            预检冲突并合回
                          </button>
                        )
                      )}
                      {raw.childSessionId && onOpenChildSession && (
                        <button
                          type="button"
                          onClick={() => onOpenChildSession(raw.childSessionId!)}
                          className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                        >
                          查看
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 3. Merge-Back Conflict Review Modal ─────────────────────────────────

export interface MergeBackReviewModalViewProps {
  subagent: SubagentRunRecord;
  dryRun: GitDryRunMergeResult | null;
  diffStat: SubagentDiffStat | null;
  harnesses: readonly HarnessInfo[];
  loading: boolean;
  merging?: boolean;
  error: string | null;
  onConfirmMerge: (opts: { cleanupWorktree: boolean; deleteBranch: boolean }) => void;
  onClose: () => void;
}

export function MergeBackReviewModalView({
  subagent,
  dryRun,
  diffStat,
  harnesses,
  loading,
  merging = false,
  error,
  onConfirmMerge,
  onClose,
}: MergeBackReviewModalViewProps) {
  const [cleanupWorktree, setCleanupWorktree] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);

  const harnessMeta = resolveHarnessMeta(
    { harnessId: subagent.targetInstanceId, harnessKind: subagent.targetDriverId },
    harnesses,
  );
  const hasConflicts = Boolean(dryRun?.hasConflicts);
  const unsupported = dryRun !== null && !dryRun.supported;
  const canConfirm = !loading && !merging && dryRun !== null && dryRun.supported && !hasConflicts;
  const diffText = formatDiffStat(diffStat ?? subagent.diffStat);

  return (
    <div data-testid="merge-back-review-modal" className="flex flex-col">
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="flex items-center gap-2">
          <GitMerge size={16} style={{ color: 'var(--accent-indigo)' }} />
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
              Merge-Back 冲突预检与合回审查
            </h2>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
              <span
                className="mr-1.5 inline-block rounded px-1.5 py-0.5 font-mono-code text-[10px] font-semibold"
                style={{ backgroundColor: harnessMeta.softBg, color: harnessMeta.accentColor }}
              >
                {harnessMeta.shortLabel}
              </span>
              {subagent.roleTitle}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="关闭弹窗"
          onClick={onClose}
          className="cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="space-y-4 p-5 text-[12.5px]">
        {/* Branch Mapping */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 font-mono-code text-[11.5px]"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-1.5 text-[var(--text-primary)]">
            <GitBranch size={13} />
            <span>{subagent.branchName}</span>
            <span className="text-[var(--text-muted)]">→</span>
            <span>{dryRun?.baseBranch ?? subagent.baseBranch ?? 'main'}</span>
          </div>
          {diffText && <span className="text-[var(--text-secondary)]">{diffText}</span>}
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex items-center gap-2 rounded-xl p-4 text-[var(--text-secondary)]">
            <Loader2 size={15} className="animate-spin" />
            正在执行无副作用 git merge-tree --write-tree 冲突预检…
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            className="flex items-start gap-2 rounded-xl p-3 text-[12px]"
            style={{
              backgroundColor: 'var(--accent-rose-soft)',
              color: 'var(--accent-rose)',
              border: '1px solid var(--accent-rose)',
            }}
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Dry-Run Result */}
        {!loading && dryRun && (
          <>
            {hasConflicts ? (
              <div
                data-testid="merge-conflict-banner"
                className="space-y-2.5 rounded-xl p-3.5"
                style={{
                  backgroundColor: 'var(--accent-rose-soft)',
                  border: '1px solid var(--accent-rose)',
                }}
              >
                <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--accent-rose)' }}>
                  <AlertTriangle size={15} />
                  <span>
                    检测到 {dryRun.conflictFiles.length} 个合并冲突，已阻断盲目合回（主工作区未受任何修改）
                  </span>
                </div>
                <ul className="ml-5 list-disc space-y-1 font-mono-code text-[11.5px] text-[var(--text-primary)]">
                  {dryRun.conflictFiles.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <p className="text-[11.5px] text-[var(--text-secondary)]">
                  请在隔离 Worktree 分支 <code className="font-mono-code">{subagent.branchName}</code>{' '}
                  中变基/解决上述冲突文件，或交回主控引擎处理后再重新预检。
                </p>
              </div>
            ) : unsupported ? (
              <div
                className="rounded-xl p-3.5 text-[12px]"
                style={{
                  backgroundColor: 'var(--accent-star-soft)',
                  color: 'var(--accent-star)',
                  border: '1px solid var(--accent-star)',
                }}
              >
                {dryRun.message}
              </div>
            ) : (
              <div
                data-testid="merge-clean-banner"
                className="space-y-2 rounded-xl p-3.5"
                style={{
                  backgroundColor: 'var(--accent-emerald-soft)',
                  border: '1px solid var(--accent-emerald)',
                }}
              >
                <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--accent-emerald)' }}>
                  <CheckCircle2 size={15} />
                  <span>预检通过：{dryRun.message}</span>
                </div>
                {diffStat && diffStat.changedFiles.length > 0 && (
                  <ul className="ml-5 list-disc space-y-0.5 font-mono-code text-[11px] text-[var(--text-primary)]">
                    {diffStat.changedFiles.slice(0, 15).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {diffStat.changedFiles.length > 15 && (
                      <li className="text-[var(--text-muted)]">
                        … 等共 {diffStat.changedFiles.length} 个文件
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}

            {/* Cleanup Options */}
            {!hasConflicts && !unsupported && (
              <div className="space-y-2 rounded-xl border border-[var(--border-hairline)] p-3">
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-primary)]">
                  <input
                    type="checkbox"
                    data-testid="merge-cleanup-worktree-checkbox"
                    checked={cleanupWorktree}
                    onChange={(e) => {
                      setCleanupWorktree(e.target.checked);
                      if (!e.target.checked) setDeleteBranch(false);
                    }}
                  />
                  <span>合并后清理 Worktree</span>
                </label>
                {cleanupWorktree && (
                  <label className="ml-5 flex cursor-pointer items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={deleteBranch}
                      onChange={(e) => setDeleteBranch(e.target.checked)}
                    />
                    <span>同时删除已合并的子任务临时分支 ({subagent.branchName})</span>
                  </label>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-end gap-2 px-5 py-3.5"
        style={{ borderTop: '1px solid var(--border-hairline)' }}
      >
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-xl border border-[var(--border-hairline)] px-3.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="merge-confirm-btn"
          disabled={!canConfirm}
          onClick={() => onConfirmMerge({ cleanupWorktree, deleteBranch })}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            backgroundColor: hasConflicts ? 'var(--accent-rose)' : 'var(--accent-emerald)',
          }}
        >
          <GitMerge size={13.5} />
          {merging ? '正在合回…' : hasConflicts ? '存在冲突 · 禁止盲目合回' : '确认合回主分支'}
        </button>
      </div>
    </div>
  );
}

export function MergeBackReviewModal({ onClose }: { onClose: () => void }) {
  const {
    harnesses,
    mergeBackReviewTarget,
    confirmSubagentMergeBack,
    closeSubagentMergeReview,
  } = useAppStore();
  const [merging, setMerging] = useState(false);

  if (!mergeBackReviewTarget) return null;

  const handleClose = () => {
    closeSubagentMergeReview();
    onClose();
  };

  return (
    <MergeBackReviewModalView
      subagent={mergeBackReviewTarget.subagent}
      dryRun={mergeBackReviewTarget.dryRun}
      diffStat={mergeBackReviewTarget.diffStat}
      harnesses={harnesses}
      loading={mergeBackReviewTarget.loading}
      merging={merging}
      error={mergeBackReviewTarget.error}
      onClose={handleClose}
      onConfirmMerge={async ({ cleanupWorktree, deleteBranch }) => {
        setMerging(true);
        try {
          await confirmSubagentMergeBack(mergeBackReviewTarget.subagent.subagentId, {
            baseBranch: mergeBackReviewTarget.dryRun?.baseBranch,
            confirmMerge: true,
            cleanupWorktree,
            deleteBranch,
          });
        } finally {
          setMerging(false);
        }
      }}
    />
  );
}
