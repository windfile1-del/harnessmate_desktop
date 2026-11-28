import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/theme.css';
import { AgyArtifactReviewPanel, AgyEcosystemPanel } from '../../components/agy/AgyArtifactReviewPanel';
import { AgyComposerControls } from '../../components/agy/AgyComposerControls';
import { AgySettingsSlot } from '../../components/agy/AgySettingsSlot';
import { registerBoostStudioView } from '../../components/agy/native/boost/register';
import { registerSubagentManagerView } from '../../components/agy/native/child/register';
import { registerAgyNativeRuntimeView } from '../../components/agy/native/runtime';
import { AgyWorkbenchShell, DEFAULT_WORKBENCH_ROUTE } from '../../components/agy/native/shared';
import { registerSwarmStudioView } from '../../components/agy/native/swarm/register';
import { registerNativeTasksView } from '../../components/agy/native/tasks/register';
import { registerTeamworkStudioView } from '../../components/agy/native/teamwork/register';
import { registerDynamicWorkflowStudioView } from '../../components/agy/native/workflow';
import { startWorkbenchBridgeSync, useAppStore, workbenchBridge } from './store';

function AgyWorkbenchPluginRoot() {
  const slotId = workbenchBridge?.slotId ?? 'agy-workbench';
  const sessions = useAppStore((s) => s.sessions);
  const harnesses = useAppStore((s) => s.harnesses);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const pendingApprovals = useAppStore((s) => s.pendingApprovals);
  const nativeRuntimeBySession = useAppStore((s) => s.nativeRuntimeBySession);
  const setRoute = useAppStore((s) => s.setNativeWorkbenchRoute);
  const hydrate = useAppStore((s) => s.hydrateNativeRuntime);
  const submitNativeCommand = useAppStore((s) => s.submitNativeCommand);
  const dispatchNativeControl = useAppStore((s) => s.dispatchNativeControl);
  const loadNativeTimeline = useAppStore((s) => s.loadNativeTimeline);
  const loadNativeWorkflowResource = useAppStore((s) => s.loadNativeWorkflowResource);

  useEffect(() => {
    const unregisterViews = [
      registerAgyNativeRuntimeView(),
      registerSubagentManagerView(),
      registerSwarmStudioView(),
      registerBoostStudioView(),
      registerTeamworkStudioView(),
      registerDynamicWorkflowStudioView(),
      registerNativeTasksView(),
    ];
    const stopBridge = startWorkbenchBridgeSync();
    return () => {
      stopBridge();
      unregisterViews.reverse().forEach((dispose) => dispose());
    };
  }, []);

  const session = useMemo(
    () => sessions.find((item) => item.id === selectedSessionId) ?? workbenchBridge?.session ?? null,
    [sessions, selectedSessionId],
  );

  const slice = session ? nativeRuntimeBySession[session.id] : undefined;
  const sessionPending = useMemo(
    () => (session ? pendingApprovals.filter((a) => a.sessionId === session.id && a.status === 'pending') : []),
    [pendingApprovals, session],
  );

  if (slotId === 'agy-settings') {
    const agyHarness = harnesses.find((h) => h.driverId === 'agy' || h.kind === 'agy') ?? {
      id: 'agy',
      driverId: 'agy',
      kind: 'agy' as const,
      displayName: 'Antigravity CLI',
      description: 'AGY ACP',
      protocolLabel: 'ACP',
      binaryPath: null,
      version: null,
      health: 'ready' as const,
      models: [],
      capabilities: {
        streaming: true,
        interactiveApproval: true,
        reasoningEfforts: [],
        permissionModes: ['manual'],
        sessionResume: true,
        sessionFork: false,
        imageInput: true,
        subagents: true,
      },
    };
    return <AgySettingsSlot harness={agyHarness} onRefresh={() => {}} />;
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-[12px] text-[var(--text-muted)]">
        请选择一个 AGY 会话以打开原生工作台。
      </div>
    );
  }

  if (slotId === 'agy-composer') {
    const isRunning = session.status === 'running';
    return <AgyComposerControls session={session} isRunning={isRunning} />;
  }

  if (slotId === 'agy-artifacts') {
    return <AgyArtifactReviewPanel session={session} />;
  }

  if (slotId === 'agy-ecosystem') {
    return <AgyEcosystemPanel session={session} />;
  }

  if (slotId === 'agy-native-badge') {
    if (session.harnessKind !== 'agy' || !slice?.projection) return null;
    const runningCount = slice.projection.work.filter(
      (w) => w.state.kind === 'known' && (w.state.value === 'running' || w.state.value === 'waiting'),
    ).length;
    const pendingCount = sessionPending.length;
    if (runningCount === 0 && pendingCount === 0 && slice.projection.status === 'attached') return null;
    return (
      <span
        data-testid="agy-native-sidebar-badge"
        className="rounded px-1.5 py-0.5 font-mono-code text-[10px]"
        style={{
          backgroundColor: pendingCount > 0 ? 'var(--accent-star-soft)' : 'var(--accent-indigo-soft)',
          color: pendingCount > 0 ? 'var(--accent-star)' : 'var(--accent-indigo)',
        }}
      >
        {pendingCount > 0 ? `需操作 ${pendingCount}` : slice.projection.status === 'reconciling' ? '校准中' : `原生 ${runningCount}`}
      </span>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <AgyWorkbenchShell
        session={session}
        projection={slice?.projection ?? null}
        syncState={slice?.syncState ?? null}
        capabilities={slice?.capabilities ?? []}
        pendingApprovals={sessionPending}
        route={slice?.route ?? { ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={(patch) => setRoute(session.id, patch)}
        onBackToChat={() => setRoute(session.id, { surface: 'chat' })}
        onRefresh={() => void hydrate(session.id)}
        onResolveRequest={async () => { throw new Error('请在绑定的请求视图处理'); }}
        onSubmitCommand={async (req) => {
          await submitNativeCommand(session.id, req);
        }}
        onDispatchControl={async (req) => {
          await dispatchNativeControl(session.id, req);
        }}
        loadTimeline={(scope, pageToken, signal) => loadNativeTimeline(session.id, scope, pageToken, signal)}
        loadWorkflowResource={(workflowId, resource, pageToken, signal) =>
          loadNativeWorkflowResource(session.id, workflowId, resource, pageToken, signal)
        }
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<AgyWorkbenchPluginRoot />);
