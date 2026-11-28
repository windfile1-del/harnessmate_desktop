export function apply(ctx) { ctx.provide('management.view.v1', { async getInfo() { return { version: '1.0.0', pageId: 'management' }; } }); }
