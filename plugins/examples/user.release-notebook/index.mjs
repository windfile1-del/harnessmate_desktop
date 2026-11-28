export function apply(ctx) {
  ctx.provide('example.release-notebook.v1', { getInfo: async () => ({ version: '1.0.0' }), read: async () => ({ text: await ctx.storage.plugin.get('note') || '' }) });
  ctx.slots.register({ slot: 'workspace.pages', id: 'notes', title: '发布便笺', ui: 'ui/index.html', async onMessage(input) { if (input.type === 'save') await ctx.storage.plugin.set('note', String(input.text || '')); return { text: await ctx.storage.plugin.get('note') || '' }; } });
}
