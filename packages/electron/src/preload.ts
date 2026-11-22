import { contextBridge, ipcRenderer } from 'electron';

const daemonPort = process.env.HARNESSMATE_PORT || '4789';

contextBridge.exposeInMainWorld('harnessMateBridge', {
  daemonUrl: `http://127.0.0.1:${daemonPort}`,
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  notify: (title: string, body: string): void => {
    ipcRenderer.send('desktop:notify', { title, body });
  },
});
