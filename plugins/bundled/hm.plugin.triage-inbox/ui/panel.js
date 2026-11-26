const bridge = window.harnessMate;
const view = document.querySelector('#view');
const action = (name, params) => bridge.call('surface.action', { action: name, ...params });
const heading = document.createElement('h2');
heading.textContent = '会话待办';
view.append(heading);
const list = document.createElement('section');
view.append(list);
const error = document.createElement('p');
error.dataset.error = '';
view.append(error);

function button(label, callback, parent, disabled = false) {
  const item = document.createElement('button');
  item.type = 'button';
  item.textContent = label;
  item.disabled = disabled;
  item.onclick = () => {
    item.disabled = true;
    Promise.resolve(callback()).catch((reason) => { error.textContent = reason.message; })
      .finally(() => { item.disabled = disabled; });
  };
  parent.append(item);
}

async function update(id, patch) {
  await action('update', { sessionId: id, patch });
  error.textContent = '';
}

function render(props) {
  list.replaceChildren();
  const entries = props.entries ?? [];
  if (entries.length === 0) {
    list.textContent = '当前没有会话';
    return;
  }
  for (const { session, state, group } of entries) {
    const row = document.createElement('article');
    row.append(document.createTextNode(session.title));
    const label = document.createElement('small');
    const groups = {
      needs_attention: '需要关注', unread: '未读', running: '运行中', pinned: '已置顶',
      normal: '已读', snoozed: '已延后', settled: '已处理',
    };
    label.textContent = groups[group] ?? group;
    if (state?.meta.snoozedUntilMs) label.textContent += ' · ' + new Date(state.meta.snoozedUntilMs).toLocaleString();
    row.append(label);
    const buttons = document.createElement('div');
    buttons.className = 'actions';
    button('打开会话', () => bridge.navigateToSession({ sessionId: session.id }), buttons);
    button(state?.meta.pinned ? '取消置顶' : '置顶', () => update(session.id, { pinned: !state?.meta.pinned }), buttons);
    button(group === 'unread' ? '标记已读' : '标记未读', () => group === 'unread'
      ? action('viewed', { sessionId: session.id })
      : update(session.id, { forceUnread: true, settled: false }), buttons);
    button(state?.meta.settled ? '重新待办' : '标记已处理', () => update(session.id, { settled: !state?.meta.settled }), buttons);
    if (state?.meta.snoozedUntilMs) {
      button('取消延后', () => update(session.id, { snoozedUntilMs: null }), buttons);
    } else {
      button('延后 30 分钟', () => update(session.id, { snoozedUntilMs: Date.now() + 30 * 60_000 }), buttons, !props.snoozeAvailable);
    }
    row.append(buttons);
    list.append(row);
  }
}

render(bridge.props);
bridge.onContext((_session, props) => render(props));
