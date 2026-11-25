import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CapabilityDescriptor,
  NativeAgentId,
  NativeWorkflowResourcePageResponse,
  WorkflowId,
} from '../../../../lib/native-client';
import {
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EVIDENCE_SOURCE_LABELS,
  EvidenceDetails,
} from '../shared';
import {
  SWARM_OFFICIAL_CLI_BOARD_HINT,
  SWARM_OFFICIAL_DOC_URL,
  groupBoardPostsIntoThreads,
  parseBoardResourcePosts,
  resolveSwarmBoardStatus,
  type SwarmBoardPostDto,
  type SwarmWorkflowEntity,
} from './swarm-view-model';

export interface SwarmBoardPanelProps {
  workflow: SwarmWorkflowEntity;
  bindingKey: string;
  boardCapability: CapabilityDescriptor | null;
  confirmedAgentIds: ReadonlySet<NativeAgentId>;
  loadWorkflowResource?: (
    workflowId: WorkflowId,
    resource: string,
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeWorkflowResourcePageResponse>;
  onJumpToWorker: (agentId: NativeAgentId) => void;
  onRefresh: () => void;
  onBackToChat: () => void;
}

interface BoardFetchState {
  scopeKey: string;
  posts: SwarmBoardPostDto[];
  loading: boolean;
  nextPageToken: string | null;
  hasMore: boolean;
  sourceUnavailableReason?: string;
}

function formatPostTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

/**
 * NP-08 Swarm Shared Board Panel.
 *
 * - Paginates verified Board posts by stable `postId` cursor via `loadWorkflowResource(workflowId, 'board')`.
 * - Cancels in-flight requests and immediately clears stale posts when workflow/binding changes.
 * - When ACP Board feed is missing or gated (`upstream_limited`, `gate_disabled`, `unknown`),
 *   honestly renders "当前 ACP 未提供 Board" + official `/swarm board` & `Alt+S` guidance.
 * - Strictly read-only: NEVER provides local Board post composers or auto `@mention` emitters.
 */
export function SwarmBoardPanel({
  workflow,
  bindingKey,
  boardCapability,
  confirmedAgentIds,
  loadWorkflowResource,
  onJumpToWorker,
  onRefresh,
  onBackToChat,
}: SwarmBoardPanelProps) {
  const scopeKey = `${bindingKey}:${workflow.id}:board`;
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<BoardFetchState>({
    scopeKey,
    posts: [],
    loading: false,
    nextPageToken: null,
    hasMore: false,
  });

  const shouldAttemptLoad = Boolean(
    loadWorkflowResource &&
      (workflow.detail.board.kind === 'known' && workflow.detail.board.value === 'available' ||
        workflow.detail.board.kind === 'stale'),
  );

  useEffect(() => {
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;

    if (!shouldAttemptLoad || !loadWorkflowResource) {
      setState({
        scopeKey,
        posts: [],
        loading: false,
        nextPageToken: null,
        hasMore: false,
      });
      return;
    }

    const requestScope = scopeKey;
    const controller = new AbortController();
    setState({
      scopeKey: requestScope,
      posts: [],
      loading: true,
      nextPageToken: null,
      hasMore: false,
    });

    void loadWorkflowResource(workflow.id, 'board', null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState({
          scopeKey: requestScope,
          posts: parseBoardResourcePosts(page),
          loading: false,
          nextPageToken: page.nextPageToken,
          hasMore: page.hasMore,
          sourceUnavailableReason: page.sourceUnavailableReason,
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState({
          scopeKey: requestScope,
          posts: [],
          loading: false,
          nextPageToken: null,
          hasMore: false,
          sourceUnavailableReason: 'board_resource_read_failed',
        });
      });

    return () => {
      controller.abort();
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
    };
  }, [scopeKey, shouldAttemptLoad, loadWorkflowResource, workflow.id]);

  const handleLoadMore = useCallback(() => {
    if (!loadWorkflowResource || !state.nextPageToken || state.loading || state.scopeKey !== scopeKey) {
      return;
    }
    const requestScope = scopeKey;
    const token = state.nextPageToken;
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    setState((prev) => (prev.scopeKey === requestScope ? { ...prev, loading: true } : prev));
    void loadWorkflowResource(workflow.id, 'board', token, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState((prev) => {
          if (prev.scopeKey !== requestScope) return prev;
          return {
            ...prev,
            posts: parseBoardResourcePosts(page, prev.posts),
            loading: false,
            nextPageToken: page.nextPageToken,
            hasMore: page.hasMore,
            sourceUnavailableReason: page.sourceUnavailableReason,
          };
        });
      })
      .catch(() => {
        if (controller.signal.aborted || activeScopeRef.current !== requestScope) return;
        setState((prev) => (prev.scopeKey === requestScope ? { ...prev, loading: false } : prev));
      });
  }, [loadWorkflowResource, state.nextPageToken, state.loading, state.scopeKey, scopeKey, workflow.id]);

  const matchesScope = state.scopeKey === scopeKey;
  const posts = matchesScope ? state.posts : [];
  const loading = matchesScope ? state.loading : shouldAttemptLoad;
  const unavailableReason = matchesScope ? state.sourceUnavailableReason : undefined;

  const boardStatus = useMemo(
    () => resolveSwarmBoardStatus(workflow, boardCapability, unavailableReason),
    [workflow, boardCapability, unavailableReason],
  );
  const threads = useMemo(() => groupBoardPostsIntoThreads(posts), [posts]);

  const toggleThread = (threadId: string) => {
    setExpandedThreads((prev) => ({ ...prev, [threadId]: prev[threadId] === false }));
  };

  const renderPost = (post: SwarmBoardPostDto, isReply: boolean) => {
    const canJumpAuthor = Boolean(post.authorAgentId && confirmedAgentIds.has(post.authorAgentId));
    return (
      <article
        key={post.postId}
        data-testid="np08-board-post"
        data-post-id={post.postId}
        className={`space-y-1.5 rounded-xl border border-[var(--border-hairline)] p-2.5 text-[11.5px] ${
          isReply ? 'ml-4 bg-[var(--bg-elevated)]' : 'bg-[var(--bg-surface)]'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-[var(--text-muted)]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-[var(--text-primary)]">
              {post.authorLabel ?? post.authorAgentId ?? '未知发布者'}
            </span>
            <span className="font-mono-code text-[10px]">{post.postId}</span>
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9.5px]">
              {EVIDENCE_SOURCE_LABELS[post.evidence.sourceKind]}
            </span>
            {post.truncated && (
              <span className="rounded bg-[var(--accent-clay-soft)] px-1.5 py-0.5 text-[9.5px] text-[var(--accent-clay)]">
                已截断
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono-code text-[10px]">{formatPostTime(post.createdAt)}</span>
            {canJumpAuthor && post.authorAgentId && (
              <button
                type="button"
                onClick={() => onJumpToWorker(post.authorAgentId!)}
                className="inline-flex cursor-pointer items-center gap-0.5 text-[10.5px] text-[var(--accent-indigo)] hover:underline"
              >
                <span>成员</span>
                <ArrowUpRight size={10} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <p className="whitespace-pre-wrap break-words leading-relaxed text-[var(--text-secondary)]">
          {post.summary}
        </p>
      </article>
    );
  };

  return (
    <div className="space-y-3" data-testid="np08-board-panel" data-board-status={boardStatus.status}>
      {/* Strict Read-only Notice */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1.5">
          <Eye size={12.5} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
          <span>Board 视图严格只读：不自动发送 @mention，不从文本伪造帖子或进度。</span>
        </span>
        <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
          {SWARM_OFFICIAL_CLI_BOARD_HINT}
        </span>
      </div>

      {/* Honest Degradation when Board Feed is Unavailable / Upstream Limited / Gate Disabled */}
      {boardStatus.status !== 'available' && (
        <CapabilityUnavailable
          title={boardStatus.title}
          gate={boardStatus.status === 'upstream_limited' ? 'upstream_limited' : 'unknown'}
          capabilityId="AGY-W05"
          reason={boardStatus.reason}
          officialEntryHint={SWARM_OFFICIAL_CLI_BOARD_HINT}
          officialDocUrl={SWARM_OFFICIAL_DOC_URL}
          onRefresh={onRefresh}
          onReadOnlyFallback={onBackToChat}
          readOnlyFallbackLabel="返回主聊天查看原始流"
        />
      )}

      {/* Paginated Thread & Post List (only when real verified posts exist) */}
      {loading && posts.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-[11.5px] text-[var(--text-muted)]">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          <span>正在按稳定 ID 读取 Board 帖子…</span>
        </div>
      ) : threads.length > 0 ? (
        <div className="space-y-2.5" data-testid="np08-board-thread-list">
          {threads.map((thread) => {
            const isExpanded = expandedThreads[thread.threadId] !== false;
            return (
              <section
                key={thread.threadId}
                data-testid="np08-board-thread"
                data-thread-id={thread.threadId}
                className="space-y-1.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5"
              >
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => toggleThread(thread.threadId)}
                    className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-[var(--text-primary)] hover:text-[var(--accent-indigo)]"
                  >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <MessageSquare size={12} className="text-[var(--accent-indigo)]" aria-hidden="true" />
                    <span className="font-mono-code text-[10.5px]">线程 {thread.threadId}</span>
                  </button>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {thread.replies.length} 条回复
                  </span>
                </div>

                {thread.rootPost && renderPost(thread.rootPost, false)}
                {isExpanded && thread.replies.map((reply) => renderPost(reply, true))}
              </section>
            );
          })}

          {matchesScope && state.hasMore && state.nextPageToken && (
            <div className="text-center">
              <button
                type="button"
                disabled={loading}
                data-testid="np08-board-load-more"
                onClick={handleLoadMore}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-[11px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
              >
                {loading && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
                <span>加载更多帖子（稳定 ID 分页）</span>
              </button>
            </div>
          )}
        </div>
      ) : boardStatus.status === 'available' ? (
        <div
          data-testid="np08-board-empty"
          className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-center text-[11.5px] text-[var(--text-muted)]"
        >
          <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
          <p className="mt-1 text-[10.5px]">{EMPTY_STATE_COPY.emptyListNotStopped}</p>
        </div>
      ) : null}

      <EvidenceDetails
        evidence={boardStatus.evidence}
        reasonCode={boardStatus.reasonCode}
        evidenceRefs={['AGY-W05']}
        label="Board 数据来源与边界证据"
      />
    </div>
  );
}
