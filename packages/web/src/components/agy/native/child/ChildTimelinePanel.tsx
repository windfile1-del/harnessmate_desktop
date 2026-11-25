import { ArrowLeft, Eye, Radio } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  coalesceTimelineEntries,
  type AgentIdentity,
  type EvidenceDto,
  type NativeTimelineEntry,
} from '../../../../lib/native-client';
import {
  EVIDENCE_SOURCE_LABELS,
  EvidenceDetails,
  NativeTimeline,
  type NativeWorkbenchViewProps,
} from '../shared';

export interface ChildTimelinePanelProps {
  readonly agent: AgentIdentity;
  readonly displayName: string;
  readonly bindingKey: string;
  readonly provenance: EvidenceDto | null;
  readonly isReadOnlySnapshotOnly: boolean;
  readonly loadTimeline?: NativeWorkbenchViewProps['loadTimeline'];
  readonly onBackToChat: () => void;
}

interface ScopedChildTimelineState {
  readonly scopeKey: string;
  readonly entries: NativeTimelineEntry[];
  readonly loading: boolean;
  readonly nextPageToken: string | null;
  readonly sourceUnavailable: boolean;
  readonly sourceUnavailableReason?: string;
}

const SOURCE_UNAVAILABLE_COPY: Record<string, string> = {
  child_lineage_unconfirmed:
    '当前仅观察到子 Agent 委派批次，身份尚未通过协议或版本化快照确证，因此不加载任何父会话历史。',
  child_lineage_conflicting:
    '该子 Agent 存在亲缘或命名空间冲突，已阻断轨迹读取以防错标。',
  child_transcript_source_not_provided:
    '该来源未提供该子 Agent 的独立轨迹文件或实时子流；不会回退到父会话历史以免错标。',
  child_transcript_path_rejected:
    '只读轨迹文件未通过受管目录安全校验（如符号链接或越界路径），已拒绝读取。',
  timeline_reader_unregistered:
    '后端子 Agent 时间线读取器尚未注册，当前保持只读空态。',
  native_runtime_disabled:
    '原生运行时门控关闭，未读取子 Agent 时间线。',
};

/**
 * Independent, scope-isolated child timeline viewer (NP-05).
 *
 * Guarantees:
 * - Cancels in-flight initial & pagination fetches immediately when switching child or binding generation.
 * - Never renders stale entries from a previous child under a new header.
 * - Explicitly distinguishes live protocol stream vs read-only snapshot vs unavailable source.
 * - Never exposes simulated child prompt/steer inputs; offers explicit return to main Agent.
 */
export function ChildTimelinePanel({
  agent,
  displayName,
  bindingKey,
  provenance,
  isReadOnlySnapshotOnly,
  loadTimeline,
  onBackToChat,
}: ChildTimelinePanelProps) {
  const scopeKey = `${bindingKey}:agent:${agent.id}`;
  const activeScopeKeyRef = useRef(scopeKey);
  activeScopeKeyRef.current = scopeKey;
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<ScopedChildTimelineState>({
    scopeKey,
    entries: [],
    loading: false,
    nextPageToken: null,
    sourceUnavailable: false,
  });

  useEffect(() => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

    if (agent.lineage !== 'confirmed') {
      setState({
        scopeKey,
        entries: [],
        loading: false,
        nextPageToken: null,
        sourceUnavailable: true,
        sourceUnavailableReason:
          agent.lineage === 'conflicting'
            ? 'child_lineage_conflicting'
            : 'child_lineage_unconfirmed',
      });
      return;
    }

    if (!loadTimeline) {
      setState({
        scopeKey,
        entries: [],
        loading: false,
        nextPageToken: null,
        sourceUnavailable: true,
        sourceUnavailableReason: 'child_transcript_source_not_provided',
      });
      return;
    }

    const requestScopeKey = scopeKey;
    const controller = new AbortController();
    setState({
      scopeKey: requestScopeKey,
      entries: [],
      loading: true,
      nextPageToken: null,
      sourceUnavailable: false,
    });

    void loadTimeline({ kind: 'agent', id: agent.id }, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState({
          scopeKey: requestScopeKey,
          entries: coalesceTimelineEntries([], page.items),
          loading: false,
          nextPageToken: page.nextPageToken,
          sourceUnavailable: Boolean(page.sourceUnavailableReason),
          sourceUnavailableReason: page.sourceUnavailableReason,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState({
          scopeKey: requestScopeKey,
          entries: [],
          loading: false,
          nextPageToken: null,
          sourceUnavailable: true,
          sourceUnavailableReason: 'child_transcript_source_not_provided',
        });
      });

    return () => {
      controller.abort();
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [agent.id, agent.lineage, bindingKey, scopeKey, loadTimeline]);

  const handleLoadMore = useCallback(() => {
    if (!loadTimeline || agent.lineage !== 'confirmed') return;
    if (state.scopeKey !== scopeKey || !state.nextPageToken || state.loading) return;
    const requestScopeKey = scopeKey;
    const token = state.nextPageToken;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setState((prev) => (prev.scopeKey === requestScopeKey ? { ...prev, loading: true } : prev));
    void loadTimeline({ kind: 'agent', id: agent.id }, token, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState((prev) => {
          if (prev.scopeKey !== requestScopeKey) return prev;
          return {
            ...prev,
            entries: coalesceTimelineEntries(prev.entries, page.items),
            nextPageToken: page.nextPageToken,
            loading: false,
          };
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeKeyRef.current !== requestScopeKey) return;
        setState((prev) => (prev.scopeKey === requestScopeKey ? { ...prev, loading: false } : prev));
      });
  }, [agent.id, agent.lineage, loadTimeline, scopeKey, state.loading, state.nextPageToken, state.scopeKey]);

  const matchesScope = state.scopeKey === scopeKey;
  const entries = matchesScope ? state.entries : [];
  const loading = matchesScope ? state.loading : Boolean(loadTimeline && agent.lineage === 'confirmed');
  const sourceUnavailable = matchesScope && state.sourceUnavailable;
  const rawReason = matchesScope ? state.sourceUnavailableReason : undefined;
  const friendlyReason = rawReason
    ? (SOURCE_UNAVAILABLE_COPY[rawReason] ?? rawReason)
    : '该子 Agent 暂无已验证的独立轨迹源；不会回退到父会话历史以免错标。';

  const sourceLabel = provenance
    ? EVIDENCE_SOURCE_LABELS[provenance.sourceKind]
    : isReadOnlySnapshotOnly
      ? '原生只读快照'
      : '来源未确认';

  return (
    <section
      data-testid="np05-child-timeline-panel"
      data-agent-id={agent.id}
      data-source-readonly={isReadOnlySnapshotOnly ? 'true' : 'false'}
      aria-label={`子 Agent ${displayName} 独立时间线`}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="inline-flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]"
            data-testid="np05-child-source-badge"
          >
            {isReadOnlySnapshotOnly ? (
              <Eye size={11} className="text-[var(--accent-clay)]" aria-hidden="true" />
            ) : (
              <Radio size={11} className="text-[var(--accent-indigo)]" aria-hidden="true" />
            )}
            <span>
              来源：{sourceLabel}
              {isReadOnlySnapshotOnly ? '（只读）' : ''}
            </span>
          </span>
        </div>

        <button
          type="button"
          onClick={onBackToChat}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          <ArrowLeft size={10.5} aria-hidden="true" />
          <span>无原生子对话输入 · 回主 Agent 交互</span>
        </button>
      </div>

      <NativeTimeline
        entries={entries}
        scopeLabel={`${displayName} (${agent.id}) 独立轨迹`}
        loading={loading}
        hasMore={matchesScope && Boolean(state.nextPageToken)}
        onLoadMore={matchesScope && state.nextPageToken ? handleLoadMore : undefined}
        sourceNotProvided={sourceUnavailable}
        sourceUnavailableReason={friendlyReason}
      />

      <EvidenceDetails
        evidence={provenance}
        reasonCode={rawReason}
        label={`子 Agent ${agent.id} 来源与新鲜度`}
      />
    </section>
  );
}
