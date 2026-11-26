import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const requires = ['ui.workspace.pages'];

export async function apply(ctx, config = {}) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerScript = path.join(__dirname, 'backend-worker.mjs');
  const storageRoot = typeof config.storageDir === 'string' && config.storageDir.trim()
    ? config.storageDir.trim()
    : path.join(os.tmpdir(), 'hm-headless-browser', ctx.instanceId.replace(/[^a-z0-9._-]/gi, '_'));
  fs.mkdirSync(storageRoot, { recursive: true });

  const worker = spawn(process.execPath, [workerScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HM_INSTANCE_ID: ctx.instanceId,
      HM_HEADLESS_STORAGE_DIR: storageRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  ctx.effect(() => () => {
    try { worker.kill('SIGKILL'); } catch {}
  });

  const readyInfo = await new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('无头浏览器后端启动超时')), 4000);
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    worker.stdout.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.port === 'number') {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {}
      }
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`无头浏览器后端意外退出 (${code}): ${stderr}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${readyInfo.port}`;

  async function callWorker(endpoint, method = 'GET', body = undefined) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `无头浏览器后端请求失败 (${res.status})`);
    return data;
  }

  ctx.provide(
    'browser.v1',
    {
      getInfo() {
        return {
          kind: 'headless',
          pluginId: ctx.pluginId,
          instanceId: ctx.instanceId,
          runId: ctx.runId,
          workerPid: readyInfo.pid,
          workerPort: readyInfo.port,
          title: '无头浏览器',
        };
      },
      open: (url, sessionId = null) => callWorker('/navigate', 'POST', { url, sessionId }),
      navigate: (url, sessionId = null) => callWorker('/navigate', 'POST', { url, sessionId }),
      input: (text) => callWorker('/input', 'POST', { text }),
      back: () => callWorker('/back', 'POST', {}),
      forward: () => callWorker('/forward', 'POST', {}),
      reload: () => callWorker('/reload', 'POST', {}),
      getState: () => callWorker('/state', 'GET'),
      close: () => callWorker('/close', 'POST', {}),
    },
    {
      version: '1.0.0',
      metadata: { kind: 'headless', title: '无头浏览器', workerPid: readyInfo.pid, workerPort: readyInfo.port },
    },
  );

  ctx.routes.register('/state', async () => {
    const data = await callWorker('/state', 'GET');
    return {
      status: 200,
      body: {
        ...data,
        kind: 'headless',
        pluginId: ctx.pluginId,
        instanceId: ctx.instanceId,
        runId: ctx.runId,
        workerPort: readyInfo.port,
      },
    };
  });

  ctx.slots.register({
    slot: 'workspace.pages',
    id: 'headless-browser',
    title: '无头浏览器',
    ui: 'ui/panel.html',
    order: 20,
    async onMessage(payload, meta) {
      if (!payload || typeof payload !== 'object') return { error: '无效请求' };
      switch (payload.type) {
        case 'getState':
          return callWorker('/state', 'GET');
        case 'navigate':
          return callWorker('/navigate', 'POST', { url: payload.url, sessionId: meta?.sessionId ?? null });
        case 'input':
          return callWorker('/input', 'POST', { text: payload.text });
        case 'back':
          return callWorker('/back', 'POST', {});
        case 'forward':
          return callWorker('/forward', 'POST', {});
        case 'reload':
          return callWorker('/reload', 'POST', {});
        case 'close':
          return callWorker('/close', 'POST', {});
        default:
          return { error: '未知无头浏览器操作' };
      }
    },
  });

  ctx.logger.info('无头浏览器后端已启动', { instanceId: ctx.instanceId, pid: readyInfo.pid, port: readyInfo.port });
}
