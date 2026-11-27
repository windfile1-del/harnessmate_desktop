const bridge = window.harnessMate;
const view = document.querySelector('#view');
let harnesses = [];
let session = bridge.session;
let props = bridge.props;

function node(tag, text, parent) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

function button(label, operation, parent) {
  const element = node('button', label, parent);
  element.type = 'button';
  element.onclick = async () => {
    element.disabled = true;
    try {
      await operation();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      element.disabled = false;
    }
  };
  return element;
}

const route = (path, method = 'GET', body) => bridge.call('plugin.route', {
  path, method, body,
  query: { sessionId: session?.id, workspaceId: session?.workspaceId ?? props.workspaceId },
});
const tokens = (value) => Number(value ?? 0).toLocaleString('zh-CN');
view.replaceChildren();
const toolbar = node('div', undefined, view);
toolbar.className = 'row spread';
node('small', '账号配额与本机使用统计', toolbar);
button('强制刷新配额', () => loadAccounts(true), toolbar);
const status = node('p', '', view);
status.className = 'error';
status.setAttribute('role', 'status');
const accountsView = node('div', undefined, view);
const policyView = node('section', undefined, view);

async function loadAccounts(refresh = false) {
  const result = await bridge.call('plugin.route', { path: '/accounts', query: { refresh } });
  accountsView.replaceChildren();
  status.textContent = '';
  if (!result.accounts.length) node('p', '暂无账号用量。', accountsView);
  for (const account of result.accounts) {
    const card = node('section', undefined, accountsView);
    node('h3', account.displayName, card);
    node('p', [account.accountLabel ?? (account.loggedIn ? '已登录' : '本地统计'), account.planType,
      account.billingTier, account.loggedIn ? '在线' : '未认证'].filter(Boolean).join(' · '), card);
    for (const limit of account.rateLimits) {
      node('p', `${limit.label} · ${limit.usedPercent}%`, card);
      const bar = node('progress', undefined, card);
      bar.max = 100;
      bar.value = limit.usedPercent;
      bar.setAttribute('aria-label', limit.label);
      if (limit.resetsAt) node('small', `重置时间 ${new Date(limit.resetsAt).toLocaleString('zh-CN')}`, card);
    }
    if (account.lifetimeTokens !== undefined) node('p', `累计历史 Token ${tokens(account.lifetimeTokens)}`, card);
    if (account.currentStreakDays !== undefined) node('p', `连续活跃 ${account.currentStreakDays} 天`, card);
    if (account.resetCreditsAvailable) node('p', `可用限额重置券 ${account.resetCreditsAvailable}`, card);
    if (account.dailyBuckets.length) {
      const trend = node('div', undefined, card);
      trend.className = 'trend';
      const max = Math.max(1, ...account.dailyBuckets.map((day) => day.tokens));
      for (const day of account.dailyBuckets) {
        const bar = node('div', undefined, trend);
        bar.className = 'bar';
        bar.style.height = `${Math.max(8, day.tokens / max * 100)}%`;
        bar.title = `${day.date} · ${tokens(day.tokens)} tokens`;
      }
    }
    node('p', `本机桌面会话 ${account.localSessionCount} 个 · 输入 ${tokens(account.localInputTokens)} / 输出 ${tokens(account.localOutputTokens)}`, card);
    if (account.localInputTokens > 0 && account.localCachedTokens > 0) {
      node('p', `Prompt Cache ${Math.min(100, Math.round(account.localCachedTokens / account.localInputTokens * 100))}%`, card);
    }
    if (account.localCostUsd > 0) node('p', `本机估算 $${account.localCostUsd.toFixed(4)}`, card);
    if (account.error) node('p', account.error, card).className = 'error';
    if ((account.driverId ?? account.harnessKind) === 'agy') {
      node('small', '多 AGY Google 账号禁止自动额度轮换，仅支持手动一键切换。', card);
      if (session) button('手动切换至该账号', () => bridge.call('session.switchHarness', {
        targetHarnessId: account.instanceId ?? account.harnessId,
      }), card);
    }
  }
}

async function loadPolicy() {
  policyView.replaceChildren();
  node('h3', 'Failover 限额接力策略与优先级链', policyView);
  let policy;
  try {
    ({ policy } = await route('/policy'));
  } catch (error) {
    node('p', error.message, policyView).className = 'error';
    button('重试读取策略', loadPolicy, policyView);
    return;
  }
  const modeLabel = node('label', '接力模式', policyView);
  const mode = node('select', undefined, modeLabel);
  for (const [value, text] of [['manual_one_click', '一键确认接力'], ['auto_same_tier', '同档位自动接力'], ['auto_any', '任意可用实例自动接力']]) {
    node('option', text, mode).value = value;
  }
  mode.value = policy.mode;
  const maxLabel = node('label', '单会话最大自动切换次数', policyView);
  const max = node('input', undefined, maxLabel);
  max.type = 'number';
  max.min = '0';
  max.max = '10';
  max.value = policy.maxAutoSwitchesPerSession;
  const flags = {};
  for (const [key, text] of [['autoRetryInterruptedPrompt', '自动重试中断的提示词'], ['notifyOnQuotaReset', '额度重置时通知']]) {
    const label = node('label', text, policyView);
    flags[key] = node('input', undefined, label);
    flags[key].type = 'checkbox';
    flags[key].checked = policy[key];
  }
  const known = harnesses.map((harness) => harness.id);
  const chain = [...policy.priorityChain.filter((id) => known.includes(id)), ...known.filter((id) => !policy.priorityChain.includes(id))];
  const order = node('div', undefined, policyView);
  function renderOrder() {
    order.replaceChildren();
    chain.forEach((id, index) => {
      const row = node('div', undefined, order);
      row.className = 'row spread';
      node('span', harnesses.find((harness) => harness.id === id)?.displayName ?? id, row);
      const actions = node('div', undefined, row);
      for (const [direction, text] of [[-1, '上移'], [1, '下移']]) {
        const target = index + direction;
        const control = button(text, () => {
          [chain[index], chain[target]] = [chain[target], chain[index]];
          renderOrder();
        }, actions);
        control.disabled = target < 0 || target >= chain.length;
      }
    });
  }
  renderOrder();
  button('保存策略', async () => {
    await route('/policy', 'PUT', { ...policy, mode: mode.value, priorityChain: chain,
      maxAutoSwitchesPerSession: Math.max(0, Math.min(10, Number(max.value) || 0)),
      ...Object.fromEntries(Object.entries(flags).map(([key, field]) => [key, field.checked])),
    });
    status.textContent = '策略已保存';
  }, policyView);
}

bridge.onContext((nextSession, nextProps) => { session = nextSession; props = nextProps; });
new ResizeObserver(() => bridge.resize(view.offsetHeight)).observe(view);
async function start() {
  ({ harnesses } = await bridge.call('plugins.list'));
  await Promise.all([loadAccounts(), loadPolicy()]);
}
start().catch((error) => { status.textContent = error.message; button('重试', start, toolbar); });
