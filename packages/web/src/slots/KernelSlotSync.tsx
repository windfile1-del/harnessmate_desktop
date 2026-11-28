import {
  normalizeAnyPluginSlotKey,
  type AnyPluginSlotKey,
  type Disposer,
  type InstalledPluginInfo,
  type PluginSlotContribution,
  type Session,
} from '@harnessmate/protocol';
import { useEffect } from 'react';
import {
  AGY_WORKBENCH_CONTRACT,
  APPLICATION_SHELL_SLOT,
  GIT_WORKSPACE_CONTRACT,
  TERMINAL_WORKSPACE_CONTRACT,
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_RULES_CONTRACT,
  pluginProvidesContract,
  resolveServiceSelectionClientSide,
} from '../api/peer-contracts';
import { layoutBridge } from '../kernel/layout-bridge';
import { useKernelStore } from '../stores/kernel-store';
import { shouldUseTrustedModuleMount } from './BoundSessionSurface';
import { useSlotRegistry } from './hooks';
import { SandboxedPluginFrame } from './SandboxedPluginFrame';
import type { SlotRegistry } from './slot-registry';
import { TrustedPluginModuleHost } from './TrustedPluginModuleHost';

const SINGLE_OWNER_SLOTS: Partial<Record<AnyPluginSlotKey, string>> = {
  'inspector.diff': GIT_WORKSPACE_CONTRACT,
  'inspector.files': WORKSPACE_FILES_CONTRACT,
  'inspector.rules': WORKSPACE_RULES_CONTRACT,
  'session.stage.embedded': AGY_WORKBENCH_CONTRACT,
};

function isActivePlugin(plugin: InstalledPluginInfo): boolean {
  return plugin.enabled && (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE');
}

export function collectDeclarativePluginSlots(
  plugin: InstalledPluginInfo,
): Array<PluginSlotContribution & { slot: AnyPluginSlotKey }> {
  const merged = new Map<string, PluginSlotContribution & { slot: AnyPluginSlotKey }>();
  for (const entry of [...(plugin.contributes.slots ?? []), ...(plugin.runtimeSlots ?? [])]) {
    const slot = normalizeAnyPluginSlotKey(entry.slot);
    if (slot === APPLICATION_SHELL_SLOT) continue;
    merged.set(`${slot}:${entry.id}`, { ...entry, slot });
  }
  return [...merged.values()];
}

export function registerDeclarativePluginSlots(
  registry: SlotRegistry,
  plugins: InstalledPluginInfo[],
  preferredSingleSlotOwners?: Partial<Record<AnyPluginSlotKey, string | null>>,
): Disposer[] {
  const disposers: Disposer[] = [];
  for (const plugin of plugins) {
    if (!isActivePlugin(plugin)) continue;
    const instanceId = plugin.instanceId ?? plugin.id;
    const revision = `${plugin.packageDigest ?? plugin.version}:${plugin.runId ?? 'decl'}`;
    for (const slotDef of collectDeclarativePluginSlots(plugin)) {
      const slotContract = SINGLE_OWNER_SLOTS[slotDef.slot];
      const preferredOwner = preferredSingleSlotOwners?.[slotDef.slot];
      if (
        slotContract &&
        preferredOwner &&
        pluginProvidesContract(plugin, slotContract) &&
        preferredOwner !== instanceId
      ) {
        continue;
      }
      if (
        slotDef.slot === 'inspector.tabs' &&
        (slotDef.key === 'terminal-workspace' || slotDef.id === 'terminal-workspace') &&
        preferredOwner &&
        pluginProvidesContract(plugin, TERMINAL_WORKSPACE_CONTRACT) &&
        preferredOwner !== instanceId
      ) {
        continue;
      }
      const resolvedOrder =
        preferredOwner === instanceId
          ? Math.min(slotDef.order ?? 500, 50)
          : (slotDef.order ?? 500);
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
          order: resolvedOrder,
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
  return disposers;
}

/**
 * Pure kernel slot synchronizer: projects declarative and runtime plugin UI slots
 * into the typed SlotRegistry without importing any business components or app-store.
 */
export function KernelSlotSync() {
  const plugins = useKernelStore((state) => state.plugins);
  const compositionEntries = useKernelStore((state) => state.compositionEntries);
  const compositionBindings = useKernelStore((state) => state.compositionBindings);
  const workspaceBindingsByWorkspace = useKernelStore((state) => state.workspaceBindingsByWorkspace);
  const sessionBindingsBySession = useKernelStore((state) => state.sessionBindingsBySession);
  const registry = useSlotRegistry();

  useEffect(() => {
    const layout = layoutBridge.getState();
    const selectedSessionId = typeof layout.selectedSessionId === 'string' ? layout.selectedSessionId : null;
    const activeWorkspaceId = typeof layout.selectedWorkspaceId === 'string' ? layout.selectedWorkspaceId : null;
    const workspaceBindings = activeWorkspaceId ? workspaceBindingsByWorkspace[activeWorkspaceId] : undefined;
    const sessionBindings = selectedSessionId ? sessionBindingsBySession[selectedSessionId] : undefined;

    const resolveContract = (contract: string) =>
      resolveServiceSelectionClientSide({
        contract,
        plugins,
        sessionBindings,
        workspaceBindings,
        compositionBindings,
        compositionEntries,
      });

    const preferredSingleSlotOwners: Partial<Record<AnyPluginSlotKey, string | null>> = {
      'inspector.diff': resolveContract(GIT_WORKSPACE_CONTRACT).instanceId,
      'inspector.files': resolveContract(WORKSPACE_FILES_CONTRACT).instanceId,
      'inspector.rules': resolveContract(WORKSPACE_RULES_CONTRACT).instanceId,
      'session.stage.embedded': resolveContract(AGY_WORKBENCH_CONTRACT).instanceId,
      'inspector.tabs': resolveContract(TERMINAL_WORKSPACE_CONTRACT).instanceId,
    };

    const disposers = registerDeclarativePluginSlots(registry, plugins, preferredSingleSlotOwners);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [plugins, compositionEntries, compositionBindings, workspaceBindingsByWorkspace, sessionBindingsBySession, registry]);

  return null;
}
