import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { registerPluginBrowser } from './plugin-browser';

const DAEMON_PORT = Number(process.env.HARNESSMATE_PORT || 4789);
const DEV_WEB_URL = process.env.HARNESSMATE_DEV_URL || 'http://127.0.0.1:5173';
const IS_DEV = process.env.HARNESSMATE_DEV === '1';
const SAFE_MODE = process.argv.includes('--safe-mode');
const APP_URL = IS_DEV ? DEV_WEB_URL : `http://127.0.0.1:${DAEMON_PORT}`;

// Enforce single instance so re-launching the .exe brings the existing tray/window to focus
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let daemonProcess: ChildProcess | null = null;
let isQuitting = false;

function isAppPage(value: string): boolean {
  try {
    const current = new URL(value);
    const start = new URL(APP_URL);
    return current.origin === start.origin && current.pathname === start.pathname;
  } catch { return false; }
}

function trustedOwner(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame &&
    isAppPage(event.senderFrame?.url ?? '');
}

const closePluginBrowsers = registerPluginBrowser(DAEMON_PORT, APP_URL, trustedOwner);

function resolveDaemonEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'daemon', 'daemon.cjs');
  }
  const staged = path.resolve(__dirname, '../resources/daemon/daemon.cjs');
  if (fs.existsSync(staged)) {
    return staged;
  }
  return path.resolve(__dirname, '../../daemon/dist/index.js');
}

function resolveWebDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'web-dist');
  }
  const staged = path.resolve(__dirname, '../resources/web-dist');
  if (fs.existsSync(staged)) {
    return staged;
  }
  return path.resolve(__dirname, '../../web/dist');
}

function resolveAppIconPath(): string | null {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'build', 'icon.png'),
        path.join(process.resourcesPath, 'icon.png'),
      ]
    : [path.resolve(__dirname, '../build/icon.png')];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function checkDaemonHealth(): Promise<{ ok: boolean; daemonVersion?: string; pluginSafeMode?: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/v1/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { daemonVersion?: string; pluginSafeMode?: boolean };
    return { ok: true, daemonVersion: data.daemonVersion, pluginSafeMode: data.pluginSafeMode };
  } catch {
    return { ok: false };
  }
}

async function ensureDaemonRunning(): Promise<void> {
  const expectedVersion = app.getVersion();
  const matches = (health: Awaited<ReturnType<typeof checkDaemonHealth>>) =>
    health.ok && health.daemonVersion === expectedVersion && Boolean(health.pluginSafeMode) === SAFE_MODE;
  const existing = await checkDaemonHealth();
  if (existing.ok) {
    if (matches(existing)) return;
    try {
      await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/v1/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      // ignore if older daemon has no /shutdown endpoint
    }
    for (let i = 0; i < 15; i++) {
      if (!(await checkDaemonHealth()).ok) break;
      if (i === 14) throw new Error('HarnessMate 后台仍在运行，请从托盘退出后重新打开。');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const entry = resolveDaemonEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`Daemon build output not found at ${entry}.`);
  }

  const webDist = resolveWebDistDir();
  let stderrLog = '';

  daemonProcess = spawn(process.execPath, ['--no-warnings', entry, ...(SAFE_MODE ? ['--safe-mode'] : [])], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HARNESSMATE_APP_VERSION: expectedVersion,
      HARNESSMATE_PORT: String(DAEMON_PORT),
      ...(fs.existsSync(webDist) ? { HARNESSMATE_WEB_DIST: webDist } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  daemonProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrLog += text;
    if (stderrLog.length > 4000) stderrLog = stderrLog.slice(-4000);
    process.stderr.write(`[daemon] ${text}`);
  });

  for (let i = 0; i < 60; i++) {
    const h = await checkDaemonHealth();
    if (matches(h)) return;
    if (daemonProcess.exitCode !== null) {
      throw new Error(
        `HarnessMate daemon exited prematurely (code=${daemonProcess.exitCode}).\n${stderrLog}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for HarnessMate daemon on port ${DAEMON_PORT}.\n${stderrLog}`);
}

function killDaemonProcess(): void {
  if (!daemonProcess || daemonProcess.exitCode !== null) return;
  const pid = daemonProcess.pid;
  if (process.platform === 'win32' && pid) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    daemonProcess.kill('SIGTERM');
  }
}

function showOrCreateWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createWindow(): void {
  const iconPath = resolveAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#080a10',
    title: 'HarnessMate Desktop',
    ...(iconPath ? { icon: iconPath } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && new URL(url).origin !== new URL(APP_URL).origin) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => { if (!isAppPage(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isAppPage(url)) event.preventDefault(); });
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) closePluginBrowsers(contents);
  });
  contents.on('destroyed', () => closePluginBrowsers(contents));
  contents.on('render-process-gone', () => closePluginBrowsers(contents));
  void mainWindow.loadURL(APP_URL);

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function restartInMode(safeMode: boolean): void {
  const args = process.argv.slice(1).filter((arg) => arg !== '--safe-mode');
  if (safeMode) args.push('--safe-mode');
  app.relaunch({ args });
  app.quit();
}

function createTray(): void {
  const iconPath = resolveAppIconPath();
  let trayImage = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (trayImage.isEmpty()) {
    const svgIcon = `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="8" fill="#121623"/>
        <path d="M16 5L18.5 13.5L27 16L18.5 18.5L16 27L13.5 18.5L5 16L13.5 13.5L16 5Z" fill="#f3c158"/>
      </svg>`,
    ).toString('base64')}`;
    trayImage = nativeImage.createFromDataURL(svgIcon);
  } else {
    trayImage = trayImage.resize({ width: 16, height: 16 });
  }

  tray = new Tray(trayImage);
  tray.setToolTip('HarnessMate Desktop — 多 Harness 守护服务运行中');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 HarnessMate 窗口',
        click: () => showOrCreateWindow(),
      },
      {
        label: SAFE_MODE ? '重新正常启动' : '重新以安全模式启动',
        click: () => restartInMode(!SAFE_MODE),
      },
      { type: 'separator' },
      {
        label: '退出 HarnessMate（停止后台守护）',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );

  tray.on('double-click', () => showOrCreateWindow());
  tray.on('click', () => showOrCreateWindow());
}

ipcMain.handle('dialog:pickDirectory', async (event) => {
  if (!trustedOwner(event)) return null;
  const win = mainWindow ?? BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win ?? undefined!, {
    properties: ['openDirectory'],
    title: '选择本地项目工作区',
  });
  return res.canceled ? null : res.filePaths[0] ?? null;
});

ipcMain.handle('shell:openExternal', async (event, url: string) => {
  if (trustedOwner(event) && typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

ipcMain.on('desktop:notify', (event, payload: { title: string; body: string }) => {
  if (trustedOwner(event) && Notification.isSupported()) {
    new Notification({ title: payload.title, body: payload.body }).show();
  }
});

app.on('second-instance', (_event, args) => {
  if (!SAFE_MODE && args.includes('--safe-mode') && !isQuitting) {
    restartInMode(true);
    return;
  }
  showOrCreateWindow();
});

app.whenReady().then(async () => {
  try {
    await ensureDaemonRunning();
    createTray();
    createWindow();
  } catch (err) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'HarnessMate Desktop 启动失败',
      message: err instanceof Error ? err.message : String(err),
      buttons: SAFE_MODE ? ['退出'] : ['退出', '以安全模式启动'],
      cancelId: 0,
    });
    if (!SAFE_MODE && response === 1) { restartInMode(true); return; }
    isQuitting = true;
    killDaemonProcess();
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  killDaemonProcess();
});

app.on('activate', () => {
  showOrCreateWindow();
});
