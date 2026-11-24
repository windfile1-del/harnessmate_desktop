import type {
  CheckpointRevertMode,
  CheckpointRevertResult,
  Session,
} from '@harnessmate/protocol';
import {
  AlertTriangle,
  FileDiff,
  GitBranch,
  History,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { TurnBlock } from '../lib/work-groups';

type CheckpointMarkerBlock = Extract<TurnBlock, { type: 'checkpoint_marker' }>;

export interface RevertCheckpointDialogProps {
  open: boolean;
  turnSeq: number;
  checkpointId?: string;
  harnessLabel: string;
  supportsNativeRollback: boolean;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: (mode: CheckpointRevertMode) => Promise<void> | void;
}

/**
 * Double-confirm revert guard dialog that honestly declares whether the active harness
 * supports native conversation rollback (never silently faking conversation rollback)
 * and informs the user that a `pre_revert` protective backup is automatically saved.
 */
export function RevertCheckpointDialog({
  open,
  turnSeq,
  checkpointId,
  harnessLabel,
  supportsNativeRollback,
  filesChanged,
  insertions,
  deletions,
  submitting = false,
  onCancel,
  onConfirm,
}: RevertCheckpointDialogProps) {
  const defaultMode: CheckpointRevertMode = supportsNativeRollback
    ? 'native_and_files'
    : 'files_only';
  const [selectedMode, setSelectedMode] = useState<CheckpointRevertMode>(defaultMode);
  const [confirmed, setConfirmed] = useState(false);

  if (!open) return null;

  const effectiveMode =
    !supportsNativeRollback && selectedMode === 'native_and_files' ? 'files_only' : selectedMode;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="确认回滚到检查点"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(4, 6, 12, 0.64)', backdropFilter: 'blur(6px)' }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-2xl"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-strong)',
          boxShadow: 'var(--shadow-float)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-start justify-between gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid var(--border-hairline)' }}
        >
          <div className="flex items-start gap-2.5">
            <div
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                color: 'var(--accent-star)',
              }}
            >
              <RotateCcw size={16} />
            </div>
            <div>
              <h3 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                确认回滚到 Turn #{turnSeq} 之前
              </h3>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                {checkpointId ? `检查点 ${checkpointId}` : `Turn #${turnSeq}`}
                {filesChanged !== undefined &&
                  ` · 涉及 ${filesChanged} 个文件 (+${insertions ?? 0} / -${deletions ?? 0})`}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭回滚弹窗"
            onClick={onCancel}
            className="cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-3.5 p-5 text-[12px]">
          {/* Honest capability disclosure */}
          <div
            className="rounded-xl p-3"
            style={{
              backgroundColor: supportsNativeRollback
                ? 'var(--accent-emerald-soft)'
                : 'var(--accent-star-soft)',
              border: `1px solid ${
                supportsNativeRollback
                  ? 'color-mix(in srgb, var(--accent-emerald) 35%, transparent)'
                  : 'color-mix(in srgb, var(--accent-star) 35%, transparent)'
              }`,
            }}
          >
            <div className="flex items-start gap-2">
              {supportsNativeRollback ? (
                <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[var(--accent-emerald)]" />
              ) : (
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--accent-star)]" />
              )}
              <div className="space-y-1">
                <p className="font-medium text-[var(--text-primary)]">
                  {supportsNativeRollback
                    ? `当前驱动 (${harnessLabel}) 支持原生对话回滚`
                    : `当前驱动 (${harnessLabel}) 不支持原生对话回滚`}
                </p>
                <p className="text-[11.5px] text-[var(--text-secondary)]">
                  {supportsNativeRollback
                    ? '系统将严格遵循“对话先回滚、文件后还原”守卫：若原生对话回滚失败，磁盘文件将保持 100% 不变。'
                    : 'HarnessMate 不会静默伪造对话回滚。请明确选择仅还原工作区文件，或还原文件并重置原生会话绑定开启新分支续跑。'}
                </p>
              </div>
            </div>
          </div>

          {/* Revert mode radio choices */}
          <div className="space-y-2">
            <label
              className={`flex cursor-pointer items-start gap-2.5 rounded-xl p-3 transition-colors ${
                !supportsNativeRollback ? 'cursor-not-allowed opacity-50' : ''
              }`}
              style={{
                backgroundColor:
                  effectiveMode === 'native_and_files' ? 'var(--bg-active)' : 'var(--bg-elevated)',
                border: `1px solid ${
                  effectiveMode === 'native_and_files'
                    ? 'var(--border-focus)'
                    : 'var(--border-hairline)'
                }`,
              }}
            >
              <input
                type="radio"
                name="revert-mode"
                value="native_and_files"
                disabled={!supportsNativeRollback}
                checked={effectiveMode === 'native_and_files'}
                onChange={() => setSelectedMode('native_and_files')}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium text-[var(--text-primary)]">
                  原生对话与文件同步回滚 (native_and_files)
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {supportsNativeRollback
                    ? '先通知 CLI 驱动回滚对话上下文，成功后再精准还原工作区文件。'
                    : '仅支持原生回滚的引擎（如 Codex）可用。'}
                </div>
              </div>
            </label>

            <label
              className="flex cursor-pointer items-start gap-2.5 rounded-xl p-3 transition-colors"
              style={{
                backgroundColor:
                  effectiveMode === 'fork_new_branch' ? 'var(--bg-active)' : 'var(--bg-elevated)',
                border: `1px solid ${
                  effectiveMode === 'fork_new_branch'
                    ? 'var(--border-focus)'
                    : 'var(--border-hairline)'
                }`,
              }}
            >
              <input
                type="radio"
                name="revert-mode"
                value="fork_new_branch"
                checked={effectiveMode === 'fork_new_branch'}
                onChange={() => setSelectedMode('fork_new_branch')}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium text-[var(--text-primary)]">
                  还原文件并开启新原生分支 (fork_new_branch)
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  还原工作区文件并清除当前原生会话绑定，下一轮对话将以干净上下文重新续跑。
                </div>
              </div>
            </label>

            <label
              className="flex cursor-pointer items-start gap-2.5 rounded-xl p-3 transition-colors"
              style={{
                backgroundColor:
                  effectiveMode === 'files_only' ? 'var(--bg-active)' : 'var(--bg-elevated)',
                border: `1px solid ${
                  effectiveMode === 'files_only'
                    ? 'var(--border-focus)'
                    : 'var(--border-hairline)'
                }`,
              }}
            >
              <input
                type="radio"
                name="revert-mode"
                value="files_only"
                checked={effectiveMode === 'files_only'}
                onChange={() => setSelectedMode('files_only')}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium text-[var(--text-primary)]">
                  仅还原工作区文件 (files_only)
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  仅将磁盘文件还原至该检查点状态，保留已有对话记录并写入清晰系统说明。
                </div>
              </div>
            </label>
          </div>

          {/* Pre-revert safety net notice */}
          <div
            className="flex items-start gap-2 rounded-xl px-3 py-2 text-[11px] text-[var(--text-secondary)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <History size={13} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" />
            <span>
              保护机制：回滚前会自动保存一条 <code className="font-mono-code">pre_revert</code>{' '}
              保护快照，回滚后可随时一键“撤销回滚 (Undo Revert)”逐字节恢复当前状态。
            </span>
          </div>

          {/* Second confirmation checkbox */}
          <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-[var(--text-primary)]">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>我已知晓将覆盖当前工作区未提交修改，并确认执行回滚</span>
          </label>
        </div>

        <div
          className="flex items-center justify-end gap-2 px-5 py-3.5"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          <button
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!confirmed || submitting}
            onClick={() => void onConfirm(effectiveMode)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
            style={{ backgroundColor: 'var(--accent-rose)' }}
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            <span>执行回滚</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Prominent Undo Revert banner shown immediately after a checkpoint revert completes.
 */
export function UndoRevertBanner({
  revertResult,
  undoing = false,
  onUndo,
  onDismiss,
}: {
  revertResult: CheckpointRevertResult;
  undoing?: boolean;
  onUndo: () => Promise<void> | void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="undo-revert-banner"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-[12px]"
      style={{
        backgroundColor: 'var(--accent-indigo-soft)',
        border: '1px solid var(--border-focus)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2 text-[var(--text-primary)]">
        <Undo2 size={14} className="shrink-0 text-[var(--accent-indigo)]" />
        <span className="truncate">
          已回滚到 Turn #{revertResult.targetTurnSeq}（还原 {revertResult.filesRestored} 个文件，清理{' '}
          {revertResult.untrackedRemoved} 个新增文件，模式：{revertResult.modeUsed}）
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={undoing}
          onClick={() => void onUndo()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: 'var(--accent-indigo)' }}
        >
          {undoing ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
          <span>撤销回滚 (Undo Revert)</span>
        </button>
        <button
          type="button"
          aria-label="关闭撤销回滚提示"
          onClick={onDismiss}
          className="cursor-pointer rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * Compact per-turn checkpoint badge rendered via V5 `chat.block` slot (`key: 'checkpoint_marker'`).
 */
export function CheckpointTurnBadge({
  session,
  block,
  harnessLabel,
  supportsNativeRollback,
  onViewDiff,
  onRevert,
}: {
  session: Session;
  block: CheckpointMarkerBlock;
  harnessLabel: string;
  supportsNativeRollback: boolean;
  onViewDiff: (checkpointId: string, turnSeq: number) => void;
  onRevert: (mode: CheckpointRevertMode, turnSeq: number) => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  return (
    <>
      <div
        data-testid={`checkpoint-badge-${block.checkpointId}`}
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11.5px]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <GitBranch size={13} className="shrink-0 text-[var(--accent-indigo)]" />
          <span className="font-medium text-[var(--text-primary)]">
            检查点 · Turn #{block.turnSeq}
          </span>
          <span className="font-mono-code text-[11px] text-[var(--accent-emerald)]">
            +{block.insertions}
          </span>
          <span className="font-mono-code text-[11px] text-[var(--accent-rose)]">
            -{block.deletions}
          </span>
          <span className="text-[var(--text-muted)]">· {block.filesChanged} 个文件</span>
          {block.skippedLargeFiles.length > 0 && (
            <span
              title={`跳过超大文件：${block.skippedLargeFiles.join(', ')}`}
              className="rounded-md px-1.5 py-0.5 text-[10px] text-[var(--accent-star)]"
              style={{ backgroundColor: 'var(--accent-star-soft)' }}
            >
              跳过 {block.skippedLargeFiles.length} 个大文件
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onViewDiff(block.checkpointId, block.turnSeq)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <FileDiff size={11.5} />
            <span>查看 Diff</span>
          </button>
          <button
            type="button"
            disabled={session.status === 'running' || session.status === 'awaiting_approval'}
            onClick={() => setDialogOpen(true)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--accent-star)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
            style={{ border: '1px solid color-mix(in srgb, var(--accent-star) 35%, transparent)' }}
          >
            <RotateCcw size={11.5} />
            <span>回滚到此轮前</span>
          </button>
        </div>
      </div>

      <RevertCheckpointDialog
        open={dialogOpen}
        turnSeq={block.turnSeq}
        checkpointId={block.checkpointId}
        harnessLabel={harnessLabel}
        supportsNativeRollback={supportsNativeRollback}
        filesChanged={block.filesChanged}
        insertions={block.insertions}
        deletions={block.deletions}
        submitting={submitting}
        onCancel={() => setDialogOpen(false)}
        onConfirm={async (mode) => {
          setSubmitting(true);
          try {
            await onRevert(mode, block.turnSeq);
            setDialogOpen(false);
          } finally {
            setSubmitting(false);
          }
        }}
      />
    </>
  );
}
