const bridge = window.harnessMate;
const view = document.querySelector('#view');
const action = (name, params) => bridge.call('surface.action', { action: name, ...params });
let current;
let dirty = false;
let working = false;
let lastVersion;
let errorText = '';
const listFields = [
  ['decisions', '决策'], ['pinnedFacts', '置顶事实'], ['blockers', '阻塞项'], ['touchedFiles', '涉及文件'],
];

function node(tag, text, parent = view) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

function button(label, callback, parent = view) {
  const element = node('button', label, parent);
  element.type = 'button';
  element.onclick = callback;
  return element;
}

function field(title, text) {
  const label = node('label');
  node('span', title, label);
  const control = node('textarea', undefined, label);
  control.rows = 2;
  control.value = text;
  control.oninput = () => { dirty = true; };
  return control;
}

async function run(operation) {
  if (working) return;
  working = true;
  try {
    const { taskState } = await operation();
    if (!current || taskState.version >= current.version) current = taskState;
    dirty = false;
    errorText = '';
  } catch (error) {
    errorText = error.message ?? String(error);
  } finally {
    working = false;
    if (dirty) {
      const error = view.querySelector('[data-error]') ?? node('p');
      error.dataset.error = '';
      error.textContent = errorText;
    } else {
      render();
    }
  }
}

function render() {
  view.replaceChildren();
  if (errorText) node('p', errorText).dataset.error = '';
  if (!current) {
    button('载入任务账本', () => run(() => action('get')));
    return;
  }
  node('h2', '任务账本');
  node('small', '版本 ' + current.version);
  if (current.ledgerFilePath) button('打开账本文件', () => openFile(current.ledgerFilePath));
  const objective = field('目标', current.objective);
  const fields = listFields.map(([key, title]) => [key, field(title, (current[key] ?? []).join('\n'))]);
  const stepsTitle = node('h3', '步骤');
  const steps = node('div');
  const stepRows = [];
  function addStep(step) {
    const row = node('div', undefined, steps);
    row.className = 'actions';
    const title = node('input', undefined, row);
    title.value = step.title;
    title.placeholder = '步骤名称';
    title.setAttribute('aria-label', '步骤名称');
    title.oninput = () => { dirty = true; };
    const select = node('select', undefined, row);
    select.setAttribute('aria-label', '步骤状态');
    for (const [value, caption] of [['pending', '待处理'], ['in_progress', '进行中'], ['done', '已完成'], ['blocked', '阻塞']]) {
      node('option', caption, select).value = value;
    }
    select.value = step.status;
    select.onchange = () => { dirty = true; };
    const item = { step, row, title, select };
    stepRows.push(item);
    button('删除', () => {
      row.remove();
      dirty = true;
    }, row);
  }
  current.steps.forEach(addStep);
  button('添加步骤', () => {
    dirty = true;
    addStep({ id: crypto.randomUUID(), title: '', status: 'pending', updatedAt: Date.now() });
  }, stepsTitle);
  const digest = field('历史摘要', current.rollingSummary);
  const buttons = node('div');
  buttons.className = 'actions';
  button('保存', () => run(() => action('save', {
    patch: {
      objective: objective.value,
      ...Object.fromEntries(fields.map(([key, control]) => [key, control.value.split('\n').map((line) => line.trim()).filter(Boolean)])),
      rollingSummary: digest.value,
      steps: stepRows.filter(({ row, title }) => row.isConnected && title.value.trim())
        .map(({ step, title, select }) => ({ ...step, title: title.value.trim(), status: select.value })),
    },
  })), buttons);
  const summarize = button('提炼摘要', () => {
    if (dirty) {
      const error = view.querySelector('[data-error]') ?? node('p');
      error.dataset.error = '';
      error.textContent = '请先保存编辑';
      return;
    }
    void run(() => action('summarize'));
  }, buttons);
  summarize.disabled = !bridge.props.summaryAvailable;
  if (current.verifications.length) {
    node('h3', '校验');
    for (const entry of current.verifications) node('p', [entry.status, entry.command, entry.summary].filter(Boolean).join(' · '));
  }
  for (const path of current.touchedFiles) button(path, () => openFile(path));
}

function openFile(path) {
  action('openFile', { path }).catch((error) => {
    const output = view.querySelector('[data-error]') ?? node('p');
    output.dataset.error = '';
    output.textContent = error.message;
  });
}

bridge.onContext((_session, props) => {
  if (props.version !== lastVersion) {
    lastVersion = props.version;
    if (!dirty) void run(() => action('get'));
  }
  const summary = [...view.querySelectorAll('button')].find((item) => item.textContent === '提炼摘要');
  if (summary) summary.disabled = !props.summaryAvailable;
});
new ResizeObserver(() => bridge.resize(view.offsetHeight)).observe(view);
void run(() => action('get'));
