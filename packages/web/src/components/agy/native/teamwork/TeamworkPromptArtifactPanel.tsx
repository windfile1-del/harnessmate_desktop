import { Check, FileCheck2, Lock, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { EvidenceDto } from '../../../../lib/native-client';
import { CapabilityUnavailable, EvidenceDetails, toneStyle } from '../shared';
import {
  TEAMWORK_APPROVAL_GATE_LABELS,
  TEAMWORK_ARTIFACT_DOC_URL,
  TEAMWORK_DEFAULT_OFFICIAL_HINT,
} from './teamwork-view-model';
import type { TeamworkApprovalGateState, TeamworkReviewControlProps } from './types';

export interface TeamworkPromptArtifactPanelProps {
  readonly promptArtifactId?: string;
  readonly gateState: TeamworkApprovalGateState;
  readonly canActNativeApproval: boolean;
  readonly disabledReason: string | null;
  readonly reviewControl?: TeamworkReviewControlProps;
  readonly evidence?: EvidenceDto | null;
  readonly onRefresh?: () => void;
}

/**
 * Teamwork Prompt Artifact & Formal Approval Gate Panel.
 *
 * Strict invariants (NP-10 / NP-14):
 * - NEVER offers a natural-language "Approve" chat turn button.
 * - Native approve/reject controls are enabled ONLY when NP-14 verified protocol support AND
 *   reviewControlEnabled are both active on a live attached binding.
 * - When approval is unavailable, guides the user honestly to official Antigravity App / CLI.
 * - When rejected/cancelled/expired, explicitly confirms zero project directory/roles/milestones exist.
 */
export function TeamworkPromptArtifactPanel({
  promptArtifactId,
  gateState,
  canActNativeApproval,
  disabledReason,
  reviewControl,
  evidence,
  onRefresh,
}: TeamworkPromptArtifactPanelProps) {
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const gateMeta = TEAMWORK_APPROVAL_GATE_LABELS[gateState];
  const isRejectedOrClosed =
    gateState === 'rejected' || gateState === 'cancelled' || gateState === 'expired';

  const handleNativeDecision = async (decision: 'approve' | 'reject') => {
    if (!promptArtifactId || !canActNativeApproval || submitting) return;
    const handler =
      decision === 'approve' ? reviewControl?.onNativeApprove : reviewControl?.onNativeReject;
    if (!handler) return;

    setSubmitting(decision);
    setActionFeedback(null);
    try {
      await handler(promptArtifactId);
      setActionFeedback(
        decision === 'approve'
          ? '已通过原生协议提交批准，等待原生项目创建与后续帧确认。'
          : '已通过原生协议提交拒绝，将阻止创建 Teamwork 项目目录与里程碑。',
      );
    } catch (err) {
      setActionFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section
      data-testid="np10-prompt-artifact-panel"
      data-approval-gate={gateState}
      data-native-approval-enabled={String(canActNativeApproval)}
      aria-label="Prompt Artifact 与批准门控"
      className="space-y-3 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5 text-[12px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileCheck2 size={15} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
              {reviewControl?.promptArtifactTitle ?? 'Prompt Artifact 审阅门控'}
            </h3>
            {promptArtifactId && (
              <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                artifact: {promptArtifactId}
                {reviewControl?.promptArtifactRevision !== undefined
                  ? ` · rev ${reviewControl.promptArtifactRevision}`
                  : ''}
              </span>
            )}
          </div>
        </div>

        <span
          data-testid="np10-approval-gate-badge"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
          style={toneStyle(gateMeta.tone === 'neutral' ? 'muted' : gateMeta.tone)}
        >
          <span>{gateMeta.label}</span>
        </span>
      </div>

      {!promptArtifactId ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px] text-[var(--text-muted)]">
          尚未观察到 Teamwork Prompt Artifact。完成需求访谈后，原生端会生成待审阅的 Prompt Artifact 作为启动项目的唯一关口。
        </div>
      ) : (
        <>
          {reviewControl?.promptArtifactPreview ? (
            <div
              data-testid="np10-prompt-artifact-preview"
              className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 font-mono-code text-[11px] leading-relaxed text-[var(--text-secondary)]"
            >
              {reviewControl.promptArtifactPreview}
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
              Prompt Artifact 正文读取由 NP-14 Artifact Reader 提供；当前仅展示已证实的不透明 Artifact ID 与门控状态。
            </div>
          )}

          {isRejectedOrClosed && (
            <div
              data-testid="np10-rejection-confirmed-banner"
              className="flex items-start gap-2 rounded-xl px-3 py-2 text-[11.5px]"
              style={{
                backgroundColor: 'var(--accent-rose-soft)',
                color: 'var(--accent-rose)',
              }}
            >
              <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                已确认 Prompt Artifact 未获批准（{gateMeta.label}）：未创建 Teamwork 项目目录、Sentinel / Project Orchestrator 角色或里程碑。
              </span>
            </div>
          )}

          {canActNativeApproval ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                data-testid="np10-native-reject-btn"
                disabled={submitting !== null || !reviewControl?.onNativeReject}
                onClick={() => void handleNativeDecision('reject')}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 text-[11.5px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
                style={{
                  color: 'var(--accent-rose)',
                  border: '1px solid color-mix(in srgb, var(--accent-rose) 40%, transparent)',
                }}
              >
                <XCircle size={12.5} aria-hidden="true" />
                <span>原生拒绝 (Reject)</span>
              </button>
              <button
                type="button"
                data-testid="np10-native-approve-btn"
                disabled={submitting !== null || !reviewControl?.onNativeApprove}
                onClick={() => void handleNativeDecision('approve')}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-emerald)] px-3 py-1.5 text-[11.5px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Check size={12.5} aria-hidden="true" />
                <span>原生批准 (Approve)</span>
              </button>
            </div>
          ) : gateState === 'approved' ? (
            <div className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--accent-emerald)]">
              <Check size={13} aria-hidden="true" />
              <span>Prompt Artifact 已通过原生协议正式批准，进入项目执行阶段。</span>
            </div>
          ) : !isRejectedOrClosed ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                <Lock size={12} aria-hidden="true" />
                <span>严禁通过自然语言聊天消息伪造 Prompt Artifact 批准。</span>
              </div>
              <CapabilityUnavailable
                title="原生 Prompt Artifact 批准入口暂未开放"
                gate={gateState === 'connection_lost' ? 'unsupported' : 'upstream_limited'}
                capabilityId="AGY-W07"
                reason={
                  disabledReason ??
                  '当前连接未开放经验证的 ACP 原生批准动作（审阅控制联合 NP-14 联测），已禁用交互批准按钮并保留只读展示。'
                }
                officialEntryHint={
                  reviewControl?.officialFallbackHint ?? TEAMWORK_DEFAULT_OFFICIAL_HINT
                }
                officialDocUrl={TEAMWORK_ARTIFACT_DOC_URL}
                onRefresh={onRefresh}
              />
            </div>
          ) : null}

          {actionFeedback && (
            <div
              role="status"
              className="rounded-lg bg-[var(--accent-indigo-soft)] px-2.5 py-1.5 text-[11px] text-[var(--accent-indigo)]"
            >
              {actionFeedback}
            </div>
          )}

          {evidence && (
            <EvidenceDetails
              evidence={evidence}
              reasonCode={gateState}
              label="Prompt Artifact 门控证据"
            />
          )}
        </>
      )}
    </section>
  );
}
