(function () {
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('changes');

  async function refresh(ctx) {
    const wsId = ctx && (ctx.workspaceId || (ctx.session && ctx.session.workspaceId));
    if (!wsId || !window.harnessMate || !window.harnessMate.requestPluginRoute) {
      statusEl.textContent = 'Workspace Tools Lite 已就绪（无活动工作区上下文）';
      return;
    }
    try {
      const res = await window.harnessMate.requestPluginRoute(
        '/git-status?workspaceId=' + encodeURIComponent(wsId),
      );
      const val = res && res.value ? res.value : res;
      if (!val || !val.status) {
        statusEl.textContent = '非 Git 目录或暂无状态';
        return;
      }
      statusEl.textContent =
        '分支 ' + (val.status.branch || 'HEAD') + ' · 变更 ' + (val.status.totalChanged || 0) + ' 项';
      listEl.replaceChildren();
      for (const ch of val.status.changes || []) {
        const li = document.createElement('li');
        li.textContent = ch.path;
        listEl.appendChild(li);
      }
    } catch (err) {
      statusEl.textContent = '读取失败: ' + (err && err.message ? err.message : String(err));
    }
  }

  if (window.harnessMate && window.harnessMate.onContext) {
    window.harnessMate.onContext(refresh);
  }
})();
