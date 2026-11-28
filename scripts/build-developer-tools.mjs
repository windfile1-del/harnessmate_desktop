import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'packages/electron/package.json'));
const { build } = require('esbuild');
const output = path.join(root, 'plugins/bundled/hm.plugin.developer-tools/runtime');
fs.mkdirSync(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'packages/daemon/src/plugins/developer-tools/index.ts')], outfile: path.join(output, 'index.mjs'), platform: 'node', target: 'node22', format: 'esm', banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' }, bundle: true, external: ['node:*'], logLevel: 'info' });
await build({ entryPoints: [path.join(root, 'packages/plugin-sdk/src/testing.ts')], outfile: path.join(output, 'plugin-sdk-testing.mjs'), platform: 'node', target: 'node22', format: 'esm', banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' }, bundle: true, external: ['node:*'], logLevel: 'info' });
fs.copyFileSync(path.join(root, 'docs/plugin-api/ai-builder-context.md'), path.join(output, 'ai-builder-context.md'));

for (const id of ['management-default', 'developer-tools']) {
  const dir = path.join(root, 'plugins/bundled/hm.plugin.' + id);
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'view.html'), path.join(dir, 'ui/index.html'));
}
