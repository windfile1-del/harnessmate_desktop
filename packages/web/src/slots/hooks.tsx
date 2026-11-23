import type { PluginSlotKey, PluginSlotRenderFailure, Session } from '@harnessmate/protocol';
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { ProjectedTurn } from '../lib/projector';
import { useAppStore } from '../stores/app-store';
import { slotRegistry, type RegisteredSlotItem, type SlotRegistry } from './slot-registry';

const SlotRegistryContext = createContext<SlotRegistry>(slotRegistry);
const SlotSessionContext = createContext<Session | null>(null);
const SlotTurnContext = createContext<ProjectedTurn | null>(null);

export function SlotRegistryProvider({
  registry = slotRegistry,
  children,
}: {
  registry?: SlotRegistry;
  children: ReactNode;
}) {
  return <SlotRegistryContext.Provider value={registry}>{children}</SlotRegistryContext.Provider>;
}

export function SlotSessionProvider({
  session,
  children,
}: {
  session: Session | null;
  children: ReactNode;
}) {
  return <SlotSessionContext.Provider value={session}>{children}</SlotSessionContext.Provider>;
}

export function SlotTurnProvider({
  turn,
  children,
}: {
  turn: ProjectedTurn | null;
  children: ReactNode;
}) {
  return <SlotTurnContext.Provider value={turn}>{children}</SlotTurnContext.Provider>;
}

export function useSlotRegistry(): SlotRegistry {
  return useContext(SlotRegistryContext);
}

/**
 * Standard host hook for slot components (slot components never receive plugin ctx).
 */
export function useSession(): Session | null {
  return useContext(SlotSessionContext);
}

export function useRequiredSession(): Session {
  const session = useContext(SlotSessionContext);
  if (!session) {
    throw new Error('useRequiredSession 只能在会话作用域插槽内使用');
  }
  return session;
}

/**
 * Standard host hook returning the surrounding chat turn when inside a turn/message slot.
 */
export function useTurn(): ProjectedTurn | null {
  return useContext(SlotTurnContext);
}

export function useSlotTheme(): 'dark' | 'light' {
  return useAppStore((state) => state.theme);
}

export function useSlotItems<K extends PluginSlotKey>(
  slot: K,
  matchKey?: string,
): readonly RegisteredSlotItem<K>[] {
  const registry = useSlotRegistry();
  const session = useSession();
  const hasSession = Boolean(session);
  const subscribe = (onStoreChange: () => void) => registry.subscribe(onStoreChange);
  const getSnapshot = () => registry.getItems(slot, { hasSession, matchKey });
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSlotRenderFailures(): readonly PluginSlotRenderFailure[] {
  const registry = useSlotRegistry();
  const subscribe = (onStoreChange: () => void) => registry.subscribe(onStoreChange);
  const getSnapshot = () => registry.getRenderFailures();
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
