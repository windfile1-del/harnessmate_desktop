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
import { encodeNativeCursor } from './persistence.js';
import type { AgyNativeRuntimeRegistry } from './registry.js';

export interface NativeWsFeedGatewayDeps {
  readonly auth: RemoteAuthService;
  readonly sessionManager: SessionManager;
  readonly nativeRegistry: AgyNativeRuntimeRegistry;
  readonly maxReplayEvents?: number;
  readonly maxLiveBuffer?: number;
  readonly maxBufferedBytes?: number;
}

const NATIVE_WS_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/native\/ws$/;
const DEFAULT_MAX_REPLAY_EVENTS = 10_000;
const DEFAULT_REPLAY_PAGE_SIZE = 500;
const DEFAULT_MAX_LIVE_BUFFER = 2048;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Dedicated versioned WebSocket namespace (`/api/v1/sessions/:id/native/ws`) for the AGY native
 * canonical event feed.
 *
 * R3 guarantees:
 * - Complete bounded multi-page replay before emitting `native_replay_complete` (or explicit `native_resync_required` if backlog exceeds bound).
 * - Runtime and generation changes immediately emit `native_resync_required` instead of silent drops.
 * - Bounded live buffer & slow-consumer protection emitting `native_resync_required`.
 * - Controlled HTTP upgrade errors for malformed paths and non-AGY sessions (matching REST scope).
 */
export class NativeWsFeedGateway {
  private readonly wss: WebSocketServer;
  private readonly maxReplayEvents: number;
  private readonly maxLiveBuffer: number;
  private readonly maxBufferedBytes: number;

  constructor(private readonly deps: NativeWsFeedGatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true });
    this.maxReplayEvents = deps.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
    this.maxLiveBuffer = deps.maxLiveBuffer ?? DEFAULT_MAX_LIVE_BUFFER;
    this.maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  canHandlePath(requestUrl: string | undefined): boolean {
    try {
      const url = new URL(requestUrl ?? '/', 'http://localhost');
      return NATIVE_WS_PATH_RE.test(url.pathname);
    } catch {
      return false;
    }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    const match = NATIVE_WS_PATH_RE.exec(url.pathname);
    if (!match) return false;

    let sessionId: string;
    try {
      sessionId = decodeURIComponent(match[1]!);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return true;
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
    if (session.harnessKind !== 'agy') {
      socket.write('HTTP/1.1 422 Unprocessable Entity\r\n\r\n');
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
    const enabled = this.deps.nativeRegistry.isEnabled();
    const binding =
      schemaStatus.compatible && enabled
        ? this.deps.nativeRegistry.getActiveBinding(sessionId, instanceId)
        : null;

    this.send(ws, {
      op: 'native_hello',
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      contractRevision: AGY_NATIVE_CONTRACT_REVISION,
      sessionId,
      runtimeId: binding?.runtimeId ?? null,
      generation: binding?.generation ?? null,
      enabled,
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
          let bufferOverflowed = false;
          const liveBuffer: NativeCanonicalEvent[] = [];
          let activeRuntimeId: string | null = null;
          let activeGeneration: string | null = null;
          let maxSentSeq = frame.afterSeq;

          const abortWithResync = (
            reason: string,
            latestSeq: number,
            currentGeneration: NativeCanonicalEvent['generation'] | null,
          ) => {
            activeUnsub?.();
            activeUnsub = null;
            this.send(ws, {
              op: 'native_resync_required',
              schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
              code: 'RESYNC_REQUIRED',
              reason,
              latestSeq,
              currentGeneration,
            });
          };

          activeUnsub = this.deps.nativeRegistry.subscribeSession(sessionId, (event) => {
            if (replaying) {
              if (liveBuffer.length >= this.maxLiveBuffer) {
                bufferOverflowed = true;
                return;
              }
              liveBuffer.push(event);
              return;
            }
            if (ws.bufferedAmount > this.maxBufferedBytes) {
              abortWithResync('slow_consumer_overflow', event.seq, event.generation);
              return;
            }
            if (activeRuntimeId && event.runtimeId !== activeRuntimeId) {
              abortWithResync('runtime_changed', event.seq, event.generation);
              return;
            }
            if (activeGeneration && event.generation !== activeGeneration) {
              abortWithResync('generation_changed', event.seq, event.generation);
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

          // Complete multi-page bounded replay loop before ever sending `native_replay_complete`
          let nextAfterSeq = frame.afterSeq;
          let cursorForFirstPage = frame.cursor;
          let expectedGeneration = frame.generation;
          let totalReplayed = 0;
          let finalRuntimeId: NativeCanonicalEvent['runtimeId'] | null = null;
          let finalGeneration: NativeCanonicalEvent['generation'] | null = null;
          let finalCursor = '';

          while (true) {
            const page = this.deps.nativeRegistry.readEventsForSession(sessionId, instanceId, {
              afterSeq: nextAfterSeq,
              limit: DEFAULT_REPLAY_PAGE_SIZE,
              cursor: cursorForFirstPage,
              expectedGeneration,
            });
            cursorForFirstPage = undefined;

            if (page.resyncRequired) {
              abortWithResync(page.reason, page.latestSeq, page.currentGeneration);
              return;
            }

            if (finalRuntimeId && (finalRuntimeId !== page.runtimeId || finalGeneration !== page.generation)) {
              abortWithResync(
                finalRuntimeId !== page.runtimeId ? 'runtime_changed' : 'generation_changed',
                page.asOfSeq,
                page.generation,
              );
              return;
            }

            finalRuntimeId = page.runtimeId;
            finalGeneration = page.generation;
            expectedGeneration = page.generation;
            activeRuntimeId = page.runtimeId;
            activeGeneration = page.generation;
            finalCursor = page.nextCursor;

            for (const ev of page.events) {
              totalReplayed += 1;
              if (totalReplayed > this.maxReplayEvents) {
                abortWithResync('replay_backlog_exceeded', page.asOfSeq, page.generation);
                return;
              }
              if (ev.seq > maxSentSeq) {
                maxSentSeq = ev.seq;
                this.send(ws, {
                  op: 'native_event',
                  schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
                  event: ev,
                });
              }
            }

            if (!page.hasMore) {
              break;
            }
            if (page.nextSeq <= nextAfterSeq) {
              // Defensive progress guard against non-advancing cursor
              abortWithResync('replay_stalled', page.asOfSeq, page.generation);
              return;
            }
            nextAfterSeq = page.nextSeq;
          }

          if (bufferOverflowed || ws.bufferedAmount > this.maxBufferedBytes) {
            const latest = this.deps.nativeRegistry.getActiveBinding(sessionId, instanceId);
            abortWithResync(
              'slow_consumer_overflow',
              maxSentSeq,
              latest?.generation ?? finalGeneration,
            );
            return;
          }

          replaying = false;
          for (const ev of liveBuffer) {
            if (ev.runtimeId !== activeRuntimeId) {
              abortWithResync('runtime_changed', ev.seq, ev.generation);
              return;
            }
            if (ev.generation !== activeGeneration) {
              abortWithResync('generation_changed', ev.seq, ev.generation);
              return;
            }
            if (ev.seq > maxSentSeq) {
              maxSentSeq = ev.seq;
              this.send(ws, {
                op: 'native_event',
                schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
                event: ev,
              });
            }
          }

          if (finalRuntimeId && finalGeneration) {
            this.send(ws, {
              op: 'native_replay_complete',
              schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
              runtimeId: finalRuntimeId,
              generation: finalGeneration,
              lastSeq: maxSentSeq,
              nextCursor: encodeNativeCursor(finalRuntimeId, finalGeneration, maxSentSeq) || finalCursor,
            });
          }
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
