import type {
  PluginSlotBridgeHostMessage,
  PluginSlotBridgeIframeMessage,
  PluginSlotKey,
  Session,
} from '@harnessmate/protocol';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { daemonApi } from '../api/client';
import { useAppStore } from '../stores/app-store';
import { useSlotRegistry, useSlotTheme } from './hooks';
import {
  buildIframeSrcDoc,
  collectThemeCssVars,
  toPublicSessionDto,
} from './sandbox-iframe-utils';

export interface SandboxedPluginFrameProps {
  pluginId: string;
  pluginName: string;
  revision: string;
  slot: PluginSlotKey;
  slotId: string;
  title: string;
  ui: string;
  session: Session | null;
  props?: Record<string, unknown>;
  defaultHeight?: number;
  compact?: boolean;
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
}: SandboxedPluginFrameProps) {
  const registry = useSlotRegistry();
  const theme = useSlotTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<{ html: string; csp: string; runId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(defaultHeight ?? (compact ? 48 : 220));
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const sessionDto = useMemo(() => toPublicSessionDto(session), [session]);
  const safeProps = useMemo(() => serializeSafeProps(props), [props]);
  const initialThemeRef = useRef(theme);
  const initialSessionRef = useRef(sessionDto);
  const initialPropsRef = useRef(safeProps);

  useEffect(() => {
    const controller = new AbortController();
    setDoc(null);
    setError(null);
    void daemonApi
      .getPluginUiDoc(pluginId, ui, controller.signal)
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
      });
    return () => controller.abort();
  }, [pluginId, pluginName, revision, slot, slotId, ui, registry]);

  const srcDoc = useMemo(() => {
    if (!doc) return null;
    return buildIframeSrcDoc({
      html: doc.html,
      csp: doc.csp,
      theme: initialThemeRef.current,
      cssVars: collectThemeCssVars(),
      pluginId,
      runId: doc.runId,
      slotId,
      slot,
      session: initialSessionRef.current,
      props: initialPropsRef.current,
      browserAvailable: Boolean(window.harnessMateBridge?.pluginBrowser),
    });
  }, [doc, pluginId, slotId, slot]);

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
    const browser = window.harnessMateBridge?.pluginBrowser;
    const viewId = browser ? window.crypto.randomUUID() : '';
    let disposed = false;
    let unsubscribeBrowser: (() => void) | undefined;

    const reply = (
      requestId: string,
      payload: { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } },
    ) => {
      const win = iframeRef.current?.contentWindow;
      if (disposed || !win) return;
      const msg: PluginSlotBridgeHostMessage = {
        type: 'hm:rpc:response',
        requestId,
        ...payload,
      };
      win.postMessage(msg, '*');
    };

    const onMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      const data = event.data as PluginSlotBridgeIframeMessage | null;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

      if (data.type === 'hm:resize' && data.slotId === slotId) {
        const clamped = Math.max(48, Math.min(960, Math.round(Number(data.height) || 120)));
        setHeight(clamped);
        return;
      }

      if (data.type === 'hm:ready' && data.slotId === slotId) {
        iframeWindow.postMessage(
          {
            type: 'hm:theme',
            theme: useAppStore.getState().theme,
            cssVars: collectThemeCssVars(),
          } satisfies PluginSlotBridgeHostMessage,
          '*',
        );
        return;
      }

      if (data.type === 'hm:rpc:request') {
        const { requestId, runId, method, params } = data;
        if (runId !== activeRunId) {
          reply(requestId, {
            ok: false,
            error: { code: 'E_STALE_RUN', message: '插件 UI 实例已过期' },
          });
          return;
        }

        void (async () => {
          try {
            const currentSession = sessionRef.current;
            const store = useAppStore.getState();

            if (method.startsWith('browser.')) {
              if (!browser) {
                reply(requestId, { ok: false, error: { code: 'E_NOT_SUPPORTED', message: '浏览器预览需要 HarnessMate Desktop' } });
                return;
              }
              const action = method.slice('browser.'.length);
              if (action === 'open' && !unsubscribeBrowser) {
                unsubscribeBrowser = browser.subscribe(viewId, (update) => {
                  if (disposed || iframeRef.current?.contentWindow !== iframeWindow) return;
                  iframeWindow.postMessage('frame' in update
                    ? { type: 'hm:browser:frame', runId, frame: update.frame } satisfies PluginSlotBridgeHostMessage
                    : { type: 'hm:browser:status', runId, status: update.status } satisfies PluginSlotBridgeHostMessage, '*');
                });
              }
              await browser.call(viewId, action, action === 'open'
                ? { url: params?.url, width: params?.width, height: params?.height, pluginId, runId }
                : params?.input);
              reply(requestId, { ok: true });
              return;
            }

            if (method === 'plugin.message') {
              const res = await daemonApi.sendPluginUiMessage(pluginId, {
                slotId,
                slot,
                runId,
                sessionId: currentSession?.id ?? null,
                payload: params?.payload,
              });
              reply(requestId, { ok: true, result: res.result });
              return;
            }

            if (method === 'composer.setDraft') {
              if (!currentSession) {
                reply(requestId, {
                  ok: false,
                  error: { code: 'E_NOT_SUPPORTED', message: '当前没有活动会话' },
                });
                return;
              }
              const text = typeof params?.text === 'string' ? params.text.slice(0, 12_000) : '';
              store.setDraftText(currentSession.id, text);
              reply(requestId, { ok: true, result: { ok: true } });
              return;
            }

            if (method === 'ui.toast') {
              const toastTitle = String(params?.title ?? '').trim().slice(0, 120);
              if (!toastTitle) {
                reply(requestId, {
                  ok: false,
                  error: { code: 'E_INVALID_INPUT', message: '通知标题不能为空' },
                });
                return;
              }
              const rawKind = params?.kind;
              const kind = rawKind === 'success' || rawKind === 'warning' || rawKind === 'error' ? rawKind : 'info';
              store.pushToast({
                kind,
                title: toastTitle,
                body: typeof params?.body === 'string' ? params.body.slice(0, 300) : undefined,
              });
              reply(requestId, { ok: true, result: { ok: true } });
              return;
            }

            if (method === 'command.run') {
              if (!currentSession) {
                reply(requestId, {
                  ok: false,
                  error: { code: 'E_NOT_SUPPORTED', message: '当前没有活动会话' },
                });
                return;
              }
              const command = String(params?.command ?? '').trim();
              const args = typeof params?.args === 'string' ? params.args : '';
              const result = await store.runPluginAction(currentSession.id, {
                command,
                harnessId: currentSession.harnessId,
                args,
              });
              reply(requestId, { ok: true, result });
              return;
            }

            reply(requestId, {
              ok: false,
              error: { code: 'E_NOT_SUPPORTED', message: `不支持的 UI 桥接方法: ${method}` },
            });
          } catch (err) {
            reply(requestId, {
              ok: false,
              error: {
                code: 'E_INVALID_INPUT',
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        })();
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      disposed = true;
      window.removeEventListener('message', onMessage);
      if (unsubscribeBrowser) {
        unsubscribeBrowser();
        void browser?.call(viewId, 'close').catch(() => {});
      }
    };
  }, [doc, pluginId, slot, slotId]);

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
      className="w-full rounded-xl border border-[var(--border-hairline)] bg-transparent"
      style={{ height: `${height}px` }}
    />
  );
}
