export function apply(ctx) { ctx.provide('management.view.v1', { getInfo: async () => ({ name: 'External Management Lite', version: '1.0.0' }) }); }
