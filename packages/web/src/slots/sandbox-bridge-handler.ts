import type { ImportSessionBundleRequest, Session } from '@harnessmate/protocol';
import { ApiHttpError, daemonApi, getDaemonBaseUrl } from '../api/client';
import { getPluginInstanceId, makeWorkspacePageKey } from '../api/peer-contracts';
import { defaultPeerWorkspaceTransport } from '../api/peer-workspace-client';
import { useAppStore } from '../stores/app-store';
import { invokeShell, shellSnapshot } from './shell-bridge';

export interface SandboxedBridgeExecContext {
  pluginId: string;
  effectiveInstanceId: string;
  slot: string;
  slotId: string;
  runId: string;
  currentSession: Session | null;
  signal: AbortSignal;
  isDisposed: () => boolean;
}

/**
 * Executes host-side RPC methods invoked by a sandboxed plugin iframe via `window.harnessMate`.
 * Bound to an AbortSignal and disposal check so instance switching / unmount cancels in-flight work.
 */
export async function executeSandboxedBridgeMethod(
  ctx: SandboxedBridgeExecContext,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const {
    pluginId,
    effectiveInstanceId,
    slot,
    slotId,
    runId,
    currentSession,
    signal,
    isDisposed,
  } = ctx;
  const store = useAppStore.getState();
  if (method === 'presentation.publish') {
    if (JSON.stringify(params).length > 65536) throw new Error('页面投影超过 64 KiB');
    if (!signal.aborted && !isDisposed()) window.dispatchEvent(new CustomEvent('hm:presentation', {
      detail: { instanceId: effectiveInstanceId, sessionId: currentSession?.id, ...params },
    }));
    return {};
  }
  if (method === 'shell.snapshot') return shellSnapshot();
  if (method === 'shell.invoke') return invokeShell(String(params?.name ?? ''), Array.isArray(params?.args) ? params.args : []);
  if (method === 'clipboard.writeText') return navigator.clipboard.writeText(String(params?.text ?? ''));
  if (method === 'files.download') {
    const filename = String(params?.filename ?? 'export.txt').split(/[\\/]/).at(-1) || 'export.txt';
    const blob = new Blob([String(params?.text ?? '')], { type: String(params?.mime ?? 'text/plain') });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename };
  }
  if (method === 'transport.resource') {
    const path = String(params?.path ?? '');
    if (!path.startsWith('/api/v1/') || path.includes('..') || path.includes('\\')) throw new Error('需要本机公开资源路径');
    const response = await fetch(`${getDaemonBaseUrl()}${path}`, { signal });
    if (!response.ok) throw new Error(`读取资源失败: ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size > 16 * 1024 * 1024) throw new Error('需要 16 MiB 以内图片资源');
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
    });
  }

  if (method === 'services.call') {
    return daemonApi.callUiService(effectiveInstanceId, { ...params, runId }, signal);
  }

  if (method === 'transport.request') {
    const path = typeof params?.path === 'string' ? params.path : '';
    if (!path.startsWith('/api/v1/') || path.includes('..') || path.includes('\\')) {
      throw Object.assign(new Error('需要本机公开 API 路径'), { code: 'E_INVALID_INPUT' });
    }
    return daemonApi.request(path, { signal,
      method: typeof params?.method === 'string' ? params.method : 'GET',
      body: typeof params?.body === 'string' ? params.body : undefined });
  }

  if (method === 'plugin.route') {
    const targetInstanceId =
      typeof params?.instanceId === 'string' && params.instanceId.trim()
        ? params.instanceId.trim()
        : effectiveInstanceId;
    const rawPath = typeof params?.path === 'string' ? params.path.trim() : '';
    if (!rawPath) {
      throw Object.assign(new Error('缺少插件路由 path'), { code: 'E_INVALID_INPUT' });
    }
    const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    let routeWithQuery = normalizedPath;
    if (params?.query && typeof params.query === 'object' && !Array.isArray(params.query)) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params.query as Record<string, unknown>)) {
        if (v !== undefined && v !== null && v !== '') {
          sp.set(k, String(v));
        }
      }
      const qs = sp.toString();
      if (qs) {
        routeWithQuery += (normalizedPath.includes('?') ? '&' : '?') + qs;
      }
    }
    const httpMethod =
      typeof params?.method === 'string' && params.method.trim()
        ? params.method.trim().toUpperCase()
        : 'GET';
    const init: RequestInit = { method: httpMethod, signal };
    if (httpMethod !== 'GET' && httpMethod !== 'HEAD' && params?.body !== undefined) {
      init.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
    }
    try {
      return await daemonApi.callPluginInstanceRoute(targetInstanceId, routeWithQuery, init);
    } catch (err) {
      if (err instanceof ApiHttpError && err.payload && typeof err.payload === 'object' && 'ok' in err.payload) {
        return err.payload;
      }
      throw err;
    }
  }

  if (method === 'services.resolve') {
    const contract = typeof params?.contract === 'string' ? params.contract.trim() : '';
    if (!contract) {
      throw Object.assign(new Error('缺少服务契约 contract'), { code: 'E_INVALID_INPUT' });
    }
    const wsId =
      typeof params?.workspaceId === 'string'
        ? params.workspaceId
        : store.selectedWorkspaceId ?? undefined;
    const sId =
      typeof params?.sessionId === 'string'
        ? params.sessionId
        : currentSession?.id ?? undefined;
    return await defaultPeerWorkspaceTransport.resolveServiceSelection(contract, {
      workspaceId: wsId,
      sessionId: sId,
      explicitInstanceId:
        typeof params?.explicitInstanceId === 'string' ? params.explicitInstanceId : undefined,
      plugins: store.plugins,
      sessionBindings: sId ? store.sessionBindingsBySession[sId] : undefined,
      workspaceBindings: wsId ? store.workspaceBindingsByWorkspace[wsId] : undefined,
      compositionBindings: store.compositionBindings,
      compositionEntries: store.compositionEntries,
      signal,
    });
  }

  if (method === 'plugins.list') {
    return {
      plugins: store.plugins,
      workspaces: store.workspaces,
      harnesses: store.harnesses,
      sessions: store.sessions,
    };
  }

  if (method === 'import.bundle') {
    if (!params?.bundle) {
      throw Object.assign(new Error('缺少导出包 bundle'), { code: 'E_INVALID_INPUT' });
    }
    const req: ImportSessionBundleRequest = {
      bundle: params.bundle as ImportSessionBundleRequest['bundle'],
      workspaceId:
        typeof params.workspaceId === 'string' && params.workspaceId.trim()
          ? params.workspaceId.trim()
          : undefined,
    };
    const res = await daemonApi.importSessionBundle(req);
    if (signal.aborted || isDisposed()) return res;
    if (res.session?.id && typeof store.syncImportedSession === 'function') {
      await store.syncImportedSession(res.session.id).catch(() => null);
    }
    return res;
  }

  if (method === 'navigateToSession' || method === 'session.navigate') {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : '';
    if (!sessionId) {
      throw Object.assign(new Error('缺少目标 sessionId'), { code: 'E_INVALID_INPUT' });
    }
    const turnId = typeof params?.turnId === 'string' && params.turnId.trim() ? params.turnId.trim() : undefined;
    const itemId = typeof params?.itemId === 'string' && params.itemId.trim() ? params.itemId.trim() : undefined;
    const workspaceId =
      typeof params?.workspaceId === 'string' && params.workspaceId.trim()
        ? params.workspaceId.trim()
        : undefined;
    if (!store.sessions.some((s) => s.id === sessionId) && typeof store.syncImportedSession === 'function') {
      await store.syncImportedSession(sessionId).catch(() => null);
    }
    if (signal.aborted || isDisposed()) return { ok: false, aborted: true };
    const latestState = useAppStore.getState();
    const targetSession = latestState.sessions.find((s) => s.id === sessionId);
    const resolvedWorkspaceId = workspaceId ?? targetSession?.workspaceId ?? null;
    if (resolvedWorkspaceId && latestState.selectedWorkspaceId !== resolvedWorkspaceId) {
      latestState.setSelectedWorkspaceId(resolvedWorkspaceId);
    }
    if (params?.closeWorkspace !== false) {
      latestState.setActivePluginPage(null);
    }
    await latestState.selectSession(sessionId);
    if (signal.aborted || isDisposed()) return { ok: false, aborted: true };
    if (turnId) {
      useAppStore.getState().focusTurn({ sessionId, turnId, itemId });
    }
    return { ok: true, sessionId, turnId: turnId ?? null, itemId: itemId ?? null };
  }

  if (method === 'navigateToFile' || method === 'openFile' || method === 'file.navigate') {
    const rawPath = typeof params?.path === 'string' ? params.path : '';
    const lineRaw = params?.line;
    const line = typeof lineRaw === 'number' && Number.isFinite(lineRaw) && lineRaw > 0
      ? Math.floor(lineRaw)
      : undefined;
    const sessionId =
      typeof params?.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId.trim()
        : currentSession?.id;
    const workspaceId =
      typeof params?.workspaceId === 'string' && params.workspaceId.trim()
        ? params.workspaceId.trim()
        : undefined;
    return useAppStore.getState().navigateToFile({
      workspaceId,
      sessionId,
      path: rawPath,
      line,
      openInspector: params?.openInspector !== false,
      preserveSession: params?.preserveSession !== false,
    });
  }

  if (method === 'refreshSessions') {
    const { sessions } = await daemonApi.listSessions();
    if (!signal.aborted && !isDisposed()) {
      useAppStore.setState({ sessions });
    }
    return { sessions };
  }

  if (method === 'refreshWorkspaces') {
    const { workspaces } = await daemonApi.listWorkspaces();
    if (!signal.aborted && !isDisposed()) {
      useAppStore.setState({ workspaces });
    }
    return { workspaces };
  }

  if (method === 'session.switchHarness') {
    if (!currentSession || signal.aborted || isDisposed()) {
      throw Object.assign(new Error('当前会话不可用'), { code: 'E_SERVICE_UNAVAILABLE' });
    }
    const targetHarnessId = typeof params?.targetHarnessId === 'string' ? params.targetHarnessId.trim() : '';
    if (!store.harnesses.some((harness) => harness.id === targetHarnessId)) {
      throw Object.assign(new Error('目标 Harness 不存在'), { code: 'E_INVALID_INPUT' });
    }
    await store.switchHarness(currentSession.id, { targetHarnessId });
    return { ok: true };
  }

  if (method === 'switchInstance') {
    const targetInstanceId = typeof params?.instanceId === 'string' ? params.instanceId.trim() : '';
    if (!targetInstanceId) {
      throw Object.assign(new Error('缺少目标 instanceId'), { code: 'E_INVALID_INPUT' });
    }
    const contract = typeof params?.contract === 'string' ? params.contract.trim() : '';
    const targetSlotId =
      typeof params?.slotId === 'string' && params.slotId.trim() ? params.slotId.trim() : slotId;
    if (contract && store.selectedWorkspaceId && typeof store.setWorkspaceBinding === 'function') {
      await store.setWorkspaceBinding(store.selectedWorkspaceId, contract, targetInstanceId).catch(() => {});
    }
    if (!signal.aborted && !isDisposed()) {
      useAppStore.getState().setActivePluginPage(makeWorkspacePageKey(targetInstanceId, targetSlotId));
    }
    return { ok: true, instanceId: targetInstanceId, slotId: targetSlotId };
  }

  if (method === 'plugin.message') {
    const res = await daemonApi.sendPluginUiMessage(effectiveInstanceId, {
      slotId,
      slot,
      runId,
      sessionId: currentSession?.id ?? null,
      payload: params?.payload,
    });
    return res.result;
  }

  if (method === 'composer.setDraft') {
    if (!currentSession) {
      throw Object.assign(new Error('当前没有活动会话'), { code: 'E_NOT_SUPPORTED' });
    }
    const text = typeof params?.text === 'string' ? params.text.slice(0, 12_000) : '';
    store.setDraftText(currentSession.id, text);
    return { ok: true };
  }

  if (method === 'ui.toast') {
    const toastTitle = String(params?.title ?? '').trim().slice(0, 120);
    if (!toastTitle) {
      throw Object.assign(new Error('通知标题不能为空'), { code: 'E_INVALID_INPUT' });
    }
    const rawKind = params?.kind;
    const kind = rawKind === 'success' || rawKind === 'warning' || rawKind === 'error' ? rawKind : 'info';
    store.pushToast({
      kind,
      title: toastTitle,
      body: typeof params?.body === 'string' ? params.body.slice(0, 300) : undefined,
    });
    return { ok: true };
  }

  if (method === 'command.run') {
    if (!currentSession) {
      throw Object.assign(new Error('当前没有活动会话'), { code: 'E_NOT_SUPPORTED' });
    }
    const command = String(params?.command ?? '').trim();
    const args = typeof params?.args === 'string' ? params.args : '';
    return await store.runPluginAction(currentSession.id, {
      pluginId: getPluginInstanceId(
        store.plugins.find((p) => getPluginInstanceId(p) === effectiveInstanceId) ?? {
          id: pluginId,
          instanceId: effectiveInstanceId,
        } as Parameters<typeof getPluginInstanceId>[0],
      ),
      command,
      harnessId: currentSession.harnessId,
      args,
    });
  }

  throw Object.assign(new Error(`不支持的 UI 桥接方法: ${method}`), { code: 'E_NOT_SUPPORTED' });
}
