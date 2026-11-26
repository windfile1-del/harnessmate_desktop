import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ALL_PLUGIN_UI_SLOTS,
  FILE_PREVIEW_FEATURE,
  HOST_FEATURES_V5,
  PLUGIN_API_VERSION,
  PluginManifestV4Schema,
  STATIC_PLUGIN_PERMISSIONS,
  pluginErrorCodes,
  pluginEventContracts,
} from '../packages/plugin-api/dist/index.js';

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
  'triage.snooze_expired': 'core/triage-inbox-service.ts',
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
  ...[...builtin.matchAll(/provides:\s*\[([^\]]+)\]/g)].flatMap(([, list]) =>
    [...list.matchAll(/'([^']+)'/g)].map(([, name]) => name),
  ),
].sort();
const handoffConfig = builtin.match(/export const handoffConfigSchema = (z\.object\(\{[\s\S]+?\}\).*?);/);
output.set('services.md', heading('宿主服务与配置') +
  '第一方服务按名称注册；第三方 V4 隔离插件可在声明 `service:provide:<name>` 并获授权后替换公共服务（`ledger`、`handoff`、`git`、`usage`、`notify`），或提供带命名空间前缀的第三方服务。`harness.*` 仅允许第一方提供。\n\n' +
  serviceNames.map((name) => `- \`${name}\`\n`).join('') +
  '\n## 交接配置\n\n```ts\n' + (handoffConfig?.[1] ?? '') + '\n```\n');

const slotRows = Object.entries(ALL_PLUGIN_UI_SLOTS).map(([key, { cardinality, scope, description }]) =>
  `| \`${key}\` | \`${cardinality}\` | \`${scope}\` | ${description} |`);
output.set('slots.md', heading('公共 UI 插槽') +
  '第一方与内核级插件可直接注册 React 组件；第三方插件在 `contributes.slots` 或 `ctx.slots.register()` 中声明包内 HTML 入口，由宿主在 `sandbox="allow-scripts"` 沙箱 iframe 中渲染。包含全部 V4 与 V5 插槽契约。\n\n' +
  '| 插槽 | 基数 | 作用域 | 说明 |\n| --- | --- | --- | --- |\n' + slotRows.join('\n') + '\n');

const surface = ['context', 'events', 'rpc', 'slots', 'browser-preview', 'file-preview'].map((name) => read(`packages/plugin-api/dist/${name}.d.ts`)
  .split('\n').filter((line) => !line.startsWith('//# sourceMappingURL')).join('\n').trim()).join('\n\n');
output.set('plugin-api.api.md', heading('插件 API 报告') +
  '清单与声明式贡献点见同目录 JSON Schema。公共错误码见类型声明。\n\n' +
  '```ts\n' + surface + '\n```\n');
output.set('manifest-v4.schema.json',
  JSON.stringify(zodToJsonSchema(PluginManifestV4Schema, 'PluginManifestV4'), null, 2) + '\n');

// Compact machine-readable SDK knowledge pack for AI Plugin Builder v2 (<= 18KB / ~6,000 tokens)
const compactEvents = Object.entries(pluginEventContracts)
  .map(([name, { mode, permission }]) => `| \`${name}\` | ${mode} | ${permission ? `\`${permission}\`` : '—'} |`)
  .join('\n');

const aiBuilderContext = [
  `# HarnessMate Plugin SDK · AI Builder v2 Context Pack`,
  ``,
  `> Auto-generated by \`pnpm contracts:generate\`. API \`${PLUGIN_API_VERSION}\`. Features: ${[...HOST_FEATURES_V5, FILE_PREVIEW_FEATURE].map((f) => `\`${f}\``).join(', ')}.`,
  ``,
  `## 1. Manifest V4/V5 Required Structure (\`harnessmate-plugin.json\`)`,
  `- Required: \`id\` (\`user.<slug>\` or \`<org>.<slug>\`; forbidden prefixes: \`core.\`, \`broken.\`), \`name\` (1-80 chars), \`version\` (semver), \`description\`, \`apiVersion: 4\`, \`engines: { "pluginApi": "^4.0" }\`, \`category\` (\`workflow|ui|tool|harness|telemetry|mcp|remote\`).`,
  `- Code plugin entry: \`main: "index.mjs"\` (ESM exporting \`export function apply(ctx, config) {}\`).`,
  `- Dependencies: \`inject?: string[]\` (required services), \`optional?: string[]\`, \`provides?: string[]\` (namespaced \`org.svc\` or replaceable public service).`,
  `- Minimal permissions: \`permissions: string[]\`. Declare only required static or dynamic permissions.`,
  `- UI slots: \`contributes.slots: [{ slot, id, title, ui: "ui/xxx.html", key?, order?, height? }]\`. \`ui\` must be package-relative \`.html/.htm\`.`,
  `- File preview: declare \`contributes.filePreview: { extensions: [".md"] }\` and \`file:preview\`. Export \`renderFilePreview(file)\` and return \`{ version: 1, format: "markdown" | "text", content, line? }\` or \`null\`. The user selects the provider in plugin composition after granting workspace access.`,
  ``,
  `## 2. Core IsolatedPluginContextV5 API Signatures`,
  `\`\`\`ts`,
  `// Harness Adapter (requires 'harness:driver:register')`,
  `ctx.harnesses.registerDriver({ driverId, displayName, description, protocolLabel, capabilities, capabilitiesV2, presentation, probe, probePassive?, readUsageLimits?, createSession }): Disposer`,
  `ctx.harnesses.listInstances(): Promise<PublicHarnessInstanceInfo[]>`,
  `// Managed CLI Process (requires 'process:spawn:<binary>')`,
  `ctx.runtime.spawnCli({ command, args, cwd?, cwdWorkspaceId?, extraEnv?, unsetEnv?, timeoutMs? }): Promise<ManagedCliProcessHandle>`,
  `// Network (requires 'net:<host>') & Secrets (requires 'secrets:read:<ns>')`,
  `ctx.net.fetch(url, init?): Promise<PublicNetResponse>`,
  `ctx.net.openStream(url, init?): Promise<PublicNetStreamHandle> // onChunk, onEnd, onError, close`,
  `ctx.secrets.resolve(secretRef): Promise<string | null> // secretRef format: "<namespace>:<key>"`,
  `// Sessions, Handoff, Tools, Commands, Slots, Storage, FS`,
  `ctx.sessions.{ list, get, capabilities, listItems, getItem, getBindings, fork, switchInstance, postNotice, prepareTurn, runNative }`,
  `ctx.handoff.{ section, onCompose, onShouldOffer, onRedact, preview }`,
  `ctx.slots.register({ slot, id, title, ui, key?, order?, height?, onMessage?(payload, meta) }): Disposer`,
  `ctx.commands.register(cmd, handler): Disposer; ctx.tools.register({ name, description, inputSchema, readOnly?, handler }): Disposer`,
  `ctx.approvals.onAnnotate(listener): Disposer // risk annotations only; NEVER approve`,
  `ctx.storage.plugin.{ get, set, delete, keys }; ctx.storage.workspace.{ get, set, delete, keys }`,
  `ctx.fs.{ read, list, stat, write }; ctx.provide(name, impl); ctx.get(name); ctx.effect(fn); ctx.logger.{ debug, info, warn, error }`,
  `\`\`\``,
  ``,
  `## 3. Public Events & Host Services`,
  `- Host services: ${serviceNames.map((s) => `\`${s}\``).join(', ')}.`,
  `- Replaceable public services (with \`service:provide:<name>\`): \`ledger\`, \`handoff\`, \`git\`, \`usage\`, \`notify\`.`,
  ``,
  `| Event / Hook | Mode | Permission |`,
  `| --- | --- | --- |`,
  compactEvents,
  ``,
  `## 4. V4 + V5 UI Slots & Sandbox Bridge`,
  `| Slot | Cardinality | Scope | Description |`,
  `| --- | --- | --- | --- |`,
  ...slotRows,
  ``,
  `- Sandbox iframe CSP: \`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'\`.`,
  `- Bridge API inside HTML: \`window.harnessMate.{ session, props, onContext(cb), sendToPlugin(payload), setDraft(text), toast(title, body, level) }\`.`,
  `- Styling: use host CSS vars (\`--bg-surface\`, \`--bg-elevated\`, \`--text-primary\`, \`--text-secondary\`, \`--border-hairline\`, \`--accent-indigo\`).`,
  ``,
  `## 5. Error Codes & Permission Risk Matrix`,
  `- Error codes: ${pluginErrorCodes.map((c) => `\`${c}\``).join(', ')}.`,
  `- Static permissions (${STATIC_PLUGIN_PERMISSIONS.length}): ${STATIC_PLUGIN_PERMISSIONS.map((p) => `\`${p}\``).join(', ')}.`,
  `- Dynamic permissions: \`net:<host>\` (medium), \`service:provide:<name>\` (medium), \`process:spawn:<bin>\` (high), \`secrets:read:<ns>\` (high).`,
  `- High-risk permissions requiring explicit review: \`harness:driver:register\`, \`process:spawn:*\`, \`secrets:read:*\`, \`fs:workspace:write\`, \`workspace:git:write\`, \`process:pty:workspace\`, \`handoff:redact\`.`,
  ``,
  `## 6. Five Mandatory Security Redlines`,
  `1. **No Core Hijacking**: Never use \`core.*\`/\`broken.*\` plugin IDs, never register built-in driver IDs (\`codex\`, \`claude\`, \`agy\`, \`acp\`), and never override reserved security services (\`auth\`, \`permissions\`, \`remote\`, \`mcpHub\`, \`session-kernel\`, \`harness.*\`).`,
  `2. **No Dangerous Runtime APIs**: Never import/call \`child_process\`, \`node:child_process\`, \`worker_threads\`, \`vm\`, \`eval(\`, \`new Function\`, \`process.binding\`, or unbounded \`fs.rmSync\`. Spawn CLIs exclusively via \`ctx.runtime.spawnCli\`.`,
  `3. **No Unauthorized Approval or System Prompt Injection**: Plugins may only attach risk annotations via \`ctx.approvals.onAnnotate\`; never auto-approve user requests or attempt to alter system prompts.`,
  `4. **Minimal Network & Permission Scope**: Every external URL referenced in code MUST match a declared \`net:<host>\` permission; avoid unused high-risk permissions.`,
  `5. **Strict HTML Sandbox Hygiene**: No external \`<script src="http...">\` or \`<link href="http...">\`, no \`javascript:\` URLs, no inline event handlers (\`onclick=\`, \`onload=\`, etc.), and no \`../\` path traversal.`,
  ``,
  `## 7. Offline Testing Kit (\`@harnessmate/plugin-sdk/testing\`)`,
  `- \`createMockPluginHost(opts?)\`: mocks permissions, storage, logger, services, \`spawnCli\`, \`net.openStream\`, \`secrets.resolve\`, and captures registered drivers/slots/tools.`,
  `- \`createMockSession(opts?)\` & \`createMockCliProcess(opts?)\`: construct deterministic sessions and NDJSON CLI streams offline.`,
  `- \`replayAdapterTranscript(driverOrSession, ndjsonLines, opts?)\`: replays NDJSON frames and asserts normalized adapter events, capabilities, and failure classes.`,
  ``,
].join('\n');

const MAX_AI_BUILDER_CONTEXT_BYTES = 18 * 1024;
if (Buffer.byteLength(aiBuilderContext, 'utf8') > MAX_AI_BUILDER_CONTEXT_BYTES) {
  throw new Error(
    `ai-builder-context.md 体积超限 (${Buffer.byteLength(aiBuilderContext, 'utf8')} > ${MAX_AI_BUILDER_CONTEXT_BYTES} bytes)`,
  );
}
output.set('ai-builder-context.md', aiBuilderContext);

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
