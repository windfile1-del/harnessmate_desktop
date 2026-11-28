// External minimal layout plugin (hm.plugin.shell-lite)
// Uses ONLY public HarnessMate trusted-module runtime & bridge APIs.
// Zero imports from host internal stores or default layout components.

function parseFilePathSpec(rawHref) {
  if (!rawHref || typeof rawHref !== 'string') return null;
  let value = rawHref.trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return null;
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return null;
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  if (value.startsWith('/api/')) return null;

  let line;
  let column;
  const fragment = /#(?:L|line-?)?(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(value);
  if (fragment) {
    value = value.slice(0, fragment.index);
    line = Number(fragment[1]);
    if (fragment[2]) column = Number(fragment[2]);
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  const suffix = /:(\d+)(?::(\d+))?$/.exec(value);
  if (suffix) {
    value = value.slice(0, suffix.index);
    if (!line) line = Number(suffix[1]);
    if (!column && suffix[2]) column = Number(suffix[2]);
  }
  value = value.replace(/^\/(?=[a-z]:[\\/])/i, '').replaceAll('\\', '/');
  if (!value || value.startsWith('//') || /[\u0000-\u001f]/.test(value)) return null;
  return {
    path: value,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(Number.isSafeInteger(column) && column > 0 ? { column } : {}),
  };
}

export function mount({ container, bridge, runtime }) {
  const React = runtime.react;
  const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;
  const { createRoot } = runtime.reactDomClient;

  function ShellLiteApp() {
    const [sessions, setSessions] = useState([]);
    const [workspaces, setWorkspaces] = useState([]);
    const [harnesses, setHarnesses] = useState([]);
    const [selectedSessionId, setSelectedSessionId] = useState(null);
    const [activeDomainPage, setActiveDomainPage] = useState(null); // { instanceId, slotId, title }
    const [fileSidebarOpen, setFileSidebarOpen] = useState(false);
    const [filePathInput, setFilePathInput] = useState('');
    const [filePreview, setFilePreview] = useState(null); // { path, line, column, content, truncated }
    const [fileError, setFileError] = useState(null);
    const [workspaceFiles, setWorkspaceFiles] = useState([]);
    const [toasts, setToasts] = useState([]);
    const [kernelSnap, setKernelSnap] = useState(() => bridge.kernel.getSnapshot());
    const [domainPages, setDomainPages] = useState(() =>
      bridge.surfaces.listSlots('workspace.pages', { hasSession: true }),
    );

    const stateRef = useRef({});
    stateRef.current = {
      sessions,
      workspaces,
      harnesses,
      selectedSessionId,
      activeDomainPage,
      fileSidebarOpen,
      domainPages,
    };

    const chatHostRef = useRef(null);
    const chatSurfaceRef = useRef(null);
    const pageHostRef = useRef(null);
    const pageSurfaceRef = useRef(null);

    const pushToast = useCallback((toast) => {
      const id = `sl_toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, 3600);
    }, []);

    const activeSession = useMemo(
      () => sessions.find((s) => s.id === selectedSessionId) ?? null,
      [sessions, selectedSessionId],
    );

    const layoutProviders = useMemo(
      () =>
        (kernelSnap.plugins || []).filter(
          (p) =>
            p.enabled &&
            (!p.runtimeState || p.runtimeState === 'ACTIVE') &&
            ((p.provides || []).includes('application.view.v1') ||
              (p.providedContracts || []).some((c) => c.contract === 'application.view.v1')),
        ),
      [kernelSnap.plugins],
    );

    const loadData = useCallback(async () => {
      try {
        const [sRes, wRes, hRes] = await Promise.all([
          bridge.call('transport.request', { path: '/api/v1/sessions', method: 'GET' }),
          bridge.call('transport.request', { path: '/api/v1/workspaces', method: 'GET' }),
          bridge.call('transport.request', { path: '/api/v1/harnesses', method: 'GET' }),
        ]);
        const nextSessions = Array.isArray(sRes?.sessions) ? sRes.sessions : [];
        const nextWorkspaces = Array.isArray(wRes?.workspaces) ? wRes.workspaces : [];
        const nextHarnesses = Array.isArray(hRes?.harnesses) ? hRes.harnesses : [];
        setSessions(nextSessions);
        setWorkspaces(nextWorkspaces);
        setHarnesses(nextHarnesses);
        setSelectedSessionId((prev) => {
          if (prev && nextSessions.some((s) => s.id === prev)) return prev;
          return nextSessions[0]?.id ?? null;
        });
      } catch (err) {
        pushToast({ kind: 'error', title: '加载会话失败', body: String(err?.message ?? err) });
      }
    }, [pushToast]);

    const openFileInSidebar = useCallback(
      async (rawPath, explicitLine, explicitColumn, explicitSessionId) => {
        const parsed = parseFilePathSpec(rawPath);
        const sid = explicitSessionId ?? stateRef.current.selectedSessionId;
        setFileSidebarOpen(true);
        if (!parsed) {
          const message = /^https?:\/\//i.test(String(rawPath || '').trim())
            ? '外部 HTTP 链接不支持在文件侧栏中打开；当前会话已保留。'
            : '无效的文件路径；当前会话已保留。';
          setFileError({ path: String(rawPath || ''), code: 'E_INVALID_INPUT', message });
          setFilePreview(null);
          return {
            opened: false,
            sessionId: sid ?? null,
            path: String(rawPath || ''),
            errorCode: 'E_INVALID_INPUT',
            message,
          };
        }
        if (!sid) {
          const message = '当前没有活动会话，无法预览工作区文件。';
          setFileError({ path: parsed.path, code: 'E_SESSION_NOT_FOUND', message });
          setFilePreview(null);
          return {
            opened: false,
            sessionId: null,
            path: parsed.path,
            line: explicitLine ?? parsed.line,
            column: explicitColumn ?? parsed.column,
            errorCode: 'E_SESSION_NOT_FOUND',
            message,
          };
        }

        const resolution = await bridge
          .resolveService({ contract: 'workspace.files.v1', sessionId: sid })
          .catch(() => null);
        if (resolution && resolution.status !== 'ready') {
          const code = resolution.status === 'disabled' ? 'E_PLUGIN_DISABLED' : 'E_SERVICE_UNAVAILABLE';
          const message = '工作区文件能力当前已停用或不可用；当前会话已保留。';
          setFileError({ path: parsed.path, code, message });
          setFilePreview(null);
          return {
            opened: false,
            sessionId: sid,
            path: parsed.path,
            line: explicitLine ?? parsed.line,
            column: explicitColumn ?? parsed.column,
            errorCode: code,
            message,
          };
        }

        const line = explicitLine ?? parsed.line;
        const column = explicitColumn ?? parsed.column;
        setFilePathInput(parsed.path);
        setFileError(null);
        try {
          const qs = new URLSearchParams({ path: parsed.path });
          if (line) qs.set('line', String(line));
          const res = await bridge.call('transport.request', {
            path: `/api/v1/sessions/${encodeURIComponent(sid)}/file-view?${qs.toString()}`,
            method: 'GET',
          });
          const fileObj = res?.file ?? res;
          setFilePreview({
            path: fileObj?.relativePath ?? parsed.path,
            line,
            column,
            content: typeof fileObj?.content === 'string' ? fileObj.content : '',
            truncated: Boolean(fileObj?.truncated),
          });
          return {
            opened: true,
            sessionId: sid,
            path: fileObj?.relativePath ?? parsed.path,
            line,
            column,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setFileError({ path: parsed.path, code: 'E_READ_FAILED', message });
          setFilePreview(null);
          return {
            opened: false,
            sessionId: sid,
            path: parsed.path,
            line,
            column,
            errorCode: 'E_READ_FAILED',
            message,
          };
        }
      },
      [],
    );

    // Sync kernel snapshot & workspace.pages slots
    useEffect(() => {
      const unsubKernel = bridge.kernel.subscribe(() => {
        setKernelSnap(bridge.kernel.getSnapshot());
      });
      const unsubSlots = bridge.surfaces.onSlotsChanged(() => {
        setDomainPages(bridge.surfaces.listSlots('workspace.pages', { hasSession: true }));
      });
      void loadData();
      return () => {
        unsubKernel();
        unsubSlots();
      };
    }, [loadData]);

    // Publish public layout state so nested chat.view.v1 and domain pages work seamlessly
    useEffect(() => {
      bridge.application.publishState({
        sidebarCollapsed: false,
        inspectorOpen: fileSidebarOpen,
        inspectorTab: 'files',
        selectedWorkspaceId: activeSession?.workspaceId ?? workspaces[0]?.id ?? null,
        selectedSessionId,
        sessions,
        workspaces,
        harnesses,
        slashCommands: [],
      });
    }, [activeSession, fileSidebarOpen, harnesses, selectedSessionId, sessions, workspaces]);

    // Load file list when file sidebar opens for a session
    useEffect(() => {
      if (!fileSidebarOpen || !selectedSessionId) return;
      let cancelled = false;
      void bridge
        .call('transport.request', {
          path: `/api/v1/sessions/${encodeURIComponent(selectedSessionId)}/files`,
          method: 'GET',
        })
        .then((res) => {
          if (!cancelled && Array.isArray(res?.files)) {
            setWorkspaceFiles(res.files.slice(0, 60));
          }
        })
        .catch(() => {
          if (!cancelled) setWorkspaceFiles([]);
        });
      return () => {
        cancelled = true;
      };
    }, [fileSidebarOpen, selectedSessionId]);

    // Mount real chat.view.v1 via public bridge.surfaces
    useEffect(() => {
      const el = chatHostRef.current;
      if (!el || activeDomainPage) return;
      const handle = bridge.surfaces.mountBoundSurface(el, {
        contract: 'chat.view.v1',
        surface: 'chat',
        session: activeSession,
      });
      chatSurfaceRef.current = handle;
      return () => {
        handle.dispose();
        chatSurfaceRef.current = null;
      };
    }, [Boolean(activeDomainPage)]);

    useEffect(() => {
      chatSurfaceRef.current?.update({ session: activeSession });
    }, [activeSession]);

    // Mount active domain page via public bridge.surfaces
    useEffect(() => {
      const el = pageHostRef.current;
      if (!el || !activeDomainPage) return;
      const handle = bridge.surfaces.mountSlotItem(el, {
        slot: 'workspace.pages',
        instanceId: activeDomainPage.instanceId,
        slotId: activeDomainPage.slotId,
        session: activeSession,
        props: {
          workspaceId: activeSession?.workspaceId ?? workspaces[0]?.id ?? null,
        },
      });
      pageSurfaceRef.current = handle;
      return () => {
        handle.dispose();
        pageSurfaceRef.current = null;
      };
    }, [activeDomainPage]);

    useEffect(() => {
      pageSurfaceRef.current?.update({
        session: activeSession,
        props: { workspaceId: activeSession?.workspaceId ?? workspaces[0]?.id ?? null },
      });
    }, [activeSession, workspaces]);

    // Register public navigation handler, toast handler, shortcuts, and tray action
    useEffect(() => {
      const disposers = [];
      disposers.push(bridge.application.registerToastHandler(pushToast));

      disposers.push(
        bridge.navigation.registerHandler(async (req) => {
          const kind = req.target?.kind ?? (req.target?.pageId ? 'page' : 'unknown');
          const ctx = req.context ?? {};

          if (kind === 'session') {
            const sid = typeof ctx.sessionId === 'string' ? ctx.sessionId : null;
            if (sid && !stateRef.current.sessions.some((s) => s.id === sid)) {
              await loadData();
            }
            setActiveDomainPage(null);
            setSelectedSessionId(sid);
            return {
              requestId: req.requestId,
              status: 'accepted',
              placement: req.placement ?? 'primary',
              detail: { sessionId: sid },
            };
          }

          if (kind === 'file') {
            const rawPath =
              typeof ctx.path === 'string'
                ? ctx.path
                : typeof req.target?.uri === 'string'
                  ? req.target.uri
                  : '';
            const res = await openFileInSidebar(
              rawPath,
              typeof ctx.line === 'number' ? ctx.line : undefined,
              typeof ctx.column === 'number' ? ctx.column : undefined,
              typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined,
            );
            return {
              requestId: req.requestId,
              status: res.opened
                ? 'accepted'
                : res.errorCode === 'E_PLUGIN_DISABLED' || res.errorCode === 'E_SERVICE_UNAVAILABLE'
                  ? 'unavailable'
                  : 'failed',
              placement: req.placement ?? 'side',
              code: res.errorCode,
              message: res.message,
              detail: res,
            };
          }

          if (kind === 'page') {
            const pageId = req.target?.pageId ?? req.target?.slotId;
            const instId = req.target?.instanceId;
            const list = bridge.surfaces.listSlots('workspace.pages', { hasSession: true });
            const matched = list.find(
              (item) =>
                (!instId || item.instanceId === instId) &&
                (!pageId || item.id === pageId),
            );
            if (!matched) {
              return {
                requestId: req.requestId,
                status: 'unavailable',
                code: 'E_SERVICE_UNAVAILABLE',
                message: `目标领域页不可用 (${instId ?? ''}:${pageId ?? ''})`,
              };
            }
            setActiveDomainPage({
              instanceId: matched.instanceId,
              slotId: matched.id,
              title: matched.title,
            });
            return {
              requestId: req.requestId,
              status: 'accepted',
              placement: req.placement ?? 'primary',
            };
          }

          if (kind === 'external' && typeof req.target?.uri === 'string' && /^https?:\/\//i.test(req.target.uri)) {
            if (window.harnessMateBridge?.openExternal) {
              await window.harnessMateBridge.openExternal(req.target.uri);
            } else {
              window.open(req.target.uri, '_blank', 'noopener,noreferrer');
            }
            return { requestId: req.requestId, status: 'accepted', placement: 'external' };
          }

          return {
            requestId: req.requestId,
            status: 'unavailable',
            code: 'E_NOT_SUPPORTED',
            message: `Shell Lite 不支持导航目标: ${kind}`,
          };
        }),
      );

      disposers.push(
        bridge.contributions.register({
          id: 'shell-lite.toggle-files',
          kind: 'shortcut',
          title: 'Shell Lite: 切换文件侧栏',
          shortcut: 'Mod+Shift+L',
          order: 10,
          execute: () => setFileSidebarOpen((v) => !v),
        }),
        bridge.contributions.register({
          id: 'shell-lite.tray-files',
          kind: 'tray',
          title: 'Shell Lite: 切换文件侧栏',
          shortcut: 'Mod+Shift+L',
          order: 10,
          execute: () => setFileSidebarOpen((v) => !v),
        }),
        bridge.contributions.register({
          id: 'layout.syncSessions',
          kind: 'command',
          title: '同步会话列表',
          execute: async ({ args }) => {
            if (Array.isArray(args?.sessions)) setSessions(args.sessions);
            else await loadData();
          },
        }),
        bridge.contributions.register({
          id: 'layout.syncWorkspaces',
          kind: 'command',
          title: '同步工作区列表',
          execute: async ({ args }) => {
            if (Array.isArray(args?.workspaces)) setWorkspaces(args.workspaces);
            else await loadData();
          },
        }),
      );

      return () => {
        for (const d of disposers) d();
      };
    }, [loadData, openFileInSidebar, pushToast]);

    const visibleDomainPages = useMemo(
      () => domainPages.filter((page) => page.id !== 'chat'),
      [domainPages],
    );

    return h(
      'div',
      {
        'data-shell-layout': 'hm.plugin.shell-lite',
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          width: '100vw',
          backgroundColor: 'var(--bg-canvas)',
          color: 'var(--text-primary)',
          overflow: 'hidden',
        },
      },
      // Top bar
      h(
        'header',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '8px 14px',
            backgroundColor: 'var(--bg-rail)',
            borderBottom: '1px solid var(--border-hairline)',
            flexShrink: 0,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
          h(
            'strong',
            { style: { fontSize: '13px', color: 'var(--accent-indigo)' } },
            'Shell Lite',
          ),
          h(
            'select',
            {
              'aria-label': 'Shell Lite 会话选择',
              value: selectedSessionId ?? '',
              onChange: (e) => {
                setActiveDomainPage(null);
                setSelectedSessionId(e.target.value || null);
              },
              style: {
                maxWidth: '240px',
                padding: '4px 8px',
                borderRadius: '8px',
                border: '1px solid var(--border-hairline)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontSize: '12px',
              },
            },
            sessions.length === 0
              ? h('option', { value: '' }, '暂无会话')
              : sessions.map((s) =>
                  h('option', { key: s.id, value: s.id }, `${s.title} (${s.harnessId})`),
                ),
          ),
          visibleDomainPages.length > 0 &&
            h(
              'select',
              {
                'aria-label': 'Shell Lite 领域页',
                value: activeDomainPage ? `${activeDomainPage.instanceId}:${activeDomainPage.slotId}` : '',
                onChange: (e) => {
                  const val = e.target.value;
                  if (!val) {
                    setActiveDomainPage(null);
                    return;
                  }
                  const found = visibleDomainPages.find((p) => `${p.instanceId}:${p.id}` === val);
                  if (found) {
                    setActiveDomainPage({
                      instanceId: found.instanceId,
                      slotId: found.id,
                      title: found.title,
                    });
                  }
                },
                style: {
                  maxWidth: '200px',
                  padding: '4px 8px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-hairline)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                },
              },
              h('option', { value: '' }, '聊天主舞台'),
              visibleDomainPages.map((page) =>
                h('option', { key: `${page.instanceId}:${page.id}`, value: `${page.instanceId}:${page.id}` }, page.title),
              ),
            ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => setFileSidebarOpen((v) => !v),
              style: {
                padding: '4px 10px',
                borderRadius: '8px',
                border: '1px solid var(--border-hairline)',
                backgroundColor: fileSidebarOpen ? 'var(--bg-active)' : 'var(--bg-surface)',
                color: 'var(--text-primary)',
                fontSize: '12px',
                cursor: 'pointer',
              },
            },
            fileSidebarOpen ? '收起文件侧栏' : '文件侧栏',
          ),
          layoutProviders.length > 1 &&
            h(
              'select',
              {
                'aria-label': '切换应用布局',
                value: kernelSnap.compositionBindings?.['application.view.v1'] ?? bridge.instanceId,
                onChange: (e) => {
                  if (e.target.value) void bridge.kernel.switchApplicationEntry(e.target.value);
                },
                style: {
                  padding: '4px 8px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-hairline)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                },
              },
              layoutProviders.map((p) => {
                const id = p.instanceId ?? p.id;
                return h('option', { key: id, value: id }, `${p.name} (${id})`);
              }),
            ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => bridge.kernel.toggleTheme(),
              style: {
                padding: '4px 8px',
                borderRadius: '8px',
                border: '1px solid var(--border-hairline)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
                fontSize: '12px',
                cursor: 'pointer',
              },
            },
            kernelSnap.theme === 'dark' ? '浅色' : '深色',
          ),
        ),
      ),

      // Main body: Stage + Optional File Sidebar
      h(
        'div',
        { style: { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' } },
        // Primary stage (chat OR domain page)
        h(
          'main',
          { style: { display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0, minHeight: 0 } },
          activeDomainPage
            ? h(
                'div',
                { style: { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 } },
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 14px',
                      borderBottom: '1px solid var(--border-hairline)',
                      backgroundColor: 'var(--bg-surface)',
                      fontSize: '12px',
                    },
                  },
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setActiveDomainPage(null),
                      style: {
                        padding: '3px 8px',
                        borderRadius: '6px',
                        border: '1px solid var(--border-hairline)',
                        backgroundColor: 'transparent',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                      },
                    },
                    '返回聊天',
                  ),
                  h('span', { style: { fontWeight: 600 } }, activeDomainPage.title),
                ),
                h('div', {
                  ref: pageHostRef,
                  'data-testid': 'shell-lite-domain-page',
                  style: { display: 'flex', flex: 1, minHeight: 0 },
                }),
              )
            : h('div', {
                ref: chatHostRef,
                'data-testid': 'shell-lite-chat-stage',
                style: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 },
              }),
        ),

        // File Sidebar
        fileSidebarOpen &&
          h(
            'aside',
            {
              'data-testid': 'shell-lite-file-sidebar',
              style: {
                width: '340px',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                borderLeft: '1px solid var(--border-hairline)',
                backgroundColor: 'var(--bg-rail)',
                overflow: 'hidden',
              },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--border-hairline)',
                  fontSize: '12px',
                  fontWeight: 600,
                },
              },
              h('span', null, '文件侧栏预览'),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setFileSidebarOpen(false),
                  style: {
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  },
                },
                '关闭',
              ),
            ),
            h(
              'form',
              {
                onSubmit: (e) => {
                  e.preventDefault();
                  void openFileInSidebar(filePathInput);
                },
                style: { display: 'flex', gap: '6px', padding: '8px 10px' },
              },
              h('input', {
                'aria-label': '输入文件路径或 URI',
                value: filePathInput,
                onChange: (e) => setFilePathInput(e.target.value),
                placeholder: '路径 / file:// URI / :行:列',
                style: {
                  flex: 1,
                  padding: '4px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-hairline)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  fontSize: '11.5px',
                },
              }),
              h(
                'button',
                {
                  type: 'submit',
                  style: {
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'var(--accent-indigo)',
                    color: '#fff',
                    fontSize: '11.5px',
                    cursor: 'pointer',
                  },
                },
                '打开',
              ),
            ),
            h(
              'div',
              { style: { flex: 1, overflowY: 'auto', padding: '0 10px 12px' } },
              fileError &&
                h(
                  'div',
                  {
                    role: 'alert',
                    'data-testid': 'shell-lite-file-error',
                    style: {
                      padding: '8px 10px',
                      marginBottom: '8px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--accent-rose-soft)',
                      color: 'var(--accent-rose)',
                      fontSize: '11.5px',
                    },
                  },
                  fileError.message,
                ),
              filePreview &&
                h(
                  'div',
                  {
                    'data-testid': 'shell-lite-file-preview',
                    style: {
                      marginBottom: '10px',
                      borderRadius: '8px',
                      border: '1px solid var(--border-strong)',
                      backgroundColor: 'var(--code-bg)',
                      overflow: 'hidden',
                    },
                  },
                  h(
                    'div',
                    {
                      style: {
                        padding: '6px 10px',
                        borderBottom: '1px solid var(--border-hairline)',
                        fontSize: '11px',
                        color: 'var(--accent-indigo)',
                        wordBreak: 'break-all',
                      },
                    },
                    `${filePreview.path}${filePreview.line ? `:${filePreview.line}` : ''}${filePreview.column ? `:${filePreview.column}` : ''}`,
                  ),
                  h(
                    'pre',
                    {
                      style: {
                        margin: 0,
                        padding: '8px 10px',
                        fontSize: '11px',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: '280px',
                        overflowY: 'auto',
                      },
                    },
                    filePreview.content,
                  ),
                ),
              workspaceFiles.length > 0 &&
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                  workspaceFiles.map((f) =>
                    h(
                      'button',
                      {
                        key: f.relativePath,
                        type: 'button',
                        onClick: () => void openFileInSidebar(f.relativePath),
                        style: {
                          textAlign: 'left',
                          padding: '5px 8px',
                          borderRadius: '6px',
                          border: '1px solid var(--border-hairline)',
                          backgroundColor: 'var(--bg-surface)',
                          color: 'var(--text-primary)',
                          fontSize: '11px',
                          cursor: 'pointer',
                        },
                      },
                      f.relativePath,
                    ),
                  ),
                ),
            ),
          ),
      ),

      // Toasts
      toasts.length > 0 &&
        h(
          'div',
          {
            style: {
              position: 'fixed',
              right: '16px',
              bottom: '16px',
              zIndex: 50,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              width: '280px',
            },
          },
          toasts.map((t) =>
            h(
              'div',
              {
                key: t.id,
                style: {
                  padding: '8px 12px',
                  borderRadius: '10px',
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-strong)',
                  fontSize: '12px',
                },
              },
              h('div', { style: { fontWeight: 600 } }, t.title),
              t.body && h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, t.body),
            ),
          ),
        ),
    );
  }

  const root = createRoot(container);
  root.render(h(ShellLiteApp));
  return () => {
    root.unmount();
  };
}
