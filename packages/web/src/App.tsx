import { X } from 'lucide-react';
import { useEffect } from 'react';
import { ChatStage } from './components/ChatStage';
import { ModalHost } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import { useAppStore } from './stores/app-store';

export function App() {
  const {
    init,
    sidebarCollapsed,
    setSidebarCollapsed,
    inspectorOpen,
    setInspectorOpen,
    activeModal,
    openModal,
    toasts,
    dismissToast,
  } = useAppStore();

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
    <div className="flex h-screen w-screen overflow-hidden">
      {!sidebarCollapsed && <Sidebar />}
      <ChatStage />
      <ModalHost />

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
  );
}
