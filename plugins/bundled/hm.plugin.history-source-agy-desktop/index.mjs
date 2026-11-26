import { registerHistorySourcePlugin } from './history-source-runtime.mjs';

export function apply(ctx, config = {}) {
  return registerHistorySourcePlugin(ctx, config, {
    namespace: 'agy_desktop',
    harnessKind: 'agy',
    title: 'Antigravity Desktop 本机历史来源',
  });
}
