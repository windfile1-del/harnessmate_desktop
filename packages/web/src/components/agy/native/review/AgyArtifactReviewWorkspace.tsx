import { FileCheck2, Globe, ListChecks, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CapabilityUnavailable, EntityStatusBadge, toneStyle } from '../shared';
import { BrowserAgentPanel } from './BrowserAgentPanel';
import { PlanAndDiffSeparationPanel } from './PlanAndDiffSeparationPanel';
import { SafeArtifactContentView } from './SafeArtifactContentView';
import type {
  ArtifactContentKind,
  ArtifactOriginKind,
  AgyArtifactReviewWorkspaceProps,
} from './types';

type WorkspaceTabId = 'artifacts' | 'plan_diff' | 'browser';

export function AgyArtifactReviewWorkspace({
  runtimeStatus,
  featureGates,
  artifacts,
  selectedArtifactId,
  selectedContent,
  reviewCapability,
  planSnapshot,
  toolDiffs = [],
  browserObservation,
  isNarrowViewport = false,
  onSelectArtifact,
  onLoadMoreArtifact,
  onRefresh,
  onSubmitLineComment,
  onSubmitApproval,
  onJumpToChildAgent,
}: AgyArtifactReviewWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>('artifacts');
  const [searchQuery, setSearchQuery] = useState('');
  const [originFilter, setOriginFilter] = useState<ArtifactOriginKind | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<ArtifactContentKind | 'all'>('all');
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    artifacts[0]?.artifactId ?? null,
  );

  const effectiveSelectedId = selectedArtifactId ?? internalSelectedId ?? artifacts[0]?.artifactId ?? null;

  const filteredArtifacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return artifacts.filter((item) => {
      if (originFilter !== 'all' && item.originKind !== originFilter) return false;
      if (kindFilter !== 'all' && item.contentKind !== kindFilter) return false;
      if (
        q &&
        !item.title.toLowerCase().includes(q) &&
        !item.artifactId.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [artifacts, originFilter, kindFilter, searchQuery]);

  const selectedSummary = useMemo(
    () =>
      filteredArtifacts.find((item) => item.artifactId === effectiveSelectedId) ??
      artifacts.find((item) => item.artifactId === effectiveSelectedId) ??
      filteredArtifacts[0] ??
      null,
    [filteredArtifacts, artifacts, effectiveSelectedId],
  );

  const handleSelect = (artifactId: string) => {
    setInternalSelectedId(artifactId);
    onSelectArtifact?.(artifactId);
  };

  if (!featureGates.nativeArtifactsEnabled) {
    return (
      <div data-testid="np14-workspace-gate-disabled" className="space-y-3 text-[12px]">
        <CapabilityUnavailable
          title="AGY 原生 Artifact & Review 工作台已关闭"
          gate="unsupported"
          capabilityId="AGY-W14"
          reason="当前原生 Artifact 工作台开关 (nativeArtifactsEnabled) 处于关闭状态；已有历史只读面板不受影响，或可在官方 Antigravity App / CLI 查看产物。"
          officialEntryHint="官方 Antigravity App Artifact Tab · CLI /artifact"
          officialDocUrl="https://antigravity.google/docs/cli/artifacts/"
          onRefresh={onRefresh}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="np14-artifact-review-workspace"
      data-narrow={String(isNarrowViewport)}
      className="space-y-3 text-[12px]"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <FileCheck2 size={15} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
            AGY Artifact & Review Workspace
          </h2>
          <EntityStatusBadge kind="runtime" status={runtimeStatus} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-full border px-2 py-0.5 text-[10px]"
            style={toneStyle(featureGates.reviewControlEnabled ? 'emerald' : 'muted')}
          >
            审阅控制: {featureGates.reviewControlEnabled ? '开' : '关(只读)'}
          </span>
          <span
            className="rounded-full border px-2 py-0.5 text-[10px]"
            style={toneStyle(featureGates.mediaArtifactsEnabled ? 'emerald' : 'muted')}
          >
            媒体参考: {featureGates.mediaArtifactsEnabled ? '开' : '关'}
          </span>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              aria-label="刷新产物列表"
              className="cursor-pointer rounded-lg border border-[var(--border-hairline)] p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <div
        role="tablist"
        aria-label="Artifact 工作台分区"
        className="flex flex-wrap gap-1.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'artifacts'}
          onClick={() => setActiveTab('artifacts')}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11.5px] font-medium ${
            activeTab === 'artifacts'
              ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo-soft)] text-[var(--accent-indigo)]'
              : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
          }`}
        >
          <FileCheck2 size={12.5} aria-hidden="true" />
          <span>产物与审阅 ({artifacts.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'plan_diff'}
          onClick={() => setActiveTab('plan_diff')}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11.5px] font-medium ${
            activeTab === 'plan_diff'
              ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo-soft)] text-[var(--accent-indigo)]'
              : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
          }`}
        >
          <ListChecks size={12.5} aria-hidden="true" />
          <span>计划与 Diff ({(planSnapshot?.steps.length ?? 0) + toolDiffs.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'browser'}
          onClick={() => setActiveTab('browser')}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11.5px] font-medium ${
            activeTab === 'browser'
              ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo-soft)] text-[var(--accent-indigo)]'
              : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'
          }`}
        >
          <Globe size={12.5} aria-hidden="true" />
          <span>Browser Agent ({browserObservation?.roles.length ?? 0})</span>
        </button>
      </div>

      {activeTab === 'artifacts' && (
        <div className={isNarrowViewport ? 'space-y-3' : 'grid grid-cols-1 gap-3 lg:grid-cols-12'}>
          <div className={isNarrowViewport ? 'space-y-2' : 'space-y-2 lg:col-span-5'}>
            <div className="space-y-2 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5">
              <div className="relative">
                <Search
                  size={12}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2 left-2.5 text-[var(--text-muted)]"
                />
                <input
                  type="search"
                  aria-label="过滤产物"
                  placeholder="搜索产物标题或 ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] py-1 pr-2.5 pl-7 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <select
                  aria-label="按来源过滤"
                  value={originFilter}
                  onChange={(e) => setOriginFilter(e.target.value as ArtifactOriginKind | 'all')}
                  className="flex-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                >
                  <option value="all">全部来源</option>
                  <option value="brain_session">Brain 产物</option>
                  <option value="teamwork_prompt">Teamwork Prompt</option>
                  <option value="dynamic_script">Dynamic 脚本</option>
                  <option value="dynamic_result">Dynamic 结果</option>
                  <option value="acp_plan">ACP 计划</option>
                  <option value="acp_tool_diff">ACP 工具 Diff</option>
                  <option value="browser_reference">Browser 参考</option>
                  <option value="history_snapshot">历史快照</option>
                </select>
                <select
                  aria-label="按格式过滤"
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value as ArtifactContentKind | 'all')}
                  className="flex-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                >
                  <option value="all">全部格式</option>
                  <option value="markdown">Markdown</option>
                  <option value="diff">Diff</option>
                  <option value="json">JSON</option>
                  <option value="script">脚本</option>
                  <option value="text">纯文本</option>
                  <option value="media_ref">媒体参考</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              {filteredArtifacts.length === 0 ? (
                <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]">
                  未观察到匹配的受控产物。
                </div>
              ) : (
                filteredArtifacts.map((art) => {
                  const isSelected = selectedSummary?.artifactId === art.artifactId;
                  return (
                    <button
                      key={art.artifactId}
                      type="button"
                      onClick={() => handleSelect(art.artifactId)}
                      className={`block w-full cursor-pointer rounded-xl border p-2.5 text-left transition-colors ${
                        isSelected
                          ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo-soft)]'
                          : 'border-[var(--border-hairline)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-[var(--text-primary)]">
                          {art.title}
                        </span>
                        <span className="shrink-0 font-mono-code text-[10px] text-[var(--text-muted)]">
                          rev {art.revision}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                        <span>{art.originKind}</span>
                        <span>·</span>
                        <span>{art.contentKind}</span>
                        <span>·</span>
                        <span>{art.scope.readOnly ? '只读' : '可审阅'}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className={isNarrowViewport ? '' : 'lg:col-span-7'}>
            {selectedSummary ? (
              <SafeArtifactContentView
                summary={selectedSummary}
                content={
                  selectedContent && selectedContent.artifactId === selectedSummary.artifactId
                    ? selectedContent
                    : null
                }
                runtimeStatus={runtimeStatus}
                featureGates={featureGates}
                reviewCapability={reviewCapability}
                onLoadMore={onLoadMoreArtifact}
                onSubmitLineComment={onSubmitLineComment}
                onSubmitApproval={onSubmitApproval}
                onRefresh={onRefresh}
              />
            ) : (
              <div className="rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-[11.5px] text-[var(--text-muted)]">
                选择一个受控产物以查看安全内容预览与来源证据。
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'plan_diff' && (
        <PlanAndDiffSeparationPanel
          planSnapshot={planSnapshot}
          toolDiffs={toolDiffs}
        />
      )}

      {activeTab === 'browser' && (
        <BrowserAgentPanel
          observation={browserObservation}
          onRefresh={onRefresh}
          onJumpToChildAgent={onJumpToChildAgent}
        />
      )}
    </div>
  );
}
