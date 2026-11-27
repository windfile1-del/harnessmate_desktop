import { useShallow } from 'zustand/react/shallow';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiagnosticEntry } from './lib/projector';
import { BoundSessionSurface, useBoundSessionPlugin } from './slots/BoundSessionSurface';
import { InspectorDrawer } from './components/InspectorDrawer';
import { KernelRecoveryView } from './components/KernelRecoveryView';
import { registerAgyNativeRuntimeView } from './components/agy/native/runtime';
import { registerSubagentManagerView } from './components/agy/native/child/register';
import { registerSwarmStudioView } from './components/agy/native/swarm/register';
import { registerBoostStudioView } from './components/agy/native/boost/register';
import { registerTeamworkStudioView } from './components/agy/native/teamwork/register';
import { registerDynamicWorkflowStudioView } from './components/agy/native/workflow';
import { registerNativeTasksView } from './components/agy/native/tasks/register';
import { PluginWorkspaceStage } from './slots/PluginWorkspace';
import { ModalHost } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import { TriageInboxLifecycle, openTriageSession } from './components/TriageInbox';
import { isImeComposing, trackComposition } from './lib/ime';
import { isTriageEnabled } from './lib/triage';
import { handleTriageShortcut } from './lib/triage-shortcuts';
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

function MainStageContent({ selectedSession }: { selectedSession: import('@harnessmate/protocol').Session | null }) {
  const startItems = useSlotItems('workspace.start');
  const chat = useBoundSessionPlugin('chat.view.v1', selectedSession);
  if (!selectedSession && startItems.length > 0) {
    return <Slot name="workspace.start" slotProps={{ session: null }} className="flex min-h-0 flex-1" />;
  }
  if (!chat) return <div role="status" className="flex flex-1 items-center justify-center p-8 text-[var(--text-secondary)]">聊天插件不可用。可在插件中心启用实例或恢复组合。</div>;
  return <div className="min-h-0 min-w-0 flex-1"><BoundSessionSurface plugin={chat} surface="chat" session={selectedSession} /></div>;
}

export function App() {
  const [presentation, setPresentation] = useState<{sessionId: string; diagnostics: DiagnosticEntry[]}>();
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (Array.isArray(detail?.diagnostics)) setPresentation({ sessionId: detail.sessionId, diagnostics: detail.diagnostics });
    };
    window.addEventListener('hm:presentation', listener);
    return () => window.removeEventListener('hm:presentation', listener);
  }, []);
  const triageEnabled = useAppStore((state) => isTriageEnabled(state.plugins));
  const composing = useRef(false);
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
    emptyComposition,
    agyNativeWorkbenchEnabled,
    setNativeWorkbenchRoute,
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
    emptyComposition: state.emptyComposition,
    agyNativeWorkbenchEnabled: state.agyNativeWorkbenchEnabled,
    setNativeWorkbenchRoute: state.setNativeWorkbenchRoute,
  })));

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => trackComposition(window, composing), []);

  useEffect(() => {
    if (!agyNativeWorkbenchEnabled) return;
    const unregister = [
      registerAgyNativeRuntimeView(),
      registerSubagentManagerView(),
      registerSwarmStudioView(),
      registerBoostStudioView(),
      registerTeamworkStudioView(),
      registerDynamicWorkflowStudioView(),
      registerNativeTasksView(),
    ];
    return () => unregister.reverse().forEach((dispose) => dispose());
  }, [agyNativeWorkbenchEnabled]);

  useEffect(() => {
    if (!triageEnabled) {
      if (useAppStore.getState().activeModal === 'command_palette') openModal(null);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useAppStore.getState();
      handleTriageShortcut(event, composing.current, {
        modal: state.activeModal,
        sessions: state.sessions,
        triage: state.triageBySession,
        selectedSessionId: state.selectedSessionId,
        openPalette: state.openCommandPalette,
        closePalette: () => state.openModal(null),
        selectSession: (session) => { void openTriageSession(session); },
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [triageEnabled, openModal]);

  // Keyboard-first shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeComposing(e, composing.current)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openModal('new_session');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setInspectorOpen(!inspectorOpen);
      } else if (
        agyNativeWorkbenchEnabled &&
        selectedSession?.harnessKind === 'agy' &&
        !activeModal &&
        ((e.altKey && e.shiftKey && e.key.toLowerCase() === 'a') ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g'))
      ) {
        e.preventDefault();
        const curSurface =
          useAppStore.getState().nativeRuntimeBySession[selectedSession.id]?.route.surface ?? 'chat';
        setNativeWorkbenchRoute(selectedSession.id, {
          surface: curSurface === 'chat' ? 'runtime' : 'chat',
        });
      } else if (e.key === 'Escape' && activeModal) {
        openModal(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    sidebarCollapsed,
    inspectorOpen,
    activeModal,
    agyNativeWorkbenchEnabled,
    selectedSession,
    setSidebarCollapsed,
    setInspectorOpen,
    openModal,
    setNativeWorkbenchRoute,
  ]);

  return (
    <SlotRegistryProvider>
      <SlotSessionProvider session={selectedSession}>
        <PluginSlotSync />
        {triageEnabled && <TriageInboxLifecycle />}
        <div className="flex h-screen w-screen flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {emptyComposition ? (
              <>
                <KernelRecoveryView />
                <ModalHost />
              </>
            ) : (
              <>
                {!sidebarCollapsed && <Sidebar />}
                <PluginWorkspaceStage><MainStageContent selectedSession={selectedSession} /></PluginWorkspaceStage>
                {inspectorOpen && selectedSession && <InspectorDrawer session={selectedSession} diagnostics={presentation?.sessionId === selectedSession.id ? presentation.diagnostics : []} />}
                <ModalHost />
              </>
            )}
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
