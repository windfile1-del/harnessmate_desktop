import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHistorySourcePlugin } from './history-source-runtime.mjs';

export function apply(ctx, config = {}) {
  const packageRoot = path.dirname(fileURLToPath(import.meta.url));
  return registerHistorySourcePlugin(ctx, config, {
    namespace: 'custom',
    harnessKind: 'custom',
    title: '自定义 JSONL 历史来源样例',
    packageRoot,
  });
}
