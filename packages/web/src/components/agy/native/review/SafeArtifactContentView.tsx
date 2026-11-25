import { Check, Code2, FileDiff, FileText, Lock, MessageSquarePlus, ShieldAlert, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NativeRuntimeStatus } from '../../../../lib/native-client';
import { CapabilityUnavailable, EvidenceDetails, toneStyle } from '../shared';
import { formatSafeUnifiedDiffLines, parseSafeMarkdown, type SafeInlineToken } from './safe-content';
import type {
  ArtifactContentView,
  ArtifactLineCommentDraft,
  ArtifactSummaryView,
  ArtifactWorkspaceFeatureGates,
  ReviewCapabilityView,
} from './types';

export const AGY_ARTIFACT_REVIEW_DOC_URL = 'https://antigravity.google/docs/artifact-review/';

const ORIGIN_LABELS: Record<ArtifactSummaryView['originKind'], string> = {
  brain_session: 'Brain 会话产物',
  acp_plan: 'ACP 计划产物',
  acp_tool_diff: 'ACP 工具 Diff',
  teamwork_prompt: 'Teamwork Prompt Artifact',
  dynamic_script: 'Dynamic Workflow 脚本',
  dynamic_result: 'Dynamic Workflow 结果',
  browser_reference: 'Browser 证据参考',
  history_snapshot: '历史只读快照',
};

function renderInlineTokens(tokens: readonly SafeInlineToken[]) {
  return tokens.map((tok, idx) => {
    switch (tok.kind) {
      case 'code':
        return (
          <code
            key={idx}
            className="rounded bg-[var(--bg-elevated)] px-1 py-0.5 font-mono-code text-[11px] text-[var(--accent-indigo)]"
          >
            {tok.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={idx} className="font-semibold text-[var(--text-primary)]">
            {tok.text}
          </strong>
        );
      case 'safe_doc_link':
        return (
          <a
            key={idx}
            href={tok.href}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent-indigo)] underline"
          >
            {tok.label}
          </a>
        );
      case 'blocked_link':
        return (
          <span
            key={idx}
            data-testid="np14-blocked-link-token"
            title={tok.reason}
            className="rounded bg-[var(--accent-clay-soft)] px-1 py-0.5 font-mono-code text-[10.5px] text-[var(--accent-clay)]"
          >
            {tok.label}
          </span>
        );
      default:
        return <span key={idx}>{tok.text}</span>;
    }
  });
}

export interface SafeArtifactContentViewProps {
  readonly summary: ArtifactSummaryView;
  readonly content: ArtifactContentView | null;
  readonly runtimeStatus: NativeRuntimeStatus;
  readonly featureGates: ArtifactWorkspaceFeatureGates;
  readonly reviewCapability?: ReviewCapabilityView | null;
  readonly onLoadMore?: (artifactId: string, pageToken: string) => Promise<void>;
  readonly onSubmitLineComment?: (input: {
    artifactId: string;
    revision: number;
    requestId?: string;
    line: number;
    comment: string;
  }) => Promise<void>;
  readonly onSubmitApproval?: (input: {
    artifactId: string;
    revision: number;
    requestId?: string;
    decision: 'approve' | 'reject';
    comments: readonly ArtifactLineCommentDraft[];
  }) => Promise<void>;
  readonly onRefresh?: () => void;
}

export function SafeArtifactContentView({
  summary,
  content,
  runtimeStatus,
  featureGates,
  reviewCapability,
  onLoadMore,
  onSubmitLineComment,
  onSubmitApproval,
  onRefresh,
}: SafeArtifactContentViewProps) {
  const defaultMode: 'markdown' | 'text' | 'diff' =
    summary.contentKind === 'diff'
      ? 'diff'
      : summary.contentKind === 'markdown'
        ? 'markdown'
        : 'text';
  const [viewMode, setViewMode] = useState<'markdown' | 'text' | 'diff'>(defaultMode);
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [comments, setComments] = useState<ArtifactLineCommentDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const parsedMd = useMemo(
    () => (content ? parseSafeMarkdown(content.content) : null),
    [content],
  );
  const diffLines = useMemo(
    () => (content ? formatSafeUnifiedDiffLines(content.content) : []),
    [content],
  );
  const rawLines = useMemo(() => (content ? content.content.split(/\r?\n/) : []), [content]);

  const canComment = Boolean(
    featureGates.reviewControlEnabled &&
      runtimeStatus === 'attached' &&
      !summary.scope.isHistorical &&
      reviewCapability?.canComment &&
      summary.verifiedActionKeys.includes('submit_native_comment'),
  );
  const canApprove = Boolean(
    featureGates.reviewControlEnabled &&
      runtimeStatus === 'attached' &&
      !summary.scope.isHistorical &&
      reviewCapability?.canApproveViaNativeProtocol &&
      summary.verifiedActionKeys.includes('submit_native_approval'),
  );

  const hasSecurityNotice = Boolean(
    content &&
      (content.security.secretsRedactedCount > 0 ||
        content.security.hostPathsRedactedCount > 0 ||
        content.security.htmlStrippedOrEscaped ||
        content.security.unsafeLinksBlockedCount > 0 ||
        (parsedMd &&
          (parsedMd.rawHtmlDetected ||
            parsedMd.blockedLinksCount > 0 ||
            parsedMd.blockedImagesCount > 0))),
  );

  const handleAddComment = async () => {
    if (!content || draftLine === null || !draftNote.trim() || !canComment) return;
    const text = draftNote.trim();
    const item: ArtifactLineCommentDraft = {
      artifactId: content.artifactId,
      line: draftLine,
      comment: text,
    };
    setComments((prev) => [...prev, item]);
    setDraftLine(null);
    setDraftNote('');
    if (onSubmitLineComment) {
      setSubmitting(true);
      try {
        await onSubmitLineComment({
          artifactId: content.artifactId,
          revision: content.revision,
          requestId: summary.pendingRequestId,
          line: item.line,
          comment: item.comment,
        });
        setFeedback(`已提交第 ${item.line} 行评论。`);
      } catch (err) {
        setFeedback(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    }
  };

  const handleDecision = async (decision: 'approve' | 'reject') => {
    if (!content || !canApprove || !onSubmitApproval || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await onSubmitApproval({
        artifactId: content.artifactId,
        revision: content.revision,
        requestId: summary.pendingRequestId,
        decision,
        comments,
      });
      setFeedback(
        decision === 'approve' ? '已通过原生协议提交批准。' : '已通过原生协议提交拒绝。',
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="np14-artifact-detail"
      data-artifact-id={summary.artifactId}
      data-artifact-revision={summary.revision}
      className="space-y-3 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px]"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
              {summary.title}
            </h4>
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
              {summary.artifactId}
            </span>
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
              rev {summary.revision}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <span
              className="rounded-full border px-2 py-0.5"
              style={toneStyle('indigo')}
            >
              {ORIGIN_LABELS[summary.originKind]}
            </span>
            <span
              className="rounded-full border px-2 py-0.5"
              style={toneStyle(summary.scope.isHistorical || summary.scope.readOnly ? 'muted' : 'emerald')}
            >
              {summary.scope.isHistorical ? '历史只读' : summary.scope.readOnly ? '只读预览' : '可原生审阅'}
            </span>
            <span
              className="rounded-full border px-2 py-0.5"
              style={toneStyle(summary.scope.ownerLineage === 'confirmed' ? 'emerald' : 'clay')}
            >
              归属: {summary.scope.ownerAgentId ?? summary.scope.scopeKind} ({summary.scope.ownerLineage})
            </span>
          </div>
        </div>

        <div
          role="group"
          aria-label="视图格式"
          className="inline-flex overflow-hidden rounded-lg border border-[var(--border-hairline)]"
        >
          <button
            type="button"
            onClick={() => setViewMode('markdown')}
            disabled={summary.contentKind === 'diff'}
            className={`inline-flex cursor-pointer items-center gap-1 px-2 py-1 text-[10.5px] disabled:opacity-40 ${
              viewMode === 'markdown'
                ? 'bg-[var(--bg-active)] text-[var(--accent-indigo)]'
                : 'text-[var(--text-secondary)]'
            }`}
          >
            <FileText size={11} aria-hidden="true" />
            <span>安全 Markdown</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('text')}
            className={`inline-flex cursor-pointer items-center gap-1 border-l border-[var(--border-hairline)] px-2 py-1 text-[10.5px] ${
              viewMode === 'text'
                ? 'bg-[var(--bg-active)] text-[var(--accent-indigo)]'
                : 'text-[var(--text-secondary)]'
            }`}
          >
            <Code2 size={11} aria-hidden="true" />
            <span>文本/行号</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('diff')}
            disabled={summary.contentKind !== 'diff'}
            className={`inline-flex cursor-pointer items-center gap-1 border-l border-[var(--border-hairline)] px-2 py-1 text-[10.5px] disabled:opacity-40 ${
              viewMode === 'diff'
                ? 'bg-[var(--bg-active)] text-[var(--accent-indigo)]'
                : 'text-[var(--text-secondary)]'
            }`}
          >
            <FileDiff size={11} aria-hidden="true" />
            <span>Diff</span>
          </button>
        </div>
      </div>

      {hasSecurityNotice && content && (
        <div
          data-testid="np14-security-redaction-banner"
          className="flex items-start gap-2 rounded-xl px-3 py-2 text-[11px]"
          style={{
            backgroundColor: 'var(--accent-clay-soft)',
            color: 'var(--accent-clay)',
          }}
        >
          <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            已启用不可信内容防御：秘钥脱敏 {content.security.secretsRedactedCount} 处 · 宿主路径脱敏{' '}
            {content.security.hostPathsRedactedCount} 处 · 拦截未审查链接/图片{' '}
            {content.security.unsafeLinksBlockedCount + (parsedMd?.blockedLinksCount ?? 0) + (parsedMd?.blockedImagesCount ?? 0)}{' '}
            处
            {content.security.htmlStrippedOrEscaped || parsedMd?.rawHtmlDetected
              ? ' · 原始 HTML/脚本已强制转义为纯文本'
              : ''}
            。
          </span>
        </div>
      )}

      {!content ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px] text-[var(--text-muted)]">
          正在等待读取受控产物正文，或该产物尚未授权读取。
        </div>
      ) : viewMode === 'markdown' && parsedMd ? (
        <div
          data-testid="np14-safe-markdown-view"
          className="max-h-72 space-y-1.5 overflow-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[12px] leading-relaxed"
        >
          {parsedMd.blocks.map((block, idx) => {
            if (block.kind === 'blank') {
              return <div key={idx} className="h-1.5" />;
            }
            if (block.kind === 'code_block') {
              return (
                <pre
                  key={idx}
                  className="overflow-x-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono-code text-[11px] text-[var(--text-secondary)]"
                >
                  <code>{block.lines.join('\n')}</code>
                </pre>
              );
            }
            if (block.kind === 'heading') {
              const cls =
                block.level === 1
                  ? 'text-[14px] font-bold text-[var(--text-primary)]'
                  : block.level === 2
                    ? 'text-[13px] font-semibold text-[var(--text-primary)]'
                    : 'text-[12px] font-semibold text-[var(--text-primary)]';
              return (
                <div key={idx} className={cls}>
                  {renderInlineTokens(block.tokens)}
                </div>
              );
            }
            if (block.kind === 'list_item') {
              return (
                <div key={idx} className="flex items-start gap-2 pl-2 text-[var(--text-secondary)]">
                  <span className="text-[var(--text-muted)]">•</span>
                  <span className="min-w-0 flex-1">{renderInlineTokens(block.tokens)}</span>
                </div>
              );
            }
            return (
              <p key={idx} className="text-[var(--text-secondary)]">
                {renderInlineTokens(block.tokens)}
              </p>
            );
          })}
        </div>
      ) : viewMode === 'diff' ? (
        <div
          data-testid="np14-safe-diff-view"
          className="max-h-72 overflow-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2 font-mono-code text-[11px]"
        >
          {diffLines.map((row) => (
            <div
              key={row.lineNo}
              className="flex items-start gap-2 rounded px-1 py-0.5"
              style={{
                backgroundColor:
                  row.kind === 'add'
                    ? 'var(--accent-emerald-soft)'
                    : row.kind === 'del'
                      ? 'var(--accent-rose-soft)'
                      : 'transparent',
                color:
                  row.kind === 'add'
                    ? 'var(--accent-emerald)'
                    : row.kind === 'del'
                      ? 'var(--accent-rose)'
                      : row.kind === 'hunk'
                        ? 'var(--accent-indigo)'
                        : 'var(--text-secondary)',
              }}
            >
              <span className="w-8 shrink-0 select-none text-right text-[10px] text-[var(--text-muted)]">
                {row.lineNo}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all">{row.text || ' '}</span>
            </div>
          ))}
        </div>
      ) : (
        <div
          data-testid="np14-numbered-text-view"
          className="max-h-72 overflow-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2 font-mono-code text-[11px]"
        >
          {rawLines.map((lineText, idx) => {
            const lineNo = idx + 1;
            const hasComment = comments.some((c) => c.line === lineNo);
            return (
              <div
                key={lineNo}
                className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-[var(--bg-hover)]"
              >
                <button
                  type="button"
                  disabled={!canComment}
                  onClick={() => canComment && setDraftLine(lineNo)}
                  title={canComment ? `在第 ${lineNo} 行添加原生评论` : '只读模式（原生评论未开放）'}
                  className={`w-8 shrink-0 text-right ${
                    canComment ? 'cursor-pointer' : 'cursor-default'
                  } ${hasComment ? 'font-bold text-[var(--accent-star)]' : 'text-[var(--text-muted)]'}`}
                >
                  {lineNo}
                </button>
                <span className="flex-1 whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                  {lineText || ' '}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {content?.hasMore && content.nextPageToken && onLoadMore && (
        <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span>
            已读取 {content.content.length} / {content.totalChars} 字符
          </span>
          <button
            type="button"
            onClick={() => void onLoadMore(content.artifactId, content.nextPageToken!)}
            className="cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
          >
            分页加载更多内容
          </button>
        </div>
      )}

      {canComment && draftLine !== null && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono-code text-[11px] text-[var(--accent-indigo)]">
            L{draftLine}
          </span>
          <input
            type="text"
            placeholder="输入原生行级评论..."
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            className="flex-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11.5px]"
          />
          <button
            type="button"
            disabled={submitting || !draftNote.trim()}
            onClick={() => void handleAddComment()}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-indigo)] px-2.5 py-1 text-[11px] text-white disabled:opacity-45"
          >
            <MessageSquarePlus size={12} aria-hidden="true" />
            <span>添加评论</span>
          </button>
        </div>
      )}

      {canApprove ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            data-testid="np14-native-reject-btn"
            disabled={submitting}
            onClick={() => void handleDecision('reject')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium disabled:opacity-45"
            style={{
              color: 'var(--accent-rose)',
              borderColor: 'color-mix(in srgb, var(--accent-rose) 40%, transparent)',
            }}
          >
            <XCircle size={12} aria-hidden="true" />
            <span>原生拒绝 (Reject)</span>
          </button>
          <button
            type="button"
            data-testid="np14-native-approve-btn"
            disabled={submitting}
            onClick={() => void handleDecision('approve')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-emerald)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-45"
          >
            <Check size={12} aria-hidden="true" />
            <span>原生批准 (Approve)</span>
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <Lock size={12} aria-hidden="true" />
            <span>原生评论与批准严格受 AGY-W14 协议证据与审阅开关门控，不通过聊天消息伪造批准。</span>
          </div>
          <CapabilityUnavailable
            title="当前保持受控只读模式（原生评论/批准未启用）"
            gate={reviewCapability?.approveGate ?? 'upstream_limited'}
            capabilityId="AGY-W14"
            reason={
              summary.scope.isHistorical
                ? '历史快照仅提供只读回看，不可对历史产物发起原生批准或评论。'
                : (reviewCapability?.officialFallbackHint ??
                  '当前尚未观察到经验证的 ACP 原生评论/批准线格式或审阅控制门控未开启；请在官方 Antigravity App 或 CLI 中完成交互审阅。')
            }
            officialEntryHint="官方 Antigravity App Artifact Tab · CLI /artifact"
            officialDocUrl={AGY_ARTIFACT_REVIEW_DOC_URL}
            onRefresh={onRefresh}
          />
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className="rounded-lg bg-[var(--accent-indigo-soft)] px-2.5 py-1.5 text-[11px] text-[var(--accent-indigo)]"
        >
          {feedback}
        </div>
      )}

      <EvidenceDetails
        evidence={summary.provenance}
        reasonCode={reviewCapability?.reasonCode ?? summary.reviewWireSupport}
        label="产物来源与安全边界"
      />
    </div>
  );
}
