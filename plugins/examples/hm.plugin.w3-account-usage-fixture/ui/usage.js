const result = document.querySelector('#result');

async function refresh() {
  try {
    const bridge = window.harnessMate;
    const payload = await bridge.requestPluginRoute({
      instanceId: bridge.instanceId,
      method: 'GET',
      path: '/accounts',
    });
    result.textContent = `${payload.instanceId} · ${payload.accounts.map(({ displayName }) => displayName).join('、')}`;
  } catch (error) {
    result.textContent = `读取示例额度失败 · ${error.message}`;
  }
}

document.querySelector('#refresh').addEventListener('click', () => void refresh());
void refresh();
