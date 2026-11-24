import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  PROTOCOL_VERSION,
  WsClientFrameSchema,
  type WsServerFrame,
} from '@harnessmate/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import type { DaemonEventBus } from '../core/event-bus.js';
import type { SessionManager } from '../core/session-manager.js';
import { isLocalBrowserRequest, isLoopbackAddress, type RemoteAuthService } from './auth.js';

export interface WsGatewayDeps {
  desktopId: string;
  desktopName: string;
  auth: RemoteAuthService;
  eventBus: DaemonEventBus;
  sessionManager: SessionManager;
}

export class WsGateway {
  private readonly wss: WebSocketServer;
  private readonly localSockets = new Set<WebSocket>();

  constructor(private readonly deps: WsGatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/v1/ws') {
      socket.destroy();
      return;
    }

    const authHeader = request.headers.authorization;
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    const queryToken = url.searchParams.get('token') ?? undefined;
    const principal = this.deps.auth.authenticate(
      request.socket.remoteAddress,
      headerToken ?? queryToken,
    );

    if (!principal) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (principal.kind === 'local' && !isLocalBrowserRequest(request.headers)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      if (principal.kind === 'local' && isLoopbackAddress(request.socket.remoteAddress)) {
        this.localSockets.add(ws);
        ws.once('close', () => this.localSockets.delete(ws));
      }
      this.wss.emit('connection', ws, request);
    });
  }

  notifyPluginsChanged(): void {
    for (const ws of this.localSockets) this.send(ws, { op: 'plugins_changed' });
  }

  close(): void {
    for (const client of this.wss.clients) {
      client.close(1001, 'Daemon shutting down');
    }
    this.wss.close();
  }

  private handleConnection(ws: WebSocket): void {
    const sessionUnsubs = new Map<string, () => void>();
    const commandOutputUnsubs = new Map<string, () => void>();
    let attentionUnsub: (() => void) | null = null;

    this.send(ws, {
      op: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      desktopId: this.deps.desktopId,
      desktopName: this.deps.desktopName,
    });

    ws.on('message', (raw) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString('utf8'));
      } catch {
        this.send(ws, { op: 'error', code: 'INVALID_JSON', message: 'Expected valid JSON frame' });
        return;
      }

      const parsed = WsClientFrameSchema.safeParse(parsedJson);
      if (!parsed.success) {
        this.send(ws, {
          op: 'error',
          code: 'INVALID_FRAME',
          message: parsed.error.issues[0]?.message ?? 'Invalid WebSocket frame',
        });
        return;
      }

      const frame = parsed.data;
      switch (frame.op) {
        case 'ping': {
          this.send(ws, { op: 'pong', ts: frame.ts ?? Date.now() });
          break;
        }

        case 'subscribe': {
          const { sessionId, afterSeq } = frame;
          sessionUnsubs.get(sessionId)?.();

          // Subscribe live first while buffering so we never drop an event between DB replay and live stream
          let replaying = true;
          let maxSentSeq = afterSeq;
          const liveBuffer: import('@harnessmate/protocol').CanonicalEvent[] = [];

          const unsub = this.deps.eventBus.subscribeSession(sessionId, (event) => {
            if (replaying) {
              liveBuffer.push(event);
              return;
            }
            if (event.seq > maxSentSeq) {
              maxSentSeq = event.seq;
              this.send(ws, { op: 'event', event });
            }
          });
          sessionUnsubs.set(sessionId, unsub);

          for (const ev of this.deps.sessionManager.iterateSessionEvents(sessionId, afterSeq)) {
            if (ev.seq > maxSentSeq) {
              maxSentSeq = ev.seq;
              this.send(ws, { op: 'event', event: ev });
            }
          }

          replaying = false;
          for (const ev of liveBuffer) {
            if (ev.seq > maxSentSeq) {
              maxSentSeq = ev.seq;
              this.send(ws, { op: 'event', event: ev });
            }
          }

          this.send(ws, { op: 'replay_complete', sessionId, lastSeq: maxSentSeq });
          break;
        }

        case 'unsubscribe': {
          sessionUnsubs.get(frame.sessionId)?.();
          sessionUnsubs.delete(frame.sessionId);
          break;
        }

        case 'subscribe_attention': {
          if (!attentionUnsub) {
            attentionUnsub = this.deps.eventBus.subscribeAttention((item) => {
              this.send(ws, { op: 'attention', item });
            });
          }
          break;
        }

        case 'subscribe_command_output': {
          const key = `${frame.sessionId}::${frame.toolCallId}`;
          commandOutputUnsubs.get(key)?.();
          const unsub = this.deps.sessionManager.commandOutputHub.subscribe(
            frame.sessionId,
            frame.toolCallId,
            (chunk) => {
              this.send(ws, {
                op: 'command_output',
                sessionId: chunk.sessionId,
                toolCallId: chunk.toolCallId,
                chunk: chunk.chunk,
                stream: chunk.stream,
                snapshot: chunk.snapshot,
                done: chunk.done,
                timestamp: chunk.timestamp,
              });
            },
          );
          commandOutputUnsubs.set(key, unsub);
          break;
        }

        case 'unsubscribe_command_output': {
          const key = `${frame.sessionId}::${frame.toolCallId}`;
          commandOutputUnsubs.get(key)?.();
          commandOutputUnsubs.delete(key);
          break;
        }
      }
    });

    ws.on('close', () => {
      for (const unsub of sessionUnsubs.values()) unsub();
      sessionUnsubs.clear();
      for (const unsub of commandOutputUnsubs.values()) unsub();
      commandOutputUnsubs.clear();
      attentionUnsub?.();
      attentionUnsub = null;
    });
  }

  private send(ws: WebSocket, frame: WsServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }
}
