import { FileCode2, Lock, ShieldCheck, ShieldX } from 'lucide-react';
import { useState } from 'react';
import type { WorkflowId } from '../../../../lib/native-client';
import { EvidenceDetails, toneStyle } from '../shared';
import type {
  DynamicScriptApprovalDisplayState,
  DynamicScriptPreviewData,
} from './types';

export interface DynamicWorkflowScriptReviewProps {
  readonly workflowId: WorkflowId;
  readonly scriptArtifactId?: string;
  readonly approvalState: DynamicScriptApprovalDisplayState;
  readonly preview?: DynamicScriptPreviewData | null;
  readonly onLoadMorePreview?: (
    workflowId: WorkflowId,
    artifactId: string,
    pageToken: string,
  ) => Promise<DynamicScriptPreviewData | null>;
}

function resolveApprovalBadge(state: DynamicScriptApprovalDisplayState): {
  label: string;
  tone: 'emerald' | 'star' | 'rose' | 'clay' | 'muted';
} {
  switch (state) {
    case 'approved':
      return { label: '脚本已获批准', tone: 'emerald' };
    case 'pending':
      return { label: '等待用户批准脚本', tone: 'star' };
    case 'denied':
      return { label: '脚本已被拒绝', tone: 'rose' };
    case 'cancelled':
      return { label: '脚本执行已取消', tone: 'clay' };
    case 'expired':
      return { label: '批准请求已过期', tone: 'muted' };
    default:
      return { label: '批准状态未知', tone: 'muted' };
  }
}

/**
 * Read-only script review panel for NP-11 Dynamic Workflows.
 * Never executes Python, never resolves unapproved filesystem paths, and
 * delegates any script approval action strictly to NP-07 NativeRequestQueuePanel.
 */
export function DynamicWorkflowScriptReview({
  workflowId,
  scriptArtifactId,
  approvalState,
  preview,
  onLoadMorePreview,
}: DynamicWorkflowScriptReviewProps) {
  const [extraLines, setExtraLines] = useState<string[]>([]);
  const [nextToken, setNextToken] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const badge = resolveApprovalBadge(approvalState);
  const badgeStyle = toneStyle(badge.tone);

  const activeArtifactId = preview?.artifactId ?? scriptArtifactId;
  const effectiveNextToken =
    nextToken !== undefined ? nextToken : (preview?.nextPageToken ?? null);
  const allLines = [...(preview?.previewLines ?? []), ...extraLines];

  const handleLoadMore = async () => {
    if (!onLoadMorePreview || !activeArtifactId || !effectiveNextToken || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await onLoadMorePreview(workflowId, activeArtifactId, effectiveNextToken);
      if (page) {
        setExtraLines((prev) => [...prev, ...page.previewLines]);
        setNextToken(page.nextPageToken);
      } else {
        setNextToken(null);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section
      data-testid="np11-script-review"
      aria-label="动态工作流脚本审阅"
      className="space-y-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <FileCode2 size={14} className="text-[var(--accent-indigo)]" aria-hidden="true" />
          <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
            脚本审阅（只读文本）
          </h3>
          {activeArtifactId && (
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
              {activeArtifactId}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]"
          >
            <Lock size={10} aria-hidden="true" />
            <span>不在客户端执行 Python</span>
          </span>
          <span
            data-testid="np11-script-approval-badge"
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
            style={badgeStyle}
          >
            {approvalState === 'approved' ? (
              <ShieldCheck size={10.5} aria-hidden="true" />
            ) : (
              <ShieldX size={10.5} aria-hidden="true" />
            )}
            <span>{badge.label}</span>
          </span>
        </div>
      </div>

      {preview?.sourceScopeNote && (
        <p className="text-[11px] text-[var(--text-muted)]">{preview.sourceScopeNote}</p>
      )}

      {!activeArtifactId ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px] text-[var(--text-muted)]">
          尚未观测到已批准的脚本产物 ID；客户端不会主动读取未授权的本地脚本路径。
        </div>
      ) : allLines.length === 0 ? (
        <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[11.5px] text-[var(--text-secondary)]">
          <div>已记录受控脚本引用：{activeArtifactId}</div>
          <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
            脚本正文读取依赖 NP-14 安全 Artifact 接口或原生实时预览帧，当前保留只读占位边界。
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <pre
            data-testid="np11-script-preview-code"
            className="max-h-56 overflow-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 font-mono-code text-[11px] leading-relaxed text-[var(--text-primary)]"
          >
            <code>{allLines.join('\n')}</code>
          </pre>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-[var(--text-muted)]">
            <span>
              已加载 {allLines.length}
              {preview?.totalLines ? ` / ${preview.totalLines}` : ''} 行
              {preview?.truncated ? '（已按页截断）' : ''}
            </span>
            {effectiveNextToken && onLoadMorePreview && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void handleLoadMore()}
                className="cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {loadingMore ? '加载中…' : '分页加载更多脚本'}
              </button>
            )}
          </div>
        </div>
      )}

      {preview?.provenance && (
        <EvidenceDetails
          evidence={preview.provenance}
          label="脚本预览来源与范围"
        />
      )}
    </section>
  );
}
