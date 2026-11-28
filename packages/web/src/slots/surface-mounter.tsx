import type { AnyPluginSlotKey, Disposer, PublicSession, Session, PluginSlotRenderFailure } from '@harnessmate/protocol';
import { createRoot, type Root } from 'react-dom/client';
import { getPluginInstanceId, resolveServiceSelectionClientSide } from '../api/peer-contracts';
import { useKernelStore } from '../stores/kernel-store';
import { BoundSessionSurface } from './BoundSessionSurface';
import { SlotRegistryProvider, SlotSessionProvider } from './hooks';
import { slotRegistry, type SlotRegistry } from './slot-registry';
import { SlotErrorBoundary } from './SlotRenderer';

export interface PublicSlotItemSummary {
  readonly registrationKey: string;
  readonly slot: AnyPluginSlotKey;
  readonly id: string;
  readonly instanceId: string;
  readonly pluginName: string;
  readonly title: string;
  readonly order?: number;
  readonly key?: string;
}

export interface MountedSurfaceHandle {
  update(next: { session?: PublicSession | Session | null; props?: Record<string, unknown> }): void;
  dispose(): void;
}

export interface PublicSurfacesApi {
  getRenderFailures(): readonly PluginSlotRenderFailure[];
  clearRenderFailure(id?: string): void;
  listSlots(
    slot: AnyPluginSlotKey,
    options?: { hasSession?: boolean; matchKey?: string },
  ): PublicSlotItemSummary[];
  onSlotsChanged(listener: () => void): Disposer;
  mountBoundSurface(
    container: HTMLElement,
    options: {
      contract: string;
      surface: string;
      session: PublicSession | Session | null;
      props?: Record<string, unknown>;
      defaultHeight?: number;
    },
  ): MountedSurfaceHandle;
  mountSlotItem(
    container: HTMLElement,
    options: {
      slot: AnyPluginSlotKey;
      instanceId: string;
      slotId: string;
      session?: PublicSession | Session | null;
      props?: Record<string, unknown>;
    },
  ): MountedSurfaceHandle;
}

function toSessionLike(session: PublicSession | Session | null | undefined): Session | null {
  if (!session) return null;
  return session as Session;
}

function BoundSurfaceWrapper({
  contract,
  surface,
  session,
  props,
  defaultHeight,
  registry,
}: {
  contract: string;
  surface: string;
  session: Session | null;
  props?: Record<string, unknown>;
  defaultHeight?: number;
  registry: SlotRegistry;
}) {
  const plugins = useKernelStore((state) => state.plugins);
  const sessionBindings = useKernelStore((state) =>
    session ? state.sessionBindingsBySession[session.id] : undefined,
  );
  const workspaceBindings = useKernelStore((state) =>
    session?.workspaceId ? state.workspaceBindingsByWorkspace[session.workspaceId] : undefined,
  );
  const compositionBindings = useKernelStore((state) => state.compositionBindings);
  const compositionEntries = useKernelStore((state) => state.compositionEntries);

  const resolution = resolveServiceSelectionClientSide({
    contract,
    plugins,
    sessionBindings,
    workspaceBindings,
    compositionBindings,
    compositionEntries,
  });
  const plugin =
    resolution.status === 'ready'
      ? plugins.find((item) => getPluginInstanceId(item) === resolution.instanceId)
      : undefined;

  if (!plugin) {
    return (
      <div
        role="status"
        className="flex h-full min-h-[120px] flex-1 items-center justify-center p-6 text-center text-[12.5px] text-[var(--text-secondary)]"
      >
        能力 {contract} 当前不可用（状态：{resolution.status}）。
      </div>
    );
  }

  return (
    <SlotRegistryProvider registry={registry}>
      <SlotSessionProvider session={session}>
        <div className="flex size-full min-h-0 min-w-0 flex-1 flex-col">
          <BoundSessionSurface
            plugin={plugin}
            surface={surface}
            session={session}
            props={props}
            defaultHeight={defaultHeight}
          />
        </div>
      </SlotSessionProvider>
    </SlotRegistryProvider>
  );
}

function SlotItemWrapper({
  slot,
  instanceId,
  slotId,
  session,
  props,
  registry,
}: {
  slot: AnyPluginSlotKey;
  instanceId: string;
  slotId: string;
  session: Session | null;
  props?: Record<string, unknown>;
  registry: SlotRegistry;
}) {
  const items = registry.getItems(slot, { hasSession: Boolean(session) });
  const item = items.find((candidate) => candidate.pluginId === instanceId && candidate.id === slotId);
  if (!item) {
    return (
      <div
        role="status"
        className="flex h-full min-h-[120px] flex-1 items-center justify-center p-6 text-center text-[12.5px] text-[var(--text-secondary)]"
      >
        插槽页面 {instanceId}:{slotId} 当前不可用或已停用。
      </div>
    );
  }
  const mergedProps = {
    ...(props ?? {}),
    session,
  } as Record<string, unknown>;
  return (
    <SlotRegistryProvider registry={registry}>
      <SlotSessionProvider session={session}>
        <div className="flex size-full min-h-0 min-w-0 flex-1 flex-col">
          <SlotErrorBoundary key={item.registrationKey} registry={registry} item={item}>
            {(item.render as (raw: Record<string, unknown>) => React.ReactNode)(mergedProps)}
          </SlotErrorBoundary>
        </div>
      </SlotSessionProvider>
    </SlotRegistryProvider>
  );
}

export function createPublicSurfacesApi(
  registry: SlotRegistry = slotRegistry,
  trackDisposer?: (disposer: Disposer) => void,
): PublicSurfacesApi {
  return {
    listSlots(slot, options) {
      return registry
        .getItems(slot, {
          hasSession: options?.hasSession ?? true,
          matchKey: options?.matchKey,
        })
        .map((item) => ({
          registrationKey: item.registrationKey,
          slot: item.slot,
          id: item.id,
          instanceId: item.pluginId,
          pluginName: item.pluginName,
          title: item.title ?? item.id,
          order: item.order,
          key: item.key,
        }));
    },

    getRenderFailures: () => registry.getRenderFailures(),
    clearRenderFailure: id => id ? registry.clearRenderFailure(id) : registry.clearAllRenderFailures(),
    onSlotsChanged(listener) {
      const dispose = registry.subscribe(listener);
      trackDisposer?.(dispose);
      return dispose;
    },

    mountBoundSurface(container, initial) {
      let currentSession = toSessionLike(initial.session);
      let currentProps = initial.props;
      let disposed = false;
      const root: Root = createRoot(container);

      const render = () => {
        if (disposed) return;
        root.render(
          <BoundSurfaceWrapper
            contract={initial.contract}
            surface={initial.surface}
            session={currentSession}
            props={currentProps}
            defaultHeight={initial.defaultHeight}
            registry={registry}
          />,
        );
      };
      render();

      const dispose = () => {
        if (disposed) return;
        disposed = true;
        root.unmount();
      };
      trackDisposer?.(dispose);

      return {
        update(next) {
          if (disposed) return;
          if ('session' in next) currentSession = toSessionLike(next.session);
          if ('props' in next) currentProps = next.props;
          render();
        },
        dispose,
      };
    },

    mountSlotItem(container, initial) {
      let currentSession = toSessionLike(initial.session);
      let currentProps = initial.props;
      let disposed = false;
      const root: Root = createRoot(container);

      const render = () => {
        if (disposed) return;
        root.render(
          <SlotItemWrapper
            slot={initial.slot}
            instanceId={initial.instanceId}
            slotId={initial.slotId}
            session={currentSession}
            props={currentProps}
            registry={registry}
          />,
        );
      };
      render();
      const unsubRegistry = registry.subscribe(render);

      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubRegistry();
        root.unmount();
      };
      trackDisposer?.(dispose);

      return {
        update(next) {
          if (disposed) return;
          if ('session' in next) currentSession = toSessionLike(next.session);
          if ('props' in next) currentProps = next.props;
          render();
        },
        dispose,
      };
    },
  };
}
