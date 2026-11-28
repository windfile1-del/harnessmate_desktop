import {
  normalizeAnyPluginSlotKey,
  type AnyPluginSlotKey,
  type Disposer,
  type InstalledPluginInfo,
  type PluginSlotContribution,
  type Session,
} from '@harnessmate/protocol';
import { Puzzle } from 'lucide-react';
import { useEffect } from 'react';
import { CheckpointTurnBadge } from '../../components/CheckpointControls';
import { FailoverInlineBanner } from '../../components/FailoverInlineBanner';
import { HtmlRenderCard } from '../../components/HtmlRenderCard';
import { TraitsPicker } from '../../components/TraitsPicker';
import { resolveHarnessMeta, resolveHarnessOptionDescriptors } from '../../lib/harness-meta';
import { listPluginPanels } from '../../lib/plugin-panels';
import { isActivePlugin } from '../../lib/triage';
import { shouldUseTrustedModuleMount } from '../../slots/BoundSessionSurface';
import { SandboxedPluginFrame } from '../../slots/SandboxedPluginFrame';
import { TrustedPluginModuleHost } from '../../slots/TrustedPluginModuleHost';
import { useSlotRegistry } from '../../slots/hooks';
import { useAppStore } from './store';

const CHAT_SCOPED_SLOTS = new Set<AnyPluginSlotKey>([
  'session.header.title',
  'composer.actions',
  'composer.traits',
  'chat.node',
  'chat.block',
  'chat.message.wrapper',
  'tool.result',
  'approval.detail',
]);

function collectChatSlots(
  plugin: InstalledPluginInfo,
): Array<PluginSlotContribution & { slot: AnyPluginSlotKey }> {
  const merged = new Map<string, PluginSlotContribution & { slot: AnyPluginSlotKey }>();
  for (const entry of [...(plugin.contributes.slots ?? []), ...(plugin.runtimeSlots ?? [])]) {
    const slot = normalizeAnyPluginSlotKey(entry.slot);
    if (!CHAT_SCOPED_SLOTS.has(slot)) continue;
    merged.set(`${slot}:${entry.id}`, { ...entry, slot });
  }
  return [...merged.values()];
}

/**
 * Slim slot synchronizer dedicated to the Chat plugin.
 * Deliberately excludes shell-only panels (DiffInspector, TerminalWorkspace,
 * OrchestratorBoard, HistoryImport, SessionSearch, SideChat, TriageInbox) so the
 * chat bundle never carries duplicate shell feature code.
 */
export function ChatSlotSync() {
  const plugins = useAppStore((state) => state.plugins);
  const registry = useSlotRegistry();

  useEffect(() => {
    const disposers: Disposer[] = [];

    disposers.push(
      registry.register({
        slot: 'composer.traits',
        id: 'message-studio-traits',
        pluginId: 'core.chat',
        pluginName: '会话正文',
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

    disposers.push(
      registry.register({
        slot: 'chat.block',
        id: 'message-studio-html-render',
        pluginId: 'core.chat',
        pluginName: '会话正文',
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

    disposers.push(
      registry.register({
        slot: 'chat.block',
        id: 'usage-failover-banner',
        pluginId: 'core.auto-failover',
        pluginName: 'Usage & Failover',
        title: '限额接力横幅',
        key: 'ext:failover.banner',
        order: 100,
        sourceKind: 'builtin',
        render: ({ session, block, onFailover }) => {
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
              sessionId={session.id}
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

    // V2 dataPanels composer actions
    const dataPanels = listPluginPanels(plugins);
    for (const contribution of dataPanels) {
      if (!contribution.panel.placements?.includes('composer_action')) continue;
      const plugin = plugins.find((p) => p.id === contribution.pluginId);
      const pluginName = plugin?.name ?? contribution.pluginId;
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

    // Plugin-contributed chat slots (honors `when.harnessKinds` and trusted-module mount)
    for (const plugin of plugins) {
      if (!isActivePlugin(plugin)) continue;
      const instanceId = plugin.instanceId ?? plugin.id;
      const revision = `${plugin.packageDigest ?? plugin.version}:${plugin.runId ?? 'decl'}`;
      for (const slotDef of collectChatSlots(plugin)) {
        const isCompactSlot =
          slotDef.slot === 'composer.actions' ||
          slotDef.slot === 'composer.traits' ||
          slotDef.slot === 'session.header.title';
        disposers.push(
          registry.register({
            slot: slotDef.slot,
            id: slotDef.id,
            pluginId: instanceId,
            pluginName: plugin.name,
            title: slotDef.title,
            order: slotDef.order ?? 500,
            key: slotDef.key,
            sourceKind: 'iframe',
            render: (rawProps) => {
              const recordProps = rawProps as Record<string, unknown>;
              const session = (recordProps.session as Session | null | undefined) ?? null;
              if (
                slotDef.when?.harnessKinds?.length &&
                (!session || !slotDef.when.harnessKinds.includes(session.harnessKind))
              ) {
                return null;
              }
              if (shouldUseTrustedModuleMount(plugin, slotDef)) {
                return (
                  <TrustedPluginModuleHost
                    key={`mod:${instanceId}:${slotDef.slot}:${slotDef.id}:${revision}`}
                    pluginId={plugin.id}
                    instanceId={instanceId}
                    pluginName={plugin.name}
                    revision={revision}
                    slot={slotDef.slot}
                    slotId={slotDef.id}
                    title={slotDef.title}
                    modulePath={slotDef.module!}
                    session={session}
                    props={recordProps}
                    defaultHeight={slotDef.height}
                    compact={isCompactSlot}
                  />
                );
              }
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

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, [plugins, registry]);

  return null;
}
