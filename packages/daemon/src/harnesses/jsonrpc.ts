import type { ChildProcess } from 'node:child_process';
import { ResilientJsonLineParser, killProcessTree } from './process.js';

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface JsonRpcHandlers {
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (req: JsonRpcServerRequest) => void;
  onDiagnostic: (stream: 'stdout' | 'stderr' | 'protocol', message: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class StdioJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly parser: ResilientJsonLineParser;
  private disposed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: JsonRpcHandlers,
  ) {
    this.parser = new ResilientJsonLineParser(
      (msg) => this.handleMessage(msg),
      (noise) => this.handlers.onDiagnostic('stdout', noise),
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      this.parser.feed(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            this.handlers.onDiagnostic('stderr', line.trim());
          }
        }
      }
    });

    child.on('error', (err) => {
      this.handlers.onDiagnostic('protocol', `Process error: ${err.message}`);
      this.rejectAllPending(err);
    });

    child.on('close', (code, signal) => {
      this.parser.flush();
      this.rejectAllPending(new Error(`CLI process exited (code=${code}, signal=${signal})`));
      this.handlers.onExit(code, signal);
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error(`JSON-RPC client disposed before calling ${method}`));
    }
    const id = this.nextId++;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(key, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });

      this.writeLine({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.writeLine({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  respond(id: string | number, result: unknown): void {
    if (this.disposed) return;
    this.writeLine({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  respondError(id: string | number, code: number, message: string): void {
    if (this.disposed) return;
    this.writeLine({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending(new Error('JSON-RPC client disposed'));
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    await killProcessTree(this.child);
  }

  private writeLine(payload: Record<string, unknown>): void {
    if (!this.child.stdin || this.child.stdin.destroyed) {
      this.handlers.onDiagnostic('protocol', 'Cannot write to CLI stdin (stream closed)');
      return;
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === 'string';

    // Response to our outgoing request
    if (hasId && !hasMethod) {
      const key = String(msg.id);
      const entry = this.pending.get(key);
      if (!entry) return;
      this.pending.delete(key);
      clearTimeout(entry.timer);

      if (msg.error && typeof msg.error === 'object') {
        const errObj = msg.error as { message?: string; code?: number };
        entry.reject(
          new Error(errObj.message || `JSON-RPC error (${errObj.code ?? 'unknown'}) on ${entry.method}`),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Incoming Server Request (needs response, e.g., tool permission approval)
    if (hasId && hasMethod) {
      this.handlers.onServerRequest({
        id: msg.id as string | number,
        method: msg.method as string,
        params: msg.params,
      });
      return;
    }

    // Incoming Server Notification
    if (hasMethod) {
      this.handlers.onNotification(msg.method as string, msg.params);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [key, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(key);
    }
  }
}
