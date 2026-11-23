import { useShallow } from 'zustand/react/shallow';
import { X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { ChatStage } from './components/ChatStage';
import { ModalHost } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import {
  PluginSlotSync,
  Slot,
  SlotRegistryProvider,
  SlotSessionProvider,
  useSlotItems,
} from './slots';
import { useAppStore } from './stores/app-store';

function StatusbarSlotStrip({ session }: { session: import('@harnessmate/protocol').Session | null }) {
  const items = useSlotItems('statusbar.items');
  if (items.length === 0) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 px-3 py-1 text-[11px] text-[var(--text-secondary)]"
      style={{
        backgroundColor: 'var(--bg-rail)',
        borderTop: '1px solid var(--border-hairline)',
      }}
    >
      <Slot name="statusbar.items" slotProps={{ session }} compactErrors className="flex flex-wrap items-center gap-2" />
    </div>
  );
}

export function App() {
  const {
    init,
    sessions,
    selectedSessionId,
    sidebarCollapsed,
    setSidebarCollapsed,
    inspectorOpen,
    setInspectorOpen,
    activeModal,
    openModal,
    toasts,
    dismissToast,
  } = useAppStore(useShallow((state) => ({
    init: state.init,
    sessions: state.sessions,
    selectedSessionId: state.selectedSessionId,
    sidebarCollapsed: state.sidebarCollapsed,
    setSidebarCollapsed: state.setSidebarCollapsed,
    inspectorOpen: state.inspectorOpen,
    setInspectorOpen: state.setInspectorOpen,
    activeModal: state.activeModal,
    openModal: state.openModal,
    toasts: state.toasts,
    dismissToast: state.dismissToast,
  })));

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  useEffect(() => {
    void init();
  }, [init]);

  // Keyboard-first shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openModal(activeModal === 'command_palette' ? null : 'command_palette');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openModal('new_session');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setInspectorOpen(!inspectorOpen);
      } else if (e.key === 'Escape' && activeModal) {
        openModal(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarCollapsed, inspectorOpen, activeModal, setSidebarCollapsed, setInspectorOpen, openModal]);

  return (
    <SlotRegistryProvider>
      <SlotSessionProvider session={selectedSession}>
        <PluginSlotSync />
        <div className="flex h-screen w-screen flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {!sidebarCollapsed && <Sidebar />}
            <ChatStage />
            <ModalHost />
          </div>
          <StatusbarSlotStrip session={selectedSession} />

          {/* Refined Floating Toast Stack */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[320px] flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="animate-fade-up pointer-events-auto flex items-start justify-between gap-2.5 rounded-xl px-3.5 py-2.5"
              style={{
                backgroundColor: 'var(--bg-glass)',
                backdropFilter: 'blur(16px)',
                border: `1px solid ${
                  t.kind === 'error'
                    ? 'color-mix(in srgb, var(--accent-rose) 48%, transparent)'
                    : t.kind === 'warning'
                      ? 'color-mix(in srgb, var(--accent-star) 50%, transparent)'
                      : t.kind === 'success'
                        ? 'color-mix(in srgb, var(--accent-emerald) 45%, transparent)'
                        : 'var(--border-strong)'
                }`,
                boxShadow: 'var(--shadow-float)',
              }}
            >
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t.title}</div>
                {t.body && (
                  <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">
                    {t.body}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="cursor-pointer rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
        </div>
      </SlotSessionProvider>
    </SlotRegistryProvider>
  );
}
