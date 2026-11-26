import {
  normalizeAnyPluginSlotKey,
  TRIAGE_INBOX_PLUGIN_ID,
  type AnyPluginSlotKey,
  type ApprovalRequest,
  type Disposer,
  type InstalledPluginInfo,
  type PluginPanel,
  type PluginSlotContribution,
  type Session,
} from '@harnessmate/protocol';
import { Puzzle, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { RuntimeRequestReceiptBlock } from '../components/ApprovalCenter';
import {
  AgyArtifactReviewPanel,
  AgyEcosystemPanel,
} from '../components/agy/AgyArtifactReviewPanel';
import { AgyComposerControls } from '../components/agy/AgyComposerControls';
import { AgySettingsSlot } from '../components/agy/AgySettingsSlot';
import { AgyStudioBlockCard } from '../components/agy/AgyStudioBlocks';
import {
  AgyWorkbenchShell,
  DEFAULT_WORKBENCH_ROUTE,
} from '../components/agy/native/shared';
import { CheckpointTurnBadge } from '../components/CheckpointControls';
import { ContextCompressionPanel } from '../components/ContextCompressionPanel';
import { DiffInspectorPanel } from '../components/DiffInspectorPanel';
import { HtmlRenderCard } from '../components/HtmlRenderCard';
import { FailoverInlineBanner } from '../components/MessageStudio';
import {
  OrchestratorCohortBlockCard,
  ParallelExecutionBoard,
} from '../components/OrchestratorBoard';
import { PluginDataPanel } from '../components/PluginDataPanel';
import { HistoryImportWorkspacePage } from '../components/HistoryImportWorkspacePage';
import { SessionSearchWorkspacePage } from '../components/SessionSearchWorkspacePage';
import { SideChatDrawer } from '../components/SideChatDrawer';
import {
  HISTORY_IMPORT_CONTRACT,
  HISTORY_IMPORT_PAGE_SLOT_ID,
  LEGACY_EXPLORER_PLUGIN_ID,
  SESSION_SEARCH_CONTRACT,
  SESSION_SEARCH_PAGE_SLOT_ID,
  getPluginInstanceId,
  isPluginInstanceReady,
  pluginProvidesContract,
} from '../api/peer-contracts';
import {
  TerminalStatusbarBadge,
  TerminalWorkspaceDrawer,
} from '../components/TerminalWorkspaceDrawer';
import { TraitsPicker } from '../components/TraitsPicker';
import { TriageSidebarBadge } from '../components/TriageInbox';
import { resolveHarnessMeta, resolveHarnessOptionDescriptors } from '../lib/harness-meta';
import { listPluginPanels } from '../lib/plugin-panels';
import { isActivePlugin as isPluginActive, isTriageEnabled } from '../lib/triage';
import { useAppStore } from '../stores/app-store';
import { useSlotRegistry } from './hooks';
import { SandboxedPluginFrame } from './SandboxedPluginFrame';
import type { SlotRegistry } from './slot-registry';

const V1_EVENT_LABELS = {
  'turn.completed': '完成',
  'turn.failed': '失败',
  'turn.cancelled': '取消',
} as const;

const V1_RESULT_LABELS = { pass: '通过', fail: '失败', unknown: '待确认' };

function V1PluginPanelAdapter({
  sessionId,
  panel,
}: {
  sessionId: string;
  panel: PluginPanel;
}) {
  const { eventsBySession, taskStateBySession, setDraftText, draftTextBySession } = useAppStore();
  const events = eventsBySession[sessionId];
  const taskState = taskStateBySession[sessionId];
  const draft = draftTextBySession[sessionId];

  const activity = useMemo(
    () =>
      (events ?? []).flatMap((event) => {
        if (!Object.hasOwn(V1_EVENT_LABELS, event.type) || event.payload.maintenance) return [];
        return [
          {
            seq: event.seq,
            time: event.createdAt,
            status: V1_EVENT_LABELS[event.type as keyof typeof V1_EVENT_LABELS],
          },
        ];
      }),
    [events],
  );
  const completed = activity.filter(({ status }) => status === '完成').length;
  const failed = activity.filter(({ status }) => status === '失败').length;

  return (
    <section className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[12px] text-[var(--text-secondary)]">
      <h3 className="font-semibold text-[var(--text-primary)]">{panel.title}</h3>
      {panel.description && <p>{panel.description}</p>}
      {panel.sections.includes('turns') && (
        <p>
          完成 {completed} · 失败 {failed} · 取消 {activity.length - completed - failed}
        </p>
      )}
      {panel.sections.includes('changed_files') && (
        <div>
          <h4 className="font-medium">已记录的改动文件</h4>
          {(taskState?.touchedFiles.length ?? 0) ? (
            <ul className="ml-4 list-disc break-all">
              {taskState?.touchedFiles.slice(-12).map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无记录</p>
          )}
        </div>
      )}
      {panel.sections.includes('verifications') && (
        <div>
          <h4 className="font-medium">验证结果</h4>
          {(taskState?.verifications.length ?? 0) ? (
            <ul className="ml-4 list-disc break-all">
              {taskState?.verifications.slice(-8).map((item, index) => (
                <li key={`${item.timestamp}:${index}`}>
                  {V1_RESULT_LABELS[item.status]} · <code>{item.command}</code>
                  {item.summary && <p>{item.summary}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无记录</p>
          )}
        </div>
      )}
      {panel.sections.includes('recent_activity') && (
        <div>
          <h4 className="font-medium">最近轮次</h4>
          {activity.length ? (
            <ul className="ml-4 list-disc">
              {activity
                .slice(-6)
                .reverse()
                .map(({ seq, time, status }) => (
                  <li key={seq}>
                    {status} · {new Date(time).toLocaleString()}
                  </li>
                ))}
            </ul>
          ) : (
            <p>暂无记录</p>
          )}
        </div>
      )}
      {panel.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {panel.actions.map(({ command, args, label }, index) => (
            <button
              key={index}
              type="button"
              disabled={Boolean(draft?.trim())}
              title={draft?.trim() ? '请先处理当前输入草稿' : `填入 /${command}`}
              className="rounded-lg border border-[var(--border-hairline)] px-2 py-1 hover:bg-[var(--bg-hover)] disabled:opacity-40"
              onClick={() => setDraftText(sessionId, `/${command} ${args ?? ''}`)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ApprovalAnnotationsDetail({ approval }: { approval: ApprovalRequest }) {
  const annotations = approval.annotations ?? [];
  if (annotations.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {annotations.map((note, idx) => (
        <div
          key={`${note.pluginId}:${idx}`}
          className="flex items-start gap-1.5 rounded-lg px-2 py-1 text-[11px]"
          style={{
            backgroundColor:
              note.risk === 'high'
                ? 'var(--accent-rose-soft)'
                : note.risk === 'medium'
                  ? 'var(--accent-star-soft)'
                  : 'var(--bg-elevated)',
            color:
              note.risk === 'high'
                ? 'var(--accent-rose)'
                : note.risk === 'medium'
                  ? 'var(--accent-star)'
                  : 'var(--text-secondary)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <ShieldAlert size={11.5} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <span className="font-medium">{note.label}</span>
            <span className="ml-1.5 font-mono-code text-[10px] opacity-75">({note.pluginId})</span>
            {note.detail && <div className="mt-0.5 text-[10.5px] opacity-90">{note.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function registerPluginIframeSlots(
  registry: SlotRegistry,
  plugins: InstalledPluginInfo[],
): Disposer[] {
  const disposers: Disposer[] = [];
  for (const plugin of plugins) {
    if (!isPluginActive(plugin)) continue;
    const instanceId = plugin.instanceId ?? plugin.id;
    const revision = `${plugin.packageDigest ?? plugin.version}:${plugin.runId ?? 'decl'}`;
    for (const slotDef of collectPluginIframeSlots(plugin)) {
      const isCompactSlot =
        slotDef.slot === 'statusbar.items' ||
        slotDef.slot === 'composer.actions' ||
        slotDef.slot === 'composer.traits' ||
        slotDef.slot === 'session.sidebar.badge' ||
        slotDef.slot === 'session.header.title';
      const pageTitle =
        slotDef.slot === 'workspace.pages' && instanceId !== plugin.id && !slotDef.title.includes(instanceId)
          ? `${slotDef.title} (${instanceId})`
          : slotDef.title;
      disposers.push(
        registry.register({
          slot: slotDef.slot,
          id: slotDef.id,
          pluginId: instanceId,
          pluginName: plugin.name,
          title: pageTitle,
          order: slotDef.order ?? 500,
          key: slotDef.key,
          sourceKind: 'iframe',
          render: (rawProps) => {
            const recordProps = rawProps as Record<string, unknown>;
            const session = (recordProps.session as Session | null | undefined) ?? null;
            return (
              <SandboxedPluginFrame
                key={`${instanceId}:${slotDef.slot}:${slotDef.id}:${revision}`}
                pluginId={plugin.id}
                instanceId={instanceId}
                pluginName={plugin.name}
                revision={revision}
                slot={slotDef.slot}
                slotId={slotDef.id}
                title={slotDef.title}
                ui={slotDef.ui}
                session={session}
                props={recordProps}
                defaultHeight={slotDef.height}
                compact={isCompactSlot}
              />
            );
          },
        }),
      );
    }
  }
  return disposers;
}

export function registerBatch1WorkspacePages(
  registry: SlotRegistry,
  plugins: InstalledPluginInfo[],
): Disposer[] {
  const disposers: Disposer[] = [];
  const hasIframePageSlot = (plugin: InstalledPluginInfo, targetSlotId: string): boolean =>
    collectPluginIframeSlots(plugin).some(
      (s) => s.slot === 'workspace.pages' && s.id === targetSlotId,
    );

  // Only register host fallback views if an active provider lacks its own `workspace.pages` UI slot.
  // Plugins supplying `ui/panel.html` (both bundled and 3rd-party custom UIs) are registered directly
  // via step 3 (`SandboxedPluginFrame`) without host-side React override.
  const activeImportProviders = plugins.filter(
    (plugin) =>
      isPluginInstanceReady(plugin) &&
      pluginProvidesContract(plugin, HISTORY_IMPORT_CONTRACT) &&
      !hasIframePageSlot(plugin, HISTORY_IMPORT_PAGE_SLOT_ID),
  );
  const activeSearchProviders = plugins.filter(
    (plugin) =>
      isPluginInstanceReady(plugin) &&
      pluginProvidesContract(plugin, SESSION_SEARCH_CONTRACT) &&
      !hasIframePageSlot(plugin, SESSION_SEARCH_PAGE_SLOT_ID),
  );

  for (const plugin of activeImportProviders) {
    const instanceId = getPluginInstanceId(plugin);
    const title =
      activeImportProviders.length > 1 || instanceId !== plugin.id
        ? `${plugin.name} (${instanceId})`
        : '历史导入';
    disposers.push(
      registry.register({
        slot: 'workspace.pages',
        id: HISTORY_IMPORT_PAGE_SLOT_ID,
        pluginId: instanceId,
        pluginName: plugin.name,
        title,
        order: 25,
        sourceKind: 'builtin',
        render: () => <HistoryImportWorkspacePage instanceId={instanceId} />,
      }),
    );
  }

  for (const plugin of activeSearchProviders) {
    const instanceId = getPluginInstanceId(plugin);
    const title =
      activeSearchProviders.length > 1 || instanceId !== plugin.id
        ? `${plugin.name} (${instanceId})`
        : '会话搜索';
    disposers.push(
      registry.register({
        slot: 'workspace.pages',
        id: SESSION_SEARCH_PAGE_SLOT_ID,
        pluginId: instanceId,
        pluginName: plugin.name,
        title,
        order: 20,
        sourceKind: 'builtin',
        render: () => <SessionSearchWorkspacePage instanceId={instanceId} />,
      }),
    );
  }

  const explorerPlugin = plugins.find((p) => p.id === LEGACY_EXPLORER_PLUGIN_ID);
  if (
    explorerPlugin &&
    isPluginActive(explorerPlugin) &&
    !plugins.some((p) => pluginProvidesContract(p, SESSION_SEARCH_CONTRACT)) &&
    !plugins.some((p) => pluginProvidesContract(p, HISTORY_IMPORT_CONTRACT))
  ) {
    disposers.push(
      registry.register({
        slot: 'workspace.pages',
        id: SESSION_SEARCH_PAGE_SLOT_ID,
        pluginId: LEGACY_EXPLORER_PLUGIN_ID,
        pluginName: explorerPlugin.name,
        title: '会话搜索',
        order: 20,
        sourceKind: 'builtin',
        render: () => <SessionSearchWorkspacePage instanceId={LEGACY_EXPLORER_PLUGIN_ID} />,
      }),
    );
    disposers.push(
      registry.register({
        slot: 'workspace.pages',
        id: HISTORY_IMPORT_PAGE_SLOT_ID,
        pluginId: LEGACY_EXPLORER_PLUGIN_ID,
        pluginName: explorerPlugin.name,
        title: '历史导入',
        order: 25,
        sourceKind: 'builtin',
        render: () => <HistoryImportWorkspacePage instanceId={LEGACY_EXPLORER_PLUGIN_ID} />,
      }),
    );
  }

  return disposers;
}

export function registerTriageBadge(registry: SlotRegistry, plugins: InstalledPluginInfo[]): Disposer | undefined {
  if (!isTriageEnabled(plugins)) return;
  return registry.register({
    slot: 'session.sidebar.badge',
    id: 'triage-inbox',
    pluginId: TRIAGE_INBOX_PLUGIN_ID,
    pluginName: '会话待办与命令面板',
    title: '会话待办状态',
    order: 10,
    sourceKind: 'builtin',
    render: ({ session }) => <TriageSidebarBadge session={session} />,
  });
}

function collectPluginIframeSlots(
  plugin: InstalledPluginInfo,
): Array<PluginSlotContribution & { slot: AnyPluginSlotKey }> {
  const merged = new Map<string, PluginSlotContribution & { slot: AnyPluginSlotKey }>();
  for (const entry of [...(plugin.contributes.slots ?? []), ...(plugin.runtimeSlots ?? [])]) {
    const slot = normalizeAnyPluginSlotKey(entry.slot);
    merged.set(`${slot}:${entry.id}`, { ...entry, slot });
  }
  return [...merged.values()];
}

/**
 * Effect-driven synchronizer that projects installed/active plugins (V1 panels, V2 dataPanels,
 * V4/V5 manifest/runtime iframe slots, and built-in adapters) into the typed UI SlotRegistry.
 */
function AgyNativeSidebarBadge({ session }: { session: Session }) {
  const slice = useAppStore((state) => state.nativeRuntimeBySession[session.id]);
  const pendingApprovals = useAppStore((state) => state.pendingApprovals);
  if (session.harnessKind !== 'agy' || !slice?.projection) return null;
  const runningCount = slice.projection.work.filter(
    (w) => w.state.kind === 'known' && (w.state.value === 'running' || w.state.value === 'waiting'),
  ).length;
  const pendingCount = pendingApprovals.filter(
    (a) => a.sessionId === session.id && a.status === 'pending',
  ).length;
  if (runningCount === 0 && pendingCount === 0 && slice.projection.status === 'attached') {
    return null;
  }
  return (
    <span
      data-testid="agy-native-sidebar-badge"
      title={`AGY 原生运行时：${runningCount} 活跃任务 · ${pendingCount} 待处理`}
      className="rounded px-1 py-0.2 font-mono-code text-[9.5px]"
      style={{
        backgroundColor:
          pendingCount > 0 ? 'var(--accent-star-soft)' : 'var(--accent-indigo-soft)',
        color: pendingCount > 0 ? 'var(--accent-star)' : 'var(--accent-indigo)',
      }}
    >
      {pendingCount > 0 ? `需操作 ${pendingCount}` : slice.projection.status === 'reconciling' ? '校准中' : `原生 ${runningCount}`}
    </span>
  );
}

function AgyNativeInspectorAdapter({ session }: { session: Session }) {
  const slice = useAppStore((state) => state.nativeRuntimeBySession[session.id]);
  const pendingApprovals = useAppStore((state) => state.pendingApprovals);
  const setRoute = useAppStore((state) => state.setNativeWorkbenchRoute);
  const hydrate = useAppStore((state) => state.hydrateNativeRuntime);
  const resolveRuntimeRequest = useAppStore((state) => state.resolveRuntimeRequest);
  const dispatchControl = useAppStore((state) => state.dispatchNativeControl);
  const loadNativeTimeline = useAppStore((state) => state.loadNativeTimeline);
  const loadNativeWorkflowResource = useAppStore((state) => state.loadNativeWorkflowResource);

  const stableLoadTimeline = useMemo(
    () => (scope: { kind: 'activity' | 'agent'; id: string }, pageToken?: string | null, signal?: AbortSignal) =>
      loadNativeTimeline(session.id, scope, pageToken, signal),
    [session.id, loadNativeTimeline],
  );
  const stableLoadWorkflowResource = useMemo(
    () => (workflowId: import('../lib/native-client').WorkflowId, resource: string, pageToken?: string | null, signal?: AbortSignal) =>
      loadNativeWorkflowResource(session.id, workflowId, resource, pageToken, signal),
    [session.id, loadNativeWorkflowResource],
  );

  if (session.harnessKind !== 'agy') {
    return (
      <div className="p-3 text-[12px] text-[var(--text-muted)]">
        AGY 原生工作台仅在 AGY 会话中可用。
      </div>
    );
  }

  const sessionPending = pendingApprovals.filter(
    (a) => a.sessionId === session.id && a.status === 'pending',
  );

  return (
    <div className="h-[520px] min-h-0">
      <AgyWorkbenchShell
        session={session}
        projection={slice?.projection ?? null}
        syncState={slice?.syncState ?? null}
        capabilities={slice?.capabilities ?? []}
        pendingApprovals={sessionPending}
        route={slice?.route ?? { ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={(patch) => setRoute(session.id, patch)}
        onBackToChat={() => setRoute(session.id, { surface: 'chat' })}
        onRefresh={() => void hydrate(session.id)}
        onResolveRequest={resolveRuntimeRequest}
        onDispatchControl={(req) => dispatchControl(session.id, req)}
        loadTimeline={stableLoadTimeline}
        loadWorkflowResource={stableLoadWorkflowResource}
      />
    </div>
  );
}

export function PluginSlotSync() {
  const plugins = useAppStore((state) => state.plugins);
  const agyNativeWorkbenchEnabled = useAppStore((state) => state.agyNativeWorkbenchEnabled);
  const registry = useSlotRegistry();

  useEffect(() => {
    const disposers: Disposer[] = [];
    const triageBadge = registerTriageBadge(registry, plugins);
    if (triageBadge) disposers.push(triageBadge);

    // Built-in chain adapter for approval risk annotations (P3 -> P4 UI integration)
    disposers.push(
      registry.register({
        slot: 'approval.detail',
        id: 'approval-annotations',
        pluginId: 'core.ui-approvals',
        pluginName: '审批风险标注',
        order: 900,
        sourceKind: 'builtin',
        render: ({ approval }) =>
          approval.annotations?.length ? <ApprovalAnnotationsDetail approval={approval} /> : null,
      }),
    );

    // Built-in V5 Message Studio: dynamic schema-driven TraitsPicker (composer.traits)
    disposers.push(
      registry.register({
        slot: 'composer.traits',
        id: 'message-studio-traits',
        pluginId: 'hm.plugin.message-studio',
        pluginName: 'Message Studio',
        title: '动态参数选择器',
        order: 100,
        sourceKind: 'builtin',
        render: ({ session, harness, disabled, values, onChange }) => {
          const descriptors = resolveHarnessOptionDescriptors(harness, session.model);
          return (
            <TraitsPicker
              descriptors={descriptors}
              values={values}
              disabled={disabled}
              onChange={onChange}
            />
          );
        },
      }),
    );

    // Built-in V5 Message Studio: sandboxed html_render card (chat.block)
    disposers.push(
      registry.register({
        slot: 'chat.block',
        id: 'message-studio-html-render',
        pluginId: 'hm.plugin.message-studio',
        pluginName: 'Message Studio',
        title: 'HTML 沙箱预览',
        key: 'html_render',
        order: 100,
        sourceKind: 'builtin',
        render: ({ block }) => {
          if (block.type !== 'html_render') return null;
          return (
            <HtmlRenderCard
              renderId={block.renderId ?? block.blockId}
              title={block.title}
              html={block.html}
              preferredHeightPx={block.preferredHeightPx}
              allowFullscreen={block.allowFullscreen}
            />
          );
        },
      }),
    );

    // Built-in V5 Usage & Failover: inline failover banner (chat.block)
    disposers.push(
      registry.register({
        slot: 'chat.block',
        id: 'usage-failover-banner',
        pluginId: 'hm.plugin.usage-failover',
        pluginName: 'Usage & Failover',
        title: '限额接力横幅',
        key: 'ext:failover.banner',
        order: 100,
        sourceKind: 'builtin',
        render: ({ block, onFailover }) => {
          if (block.type !== 'ext:failover.banner' || !('payload' in block)) return null;
          const store = useAppStore.getState();
          const p = block.payload as {
            failedInstanceId?: string;
            failureClass?: string;
            errorMessage?: string;
            resetsAt?: number | null;
          };
          return (
            <FailoverInlineBanner
              failedInstanceId={p.failedInstanceId ?? block.harnessInstanceId}
              failureClass={p.failureClass ?? 'usage_limit'}
              errorMessage={p.errorMessage ?? block.fallbackSummary ?? '达到速率限额'}
              resetsAt={p.resetsAt ?? null}
              harnesses={store.harnesses}
              accountUsage={store.accountUsage}
              failoverPolicy={store.failoverPolicy}
              onFailover={(targetId) => onFailover?.(targetId)}
            />
          );
        },
      }),
    );

    // Built-in V5 Git Checkpoints & Diff Inspector (`inspector.diff` + `chat.block` checkpoint_marker)
    const gitInspectorPlugin = plugins.find((p) => p.id === 'core.git-inspector');
    if (!gitInspectorPlugin || isPluginActive(gitInspectorPlugin)) {
      disposers.push(
        registry.register({
          slot: 'inspector.diff',
          id: 'git-diff-inspector',
          pluginId: 'core.git-inspector',
          pluginName: 'Git Checkpoints & Diff',
          title: 'Git 差异与检查点对比',
          order: 100,
          sourceKind: 'builtin',
          render: ({ session, git, onRefresh }) => (
            <DiffInspectorPanel session={session} git={git} onRefresh={onRefresh} />
          ),
        }),
      );

      disposers.push(
        registry.register({
          slot: 'chat.block',
          id: 'git-checkpoint-marker',
          pluginId: 'core.git-inspector',
          pluginName: 'Git Checkpoints & Diff',
          title: '轮次检查点徽章',
          key: 'checkpoint_marker',
          order: 100,
          sourceKind: 'builtin',
          render: ({ session, block }) => {
            if (block.type !== 'checkpoint_marker') return null;
            const store = useAppStore.getState();
            const harness = store.harnesses.find((h) => h.id === session.harnessId) ?? null;
            const meta = resolveHarnessMeta(
              { harnessId: session.harnessId, harnessKind: session.harnessKind },
              store.harnesses,
            );
            const supportsNativeRollback =
              store.supportsNativeRollbackBySession[session.id] ??
              Boolean(harness?.capabilitiesV2?.supportsNativeRollback);
            return (
              <CheckpointTurnBadge
                session={session}
                block={block}
                harnessLabel={meta.shortLabel || session.harnessId}
                supportsNativeRollback={supportsNativeRollback}
                onViewDiff={(checkpointId) => {
                  const checkpoints = store.checkpointsBySession[session.id] ?? [];
                  const pre = checkpoints.find(
                    (c) => c.phase === 'turn_pre' && c.turnSeq === block.turnSeq,
                  );
                  store.focusCheckpointDiff(
                    session.id,
                    pre?.checkpointId ?? checkpointId,
                    pre ? checkpointId : undefined,
                  );
                }}
                onRevert={async (mode, turnSeq) => {
                  await store.revertCheckpoint(session.id, { targetTurnSeq: turnSeq, mode });
                }}
              />
            );
          },
        }),
      );
    }

    // Built-in V5 Session Explorer: Side Chat (`inspector.tabs` key: `side-chat`) + Sidebar lineage badge (`session.sidebar.badge`)
    const explorerPlugin = plugins.find((p) => p.id === 'hm.plugin.session-explorer');
    if (!explorerPlugin || isPluginActive(explorerPlugin)) {
      disposers.push(
        registry.register({
          slot: 'inspector.tabs',
          id: 'side-chat',
          pluginId: 'hm.plugin.session-explorer',
          pluginName: 'Session Explorer',
          title: 'Side Chat 侧栏问答',
          key: 'side-chat',
          order: 120,
          sourceKind: 'builtin',
          render: ({ session }) => <SideChatDrawer session={session} />,
        }),
      );

      disposers.push(
        registry.register({
          slot: 'session.sidebar.badge',
          id: 'session-lineage-badge',
          pluginId: 'hm.plugin.session-explorer',
          pluginName: 'Session Explorer',
          title: '分支与导入徽标',
          order: 100,
          sourceKind: 'builtin',
          render: ({ session }) => {
            if (session.parentSessionId) {
              return (
                <span
                  title={`从父会话 ${session.parentSessionId} 分叉`}
                  className="rounded px-1 py-0.2 font-mono-code text-[9.5px]"
                  style={{
                    backgroundColor: 'var(--accent-indigo-soft)',
                    color: 'var(--accent-indigo)',
                  }}
                >
                  分支
                </span>
              );
            }
            if (session.importMode === 'mirror' || session.importMode === 'attach') {
              return (
                <span
                  title={`外部 CLI 导入 (${session.importSource ?? session.importMode})`}
                  className="rounded px-1 py-0.2 font-mono-code text-[9.5px]"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {session.importMode === 'mirror' ? '镜像' : '接管'}
                </span>
              );
            }
            return null;
          },
        }),
      );
    }

    // Built-in V5 Approval Center: historical read-only receipt (`chat.block` key: `runtime_request`)
    const approvalCenterPlugin = plugins.find((p) => p.id === 'hm.plugin.approval-center');
    if (!approvalCenterPlugin || isPluginActive(approvalCenterPlugin)) {
      disposers.push(
        registry.register({
          slot: 'chat.block',
          id: 'approval-center-receipt',
          pluginId: 'hm.plugin.approval-center',
          pluginName: 'Approval Center',
          title: '审批与凭据回执卡',
          key: 'runtime_request',
          order: 100,
          sourceKind: 'builtin',
          render: ({ block }) => {
            if (block.type !== 'runtime_request') return null;
            return (
              <RuntimeRequestReceiptBlock
                kind={block.kind}
                title={block.title}
                receiptText={block.receiptText}
                requestStatus={block.requestStatus}
                resolvedBy={block.resolvedBy}
              />
            );
          },
        }),
      );
    }

    // Built-in V5 Optional Multi-Harness Parallel Orchestrator (`inspector.tabs` key: `orchestrator-board` + `chat.block` key: `ext:orchestrator.cohort`)
    const orchestratorPlugin = plugins.find((p) => p.id === 'hm.plugin.multi-harness-orchestrator');
    if (orchestratorPlugin && isPluginActive(orchestratorPlugin)) {
      disposers.push(
        registry.register({
          slot: 'inspector.tabs',
          id: 'orchestrator-board',
          pluginId: 'hm.plugin.multi-harness-orchestrator',
          pluginName: 'Multi-Harness Orchestrator',
          title: '并行编排看板',
          key: 'orchestrator-board',
          order: 90,
          sourceKind: 'builtin',
          render: ({ session }) => <ParallelExecutionBoard session={session} />,
        }),
      );

      disposers.push(
        registry.register({
          slot: 'chat.block',
          id: 'orchestrator-cohort-card',
          pluginId: 'hm.plugin.multi-harness-orchestrator',
          pluginName: 'Multi-Harness Orchestrator',
          title: '并行协作批次摘要卡',
          key: 'ext:orchestrator.cohort',
          order: 100,
          sourceKind: 'builtin',
          render: ({ block }) => {
            if (block.type !== 'ext:orchestrator.cohort' || !('payload' in block)) return null;
            const store = useAppStore.getState();
            return (
              <OrchestratorCohortBlockCard
                block={block}
                harnesses={store.harnesses}
                onReviewMerge={(sub) => void store.openSubagentMergeReview(sub)}
                onOpenChildSession={(childId) => void store.selectSession(childId)}
              />
            );
          },
        }),
      );
    }

    // Built-in V5 Optional AI Context Compression & Symbol Index (`inspector.tabs` key: `context-compression`)
    const compressionPlugin = plugins.find((p) => p.id === 'hm.plugin.context-compression');
    if (compressionPlugin && isPluginActive(compressionPlugin)) {
      disposers.push(
        registry.register({
          slot: 'inspector.tabs',
          id: 'context-compression',
          pluginId: 'hm.plugin.context-compression',
          pluginName: 'Context Compression',
          title: '上下文压缩与符号索引',
          key: 'context-compression',
          order: 95,
          sourceKind: 'builtin',
          render: ({ session }) => <ContextCompressionPanel session={session} />,
        }),
      );
    }

    // Built-in V5 Optional Integrated PTY Terminal & Context Chips (`inspector.tabs` key: `terminal-workspace` + `statusbar.items`)
    const terminalWorkspacePlugin = plugins.find((p) => p.id === 'hm.plugin.terminal-workspace');
    if (terminalWorkspacePlugin && isPluginActive(terminalWorkspacePlugin)) {
      disposers.push(
        registry.register({
          slot: 'inspector.tabs',
          id: 'terminal-workspace',
          pluginId: 'hm.plugin.terminal-workspace',
          pluginName: 'Integrated Terminal Workspace',
          title: '集成终端',
          key: 'terminal-workspace',
          order: 85,
          sourceKind: 'builtin',
          render: ({ session }) => <TerminalWorkspaceDrawer session={session} />,
        }),
      );

      disposers.push(
        registry.register({
          slot: 'statusbar.items',
          id: 'terminal-workspace-count',
          pluginId: 'hm.plugin.terminal-workspace',
          pluginName: 'Integrated Terminal Workspace',
          title: '托管终端计数',
          order: 100,
          sourceKind: 'builtin',
          render: ({ session }) => <TerminalStatusbarBadge session={session} />,
        }),
      );
    }

    // Built-in V5 Antigravity Native Experience & Account Isolation slots
    const agyHarnessPlugin = plugins.find((p) => p.id === 'core.harness.agy');
    if (!agyHarnessPlugin || isPluginActive(agyHarnessPlugin)) {
      disposers.push(
        registry.register({
          slot: 'harness.settings',
          id: 'agy-account-settings',
          pluginId: 'core.harness.agy',
          pluginName: 'Antigravity (AGY)',
          title: 'AGY 多账号隔离与官方认证',
          key: 'agy',
          order: 50,
          sourceKind: 'builtin',
          render: ({ harness, onRefresh }) => <AgySettingsSlot harness={harness} onRefresh={onRefresh} />,
        }),
      );

      disposers.push(
        registry.register({
          slot: 'composer.actions',
          id: 'agy-composer-controls',
          pluginId: 'core.harness.agy',
          pluginName: 'Antigravity (AGY)',
          title: 'AGY 原生控制条与手动切换',
          order: 60,
          sourceKind: 'builtin',
          render: ({ session, isRunning }) => (
            <AgyComposerControls session={session} isRunning={isRunning} />
          ),
        }),
      );

      const agyBlockSpecs: ReadonlyArray<{
        id: string;
        key:
          | 'ext:agy.plan'
          | 'ext:agy.subagent_batch'
          | 'ext:agy.background_task'
          | 'ext:agy.artifact_card'
          | 'ext:agy.goal_status';
        title: string;
      }> = [
        { id: 'agy-block-plan', key: 'ext:agy.plan', title: 'AGY Plan 卡片' },
        { id: 'agy-block-subagent', key: 'ext:agy.subagent_batch', title: 'AGY 子 Agent 批次卡' },
        { id: 'agy-block-background', key: 'ext:agy.background_task', title: 'AGY 后台任务卡' },
        { id: 'agy-block-artifact', key: 'ext:agy.artifact_card', title: 'AGY Artifact 摘要卡' },
        { id: 'agy-block-goal', key: 'ext:agy.goal_status', title: 'AGY Goal 状态卡' },
      ];

      for (const spec of agyBlockSpecs) {
        disposers.push(
          registry.register({
            slot: 'chat.block',
            id: spec.id,
            pluginId: 'core.harness.agy',
            pluginName: 'Antigravity (AGY)',
            title: spec.title,
            key: spec.key,
            order: 95,
            sourceKind: 'builtin',
            render: ({ session, block }) => {
              if (
                block.type !== 'ext:agy.plan' &&
                block.type !== 'ext:agy.subagent_batch' &&
                block.type !== 'ext:agy.background_task' &&
                block.type !== 'ext:agy.artifact_card' &&
                block.type !== 'ext:agy.goal_status'
              ) {
                return null;
              }
              return <AgyStudioBlockCard session={session} block={block} />;
            },
          }),
        );
      }

      disposers.push(
        registry.register({
          slot: 'inspector.tabs',
          id: 'agy-artifacts',
          pluginId: 'core.harness.agy',
          pluginName: 'Antigravity (AGY)',
          title: 'Artifact 审阅',
          key: 'agy-artifacts',
          order: 85,
          sourceKind: 'builtin',
          render: ({ session }) => <AgyArtifactReviewPanel session={session} />,
        }),
      );

      disposers.push(
        registry.register({
          slot: 'inspector.tabs',
          id: 'agy-ecosystem',
          pluginId: 'core.harness.agy',
          pluginName: 'Antigravity (AGY)',
          title: 'AGY 生态边界',
          key: 'agy-ecosystem',
          order: 88,
          sourceKind: 'builtin',
          render: ({ session }) => <AgyEcosystemPanel session={session} />,
        }),
      );

      if (agyNativeWorkbenchEnabled) {
        disposers.push(
          registry.register({
            slot: 'inspector.tabs',
            id: 'agy-native-runtime',
            pluginId: 'core.harness.agy',
            pluginName: 'Antigravity (AGY)',
            title: 'AGY Native Runtime',
            key: 'agy-native-runtime',
            order: 80,
            sourceKind: 'builtin',
            render: ({ session }) => <AgyNativeInspectorAdapter session={session} />,
          }),
        );

        disposers.push(
          registry.register({
            slot: 'session.sidebar.badge',
            id: 'agy-native-runtime-badge',
            pluginId: 'core.harness.agy',
            pluginName: 'Antigravity (AGY)',
            title: 'AGY 原生运行时状态徽标',
            order: 40,
            sourceKind: 'builtin',
            render: ({ session }) => <AgyNativeSidebarBadge session={session} />,
          }),
        );
      }
    }

    // 1. V2 dataPanels -> inspector.tabs, sidebar.tools, composer.actions
    const dataPanels = listPluginPanels(plugins);
    for (const contribution of dataPanels) {
      const plugin = plugins.find((p) => p.id === contribution.pluginId);
      const pluginName = plugin?.name ?? contribution.pluginId;

      disposers.push(
        registry.register({
          slot: 'inspector.tabs',
          id: contribution.panel.id,
          pluginId: contribution.pluginId,
          pluginName,
          title: contribution.panel.title,
          order: 300,
          sourceKind: 'v2-data-panel',
          render: ({ session }) => (
            <PluginDataPanel
              key={`${session.id}:${contribution.key}:${contribution.revision}`}
              sessionId={session.id}
              contribution={contribution}
            />
          ),
        }),
      );

      if (contribution.panel.placements?.includes('sidebar_tool')) {
        disposers.push(
          registry.register({
            slot: 'sidebar.tools',
            id: `sidebar-${contribution.panel.id}`,
            pluginId: contribution.pluginId,
            pluginName,
            title: contribution.panel.title,
            order: 300,
            sourceKind: 'v2-data-panel',
            render: ({ session }) => {
              const store = useAppStore.getState();
              const targetSession =
                session ??
                store.sessions.find(
                  ({ workspaceId }) => !store.selectedWorkspaceId || workspaceId === store.selectedWorkspaceId,
                );
              if (!targetSession) return null;
              return (
                <button
                  type="button"
                  className="block w-full cursor-pointer truncate rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  onClick={() => {
                    if (targetSession.id !== store.selectedSessionId) {
                      void store.selectSession(targetSession.id);
                    }
                    store.openPluginPanel(contribution.key);
                  }}
                >
                  {contribution.panel.title}
                </button>
              );
            },
          }),
        );
      }

      if (contribution.panel.placements?.includes('composer_action')) {
        disposers.push(
          registry.register({
            slot: 'composer.actions',
            id: `composer-${contribution.panel.id}`,
            pluginId: contribution.pluginId,
            pluginName,
            title: contribution.panel.title,
            order: 300,
            sourceKind: 'v2-data-panel',
            render: () => (
              <button
                type="button"
                title={`打开插件面板 ${contribution.panel.title}`}
                onClick={() => useAppStore.getState().openPluginPanel(contribution.key)}
                className="inline-flex h-7 max-w-36 cursor-pointer items-center gap-1 truncate rounded-lg px-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <Puzzle size={11.5} className="shrink-0 text-[var(--accent-indigo)]" />
                <span className="truncate">{contribution.panel.title}</span>
              </button>
            ),
          }),
        );
      }
    }

    // 2b. Batch 1 History Import (`history.import.v1`) & Session Search (`session.search.v1`) workspace pages
    disposers.push(...registerBatch1WorkspacePages(registry, plugins));

    // 2. V1 panels -> inspector.tabs
    for (const plugin of plugins) {
      if (!isPluginActive(plugin)) continue;
      for (const panel of plugin.contributes.panels ?? []) {
        disposers.push(
          registry.register({
            slot: 'inspector.tabs',
            id: panel.id,
            pluginId: plugin.id,
            pluginName: plugin.name,
            title: panel.title,
            order: 400,
            sourceKind: 'v1-panel',
            render: ({ session }) => <V1PluginPanelAdapter sessionId={session.id} panel={panel} />,
          }),
        );
      }
    }

    // 3. V4/V5 manifest contributes.slots & isolated runtimeSlots -> sandboxed iframe
    disposers.push(...registerPluginIframeSlots(registry, plugins));

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, [plugins, agyNativeWorkbenchEnabled, registry]);

  return null;
}
