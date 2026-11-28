const DEFAULT_SCOPE = 'default';

export function apply(ctx) {
  let writes = Promise.resolve();
  const key = (scope) => `shell-lite:${scope || DEFAULT_SCOPE}`;

  const info = {
    layoutId: 'hm.plugin.shell-lite',
    name: 'Shell Lite 外部布局',
    version: '1.0.0',
    description: '外部精简双栏布局：顶部会话与领域页导航、中间聊天/领域页舞台、右侧可折叠文件预览侧栏。',
    supportsHotSwap: true,
    requiresRestartOnSwitch: false,
    regions: [
      { id: 'topbar', title: '顶栏导航', placements: ['tab'] },
      { id: 'stage', title: '主舞台', placements: ['primary'] },
      { id: 'file-sidebar', title: '文件侧栏', placements: ['side', 'drawer'] },
    ],
  };

  function mutate(scope, patch, sourceId) {
    const operation = writes.then(async () => {
      const previous = (await ctx.storage.plugin.get(key(scope))) ?? {};
      const state = {
        ...previous,
        ...(patch && typeof patch === 'object' ? patch : {}),
        revision: (previous.revision ?? 0) + 1,
      };
      await ctx.storage.plugin.set(key(scope), state);
      ctx.services.publish('application.view.v1', {
        scope: scope || DEFAULT_SCOPE,
        state,
        sourceId,
      });
      return { ok: true, value: { state } };
    });
    writes = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  ctx.provide(
    'application.view.v1',
    {
      async getInfo() {
        return { ok: true, value: { info } };
      },
      async readLayoutState(req = {}) {
        await writes;
        const state = (await ctx.storage.plugin.get(key(req?.scope))) ?? {};
        return { ok: true, value: { state } };
      },
      writeLayoutState(req = {}) {
        return mutate(req?.scope, req?.patch, req?.sourceId);
      },
    },
    { version: '1.0.0' },
  );
}
