import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  PROTOCOL_VERSION,
  WsClientFrameSchema,
  type AgyAuthState,
  type WsServerFrame,
} from '@harnessmate/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import { PEER_CONTRACTS } from '@harnessmate/plugin-api';
import type { DaemonEventBus } from '../core/event-bus.js';
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

        case 'subscribe_terminal': {
          terminalOutputUnsubs.get(frame.terminalId)?.();
          terminalOutputUnsubs.delete(frame.terminalId);
          const owner = this.deps.pluginManager
            ? await resolveTerminalProviderForTerminalIdAsync(this.deps.pluginManager, frame.terminalId)
            : null;
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
            terminalOutputUnsubs.set(frame.terminalId, unsub);
            break;
          }
          if (owner?.peer && typeof owner.peer.getOutputSnapshot === 'function') {
            let lastLen = 0;
            let stopped = false;
            const emitSnap = async (initial: boolean) => {
              if (stopped || ws.readyState !== WebSocket.OPEN) return;
              try {
                const res = await owner.peer!.getOutputSnapshot({ terminalId: frame.terminalId });
                if (stopped || !res.ok) return;
                const full = res.value.snapshot ?? '';
                if (initial) {
                  lastLen = full.length;
                  this.send(ws, {
                    op: 'terminal_output',
                    terminalId: frame.terminalId,
                    chunk: full,
                    snapshot: true,
                    truncated: res.value.truncated,
                    ringBufferBytes: Buffer.byteLength(full, 'utf8'),
                    timestamp: Date.now(),
                  });
                } else if (full.length > lastLen) {
                  const delta = full.slice(lastLen);
                  lastLen = full.length;
                  this.send(ws, {
                    op: 'terminal_output',
                    terminalId: frame.terminalId,
                    chunk: delta,
                    snapshot: false,
                    truncated: res.value.truncated,
                    ringBufferBytes: Buffer.byteLength(full, 'utf8'),
                    timestamp: Date.now(),
                  });
                }
              } catch {
                // ignore transient stop
              }
            };
            void emitSnap(true);
            const timer = setInterval(() => {
              void emitSnap(false);
            }, 150);
            timer.unref?.();
            terminalOutputUnsubs.set(frame.terminalId, () => {
              stopped = true;
              clearInterval(timer);
            });
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
