(function () {
  const statusEl = document.getElementById('status');
  if (!window.harnessMate || !window.harnessMate.requestPluginRoute) return;
  window.harnessMate.requestPluginRoute('/status').then(
    function (res) {
      statusEl.textContent = 'Terminal Lite 活动终端数: ' + ((res && res.count) || 0);
    },
    function () {
      statusEl.textContent = 'Terminal Lite 已就绪';
    },
  );
})();
