import {
  normalizeAnyPluginSlotKey,
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
import { CheckpointTurnBadge } from '../components/CheckpointControls';
import { DiffInspectorPanel } from '../components/DiffInspectorPanel';
import { HtmlRenderCard } from '../components/HtmlRenderCard';
import { FailoverInlineBanner } from '../components/MessageStudio';
import { PluginDataPanel } from '../components/PluginDataPanel';
import { TraitsPicker } from '../components/TraitsPicker';
import { resolveHarnessMeta, resolveHarnessOptionDescriptors } from '../lib/harness-meta';
import { listPluginPanels } from '../lib/plugin-panels';
import { useAppStore } from '../stores/app-store';
import { useSlotRegistry } from './hooks';
import { SandboxedPluginFrame } from './SandboxedPluginFrame';

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

function isPluginActive(plugin: InstalledPluginInfo): boolean {
  return plugin.enabled && (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE');
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
export function PluginSlotSync() {
  const plugins = useAppStore((state) => state.plugins);
  const registry = useSlotRegistry();

  useEffect(() => {
    const disposers: Disposer[] = [];

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
              renderId={block.renderId}
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

      // 3. V4 manifest contributes.slots & isolated runtimeSlots -> sandboxed iframe
      const revision = `${plugin.packageDigest ?? plugin.version}:${plugin.runId ?? 'decl'}`;
      for (const slotDef of collectPluginIframeSlots(plugin)) {
        const isCompactSlot =
          slotDef.slot === 'statusbar.items' ||
          slotDef.slot === 'composer.actions' ||
          slotDef.slot === 'composer.traits' ||
          slotDef.slot === 'session.sidebar.badge' ||
          slotDef.slot === 'session.header.title';
        disposers.push(
          registry.register({
            slot: slotDef.slot,
            id: slotDef.id,
            pluginId: plugin.id,
            pluginName: plugin.name,
            title: slotDef.title,
            order: slotDef.order ?? 500,
            key: slotDef.key,
            sourceKind: 'iframe',
            render: (rawProps) => {
              const recordProps = rawProps as Record<string, unknown>;
              const session = (recordProps.session as Session | null | undefined) ?? null;
              return (
                <SandboxedPluginFrame
                  key={`${plugin.id}:${slotDef.slot}:${slotDef.id}:${revision}`}
                  pluginId={plugin.id}
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

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, [plugins, registry]);

  return null;
}
