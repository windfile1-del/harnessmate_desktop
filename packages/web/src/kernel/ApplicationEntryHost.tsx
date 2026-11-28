import {
  normalizeAnyPluginSlotKey,
  type InstalledPluginInfo,
  type PluginSlotContribution,
} from '@harnessmate/protocol';
import { Loader2 } from 'lucide-react';
import { Component, useCallback, useMemo, useSyncExternalStore, useState, useEffect, type ErrorInfo, type ReactNode } from 'react';
import {
  APPLICATION_SHELL_SLOT,
  APPLICATION_VIEW_CONTRACT,
  getPluginInstanceId,
  resolveServiceSelectionClientSide,
} from '../api/peer-contracts';
import { KernelRecoveryView } from '../components/KernelRecoveryView';
import { shouldUseTrustedModuleMount } from '../slots/BoundSessionSurface';
import { SandboxedPluginFrame } from '../slots/SandboxedPluginFrame';
import { TrustedPluginModuleHost } from '../slots/TrustedPluginModuleHost';
import { useKernelStore, type KernelRecoveryKind } from '../stores/kernel-store';

function findApplicationShellContribution(
  plugin: InstalledPluginInfo | undefined,
): PluginSlotContribution | undefined {
  if (!plugin) return undefined;
  const all = [...(plugin.contributes.slots ?? []), ...(plugin.runtimeSlots ?? [])];
  return all.find(
    (entry) => normalizeAnyPluginSlotKey(entry.slot) === APPLICATION_SHELL_SLOT && Boolean(entry.ui),
  );
}

class ApplicationErrorBoundary extends Component<
  {
    instanceId: string;
    onCrash: (message: string) => void;
    children: ReactNode;
  },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onCrash(error.message || String(error));
  }

  componentDidUpdate(prevProps: { instanceId: string }): void {
    if (prevProps.instanceId !== this.props.instanceId && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/**
 * Resolves the explicitly bound `application.view.v1` layout plugin from the active composition
 * and mounts it through the single generic plugin frontend loader (`TrustedPluginModuleHost`
 * or `SandboxedPluginFrame`). Never imports or falls back to any hardcoded default layout component.
 */
export function ApplicationEntryHost() {
  const [manualRecovery, setManualRecovery] = useState(() => typeof location !== 'undefined' && location.hash === '#kernel-recovery');
  useEffect(() => { const update = () => setManualRecovery(location.hash === '#kernel-recovery'); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  const {
    loading,
    initialized,
    plugins,
    emptyComposition,
    compositionBindings,
    compositionEntries,
    applicationFailure,
    restartStatus,
    reportApplicationFailure,
    clearApplicationFailure,
    refreshPlugins,
  } = useSyncExternalStore(
    useKernelStore.subscribe,
    useKernelStore.getState,
    useKernelStore.getState,
  );

  const resolution = useMemo(
    () =>
      resolveServiceSelectionClientSide({
        contract: APPLICATION_VIEW_CONTRACT,
        allowSingleCandidate: false,
        plugins,
        compositionBindings,
        compositionEntries,
      }),
    [plugins, compositionBindings, compositionEntries],
  );

  const resolvedPlugin = useMemo(
    () =>
      resolution.status === 'ready'
        ? plugins.find((plugin) => getPluginInstanceId(plugin) === resolution.instanceId)
        : undefined,
    [plugins, resolution],
  );
  const shellContribution = useMemo(
    () => findApplicationShellContribution(resolvedPlugin),
    [resolvedPlugin],
  );

  const handleRecovered = useCallback(() => {
    clearApplicationFailure();
    void refreshPlugins().catch(() => {});
  }, [clearApplicationFailure, refreshPlugins]);

  if (!initialized && loading) {
    return (
      <div
        role="status"
        className="flex h-screen w-screen items-center justify-center gap-2 text-[13px] text-[var(--text-secondary)]"
        style={{ backgroundColor: 'var(--bg-canvas)' }}
      >
        <Loader2 size={16} className="animate-spin text-[var(--accent-indigo)]" />
        <span>正在初始化内核装配…</span>
      </div>
    );
  }

  if (manualRecovery) return <div className="flex h-screen flex-col overflow-auto"><button onClick={() => { location.hash = ''; setManualRecovery(false); }}>返回应用入口</button><KernelRecoveryView reasonKind="manual" onRecovered={handleRecovered} /></div>;

  if (emptyComposition) {
    return (
      <KernelRecoveryView
        reasonKind="empty_composition"
        restartRequired={restartStatus?.required}
        restartReason={restartStatus?.reason}
        onRecovered={handleRecovered}
      />
    );
  }

  if (applicationFailure) {
    return (
      <KernelRecoveryView
        reasonKind={applicationFailure.kind}
        failedInstanceId={applicationFailure.instanceId}
        errorMessage={applicationFailure.message}
        restartRequired={applicationFailure.restartRequired ?? restartStatus?.required}
        restartReason={restartStatus?.reason}
        onRecovered={handleRecovered}
      />
    );
  }

  if (resolution.status !== 'ready' || !resolvedPlugin || !shellContribution) {
    let reasonKind: KernelRecoveryKind = 'entry_unbound';
    let errorMessage: string | undefined;
    if (resolution.status === 'disabled') {
      reasonKind = 'entry_disabled';
      errorMessage = `布局实例 ${resolution.instanceId} 已停用。`;
    } else if (resolution.status === 'unavailable' || resolution.status === 'incompatible') {
      reasonKind = 'entry_unavailable';
      errorMessage = `布局实例 ${resolution.instanceId} 当前不可用（${resolution.status}）。`;
    } else if (resolution.status === 'ready' && !shellContribution) {
      reasonKind = 'entry_unavailable';
      errorMessage = `布局插件 ${resolvedPlugin?.id ?? resolution.instanceId} 缺少 ${APPLICATION_SHELL_SLOT} 入口声明。`;
    }
    return (
      <KernelRecoveryView
        reasonKind={reasonKind}
        failedInstanceId={resolution.instanceId ?? undefined}
        errorMessage={errorMessage}
        restartRequired={restartStatus?.required}
        restartReason={restartStatus?.reason}
        onRecovered={handleRecovered}
      />
    );
  }

  const instanceId = getPluginInstanceId(resolvedPlugin);
  const revision = resolvedPlugin.runId ?? resolvedPlugin.packageDigest ?? resolvedPlugin.version;
  const hostKey = `${instanceId}:${revision}:${shellContribution.id}`;
  const useTrustedModule = shouldUseTrustedModuleMount(resolvedPlugin, shellContribution);

  return (
    <ApplicationErrorBoundary
      instanceId={hostKey}
      onCrash={(message) => {
        reportApplicationFailure({
          kind: 'runtime_error',
          instanceId,
          pluginId: resolvedPlugin.id,
          message,
        });
      }}
    >
      <div
        data-application-entry={instanceId}
        data-application-mount-mode={useTrustedModule ? 'trusted-module' : 'iframe'}
        className="flex h-screen w-screen flex-col overflow-hidden"
      >
        {useTrustedModule ? (
          <TrustedPluginModuleHost
            key={`app-mod:${hostKey}`}
            pluginId={resolvedPlugin.id}
            instanceId={instanceId}
            pluginName={resolvedPlugin.name}
            revision={revision}
            slot={APPLICATION_SHELL_SLOT}
            slotId={shellContribution.id}
            title={shellContribution.title ?? resolvedPlugin.name}
            modulePath={shellContribution.module!}
            session={null}
            onLoadError={(message) => {
              reportApplicationFailure({
                kind: 'load_failed',
                instanceId,
                pluginId: resolvedPlugin.id,
                message,
              });
            }}
          />
        ) : (
          <SandboxedPluginFrame
            key={`app-ifr:${hostKey}`}
            pluginId={resolvedPlugin.id}
            instanceId={instanceId}
            pluginName={resolvedPlugin.name}
            revision={revision}
            slot={APPLICATION_SHELL_SLOT}
            slotId={shellContribution.id}
            title={shellContribution.title ?? resolvedPlugin.name}
            ui={shellContribution.ui}
            session={null}
            onLoadError={(message) => {
              reportApplicationFailure({
                kind: 'load_failed',
                instanceId,
                pluginId: resolvedPlugin.id,
                message,
              });
            }}
          />
        )}
      </div>
    </ApplicationErrorBoundary>
  );
}
