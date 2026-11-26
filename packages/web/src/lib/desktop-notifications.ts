import { daemonApi } from '../api/client';
import type { InstalledPluginInfo, Session } from '@harnessmate/protocol';
import { resolveServiceSelectionClientSide } from '../api/peer-contracts';

const delivered = new Set<string>();
const pending = new Set<string>();
const storageKey = 'harnessmate.desktop-notifications.v1';
const maxReceipts = 256;

export function showSessionNotification(state: {
  plugins: InstalledPluginInfo[];
  sessionBindingsBySession: Record<string, Record<string, string | null>>;
  workspaceBindingsByWorkspace: Record<string, Record<string, string | null>>;
  compositionBindings: Record<string, string | null>;
}, session: Session | undefined, intent: Parameters<typeof daemonApi.planSessionNotification>[0]): void {
  const key = [intent.kind, intent.sessionId, intent.identity].join(':');
  const bridge = window.harnessMateBridge;
  if (!bridge || delivered.has(key) || pending.has(key)) return;
  const selection = resolveServiceSelectionClientSide({
    contract: 'session.notifications.v1',
    plugins: state.plugins,
    sessionBindings: session ? state.sessionBindingsBySession[session.id] : undefined,
    workspaceBindings: session ? state.workspaceBindingsByWorkspace[session.workspaceId] : undefined,
    compositionBindings: state.compositionBindings,
  });
  if (selection.status !== 'ready') return;
  pending.add(key);
  void daemonApi.planSessionNotification(intent).then(({ notice }) => {
    if (!notice) return;
    delivered.add(key);
    if (delivered.size > maxReceipts) delivered.delete(delivered.values().next().value!);
    deliverNativeNotice(bridge, notice);
  }).catch(() => {}).finally(() => pending.delete(key));
}

function deliverNativeNotice(bridge: NonNullable<Window['harnessMateBridge']>, { id, title, body }: {
  id: string; title: string; body: string;
}) {
  try {
    const raw = localStorage.getItem(storageKey);
    const values: unknown = raw ? JSON.parse(raw) : [];
    const receipts = Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
    if (receipts.includes(id)) return;
    localStorage.setItem(storageKey, JSON.stringify([...receipts.slice(1 - maxReceipts), id]));
  } catch {
    // Retain the in-memory receipt if renderer storage is unavailable.
  }
  bridge.notify(title, body);
}
