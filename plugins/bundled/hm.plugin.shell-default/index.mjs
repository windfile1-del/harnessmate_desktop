const DEFAULT_SCOPE = 'default';

export function apply(ctx) {
  let writes = Promise.resolve();
  const key = (scope) => `layout:${scope || DEFAULT_SCOPE}`;

  const info = {
    layoutId: 'hm.plugin.shell-default',
    name: '默认工作台布局',
    version: '1.0.0',
    description: '默认三栏工作台：Sidebar、主舞台/工作页、InspectorDrawer、命令面板与全局弹窗框架。',
    supportsHotSwap: true,
    requiresRestartOnSwitch: false,
    regions: [
      { id: 'sidebar', title: '左侧栏', placements: ['side'] },
      { id: 'stage', title: '主工作区', placements: ['primary', 'tab'] },
      { id: 'inspector', title: '右侧检视抽屉', placements: ['drawer', 'side'] },
      { id: 'modal', title: '弹窗层', placements: ['modal'] },
      { id: 'statusbar', title: '状态栏', placements: ['inline'] },
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
