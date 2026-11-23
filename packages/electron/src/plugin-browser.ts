import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { PluginBrowserFrame, PluginBrowserInput, PluginBrowserOptions, PluginBrowserStatus } from '@harnessmate/plugin-api';

interface Preview {
  owner: WebContents;
  guest: BrowserWindow;
  pluginId: string;
  runId: string;
  timer?: ReturnType<typeof setTimeout>;
}

const KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown']);
const LIMIT = 6;

export function registerPluginBrowser(
  daemonPort: number,
  appUrl: string,
  trustedOwner: (event: IpcMainInvokeEvent) => boolean,
): (owner: WebContents) => void {
  const previews = new Map<string, Preview>();
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

  const send = (owner: WebContents, viewId: string, event: { frame: PluginBrowserFrame } | { status: PluginBrowserStatus }) => {
    if (!owner.isDestroyed()) owner.send('plugin-browser:event', { viewId, ...event });
  };

  const close = (viewId: string, message?: string) => {
    opening.delete(viewId);
    const preview = previews.get(viewId);
    if (!preview) return;
    previews.delete(viewId);
    clearTimeout(preview.timer);
    if (!preview.guest.isDestroyed()) preview.guest.destroy();
    if (message) send(preview.owner, viewId, { status: { state: 'closed', message } });
  };

  async function authorize(pluginId: string, runId: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/plugins/${encodeURIComponent(pluginId)}/browser-authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error || '浏览器预览授权失败');
    }
  }

  function monitor(viewId: string, preview: Preview): void {
    preview.timer = setTimeout(() => {
      void authorize(preview.pluginId, preview.runId).then(() => {
        if (previews.get(viewId) === preview) monitor(viewId, preview);
      }).catch((error: unknown) => {
        if (previews.get(viewId) === preview) close(viewId, error instanceof Error ? error.message : String(error));
      });
    }, 2_000);
  }

  function createGuest(viewId: string, previewData: Omit<Preview, 'guest'>, width: number, height: number): Preview {
    const isolated = session.fromPartition(`hm-browser-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    isolated.on('will-download', (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !canLoad(request.url, false) }));
    const guest = new BrowserWindow({
      width, height, show: false, frame: false, useContentSize: true,
      webPreferences: {
        session: isolated, offscreen: true, backgroundThrottling: false, sandbox: true,
        nodeIntegration: false, contextIsolation: true, webviewTag: false, devTools: false,
        disableDialogs: true,
      },
    });
    guest.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.webContents.on('will-navigate', (event, url) => { if (!canLoad(url, true)) event.preventDefault(); });
    guest.webContents.on('will-redirect', (event, url) => { if (!canLoad(url, true)) event.preventDefault(); });
    guest.webContents.setFrameRate(12);
    guest.webContents.on('paint', (_event, _dirty, image) => {
      if (image.isEmpty() || !previews.has(viewId)) return;
      const [width, height] = guest.getContentSize();
      send(previewData.owner, viewId, { frame: {
        width: width!, height: height!, dataUrl: `data:image/jpeg;base64,${image.toJPEG(74).toString('base64')}`,
      } });
    });
    guest.webContents.on('did-start-loading', () => send(previewData.owner, viewId, { status: { state: 'loading' } }));
    guest.webContents.on('did-finish-load', () => {
      send(previewData.owner, viewId, { status: { state: 'ready', url: guest.webContents.getURL() } });
    });
    guest.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) send(previewData.owner, viewId, { status: { state: 'error', url, message: description } });
    });
    guest.webContents.on('render-process-gone', () => close(viewId, '浏览器渲染进程已退出'));
    guest.on('closed', () => close(viewId, '浏览器已关闭'));
    const preview = { ...previewData, guest };
    previews.set(viewId, preview);
    monitor(viewId, preview);
    return preview;
  }

  function handleInput(preview: Preview, input: Partial<PluginBrowserInput> | undefined) {
    const contents = preview.guest.webContents;
    if (!input) throw new Error('缺少浏览器输入');
    if (input.type === 'text' && typeof input.text === 'string') {
      return contents.insertText(input.text.slice(0, 1000));
    }
    if (input.type === 'key' && typeof input.key === 'string' && KEYS.has(input.key)) {
      contents.sendInputEvent({ type: 'keyDown', keyCode: input.key });
      contents.sendInputEvent({ type: 'keyUp', keyCode: input.key });
      return;
    }
    if (input.type === 'click' || input.type === 'move' || input.type === 'wheel') {
      const [width, height] = preview.guest.getContentSize();
      const x = Math.round(Number(input.x));
      const y = Math.round(Number(input.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width! || y >= height!) return;
      if (input.type === 'wheel') {
        contents.sendInputEvent({ type: 'mouseWheel', x, y,
          deltaX: Math.max(-1200, Math.min(1200, Number(input.deltaX) || 0)),
          deltaY: Math.max(-1200, Math.min(1200, Number(input.deltaY) || 0)),
        });
      } else if (input.type === 'click') {
        contents.focus();
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      } else {
        contents.sendInputEvent({ type: 'mouseMove', x, y });
      }
      return;
    }
    throw new Error('不支持的浏览器输入');
  }

  ipcMain.handle('plugin-browser:call', async (event, viewId: string, method: string, data?: unknown) => {
    if (!trustedOwner(event) || typeof viewId !== 'string' || !/^[a-f0-9-]{36}$/.test(viewId)) {
      throw new Error('浏览器预览仅在桌面主窗口可用');
    }
    let preview = previews.get(viewId);
    if (preview && preview.owner !== event.sender) throw new Error('浏览器预览所有者不匹配');
    if (method === 'close') { close(viewId); return; }
    if (method === 'open') {
      if (opening.has(viewId)) throw new Error('浏览器正在打开');
      const { pluginId, runId, url, width, height } = (data ?? {}) as PluginBrowserOptions & { pluginId: string; runId: string };
      if (typeof pluginId !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(pluginId) || typeof runId !== 'string' || runId.length > 128 ||
          typeof url !== 'string' || url.length > 8192 || !canLoad(url, true)) {
        throw new Error('请输入有效的 HTTP(S) 网址，HarnessMate 服务端口不可用于预览');
      }
      if (!preview && previews.size + opening.size >= LIMIT) throw new Error('浏览器预览已达到同时开启上限');
      const owner = event.sender;
      const attempt = { owner };
      opening.set(viewId, attempt);
      try {
        await authorize(pluginId, runId);
        if (opening.get(viewId) !== attempt || owner.isDestroyed()) return;
        if (preview && (preview.pluginId !== pluginId || preview.runId !== runId)) throw new Error('浏览器预览实例已更新');
        const w = Math.max(240, Math.min(1600, Math.round(Number(width) || 1000)));
        const h = Math.max(180, Math.min(1200, Math.round(Number(height) || 650)));
        preview ??= createGuest(viewId, { owner, pluginId, runId }, w, h);
        preview.guest.setContentSize(w, h);
        void preview.guest.webContents.loadURL(url).catch(() => {});
      } finally {
        if (opening.get(viewId) === attempt) opening.delete(viewId);
      }
      return;
    }
    if (!preview) throw new Error('请先打开浏览器预览');
    const contents = preview.guest.webContents;
    if (method === 'input') return handleInput(preview, data as Partial<PluginBrowserInput> | undefined);
    if (method === 'reload') contents.reload();
    else if (method === 'back') contents.navigationHistory.goBack();
    else if (method === 'forward') contents.navigationHistory.goForward();
    else throw new Error('不支持的浏览器操作');
  });

  return (owner) => {
    for (const [id, attempt] of opening) if (attempt.owner === owner) opening.delete(id);
    for (const [id, preview] of previews) if (preview.owner === owner) close(id);
  };
}
