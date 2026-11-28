import type { NavigationRequestV1, NavigationResultV1 } from '@harnessmate/protocol';
import {
  HISTORY_IMPORT_CONTRACT,
  SESSION_SEARCH_CONTRACT,
  getPluginInstanceId,
  makeWorkspacePageKey,
} from '../../api/peer-contracts';
import type { NavigationHandler } from '../../kernel/navigation-bus';
import { parseFileLink } from '../../lib/file-links';
import {
  useAppStore,
  type ActiveModal,
  type InspectorTab,
} from '../../stores/app-store';

export const VALID_DEFAULT_INSPECTOR_TABS = new Set<InspectorTab>([
  'task',
  'git',
  'files',
  'terminal',
  'diagnostics',
  'info',
  'plugins',
]);

/**
 * Navigation handler owned by `hm.plugin.shell-default`.
 * Interprets generic `NavigationRequestV1` targets & placements into default layout transitions.
 */
export function createDefaultShellNavigationHandler(): NavigationHandler {
  return async (
    req: NavigationRequestV1 & { requestId: string },
  ): Promise<NavigationResultV1> => {
    const state = useAppStore.getState();
    const kind = req.target?.kind ?? (req.target?.pageId ? 'page' : 'unknown');
    const ctx = req.context ?? {};

    if (kind === 'session') {
      const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId.trim() : null;
      const signal = ctx.signal instanceof AbortSignal ? ctx.signal : undefined;
      if (sessionId === null) {
        await state.selectSession(null);
        return { requestId: req.requestId, status: 'accepted', placement: req.placement ?? 'primary' };
      }
      if (!state.sessions.some((s) => s.id === sessionId) && typeof state.syncImportedSession === 'function') {
        await state.syncImportedSession(sessionId).catch(() => null);
      }
      if (signal?.aborted) {
        return { requestId: req.requestId, status: 'failed', code: 'E_ABORTED', message: '导航已取消' };
      }
      const latest = useAppStore.getState();
      const targetSession = latest.sessions.find((s) => s.id === sessionId);
      const wsId =
        typeof ctx.workspaceId === 'string' && ctx.workspaceId.trim()
          ? ctx.workspaceId.trim()
          : targetSession?.workspaceId ?? null;
      if (wsId && latest.selectedWorkspaceId !== wsId) {
        latest.setSelectedWorkspaceId(wsId);
      }
      if (req.placement !== 'keep-page' && ctx.closeWorkspace !== false) {
        latest.setActivePluginPage(null);
      }
      await latest.selectSession(sessionId);
      if (signal?.aborted) {
        return { requestId: req.requestId, status: 'failed', code: 'E_ABORTED', message: '导航已取消' };
      }
      if (typeof ctx.turnId === 'string' && ctx.turnId.trim()) {
        useAppStore.getState().focusTurn({
          sessionId,
          turnId: ctx.turnId.trim(),
          itemId: typeof ctx.itemId === 'string' && ctx.itemId.trim() ? ctx.itemId.trim() : undefined,
        });
      }
      return {
        requestId: req.requestId,
        status: 'accepted',
        placement: req.placement ?? 'primary',
        detail: { sessionId },
      };
    }

    if (kind === 'file') {
      const rawPath =
        typeof ctx.path === 'string'
          ? ctx.path
          : typeof req.target.uri === 'string'
            ? req.target.uri
            : '';
      const parsed = parseFileLink(rawPath);
      if (!parsed && /^https?:\/\//i.test(rawPath.trim())) {
        return {
          requestId: req.requestId,
          status: 'failed',
          placement: 'side',
          code: 'E_INVALID_INPUT',
          message: '外部 HTTP 链接不支持在工作区文件预览中打开；当前会话已保留。',
          detail: {
            opened: false,
            sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : state.selectedSessionId,
            path: rawPath,
            errorCode: 'E_INVALID_INPUT',
            message: '外部 HTTP 链接不支持在工作区文件预览中打开；当前会话已保留。',
          },
        };
      }
      const result = state.navigateToFile({
        workspaceId: typeof ctx.workspaceId === 'string' ? ctx.workspaceId : undefined,
        sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined,
        path: rawPath,
        line: typeof ctx.line === 'number' ? ctx.line : parsed?.line,
        column: typeof ctx.column === 'number' ? ctx.column : parsed?.column,
        openInspector: ctx.openInspector !== false,
        preserveSession: ctx.preserveSession !== false,
      });
      return {
        requestId: req.requestId,
        status: result.opened
          ? 'accepted'
          : result.errorCode === 'E_PLUGIN_DISABLED' || result.errorCode === 'E_SERVICE_UNAVAILABLE'
            ? 'unavailable'
            : 'failed',
        placement: req.placement ?? 'side',
        code: result.errorCode,
        message: result.message,
        detail: result as unknown as Record<string, unknown>,
      };
    }

    if (kind === 'page') {
      const contract = req.target.contract;
      if (contract === SESSION_SEARCH_CONTRACT) {
        state.openSessionSearchPage({
          query: typeof ctx.query === 'string' ? ctx.query : undefined,
          instanceId: req.target.instanceId ?? null,
        });
        return { requestId: req.requestId, status: 'accepted', placement: req.placement ?? 'primary' };
      }
      if (contract === HISTORY_IMPORT_CONTRACT) {
        state.openHistoryImportPage({
          instanceId: req.target.instanceId ?? null,
          tab: ctx.tab === 'bundle' ? 'bundle' : 'native',
        });
        return { requestId: req.requestId, status: 'accepted', placement: req.placement ?? 'primary' };
      }
      const pageId = req.target.pageId ?? req.target.slotId;
      const instanceId = req.target.instanceId;
      if (instanceId && pageId) {
        const targetPlugin = state.plugins.find(
          (p) => getPluginInstanceId(p) === instanceId || p.id === instanceId,
        );
        if (
          targetPlugin &&
          (!targetPlugin.enabled || (targetPlugin.runtimeState && targetPlugin.runtimeState !== 'ACTIVE'))
        ) {
          return {
            requestId: req.requestId,
            status: 'unavailable',
            code: 'E_PLUGIN_DISABLED',
            message: `目标页面所属插件 ${instanceId} 当前已停用。`,
          };
        }
        state.openModal(null);
        state.setActivePluginPage(makeWorkspacePageKey(instanceId, pageId));
        return { requestId: req.requestId, status: 'accepted', placement: req.placement ?? 'primary' };
      }
      if (pageId === null || pageId === '') {
        state.setActivePluginPage(null);
        return { requestId: req.requestId, status: 'accepted', placement: 'primary' };
      }
      return {
        requestId: req.requestId,
        status: 'unavailable',
        code: 'E_INVALID_INPUT',
        message: '缺少有效的目标页面 instanceId 与 pageId。',
      };
    }

    if (kind === 'panel') {
      const tab = (typeof ctx.tab === 'string' ? ctx.tab : req.target.pageId) as InspectorTab;
      if (tab === 'plugins' && (typeof ctx.panelKey === 'string' || typeof req.target.slotId === 'string')) {
        state.openPluginPanel(String(ctx.panelKey ?? req.target.slotId));
        return { requestId: req.requestId, status: 'accepted', placement: 'drawer' };
      }
      if (VALID_DEFAULT_INSPECTOR_TABS.has(tab)) {
        state.setInspectorTab(tab);
        state.setInspectorOpen(true);
        return { requestId: req.requestId, status: 'accepted', placement: 'drawer' };
      }
      return {
        requestId: req.requestId,
        status: 'unavailable',
        code: 'E_NOT_SUPPORTED',
        message: `未知检视面板: ${String(tab)}`,
      };
    }

    if (kind === 'modal') {
      const modal = (ctx.modal !== undefined ? ctx.modal : req.target.pageId || null) as ActiveModal;
      const preset = typeof ctx.presetHarnessId === 'string' ? ctx.presetHarnessId : null;
      state.openModal(modal, preset);
      return { requestId: req.requestId, status: 'accepted', placement: 'modal' };
    }

    if (kind === 'external' && typeof req.target.uri === 'string' && /^https?:\/\//i.test(req.target.uri)) {
      if (typeof window !== 'undefined' && window.harnessMateBridge?.openExternal) {
        await window.harnessMateBridge.openExternal(req.target.uri);
      } else if (typeof window !== 'undefined') {
        window.open(req.target.uri, '_blank', 'noopener,noreferrer');
      }
      return { requestId: req.requestId, status: 'accepted', placement: 'external' };
    }

    return {
      requestId: req.requestId,
      status: 'unavailable',
      code: 'E_NOT_SUPPORTED',
      message: `默认布局不支持导航目标类型: ${kind}`,
    };
  };
}
