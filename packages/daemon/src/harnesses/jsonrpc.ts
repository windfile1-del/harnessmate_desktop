import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { NativeTransportFrame } from './agy/native/wiring/types.js';
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
  connectionId?: string;
  ingressOrdinal?: number;
}

export interface JsonRpcHandlers {
  onNotification: (method: string, params: unknown, meta?: { connectionId: string; ingressOrdinal: number }) => void;
  onServerRequest: (req: JsonRpcServerRequest) => void;
  onDiagnostic: (stream: 'stdout' | 'stderr' | 'protocol', message: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onMessageActivity?: (msg: Record<string, unknown>) => void;
  onTransportFrame?: (frame: NativeTransportFrame) => void;
}

interface PendingRequest {
  rpcId: string | number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

function rpcPendingKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

export class StdioJsonRpcClient {
  readonly connectionId: string;
  private nextId = 1;
  private ingressOrdinal = 0;
  private egressOrdinal = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly parser: ResilientJsonLineParser;
  private disposed = false;
  private _lastIncomingMessageAt = Date.now();

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: JsonRpcHandlers,
  ) {
    this.connectionId = `conn_${crypto.randomBytes(6).toString('hex')}`;
    this.parser = new ResilientJsonLineParser(
      (msg) => this.handleMessage(msg),
      (noise) => {
        this.emitTransportFrame({
          direction: 'in',
          ordinal: ++this.ingressOrdinal,
          messageKind: 'noise',
          diagnosticText: noise,
        });
        this.handlers.onDiagnostic('stdout', noise);
      },
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
            this.emitTransportFrame({
              direction: 'in',
              ordinal: ++this.ingressOrdinal,
              messageKind: 'stderr',
              diagnosticText: line.trim(),
            });
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
      this.emitTransportFrame({
        direction: 'internal',
        ordinal: ++this.ingressOrdinal,
        messageKind: 'exit',
        exitCode: code,
        exitSignal: signal,
      });
      this.rejectAllPending(new Error(`CLI process exited (code=${code}, signal=${signal})`));
      this.handlers.onExit(code, signal);
    });
  }

  get lastIncomingMessageAt(): number {
    return this._lastIncomingMessageAt;
  }

  get currentIngressOrdinal(): number {
    return this.ingressOrdinal;
  }

  requestWithMeta<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 60_000,
  ): { rpcId: number; requestOrdinal: number; promise: Promise<T> } {
    const id = this.nextId++;
    const requestOrdinal = ++this.egressOrdinal;
    if (this.disposed) {
      return {
        rpcId: id,
        requestOrdinal,
        promise: Promise.reject(new Error(`JSON-RPC client disposed before calling ${method}`)),
      };
    }
    const key = rpcPendingKey(id);
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(key, {
        rpcId: id,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method,
      });

      const wirePayload = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.emitTransportFrame({
        direction: 'out',
        ordinal: requestOrdinal,
        messageKind: 'request',
        rpcId: id,
        method,
        wire: wirePayload,
      });

      const ok = this.writeLine(wirePayload);
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new Error(`Cannot send JSON-RPC request "${method}": CLI stdin is closed`));
      }
    });
    return { rpcId: id, requestOrdinal, promise };
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    return this.requestWithMeta<T>(method, params, timeoutMs).promise;
  }

  notify(method: string, params?: unknown): boolean {
    if (this.disposed) return false;
    const wirePayload = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.emitTransportFrame({
      direction: 'out',
      ordinal: ++this.egressOrdinal,
      messageKind: 'notification',
      method,
      wire: wirePayload,
    });
    return this.writeLine(wirePayload);
  }

  respond(id: string | number, result: unknown): boolean {
    if (this.disposed) return false;
    const wirePayload = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.emitTransportFrame({
      direction: 'out',
      ordinal: ++this.egressOrdinal,
      messageKind: 'response',
      rpcId: id,
      wire: wirePayload,
    });
    return this.writeLine(wirePayload);
  }

  respondError(id: string | number, code: number, message: string): boolean {
    if (this.disposed) return false;
    const wirePayload = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    this.emitTransportFrame({
      direction: 'out',
      ordinal: ++this.egressOrdinal,
      messageKind: 'response',
      rpcId: id,
      wire: wirePayload,
    });
    return this.writeLine(wirePayload);
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

  private emitTransportFrame(
    frame: Omit<NativeTransportFrame, 'connectionId' | 'monotonicMs' | 'observedAt'>,
  ): void {
    if (!this.handlers.onTransportFrame) return;
    try {
      this.handlers.onTransportFrame({
        connectionId: this.connectionId,
        monotonicMs: performance.now(),
        observedAt: Date.now(),
        ...frame,
      });
    } catch {
      // observatory tap must never interfere with transport
    }
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
    const ordinal = ++this.ingressOrdinal;
    this.handlers.onMessageActivity?.(msg);

    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === 'string';

    // Response to our outgoing request
    if (hasId && !hasMethod) {
      const id = msg.id as string | number;
      this.emitTransportFrame({
        direction: 'in',
        ordinal,
        messageKind: 'response',
        rpcId: id,
        wire: msg,
      });
      const key = rpcPendingKey(id);
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
      const id = msg.id as string | number;
      this.emitTransportFrame({
        direction: 'in',
        ordinal,
        messageKind: 'server_request',
        rpcId: id,
        method: msg.method as string,
        wire: msg,
      });
      this.handlers.onServerRequest({
        id,
        method: msg.method as string,
        params: msg.params,
        connectionId: this.connectionId,
        ingressOrdinal: ordinal,
      });
      return;
    }

    // Incoming Server Notification
    if (hasMethod) {
      this.emitTransportFrame({
        direction: 'in',
        ordinal,
        messageKind: 'notification',
        method: msg.method as string,
        wire: msg,
      });
      this.handlers.onNotification(msg.method as string, msg.params, {
        connectionId: this.connectionId,
        ingressOrdinal: ordinal,
      });
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
