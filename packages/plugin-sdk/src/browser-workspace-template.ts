import { browserPreviewTemplate } from './browser-preview-template.js';

export function browserWorkspaceTemplate(title: string): Record<string, string> {
  return {
    'index.mjs': `import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

export const requires = ['ui.workspace.pages', 'runtime.trustedLocal'];

export async function apply(ctx) {
  if (!ctx.runtime.trustedLocal) {
    throw Object.assign(new Error('请从插件中心的开发页关联并信任此目录'), { code: 'E_PERMISSION_DENIED' });
  }
  const page = await readFile(new URL('./viewer.html', import.meta.url));
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(page);
  });

  ctx.effect(() => () => {
    server.close();
    server.closeAllConnections();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  ctx.slots.register({
    slot: 'workspace.pages',
    id: 'browser',
    title: ${JSON.stringify(title)},
    ui: 'ui/panel.html',
    onMessage(payload) {
      if (payload?.type === 'viewer.url') return { url };
      return { error: '未知工作页请求' };
    },
  });
  ctx.logger.info('本地查看服务已就绪');
}
`,
    'viewer.html': `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>本地浏览器查看器</title>
<style>
  body { padding: 32px; margin: 0; color: #292d3e; background: #f4f6fb; font: 17px system-ui; }
  input { box-sizing: border-box; display: block; width: min(100%, 480px); margin-top: 8px; padding: 8px; }
</style>
<h1>本地浏览器查看器</h1>
<label>输入测试文字 <input id="text" placeholder="试着输入中文"></label>
<p id="echo" aria-live="polite"></p>
<script>
  document.querySelector('input').addEventListener('input', (event) => {
    document.getElementById('echo').textContent = event.currentTarget.value;
  });
</script>
</html>
`,
    'ui/panel.html': browserPreviewTemplate['ui/panel.html'].replace(
      '<button id="open-url" type="button">打开</button>',
      '<button id="open-url" type="button">打开</button>\n    <button id="local" type="button">打开本地查看器</button>',
    ),
    'ui/panel.css': browserPreviewTemplate['ui/panel.css'] +
      '\n#preview { width: min(100%, 1000px); display: block; }\n',
    'ui/panel.js': browserPreviewTemplate['ui/panel.js'] + `
const local = document.getElementById('local');
local.disabled = !browser.available;
local.addEventListener('click', () => {
  void run(window.harnessMate.sendToPlugin({ type: 'viewer.url' }).then(async (result) => {
    if (!result?.url) throw new Error(result?.error || '本地查看器未就绪');
    await browser.open({ url: result.url, width: 1000, height: 620 });
    setOpen(true);
  }));
});
`,
    'README.md': `# 浏览器工作页

在插件中心的「开发」页选择此源码目录，点击「关联并信任」。再授权插件的 \`browser:preview\`，从侧栏打开工作页并点击「打开本地查看器」。

\`index.mjs\` 在插件进程里启动回环 HTTP 服务。\`viewer.html\` 是服务页面，\`ui/panel.*\` 是 HarnessMate 工作页。修改这些文件即可热重载。运行副本由宿主管理，工作数据请使用插件存储或单独的数据目录。

插件中心支持停用、撤销信任和回退。可信后端与当前系统用户拥有相同的系统权限。模型工具和宿主桥调用继续使用原有授权。
`,
  };
}
