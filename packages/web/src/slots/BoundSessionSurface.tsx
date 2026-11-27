import type { Session } from '@harnessmate/protocol';
import { useMemo } from 'react';
import { getPluginInstanceId, resolveServiceSelectionClientSide } from '../api/peer-contracts';
import { useAppStore } from '../stores/app-store';
import { SandboxedPluginFrame, type SandboxedPluginFrameProps } from './SandboxedPluginFrame';

export function useBoundSessionPlugin(contract: string, session: Session | null) {
  const plugins = useAppStore((state) => state.plugins);
  const sessionBindings = useAppStore((state) => session ? state.sessionBindingsBySession[session.id] : undefined);
  const workspaceBindings = useAppStore((state) => {
    const workspaceId = session?.workspaceId ?? state.selectedWorkspaceId;
    return workspaceId ? state.workspaceBindingsByWorkspace[workspaceId] : undefined;
  });
  const compositionBindings = useAppStore((state) => state.compositionBindings);
  const compositionEntries = useAppStore((state) => state.compositionEntries);
  return useMemo(() => {
    const resolution = resolveServiceSelectionClientSide({
      contract, plugins, sessionBindings, workspaceBindings, compositionBindings, compositionEntries,
    });
    return resolution.status === 'ready'
      ? plugins.find((plugin) => getPluginInstanceId(plugin) === resolution.instanceId)
      : undefined;
  }, [contract, plugins, sessionBindings, workspaceBindings, compositionBindings, compositionEntries]);
}

export function BoundSessionSurface({
  plugin, surface, session, props, onAction, defaultHeight,
}: Pick<SandboxedPluginFrameProps, 'session' | 'props' | 'onAction' | 'defaultHeight'> & {
  plugin: ReturnType<typeof useBoundSessionPlugin>;
  surface: string;
}) {
  const contribution = plugin?.contributes.slots?.find(({ id, ui }) => id === surface && Boolean(ui));
  if (!plugin || !contribution?.ui) return null;
  const instanceId = getPluginInstanceId(plugin);
  const revision = plugin.runId ?? plugin.packageDigest ?? plugin.version;
  return (
    <SandboxedPluginFrame
      key={`${instanceId}:${revision}:${session?.id ?? ''}:${surface}`}
      pluginId={plugin.id}
      instanceId={instanceId}
      pluginName={plugin.name}
      revision={revision}
      slot={contribution.slot === 'inspector.tab' ? 'inspector.tabs' : contribution.slot}
      slotId={surface}
      title={contribution.title ?? plugin.name}
      ui={contribution.ui}
      session={session}
      props={props}
      onAction={onAction}
      defaultHeight={defaultHeight}
      compact
    />
  );
}
