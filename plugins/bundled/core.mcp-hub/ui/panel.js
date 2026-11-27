const bridge = window.harnessMate;
const view = document.querySelector('#view');
let servers = [];
let presets = [];
let harnesses = [];
let filter = 'all';
let busy = false;

function node(tag, text, parent) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

function button(label, callback, parent) {
  const element = node('button', label, parent);
  element.type = 'button';
  element.onclick = () => run(callback);
  return element;
}

const route = (path, method = 'GET', body) => bridge.call('plugin.route', { path, method, body });
view.replaceChildren();
const toolbar = node('div', undefined, view);
toolbar.className = 'row spread';
const filterLabel = node('label', 'CLI', toolbar);
const filterControl = node('select', undefined, filterLabel);
filterControl.onchange = () => { filter = filterControl.value; renderServers(); };
button('刷新', load, toolbar);
const status = node('p', '', view);
status.className = 'error';
status.setAttribute('role', 'status');
const list = node('div', undefined, view);
const form = node('section', undefined, view);

async function run(operation) {
  if (busy) return;
  busy = true;
  view.querySelectorAll('button').forEach((element) => { element.disabled = true; });
  status.textContent = '';
  try {
    await operation();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
    view.querySelectorAll('button').forEach((element) => { element.disabled = false; });
  }
}

async function load() {
  ({ servers, presets } = await route('/servers'));
  renderServers();
}

function renderServers() {
  list.replaceChildren();
  const visible = servers.filter((server) => filter === 'all' || server.harnessId === filter);
  if (!visible.length) node('p', '当前筛选下暂无 MCP 服务器。', list);
  for (const server of visible) {
    const card = node('section', undefined, list);
    node('h3', server.name, card);
    node('p', `${server.harnessId} · ${server.transport} · ${server.status}`, card);
    node('pre', server.command ? [server.command, ...(server.args ?? [])].join(' ') : server.url, card);
    if (server.toolCount !== undefined) node('small', `${server.toolCount} 个工具`, card);
    if (server.error) node('p', server.error, card).className = 'error';
    const actions = node('div', undefined, card);
    actions.className = 'row';
    button(server.status === 'disabled' ? '启用' : '停用', async () => {
      const { result } = await route('/toggle', 'PATCH', {
        harnessId: server.harnessId, name: server.name, enabled: server.status === 'disabled',
      });
      if (!result.ok) throw new Error(result.message);
      await load();
    }, actions);
    button('移除', () => {
      const review = node('div', undefined, card);
      node('p', `从 ${server.harnessId} 移除 ${server.name}？`, review);
      button('确认移除', async () => {
        const { result } = await route('/remove', 'POST', { harnessId: server.harnessId, name: server.name });
        if (!result.ok) throw new Error(result.message);
        await load();
      }, review);
      button('取消', () => review.remove(), review);
    }, actions);
  }
}

function renderForm() {
  form.replaceChildren();
  node('h3', '添加 / 同步 MCP', form);
  function input(text, value = '') {
    const label = node('label', text, form);
    const field = node('input', undefined, label);
    field.type = 'text';
    field.value = value;
    return field;
  }
  const presetLabel = node('label', '预设', form);
  const presetControl = node('select', undefined, presetLabel);
  node('option', '自定义', presetControl).value = '';
  presets.forEach((preset, index) => { node('option', preset.name, presetControl).value = String(index); });
  const name = input('名称');
  const transportLabel = node('label', '传输', form);
  const transport = node('select', undefined, transportLabel);
  for (const value of ['stdio', 'http', 'sse']) node('option', value, transport).value = value;
  const command = input('命令', 'npx');
  const args = input('参数（空格分隔）');
  const url = input('服务器 URL');
  function updateTransport() {
    command.parentElement.hidden = args.parentElement.hidden = transport.value !== 'stdio';
    url.parentElement.hidden = transport.value === 'stdio';
  }
  transport.onchange = updateTransport;
  presetControl.onchange = () => {
    const preset = presets[Number(presetControl.value)];
    if (!preset || presetControl.value === '') return;
    name.value = preset.id ?? preset.name;
    transport.value = preset.transport;
    command.value = preset.command ?? '';
    args.value = (preset.args ?? []).join(' ');
    url.value = preset.url ?? '';
    updateTransport();
  };
  updateTransport();
  const targets = node('div', undefined, form);
  node('p', '同步写入目标 CLI', targets);
  const checks = [];
  const ids = [...new Set(['codex', 'agy', 'claude', ...harnesses.filter((h) => ['codex', 'agy', 'claude'].includes(h.kind)).map((h) => h.id)])];
  for (const id of ids) {
    const label = node('label', harnesses.find((h) => h.id === id)?.displayName ?? id, targets);
    const check = node('input', undefined, label);
    check.type = 'checkbox';
    check.checked = id === 'agy';
    checks.push({ id, check });
  }
  const review = node('div', undefined, form);
  button('检查并安装', () => {
    review.replaceChildren();
    const payload = {
      name: name.value.trim(), transport: transport.value,
      command: transport.value === 'stdio' ? command.value.trim() : undefined,
      args: transport.value === 'stdio' ? args.value.trim().split(/\s+/).filter(Boolean) : [],
      url: transport.value === 'stdio' ? undefined : url.value.trim(),
      targetHarnesses: checks.filter(({ check }) => check.checked).map(({ id }) => id),
    };
    if (!payload.name || !payload.targetHarnesses.length) throw new Error('请填写名称并选择目标 CLI');
    node('p', `允许 ${payload.targetHarnesses.join('、')} 使用以下 MCP 配置？`, review);
    node('pre', JSON.stringify(payload, null, 2), review);
    button('确认安装', async () => {
      const { results } = await route('/servers', 'POST', payload);
      const failed = results.filter((result) => !result.ok);
      const errors = results.map((result) => `${result.harnessId} · ${result.ok ? '成功' : result.message}`).join('\n');
      review.replaceChildren();
      node('pre', errors, review);
      checks.forEach(({ id, check }) => { check.checked = failed.some((result) => result.harnessId === id); });
      await load();
    }, review);
    button('取消', () => review.replaceChildren(), review);
  }, form);
}

new ResizeObserver(() => bridge.resize(view.offsetHeight)).observe(view);
run(async () => {
  ({ harnesses } = await bridge.call('plugins.list'));
  node('option', '全部 CLI', filterControl).value = 'all';
  harnesses.forEach((harness) => { node('option', harness.displayName, filterControl).value = harness.id; });
  await load();
  renderForm();
});
