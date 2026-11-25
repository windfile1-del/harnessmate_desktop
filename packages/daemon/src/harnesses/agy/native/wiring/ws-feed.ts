import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  NativeWsClientFrameSchema,
  type NativeCanonicalEvent,
  type NativeWsServerFrame,
} from '@harnessmate/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionManager } from '../../../../core/session-manager.js';
import {
  isLocalBrowserRequest,
  type RemoteAuthService,
} from '../../../../server/auth.js';
import type { AgyNativeRuntimeRegistry } from './registry.js';

export interface NativeWsFeedGatewayDeps {
  readonly auth: RemoteAuthService;
  readonly sessionManager: SessionManager;
  readonly nativeRegistry: AgyNativeRuntimeRegistry;
}

const NATIVE_WS_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/native\/ws$/;

/**
 * Dedicated versioned WebSocket namespace (`/api/v1/sessions/:id/native/ws`) for the AGY native
 * canonical event feed. Keeps existing `/api/v1/ws` frames 100% untouched for legacy clients while
 * reusing the exact same authentication, cursor validation, and gap-free replay+live semantics.
 */
export class NativeWsFeedGateway {
  private readonly wss: WebSocketServer;

  constructor(private readonly deps: NativeWsFeedGatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  canHandlePath(requestUrl: string | undefined): boolean {
    const url = new URL(requestUrl ?? '/', 'http://localhost');
    return NATIVE_WS_PATH_RE.test(url.pathname);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = NATIVE_WS_PATH_RE.exec(url.pathname);
    if (!match) return false;

    const sessionId = decodeURIComponent(match[1]!);
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
      return true;
    }
    if (principal.kind === 'local' && !isLocalBrowserRequest(request.headers)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return true;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws, session.id, session.harnessId);
    });
    return true;
  }

  close(): void {
    for (const client of this.wss.clients) {
      client.close(1001, 'Daemon shutting down');
    }
    this.wss.close();
  }

  private handleConnection(ws: WebSocket, sessionId: string, instanceId: string): void {
    let activeUnsub: (() => void) | null = null;
    const schemaStatus = this.deps.nativeRegistry.getSchemaStatus();
    const binding = schemaStatus.compatible
      ? this.deps.nativeRegistry.getActiveBinding(sessionId, instanceId)
      : null;

    this.send(ws, {
      op: 'native_hello',
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      contractRevision: AGY_NATIVE_CONTRACT_REVISION,
      sessionId,
      runtimeId: binding?.runtimeId ?? null,
      generation: binding?.generation ?? null,
      enabled: this.deps.nativeRegistry.isEnabled(),
    });

    if (!schemaStatus.compatible) {
      this.send(ws, {
        op: 'native_error',
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        code: 'NATIVE_SCHEMA_NEWER_THAN_READER',
        message: 'Native runtime schema version is newer than this daemon reader.',
      });
    }

    ws.on('message', (raw) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString('utf8'));
      } catch {
        this.send(ws, {
          op: 'native_error',
          schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
          code: 'INVALID_REQUEST',
          message: 'Expected valid JSON frame',
        });
        return;
      }

      const parsed = NativeWsClientFrameSchema.safeParse(parsedJson);
      if (!parsed.success) {
        this.send(ws, {
          op: 'native_error',
          schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
          code: 'INVALID_REQUEST',
          message: parsed.error.issues[0]?.message ?? 'Invalid native WebSocket frame',
        });
        return;
      }

      const frame = parsed.data;
      switch (frame.op) {
        case 'ping': {
          this.send(ws, { op: 'native_pong', ts: frame.ts ?? Date.now() });
          break;
        }

        case 'unsubscribe_native': {
          activeUnsub?.();
          activeUnsub = null;
          break;
        }

        case 'subscribe_native': {
          activeUnsub?.();
          activeUnsub = null;

          if (!this.deps.nativeRegistry.getSchemaStatus().compatible) {
            this.send(ws, {
              op: 'native_error',
              schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
              code: 'NATIVE_SCHEMA_NEWER_THAN_READER',
              message: 'Native runtime schema version is newer than this daemon reader.',
            });
            return;
          }

          let replaying = true;
          const liveBuffer: NativeCanonicalEvent[] = [];
          let activeRuntimeId: string | null = null;
          let activeGeneration: string | null = null;
          let maxSentSeq = frame.afterSeq;

          activeUnsub = this.deps.nativeRegistry.subscribeSession(sessionId, (event) => {
            if (replaying) {
              liveBuffer.push(event);
              return;
            }
            if (activeRuntimeId && event.runtimeId !== activeRuntimeId) return;
            if (activeGeneration && event.generation !== activeGeneration) {
              this.send(ws, {
                op: 'native_resync_required',
                schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
                code: 'RESYNC_REQUIRED',
                reason: 'generation_changed',
                latestSeq: event.seq,
                currentGeneration: event.generation,
              });
              activeUnsub?.();
              activeUnsub = null;
              return;
            }
            if (event.seq > maxSentSeq) {
              maxSentSeq = event.seq;
              this.send(ws, {
                op: 'native_event',
                schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
                event,
              });
            }
          });

          const replay = this.deps.nativeRegistry.readEventsForSession(sessionId, instanceId, {
            afterSeq: frame.afterSeq,
            limit: 500,
            cursor: frame.cursor,
            expectedGeneration: frame.generation,
          });

          if (replay.resyncRequired) {
            activeUnsub?.();
            activeUnsub = null;
            this.send(ws, {
              op: 'native_resync_required',
              schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
              code: 'RESYNC_REQUIRED',
              reason: replay.reason,
              latestSeq: replay.latestSeq,
              currentGeneration: replay.currentGeneration,
            });
            return;
          }

          activeRuntimeId = replay.runtimeId;
          activeGeneration = replay.generation;

          for (const ev of replay.events) {
            if (ev.seq > maxSentSeq) {
              maxSentSeq = ev.seq;
              this.send(ws, {
                op: 'native_event',
                schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
                event: ev,
              });
            }
          }

          replaying = false;
          for (const ev of liveBuffer) {
            if (ev.runtimeId === activeRuntimeId && ev.generation === activeGeneration && ev.seq > maxSentSeq) {
              maxSentSeq = ev.seq;
              this.send(ws, {
                op: 'native_event',
                schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
                event: ev,
              });
            }
          }

          this.send(ws, {
            op: 'native_replay_complete',
            schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
            runtimeId: replay.runtimeId,
            generation: replay.generation,
            lastSeq: maxSentSeq,
            nextCursor: replay.nextCursor,
          });
          break;
        }
      }
    });

    ws.on('close', () => {
      activeUnsub?.();
      activeUnsub = null;
    });
  }

  private send(ws: WebSocket, frame: NativeWsServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }
}
