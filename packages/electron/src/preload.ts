import { contextBridge, ipcRenderer } from 'electron';
import type { PluginBrowserFrame, PluginBrowserStatus } from '@harnessmate/plugin-api';

const daemonPort = process.env.HARNESSMATE_PORT || '4789';

contextBridge.exposeInMainWorld('harnessMateBridge', {
  daemonUrl: `http://127.0.0.1:${daemonPort}`,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  notify: (title: string, body: string): void => {
    ipcRenderer.send('desktop:notify', { title, body });
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
