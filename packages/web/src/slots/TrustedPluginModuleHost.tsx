import type {
  AnyPluginSlotKey,
  ApplicationSwitchResult,
  Disposer,
  NavigationRequestV1,
  NavigationResultV1,
  PublicSession,
  Session,
  UiContributionInput,
  UiContributionInvocation,
  UiContributionRecord,
  WsServerFrame,
} from '@harnessmate/protocol';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { getDaemonBaseUrl, getSharedDaemonWs, type ServiceBatch } from '../api/client';
import { isAbortError } from '../api/peer-workspace-client';
import { contributionRegistry, type UiContributionQuery } from '../kernel/contribution-registry';
import {
  layoutBridge,
  type LayoutLegacyActionDelegate,
  type LayoutToastHandler,
  type PublishedLayoutState,
} from '../kernel/layout-bridge';
import { navigationBus, type NavigationHandler } from '../kernel/navigation-bus';
import { kernelRecoveryClient, type KernelRestartResult } from '../kernel/recovery-client';
import { frontendPerfDiagnostics } from '../lib/perf-diagnostics';
import { useKernelStore, type KernelStoreState } from '../stores/kernel-store';
import { useSlotRegistry, useSlotTheme } from './hooks';
import { executeSandboxedBridgeMethod } from './sandbox-bridge-handler';
import { collectThemeCssVars, toPublicSessionDto } from './sandbox-iframe-utils';
import { ensureSharedPluginRuntime, type HarnessMateSharedFrontendRuntime } from './shared-runtime';
import { subscribeShellState } from './shell-bridge';
import { createPublicSurfacesApi, type PublicSurfacesApi } from './surface-mounter';

export interface TrustedModuleKernelApi {
  getSnapshot(): Pick<
    KernelStoreState,
    | 'theme'
    | 'connected'
    | 'loading'
    | 'plugins'
    | 'emptyComposition'
    | 'compositionBindings'
    | 'compositionEntries'
    | 'workspaceBindingsByWorkspace'
    | 'sessionBindingsBySession'
    | 'pluginPermissionRevision'
    | 'restartStatus'
  >;
  subscribe(listener: () => void): Disposer;
  setTheme(theme: 'dark' | 'light'): void;
  toggleTheme(): void;
  refreshPlugins(): Promise<void>;
  refreshComposition(workspaceId?: string): Promise<void>;
  refreshWorkspaceBindings(workspaceId: string): Promise<void>;
  setWorkspaceBinding(workspaceId: string, contract: string, instanceId: string | null): Promise<void>;
  refreshSessionBindings(sessionId: string): Promise<void>;
  setSessionBinding(sessionId: string, contract: string, instanceId: string | null): Promise<void>;
  setCompositionBinding(contract: string, instanceId: string | null): Promise<void>;
  switchApplicationEntry(
    instanceId: string | null,
    options?: { requiresRestart?: boolean; restartReason?: string },
  ): Promise<ApplicationSwitchResult>;
  togglePlugin(id: string, enabled: boolean): Promise<void>;
  rollbackPlugin(id: string): Promise<void>;
  restoreComposition(source: 'builtin' | 'previous' | 'empty'): Promise<void>;
  reloadPlugins(): Promise<void>;
  invalidatePluginPermissions(): void;
  requestRestart(options?: { safeMode?: boolean }): Promise<KernelRestartResult>;
}

export interface TrustedModulePageBridge {
  readonly pluginId: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly slotId: string;
  readonly slot: AnyPluginSlotKey;
  readonly theme: 'dark' | 'light';
  readonly apiBase: string;
  readonly workspaceId: string | null;
  readonly cssVars: Record<string, string>;
  readonly session: PublicSession | null;
  readonly props: Record<string, unknown>;
  readonly mountMode: 'trusted-module';
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
  services: {
    call<T = { value: unknown }>(
      contract: string,
      method: string,
      args?: unknown[],
      options?: Record<string, unknown>,
    ): Promise<T>;
    subscribe(
      options: { contract: string; instanceId?: string; runId?: string; signal?: AbortSignal },
      listener: (batch: ServiceBatch) => void,
    ): Promise<() => void>;
  };
  navigate(request: NavigationRequestV1): Promise<NavigationResultV1>;
  navigation: {
    navigate(request: NavigationRequestV1): Promise<NavigationResultV1>;
    registerHandler(handler: NavigationHandler): Disposer;
  };
  contributions: {
    register(input: UiContributionInput): Disposer;
    query(filter?: UiContributionQuery): readonly UiContributionRecord[];
    execute(
      keyOrId: string,
      invocation?: Partial<UiContributionInvocation>,
    ): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>;
    subscribe(listener: () => void): Disposer;
  };
  application: {
    publishState(patch: PublishedLayoutState): boolean;
    registerToastHandler(handler: LayoutToastHandler): Disposer;
    registerLegacyActionDelegate(delegate: LayoutLegacyActionDelegate): Disposer;
  };
  kernel: TrustedModuleKernelApi;
  surfaces: PublicSurfacesApi;
  requestPluginRoute(options?: Record<string, unknown>): Promise<unknown>;
  resolveService(options?: Record<string, unknown>): Promise<unknown>;
  listPlugins(): Promise<unknown>;
  importBundle(options?: Record<string, unknown>): Promise<unknown>;
  navigateToSession(options?: Record<string, unknown>): Promise<unknown>;
  navigateToFile(options?: Record<string, unknown>): Promise<unknown>;
  openFile(options?: Record<string, unknown>): Promise<unknown>;
  refreshSessions(): Promise<unknown>;
  refreshWorkspaces(): Promise<unknown>;
  switchInstance(options?: Record<string, unknown>): Promise<unknown>;
  sendToPlugin(payload: unknown): Promise<unknown>;
  setDraft(text: string): Promise<unknown>;
  runCommand(command: string, args?: string): Promise<unknown>;
  toast(title: string, body?: string, kind?: 'info' | 'success' | 'warning' | 'error'): Promise<unknown>;
  resize(height: number): void;
  onTheme(cb: (theme: 'dark' | 'light', cssVars: Record<string, string>) => void): () => void;
  onContext(cb: (session: PublicSession | null, props: Record<string, unknown>) => void): () => void;
  onShellState(cb: (patch: Record<string, unknown>) => void): () => void;
  onCommandOutput(cb: (frame: Extract<WsServerFrame, { op: 'command_output' }>) => void): () => void;
}

export interface TrustedPluginModuleExports {
  mount(ctx: {
    container: HTMLElement;
    bridge: TrustedModulePageBridge;
    runtime: HarnessMateSharedFrontendRuntime;
  }): (() => void) | void | Promise<(() => void) | void>;
}

export interface TrustedPluginModuleHostProps {
  pluginId: string;
  instanceId?: string;
  pluginName: string;
  revision: string;
  slot: AnyPluginSlotKey;
  slotId: string;
  title: string;
  modulePath: string;
  session: Session | null;
  props?: Record<string, unknown>;
  defaultHeight?: number;
  compact?: boolean;
  onAction?: (action: string, params: Record<string, unknown>, signal: AbortSignal) => unknown;
  onLoadError?: (message: string) => void;
}

class ModuleErrorBoundary extends Component<
  { title: string; onError: (message: string) => void; children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error.message || String(error) };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error.message || String(error));
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl p-2.5 text-[11.5px] text-[var(--accent-rose)]"
          style={{
            backgroundColor: 'var(--accent-rose-soft)',
            border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
          }}
        >
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0 break-words">
            <div className="font-medium">{this.props.title} 渲染异常</div>
            <div className="text-[11px] opacity-90">{this.state.error}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function resolvePluginModuleUrl(instanceId: string, modulePath: string, revision: string): string {
  const cleaned = modulePath.replace(/^\.\//, '');
  const base = getDaemonBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/api/v1/plugins/${encodeURIComponent(instanceId)}/ui/${cleaned}?v=${encodeURIComponent(revision)}`;
}

export function TrustedPluginModuleHost({
  pluginId,
  instanceId,
  pluginName,
  revision,
  slot,
  slotId,
  title,
  modulePath,
  session,
  props,
  defaultHeight,
  compact = false,
  onAction,
  onLoadError,
}: TrustedPluginModuleHostProps) {
  const effectiveInstanceId = instanceId ?? pluginId;
  const registry = useSlotRegistry();
  const theme = useSlotTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFullSize =
    slot === 'application.shell' || slot === 'workspace.pages' || slot === 'session.stage.embedded';
  const [height, setHeight] = useState<number | null>(
    isFullSize ? null : (defaultHeight ?? (compact ? 48 : 220)),
  );

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const loadErrorRef = useRef(onLoadError);
  loadErrorRef.current = onLoadError;

  const sessionDto = useMemo(() => toPublicSessionDto(session), [session]);
  const safeProps = useMemo(() => {
    const out: Record<string, unknown> = { ...(props ?? {}) };
    if (typeof out.apiBase !== 'string') {
      out.apiBase =
        typeof window !== 'undefined'
          ? window.harnessMateBridge?.daemonUrl || window.location?.origin || ''
          : '';
    }
    return out;
  }, [props]);

  const themeListenersRef = useRef<Set<(t: 'dark' | 'light', vars: Record<string, string>) => void>>(new Set());
  const contextListenersRef = useRef<Set<(s: PublicSession | null, p: Record<string, unknown>) => void>>(new Set());
  const stateRef = useRef({
    theme,
    cssVars: collectThemeCssVars(),
    session: sessionDto,
    props: safeProps,
  });

  useEffect(() => {
    const cssVars = collectThemeCssVars();
    stateRef.current.theme = theme;
    stateRef.current.cssVars = cssVars;
    for (const cb of themeListenersRef.current) {
      try {
        cb(theme, cssVars);
      } catch {}
    }
  }, [theme]);

  useEffect(() => {
    stateRef.current.session = sessionDto;
    stateRef.current.props = safeProps;
    for (const cb of contextListenersRef.current) {
      try {
        cb(sessionDto, safeProps);
      } catch {}
    }
  }, [sessionDto, safeProps]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Each run gets its own mount node. A nested React root may defer unmount
    // during its parent's commit; clearing its children here races that commit.
    const moduleContainer = document.createElement('div');
    moduleContainer.className = isFullSize ? 'flex size-full min-h-0 min-w-0 flex-1 flex-col' : 'w-full';
    container.append(moduleContainer);
    const runtime = ensureSharedPluginRuntime();
    const rpcAbort = new AbortController();
    let disposed = false;
    let moduleDispose: (() => void) | undefined;
    const owner = { instanceId: effectiveInstanceId, runId: revision, pluginId };
    const trackedDisposers = new Set<Disposer>();
    const trackDisposer = (dispose: Disposer): Disposer => {
      trackedDisposers.add(dispose);
      return () => {
        trackedDisposers.delete(dispose);
        dispose();
      };
    };

    const detachLayoutOwner = slot === 'application.shell' ? layoutBridge.attachOwner(owner) : undefined;
    const serviceSubscriptions = new Map<string, () => void>();
    const outputSubscriptions = new Map<string, () => void>();
    const shellListeners = new Set<(patch: Record<string, unknown>) => void>();
    const outputListeners = new Set<(frame: Extract<WsServerFrame, { op: 'command_output' }>) => void>();
    let subSeq = 0;

    setLoading(true);
    setError(null);

    const unsubscribeShell = subscribeShellState((patch) => {
      if (disposed || shellListeners.size === 0) return;
      for (const cb of shellListeners) {
        try {
          cb(patch);
        } catch {}
      }
    });

    const unsubscribeOutput = getSharedDaemonWs()?.observeFrames((frame) => {
      if (disposed || outputListeners.size === 0) return;
      if (frame.op === 'command_output' && outputSubscriptions.has(`${frame.sessionId}::${frame.toolCallId}`)) {
        for (const cb of outputListeners) {
          try {
            cb(frame);
          } catch {}
        }
      }
    });

    const runMethod = async (
      method: string,
      params?: Record<string, unknown>,
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<unknown> => {
      if (disposed || rpcAbort.signal.aborted) {
        throw new DOMException('插件模块已卸载', 'AbortError');
      }
      const combinedSignal = options?.signal
        ? AbortSignal.any([options.signal, rpcAbort.signal])
        : rpcAbort.signal;

      if (method === 'outputs.subscribe' || method === 'outputs.unsubscribe') {
        const sid = String(params?.sessionId ?? '');
        const cid = String(params?.toolCallId ?? '');
        const id = `${sid}::${cid}`;
        outputSubscriptions.get(id)?.();
        outputSubscriptions.delete(id);
        if (method === 'outputs.subscribe') {
          outputSubscriptions.set(id, useKernelStore.getState().subscribeCommandOutput(sid, cid));
        }
        return id;
      }

      if (method === 'surface.action' && actionRef.current && typeof params?.action === 'string') {
        return actionRef.current(params.action, params, combinedSignal);
      }

      return executeSandboxedBridgeMethod(
        {
          pluginId,
          effectiveInstanceId,
          slot,
          slotId,
          runId: revision,
          currentSession: sessionRef.current,
          signal: combinedSignal,
          isDisposed: () => disposed,
        },
        method,
        params,
      );
    };

    const surfaces = createPublicSurfacesApi(registry, (d) => {
      trackedDisposers.add(d);
    });

    const kernelApi: TrustedModuleKernelApi = {
      getSnapshot() {
        const s = useKernelStore.getState();
        return {
          theme: s.theme,
          connected: s.connected,
          loading: s.loading,
          plugins: s.plugins,
          emptyComposition: s.emptyComposition,
          compositionBindings: s.compositionBindings,
          compositionEntries: s.compositionEntries,
          workspaceBindingsByWorkspace: s.workspaceBindingsByWorkspace,
          sessionBindingsBySession: s.sessionBindingsBySession,
          pluginPermissionRevision: s.pluginPermissionRevision,
          restartStatus: s.restartStatus,
        };
      },
      subscribe(listener) {
        return trackDisposer(useKernelStore.subscribe(listener));
      },
      setTheme: (next) => useKernelStore.getState().setTheme(next),
      toggleTheme: () => useKernelStore.getState().toggleTheme(),
      refreshPlugins: () => useKernelStore.getState().refreshPlugins(),
      refreshComposition: (wsId) => useKernelStore.getState().refreshComposition(wsId),
      refreshWorkspaceBindings: (wsId) => useKernelStore.getState().refreshWorkspaceBindings(wsId),
      setWorkspaceBinding: (wsId, contract, targetId) =>
        useKernelStore.getState().setWorkspaceBinding(wsId, contract, targetId),
      refreshSessionBindings: (sid) => useKernelStore.getState().refreshSessionBindings(sid),
      setSessionBinding: (sid, contract, targetId) =>
        useKernelStore.getState().setSessionBinding(sid, contract, targetId),
      setCompositionBinding: (contract, targetId) =>
        useKernelStore.getState().setCompositionBinding(contract, targetId),
      switchApplicationEntry: (targetId, opts) =>
        useKernelStore.getState().switchApplicationEntry(targetId, opts),
      togglePlugin: (id, enabled) => useKernelStore.getState().togglePlugin(id, enabled),
      rollbackPlugin: (id) => useKernelStore.getState().rollbackPlugin(id),
      restoreComposition: (source) => useKernelStore.getState().restoreComposition(source),
      reloadPlugins: () => useKernelStore.getState().reloadPlugins(),
      invalidatePluginPermissions: () => useKernelStore.getState().invalidatePluginPermissions(),
      requestRestart: (opts) => kernelRecoveryClient.requestRestart(opts),
    };

    const navigateFn = (request: NavigationRequestV1) =>
      navigationBus.navigate({
        ...request,
        sourceInstanceId: request.sourceInstanceId ?? effectiveInstanceId,
        sourceRunId: request.sourceRunId ?? revision,
      });

    const bridgeObj: TrustedModulePageBridge = {
      get pluginId() {
        return pluginId;
      },
      get instanceId() {
        return effectiveInstanceId;
      },
      get runId() {
        return revision;
      },
      get slotId() {
        return slotId;
      },
      get slot() {
        return slot;
      },
      get theme() {
        return stateRef.current.theme;
      },
      get apiBase() {
        return typeof stateRef.current.props.apiBase === 'string' ? stateRef.current.props.apiBase : '';
      },
      get workspaceId() {
        return typeof stateRef.current.props.workspaceId === 'string'
          ? stateRef.current.props.workspaceId
          : null;
      },
      get cssVars() {
        return stateRef.current.cssVars;
      },
      get session() {
        return stateRef.current.session;
      },
      get props() {
        return stateRef.current.props;
      },
      mountMode: 'trusted-module',
      call: <T = unknown>(
        method: string,
        params?: Record<string, unknown>,
        options?: { signal?: AbortSignal; timeoutMs?: number },
      ) => runMethod(method, params, options) as Promise<T>,
      services: {
        call: <T = { value: unknown }>(
          contract: string,
          method: string,
          args: unknown[] = [],
          options?: Record<string, unknown>,
        ) => {
          const params: Record<string, unknown> = { contract, method, args, ...(options ?? {}) };
          delete params.signal;
          delete params.timeoutMs;
          return runMethod('services.call', params, {
            signal: options?.signal as AbortSignal | undefined,
            timeoutMs: options?.timeoutMs as number | undefined,
          }) as Promise<T>;
        },
        subscribe: async (options, listener) => {
          const connection = getSharedDaemonWs();
          if (!connection) throw new Error('事件连接尚未就绪');
          const contract = String(options.contract ?? '');
          if (!contract) throw new Error('需要契约 ID');
          let targetInstanceId =
            typeof options.instanceId === 'string' && options.instanceId ? options.instanceId : '';
          if (!targetInstanceId) {
            const resolved = (await runMethod(
              'services.resolve',
              {
                contract,
                sessionId: sessionRef.current?.id,
                workspaceId: sessionRef.current?.workspaceId ?? stateRef.current.props.workspaceId,
              },
              { signal: options.signal },
            )) as { status?: string; instanceId?: string } | undefined;
            if (resolved?.status === 'ready' && resolved.instanceId) {
              targetInstanceId = resolved.instanceId;
            } else {
              targetInstanceId = effectiveInstanceId;
            }
          }
          const subId = `mod_sub_${++subSeq}`;
          return await new Promise<() => void>((resolve, reject) => {
            if (disposed || rpcAbort.signal.aborted) {
              reject(new DOMException('插件模块已卸载', 'AbortError'));
              return;
            }
            let acknowledged = false;
            let released = false;
            const cleanup = () => {
              if (released) return;
              released = true;
              serviceSubscriptions.get(subId)?.();
              serviceSubscriptions.delete(subId);
              frontendPerfDiagnostics.adjustPluginSubscription(-1);
            };
            const onAbort = () => {
              cleanup();
              if (!acknowledged) reject(new DOMException('请求已取消', 'AbortError'));
            };
            const signal = options.signal
              ? AbortSignal.any([options.signal, rpcAbort.signal])
              : rpcAbort.signal;
            signal.addEventListener('abort', onAbort, { once: true });
            frontendPerfDiagnostics.adjustPluginSubscription(1);
            const rawRelease = connection.subscribeService(
              { contract, instanceId: targetInstanceId, runId: options.runId },
              (batch) => {
                if (disposed || released || rpcAbort.signal.aborted) return;
                listener(batch);
                if (!acknowledged) {
                  acknowledged = true;
                  signal.removeEventListener('abort', onAbort);
                  resolve(cleanup);
                }
              },
            );
            serviceSubscriptions.set(subId, rawRelease);
          });
        },
      },
      navigate: navigateFn,
      navigation: {
        navigate: navigateFn,
        registerHandler(handler) {
          return trackDisposer(navigationBus.registerHandler(owner, handler));
        },
      },
      contributions: {
        register(input) {
          return trackDisposer(contributionRegistry.register(owner, input));
        },
        query(filter) {
          return contributionRegistry.query(filter);
        },
        execute(keyOrId, invocation) {
          return contributionRegistry.execute(keyOrId, {
            ...invocation,
            sourceInstanceId: invocation?.sourceInstanceId ?? effectiveInstanceId,
          });
        },
        subscribe(listener) {
          return trackDisposer(contributionRegistry.subscribe(listener));
        },
      },
      application: {
        publishState(patch) {
          if (slot !== 'application.shell') return false;
          return layoutBridge.publishState(owner, patch);
        },
        registerToastHandler(handler) {
          if (slot !== 'application.shell') return () => {};
          return trackDisposer(layoutBridge.registerToastHandler(owner, handler));
        },
        registerLegacyActionDelegate(delegate) {
          if (slot !== 'application.shell') return () => {};
          return trackDisposer(layoutBridge.registerLegacyActionDelegate(owner, delegate));
        },
      },
      kernel: kernelApi,
      surfaces,
      requestPluginRoute: (o) => runMethod('plugin.route', o),
      resolveService: (o) => runMethod('services.resolve', o),
      listPlugins: () => runMethod('plugins.list'),
      importBundle: (o) => runMethod('import.bundle', o),
      navigateToSession: (o) => runMethod('navigateToSession', o),
      navigateToFile: (o) => runMethod('navigateToFile', o),
      openFile: (o) => runMethod('navigateToFile', o),
      refreshSessions: () => runMethod('refreshSessions'),
      refreshWorkspaces: () => runMethod('refreshWorkspaces'),
      switchInstance: (o) => runMethod('switchInstance', o),
      sendToPlugin: (payload) => runMethod('plugin.message', { payload }),
      setDraft: (text) => runMethod('composer.setDraft', { text: String(text || '') }),
      runCommand: (command, args = '') => runMethod('command.run', { command, args }),
      toast: (t, body, kind = 'info') => runMethod('ui.toast', { title: t, body, kind }),
      resize: (h) => {
        if (!isFullSize) {
          setHeight(Math.max(48, Math.min(960, Math.round(Number(h) || 120))));
        }
      },
      onTheme: (cb) => {
        themeListenersRef.current.add(cb);
        return () => {
          themeListenersRef.current.delete(cb);
        };
      },
      onContext: (cb) => {
        contextListenersRef.current.add(cb);
        return () => {
          contextListenersRef.current.delete(cb);
        };
      },
      onShellState: (cb) => {
        shellListeners.add(cb);
        return () => {
          shellListeners.delete(cb);
        };
      },
      onCommandOutput: (cb) => {
        outputListeners.add(cb);
        return () => {
          outputListeners.delete(cb);
        };
      },
    };
    const bridge: TrustedModulePageBridge = Object.freeze(bridgeObj);

    const url = resolvePluginModuleUrl(effectiveInstanceId, modulePath, revision);
    void (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ url)) as Partial<TrustedPluginModuleExports>;
        if (disposed || rpcAbort.signal.aborted) return;
        if (typeof mod?.mount !== 'function') {
          throw new Error(`可信模块缺少导出 mount(): ${modulePath}`);
        }
        const cleanup = await mod.mount({ container: moduleContainer, bridge, runtime });
        if (disposed || rpcAbort.signal.aborted) {
          if (typeof cleanup === 'function') cleanup();
          return;
        }
        moduleDispose = typeof cleanup === 'function' ? cleanup : undefined;
        setLoading(false);
      } catch (err) {
        if (disposed || isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setLoading(false);
        registry.reportRenderFailure({
          pluginId,
          pluginName,
          slot,
          slotItemId: slotId,
          message: `可信前端模块加载失败: ${message}`,
        });
        loadErrorRef.current?.(message);
      }
    })();

    return () => {
      disposed = true;
      rpcAbort.abort();
      try {
        moduleDispose?.();
      } catch {}
      moduleDispose = undefined;
      for (const dispose of [...trackedDisposers]) {
        try {
          dispose();
        } catch {}
      }
      trackedDisposers.clear();
      contributionRegistry.revokeByOwner(effectiveInstanceId, revision);
      navigationBus.revokeByOwner(effectiveInstanceId, revision);
      detachLayoutOwner?.();
      unsubscribeShell();
      unsubscribeOutput?.();
      shellListeners.clear();
      outputListeners.clear();
      themeListenersRef.current.clear();
      contextListenersRef.current.clear();
      for (const release of outputSubscriptions.values()) release();
      outputSubscriptions.clear();
      for (const release of serviceSubscriptions.values()) {
        release();
        frontendPerfDiagnostics.adjustPluginSubscription(-1);
      }
      serviceSubscriptions.clear();
      moduleContainer.remove();
    };
  }, [pluginId, effectiveInstanceId, pluginName, revision, slot, slotId, modulePath, registry, isFullSize]);

  if (error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-xl p-2.5 text-[11.5px] text-[var(--accent-rose)]"
        style={{
          backgroundColor: 'var(--accent-rose-soft)',
          border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
        }}
      >
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 break-words">
          <div className="font-medium">{title} 加载失败</div>
          <div className="text-[11px] opacity-90">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <ModuleErrorBoundary
      title={title}
      onError={(message) => {
        registry.reportRenderFailure({
          pluginId,
          pluginName,
          slot,
          slotItemId: slotId,
          message: `可信前端模块渲染失败: ${message}`,
        });
        loadErrorRef.current?.(message);
      }}
    >
      <div
        data-trusted-module-host={`${effectiveInstanceId}:${slotId}`}
        className={isFullSize ? 'relative flex size-full min-h-0 min-w-0 flex-1 flex-col' : 'relative w-full'}
        style={!isFullSize && height !== null ? { minHeight: `${height}px` } : undefined}
      >
        {loading && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
            <Loader2 size={12.5} className="animate-spin text-[var(--accent-indigo)]" />
            <span>正在加载模块 {title}…</span>
          </div>
        )}
        <div
          ref={containerRef}
          className={isFullSize ? 'flex size-full min-h-0 min-w-0 flex-1 flex-col' : 'w-full'}
        />
      </div>
    </ModuleErrorBoundary>
  );
}
