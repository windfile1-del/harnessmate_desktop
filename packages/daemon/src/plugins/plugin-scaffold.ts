import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_MANIFEST_VERSION, PluginApiError } from '@harnessmate/plugin-api';
import type { ScaffoldPluginRequest } from '@harnessmate/protocol';

const VALID_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function toSlug(id: string): string {
  const parts = id.split('.');
  const raw = (parts[parts.length - 1] ?? id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return /^[a-z0-9]/.test(raw) ? raw.slice(0, 28) : `cmd-${raw.slice(0, 24)}`;
}

export function buildScaffoldFiles(req: ScaffoldPluginRequest): {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
} {
  const id = req.id.trim();
  const name = req.name.trim();
  if (!VALID_ID.test(id) || id.startsWith('core.') || id.startsWith('broken.')) {
    throw new PluginApiError('E_INVALID_INPUT', '插件 ID 格式无效或使用了保留前缀 (core./broken.)');
  }
  const description = (req.description?.trim() || `${name} — HarnessMate V4 插件`).slice(0, 320);
  const author = (req.author?.trim() || 'Local Developer').slice(0, 80);
  const slug = toSlug(id);

  if (req.template === 'ui-slot') {
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
    return {
      manifest,
      files: {
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
.title { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--text-primary, #f2f4fb); }
.muted { margin: 0 0 10px; font-size: 12px; color: var(--text-secondary, #98a1ba); }
.actions { display: flex; gap: 8px; }
button {
  cursor: pointer; padding: 5px 10px; border-radius: 8px;
  border: 1px solid var(--border-strong, rgba(255,255,255,0.14));
  background: var(--bg-surface, #121623); color: var(--text-primary, #f2f4fb); font-size: 11.5px;
}
`,
        'ui/panel.js': `const info = document.getElementById('session-info');
function render(session) {
  if (info) info.textContent = session ? '当前会话：' + session.title + ' (' + session.harnessId + ')' : '当前未选中会话';
}
render(window.harnessMate.session);
window.harnessMate.onContext((session) => render(session));
document.getElementById('draft-btn')?.addEventListener('click', () => void window.harnessMate.setDraft('请帮我审查当前改动并补充测试。'));
document.getElementById('toast-btn')?.addEventListener('click', () => void window.harnessMate.toast(${JSON.stringify(name)}, '来自沙箱 iframe 插槽的问候！', 'success'));
`,
        'README.md': `# ${name}\n\nHarnessMate V4 声明式沙箱 UI 插槽插件（\`${id}\`）。\n`,
      },
    };
  }

  if (req.template === 'service') {
    const serviceName = (req.serviceName?.trim() || `acme.${slug}`).toLowerCase();
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
    return {
      manifest,
      files: {
        'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
        'index.mjs': `export const name = ${JSON.stringify(id)};
export const provides = [${JSON.stringify(serviceName)}];

export function apply(ctx) {
  ctx.logger.info('Service plugin activated', { service: ${JSON.stringify(serviceName)}, runId: ctx.runId });
  ctx.provide(${JSON.stringify(serviceName)}, {
    ping(input = 'hello') {
      return { ok: true, service: ${JSON.stringify(serviceName)}, echo: input, timestamp: Date.now() };
    },
  });
}
`,
        'README.md': `# ${name}\n\nHarnessMate V4 第三方服务提供方插件（\`${serviceName}\`）。\n`,
      },
    };
  }

  if (req.template === 'declarative') {
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
        projections: [{ id: `${slug}_turns`, scope: 'session', events: ['turn.completed', 'turn.failed'] }],
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
    return {
      manifest,
      files: {
        'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
        'README.md': `# ${name}\n\nHarnessMate V4 纯声明式工作流与数据面板插件（\`/${slug}\`）。\n`,
      },
    };
  }

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
      commands: [{ command: slug, description: `执行 ${name} 命令`, argumentHint: '[参数]' }],
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
  return {
    manifest,
    files: {
      'harnessmate-plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'index.mjs': `export const name = ${JSON.stringify(id)};

export function apply(ctx) {
  let turnCount = 0;
  ctx.logger.info('插件已启动', { pluginId: ctx.pluginId, runId: ctx.runId });

  ctx.on('turn.completed', (event) => {
    turnCount += 1;
    ctx.logger.debug('收到轮次完成事件', { sessionId: event.sessionId, turnCount });
  });

  ctx.commands.register(${JSON.stringify(slug)}, async (input) => ({
    kind: 'message',
    text: \`[\${ctx.pluginId}] 收到命令参数：\${input.args || '(空)'}，当前已观测轮次：\${turnCount}\`,
  }));

  ctx.slots.register({
    slot: 'inspector.tabs',
    id: ${JSON.stringify(`${slug}-view`)},
    title: ${JSON.stringify(name)},
    ui: 'ui/panel.html',
    order: 200,
    async onMessage(payload, meta) {
      ctx.logger.info('收到沙箱面板消息', { payload, sessionId: meta.sessionId });
      return { ok: true, turnCount, runId: ctx.runId, echo: payload };
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
    .box { padding: 12px; border-radius: 10px; background: var(--bg-elevated, #181d2e); border: 1px solid var(--border-hairline, rgba(255,255,255,0.08)); }
    button { cursor: pointer; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border-strong, rgba(255,255,255,0.14)); background: var(--bg-surface, #121623); color: var(--text-primary, #f2f4fb); }
    pre { margin-top: 10px; padding: 8px; border-radius: 8px; background: var(--code-bg, #0b0e17); font-size: 11px; overflow: auto; }
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
      'README.md': `# ${name}\n\nHarnessMate V4 隔离级代码插件（\`${id}\`）。\n`,
    },
  };
}

export function writeScaffoldToDirectory(targetDir: string, files: Record<string, string>): string {
  const resolved = path.resolve(targetDir);
  if (fs.existsSync(resolved)) {
    const existing = fs.readdirSync(resolved);
    if (existing.length > 0) {
      throw new PluginApiError('E_CONFLICT', `目标目录非空，请指定空目录或新目录: ${resolved}`);
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true });
  }
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(resolved, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return fs.realpathSync(resolved);
}
