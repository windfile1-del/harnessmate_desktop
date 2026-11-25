import { Code2, Maximize2, ShieldAlert, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatByteSize } from '../lib/harness-meta';
import { collectThemeCssVars, useSlotTheme } from '../slots';

export const HTML_RENDER_MAX_BYTES = 512 * 1024;
export const HTML_RENDER_STRICT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'";

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildThemeCss(theme: 'dark' | 'light', cssVars: Record<string, string>): string {
  const lines = Object.entries(cssVars)
    .filter(([k]) => /^--[a-z0-9-]+$/i.test(k))
    .map(([k, v]) => `  ${k}: ${v.replace(/[;{}<>]/g, '')};`);
  return [
    ':root {',
    `  color-scheme: ${theme};`,
    ...lines,
    '}',
    'html, body { margin: 0; padding: 12px; background: transparent; color: var(--text-primary, inherit); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
    '* { box-sizing: border-box; }',
  ].join('\n');
}

/**
 * Builds a doubly-isolated HTML srcDoc with strict CSP, theme CSS variable injection,
 * modal dialog blocking (alert/confirm/prompt), and ResizeObserver height sync.
 * Zero host RPC, zero parent/same-origin access, zero external network scripts.
 */
export function buildSandboxedHtmlRenderSrcDoc(params: {
  html: string;
  theme: 'dark' | 'light';
  cssVars: Record<string, string>;
  renderId: string;
}): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(HTML_RENDER_STRICT_CSP)}">`;
  const styleTag = `<style id="hm-html-render-theme">\n${buildThemeCss(params.theme, params.cssVars)}\n</style>`;
  const safeId = JSON.stringify(params.renderId).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const guardScript = `<script id="hm-html-render-guard">
(function () {
  var renderId = ${safeId};
  try {
    window.alert = function () {};
    window.confirm = function () { return false; };
    window.prompt = function () { return null; };
  } catch (_) {}
  function reportHeight() {
    var h = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    if (h > 0) {
      try { window.parent.postMessage({ type: 'hm:html-render:resize', renderId: renderId, height: h }, '*'); } catch (_) {}
    }
  }
  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    var data = ev.data;
    if (!data || data.type !== 'hm:theme') return;
    document.documentElement.setAttribute('data-theme', data.theme);
    document.documentElement.style.colorScheme = data.theme;
    var vars = data.cssVars || {};
    for (var k in vars) {
      if (/^--[a-z0-9-]+$/i.test(k)) {
        document.documentElement.style.setProperty(k, String(vars[k]));
      }
    }
  });
  document.documentElement.setAttribute('data-theme', ${JSON.stringify(params.theme)});
  window.addEventListener('DOMContentLoaded', function () {
    reportHeight();
    if (typeof ResizeObserver === 'function' && document.body) {
      new ResizeObserver(reportHeight).observe(document.body);
    }
  });
})();
</script>`;

  const headInject = `${cspMeta}\n${styleTag}\n${guardScript}`;
  // The browser applies the host policy before it parses supplied markup.
  return `<!doctype html><html><head>${headInject}</head>
${params.html}`;
}

export interface HtmlRenderCardProps {
  renderId: string;
  title: string;
  html: string;
  preferredHeightPx?: number;
  allowFullscreen?: boolean;
}

export function HtmlRenderCard({
  renderId,
  title,
  html,
  preferredHeightPx,
  allowFullscreen = true,
}: HtmlRenderCardProps) {
  const theme = useSlotTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const modalIframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(
    Math.max(120, Math.min(720, preferredHeightPx ?? 280)),
  );
  const [showSource, setShowSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const byteLength = useMemo(() => new TextEncoder().encode(html).length, [html]);
  const exceedsLimit = byteLength > HTML_RENDER_MAX_BYTES;
  const initialThemeRef = useRef(theme);

  const srcDoc = useMemo(() => {
    if (exceedsLimit) return null;
    return buildSandboxedHtmlRenderSrcDoc({
      html,
      theme: initialThemeRef.current,
      cssVars: collectThemeCssVars(),
      renderId,
    });
  }, [exceedsLimit, html, renderId]);

  useEffect(() => {
    if (exceedsLimit) return;
    const msg = { type: 'hm:theme', theme, cssVars: collectThemeCssVars() };
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
    modalIframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, [theme, exceedsLimit]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data as { type?: string; renderId?: string; height?: number } | null;
      if (data?.type === 'hm:html-render:resize' && data.renderId === renderId) {
        const next = Math.max(120, Math.min(760, Math.round(Number(data.height) || 280)));
        setHeight(next);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [renderId]);

  return (
    <div
      data-testid="html-render-card"
      className="overflow-hidden rounded-xl"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)',
      }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 text-[11.5px]"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={12.5} className="shrink-0 text-[var(--accent-indigo)]" />
          <span className="truncate font-medium text-[var(--text-primary)]">{title || 'HTML 交互预览'}</span>
          <span className="rounded px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]" style={{ backgroundColor: 'var(--bg-surface)' }}>
            sandbox · {formatByteSize(byteLength)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Code2 size={11.5} />
            <span>{showSource ? '视图' : '源码'}</span>
          </button>
          {allowFullscreen && !exceedsLimit && (
            <button
              type="button"
              aria-label="全屏查看 HTML 渲染"
              onClick={() => setFullscreen(true)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Maximize2 size={11.5} />
              <span>全屏</span>
            </button>
          )}
        </div>
      </div>

      {exceedsLimit ? (
        <div className="space-y-2 p-3 text-[11.5px]">
          <div className="flex items-center gap-1.5 text-[var(--accent-rose)]">
            <ShieldAlert size={13.5} />
            <span>
              HTML 文档体积 ({formatByteSize(byteLength)}) 超过安全上限 (512 KB)，已拒绝沙箱渲染并回退源码展示。
            </span>
          </div>
          <pre
            className="m-0 max-h-[260px] overflow-auto rounded-lg p-2.5 font-mono-code text-[11px] text-[var(--text-secondary)]"
            style={{ backgroundColor: 'var(--code-bg)' }}
          >
            {html.slice(0, 12_000)}
            {html.length > 12_000 ? '\n… (truncated)' : ''}
          </pre>
        </div>
      ) : showSource ? (
        <pre
          className="m-0 max-h-[320px] overflow-auto p-3 font-mono-code text-[11px] text-[var(--text-secondary)]"
          style={{ backgroundColor: 'var(--code-bg)' }}
        >
          {html}
        </pre>
      ) : (
        <iframe
          ref={iframeRef}
          title={title || 'Sandboxed HTML Render'}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc ?? ''}
          className="block w-full border-0 bg-transparent"
          style={{ height: `${height}px` }}
        />
      )}

      {fullscreen && srcDoc && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title || 'HTML 预览全屏'}
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ backgroundColor: 'rgba(4, 6, 12, 0.76)', backdropFilter: 'blur(8px)' }}
          onClick={() => setFullscreen(false)}
        >
          <div
            className="flex h-[86vh] w-[90vw] max-w-[1180px] flex-col overflow-hidden rounded-2xl"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-strong)',
              boxShadow: 'var(--shadow-float)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderBottom: '1px solid var(--border-hairline)' }}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                <Sparkles size={13.5} className="text-[var(--accent-indigo)]" />
                <span>{title || 'HTML 交互预览'}</span>
              </div>
              <button
                type="button"
                aria-label="关闭全屏预览"
                onClick={() => setFullscreen(false)}
                className="cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <X size={16} />
              </button>
            </div>
            <iframe
              ref={modalIframeRef}
              title={`${title || 'Sandboxed HTML Render'} (Fullscreen)`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
              className="w-full flex-1 border-0 bg-transparent"
            />
          </div>
        </div>
      )}
    </div>
  );
}
