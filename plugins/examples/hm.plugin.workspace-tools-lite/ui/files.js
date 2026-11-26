(function () {
  const summaryEl = document.getElementById('summary');
  const containerEl = document.getElementById('files');

  async function refresh(ctx) {
    const wsId = ctx && (ctx.workspaceId || (ctx.session && ctx.session.workspaceId));
    const sessionId = ctx && (ctx.sessionId || (ctx.session && ctx.session.id));
    if (!wsId || !window.harnessMate || !window.harnessMate.requestPluginRoute) {
      summaryEl.textContent = 'Lite 文件面板已挂载';
      return;
    }
    try {
      const res = await window.harnessMate.requestPluginRoute(
        '/files?workspaceId=' + encodeURIComponent(wsId),
      );
      const val = res && res.value ? res.value : res;
      const files = (val && val.files) || [];
      summaryEl.textContent = '共发现 ' + files.length + ' 个工作区文件';
      containerEl.replaceChildren();
      for (const file of files.slice(0, 30)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = file.relativePath;
        btn.addEventListener('click', function () {
          if (window.harnessMate && window.harnessMate.navigateToFile) {
            void window.harnessMate.navigateToFile({
              workspaceId: wsId,
              sessionId: sessionId || undefined,
              path: file.relativePath,
              line: 1,
              openInspector: true,
              preserveSession: true,
            });
          }
        });
        containerEl.appendChild(btn);
      }
    } catch (err) {
      summaryEl.textContent = '加载失败: ' + (err && err.message ? err.message : String(err));
    }
  }

  if (window.harnessMate && window.harnessMate.onContext) {
    window.harnessMate.onContext(refresh);
  }
})();
