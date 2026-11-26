const bridge = window.harnessMate;
const view = document.querySelector('#view');
const action = (name, params) => bridge.call('surface.action', { action: name, ...params });
const escapeAnsi = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
let blockId;
let fullOutput;
let nextOffset = 0;
let query = '';
let readError = '';
let pending = false;
let props = bridge.props;

function node(tag, text, parent = view) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

function button(label, handler, parent = view) {
  const element = node('button', label, parent);
  element.type = 'button';
  element.onclick = handler;
  return element;
}

function showError(error) {
  readError = error.message ?? String(error);
  render();
}

async function loadOutput() {
  pending = true;
  render();
  try {
    const result = await action('readOutput', { offset: nextOffset });
    fullOutput = (fullOutput ?? '') + result.text;
    nextOffset = result.nextTextOffset;
    readError = '';
  } catch (error) {
    readError = error.message;
  } finally {
    pending = false;
    render();
  }
}

function renderTool(block) {
  if (blockId !== block.blockId) {
    blockId = block.blockId;
    fullOutput = undefined;
    nextOffset = 0;
    query = '';
    readError = '';
  }
  node('small', [block.toolName ?? block.type, block.status, block.exitCode == null ? '' : '退出码 ' + block.exitCode].filter(Boolean).join(' · '));
  for (const file of block.files ?? []) {
    button(file.path, () => action('openFile', { path: file.path, line: file.line }).catch(showError));
  }
  const base = block.outputPreview ?? block.text ?? '';
  const live = props.liveOutput ?? '';
  const output = escapeAnsi(fullOutput ?? (live.length >= base.length ? live : base));
  if (output) {
    const search = node('input');
    search.type = 'search';
    search.placeholder = '筛选输出';
    search.setAttribute('aria-label', '筛选输出');
    search.value = query;
    const pre = node('pre');
    const filter = () => {
      query = search.value;
      const term = query.trim().toLowerCase();
      pre.textContent = term ? output.split('\n').filter((line) => line.toLowerCase().includes(term)).join('\n') : output;
    };
    search.oninput = filter;
    filter();
  }
  if (block.input !== undefined) {
    const detail = node('details');
    node('summary', '输入参数', detail);
    node('pre', JSON.stringify(block.input, null, 2), detail);
  }
  if (block.diff) {
    const detail = node('details');
    node('summary', '文件差异', detail);
    node('pre', block.diff, detail);
  }
  if ((block.outputOmitted || block.diffOmitted || fullOutput !== undefined) && nextOffset !== null) {
    button(pending ? '正在加载…' : fullOutput ? '加载下一段' : '读取持久化输出', loadOutput).disabled = pending;
  }
}

function render() {
  const focus = document.activeElement?.matches('input') ? document.activeElement.selectionStart : null;
  view.replaceChildren();
  if (bridge.slotId === 'studio-tool' && props.block) renderTool(props.block);
  if (bridge.slotId === 'studio-work-group') {
    const status = { running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
    node('small', [status[props.status] ?? props.status, props.activeStep,
      props.durationMs ? (props.durationMs / 1000).toFixed(1) + ' 秒' : ''].filter(Boolean).join(' · '));
  }
  if (bridge.slotId === 'studio-extension' && props.block) {
    const { originalType, type, textBody, payload, data, summary, title } = props.block;
    const detail = node('details');
    node('summary', title ?? summary ?? originalType ?? type, detail);
    node('pre', textBody ?? JSON.stringify(payload ?? data ?? {}, null, 2), detail);
  }
  if (bridge.slotId === 'studio-timeline') {
    const nav = node('nav');
    for (const item of props.entries ?? []) {
      const mark = item.failed ? '!' : item.kind === 'turn' ? '•' : '−';
      const point = button(mark, () => action('jump', { turnId: item.id }).catch(showError), nav);
      point.title = item.label;
      point.setAttribute('aria-label', item.label);
      point.setAttribute('aria-current', String(item.id === props.activeTurnId));
      point.disabled = item.kind !== 'turn';
    }
  }
  if (readError) node('p', readError).dataset.error = '';
  if (focus !== null) view.querySelector('input')?.focus();
}

bridge.onContext((_session, next) => {
  props = next;
  render();
});
new ResizeObserver(() => bridge.resize(view.offsetHeight)).observe(view);
render();
