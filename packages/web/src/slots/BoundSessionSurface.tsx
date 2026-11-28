import type { InstalledPluginInfo, PluginSlotContribution, Session } from '@harnessmate/protocol';
import { useMemo, useSyncExternalStore } from 'react';
import { getPluginInstanceId, resolveServiceSelectionClientSide } from '../api/peer-contracts';
import { layoutBridge } from '../kernel/layout-bridge';
import { useKernelStore } from '../stores/kernel-store';
import { SandboxedPluginFrame, type SandboxedPluginFrameProps } from './SandboxedPluginFrame';
import { TrustedPluginModuleHost } from './TrustedPluginModuleHost';

const PERSISTENT_SURFACES = new Set(['chat', 'requests-queue', 'agy-workbench', 'shell']);

export function shouldUseTrustedModuleMount(
  plugin: InstalledPluginInfo,
  contribution: Pick<PluginSlotContribution, 'module' | 'mountMode'>,
): boolean {
  if (!contribution.module) return false;
  if (contribution.mountMode === 'iframe') return false;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('hm_force_iframe_mount') === '1') {
      return false;
    }
  } catch {
    // ignore storage restrictions
  }
  // Only enabled/active plugins with a declared module entry use trusted-module mount;
  // external plugins installed via trusted code path share the exact same gate as bundled plugins.
  return plugin.enabled && (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE');
}

export function useBoundSessionPlugin(contract: string, session: Session | null) {
  const kernelState = useSyncExternalStore(
    useKernelStore.subscribe,
    useKernelStore.getState,
    useKernelStore.getState,
  );
  const {
    plugins,
    sessionBindingsBySession,
    workspaceBindingsByWorkspace,
    compositionBindings,
    compositionEntries,
  } = kernelState;
  const sessionBindings = session ? sessionBindingsBySession[session.id] : undefined;
  const layoutWs = layoutBridge.getState().selectedWorkspaceId;
  const workspaceId = session?.workspaceId ?? (typeof layoutWs === 'string' ? layoutWs : null);
  const workspaceBindings = workspaceId ? workspaceBindingsByWorkspace[workspaceId] : undefined;
  return useMemo(() => {
    const resolution = resolveServiceSelectionClientSide({
      contract,
      plugins,
      sessionBindings,
      workspaceBindings,
      compositionBindings,
      compositionEntries,
    });
    return resolution.status === 'ready'
      ? plugins.find((plugin) => getPluginInstanceId(plugin) === resolution.instanceId)
      : undefined;
  }, [contract, plugins, sessionBindings, workspaceBindings, compositionBindings, compositionEntries]);
}

export function BoundSessionSurface({
  plugin,
  surface,
  session,
  props,
  onAction,
  defaultHeight,
  onLoadError,
}: Pick<SandboxedPluginFrameProps, 'session' | 'props' | 'onAction' | 'defaultHeight'> & {
  plugin: ReturnType<typeof useBoundSessionPlugin>;
  surface: string;
  onLoadError?: (message: string) => void;
}) {
  const contribution = plugin?.contributes.slots?.find(({ id, ui }) => id === surface && Boolean(ui));
  if (!plugin || !contribution?.ui) return null;
  if (
    contribution.when?.harnessKinds?.length &&
    (!session || !contribution.when.harnessKinds.includes(session.harnessKind))
  ) {
    return null;
  }
  const instanceId = getPluginInstanceId(plugin);
  const revision = plugin.runId ?? plugin.packageDigest ?? plugin.version;
  const normalizedSlot = contribution.slot === 'inspector.tab' ? 'inspector.tabs' : contribution.slot;
  const surfaceKey = PERSISTENT_SURFACES.has(surface)
    ? `${instanceId}:${revision}:${surface}`
    : `${instanceId}:${revision}:${session?.id ?? ''}:${surface}`;

  if (shouldUseTrustedModuleMount(plugin, contribution)) {
    return (
      <TrustedPluginModuleHost
        key={`mod:${surfaceKey}`}
        pluginId={plugin.id}
        instanceId={instanceId}
        pluginName={plugin.name}
        revision={revision}
        slot={normalizedSlot}
        slotId={surface}
        title={contribution.title ?? plugin.name}
        modulePath={contribution.module!}
        session={session}
        props={props}
        onAction={onAction}
        defaultHeight={defaultHeight}
        compact
        onLoadError={onLoadError}
      />
    );
  }

  return (
    <SandboxedPluginFrame
      key={`ifr:${surfaceKey}`}
      pluginId={plugin.id}
      instanceId={instanceId}
      pluginName={plugin.name}
      revision={revision}
      slot={normalizedSlot}
      slotId={surface}
      title={contribution.title ?? plugin.name}
      ui={contribution.ui}
      session={session}
      props={props}
      onAction={onAction}
      defaultHeight={defaultHeight}
      compact
      onLoadError={onLoadError}
    />
  );
}
