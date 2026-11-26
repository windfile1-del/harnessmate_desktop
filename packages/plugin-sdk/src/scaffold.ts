import { PLUGIN_MANIFEST_VERSION, PluginApiError } from '@harnessmate/plugin-api';

import { browserPreviewTemplate } from './browser-preview-template.js';
import { browserWorkspaceTemplate } from './browser-workspace-template.js';

export type PluginScaffoldTemplate =
  | 'isolated'
  | 'ui-slot'
  | 'service'
  | 'declarative'
  | 'browser-preview'
  | 'browser-workspace'
  | 'harness-adapter';

export interface PluginScaffoldOptions {
  id: string;
  name: string;
  description?: string;
  author?: string;
  template: PluginScaffoldTemplate;
  serviceName?: string;
  driverId?: string;
  binaryName?: string;
}

export interface PluginScaffoldOutput {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
}

const VALID_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function toSlug(id: string): string {
  const parts = id.split('.');
  const raw = (parts[parts.length - 1] ?? id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return /^[a-z0-9]/.test(raw) ? raw.slice(0, 28) : `cmd-${raw.slice(0, 24)}`;
}

export function scaffoldPluginFiles(options: PluginScaffoldOptions): PluginScaffoldOutput {
  const id = options.id.trim();
  const name = options.name.trim();
  if (!VALID_ID.test(id) || id.startsWith('core.') || id.startsWith('broken.')) {
    throw new PluginApiError('E_INVALID_INPUT', '插件 ID 格式无效或使用了保留前缀 (core./broken.)');
  }
  if (!name || name.length > 80) {
    throw new PluginApiError('E_INVALID_INPUT', '插件名称需为 1-80 个字符');
  }

  const description = (options.description?.trim() || `${name} — HarnessMate V4 插件`).slice(0, 320);
  const author = (options.author?.trim() || 'Local Developer').slice(0, 80);
  const slug = toSlug(id);

  if (options.template === 'harness-adapter') {
    const rawDriverId = (options.driverId?.trim() || slug).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (rawDriverId === 'codex' || rawDriverId === 'claude' || rawDriverId === 'agy' || rawDriverId === 'acp') {
      throw new PluginApiError('E_INVALID_INPUT', `禁止使用内置保留驱动 ID: ${rawDriverId}`);
    }
    const driverId = /^[a-z0-9]/.test(rawDriverId) ? rawDriverId.slice(0, 32) : `driver-${rawDriverId.slice(0, 24)}`;
    const binaryName = (options.binaryName?.trim() || `${driverId}-cli`).replace(/[^a-z0-9._-]/gi, '-').slice(0, 48);
    const extBlockType = `ext:${driverId}.status_card`;
    const manifest: Record<string, unknown> = {
      id,
      name,
      version: '0.1.0',
      description,
      author,
      category: 'harness',
      apiVersion: PLUGIN_MANIFEST_VERSION,
      engines: { pluginApi: '^4.0.0' },
      main: 'index.mjs',
      permissions: [
        'harness:driver:register',
        `process:spawn:${binaryName}`,
        'storage:plugin',
      ],
      contributes: {
        slots: [
          {
            slot: 'chat.block',
            id: `${driverId}-status-card`,
            title: `${name} 状态卡`,
            ui: 'ui/block-card.html',
            key: extBlockType,
            order: 100,
            height: 150,
          },
          {
            slot: 'harness.settings',
            id: `${driverId}-settings`,
            title: `${name} 设置`,
            ui: 'ui/settings.html',
            key: driverId,
            order: 100,
            height: 280,
          },
        ],
      },
    };

    const files: Record<string, string> = {
      'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'index.mjs': `export const name = ${JSON.stringify(id)};
export const DRIVER_ID = ${JSON.stringify(driverId)};
export const DEFAULT_BINARY = ${JSON.stringify(binaryName)};
export const EXT_BLOCK_TYPE = ${JSON.stringify(extBlockType)};

export const DRIVER_CAPABILITIES = {
  streaming: true,
  interactiveApproval: false,
  reasoningEfforts: ['medium', 'high'],
  permissionModes: ['manual', 'accept_edits'],
  sessionResume: false,
  sessionFork: false,
  imageInput: false,
  subagents: false,
};

export const DRIVER_CAPABILITIES_V2 = {
  ...DRIVER_CAPABILITIES,
  transport: 'stream_json',
  historyInjectionMode: 'inline',
  supportsNativeRollback: false,
  supportsActiveSteering: false,
  supportsUsageLimits: false,
  supportsDynamicOptions: true,
  nativeCommands: [],
  optionDescriptors: [
    {
      key: 'verboseTrace',
      label: '详细跟踪输出',
      description: '在状态卡中展示执行步骤耗时',
      kind: 'boolean',
      defaultValue: false,
    },
    {
      key: 'maxSteps',
      label: '最大推理步数',
      kind: 'number',
      min: 1,
      max: 64,
      step: 1,
      defaultValue: 8,
    },
  ],
};

export const DRIVER_PRESENTATION = {
  shortLabel: ${JSON.stringify(name.slice(0, 14))},
  accentColor: '#10b981',
  softBg: 'rgba(16, 185, 129, 0.12)',
  tagline: ${JSON.stringify(`${name} · V5 Isolated Driver`)},
};

export function parseNdjsonLine(line, turnId) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return { type: 'message.assistant.delta', turnId, text: trimmed };
  }
  if (!frame || typeof frame !== 'object') return null;
  switch (frame.type) {
    case 'delta':
      return { type: 'message.assistant.delta', turnId, text: String(frame.text ?? '') };
    case 'thinking':
      return { type: 'thinking.delta', turnId, text: String(frame.text ?? '') };
    case 'status_card':
      return {
        type: 'turn_block.ext',
        turnId,
        itemId: \`\${turnId}:\${DRIVER_ID}:status\`,
        blockType: EXT_BLOCK_TYPE,
        title: String(frame.title ?? ${JSON.stringify(`${name} 执行状态`)}),
        fallbackSummary: String(frame.summary ?? ''),
        status: frame.status === 'failed' ? 'failed' : 'completed',
        payload: {
          driverId: DRIVER_ID,
          summary: String(frame.summary ?? ''),
          steps: Number(frame.steps ?? 0),
        },
      };
    case 'usage':
      return {
        type: 'usage.updated',
        turnId,
        usage: {
          inputTokens: Number(frame.inputTokens ?? 0),
          outputTokens: Number(frame.outputTokens ?? 0),
          ...(frame.modelContextWindow ? { modelContextWindow: Number(frame.modelContextWindow) } : {}),
        },
      };
    case 'error':
      return {
        type: 'turn.failed',
        turnId,
        message: String(frame.message ?? 'Driver execution error'),
        code: typeof frame.code === 'string' ? frame.code : undefined,
        failureClass: typeof frame.failureClass === 'string' ? frame.failureClass : 'provider_error',
      };
    case 'done':
      return [
        ...(typeof frame.text === 'string' ? [{ type: 'message.assistant.completed', turnId, text: frame.text }] : []),
        { type: 'turn.completed', turnId, stopReason: String(frame.stopReason ?? 'end_turn') },
      ];
    default:
      return null;
  }
}

export function apply(ctx) {
  let settings = { defaultModel: \`\${DRIVER_ID}-default\`, extraArgs: [] };
  const activeProcesses = new Set();

  void ctx.storage.plugin.get('settings').then((saved) => {
    if (saved && typeof saved === 'object') settings = { ...settings, ...saved };
  }).catch(() => {});

  const probeInfo = () => ({
    binaryPath: DEFAULT_BINARY,
    version: '0.1.0',
    health: 'ready',
    models: [
      { id: \`\${DRIVER_ID}-default\`, displayName: ${JSON.stringify(`${name} Default`)}, isDefault: true },
    ],
    defaultModelId: settings.defaultModel || \`\${DRIVER_ID}-default\`,
    capabilitiesV2: DRIVER_CAPABILITIES_V2,
    presentation: DRIVER_PRESENTATION,
  });

  ctx.harnesses.registerDriver({
    driverId: DRIVER_ID,
    displayName: ${JSON.stringify(name)},
    description: ${JSON.stringify(description)},
    protocolLabel: 'ndjson-stdio',
    capabilities: DRIVER_CAPABILITIES,
    capabilitiesV2: DRIVER_CAPABILITIES_V2,
    presentation: DRIVER_PRESENTATION,
    probePassive: () => probeInfo(),
    probe: async () => probeInfo(),
    async createSession(config) {
      const listeners = new Set();
      let currentProc = null;
      const emit = (ev) => {
        for (const fn of [...listeners]) fn(ev);
      };

      return {
        nativeSessionId: config.nativeSessionId ?? \`\${DRIVER_ID}_\${Date.now().toString(36)}\`,
        async sendTurn(input) {
          emit({ type: 'turn.started', turnId: input.turnId });
          const proc = await ctx.runtime.spawnCli({
            command: DEFAULT_BINARY,
            args: ['--json-stdio', ...(Array.isArray(settings.extraArgs) ? settings.extraArgs : [])],
            cwd: config.cwd,
          });
          currentProc = proc;
          activeProcesses.add(proc);

          let buffer = '';
          let terminalEmitted = false;
          let fullText = '';

          const dispatchLine = (line) => {
            const parsed = parseNdjsonLine(line, input.turnId);
            const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
            for (const ev of items) {
              if (ev.type === 'message.assistant.delta') fullText += ev.text;
              if (ev.type === 'turn.completed' || ev.type === 'turn.failed' || ev.type === 'turn.cancelled') {
                terminalEmitted = true;
              }
              emit(ev);
            }
          };

          proc.onStdout((chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\\r?\\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) dispatchLine(line);
          });

          proc.onExit(({ code }) => {
            activeProcesses.delete(proc);
            if (currentProc === proc) currentProc = null;
            if (buffer.trim()) dispatchLine(buffer);
            if (!terminalEmitted) {
              if (code === 0 || code === null) {
                if (fullText) emit({ type: 'message.assistant.completed', turnId: input.turnId, text: fullText });
                emit({ type: 'turn.completed', turnId: input.turnId });
              } else {
                emit({
                  type: 'turn.failed',
                  turnId: input.turnId,
                  message: \`CLI exited with code \${code}\`,
                  failureClass: 'process_exit',
                });
              }
            }
          });

          await proc.writeStdin(JSON.stringify({
            turnId: input.turnId,
            text: input.text,
            model: input.model ?? settings.defaultModel,
            turnOptions: input.turnOptions ?? {},
          }) + '\\n');
          await proc.closeStdin();
        },
        async interrupt() {
          if (currentProc) await currentProc.kill('SIGTERM').catch(() => {});
        },
        async resolveApproval() {},
        async dispose() {
          if (currentProc) {
            await currentProc.kill('SIGTERM').catch(() => {});
            activeProcesses.delete(currentProc);
            currentProc = null;
          }
          listeners.clear();
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  });

  ctx.slots.register({
    slot: 'harness.settings',
    id: \`\${DRIVER_ID}-settings\`,
    title: ${JSON.stringify(`${name} 设置`)},
    ui: 'ui/settings.html',
    key: DRIVER_ID,
    order: 100,
    async onMessage(payload) {
      if (payload && typeof payload === 'object' && payload.action === 'save') {
        settings = {
          defaultModel: String(payload.defaultModel || \`\${DRIVER_ID}-default\`),
          extraArgs: Array.isArray(payload.extraArgs) ? payload.extraArgs.map(String) : [],
        };
        await ctx.storage.plugin.set('settings', settings);
        return { ok: true, settings };
      }
      return { ok: true, settings };
    },
  });

  ctx.slots.register({
    slot: 'chat.block',
    id: \`\${DRIVER_ID}-status-card\`,
    title: ${JSON.stringify(`${name} 状态卡`)},
    ui: 'ui/block-card.html',
    key: EXT_BLOCK_TYPE,
    order: 100,
  });

  ctx.effect(() => () => {
    for (const proc of [...activeProcesses]) {
      void proc.kill('SIGTERM').catch(() => {});
    }
    activeProcesses.clear();
  });
}
`,
      'ui/settings.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${name} 设置</title>
  <style>
    body { margin: 0; padding: 12px; font-family: system-ui, sans-serif; color: var(--text-primary, #f2f4fb); background: transparent; }
    .panel { padding: 12px; border-radius: 10px; background: var(--bg-elevated, #181d2e); border: 1px solid var(--border-hairline, rgba(255,255,255,0.08)); }
    label { display: block; font-size: 11.5px; color: var(--text-secondary, #98a1ba); margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--border-strong, rgba(255,255,255,0.14)); background: var(--bg-surface, #121623); color: var(--text-primary, #f2f4fb); font-size: 12px; }
    .row { margin-top: 10px; display: flex; align-items: center; gap: 8px; }
    button { cursor: pointer; padding: 6px 12px; border-radius: 8px; border: none; background: var(--accent-indigo, #6366f1); color: #fff; font-size: 12px; }
    .status { font-size: 11px; color: var(--text-secondary, #98a1ba); }
  </style>
</head>
<body>
  <section class="panel">
    <label for="model-input">默认模型 ID</label>
    <input id="model-input" type="text" placeholder="${driverId}-default" />
    <div class="row">
      <button id="save-btn" type="button">保存配置</button>
      <span id="status" class="status"></span>
    </div>
  </section>
  <script>
    const input = document.getElementById('model-input');
    const statusEl = document.getElementById('status');
    async function load() {
      try {
        const res = await window.harnessMate.sendToPlugin({ action: 'load' });
        if (res && res.settings && input) input.value = res.settings.defaultModel || '';
      } catch (err) {
        if (statusEl) statusEl.textContent = '加载失败';
      }
    }
    document.getElementById('save-btn').addEventListener('click', async () => {
      try {
        await window.harnessMate.sendToPlugin({ action: 'save', defaultModel: input.value.trim() });
        if (statusEl) statusEl.textContent = '已保存';
      } catch (err) {
        if (statusEl) statusEl.textContent = '保存失败';
      }
    });
    void load();
  </script>
</body>
</html>
`,
      'ui/block-card.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${name} 状态卡</title>
  <style>
    body { margin: 0; padding: 8px; font-family: system-ui, sans-serif; color: var(--text-primary, #f2f4fb); background: transparent; }
    .card { padding: 10px 12px; border-radius: 10px; background: var(--bg-elevated, #181d2e); border: 1px solid var(--border-hairline, rgba(255,255,255,0.08)); }
    .head { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
    .body { font-size: 11.5px; color: var(--text-secondary, #98a1ba); }
  </style>
</head>
<body>
  <div class="card">
    <div id="title" class="head">${name}</div>
    <div id="summary" class="body">等待执行状态…</div>
  </div>
  <script>
    const titleEl = document.getElementById('title');
    const summaryEl = document.getElementById('summary');
    function render(props) {
      const payload = (props && props.block && props.block.payload) || {};
      if (titleEl && props && props.block && props.block.title) titleEl.textContent = props.block.title;
      if (summaryEl) summaryEl.textContent = payload.summary || '已完成';
    }
    render(window.harnessMate.props);
    window.harnessMate.onContext((_session, props) => render(props));
  </script>
</body>
</html>
`,
      'tests/adapter-replay.test.mjs': `import { createMockCliProcess, createMockPluginHost, replayAdapterTranscript } from '@harnessmate/plugin-sdk/testing';
import * as plugin from '../index.mjs';

const transcript = [
  JSON.stringify({ type: 'thinking', text: 'Planning response...' }),
  JSON.stringify({ type: 'delta', text: 'Hello from ' }),
  JSON.stringify({ type: 'delta', text: '${driverId}!' }),
  JSON.stringify({ type: 'status_card', title: '${name} 状态', summary: '执行完成', steps: 2 }),
  JSON.stringify({ type: 'done', text: 'Hello from ${driverId}!' }),
];

export async function runReplayTest() {
  const host = createMockPluginHost({
    pluginId: ${JSON.stringify(id)},
    permissions: ['harness:driver:register', ${JSON.stringify(`process:spawn:${binaryName}`)}, 'storage:plugin'],
    spawnCliHandler: () => createMockCliProcess({ stdoutLines: transcript, autoEmitOnStdin: true }),
  });
  await host.activate(plugin);
  const driver = host.drivers.get(plugin.DRIVER_ID);
  if (!driver) throw new Error('Driver was not registered');

  const result = await replayAdapterTranscript(driver, transcript);
  result.assert({
    terminalType: 'turn.completed',
    assistantTextContains: 'Hello from ${driverId}!',
    thinkingTextContains: 'Planning',
    extBlockTypes: [plugin.EXT_BLOCK_TYPE],
    supportsNativeRollback: false,
  });
  host.dispose();
  return result;
}
`,
      'README.md': `# ${name}\n\nHarnessMate V5 隔离进程 Harness Adapter 插件（驱动 ID: \`${driverId}\`，CLI: \`${binaryName}\`）。\n\n- 驱动入口：\`index.mjs\`（通过 \`ctx.harnesses.registerDriver\` 与 \`ctx.runtime.spawnCli\` 运行）\n- 沙箱 UI 插槽：\`ui/settings.html\`（\`harness.settings\`）与 \`ui/block-card.html\`（\`chat.block\`）\n- 离线回放测试：\`tests/adapter-replay.test.mjs\`（基于 \`@harnessmate/plugin-sdk/testing\`）\n`,
    };
    return { manifest, files };
  }

  if (options.template === 'browser-workspace') {
    const manifest = {
      id, name, description, author, version: '0.1.0', category: 'ui',
      apiVersion: PLUGIN_MANIFEST_VERSION, engines: { pluginApi: '^4.0' },
      main: 'index.mjs',
      permissions: ['browser:preview'],
      contributes: { slots: [{ slot: 'workspace.pages', id: 'browser', title: name, ui: 'ui/panel.html' }] },
    };
    return {
      manifest,
      files: {
        'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
        ...browserWorkspaceTemplate(name),
      },
    };
  }

  if (options.template === 'browser-preview') {
    const manifest = {
      id, name, description, author, version: '0.1.0', category: 'ui',
      apiVersion: PLUGIN_MANIFEST_VERSION, engines: { pluginApi: '^4.0' },
      permissions: ['browser:preview'],
      contributes: { slots: [{
        slot: 'inspector.tabs', id: 'browser', title: name, ui: 'ui/panel.html', order: 200, height: 430,
      }] },
    };
    return {
      manifest,
      files: {
        'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
        ...browserPreviewTemplate,
      },
    };
  }

  if (options.template === 'ui-slot') {
    const manifest: Record<string, unknown> = {
      id,
      name,
      version: '0.1.0',
      description,
      author,
      category: 'ui',
      apiVersion: PLUGIN_MANIFEST_VERSION,
      engines: { pluginApi: '^4.0' },
      contributes: {
        slots: [
          {
            slot: 'inspector.tabs',
            id: `${slug}-panel`,
            title: name,
            ui: 'ui/panel.html',
            order: 200,
            height: 240,
          },
        ],
      },
    };
    const files: Record<string, string> = {
      'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'ui/panel.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${name}</title>
  <link rel="stylesheet" href="./panel.css" />
</head>
<body>
  <main class="card">
    <h1 class="title">${name}</h1>
    <p class="muted" id="session-info">等待会话上下文…</p>
    <div class="actions">
      <button id="draft-btn" type="button">填入快捷提示</button>
      <button id="toast-btn" type="button">发送通知</button>
    </div>
  </main>
  <script src="./panel.js"></script>
</body>
</html>
`,
      'ui/panel.css': `.card {
  padding: 12px;
  border-radius: 10px;
  background: var(--bg-elevated, #181d2e);
  border: 1px solid var(--border-hairline, rgba(255,255,255,0.08));
}
.title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f2f4fb);
}
.muted {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-secondary, #98a1ba);
}
.actions {
  display: flex;
  gap: 8px;
}
button {
  cursor: pointer;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.14));
  background: var(--bg-surface, #121623);
  color: var(--text-primary, #f2f4fb);
  font-size: 11.5px;
}
button:hover {
  background: var(--bg-hover, rgba(255,255,255,0.06));
}
`,
      'ui/panel.js': `const info = document.getElementById('session-info');
function renderContext(session) {
  if (!info) return;
  info.textContent = session
    ? '当前会话：' + session.title + ' (' + session.harnessId + ')'
    : '当前未选中会话';
}
renderContext(window.harnessMate.session);
window.harnessMate.onContext((session) => renderContext(session));

document.getElementById('draft-btn')?.addEventListener('click', () => {
  void window.harnessMate.setDraft('请帮我审查当前改动并补充测试。');
});
document.getElementById('toast-btn')?.addEventListener('click', () => {
  void window.harnessMate.toast('${name}', '来自沙箱 iframe 插槽的问候！', 'success');
});
`,
      'README.md': `# ${name}\n\nHarnessMate V4 声明式沙箱 UI 插槽插件（\`${id}\`）。\n\n在插件中心以开发模式挂载本目录，保存 \`ui/*\` 后立即生效。\n`,
    };
    return { manifest, files };
  }

  if (options.template === 'service') {
    const serviceName = (options.serviceName?.trim() || `acme.${slug}`).toLowerCase();
    const manifest: Record<string, unknown> = {
      id,
      name,
      version: '0.1.0',
      description,
      author,
      category: 'tool',
      apiVersion: PLUGIN_MANIFEST_VERSION,
      engines: { pluginApi: '^4.0' },
      main: 'index.mjs',
      provides: [serviceName],
      permissions: ['events:turn'],
    };
    const files: Record<string, string> = {
      'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'index.mjs': `export const name = ${JSON.stringify(id)};
export const provides = [${JSON.stringify(serviceName)}];

export function apply(ctx) {
  ctx.logger.info('Service plugin activated', { service: ${JSON.stringify(serviceName)}, runId: ctx.runId });

  ctx.provide(${JSON.stringify(serviceName)}, {
    ping(input = 'hello') {
      return {
        ok: true,
        service: ${JSON.stringify(serviceName)},
        echo: input,
        timestamp: Date.now(),
      };
    },
  });
}
`,
      'README.md': `# ${name}\n\nHarnessMate V4 第三方服务提供方插件（提供服务 \`${serviceName}\`）。\n`,
    };
    return { manifest, files };
  }

  if (options.template === 'declarative') {
    const manifest: Record<string, unknown> = {
      id,
      name,
      version: '0.1.0',
      description,
      author,
      category: 'workflow',
      apiVersion: PLUGIN_MANIFEST_VERSION,
      engines: { pluginApi: '^4.0' },
      contributes: {
        slashCommands: [
          {
            command: slug,
            description: `运行 ${name} 工作流模板`,
            argumentHint: '[任务说明]',
            template: '请按以下清单分析当前工作区并给出分步计划：\n\n{{args}}',
          },
        ],
        projections: [
          {
            id: `${slug}_turns`,
            scope: 'session',
            events: ['turn.completed', 'turn.failed'],
          },
        ],
        dataPanels: [
          {
            id: `${slug}_panel`,
            title: `${name} 记录`,
            projection: `${slug}_turns`,
            placements: ['sidebar_tool'],
            filters: ['harness', 'status'],
            counts: true,
            columns: [
              { field: 'time', label: '时间' },
              { field: 'harness', label: '引擎' },
              { field: 'status', label: '状态' },
            ],
          },
        ],
      },
    };
    const files: Record<string, string> = {
      'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'README.md': `# ${name}\n\nHarnessMate V4 纯声明式工作流与数据面板插件（\`/${slug}\`）。\n`,
    };
    return { manifest, files };
  }

  // Default: 'isolated' full V4 code + UI slot plugin
  const manifest: Record<string, unknown> = {
    id,
    name,
    version: '0.1.0',
    description,
    author,
    category: 'workflow',
    apiVersion: PLUGIN_MANIFEST_VERSION,
    engines: { pluginApi: '^4.0' },
    main: 'index.mjs',
    permissions: ['events:turn', 'session:read', 'storage:plugin'],
    contributes: {
      commands: [
        {
          command: slug,
          description: `执行 ${name} 命令`,
          argumentHint: '[参数]',
        },
      ],
      slots: [
        {
          slot: 'inspector.tabs',
          id: `${slug}-view`,
          title: name,
          ui: 'ui/panel.html',
          order: 200,
          height: 220,
        },
      ],
    },
  };

  const files: Record<string, string> = {
    'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
    'index.mjs': `export const name = ${JSON.stringify(id)};

export function apply(ctx) {
  let turnCount = 0;
  ctx.logger.info('插件已启动', { pluginId: ctx.pluginId, runId: ctx.runId });

  ctx.on('turn.completed', (event) => {
    turnCount += 1;
    ctx.logger.debug('收到轮次完成事件', { sessionId: event.sessionId, turnCount });
  });

  ctx.commands.register(${JSON.stringify(slug)}, async (input) => {
    return {
      kind: 'message',
      text: \`[\${ctx.pluginId}] 收到命令参数：\${input.args || '(空)'}，当前已观测轮次：\${turnCount}\`,
    };
  });

  ctx.slots.register({
    slot: 'inspector.tabs',
    id: ${JSON.stringify(`${slug}-view`)},
    title: ${JSON.stringify(name)},
    ui: 'ui/panel.html',
    order: 200,
    async onMessage(payload, meta) {
      ctx.logger.info('收到沙箱面板消息', { payload, sessionId: meta.sessionId });
      return {
        ok: true,
        turnCount,
        runId: ctx.runId,
        echo: payload,
      };
    },
  });
}
`,
    'ui/panel.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${name}</title>
  <style>
    body { padding: 10px; }
    .box {
      padding: 12px;
      border-radius: 10px;
      background: var(--bg-elevated, #181d2e);
      border: 1px solid var(--border-hairline, rgba(255,255,255,0.08));
    }
    button {
      cursor: pointer;
      padding: 5px 10px;
      border-radius: 8px;
      border: 1px solid var(--border-strong, rgba(255,255,255,0.14));
      background: var(--bg-surface, #121623);
      color: var(--text-primary, #f2f4fb);
    }
    pre {
      margin-top: 10px;
      padding: 8px;
      border-radius: 8px;
      background: var(--code-bg, #0b0e17);
      font-size: 11px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="box">
    <div style="font-weight:600;margin-bottom:8px;">${name}</div>
    <button id="ping" type="button">向隔离插件发送消息</button>
    <pre id="out">点击按钮测试 postMessage → Daemon → 隔离进程 RPC 链路</pre>
  </div>
  <script>
    const out = document.getElementById('out');
    document.getElementById('ping').addEventListener('click', async () => {
      out.textContent = '发送中…';
      try {
        const res = await window.harnessMate.sendToPlugin({ ping: Date.now() });
        out.textContent = JSON.stringify(res, null, 2);
      } catch (err) {
        out.textContent = '失败: ' + (err && err.message ? err.message : String(err));
      }
    });
  </script>
</body>
</html>
`,
    'README.md': `# ${name}\n\nHarnessMate V4 隔离级代码插件（\`${id}\`）。\n\n- 代码入口：\`index.mjs\`（在独立 Node 权限沙箱子进程中运行）\n- 界面插槽：\`ui/panel.html\`（在 \`sandbox="allow-scripts"\` 沙箱 iframe 中渲染）\n`,
  };

  return { manifest, files };
}
