import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { DesktopViewFrame, DesktopViewInput, DesktopViewStatus } from '@harnessmate/plugin-api';

interface DesktopViewRecord {
  owner: WebContents;
  channel: 'desktop-view:event' | 'plugin-browser:event';
  guest: BrowserWindow;
  pluginId: string;
  instanceId: string;
  runId: string;
  timer?: ReturnType<typeof setTimeout>;
}

const KEY_CODES: Readonly<Record<string, number>> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  Left: 37, Right: 39, Up: 38, Down: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34,
};
const LIMIT = 8;

export interface DesktopViewKernelController {
  closeForOwner: (owner: WebContents) => void;
  destroyByInstance: (instanceId: string, runId?: string, message?: string) => void;
  handleCall: (
    event: IpcMainInvokeEvent,
    viewId: string,
    method: string,
    data?: unknown,
    channel?: 'desktop-view:event' | 'plugin-browser:event',
  ) => Promise<void>;
}

export function registerDesktopViewKernel(
  daemonPort: number,
  appUrl: string,
  trustedOwner: (event: IpcMainInvokeEvent) => boolean,
): DesktopViewKernelController {
  const views = new Map<string, DesktopViewRecord>();
  const opening = new Map<string, { owner: WebContents }>();
  const appPort = new URL(appUrl).port;

  const canLoad = (value: string, navigation: boolean) => {
    try {
      const url = new URL(value);
      if (navigation && !['http:', 'https:'].includes(url.protocol)) return false;
      if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
        return port !== String(daemonPort) && (!appPort || port !== appPort);
      }
      return !navigation && ['data:', 'blob:', 'about:'].includes(url.protocol);
    } catch {
      return false;
    }
  };

  const send = (
    owner: WebContents,
    channel: 'desktop-view:event' | 'plugin-browser:event',
    viewId: string,
    event: { frame: DesktopViewFrame } | { status: DesktopViewStatus },
  ) => {
    if (!owner.isDestroyed()) owner.send(channel, { viewId, ...event });
  };

  const destroyView = (viewId: string, message?: string) => {
    opening.delete(viewId);
    const view = views.get(viewId);
    if (!view) return;
    views.delete(viewId);
    clearTimeout(view.timer);
    if (!view.guest.isDestroyed()) view.guest.destroy();
    if (message) send(view.owner, view.channel, viewId, { status: { state: 'closed', message } });
  };

  async function authorize(instanceId: string, runId: string): Promise<void> {
    const response = await fetch(
      `http://127.0.0.1:${daemonPort}/api/v1/plugin-instances/${encodeURIComponent(instanceId)}/view-authorize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, permission: 'browser:preview' }),
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error || '桌面视图授权失败');
    }
  }

  function monitor(viewId: string, view: DesktopViewRecord): void {
    view.timer = setTimeout(() => {
      void authorize(view.instanceId, view.runId).then(() => {
        if (views.get(viewId) === view) monitor(viewId, view);
      }).catch((error: unknown) => {
        if (views.get(viewId) === view) destroyView(viewId, error instanceof Error ? error.message : String(error));
      });
    }, 2_000);
  }

  function createGuest(
    viewId: string,
    viewData: Omit<DesktopViewRecord, 'guest'>,
    width: number,
    height: number,
  ): DesktopViewRecord {
    const isolated = session.fromPartition(`hm-view-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    isolated.on('will-download', (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !canLoad(request.url, false) }));
    const guest = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      useContentSize: true,
      webPreferences: {
        session: isolated,
        offscreen: true,
        backgroundThrottling: false,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
        devTools: false,
        disableDialogs: true,
      },
    });
    guest.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.webContents.on('will-navigate', (event, url) => { if (!canLoad(url, true)) event.preventDefault(); });
    guest.webContents.on('will-redirect', (event, url) => { if (!canLoad(url, true)) event.preventDefault(); });
    guest.webContents.setFrameRate(12);
    guest.webContents.on('paint', (_event, _dirty, image) => {
      if (image.isEmpty() || !views.has(viewId)) return;
      const [w, h] = guest.getContentSize();
      send(viewData.owner, viewData.channel, viewId, {
        frame: {
          width: w!,
          height: h!,
          dataUrl: `data:image/jpeg;base64,${image.toJPEG(74).toString('base64')}`,
        },
      });
    });
    guest.webContents.on('did-start-loading', () => send(viewData.owner, viewData.channel, viewId, { status: { state: 'loading' } }));
    guest.webContents.on('did-finish-load', () => {
      send(viewData.owner, viewData.channel, viewId, { status: { state: 'ready', url: guest.webContents.getURL() } });
    });
    guest.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        send(viewData.owner, viewData.channel, viewId, { status: { state: 'error', url, message: description } });
      }
    });
    guest.webContents.on('render-process-gone', () => destroyView(viewId, '桌面视图渲染进程已退出'));
    guest.on('closed', () => destroyView(viewId, '桌面视图已关闭'));
    const view: DesktopViewRecord = { ...viewData, guest };
    views.set(viewId, view);
    monitor(viewId, view);
    return view;
  }

  async function handleInput(view: DesktopViewRecord, input: Partial<DesktopViewInput> | undefined) {
    const contents = view.guest.webContents;
    if (!input) throw new Error('缺少桌面视图输入');
    const inputDriver = contents.debugger;
    if (!inputDriver.isAttached()) inputDriver.attach('1.3');
    if (input.type === 'text' && typeof input.text === 'string') {
      await inputDriver.sendCommand('Input.insertText', { text: input.text.slice(0, 1000) });
      return;
    }
    if (input.type === 'key' && typeof input.key === 'string' && Object.hasOwn(KEY_CODES, input.key)) {
      const key = ['Left', 'Right', 'Up', 'Down'].includes(input.key) ? `Arrow${input.key}` : input.key;
      const params = { key, code: key, windowsVirtualKeyCode: KEY_CODES[input.key] };
      await inputDriver.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' });
      await inputDriver.sendCommand('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
      return;
    }
    if (input.type === 'click' || input.type === 'move' || input.type === 'wheel') {
      const [width, height] = view.guest.getContentSize();
      const x = Math.round(Number(input.x));
      const y = Math.round(Number(input.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width! || y >= height!) return;
      if (input.type === 'wheel') {
        await inputDriver.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX: Math.max(-1200, Math.min(1200, Number(input.deltaX) || 0)),
          deltaY: Math.max(-1200, Math.min(1200, Number(input.deltaY) || 0)),
        });
      } else if (input.type === 'click') {
        const params = { x, y, button: 'left', clickCount: 1 };
        await inputDriver.sendCommand('Input.dispatchMouseEvent', { ...params, type: 'mousePressed', buttons: 1 });
        await inputDriver.sendCommand('Input.dispatchMouseEvent', { ...params, type: 'mouseReleased', buttons: 0 });
      } else {
        await inputDriver.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      }
      return;
    }
    throw new Error('不支持的桌面视图输入');
  }

  const handleCall: DesktopViewKernelController['handleCall'] = async (
    event,
    viewId,
    method,
    data,
    channel = 'desktop-view:event',
  ) => {
    if (!trustedOwner(event) || typeof viewId !== 'string' || !/^[a-f0-9-]{36}$/.test(viewId)) {
      throw new Error('桌面视图仅在桌面主窗口可用');
    }
    let view = views.get(viewId);
    if (view && view.owner !== event.sender) throw new Error('桌面视图所有者不匹配');

    if (method === 'destroy' || method === 'close') {
      destroyView(viewId);
      return;
    }
    if (method === 'create' || method === 'mount' || method === 'open' || method === 'navigate') {
      if (opening.has(viewId)) throw new Error('桌面视图正在初始化');
      const payload = (data ?? {}) as {
        pluginId?: string;
        instanceId?: string;
        runId?: string;
        url?: string;
        width?: number;
        height?: number;
      };
      const pluginId = payload.pluginId ?? view?.pluginId ?? '';
      const instanceId = payload.instanceId ?? view?.instanceId ?? pluginId;
      const runId = payload.runId ?? view?.runId ?? '';
      const url = payload.url ?? '';
      if (
        typeof pluginId !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(pluginId)
        || typeof instanceId !== 'string' || !/^[a-z0-9._-]{2,96}$/.test(instanceId)
        || typeof runId !== 'string' || !runId || runId.length > 128
        || typeof url !== 'string' || url.length > 8192 || !canLoad(url, true)
      ) {
        throw new Error('请输入有效的 HTTP(S) 网址，HarnessMate 服务端口不可用于预览');
      }
      if (!view && views.size + opening.size >= LIMIT) throw new Error('桌面视图已达到同时开启上限');
      const owner = event.sender;
      const attempt = { owner };
      opening.set(viewId, attempt);
      try {
        await authorize(instanceId, runId);
        if (opening.get(viewId) !== attempt || owner.isDestroyed()) return;
        if (view && (view.instanceId !== instanceId || view.runId !== runId)) throw new Error('桌面视图实例已更新');
        const w = Math.max(240, Math.min(1600, Math.round(Number(payload.width) || 1000)));
        const h = Math.max(180, Math.min(1200, Math.round(Number(payload.height) || 650)));
        view ??= createGuest(viewId, { owner, channel, pluginId, instanceId, runId }, w, h);
        view.guest.setContentSize(w, h);
        void view.guest.webContents.loadURL(url).catch(() => {});
      } finally {
        if (opening.get(viewId) === attempt) opening.delete(viewId);
      }
      return;
    }

    if (!view) throw new Error('请先创建或挂载桌面视图');
    const contents = view.guest.webContents;
    if (method === 'resize') {
      const { width, height } = (data ?? {}) as { width?: number; height?: number };
      const w = Math.max(240, Math.min(1600, Math.round(Number(width) || 1000)));
      const h = Math.max(180, Math.min(1200, Math.round(Number(height) || 650)));
      view.guest.setContentSize(w, h);
      return;
    }
    if (method === 'focus') {
      contents.focus();
      return;
    }
    if (method === 'input') return handleInput(view, data as Partial<DesktopViewInput> | undefined);
    if (method === 'reload') contents.reload();
    else if (method === 'back') contents.navigationHistory.goBack();
    else if (method === 'forward') contents.navigationHistory.goForward();
    else throw new Error('不支持的桌面视图操作');
  };

  ipcMain.handle('desktop-view:call', (event, viewId: string, method: string, data?: unknown) =>
    handleCall(event, viewId, method, data, 'desktop-view:event'));

  return {
    handleCall,
    closeForOwner: (owner) => {
      for (const [id, attempt] of opening) if (attempt.owner === owner) opening.delete(id);
      for (const [id, view] of views) if (view.owner === owner) destroyView(id);
    },
    destroyByInstance: (instanceId, runId, message) => {
      for (const [id, view] of views) {
        if (view.instanceId === instanceId && (!runId || view.runId === runId)) {
          destroyView(id, message);
        }
      }
    },
  };
}
