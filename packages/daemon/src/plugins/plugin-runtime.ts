import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const workerCode = `
  const { parentPort, workerData } = require('node:worker_threads');
  const runtime = import(workerData).then(module => module.default ?? module);
  parentPort.on('message', async ({ id, method, input }) => {
    try {
      const plugin = await runtime;
      const supported = ['beforeTurn', 'onEvent'].filter(name => typeof plugin[name] === 'function');
      const result = method === 'initialize' ? supported
        : method === 'beforeTurn' ? await plugin.beforeTurn(input)
        : await plugin.onEvent(input);
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.message ?? error).slice(0, 1000) });
    }
  });
`;

export class PluginRuntime {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private retired = false;
  failed = false;
  hooks: string[] = [];

  constructor(file: string, private readonly onFailure: (error: Error) => void) {
    this.worker = new Worker(workerCode, {
      eval: true,
      workerData: pathToFileURL(file).href,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on('message', ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
      if (this.retired && this.pending.size === 0) void this.worker.terminate();
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.retired) this.fail(new Error(`插件运行线程已退出 (${code})`));
    });
    this.worker.unref();
  }

  async initialize() {
    this.hooks = await this.request('initialize', null, 2500) as string[];
  }

  request(method: 'initialize' | 'beforeTurn' | 'onEvent', input: unknown, timeout = 800): Promise<unknown> {
    if (this.failed || this.retired) return Promise.reject(new Error('插件运行线程不可用'));
    if (this.pending.size >= 8) return Promise.reject(new Error('插件运行线程繁忙'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`插件 ${method} 超时`)), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, method, input });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  retire(): void {
    this.retired = true;
    if (this.pending.size === 0) void this.worker.terminate();
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    void this.worker.terminate();
    if (!this.retired) this.onFailure(error);
  }
}
