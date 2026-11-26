import { registerHistorySourcePlugin } from './history-source-runtime.mjs';

export function apply(ctx, config = {}) {
  return registerHistorySourcePlugin(ctx, config, {
    namespace: 'claude',
    harnessKind: 'claude',
    title: 'Claude Code 本机历史来源',
  });
}
