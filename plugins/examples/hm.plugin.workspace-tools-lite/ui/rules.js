(function () {
  const statusEl = document.getElementById('status');
  const rulesEl = document.getElementById('rules');

  async function refresh(ctx) {
    const wsId = ctx && (ctx.workspaceId || (ctx.session && ctx.session.workspaceId));
    const sessionId = ctx && (ctx.sessionId || (ctx.session && ctx.session.id));
    if (!wsId || !window.harnessMate || !window.harnessMate.requestPluginRoute) {
      statusEl.textContent = 'Lite 规则发现面板已挂载';
      return;
    }
    try {
      const res = await window.harnessMate.requestPluginRoute(
        '/rules?workspaceId=' + encodeURIComponent(wsId),
      );
      const val = res && res.value ? res.value : res;
      const list = (val && val.instructions) || [];
      statusEl.textContent = list.length ? '发现 ' + list.length + ' 项规则/Skill' : '未发现规则文件';
      rulesEl.replaceChildren();
      for (const item of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.relativePath + ' [' + item.kind + ']';
        btn.addEventListener('click', function () {
          if (window.harnessMate && window.harnessMate.navigateToFile) {
            void window.harnessMate.navigateToFile({
              workspaceId: wsId,
              sessionId: sessionId || undefined,
              path: item.relativePath,
              line: 1,
              openInspector: true,
              preserveSession: true,
            });
          }
        });
        rulesEl.appendChild(btn);
      }
    } catch (err) {
      statusEl.textContent = '扫描失败: ' + (err && err.message ? err.message : String(err));
    }
  }

  if (window.harnessMate && window.harnessMate.onContext) {
    window.harnessMate.onContext(refresh);
  }
})();
