import type {
  ImportSessionBundleRequest,
  NavigationRequestV1,
  Session,
  UiContributionKind,
} from '@harnessmate/protocol';
import { ApiHttpError, daemonApi, getDaemonBaseUrl } from '../api/client';
import {
  getPluginInstanceId,
  resolveServiceSelectionClientSide,
  type NavigateToFileResult,
} from '../api/peer-contracts';
import { defaultPeerWorkspaceTransport } from '../api/peer-workspace-client';
import { contributionRegistry } from '../kernel/contribution-registry';
import { layoutBridge } from '../kernel/layout-bridge';
import { navigationBus } from '../kernel/navigation-bus';
import { kernelRecoveryClient } from '../kernel/recovery-client';
import { useKernelStore } from '../stores/kernel-store';
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
 * Executes host-side RPC methods invoked by a plugin iframe or trusted module via `window.harnessMate`.
 * Depends only on kernel state, public navigation bus, UI contribution registry, and public daemon APIs —
 * never on the monolithic host app-store.
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
  const kernel = useKernelStore.getState();
  const layout = layoutBridge.getState();

  if (method === 'presentation.publish') {
    if (JSON.stringify(params).length > 65536) throw new Error('页面投影超过 64 KiB');
    if (!signal.aborted && !isDisposed()) {
      window.dispatchEvent(
        new CustomEvent('hm:presentation', {
          detail: { instanceId: effectiveInstanceId, sessionId: currentSession?.id, ...params },
        }),
      );
    }
    return {};
  }

  if (method === 'ui.navigate') {
    const req: NavigationRequestV1 = {
      requestId: typeof params?.requestId === 'string' ? params.requestId : undefined,
      target:
        params?.target && typeof params.target === 'object'
          ? (params.target as NavigationRequestV1['target'])
          : {},
      context:
        params?.context && typeof params.context === 'object'
          ? (params.context as Record<string, unknown>)
          : undefined,
      placement: typeof params?.placement === 'string' ? params.placement : undefined,
      sourceInstanceId: effectiveInstanceId,
      sourceRunId: runId,
    };
    return navigationBus.navigate(req);
  }

  if (method === 'contributions.list') {
    const rawKind = params?.kind;
    const kind =
      typeof rawKind === 'string'
        ? (rawKind as UiContributionKind)
        : Array.isArray(rawKind)
          ? (rawKind as UiContributionKind[])
          : undefined;
    const items = contributionRegistry.query({
      kind,
      target: typeof params?.target === 'string' ? params.target : undefined,
      ownerInstanceId: typeof params?.ownerInstanceId === 'string' ? params.ownerInstanceId : undefined,
      enabledOnly: params?.enabledOnly !== false,
    });
    return {
      items: items.map(({ execute: _exec, ...serializable }) => serializable),
    };
  }

  if (method === 'contributions.execute') {
    const keyOrId = typeof params?.key === 'string' ? params.key : typeof params?.id === 'string' ? params.id : '';
    if (!keyOrId) {
      throw Object.assign(new Error('缺少贡献项 ID'), { code: 'E_INVALID_INPUT' });
    }
    return contributionRegistry.execute(keyOrId, {
      sourceInstanceId: effectiveInstanceId,
      args:
        params?.args && typeof params.args === 'object'
          ? (params.args as Record<string, unknown>)
          : undefined,
    });
  }

  if (method === 'kernel.snapshot') {
    return {
      theme: kernel.theme,
      connected: kernel.connected,
      emptyComposition: kernel.emptyComposition,
      plugins: kernel.plugins,
      compositionBindings: kernel.compositionBindings,
      compositionEntries: kernel.compositionEntries,
      workspaceBindingsByWorkspace: kernel.workspaceBindingsByWorkspace,
      sessionBindingsBySession: kernel.sessionBindingsBySession,
      restartStatus: kernel.restartStatus,
    };
  }

  if (method === 'kernel.switchApplication') {
    const instanceId =
      params?.instanceId === null
        ? null
        : typeof params?.instanceId === 'string' && params.instanceId.trim()
          ? params.instanceId.trim()
          : null;
    return kernel.switchApplicationEntry(instanceId, {
      requiresRestart: Boolean(params?.requiresRestart),
      restartReason: typeof params?.restartReason === 'string' ? params.restartReason : undefined,
    });
  }

  if (method === 'kernel.setCompositionBinding') {
    const contract = typeof params?.contract === 'string' ? params.contract.trim() : '';
    if (!contract) throw Object.assign(new Error('缺少服务契约 contract'), { code: 'E_INVALID_INPUT' });
    const instanceId = typeof params?.instanceId === 'string' && params.instanceId.trim() ? params.instanceId.trim() : null;
    await kernel.setCompositionBinding(contract, instanceId);
    return { ok: true };
  }

  if (method === 'kernel.requestRestart') {
    return kernelRecoveryClient.requestRestart({
      safeMode: Boolean(params?.safeMode),
    });
  }

  if (method === 'application.publishState') {
    if (slot !== 'application.shell') {
      throw Object.assign(new Error('只有应用布局根插件可发布布局状态'), { code: 'E_PERMISSION_DENIED' });
    }
    const patch =
      params?.patch && typeof params.patch === 'object'
        ? (params.patch as Record<string, unknown>)
        : {};
    return { ok: layoutBridge.publishState({ instanceId: effectiveInstanceId, runId, pluginId }, patch) };
  }

  if (method === 'shell.snapshot') return shellSnapshot();
  if (method === 'shell.invoke') {
    return invokeShell(String(params?.name ?? ''), Array.isArray(params?.args) ? params.args : []);
  }
  if (method === 'clipboard.writeText') return navigator.clipboard.writeText(String(params?.text ?? ''));
  if (method === 'files.download') {
    const filename = String(params?.filename ?? 'export.txt').split(/[\\/]/).at(-1) || 'export.txt';
    const blob = new Blob([String(params?.text ?? '')], { type: String(params?.mime ?? 'text/plain') });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename };
  }
  if (method === 'transport.resource') {
    const path = String(params?.path ?? '');
    if (!path.startsWith('/api/v1/') || path.includes('..') || path.includes('\\')) {
      throw new Error('需要本机公开资源路径');
    }
    const response = await fetch(`${getDaemonBaseUrl()}${path}`, { signal });
    if (!response.ok) throw new Error(`读取资源失败: ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size > 16 * 1024 * 1024) {
      throw new Error('需要 16 MiB 以内图片资源');
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
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
    return daemonApi.request(path, {
      signal,
      method: typeof params?.method === 'string' ? params.method : 'GET',
      body: typeof params?.body === 'string' ? params.body : undefined,
    });
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
        : typeof layout.selectedWorkspaceId === 'string'
          ? layout.selectedWorkspaceId
          : undefined;
    const sId =
      typeof params?.sessionId === 'string'
        ? params.sessionId
        : currentSession?.id ?? undefined;
    return await defaultPeerWorkspaceTransport.resolveServiceSelection(contract, {
      workspaceId: wsId,
      sessionId: sId,
      explicitInstanceId:
        typeof params?.explicitInstanceId === 'string' ? params.explicitInstanceId : undefined,
      plugins: kernel.plugins,
      sessionBindings: sId ? kernel.sessionBindingsBySession[sId] : undefined,
      workspaceBindings: wsId ? kernel.workspaceBindingsByWorkspace[wsId] : undefined,
      compositionBindings: kernel.compositionBindings,
      compositionEntries: kernel.compositionEntries,
      signal,
    });
  }

  if (method === 'plugins.list') {
    return {
      plugins: kernel.plugins,
      workspaces: Array.isArray(layout.workspaces) ? layout.workspaces : [],
      harnesses: Array.isArray(layout.harnesses) ? layout.harnesses : [],
      sessions: Array.isArray(layout.sessions) ? layout.sessions : [],
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
    if (res.session?.id) {
      await contributionRegistry.execute('layout.syncSessions', {
        sourceInstanceId: effectiveInstanceId,
        args: { sessionId: res.session.id },
      }).catch(() => {});
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
    if (signal.aborted || isDisposed()) return { ok: false, aborted: true };
    const navResult = await navigationBus.navigate({
      target: { kind: 'session' },
      context: {
        sessionId,
        turnId,
        itemId,
        workspaceId,
        closeWorkspace: params?.closeWorkspace !== false,
        signal,
      },
      placement: params?.closeWorkspace === false ? 'keep-page' : 'primary',
      sourceInstanceId: effectiveInstanceId,
      sourceRunId: runId,
    });
    if (signal.aborted || isDisposed()) return { ok: false, aborted: true };
    if (navResult.status === 'accepted') {
      return {
        ok: true,
        sessionId,
        turnId: turnId ?? null,
        itemId: itemId ?? null,
      };
    }
    return {
      ok: false,
      status: navResult.status,
      code: navResult.code,
      message: navResult.message,
      sessionId,
      turnId: turnId ?? null,
      itemId: itemId ?? null,
    };
  }

  if (method === 'navigateToFile' || method === 'openFile' || method === 'file.navigate') {
    const rawPath = typeof params?.path === 'string' ? params.path : '';
    const lineRaw = params?.line;
    const line =
      typeof lineRaw === 'number' && Number.isFinite(lineRaw) && lineRaw > 0
        ? Math.floor(lineRaw)
        : undefined;
    const colRaw = params?.column;
    const column =
      typeof colRaw === 'number' && Number.isFinite(colRaw) && colRaw > 0
        ? Math.floor(colRaw)
        : undefined;
    const sessionId =
      typeof params?.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId.trim()
        : currentSession?.id;
    const workspaceId =
      typeof params?.workspaceId === 'string' && params.workspaceId.trim()
        ? params.workspaceId.trim()
        : undefined;
    const navResult = await navigationBus.navigate({
      target: { kind: 'file', uri: rawPath },
      context: {
        workspaceId,
        sessionId,
        path: rawPath,
        line,
        column,
        openInspector: params?.openInspector !== false,
        preserveSession: params?.preserveSession !== false,
      },
      placement: 'side',
      sourceInstanceId: effectiveInstanceId,
      sourceRunId: runId,
    });
    if (navResult.detail && typeof navResult.detail.opened === 'boolean') {
      return navResult.detail as unknown as NavigateToFileResult;
    }
    return {
      opened: navResult.status === 'accepted',
      sessionId: sessionId ?? null,
      workspaceId: workspaceId ?? null,
      path: rawPath,
      line,
      column,
      ...(navResult.code ? { errorCode: navResult.code } : {}),
      ...(navResult.message ? { message: navResult.message } : {}),
    } satisfies NavigateToFileResult;
  }

  if (method === 'refreshSessions') {
    const { sessions } = await daemonApi.listSessions();
    if (!signal.aborted && !isDisposed()) {
      await contributionRegistry
        .execute('layout.syncSessions', {
          sourceInstanceId: effectiveInstanceId,
          args: { sessions },
        })
        .catch(() => {});
    }
    return { sessions };
  }

  if (method === 'refreshWorkspaces') {
    const { workspaces } = await daemonApi.listWorkspaces();
    if (!signal.aborted && !isDisposed()) {
      await contributionRegistry
        .execute('layout.syncWorkspaces', {
          sourceInstanceId: effectiveInstanceId,
          args: { workspaces },
        })
        .catch(() => {});
    }
    return { workspaces };
  }

  if (method === 'session.switchHarness') {
    if (!currentSession || signal.aborted || isDisposed()) {
      throw Object.assign(new Error('当前会话不可用'), { code: 'E_SERVICE_UNAVAILABLE' });
    }
    const targetHarnessId = typeof params?.targetHarnessId === 'string' ? params.targetHarnessId.trim() : '';
    const harnesses = Array.isArray(layout.harnesses) ? (layout.harnesses as Array<{ id: string }>) : [];
    if (harnesses.length > 0 && !harnesses.some((harness) => harness.id === targetHarnessId)) {
      throw Object.assign(new Error('目标 Harness 不存在'), { code: 'E_INVALID_INPUT' });
    }
    await daemonApi.switchHarness(currentSession.id, { targetHarnessId });
    await contributionRegistry
      .execute('layout.syncSessions', { sourceInstanceId: effectiveInstanceId })
      .catch(() => {});
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
    const selectedWorkspaceId =
      typeof layout.selectedWorkspaceId === 'string' ? layout.selectedWorkspaceId : null;
    if (contract && selectedWorkspaceId) {
      await kernel.setWorkspaceBinding(selectedWorkspaceId, contract, targetInstanceId).catch(() => {});
    }
    if (!signal.aborted && !isDisposed()) {
      await navigationBus.navigate({
        target: {
          kind: 'page',
          instanceId: targetInstanceId,
          pageId: targetSlotId,
          slotId: targetSlotId,
          contract: contract || undefined,
        },
        placement: 'primary',
        sourceInstanceId: effectiveInstanceId,
        sourceRunId: runId,
      });
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
    const selected = resolveServiceSelectionClientSide({
      contract: 'chat.view.v1',
      plugins: kernel.plugins,
      sessionBindings: kernel.sessionBindingsBySession[currentSession.id],
      workspaceBindings: kernel.workspaceBindingsByWorkspace[currentSession.workspaceId],
      compositionBindings: kernel.compositionBindings,
      compositionEntries: kernel.compositionEntries,
    });
    const chatPlugin = kernel.plugins.find((p) => getPluginInstanceId(p) === selected.instanceId);
    if (selected.status !== 'ready' || !selected.instanceId || !chatPlugin) {
      throw Object.assign(new Error('聊天插件不可用'), { code: 'E_SERVICE_UNAVAILABLE' });
    }
    await daemonApi.callUiService(
      selected.instanceId,
      {
        runId: chatPlugin.runId ?? chatPlugin.packageDigest,
        contract: 'chat.view.v1',
        method: 'editViewState',
        instanceId: selected.instanceId,
        sessionId: currentSession.id,
        args: [{ sessionId: currentSession.id, operation: { type: 'setText', text } }],
      },
      signal,
    );
    return { ok: true };
  }

  if (method === 'ui.toast') {
    const toastTitle = String(params?.title ?? '').trim().slice(0, 120);
    if (!toastTitle) {
      throw Object.assign(new Error('通知标题不能为空'), { code: 'E_INVALID_INPUT' });
    }
    const rawKind = params?.kind;
    const kind = rawKind === 'success' || rawKind === 'warning' || rawKind === 'error' ? rawKind : 'info';
    layoutBridge.pushToast({
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
    const pluginTarget = getPluginInstanceId(
      kernel.plugins.find((p) => getPluginInstanceId(p) === effectiveInstanceId) ??
        ({
          id: pluginId,
          instanceId: effectiveInstanceId,
        } as Parameters<typeof getPluginInstanceId>[0]),
    );
    return await daemonApi.runPluginAction(currentSession.id, {
      pluginId: pluginTarget,
      command,
      harnessId: currentSession.harnessId,
      args,
    });
  }

  throw Object.assign(new Error(`不支持的 UI 桥接方法: ${method}`), { code: 'E_NOT_SUPPORTED' });
}
