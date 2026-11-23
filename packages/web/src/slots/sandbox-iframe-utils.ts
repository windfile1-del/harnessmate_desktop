import type { PluginSlotKey, PublicSession, Session } from '@harnessmate/protocol';

export const THEME_CSS_VAR_NAMES = [
  '--bg-canvas',
  '--bg-rail',
  '--bg-surface',
  '--bg-elevated',
  '--bg-glass',
  '--bg-hover',
  '--bg-active',
  '--border-hairline',
  '--border-strong',
  '--border-focus',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--accent-indigo',
  '--accent-indigo-soft',
  '--accent-star',
  '--accent-star-soft',
  '--accent-emerald',
  '--accent-emerald-soft',
  '--accent-clay',
  '--accent-clay-soft',
  '--accent-rose',
  '--accent-rose-soft',
  '--code-bg',
] as const;

export function collectThemeCssVars(rootElement?: Element | null): Record<string, string> {
  const vars: Record<string, string> = {};
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return vars;
  }
  const target = rootElement ?? document.documentElement;
  if (!target) return vars;
  const computed = getComputedStyle(target);
  for (const name of THEME_CSS_VAR_NAMES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  return vars;
}

export function toPublicSessionDto(session: Session | null): PublicSession | null {
  if (!session) return null;
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    harnessId: session.harnessId,
    harnessKind: session.harnessKind,
    title: session.title,
    status: session.status,
    model: session.model,
    permissionMode: session.permissionMode,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildCssVarsDeclaration(theme: 'dark' | 'light', cssVars: Record<string, string>): string {
  const entries = Object.entries(cssVars)
    .filter(([key]) => /^--[a-z0-9-]+$/i.test(key))
    .map(([key, value]) => `  ${key}: ${value.replace(/[;{}<>]/g, '')};`);
  return [
    `:root {`,
    `  color-scheme: ${theme};`,
    ...entries,
    `}`,
    `html, body { margin: 0; padding: 0; background: transparent; color: var(--text-primary, inherit); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; font-size: 12.5px; line-height: 1.5; }`,
    `* { box-sizing: border-box; }`,
  ].join('\n');
}

export function buildIframeSrcDoc(params: {
  html: string;
  csp: string;
  theme: 'dark' | 'light';
  cssVars: Record<string, string>;
  pluginId: string;
  runId: string;
  slotId: string;
  slot: PluginSlotKey;
  session: PublicSession | null;
  props: Record<string, unknown>;
}): string {
  const sanitizedCssVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.cssVars)) {
    if (/^--[a-z0-9-]+$/i.test(key)) {
      sanitizedCssVars[key] = value.replace(/[;{}<>]/g, '');
    }
  }
  const initPayload = safeJsonForInlineScript({
    pluginId: params.pluginId,
    runId: params.runId,
    slotId: params.slotId,
    slot: params.slot,
    theme: params.theme,
    cssVars: sanitizedCssVars,
    session: params.session,
    props: params.props,
  });

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(params.csp)}">`;
  const themeStyle = `<style id="hm-theme-vars">\n${buildCssVarsDeclaration(params.theme, sanitizedCssVars)}\n</style>`;
  const bridgeScript = `<script id="hm-slot-bridge">
(function () {
  var init = ${initPayload};
  var pending = Object.create(null);
  var reqSeq = 0;
  var themeListeners = [];
  var contextListeners = [];

  function applyTheme(theme, cssVars) {
    init.theme = theme;
    init.cssVars = cssVars || {};
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    var root = document.documentElement.style;
    for (var key in init.cssVars) {
      if (/^--[a-z0-9-]+$/i.test(key)) {
        root.setProperty(key, String(init.cssVars[key]));
      }
    }
    for (var i = 0; i < themeListeners.length; i++) {
      try { themeListeners[i](theme, init.cssVars); } catch (_) {}
    }
  }

  function post(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (_) {}
  }

  function call(method, params) {
    var requestId = 'req_' + (++reqSeq) + '_' + Date.now();
    return new Promise(function (resolve, reject) {
      pending[requestId] = { resolve: resolve, reject: reject };
      post({
        type: 'hm:rpc:request',
        requestId: requestId,
        runId: init.runId,
        method: method,
        params: params || {},
      });
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hm:theme') {
      applyTheme(data.theme, data.cssVars);
    } else if (data.type === 'hm:context') {
      init.session = data.session || null;
      init.props = data.props || {};
      for (var i = 0; i < contextListeners.length; i++) {
        try { contextListeners[i](init.session, init.props); } catch (_) {}
      }
    } else if (data.type === 'hm:rpc:response') {
      var entry = pending[data.requestId];
      if (!entry) return;
      delete pending[data.requestId];
      if (data.ok) entry.resolve(data.result);
      else entry.reject(Object.assign(new Error((data.error && data.error.message) || 'RPC error'), { code: data.error && data.error.code }));
    }
  });

  function reportHeight() {
    var height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    if (height > 0) post({ type: 'hm:resize', slotId: init.slotId, height: height });
  }

  window.harnessMate = {
    get pluginId() { return init.pluginId; },
    get runId() { return init.runId; },
    get slotId() { return init.slotId; },
    get slot() { return init.slot; },
    get theme() { return init.theme; },
    get session() { return init.session; },
    get props() { return init.props; },
    call: call,
    sendToPlugin: function (payload) { return call('plugin.message', { payload: payload }); },
    setDraft: function (text) { return call('composer.setDraft', { text: String(text || '') }); },
    runCommand: function (command, args) { return call('command.run', { command: command, args: args || '' }); },
    toast: function (title, body, kind) { return call('ui.toast', { title: title, body: body, kind: kind || 'info' }); },
    resize: function (height) { post({ type: 'hm:resize', slotId: init.slotId, height: Number(height) || 120 }); },
    onTheme: function (cb) { themeListeners.push(cb); return function () { themeListeners = themeListeners.filter(function (fn) { return fn !== cb; }); }; },
    onContext: function (cb) { contextListeners.push(cb); return function () { contextListeners = contextListeners.filter(function (fn) { return fn !== cb; }); }; },
  };

  document.documentElement.setAttribute('data-theme', init.theme);
  window.addEventListener('DOMContentLoaded', function () {
    post({ type: 'hm:ready', slotId: init.slotId });
    reportHeight();
    if (typeof ResizeObserver === 'function' && document.body) {
      new ResizeObserver(reportHeight).observe(document.body);
    }
  });
})();
</script>`;

  const injectedHead = `${cspMeta}\n${themeStyle}\n${bridgeScript}`;
  if (/<head\b[^>]*>/i.test(params.html)) {
    return params.html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${injectedHead}`);
  }
  if (/<html\b[^>]*>/i.test(params.html)) {
    return params.html.replace(/<html\b[^>]*>/i, (match) => `${match}\n<head>${injectedHead}</head>`);
  }
  return `<!doctype html><html><head>${injectedHead}</head><body>${params.html}</body></html>`;
}
