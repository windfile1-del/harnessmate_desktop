import { registerHistorySourcePlugin } from './history-source-runtime.mjs';

export function apply(ctx, config = {}) {
  return registerHistorySourcePlugin(ctx, config, {
    namespace: 'codex',
    harnessKind: 'codex',
    title: 'Codex 本机历史来源',
  });
}
