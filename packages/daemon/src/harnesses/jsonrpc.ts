import type { ChildProcess } from 'node:child_process';
import { ResilientJsonLineParser, killProcessTree } from './process.js';

export class JsonRpcResponseError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(message: string, code?: number, data?: unknown, method = '') {
    super(message);
    this.name = 'JsonRpcResponseError';
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

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
  onMessageActivity?: (msg: Record<string, unknown>) => void;
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
  private _lastIncomingMessageAt = Date.now();

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: JsonRpcHandlers,
  ) {
    this.parser = new ResilientJsonLineParser(
      (msg) => this.handleMessage(msg),
      (noise) => this.handlers.onDiagnostic('stdout', noise),
    );

    child.stdin?.on('error', (err) => {
      this.handlers.onDiagnostic('protocol', `CLI stdin error: ${err.message}`);
    });

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

  get lastIncomingMessageAt(): number {
    return this._lastIncomingMessageAt;
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

      const ok = this.writeLine({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new Error(`Cannot send JSON-RPC request "${method}": CLI stdin is closed`));
      }
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

  private writeLine(payload: Record<string, unknown>): boolean {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      this.handlers.onDiagnostic('protocol', 'Cannot write to CLI stdin (stream closed)');
      return false;
    }
    try {
      stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
      return true;
    } catch (err) {
      this.handlers.onDiagnostic(
        'protocol',
        `Cannot write to CLI stdin: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    this._lastIncomingMessageAt = Date.now();
    this.handlers.onMessageActivity?.(msg);

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
        const errObj = msg.error as { message?: string; code?: number; data?: unknown };
        entry.reject(
          new JsonRpcResponseError(
            errObj.message || `JSON-RPC error (${errObj.code ?? 'unknown'}) on ${entry.method}`,
            typeof errObj.code === 'number' ? errObj.code : undefined,
            errObj.data,
            entry.method,
          ),
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
