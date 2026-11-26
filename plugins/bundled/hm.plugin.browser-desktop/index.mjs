export const requires = ['ui.workspace.pages', 'desktop.view.v1'];

export async function apply(ctx) {
  let state = {
    currentUrl: '',
    history: [],
    lastSessionId: null,
    updatedAt: Date.now(),
  };

  try {
    const saved = await ctx.storage.plugin.get('browserState');
    if (saved && typeof saved === 'object') {
      state = {
        currentUrl: typeof saved.currentUrl === 'string' ? saved.currentUrl : '',
        history: Array.isArray(saved.history) ? saved.history.slice(-20) : [],
        lastSessionId: typeof saved.lastSessionId === 'string' ? saved.lastSessionId : null,
        updatedAt: typeof saved.updatedAt === 'number' ? saved.updatedAt : Date.now(),
      };
    }
  } catch {
    // Storage optional if denied
  }

  async function persist() {
    state.updatedAt = Date.now();
    try {
      await ctx.storage.plugin.set('browserState', state);
    } catch {
      // Ignore storage error if not granted
    }
  }

  function recordUrl(url, sessionId = null) {
    const cleaned = String(url || '').trim();
    if (!cleaned) return state;
    state.currentUrl = cleaned;
    if (sessionId) state.lastSessionId = sessionId;
    if (state.history[state.history.length - 1] !== cleaned) {
      state.history = [...state.history, cleaned].slice(-20);
    }
    void persist();
    return state;
  }

  ctx.provide(
    'browser.v1',
    {
      getInfo() {
        return {
          kind: 'desktop',
          pluginId: ctx.pluginId,
          instanceId: ctx.instanceId,
          runId: ctx.runId,
          title: '桌面浏览器',
        };
      },
      async open(url, sessionId = null) {
        recordUrl(url, sessionId);
        return { ok: true, kind: 'desktop', instanceId: ctx.instanceId, ...state };
      },
      getState() {
        return { ok: true, kind: 'desktop', instanceId: ctx.instanceId, ...state };
      },
      getHistory() {
        return [...state.history];
      },
      async close() {
        state.currentUrl = '';
        await persist();
        return { ok: true };
      },
    },
    { version: '1.0.0', metadata: { kind: 'desktop', title: '桌面浏览器' } },
  );

  ctx.routes.register('/state', () => ({
    status: 200,
    body: {
      ok: true,
      kind: 'desktop',
      pluginId: ctx.pluginId,
      instanceId: ctx.instanceId,
      runId: ctx.runId,
      state,
    },
  }));

  ctx.slots.register({
    slot: 'workspace.pages',
    id: 'desktop-browser',
    title: '桌面浏览器',
    ui: 'ui/panel.html',
    order: 10,
    async onMessage(payload, meta) {
      if (!payload || typeof payload !== 'object') return { error: '无效请求' };
      if (payload.type === 'getState') {
        return {
          ok: true,
          instanceId: ctx.instanceId,
          pluginId: ctx.pluginId,
          runId: ctx.runId,
          state,
        };
      }
      if (payload.type === 'recordUrl' && typeof payload.url === 'string') {
        recordUrl(payload.url, meta?.sessionId ?? null);
        return { ok: true, state };
      }
      if (payload.type === 'clearHistory') {
        state.history = [];
        await persist();
        return { ok: true, state };
      }
      return { error: '未知桌面浏览器操作' };
    },
  });
}
