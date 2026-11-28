import type {
  AnyPluginSlotKey,
  PluginSlotBridgeHostMessage,
  PluginSlotBridgeIframeMessage,
  Session,
} from '@harnessmate/protocol';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { daemonApi, getSharedDaemonWs } from '../api/client';
import { isAbortError } from '../api/peer-workspace-client';
import { useKernelStore } from '../stores/kernel-store';
import { useSlotRegistry, useSlotTheme } from './hooks';
import { executeSandboxedBridgeMethod } from './sandbox-bridge-handler';
import { subscribeShellState } from './shell-bridge';
import {
  buildIframeSrcDoc,
  collectThemeCssVars,
  toPublicSessionDto,
} from './sandbox-iframe-utils';

export interface SandboxedPluginFrameProps {
  pluginId: string;
  instanceId?: string;
  pluginName: string;
  revision: string;
  slot: AnyPluginSlotKey;
  slotId: string;
  title: string;
  ui: string;
  session: Session | null;
  props?: Record<string, unknown>;
  defaultHeight?: number;
  compact?: boolean;
  onAction?: (action: string, params: Record<string, unknown>, signal: AbortSignal) => unknown;
  onLoadError?: (message: string) => void;
}

function serializeSafeProps(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'function' || typeof value === 'symbol') continue;
    try {
      out[key] = JSON.parse(JSON.stringify(value));
    } catch {
      // Drop non-serializable values before crossing iframe boundary
    }
  }
  return out;
}

export function SandboxedPluginFrame({
  pluginId,
  instanceId,
  pluginName,
  revision,
  slot,
  slotId,
  title,
  ui,
  session,
  props,
  defaultHeight,
  compact = false,
  onAction,
  onLoadError,
}: SandboxedPluginFrameProps) {
  const effectiveInstanceId = instanceId ?? pluginId;
  const registry = useSlotRegistry();
  const theme = useSlotTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<{ html: string; csp: string; runId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(defaultHeight ?? (compact ? 48 : 220));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const loadErrorRef = useRef(onLoadError);
  loadErrorRef.current = onLoadError;

  const sessionDto = useMemo(() => toPublicSessionDto(session), [session]);
  const safeProps = useMemo(() => {
    const base = serializeSafeProps(props);
    if (typeof base.apiBase !== 'string') {
      base.apiBase =
        typeof window !== 'undefined'
          ? window.harnessMateBridge?.daemonUrl || window.location?.origin || ''
          : '';
    }
    return base;
  }, [props]);
  const sessionDtoRef = useRef(sessionDto);
  sessionDtoRef.current = sessionDto;
  const safePropsRef = useRef(safeProps);
  safePropsRef.current = safeProps;
  const initialThemeRef = useRef(theme);
  const initialSessionRef = useRef(sessionDto);
  const initialPropsRef = useRef(safeProps);

  useEffect(() => {
    const controller = new AbortController();
    setDoc(null);
    setError(null);
    void daemonApi
      .getPluginUiDoc(effectiveInstanceId, ui, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setDoc({ html: res.html, csp: res.csp, runId: res.runId });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        registry.reportRenderFailure({
          pluginId,
          pluginName,
          slot,
          slotItemId: slotId,
          message: `UI 加载失败: ${message}`,
        });
        loadErrorRef.current?.(message);
      });
    return () => controller.abort();
  }, [pluginId, effectiveInstanceId, pluginName, revision, slot, slotId, ui, registry]);

  const srcDoc = useMemo(() => {
    if (!doc) return null;
    return buildIframeSrcDoc({
      html: doc.html,
      csp: doc.csp,
      theme: initialThemeRef.current,
      cssVars: collectThemeCssVars(),
      pluginId,
      instanceId: effectiveInstanceId,
      runId: doc.runId,
      slotId,
      slot,
      session: initialSessionRef.current,
      props: initialPropsRef.current,
      browserAvailable: Boolean(window.harnessMateBridge?.desktopView ?? window.harnessMateBridge?.pluginBrowser),
      desktopViewAvailable: Boolean(window.harnessMateBridge?.desktopView ?? window.harnessMateBridge?.pluginBrowser),
    });
  }, [doc, pluginId, effectiveInstanceId, slotId, slot]);

  // Live theme CSS variable sync without reloading iframe
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !doc) return;
    const message: PluginSlotBridgeHostMessage = {
      type: 'hm:theme',
      theme,
      cssVars: collectThemeCssVars(),
    };
    win.postMessage(message, '*');
  }, [theme, doc]);

  // Live session/props sync without reloading iframe
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !doc) return;
    const message: PluginSlotBridgeHostMessage = {
      type: 'hm:context',
      session: sessionDto,
      props: safeProps,
    };
    win.postMessage(message, '*');
  }, [sessionDto, safeProps, doc]);

  // Handle postMessage bridge requests from sandboxed iframe
  useEffect(() => {
    if (!doc) return;
    const activeRunId = doc.runId;
    const desktopView = window.harnessMateBridge?.desktopView ?? window.harnessMateBridge?.pluginBrowser;
    const viewId = desktopView ? window.crypto.randomUUID() : '';
    const rpcAbort = new AbortController();
    const requests = new Map<string, AbortController>();
    let disposed = false;
    let unsubscribeBrowser: (() => void) | undefined;
    const serviceSubscriptions = new Map<string, () => void>();
    const outputSubscriptions = new Map<string, () => void>();
    const unsubscribeShell = subscribeShellState((patch) => {
      if (Object.keys(patch).length) {
        iframeRef.current?.contentWindow?.postMessage({ type: 'hm:shell:state', runId: activeRunId, patch }, '*');
      }
    });
    const unsubscribeOutput = getSharedDaemonWs()?.observeFrames((frame) => {
      if (frame.op === 'command_output' && outputSubscriptions.has(`${frame.sessionId}::${frame.toolCallId}`)) {
        iframeRef.current?.contentWindow?.postMessage({ type: 'hm:output', runId: activeRunId, frame }, '*');
      }
    });

    const reply = (
      requestId: string,
      payload: { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } },
    ) => {
      const win = iframeRef.current?.contentWindow;
      if (disposed || rpcAbort.signal.aborted || !win) return;
      const msg: PluginSlotBridgeHostMessage = {
        type: 'hm:rpc:response',
        requestId,
        ...payload,
      };
      win.postMessage(msg, '*');
    };

    const runHostMethod = async (
      method: string,
      params: Record<string, unknown> | undefined,
      iframeWindow: Window,
      runId: string,
      signal: AbortSignal = rpcAbort.signal,
    ): Promise<unknown> => {
      if (method === 'outputs.subscribe' || method === 'outputs.unsubscribe') {
        const sessionId = String(params?.sessionId ?? '');
        const toolCallId = String(params?.toolCallId ?? '');
        const id = `${sessionId}::${toolCallId}`;
        outputSubscriptions.get(id)?.();
        outputSubscriptions.delete(id);
        if (method === 'outputs.subscribe') outputSubscriptions.set(id, useKernelStore.getState().subscribeCommandOutput(sessionId, toolCallId));
        return id;
      }
      if (method === 'services.unsubscribe') {
        const id = String(params?.subscriptionId ?? '');
        serviceSubscriptions.get(id)?.();
        serviceSubscriptions.delete(id);
        return {};
      }
      if (method === 'services.subscribe') {
        const connection = getSharedDaemonWs();
        if (!connection) throw new Error('事件连接尚未就绪');
        const contract = String(params?.contract ?? '');
        const instanceId = String(params?.instanceId ?? '');
        const subscriptionId = String(params?.subscriptionId ?? '');
        if (!contract || !instanceId || !subscriptionId) throw new Error('需要契约、实例和订阅 ID');
        serviceSubscriptions.get(subscriptionId)?.();
        return new Promise((resolve, reject) => {
          let acknowledged = false;
          const cancel = () => { serviceSubscriptions.get(subscriptionId)?.(); serviceSubscriptions.delete(subscriptionId); reject(new DOMException('请求已取消', 'AbortError')); };
          signal.addEventListener('abort', cancel, { once: true });
          const release = connection.subscribeService({ contract, instanceId,
            runId: typeof params?.runId === 'string' ? params.runId : undefined }, (batch) => {
            if (disposed || rpcAbort.signal.aborted) return;
            iframeWindow.postMessage({ type: 'hm:service:batch', runId: activeRunId,
              subscriptionId, batch }, '*');
            if (!acknowledged) { acknowledged = true; signal.removeEventListener('abort', cancel); resolve({ subscriptionId }); }
          });
          serviceSubscriptions.set(subscriptionId, release);
        });
      }
      if (method === 'surface.action' && actionRef.current && typeof params?.action === 'string') {
        return actionRef.current(params.action, params, rpcAbort.signal);
      }
      if (method.startsWith('browser.') || method.startsWith('desktopView.')) {
        if (!desktopView) {
          throw Object.assign(new Error('桌面视图预览需要 HarnessMate Desktop'), { code: 'E_NOT_SUPPORTED' });
        }
        const action = method.startsWith('browser.')
          ? method.slice('browser.'.length)
          : method.slice('desktopView.'.length);
        if ((action === 'open' || action === 'create' || action === 'mount' || action === 'navigate') && !unsubscribeBrowser) {
          unsubscribeBrowser = desktopView.subscribe(viewId, (update) => {
            if (disposed || rpcAbort.signal.aborted || iframeRef.current?.contentWindow !== iframeWindow) return;
            iframeWindow.postMessage('frame' in update
              ? { type: 'hm:browser:frame', runId, frame: update.frame } satisfies PluginSlotBridgeHostMessage
              : { type: 'hm:browser:status', runId, status: update.status } satisfies PluginSlotBridgeHostMessage, '*');
          });
        }
        const payload = (action === 'open' || action === 'create' || action === 'mount' || action === 'navigate')
          ? { url: params?.url, width: params?.width, height: params?.height, pluginId, instanceId: effectiveInstanceId, runId }
          : action === 'resize'
            ? { width: params?.width, height: params?.height }
            : action === 'focus'
              ? { focused: params?.focused }
              : params?.input;
        await desktopView.call(viewId, action, payload);
        return undefined;
      }

      return executeSandboxedBridgeMethod(
        {
          pluginId,
          effectiveInstanceId,
          slot,
          slotId,
          runId,
          currentSession: sessionRef.current,
          signal,
          isDisposed: () => disposed,
        },
        method,
        params,
      );
    };

    const onMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      if (event.data?.type === 'hm:rpc:cancel' && event.data.runId === activeRunId) {
        requests.get(event.data.requestId)?.abort(); return;
      }
      const raw = event.data as
        | PluginSlotBridgeIframeMessage
        | { type: 'hm:action'; action: string; params?: Record<string, unknown>; slotId?: string; runId?: string }
        | null;
      if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return;

      if (raw.type === 'hm:resize' && raw.slotId === slotId) {
        const clamped = Math.max(48, Math.min(960, Math.round(Number(raw.height) || 120)));
        setHeight(clamped);
        return;
      }

      if (raw.type === 'hm:ready' && raw.slotId === slotId) {
        iframeWindow.postMessage(
          {
            type: 'hm:theme',
            theme: useKernelStore.getState().theme,
            cssVars: collectThemeCssVars(),
          } satisfies PluginSlotBridgeHostMessage,
          '*',
        );
        iframeWindow.postMessage(
          {
            type: 'hm:context',
            session: sessionDtoRef.current,
            props: safePropsRef.current,
          } satisfies PluginSlotBridgeHostMessage,
          '*',
        );
        return;
      }

      if (raw.type === 'hm:action') {
        if (raw.runId && raw.runId !== activeRunId) return;
        const actionName = typeof raw.action === 'string' ? raw.action.trim() : '';
        if (
          actionName === 'navigateToSession' ||
          actionName === 'session.navigate' ||
          actionName === 'refreshSessions' ||
          actionName === 'refreshWorkspaces' ||
          actionName === 'switchInstance'
        ) {
          void runHostMethod(actionName, raw.params, iframeWindow, activeRunId).catch(() => {});
        }
        return;
      }

      if (raw.type === 'hm:rpc:request') {
        const { requestId, runId, method, params } = raw;
        if (runId !== activeRunId) {
          reply(requestId, {
            ok: false,
            error: { code: 'E_STALE_RUN', message: '插件 UI 实例已过期' },
          });
          return;
        }

        const controller = new AbortController();
        requests.set(requestId, controller);
        void runHostMethod(method, params, iframeWindow, runId, AbortSignal.any([controller.signal, rpcAbort.signal]))
          .then((result) => {
            if (disposed || rpcAbort.signal.aborted) return;
            reply(requestId, { ok: true, result });
          })
          .catch((err: unknown) => {
            if (disposed || rpcAbort.signal.aborted || isAbortError(err)) return;
            const errObj = err && typeof err === 'object' ? (err as { code?: unknown; message?: unknown }) : null;
            reply(requestId, {
              ok: false,
              error: {
                code: typeof errObj?.code === 'string' ? errObj.code : 'E_INVALID_INPUT',
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }).finally(() => requests.delete(requestId));
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      disposed = true;
      rpcAbort.abort();
      requests.clear();
      unsubscribeShell(); unsubscribeOutput?.();
      for (const release of outputSubscriptions.values()) release();
      outputSubscriptions.clear();
      for (const release of serviceSubscriptions.values()) release();
      serviceSubscriptions.clear();
      window.removeEventListener('message', onMessage);
      if (unsubscribeBrowser) {
        unsubscribeBrowser();
        void desktopView?.call(viewId, 'destroy').catch(() => {});
      }
    };
  }, [doc, pluginId, effectiveInstanceId, slot, slotId]);

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

  if (!srcDoc) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
        <Loader2 size={12.5} className="animate-spin text-[var(--accent-indigo)]" />
        <span>正在加载沙箱视图 {title}…</span>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={`${pluginName} · ${title}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={() => {
        iframeRef.current?.contentWindow?.postMessage({
          type: 'hm:context', session: sessionDtoRef.current, props: safePropsRef.current,
        } satisfies PluginSlotBridgeHostMessage, '*');
      }}
      className={slot === 'application.shell' || slot === 'workspace.pages' || slot === 'session.stage.embedded'
        ? 'block size-full border-0 bg-transparent'
        : 'w-full rounded-xl border border-[var(--border-hairline)] bg-transparent'}
      style={slot === 'application.shell' || slot === 'workspace.pages' || slot === 'session.stage.embedded' ? undefined : { height: `${height}px` }}
    />
  );
}
