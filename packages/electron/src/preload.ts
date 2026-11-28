import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopMenuContributionDto,
  DesktopViewFrame,
  DesktopViewStatus,
  PluginBrowserFrame,
  PluginBrowserStatus,
} from '@harnessmate/plugin-api';

const daemonPort = process.env.HARNESSMATE_PORT || '4789';

contextBridge.exposeInMainWorld('harnessMateBridge', {
  daemonUrl: `http://127.0.0.1:${daemonPort}`,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  notify: (title: string, body: string): void => {
    ipcRenderer.send('desktop:notify', { title, body });
  },
  restartApp: (options?: { safeMode?: boolean }): Promise<{ ok?: boolean; reason?: string }> =>
    ipcRenderer.invoke('desktop:restartApp', options ?? {}),
  menu: {
    syncContributions: (items: DesktopMenuContributionDto[]): void => {
      ipcRenderer.send('desktop:setMenuContributions', items);
    },
    onInvoke: (
      listener: (payload: { key: string; ownerInstanceId: string; ownerRunId: string }) => void,
    ) => {
      const dispatch = (
        _event: Electron.IpcRendererEvent,
        payload: { key: string; ownerInstanceId: string; ownerRunId: string },
      ) => {
        listener(payload);
      };
      ipcRenderer.on('desktop:menuInvoke', dispatch);
      return () => {
        ipcRenderer.off('desktop:menuInvoke', dispatch);
      };
    },
  },
  desktopView: {
    call: (viewId: string, method: string, data?: unknown): Promise<void> =>
      ipcRenderer.invoke('desktop-view:call', viewId, method, data),
    subscribe: (viewId: string, listener: (payload: { frame: DesktopViewFrame } | { status: DesktopViewStatus }) => void) => {
      const dispatch = (_event: Electron.IpcRendererEvent, payload: { viewId: string } & ({ frame: DesktopViewFrame } | { status: DesktopViewStatus })) => {
        if (payload.viewId === viewId) listener('frame' in payload ? { frame: payload.frame } : { status: payload.status });
      };
      ipcRenderer.on('desktop-view:event', dispatch);
      return () => { ipcRenderer.off('desktop-view:event', dispatch); };
    },
  },
  pluginBrowser: {
    call: (viewId: string, method: string, data?: unknown): Promise<void> =>
      ipcRenderer.invoke('plugin-browser:call', viewId, method, data),
    subscribe: (viewId: string, listener: (payload: { frame: PluginBrowserFrame } | { status: PluginBrowserStatus }) => void) => {
      const dispatch = (_event: Electron.IpcRendererEvent, payload: { viewId: string } & ({ frame: PluginBrowserFrame } | { status: PluginBrowserStatus })) => {
        if (payload.viewId === viewId) listener('frame' in payload ? { frame: payload.frame } : { status: payload.status });
      };
      ipcRenderer.on('plugin-browser:event', dispatch);
      return () => { ipcRenderer.off('plugin-browser:event', dispatch); };
    },
  },
});
