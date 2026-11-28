import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  PROTOCOL_VERSION,
  WsClientFrameSchema,
  type AgyAuthState,
  type WsServerFrame,
} from '@harnessmate/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PEER_CONTRACTS,
  isReservedServiceName,
  sessionDataStreamKey,
  type SessionDataChannelEvent,
  type SessionDataStreamIdentity,
} from '@harnessmate/plugin-api';
import type { DaemonEventBus } from '../core/event-bus.js';
import { perfDiagnostics } from '../core/perf-diagnostics.js';
import type { SessionManager } from '../core/session-manager.js';
import type { TerminalWorkspaceService } from '../core/terminal-workspace-service.js';
import { resolveTerminalProviderForTerminalIdAsync } from '../core/w1-service-helpers.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import { isLocalBrowserRequest, isLoopbackAddress, type RemoteAuthService } from './auth.js';

export interface WsGatewayDeps {
  desktopId: string;
  desktopName: string;
  auth: RemoteAuthService;
  eventBus: DaemonEventBus;
  sessionManager: SessionManager;
  terminalWorkspace?: TerminalWorkspaceService;
  pluginManager?: PluginManager;
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

  notifyTriage(frame: Extract<WsServerFrame, { op: 'triage_updated' }>): void {
    for (const ws of this.localSockets) this.send(ws, frame);
  }

  notifyAgyAuthState(state: AgyAuthState): void {
    for (const ws of this.localSockets) this.send(ws, { op: 'agy_auth_state', state });
  }

  close(): void {
    for (const client of this.wss.clients) {
      client.close(1001, 'Daemon shutting down');
    }
    this.wss.close();
  }

  private handleConnection(ws: WebSocket): void {
    const serviceUnsubs = new Map<string, () => void>();
    const sessionUnsubs = new Map<string, () => void>();
    const commandOutputUnsubs = new Map<string, () => void>();
    const terminalOutputUnsubs = new Map<string, () => void>();
    let attentionUnsub: (() => void) | null = null;
    const statusUnsubsByInstance = new Map<string, () => void>();
    const syncTerminalStatusListeners = () => {
      const seen = new Set<string>();
      const pm = this.deps.pluginManager;
      if (pm) {
        const candidates = [
          ...pm.host.listServiceProviders(PEER_CONTRACTS.terminalWorkspace),
          ...pm.host.listServiceProviders('terminal-workspace'),
        ];
        for (const prov of candidates) {
          seen.add(prov.instanceId);
          if (statusUnsubsByInstance.has(prov.instanceId)) continue;
          const legacy =
            pm.host.getServiceByInstance<TerminalWorkspaceService>(prov.instanceId, 'terminal-workspace') ??
            pm.host.getServiceByInstance<TerminalWorkspaceService>(prov.instanceId, PEER_CONTRACTS.terminalWorkspace);
          if (legacy && typeof legacy.subscribeStatus === 'function') {
            statusUnsubsByInstance.set(
              prov.instanceId,
              legacy.subscribeStatus((ev) => {
                this.send(ws, {
                  op: 'terminal_status',
                  terminal: ev.terminal,
                  event: ev.event,
                });
              }),
            );
          }
        }
      } else if (this.deps.terminalWorkspace) {
        seen.add('__default__');
        if (!statusUnsubsByInstance.has('__default__')) {
          statusUnsubsByInstance.set(
            '__default__',
            this.deps.terminalWorkspace.subscribeStatus((ev) => {
              this.send(ws, {
                op: 'terminal_status',
                terminal: ev.terminal,
                event: ev.event,
              });
            }),
          );
        }
      }
      for (const [instId, unsub] of statusUnsubsByInstance) {
        if (!seen.has(instId)) {
          unsub();
          statusUnsubsByInstance.delete(instId);
        }
      }
    };
    syncTerminalStatusListeners();
    const pluginStateUnsub = this.deps.pluginManager?.host.events.on('plugin.state', () => {
      syncTerminalStatusListeners();
    });

    this.send(ws, {
      op: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      desktopId: this.deps.desktopId,
      desktopName: this.deps.desktopName,
    });

    ws.on('message', async (raw) => {
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
        case 'unsubscribe_service': {
          serviceUnsubs.get(frame.subscriptionId)?.();
          serviceUnsubs.delete(frame.subscriptionId);
          break;
        }
        case 'subscribe_service': {
          serviceUnsubs.get(frame.subscriptionId)?.();
          serviceUnsubs.delete(frame.subscriptionId);
          const pm = this.deps.pluginManager;
          const provider = pm?.host.getServiceRecordByInstance(frame.instanceId, frame.contract);
          const sendBatch = (
            events: Array<{ seq: number; emittedAt: number; payload: Record<string, unknown> }>,
            reset = false,
            meta?: { serverFlushedAt?: number; queueDepth?: number; backlogMs?: number },
          ) =>
            this.send(ws, {
              op: 'service_batch',
              subscriptionId: frame.subscriptionId,
              instanceId: frame.instanceId,
              runId: provider?.runId,
              events,
              ...(reset ? { reset: true } : {}),
              ...(meta?.serverFlushedAt !== undefined ? { serverFlushedAt: meta.serverFlushedAt } : {}),
              ...(meta?.queueDepth !== undefined ? { queueDepth: meta.queueDepth } : {}),
              ...(meta?.backlogMs !== undefined ? { backlogMs: meta.backlogMs } : {}),
            });
          if (!pm || !provider || isReservedServiceName(frame.contract)
            || (frame.runId && provider.runId !== frame.runId) || !pm.isInstanceEnabled(frame.instanceId)) {
            sendBatch([], true);
            break;
          }
          let queue: Array<{ seq: number; emittedAt: number; payload: Record<string, unknown> }> = [];
          let oldestEnqueuedAt = 0;
          let lastFlushAt = 0;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let released = false;
          perfDiagnostics.adjustSubscription('wsService', 1);
          const clearFlushTimer = () => {
            if (timer) {
              clearTimeout(timer);
              timer = undefined;
              perfDiagnostics.adjustTimer('wsServiceFlush', -1);
            }
          };
          const flush = () => {
            if (timer) {
              timer = undefined;
              perfDiagnostics.adjustTimer('wsServiceFlush', -1);
            }
            if (released || !queue.length) return;
            const batch = queue;
            const batchSize = batch.length;
            const enqueuedAt = oldestEnqueuedAt || Date.now();
            queue = [];
            oldestEnqueuedAt = 0;
            const flushedAt = Date.now();
            lastFlushAt = flushedAt;
            const backlogMs = Math.max(0, flushedAt - enqueuedAt);
            const depthAfter = perfDiagnostics.adjustQueueDepth('wsService', -batchSize);
            if (ws.bufferedAmount > 2 * 1024 * 1024) { sendBatch([], true); release(); return; }
            const firstPayload = batch[0]?.payload as { sessionId?: string; trace?: { runtimeReceivedAt?: number; committedAt?: number } } | undefined;
            perfDiagnostics.recordBatchFlush('wsService', {
              batchSize,
              backlogMs,
              queueDepthAfter: depthAfter,
              trace: {
                sessionId: firstPayload?.sessionId,
                contract: frame.contract,
                runtimeReceivedAt: firstPayload?.trace?.runtimeReceivedAt,
                postCommitAt: firstPayload?.trace?.committedAt,
                wsEnqueuedAt: enqueuedAt,
                wsFlushedAt: flushedAt,
              },
            });
            sendBatch(batch, false, { serverFlushedAt: flushedAt, queueDepth: depthAfter, backlogMs });
          };
          const unsub = pm.host.subscribeServiceChannel(frame.contract, (event) => {
            if (event.instanceId !== frame.instanceId || released) return;
            const now = Date.now();
            if (!queue.length) oldestEnqueuedAt = now;
            queue.push({ seq: event.seq, emittedAt: event.emittedAt, payload: event.payload });
            perfDiagnostics.adjustQueueDepth('wsService', 1);
            if (queue.length >= 256 || (!timer && now - lastFlushAt >= 12)) {
              clearFlushTimer();
              flush();
            } else if (!timer) {
              perfDiagnostics.adjustTimer('wsServiceFlush', 1);
              timer = setTimeout(flush, 12);
            }
          });
          const changed = pm.host.onServicesChanged(() => {
            const current = pm.host.getServiceRecordByInstance(frame.instanceId, frame.contract);
            if (!current || current.runId !== provider.runId || !pm.isInstanceEnabled(frame.instanceId)) {
              sendBatch([], true); release();
            }
          });
          const release = () => {
            if (released) return;
            released = true; unsub(); changed();
            clearFlushTimer();
            if (queue.length) {
              perfDiagnostics.adjustQueueDepth('wsService', -queue.length);
              queue = [];
            }
            perfDiagnostics.adjustSubscription('wsService', -1);
            serviceUnsubs.delete(frame.subscriptionId);
          };
          serviceUnsubs.set(frame.subscriptionId, release);
          // Acknowledgement is sent after attaching the listener. Consumers take their
          // durable snapshot only after this boundary and replay from its own cursor.
          sendBatch([], true);
          break;
        }
        case 'ping': {
          this.send(ws, { op: 'pong', ts: frame.ts ?? Date.now() });
          break;
        }

        case 'subscribe': {
          const { sessionId, afterSeq } = frame;
          const clientStream = (frame as { stream?: SessionDataStreamIdentity }).stream;
          sessionUnsubs.get(sessionId)?.();

          // Subscribe live BEFORE replaying so zero committed events are missed between replay and live stream
          let replaying = true;
          let maxSentSeq = afterSeq;
          const liveBuffer: import('@harnessmate/protocol').CanonicalEvent[] = [];

          const pushEvent = (event: import('@harnessmate/protocol').CanonicalEvent) => {
            if (replaying) {
              liveBuffer.push(event);
              return;
            }
            if (event.seq > maxSentSeq) {
              maxSentSeq = event.seq;
              this.send(ws, { op: 'event', event });
            }
          };

          const unsubBus = this.deps.eventBus.subscribeSession(sessionId, pushEvent);
          const unsubChannel = this.deps.pluginManager?.host.subscribeServiceChannel(
            PEER_CONTRACTS.sessionData,
            (raw) => {
              const payload = raw.payload as unknown as SessionDataChannelEvent | undefined;
              if (!payload || payload.sessionId !== sessionId || !Array.isArray(payload.events)) return;
              for (const ev of payload.events) {
                pushEvent({
                  sessionId: ev.sessionId,
                  seq: ev.seq,
                  type: ev.type as import('@harnessmate/protocol').CanonicalEventType,
                  turnId: ev.turnId,
                  payload: ev.payload,
                  createdAt: ev.createdAt,
                });
              }
            },
          );
          sessionUnsubs.set(sessionId, () => {
            unsubBus();
            unsubChannel?.();
          });

          try {
            const page = await this.deps.sessionManager.getSessionEventsPageAsync(sessionId, 0);
            const activeStream = page.stream;
            const streamMismatch = Boolean(
              clientStream &&
                activeStream &&
                sessionDataStreamKey(clientStream) !== sessionDataStreamKey(activeStream),
            );
            const effectiveAfterSeq = streamMismatch ? 0 : afterSeq;
            maxSentSeq = effectiveAfterSeq;

            const eventsToReplay = effectiveAfterSeq === 0
              ? page.events
              : page.events.filter((ev) => ev.seq > effectiveAfterSeq);

            for (const ev of eventsToReplay) {
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

            this.send(ws, {
              op: 'replay_complete',
              sessionId,
              lastSeq: maxSentSeq,
              ...(activeStream ? { stream: activeStream } : {}),
              ...(streamMismatch ? { streamMismatch: true } : {}),
            });
          } catch (err) {
            replaying = false;
            this.send(ws, {
              op: 'error',
              code: 'SERVICE_UNAVAILABLE',
              message: err instanceof Error ? err.message : String(err),
            });
          }
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

        case 'subscribe_terminal': {
          terminalOutputUnsubs.get(frame.terminalId)?.();
          let stopped = false;
          let cleanup: (() => void) | undefined;
          const stop = () => {
            stopped = true;
            cleanup?.();
          };
          terminalOutputUnsubs.set(frame.terminalId, stop);
          const owner = this.deps.pluginManager
            ? await resolveTerminalProviderForTerminalIdAsync(this.deps.pluginManager, frame.terminalId)
            : null;
          if (stopped || ws.readyState !== WebSocket.OPEN) break;
          const localSvc = owner?.legacy ?? (!this.deps.pluginManager ? this.deps.terminalWorkspace : undefined);
          if (localSvc && typeof localSvc.subscribeOutput === 'function') {
            const unsub = localSvc.subscribeOutput(frame.terminalId, (chunk) => {
              this.send(ws, {
                op: 'terminal_output',
                terminalId: chunk.terminalId,
                chunk: chunk.chunk,
                snapshot: chunk.snapshot,
                truncated: chunk.truncated,
                ringBufferBytes: chunk.ringBufferBytes,
                timestamp: chunk.timestamp,
              });
            });
            cleanup = unsub;
            break;
          }
          if (owner?.peer && typeof owner.peer.getOutputSnapshot === 'function') {
            let previousSnapshot: string | undefined;
            let polling = false;
            const emitSnap = async (initial: boolean) => {
              if (stopped || polling || ws.readyState !== WebSocket.OPEN) return;
              if (this.deps.pluginManager?.host.getServiceByInstance(owner.instanceId, PEER_CONTRACTS.terminalWorkspace) !== owner.peer) {
                stop();
                return;
              }
              polling = true;
              try {
                const res = await owner.peer!.getOutputSnapshot({ terminalId: frame.terminalId });
                if (stopped) return;
                if (!res.ok) {
                  if (['not_found', 'E_NOT_FOUND', 'E_TERMINAL_NOT_FOUND'].includes(res.error.code)) stop();
                  return;
                }
                const full = res.value.snapshot ?? '';
                if (initial || full !== previousSnapshot) {
                  // A bounded ring can roll over or shrink while producing output.
                  // Only append when the old content is still an exact prefix.
                  const append = previousSnapshot !== undefined && full.startsWith(previousSnapshot);
                  this.send(ws, {
                    op: 'terminal_output',
                    terminalId: frame.terminalId,
                    chunk: append ? full.slice(previousSnapshot!.length) : full,
                    snapshot: !append,
                    truncated: res.value.truncated,
                    ringBufferBytes: Buffer.byteLength(full, 'utf8'),
                    timestamp: Date.now(),
                  });
                  previousSnapshot = full;
                }
              } catch {
                // ignore transient stop
              } finally {
                polling = false;
              }
            };
            const timer = setInterval(() => {
              void emitSnap(false);
            }, 150);
            timer.unref?.();
            cleanup = () => clearInterval(timer);
            void emitSnap(true);
          }
          break;
        }

        case 'unsubscribe_terminal': {
          terminalOutputUnsubs.get(frame.terminalId)?.();
          terminalOutputUnsubs.delete(frame.terminalId);
          break;
        }

        case 'terminal_input': {
          const owner = this.deps.pluginManager
            ? await resolveTerminalProviderForTerminalIdAsync(this.deps.pluginManager, frame.terminalId)
            : null;
          const localSvc = owner?.legacy ?? (!this.deps.pluginManager ? this.deps.terminalWorkspace : undefined);
          if (localSvc) {
            try {
              localSvc.writeInput(frame.terminalId, frame.data);
            } catch (err) {
              this.send(ws, {
                op: 'error',
                code: 'TERMINAL_INPUT_ERROR',
                message: err instanceof Error ? err.message : String(err),
              });
            }
          } else if (owner?.peer) {
            void owner.peer.writeInput({ terminalId: frame.terminalId, data: frame.data }).catch(() => {});
          }
          break;
        }

        case 'terminal_resize': {
          const owner = this.deps.pluginManager
            ? await resolveTerminalProviderForTerminalIdAsync(this.deps.pluginManager, frame.terminalId)
            : null;
          const localSvc = owner?.legacy ?? (!this.deps.pluginManager ? this.deps.terminalWorkspace : undefined);
          if (localSvc) {
            try {
              localSvc.resizeTerminal(frame.terminalId, frame.cols, frame.rows);
            } catch {
              // ignore stale terminal resize
            }
          } else if (owner?.peer) {
            void owner.peer.resizeTerminal({ terminalId: frame.terminalId, cols: frame.cols, rows: frame.rows }).catch(() => {});
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      for (const unsub of [...serviceUnsubs.values()]) unsub();
      serviceUnsubs.clear();
      for (const unsub of sessionUnsubs.values()) unsub();
      sessionUnsubs.clear();
      for (const unsub of commandOutputUnsubs.values()) unsub();
      commandOutputUnsubs.clear();
      for (const unsub of terminalOutputUnsubs.values()) unsub();
      terminalOutputUnsubs.clear();
      for (const unsub of statusUnsubsByInstance.values()) unsub();
      statusUnsubsByInstance.clear();
      pluginStateUnsub?.();
      attentionUnsub?.();
      attentionUnsub = null;
    });
  }

  private send(ws: WebSocket, frame: WsServerFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }
}
