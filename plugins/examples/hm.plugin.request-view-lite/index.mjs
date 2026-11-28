export function apply(ctx) {
  ctx.provide('runtime.requests.view.v1', { getSurfaces: () => ({ ok: true, value: ['requests-queue'] }) }, { version: '1.0.0' });
}
