import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PLUGIN_API_VERSION, PLUGIN_UI_SLOTS, PluginManifestV4Schema, pluginErrorCodes, pluginEventContracts } from '../packages/plugin-api/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const output = new Map();
const heading = (title) => `# ${title}\n\n由 \`pnpm contracts:generate\` 生成。插件 API ${PLUGIN_API_VERSION}。\n\n`;

for (const name of ['plugin-api', 'plugin-sdk']) {
  const directory = path.join(root, 'packages', name);
  const allowed = new Set(name === 'plugin-api' ? ['zod'] : ['zod', '@harnessmate/plugin-api']);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!allowed.has(dependency)) throw new Error(`${name} 依赖了非公共包 ${dependency}`);
  }
  for (const file of fs.readdirSync(path.join(directory, 'src'), { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const absolute = path.join(directory, 'src', file);
    const imports = ts.preProcessFile(fs.readFileSync(absolute, 'utf8'), true, true).importedFiles;
    for (const { fileName } of imports) {
      const local = fileName.startsWith('.') && !path.relative(directory, path.resolve(path.dirname(absolute), fileName)).startsWith('..');
      if (!local && !allowed.has(fileName)) throw new Error(`${name}/${file} 引用了非公共模块 ${fileName}`);
    }
  }
}

const daemon = 'packages/daemon/src';
const producers = {
  'session.created': 'core/session-manager.ts', 'session.closing': 'core/session-manager.ts',
  'plugin.state': 'plugin-host/runtime/lifecycle.ts',
  'handoff.compose': 'core/context-compiler.ts',
  'handoff.shouldOffer': 'core/session-manager.ts',
  'approval.annotate': 'core/session-manager.ts',
};
const mapper = read(`${daemon}/plugin-host/runtime/map-event.ts`);
const builtin = read(`${daemon}/plugin-host/builtin/services.ts`);
const eventRows = Object.entries(pluginEventContracts).map(([name, { mode, permission }]) => {
  const producer = producers[name] ?? (mapper.includes(`'${name}'`) ? 'plugin-host/runtime/map-event.ts' : null);
  const listener = builtin.includes(`ctx.on('${name}'`) ? 'plugin-host/builtin/services.ts' : null;
  return `| \`${name}\` | ${mode} | ${permission ? `\`${permission}\`` : '—'} | ${producer ?? '契约预留'} | ${listener ?? '—'} |`;
});
output.set('events.md', heading('公共事件') +
  '| 事件 | 分发 | 权限契约 | 生产方 | 内置消费方 |\n| --- | --- | --- | --- | --- |\n' + eventRows.join('\n') + '\n');

const serviceNames = [
  ...[...builtin.matchAll(/adapterPlugin\('([^']+)'/g)].map(([, id]) => `harness.${id}`),
  ...[...builtin.matchAll(/provides: \['([^']+)'\]/g)].map(([, name]) => name),
].sort();
const handoffConfig = builtin.match(/export const handoffConfigSchema = (z\.object\(\{[\s\S]+?\}\).*?);/);
output.set('services.md', heading('宿主服务与配置') +
  '第一方服务按名称注册；第三方 V4 隔离插件可在声明 `service:provide:<name>` 并获授权后替换公共服务（`ledger`、`handoff`、`git`、`usage`、`notify`），或提供带命名空间前缀的第三方服务。`harness.*` 仅允许第一方提供。\n\n' +
  serviceNames.map((name) => `- \`${name}\`\n`).join('') +
  '\n## 交接配置\n\n```ts\n' + (handoffConfig?.[1] ?? '') + '\n```\n');

const slotRows = Object.entries(PLUGIN_UI_SLOTS).map(([key, { cardinality, scope, description }]) =>
  `| \`${key}\` | \`${cardinality}\` | \`${scope}\` | ${description} |`);
output.set('slots.md', heading('公共 UI 插槽') +
  '第一方与内核级插件可直接注册 React 组件；第三方插件在 `contributes.slots` 或 `ctx.slots.register()` 中声明包内 HTML 入口，由宿主在 `sandbox="allow-scripts"` 沙箱 iframe 中渲染。\n\n' +
  '| 插槽 | 基数 | 作用域 | 说明 |\n| --- | --- | --- | --- |\n' + slotRows.join('\n') + '\n');

const surface = ['context', 'events', 'rpc', 'slots', 'browser-preview'].map((name) => read(`packages/plugin-api/dist/${name}.d.ts`)
  .split('\n').filter((line) => !line.startsWith('//# sourceMappingURL')).join('\n').trim()).join('\n\n');
output.set('plugin-api.api.md', heading('插件 API 报告') +
  '清单与声明式贡献点见同目录 JSON Schema。公共错误码见类型声明。\n\n' +
  '```ts\n' + surface + '\n```\n');
output.set('manifest-v4.schema.json',
  JSON.stringify(zodToJsonSchema(PluginManifestV4Schema, 'PluginManifestV4'), null, 2) + '\n');

if (new Set(pluginErrorCodes).size !== pluginErrorCodes.length) throw new Error('插件错误码重复');
const docs = path.join(root, 'docs', 'plugin-api');
if (!check) fs.mkdirSync(docs, { recursive: true });
for (const [filename, content] of output) {
  const relative = path.join('docs', 'plugin-api', filename);
  const full = path.join(root, relative);
  if (!check) fs.writeFileSync(full, content);
  else if (!fs.existsSync(full) || read(relative) !== content) {
    throw new Error(`${relative} 与源码契约不匹配，请运行 pnpm contracts:generate`);
  }
}
