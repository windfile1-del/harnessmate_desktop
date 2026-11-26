import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { registerDesktopViewKernel } from './desktop-view';

/**
 * Compatibility bridge for legacy P1 `plugin-browser` IPC callers.
 * Delegates all view lifecycle, frame capture, and input routing to the generic desktop view kernel.
 */
export function registerPluginBrowser(
  daemonPort: number,
  appUrl: string,
  trustedOwner: (event: IpcMainInvokeEvent) => boolean,
): (owner: WebContents) => void {
  const kernel = registerDesktopViewKernel(daemonPort, appUrl, trustedOwner);
  ipcMain.handle('plugin-browser:call', (event, viewId: string, method: string, data?: unknown) =>
    kernel.handleCall(event, viewId, method, data, 'plugin-browser:event'));
  return kernel.closeForOwner;
}
