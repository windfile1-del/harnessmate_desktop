import { registerHistorySourcePlugin } from './history-source-runtime.mjs';

export function apply(ctx, config = {}) {
  return registerHistorySourcePlugin(ctx, config, {
    namespace: 'agy_cli',
    harnessKind: 'agy',
    title: 'Antigravity CLI 本机历史来源',
  });
}
