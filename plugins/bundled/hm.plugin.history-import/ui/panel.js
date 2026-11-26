(() => {
  const hm = window.harnessMate || {};

  const els = {
    instanceBadge: document.getElementById('instance-badge'),
    sourceCountBadge: document.getElementById('source-count-badge'),
    resolutionBanner: document.getElementById('resolution-banner'),
    statusLine: document.getElementById('status-line'),
    tabNative: document.getElementById('tab-native'),
    tabBundle: document.getElementById('tab-bundle'),
    nativeView: document.getElementById('native-view'),
    bundleView: document.getElementById('bundle-view'),
    sourceFilter: document.getElementById('source-filter'),
    queryInput: document.getElementById('query-input'),
    btnDiscover: document.getElementById('btn-discover'),
    sourceErrorsBanner: document.getElementById('source-errors-banner'),
    sourceErrorsList: document.getElementById('source-errors-list'),
    sessionCountBadge: document.getElementById('session-count-badge'),
    sessionGroups: document.getElementById('session-groups'),
    detailTitle: document.getElementById('detail-title'),
    detailBadge: document.getElementById('detail-badge'),
    detailEmpty: document.getElementById('detail-empty'),
    detailBody: document.getElementById('detail-body'),
    existingSessionBanner: document.getElementById('existing-session-banner'),
    existingSessionText: document.getElementById('existing-session-text'),
    btnOpenExisting: document.getElementById('btn-open-existing'),
    previewWarningsBanner: document.getElementById('preview-warnings-banner'),
    previewWarningsList: document.getElementById('preview-warnings-list'),
    nativeMode: document.getElementById('native-mode'),
    nativeWorkspace: document.getElementById('native-workspace'),
    nativeTitlePreview: document.getElementById('native-title-preview'),
    btnRefreshPreview: document.getElementById('btn-refresh-preview'),
    btnImportNative: document.getElementById('btn-import-native'),
    btnCancelImport: document.getElementById('btn-cancel-import'),
    nativeResultBanner: document.getElementById('native-result-banner'),
    nativeResultText: document.getElementById('native-result-text'),
    btnOpenImported: document.getElementById('btn-open-imported'),
    nativeErrorBanner: document.getElementById('native-error-banner'),
    previewMessages: document.getElementById('preview-messages'),
    bundleFile: document.getElementById('bundle-file'),
    bundleWorkspace: document.getElementById('bundle-workspace'),
    bundleTitleOverride: document.getElementById('bundle-title-override'),
    bundleJson: document.getElementById('bundle-json'),
    btnPreviewBundle: document.getElementById('btn-preview-bundle'),
    btnImportBundle: document.getElementById('btn-import-bundle'),
    bundleErrorBanner: document.getElementById('bundle-error-banner'),
    bundleResultBanner: document.getElementById('bundle-result-banner'),
    bundleResultText: document.getElementById('bundle-result-text'),
    btnOpenBundleSession: document.getElementById('btn-open-bundle-session'),
    bundlePreviewMessages: document.getElementById('bundle-preview-messages'),
  };

  const state = {
    activeTab: 'native',
    instanceId: hm.instanceId || hm.pluginId || 'hm.plugin.history-import',
    workspaceId: hm.workspaceId || (hm.props && hm.props.workspaceId) || '',
    workspaces: Array.isArray(hm.props && hm.props.workspaces) ? hm.props.workspaces : [],
    sources: [],
    sessions: [],
    sourceErrors: [],
    selectedKey: '',
    selectedSummary: null,
    previewData: null,
    inFlightImport: null,
    lastNativeRequestKey: '',
    lastNativeRequestId: '',
    lastImportedSessionId: '',
    lastBundleSessionId: '',
  };

  function makeId(prefix) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function sessionKey(summary) {
    if (!summary || !summary.ref) return '';
    return `${summary.ref.sourceInstanceId}::${summary.ref.sourceId}::${summary.ref.nativeSessionId}`;
  }

  function formatTime(ts) {
    if (!ts) return '未知时间';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  function setStatus(text) {
    if (els.statusLine) els.statusLine.textContent = text;
  }

  function notifyToast(title, body, kind) {
    if (typeof hm.toast === 'function') {
      try {
        hm.toast(title, body, kind);
      } catch {
        // ignore host toast failure
      }
    }
  }

  async function callPluginRoute(method, routePath, body, legacyMessageType, legacyParams) {
    const cleanPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
    if (typeof hm.requestPluginRoute === 'function') {
      return hm.requestPluginRoute({
        instanceId: state.instanceId || hm.instanceId,
        method,
        path: cleanPath,
        ...(body !== undefined ? { body } : {}),
      });
    }
    if (typeof hm.sendToPlugin === 'function') {
      return hm.sendToPlugin({
        type: legacyMessageType,
        ...(legacyParams !== undefined ? { params: legacyParams } : {}),
      });
    }
    throw new Error('宿主未提供 plugin.route 或 plugin.message 桥接通道');
  }

  async function navigateToSession(sessionId, workspaceId) {
    if (!sessionId) return;
    if (typeof hm.navigateToSession === 'function') {
      await hm.navigateToSession({
        sessionId,
        ...(workspaceId ? { workspaceId } : {}),
        closeWorkspace: true,
      });
      return;
    }
    window.parent.postMessage(
      {
        type: 'hm:action',
        action: 'navigateToSession',
        params: { sessionId, workspaceId, closeWorkspace: true },
        slotId: hm.slotId || 'history-import',
        runId: hm.runId,
      },
      '*',
    );
  }

  async function refreshHostLists() {
    try {
      if (typeof hm.refreshWorkspaces === 'function') {
        const wsRes = await hm.refreshWorkspaces();
        if (wsRes && Array.isArray(wsRes.workspaces)) {
          state.workspaces = wsRes.workspaces;
          renderWorkspaceOptions();
        }
      } else {
        window.parent.postMessage(
          {
            type: 'hm:action',
            action: 'refreshWorkspaces',
            params: {},
            slotId: hm.slotId || 'history-import',
            runId: hm.runId,
          },
          '*',
        );
      }
      if (typeof hm.refreshSessions === 'function') {
        await hm.refreshSessions();
      } else {
        window.parent.postMessage(
          {
            type: 'hm:action',
            action: 'refreshSessions',
            params: {},
            slotId: hm.slotId || 'history-import',
            runId: hm.runId,
          },
          '*',
        );
      }
    } catch {
      // non-fatal host sync
    }
  }

  function applyTheme(theme) {
    const mode = theme === 'light' ? 'light' : 'dark';
    document.documentElement.style.colorScheme = mode;
  }

  function applyResolutionBanner(props) {
    if (!els.resolutionBanner) return;
    const issues = [];
    const imp = props && props.serviceResolution;
    const src = props && props.sourceResolution;
    if (imp && imp.status && imp.status !== 'resolved') {
      issues.push(`导入服务 (${imp.contract || 'history.import.v1'}) 状态: ${imp.status} ${imp.reason || ''}`.trim());
    }
    if (src && src.status && src.status !== 'resolved') {
      issues.push(`历史来源 (${src.contract || 'history.source.v1'}) 状态: ${src.status} ${src.reason || ''}`.trim());
    }
    if (issues.length === 0) {
      els.resolutionBanner.hidden = true;
      els.resolutionBanner.textContent = '';
    } else {
      els.resolutionBanner.hidden = false;
      els.resolutionBanner.textContent = issues.join('；');
    }
  }

  function renderWorkspaceOptions(preferredWorkspaceId) {
    const selects = [els.nativeWorkspace, els.bundleWorkspace];
    const targetPreferred = preferredWorkspaceId || state.workspaceId || '';
    for (const sel of selects) {
      if (!sel) continue;
      const previous = sel.value;
      sel.replaceChildren();
      const autoOpt = document.createElement('option');
      autoOpt.value = '';
      autoOpt.textContent = sel === els.nativeWorkspace ? '自动匹配原工作目录或当前工作区' : '默认首个工作区';
      sel.appendChild(autoOpt);

      for (const ws of state.workspaces) {
        const opt = document.createElement('option');
        opt.value = ws.id;
        opt.textContent = ws.rootPath ? `${ws.name} (${ws.rootPath})` : ws.name || ws.id;
        sel.appendChild(opt);
      }

      const candidate = previous || targetPreferred;
      if (candidate && state.workspaces.some((w) => w.id === candidate)) {
        sel.value = candidate;
      }
    }
  }

  function renderSourceFilter() {
    if (!els.sourceFilter) return;
    const prev = els.sourceFilter.value;
    els.sourceFilter.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = `全部来源 (${state.sources.length})`;
    els.sourceFilter.appendChild(allOpt);
    for (const src of state.sources) {
      const opt = document.createElement('option');
      opt.value = src.instanceId;
      const label = (src.metadata && src.metadata.title) || src.pluginId || src.instanceId;
      opt.textContent = `${label} (${src.instanceId})`;
      els.sourceFilter.appendChild(opt);
    }
    if (prev && state.sources.some((s) => s.instanceId === prev)) {
      els.sourceFilter.value = prev;
    }
    if (els.sourceCountBadge) {
      els.sourceCountBadge.textContent = `来源: ${state.sources.length}`;
    }
  }

  function renderSourceErrors() {
    if (!els.sourceErrorsBanner || !els.sourceErrorsList) return;
    els.sourceErrorsList.replaceChildren();
    if (!state.sourceErrors.length) {
      els.sourceErrorsBanner.hidden = true;
      return;
    }
    els.sourceErrorsBanner.hidden = false;
    for (const err of state.sourceErrors) {
      const li = document.createElement('li');
      li.textContent = `[${err.instanceId}] (${err.code}) ${err.message}`;
      els.sourceErrorsList.appendChild(li);
    }
  }

  function getFilteredSessions() {
    const q = (els.queryInput && els.queryInput.value ? els.queryInput.value : '').trim().toLowerCase();
    const sourceFilter = els.sourceFilter ? els.sourceFilter.value : '';
    return state.sessions.filter((s) => {
      if (sourceFilter && s.ref && s.ref.sourceInstanceId !== sourceFilter) return false;
      if (!q) return true;
      const haystack = [
        s.title,
        s.harnessKind,
        s.workspaceHint && s.workspaceHint.cwd,
        s.ref && s.ref.sourceId,
        s.ref && s.ref.sourceInstanceId,
        s.ref && s.ref.nativeSessionId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  function renderSessionList() {
    if (!els.sessionGroups) return;
    const filtered = getFilteredSessions();
    if (els.sessionCountBadge) {
      els.sessionCountBadge.textContent = `${filtered.length} 条`;
    }
    els.sessionGroups.replaceChildren();

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = state.sessions.length === 0
        ? '当前未发现可导入的历史会话。请检查来源插件或点击“刷新扫描”。'
        : '没有匹配当前筛选条件的历史会话。';
      els.sessionGroups.appendChild(empty);
      return;
    }

    const bySource = new Map();
    for (const s of filtered) {
      const sid = (s.ref && s.ref.sourceInstanceId) || 'unknown';
      if (!bySource.has(sid)) bySource.set(sid, []);
      bySource.get(sid).push(s);
    }

    for (const [sourceInstanceId, items] of bySource.entries()) {
      const group = document.createElement('div');
      const header = document.createElement('div');
      header.className = 'source-group-header';
      const srcMeta = state.sources.find((p) => p.instanceId === sourceInstanceId);
      const srcLabel = (srcMeta && srcMeta.metadata && srcMeta.metadata.title) || sourceInstanceId;
      const left = document.createElement('span');
      left.textContent = `${srcLabel} (${sourceInstanceId})`;
      const right = document.createElement('span');
      right.textContent = `${items.length} 条`;
      header.append(left, right);
      group.appendChild(header);

      for (const s of items) {
        const key = sessionKey(s);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `session-item${key === state.selectedKey ? ' selected' : ''}`;
        btn.addEventListener('click', () => void selectSession(s));

        const titleRow = document.createElement('div');
        titleRow.className = 'session-title-row';
        const titleEl = document.createElement('span');
        titleEl.className = 'session-title';
        titleEl.textContent = s.title || s.ref.nativeSessionId;
        titleRow.appendChild(titleEl);

        if (s.alreadyImportedSessionId) {
          const importedBadge = document.createElement('span');
          importedBadge.className = 'badge success';
          importedBadge.textContent = '已导入';
          titleRow.appendChild(importedBadge);
        } else if (s.harnessKind) {
          const kindBadge = document.createElement('span');
          kindBadge.className = 'badge';
          kindBadge.textContent = s.harnessKind;
          titleRow.appendChild(kindBadge);
        }

        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = `消息数: ${s.messageCount ?? '未知'} · 更新: ${formatTime(s.updatedAt)}`;

        const pathEl = document.createElement('div');
        pathEl.className = 'session-path';
        pathEl.textContent = (s.workspaceHint && s.workspaceHint.cwd) || s.ref.nativeSessionId;

        btn.append(titleRow, meta, pathEl);
        group.appendChild(btn);
      }

      els.sessionGroups.appendChild(group);
    }
  }

  function renderMessagesList(container, items) {
    if (!container) return;
    container.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无可预览的文本消息。';
      container.appendChild(empty);
      return;
    }
    for (const item of items.slice(0, 80)) {
      const card = document.createElement('article');
      card.className = `msg-card ${item.role === 'user' ? 'user' : 'assistant'}`;
      const role = document.createElement('div');
      role.className = 'msg-role';
      role.textContent = item.role === 'user' ? 'User' : 'Assistant';
      const body = document.createElement('pre');
      body.className = 'msg-text';
      body.textContent = item.text || '';
      card.append(role, body);
      container.appendChild(card);
    }
    if (items.length > 80) {
      const note = document.createElement('div');
      note.className = 'status-line';
      note.textContent = `仅展示前 80 条预览消息（共 ${items.length} 条）。`;
      container.appendChild(note);
    }
  }

  function renderPreviewDetail() {
    const summary = state.selectedSummary;
    const data = state.previewData;
    if (!summary) {
      els.detailEmpty.hidden = false;
      els.detailBody.hidden = true;
      els.detailTitle.textContent = '请选择一条历史会话';
      els.detailBadge.hidden = true;
      return;
    }

    els.detailEmpty.hidden = true;
    els.detailBody.hidden = false;
    els.detailTitle.textContent = (data && data.title) || summary.title || summary.ref.nativeSessionId;
    els.detailBadge.hidden = false;
    els.detailBadge.textContent = `${summary.ref.sourceInstanceId} / ${summary.ref.sourceId}`;

    const cwdText = (data && data.targetWorkspacePath) || (summary.workspaceHint && summary.workspaceHint.cwd) || '';
    els.nativeTitlePreview.value = cwdText
      ? `${(data && data.title) || summary.title || ''} — ${cwdText}`
      : (data && data.title) || summary.title || summary.ref.nativeSessionId;

    const existingId = (data && data.existingSessionId) || (els.nativeMode.value === 'attach' ? summary.alreadyImportedSessionId : null);
    if (existingId) {
      els.existingSessionBanner.hidden = false;
      els.existingSessionText.textContent = `该会话已以接管模式导入（会话 ID: ${existingId}）。`;
      els.btnOpenExisting.onclick = () => void navigateToSession(existingId, data && data.targetWorkspaceId);
    } else {
      els.existingSessionBanner.hidden = true;
    }

    const warnings = (data && Array.isArray(data.warnings) ? data.warnings : []).slice();
    if (data && data.readStatus === 'partial') {
      warnings.unshift('读取状态为 partial：外部历史文件可能存在截断或锁冲突，导入时将做容错保存。');
    }
    els.previewWarningsList.replaceChildren();
    if (warnings.length > 0) {
      els.previewWarningsBanner.hidden = false;
      for (const w of warnings) {
        const li = document.createElement('li');
        li.textContent = w;
        els.previewWarningsList.appendChild(li);
      }
    } else {
      els.previewWarningsBanner.hidden = true;
    }

    if (data && data.targetWorkspaceId && !els.nativeWorkspace.value) {
      renderWorkspaceOptions(data.targetWorkspaceId);
    }

    const busy = Boolean(state.inFlightImport);
    els.btnImportNative.disabled = busy || (data ? !data.importable : false);
    els.btnRefreshPreview.disabled = busy;
    els.btnCancelImport.hidden = !busy;
    els.btnCancelImport.disabled = !busy;

    renderMessagesList(els.previewMessages, data ? data.items : []);
  }

  async function loadInitialData() {
    setStatus('正在加载工作区与历史来源…');
    try {
      const [wsRes, srcRes] = await Promise.all([
        callPluginRoute('GET', '/workspaces', undefined, 'workspaces'),
        callPluginRoute('GET', '/sources', undefined, 'sources'),
      ]);
      if (wsRes && wsRes.ok && wsRes.value && Array.isArray(wsRes.value.workspaces)) {
        state.workspaces = wsRes.value.workspaces;
        renderWorkspaceOptions();
      }
      if (srcRes && srcRes.ok && srcRes.value && Array.isArray(srcRes.value.sources)) {
        state.sources = srcRes.value.sources;
        renderSourceFilter();
      }
    } catch (err) {
      setStatus(`初始化失败: ${err && err.message ? err.message : String(err)}`);
    }
    await runDiscover();
  }

  async function runDiscover() {
    setStatus('正在扫描来源历史会话…');
    if (els.btnDiscover) els.btnDiscover.disabled = true;
    try {
      const sourceInstanceId = els.sourceFilter && els.sourceFilter.value ? els.sourceFilter.value : undefined;
      const res = await callPluginRoute(
        'POST',
        '/discover',
        sourceInstanceId ? { sourceInstanceId } : {},
        'discover',
        sourceInstanceId ? { sourceInstanceId } : {},
      );
      if (!res || !res.ok) {
        const msg = (res && res.error && res.error.message) || '扫描失败';
        setStatus(`扫描失败: ${msg}`);
        return;
      }
      if (Array.isArray(res.value.sources)) {
        state.sources = res.value.sources;
        renderSourceFilter();
      }
      state.sessions = Array.isArray(res.value.sessions) ? res.value.sessions : [];
      state.sourceErrors = Array.isArray(res.value.errors) ? res.value.errors : [];
      renderSourceErrors();
      renderSessionList();
      setStatus(`已扫描 ${state.sources.length} 个来源，发现 ${state.sessions.length} 条历史会话。`);
    } catch (err) {
      setStatus(`扫描异常: ${err && err.message ? err.message : String(err)}`);
    } finally {
      if (els.btnDiscover) els.btnDiscover.disabled = false;
    }
  }

  async function selectSession(summary) {
    state.selectedSummary = summary;
    state.selectedKey = sessionKey(summary);
    state.previewData = null;
    els.nativeResultBanner.hidden = true;
    els.nativeErrorBanner.hidden = true;
    renderSessionList();
    renderPreviewDetail();
    await loadPreview();
  }

  async function loadPreview() {
    const summary = state.selectedSummary;
    if (!summary) return;
    const reqKey = `${sessionKey(summary)}::${els.nativeMode.value}::${els.nativeWorkspace.value}`;
    setStatus(`正在读取预览（固定来源 ${summary.ref.sourceInstanceId}）…`);
    try {
      const body = {
        input: {
          kind: 'native',
          ref: summary.ref,
          mode: els.nativeMode.value === 'mirror' ? 'mirror' : 'attach',
          ...(summary.title ? { title: summary.title } : {}),
          ...(summary.harnessKind ? { harnessKind: summary.harnessKind } : {}),
          ...(summary.workspaceHint && summary.workspaceHint.cwd ? { cwd: summary.workspaceHint.cwd } : {}),
          ...(summary.compatLegacySources ? { compatLegacySources: summary.compatLegacySources } : {}),
          ...(summary.sourcePath ? { sourcePath: summary.sourcePath } : {}),
        },
        ...(els.nativeWorkspace.value ? { workspaceId: els.nativeWorkspace.value } : {}),
      };
      const res = await callPluginRoute('POST', '/preview', body, 'preview', body);
      if (state.selectedKey !== sessionKey(summary)) return;
      if (!res || !res.ok) {
        els.nativeErrorBanner.hidden = false;
        els.nativeErrorBanner.textContent = `预览失败: ${(res && res.error && res.error.message) || '未知错误'}`;
        setStatus('预览失败');
        return;
      }
      state.previewData = res.value;
      els.nativeErrorBanner.hidden = true;
      renderPreviewDetail();
      setStatus(`预览完成：${(res.value.items || []).length} 条消息（${reqKey.slice(0, 24)}…）`);
    } catch (err) {
      els.nativeErrorBanner.hidden = false;
      els.nativeErrorBanner.textContent = `预览异常: ${err && err.message ? err.message : String(err)}`;
    }
  }

  async function runNativeImport() {
    const summary = state.selectedSummary;
    if (!summary || state.inFlightImport) return;
    const mode = els.nativeMode.value === 'mirror' ? 'mirror' : 'attach';
    const workspaceId = els.nativeWorkspace.value || (state.previewData && state.previewData.targetWorkspaceId) || undefined;
    const intentKey = `${sessionKey(summary)}::${mode}::${workspaceId || ''}`;
    if (state.lastNativeRequestKey !== intentKey || !state.lastNativeRequestId) {
      state.lastNativeRequestKey = intentKey;
      state.lastNativeRequestId = makeId('req');
    }
    const requestId = state.lastNativeRequestId;
    const operationId = makeId('op');

    state.inFlightImport = { requestId, operationId };
    els.nativeResultBanner.hidden = true;
    els.nativeErrorBanner.hidden = true;
    renderPreviewDetail();
    setStatus('正在从所选来源读取并提交会话（提交前可取消）…');

    const body = {
      requestId,
      operationId,
      ...(workspaceId ? { workspaceId } : {}),
      input: {
        kind: 'native',
        ref: summary.ref,
        mode,
        ...(summary.title ? { title: summary.title } : {}),
        ...(summary.harnessKind ? { harnessKind: summary.harnessKind } : {}),
        ...(summary.workspaceHint && summary.workspaceHint.cwd ? { cwd: summary.workspaceHint.cwd } : {}),
        ...(summary.compatLegacySources ? { compatLegacySources: summary.compatLegacySources } : {}),
        ...(summary.sourcePath ? { sourcePath: summary.sourcePath } : {}),
        ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
      },
    };

    try {
      const res = await callPluginRoute('POST', '/import', body, 'import', body);
      state.inFlightImport = null;
      if (!res || !res.ok) {
        const code = (res && res.error && res.error.code) || 'unknown';
        const message = (res && res.error && res.error.message) || '导入失败';
        if (code === 'cancelled') {
          state.lastNativeRequestId = '';
        }
        els.nativeErrorBanner.hidden = false;
        els.nativeErrorBanner.textContent = `(${code}) ${message}`;
        setStatus(`导入未完成: ${message}`);
        renderPreviewDetail();
        return;
      }

      const result = res.value;
      state.lastNativeRequestId = '';
      state.lastImportedSessionId = result.sessionId;
      els.nativeResultBanner.hidden = false;
      els.nativeResultText.textContent = `${result.disposition === 'reused' ? '已复用既有会话' : '已新建导入会话'}：${result.sessionId}（模式: ${result.mode}）`;
      els.btnOpenImported.onclick = () => void navigateToSession(result.sessionId, workspaceId);
      setStatus(`导入完成：${result.sessionId} (${result.disposition})`);
      notifyToast(
        result.disposition === 'reused' ? '已复用既有会话' : '历史会话导入成功',
        `会话 ID: ${result.sessionId}`,
        'success',
      );
      await Promise.all([refreshHostLists(), runDiscover()]);
      renderPreviewDetail();
    } catch (err) {
      state.inFlightImport = null;
      els.nativeErrorBanner.hidden = false;
      els.nativeErrorBanner.textContent = `导入异常: ${err && err.message ? err.message : String(err)}`;
      setStatus('导入请求异常，可点击“导入此会话”使用同一幂等请求重试。');
      renderPreviewDetail();
    }
  }

  async function cancelNativeImport() {
    if (!state.inFlightImport) return;
    const { operationId, requestId } = state.inFlightImport;
    setStatus('正在请求取消读取…');
    try {
      const res = await callPluginRoute(
        'POST',
        '/cancel',
        { operationId, requestId },
        'cancel',
        { operationId, requestId },
      );
      if (res && res.ok && res.value) {
        if (res.value.cancelled) {
          setStatus('已发送取消指令，正在等待读取阶段安全停止…');
        } else if (res.value.status === 'committing') {
          setStatus('已进入持久化提交阶段，正在等待数据库提交结果…');
        }
      }
    } catch (err) {
      setStatus(`取消请求发送失败: ${err && err.message ? err.message : String(err)}`);
    }
  }

  function parseBundleInput() {
    const raw = (els.bundleJson && els.bundleJson.value ? els.bundleJson.value : '').trim();
    if (!raw) {
      throw new Error('请先选择或粘贴 PortableSessionBundleV2 JSON 内容');
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.bundleVersion !== 2 || !parsed.session) {
      throw new Error('归档包必须包含 bundleVersion = 2 与 session 字段');
    }
    return parsed;
  }

  async function previewBundle() {
    els.bundleErrorBanner.hidden = true;
    try {
      const bundle = parseBundleInput();
      const body = {
        input: {
          kind: 'bundle',
          bundle,
          ...(els.bundleTitleOverride.value.trim()
            ? { titleOverride: els.bundleTitleOverride.value.trim() }
            : {}),
        },
        ...(els.bundleWorkspace.value ? { workspaceId: els.bundleWorkspace.value } : {}),
      };
      const res = await callPluginRoute('POST', '/preview', body, 'preview', body);
      if (!res || !res.ok) {
        els.bundleErrorBanner.hidden = false;
        els.bundleErrorBanner.textContent = (res && res.error && res.error.message) || '归档包预览失败';
        return;
      }
      els.bundlePreviewMessages.hidden = false;
      renderMessagesList(els.bundlePreviewMessages, res.value.items || []);
      setStatus(`归档包预览完成：${(res.value.items || []).length} 条消息`);
    } catch (err) {
      els.bundleErrorBanner.hidden = false;
      els.bundleErrorBanner.textContent = err && err.message ? err.message : String(err);
    }
  }

  async function importBundle() {
    els.bundleErrorBanner.hidden = true;
    els.bundleResultBanner.hidden = true;
    try {
      const bundle = parseBundleInput();
      const workspaceId = els.bundleWorkspace.value || undefined;
      const body = {
        requestId: makeId('req'),
        ...(workspaceId ? { workspaceId } : {}),
        input: {
          kind: 'bundle',
          bundle,
          ...(els.bundleTitleOverride.value.trim()
            ? { titleOverride: els.bundleTitleOverride.value.trim() }
            : {}),
        },
      };
      const res = await callPluginRoute('POST', '/import', body, 'import', body);
      if (!res || !res.ok) {
        els.bundleErrorBanner.hidden = false;
        els.bundleErrorBanner.textContent = (res && res.error && res.error.message) || '归档包导入失败';
        return;
      }
      const result = res.value;
      state.lastBundleSessionId = result.sessionId;
      els.bundleResultBanner.hidden = false;
      els.bundleResultText.textContent = `${result.disposition === 'reused' ? '归档包已复用会话' : '归档包导入成功'}：${result.sessionId}`;
      els.btnOpenBundleSession.onclick = () => void navigateToSession(result.sessionId, workspaceId);
      setStatus(`归档包导入完成：${result.sessionId}`);
      notifyToast('归档包导入成功', `会话 ID: ${result.sessionId}`, 'success');
      await refreshHostLists();
    } catch (err) {
      els.bundleErrorBanner.hidden = false;
      els.bundleErrorBanner.textContent = err && err.message ? err.message : String(err);
    }
  }

  function switchTab(tab) {
    state.activeTab = tab === 'bundle' ? 'bundle' : 'native';
    const isNative = state.activeTab === 'native';
    els.nativeView.hidden = !isNative;
    els.bundleView.hidden = isNative;
    els.tabNative.classList.toggle('active', isNative);
    els.tabBundle.classList.toggle('active', !isNative);
    els.tabNative.setAttribute('aria-selected', String(isNative));
    els.tabBundle.setAttribute('aria-selected', String(!isNative));
  }

  function bindEvents() {
    els.tabNative?.addEventListener('click', () => switchTab('native'));
    els.tabBundle?.addEventListener('click', () => switchTab('bundle'));
    els.btnDiscover?.addEventListener('click', () => void runDiscover());
    els.sourceFilter?.addEventListener('change', () => renderSessionList());
    els.queryInput?.addEventListener('input', () => renderSessionList());
    els.nativeMode?.addEventListener('change', () => void loadPreview());
    els.nativeWorkspace?.addEventListener('change', () => renderPreviewDetail());
    els.btnRefreshPreview?.addEventListener('click', () => void loadPreview());
    els.btnImportNative?.addEventListener('click', () => void runNativeImport());
    els.btnCancelImport?.addEventListener('click', () => void cancelNativeImport());
    els.btnPreviewBundle?.addEventListener('click', () => void previewBundle());
    els.btnImportBundle?.addEventListener('click', () => void importBundle());
    els.bundleFile?.addEventListener('change', async (e) => {
      const file = e.target && e.target.files ? e.target.files[0] : null;
      if (!file) return;
      try {
        els.bundleJson.value = await file.text();
        await previewBundle();
      } catch (err) {
        els.bundleErrorBanner.hidden = false;
        els.bundleErrorBanner.textContent = `读取归档文件失败: ${err && err.message ? err.message : String(err)}`;
      }
    });

    if (typeof hm.onTheme === 'function') {
      hm.onTheme((theme) => applyTheme(theme));
    }
    if (typeof hm.onContext === 'function') {
      hm.onContext((_session, props) => {
        if (!props || typeof props !== 'object') return;
        if (props.instanceId) {
          const changed = props.instanceId !== state.instanceId;
          state.instanceId = props.instanceId;
          if (els.instanceBadge) els.instanceBadge.textContent = state.instanceId;
          if (changed) {
            state.inFlightImport = null;
            state.selectedKey = '';
            state.selectedSummary = null;
            state.previewData = null;
            void loadInitialData();
          }
        }
        if (props.workspaceId !== undefined) {
          state.workspaceId = props.workspaceId || '';
        }
        if (Array.isArray(props.workspaces)) {
          state.workspaces = props.workspaces;
          renderWorkspaceOptions();
        }
        if (props.initialTab === 'bundle' || props.initialTab === 'native') {
          switchTab(props.initialTab);
        }
        applyResolutionBanner(props);
      });
    }
  }

  if (els.instanceBadge) {
    els.instanceBadge.textContent = state.instanceId;
  }
  applyTheme(hm.theme);
  applyResolutionBanner(hm.props);
  if (hm.props && (hm.props.initialTab === 'bundle' || hm.props.initialTab === 'native')) {
    switchTab(hm.props.initialTab);
  }
  renderWorkspaceOptions();
  bindEvents();
  void loadInitialData();
})();
