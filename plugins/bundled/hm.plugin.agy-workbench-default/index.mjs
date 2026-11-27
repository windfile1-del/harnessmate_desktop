const DEFAULT_STATE = {
  surface: 'chat',
  layout: 'split',
  selectedActivityId: null,
  selectedWorkId: null,
  selectedAgentId: null,
  selectedWorkflowId: null,
  revision: 0,
};

const SURFACES = ['chat', 'runtime', 'subagents', 'swarm', 'boost', 'teamwork', 'dynamic', 'tasks'];

const EMBEDDED_REGIONS = [
  { region: 'session.stage.embedded', slotId: 'agy-workbench', title: 'AGY 原生工作台', ui: 'ui/index.html' },
  { region: 'workspace.pages', slotId: 'agy-workbench', title: 'AGY 工作台', ui: 'ui/index.html' },
  { region: 'composer.actions', slotId: 'agy-composer', title: 'AGY 原生控制', ui: 'ui/index.html' },
  { region: 'inspector.tabs', slotId: 'agy-artifacts', title: 'Artifact 审阅', ui: 'ui/index.html' },
  { region: 'inspector.tabs', slotId: 'agy-ecosystem', title: 'AGY 生态边界', ui: 'ui/index.html' },
  { region: 'inspector.tabs', slotId: 'agy-native-runtime', title: 'AGY Native Runtime', ui: 'ui/index.html' },
  { region: 'harness.settings', slotId: 'agy-settings', title: 'AGY 多账号隔离与官方认证', ui: 'ui/index.html' },
  { region: 'session.sidebar.badge', slotId: 'agy-native-badge', title: 'AGY 原生运行时状态徽标', ui: 'ui/index.html' },
];

export function apply(ctx) {
  let writes = Promise.resolve();
  const key = (sessionId) => `workbench:${sessionId}`;

  const mutate = (sessionId, patch, sourceId) => {
    const op = writes.then(async () => {
      const prev = (await ctx.storage.plugin.get(key(sessionId))) ?? DEFAULT_STATE;
      const next = {
        ...DEFAULT_STATE,
        ...prev,
        ...patch,
        revision: (prev.revision ?? 0) + 1,
      };
      await ctx.storage.plugin.set(key(sessionId), next);
      ctx.services.publish('agy.workbench.v1', {
        sessionId,
        state: next,
        sourceId: sourceId ?? null,
      });
      return { ok: true, value: { state: next } };
    });
    writes = op.then(() => {}, () => {});
    return op;
  };

  ctx.provide(
    'agy.workbench.v1',
    {
      async getProviderInfo() {
        return {
          ok: true,
          value: {
            pluginId: ctx.pluginId ?? 'hm.plugin.agy-workbench-default',
            instanceId: ctx.instanceId ?? 'hm.plugin.agy-workbench-default',
            runId: ctx.runId ?? 'workbench',
            surfaces: SURFACES,
            embeddedRegions: EMBEDDED_REGIONS,
          },
        };
      },
      async readWorkbenchState({ sessionId }) {
        await writes;
        const stored = (await ctx.storage.plugin.get(key(sessionId))) ?? DEFAULT_STATE;
        return { ok: true, value: { state: { ...DEFAULT_STATE, ...stored } } };
      },
      writeWorkbenchState({ sessionId, patch, sourceId }) {
        return mutate(sessionId, patch ?? {}, sourceId);
      },
    },
    { version: '1.0.0' },
  );
}
