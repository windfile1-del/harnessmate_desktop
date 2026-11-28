import type { CanonicalEvent, WsServerFrame } from '@harnessmate/protocol';
import type { StoreApi } from 'zustand';
import { daemonApi, type ServiceBatch } from '../../api/client';
import { frontendPerfDiagnostics } from '../../lib/perf-diagnostics';
import type { AppState } from '../../stores/app-store';
import { restoreTimelinePosition, setTimelinePersistence } from './work-groups';

export interface PageBridge {
  instanceId: string;
  runId?: string;
  session: { id: string; workspaceId: string } | null;
  props: Record<string, unknown>;
  call<T = any>(method: string, params?: unknown): Promise<T>;
  navigateToFile(params: unknown): Promise<unknown>;
  onContext(listener: (session: PageBridge['session'], props: Record<string, unknown>) => void): () => void;
  onShellState?(listener: (patch: Record<string, unknown>) => void): () => void;
  onCommandOutput?(listener: (frame: Extract<WsServerFrame, { op: 'command_output' }>) => void): () => void;
  services: {
    call(contract: string, method: string, args: unknown[], options?: unknown): Promise<{ value: any }>;
    subscribe(options: unknown, listener: (batch: ServiceBatch) => void): Promise<() => void>;
  };
}

export interface ChatHistoryMeta {
  earliestSeq: number;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  totalBoundarySeq: number;
}

export type ChatPluginState = AppState & {
  eventChunksBySession: Record<string, CanonicalEvent[][]>;
  historyMetaBySession: Record<string, ChatHistoryMeta>;
  loadEarlierHistory: (sessionId: string) => Promise<boolean>;
};

const INITIAL_TAIL_EVENTS = 400;
const EARLIER_PAGE_EVENTS = 400;
const EVENT_CHUNK_SIZE = 256;
const SAVE_DEBOUNCE_MS = 350;

function appendToChunks(
  existing: CanonicalEvent[][] | undefined,
  incoming: CanonicalEvent[],
): CanonicalEvent[][] {
  if (!incoming.length) return existing ?? [];
  const next = existing ? existing.slice() : [];
  let offset = 0;
  if (next.length > 0) {
    const last = next[next.length - 1]!;
    const room = EVENT_CHUNK_SIZE - last.length;
    if (room > 0) {
      const take = Math.min(room, incoming.length);
      next[next.length - 1] = last.concat(incoming.slice(0, take));
      offset += take;
    }
  }
  while (offset < incoming.length) {
    next.push(incoming.slice(offset, offset + EVENT_CHUNK_SIZE));
    offset += EVENT_CHUNK_SIZE;
  }
  return next;
}

function prependToChunks(
  older: CanonicalEvent[],
  existing: CanonicalEvent[][] | undefined,
): CanonicalEvent[][] {
  const olderChunks = appendToChunks(undefined, older);
  if (!existing || !existing.length) return olderChunks;
  return olderChunks.concat(existing);
}

let activeBridgeOverride: PageBridge | undefined;

export function setChatBridge(next?: PageBridge): void {
  activeBridgeOverride = next;
}

export function getActiveBridge(): PageBridge {
  return (activeBridgeOverride ??
    (typeof window !== 'undefined' ? (window as unknown as { harnessMate: PageBridge }).harnessMate : undefined))!;
}

export const bridge = (typeof window !== 'undefined' ? (window as unknown as { harnessMate: PageBridge }).harnessMate : undefined)!;

export async function callPeer(contract: string, method: string, args: unknown[], scope: Record<string, unknown> = {}) {
  const b = getActiveBridge();
  const result = await b.services.call(contract, method, args, {
    sessionId: b.session?.id,
    workspaceId: b.session?.workspaceId ?? b.props.workspaceId,
    ...scope,
  });
  return result.value;
}

function unwrap<T>(result: { ok: boolean; value: T; error?: { message: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? '服务调用失败');
  return result.value;
}

type EarlierLoader = (sessionId: string) => Promise<boolean>;
let activeEarlierLoader: EarlierLoader | undefined;

export async function triggerLoadEarlierHistory(sessionId: string): Promise<boolean> {
  if (!activeEarlierLoader) return false;
  return activeEarlierLoader(sessionId);
}

/** Owns the page projection. The host forwards batches; it never supplies its Zustand object. */
export function startView(store: StoreApi<ChatPluginState>, bridgeOverride?: PageBridge): () => void {
  if (bridgeOverride) setChatBridge(bridgeOverride);
  const activeBridge = getActiveBridge();

  let epoch = 0;
  let releaseFeed: (() => void) | undefined;
  let releaseView: (() => void) | undefined;
  const sourceId = crypto.randomUUID();
  let disposed = false;
  let scopeKey = '';
  let activeDataProvider = '';
  let viewState: Record<string, unknown> = {};
  let persistence = Promise.resolve();
  let saveDraftTimer: ReturnType<typeof setTimeout> | undefined;
  let dirtyDraftSessionId: string | null = null;

  const flushSaveState = (sessionId: string) => {
    if (saveDraftTimer) {
      clearTimeout(saveDraftTimer);
      saveDraftTimer = undefined;
      frontendPerfDiagnostics.adjustPluginTimer(-1);
    }
    dirtyDraftSessionId = null;
    const state = store.getState();
    const patch = {
      ...viewState,
      text: state.draftTextBySession[sessionId] ?? '',
      attachments: state.draftAttachmentsBySession[sessionId] ?? [],
      terminalContexts: state.pendingTerminalChipsBySession[sessionId] ?? [],
      traitsByScope: state.traitsByScope,
    };
    persistence = persistence
      .then(() =>
        callPeer('chat.view.v1', 'writeViewState', [{ sessionId, patch, sourceId }], {
          instanceId: activeBridge.instanceId,
        }),
      )
      .then(
        () => {},
        (error) => {
          if (!disposed) store.getState().pushToast({ kind: 'error', title: '保存草稿失败', body: String(error) });
        },
      );
  };

  const scheduleSaveState = (sessionId: string, delayMs = SAVE_DEBOUNCE_MS) => {
    dirtyDraftSessionId = sessionId;
    if (saveDraftTimer) {
      clearTimeout(saveDraftTimer);
      frontendPerfDiagnostics.adjustPluginTimer(-1);
    }
    frontendPerfDiagnostics.adjustPluginTimer(1);
    saveDraftTimer = setTimeout(() => {
      saveDraftTimer = undefined;
      frontendPerfDiagnostics.adjustPluginTimer(-1);
      if (!disposed) flushSaveState(sessionId);
    }, delayMs);
  };

  let restoring = false;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  setTimelinePersistence((sessionId, position) => {
    viewState = { ...viewState, timeline: position };
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      frontendPerfDiagnostics.adjustPluginTimer(-1);
    }
    frontendPerfDiagnostics.adjustPluginTimer(1);
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined;
      frontendPerfDiagnostics.adjustPluginTimer(-1);
      flushSaveState(sessionId);
    }, 250);
  });

  const releaseStore = store.subscribe((state, prev) => {
    const id = state.selectedSessionId;
    if (
      id &&
      !restoring &&
      (state.draftTextBySession !== prev.draftTextBySession ||
        state.draftAttachmentsBySession !== prev.draftAttachmentsBySession ||
        state.pendingTerminalChipsBySession !== prev.pendingTerminalChipsBySession ||
        state.traitsByScope !== prev.traitsByScope)
    ) {
      // Flush immediately when draft is cleared (e.g. after sending), debounce while typing
      const cleared = (state.draftTextBySession[id] ?? '') === '' && (prev.draftTextBySession[id] ?? '') !== '';
      if (cleared) flushSaveState(id);
      else scheduleSaveState(id);
    }
  });

  let rafFlushId: number | null = null;
  let fallbackFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let frameBuffer: CanonicalEvent[] = [];
  let frameBufferEnqueuedAt = 0;

  const cancelFrameFlush = () => {
    if (rafFlushId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafFlushId);
      rafFlushId = null;
    }
    if (fallbackFlushTimer) {
      clearTimeout(fallbackFlushTimer);
      fallbackFlushTimer = undefined;
      frontendPerfDiagnostics.adjustPluginTimer(-1);
    }
  };

  const updateContext = async (session: PageBridge['session'], forceReload = false) => {
    const key = `${activeBridge.instanceId}:${session?.id ?? ''}`;
    if (!forceReload && scopeKey === key) return;
    if (dirtyDraftSessionId && dirtyDraftSessionId !== session?.id) {
      flushSaveState(dirtyDraftSessionId);
    }
    scopeKey = key;
    const generation = ++epoch;
    cancelFrameFlush();
    frameBuffer = [];
    frameBufferEnqueuedAt = 0;
    releaseFeed?.();
    releaseFeed = undefined;
    releaseView?.();
    releaseView = undefined;
    activeEarlierLoader = undefined;
    const current = () => !disposed && generation === epoch;

    try {
      const shell = await activeBridge.call<Partial<AppState>>('shell.snapshot');
      if (!current()) return;
      store.setState({ ...shell, selectedSessionId: null });
      if (!session) return;
      const id = session.id;
      store.setState((state) => ({
        eventsBySession: { ...state.eventsBySession, [id]: [] },
        eventChunksBySession: { ...state.eventChunksBySession, [id]: [] },
        historyMetaBySession: {
          ...state.historyMetaBySession,
          [id]: { earliestSeq: 0, hasEarlier: false, loadingEarlier: false, totalBoundarySeq: 0 },
        },
      }));
      let revision = -1;
      const applyState = (received: Record<string, any>) => {
        if (!current() || (received.revision ?? 0) < revision) return;
        revision = received.revision ?? 0;
        viewState = received;
        if (received.timeline) restoreTimelinePosition(id, received.timeline);
        restoring = true;
        store.setState((state) => ({
          draftTextBySession: { ...state.draftTextBySession, [id]: typeof received.text === 'string' ? received.text : '' },
          draftAttachmentsBySession: {
            ...state.draftAttachmentsBySession,
            [id]: Array.isArray(received.attachments) ? received.attachments : [],
          },
          pendingTerminalChipsBySession: {
            ...state.pendingTerminalChipsBySession,
            [id]: Array.isArray(received.terminalContexts) ? received.terminalContexts : [],
          },
          ...(received.traitsByScope ? { traitsByScope: received.traitsByScope } : {}),
        }));
        restoring = false;
      };

      let firstOwnBoundary = true;
      const releaseOwn = await activeBridge.services.subscribe(
        { contract: 'chat.view.v1', instanceId: activeBridge.instanceId },
        (batch) => {
          if (batch.reset) {
            if (firstOwnBoundary) {
              firstOwnBoundary = false;
            } else {
              void callPeer('chat.view.v1', 'readViewState', [{ sessionId: id }], {
                instanceId: activeBridge.instanceId,
              })
                .then((result) => applyState(unwrap<any>(result).state ?? {}))
                .catch(() => {});
            }
          }
          for (const { payload } of batch.events) {
            if (!current() || payload.sessionId !== id || payload.sourceId === sourceId || !payload.state) continue;
            applyState(payload.state);
          }
        },
      );
      if (!current()) {
        releaseOwn();
        return;
      }
      releaseView = releaseOwn;
      const own = unwrap<any>(
        await callPeer('chat.view.v1', 'readViewState', [{ sessionId: id }], {
          instanceId: activeBridge.instanceId,
        }),
      );
      applyState(own.state ?? {});
      if (!current()) return;
      store.setState({ selectedSessionId: id });

      const selection = await activeBridge.call<any>('services.resolve', {
        contract: 'session.data.v1',
        sessionId: id,
        workspaceId: session.workspaceId,
      });
      if (!current()) return;
      if (selection.status !== 'ready') throw new Error(`会话数据不可用 (${selection.status})`);
      const provider = selection.instanceId;
      activeDataProvider = provider;
      const data = async (method: string, args: unknown[]) =>
        unwrap<any>(await callPeer('session.data.v1', method, args, { instanceId: provider }));

      let loading = true;
      let queued: ServiceBatch[] = [];
      let cursor = 0;
      let earliestLoadedSeq = 0;
      let hasEarlierHistory = false;
      let loadingEarlier = false;
      let stream = '';
      let syncing: Promise<void> | undefined;
      let firstBoundary = true;
      let overflowed = false;
      const pending = new Map<number, CanonicalEvent>();

      const commitReadyEvents = (ready: CanonicalEvent[]) => {
        if (!ready.length || !current()) return;
        store.setState((state) => {
          // Structural sharing: copy only the <=256-item tail chunk (O(1) per frame, zero O(N^2) full-array copy)
          const nextChunks = appendToChunks(state.eventChunksBySession?.[id], ready);
          // Maintain eventsBySession[id] in-place for legacy tests/consumers without full-array reallocation
          const existing = state.eventsBySession[id];
          let nextFlat: CanonicalEvent[];
          if (existing) {
            existing.push(...ready);
            nextFlat = existing;
          } else {
            nextFlat = ready.slice();
          }
          return {
            eventChunksBySession: {
              ...state.eventChunksBySession,
              [id]: nextChunks,
            },
            eventsBySession: existing
              ? state.eventsBySession
              : { ...state.eventsBySession, [id]: nextFlat },
          };
        });
        const needsSessionRefresh = ready.some(
          (event) =>
            event.type === 'turn.completed' ||
            event.type === 'turn.failed' ||
            event.type === 'turn.cancelled' ||
            event.type === 'session.status' ||
            event.type === 'session.model_confirmed' ||
            event.type === 'session.harness_switched',
        );
        if (needsSessionRefresh) {
          void daemonApi
            .getSession(id)
            .then((detail) => {
              if (!current()) return;
              store.setState((state) => ({
                sessions: state.sessions.map((item) => (item.id === id ? detail.session : item)),
              }));
            })
            .catch(() => {});
        }
        if (ready.some(({ type }) => type === 'turn.completed' || type === 'turn.failed' || type === 'turn.cancelled')) {
          void store.getState().refreshTurnItems(id);
        }
      };

      const flushFrameBuffer = () => {
        cancelFrameFlush();
        if (!frameBuffer.length || !current()) {
          frameBuffer = [];
          frameBufferEnqueuedAt = 0;
          return;
        }
        const toCommit = frameBuffer;
        const backlogMs = frameBufferEnqueuedAt ? Math.max(0, Date.now() - frameBufferEnqueuedAt) : 0;
        frameBuffer = [];
        frameBufferEnqueuedAt = 0;
        frontendPerfDiagnostics.recordPluginQueue(pending.size, backlogMs, toCommit.length);
        commitReadyEvents(toCommit);
      };

      const scheduleFrameFlush = () => {
        if (rafFlushId !== null || fallbackFlushTimer !== undefined) return;
        if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
          rafFlushId = requestAnimationFrame(() => {
            rafFlushId = null;
            flushFrameBuffer();
          });
          // Safety net in case RAF is throttled in hidden Electron window
          frontendPerfDiagnostics.adjustPluginTimer(1);
          fallbackFlushTimer = setTimeout(() => {
            fallbackFlushTimer = undefined;
            frontendPerfDiagnostics.adjustPluginTimer(-1);
            flushFrameBuffer();
          }, 24);
        } else {
          flushFrameBuffer();
        }
      };

      const append = (events: CanonicalEvent[], immediate = false) => {
        for (const event of events) {
          if (event.seq > cursor && event.sessionId === id) pending.set(event.seq, event);
        }
        const ready: CanonicalEvent[] = [];
        while (pending.has(cursor + 1)) {
          ready.push(pending.get(++cursor)!);
          pending.delete(cursor);
        }
        if (!ready.length || !current()) return;
        if (immediate) {
          flushFrameBuffer();
          frontendPerfDiagnostics.recordPluginQueue(pending.size, 0, ready.length);
          commitReadyEvents(ready);
          return;
        }
        if (!frameBuffer.length) frameBufferEnqueuedAt = Date.now();
        frameBuffer.push(...ready);
        frontendPerfDiagnostics.recordPluginQueue(frameBuffer.length + pending.size);
        scheduleFrameFlush();
      };

      const sync = (): Promise<void> =>
        (syncing ??= (async () => {
          const info = await data('getStreamInfo', []);
          if (!current()) return;
          const nextStream = JSON.stringify([info.stream.providerInstanceId, info.stream.streamId, info.stream.runId]);
          if (stream && nextStream !== stream) {
            cursor = 0;
            earliestLoadedSeq = 0;
            hasEarlierHistory = false;
            pending.clear();
            cancelFrameFlush();
            frameBuffer = [];
            store.setState((state) => ({
              eventsBySession: { ...state.eventsBySession, [id]: [] },
              eventChunksBySession: { ...state.eventChunksBySession, [id]: [] },
            }));
          }
          stream = nextStream;
          const detail = await data('getSession', [{ sessionId: id }]);
          const boundary = detail.session?.lastSeq ?? 0;

          if (cursor === 0 && boundary > INITIAL_TAIL_EVENTS) {
            // Snapshot-boundary tail pagination: load only the latest tail window first (covering recent turns even if
            // trailing metadata events exist), then stitch seamlessly with live stream > boundary.
            const page = await data('listEvents', [
              {
                sessionId: id,
                throughSeq: boundary,
                beforeSeq: boundary + 1,
                tail: true,
                minTurnEvents: 160,
                limit: INITIAL_TAIL_EVENTS,
              },
            ]);
            if (!current()) return;
            const pageEvents = (page.events ?? []) as CanonicalEvent[];
            if (pageEvents.length > 0) {
              const firstSeq = pageEvents[0]!.seq;
              const lastSeq = pageEvents[pageEvents.length - 1]!.seq;
              // Ensure provider honored tail pagination cleanly; otherwise fall back to forward pagination
              if (lastSeq >= boundary || page.earliestSeq !== undefined) {
                earliestLoadedSeq = firstSeq;
                hasEarlierHistory = page.hasEarlier ?? firstSeq > 1;
                cursor = firstSeq - 1;
                store.setState((state) => ({
                  historyMetaBySession: {
                    ...state.historyMetaBySession,
                    [id]: {
                      earliestSeq: earliestLoadedSeq,
                      hasEarlier: hasEarlierHistory,
                      loadingEarlier: false,
                      totalBoundarySeq: boundary,
                    },
                  },
                }));
                append(pageEvents, true);
                // If somehow boundary > lastSeq, catch up the tiny remaining gap
                let afterSeq = cursor;
                const extra: CanonicalEvent[] = [];
                while (afterSeq < boundary && current()) {
                  const gapPage = await data('listEvents', [
                    { sessionId: id, afterSeq, throughSeq: boundary, limit: 1000 },
                  ]);
                  if (!gapPage.events.length) break;
                  extra.push(...gapPage.events);
                  const next = gapPage.events.at(-1).seq;
                  if (next <= afterSeq) break;
                  afterSeq = next;
                }
                if (extra.length && current()) append(extra, true);
                return;
              }
            }
          }

          let afterSeq = cursor;
          const history: CanonicalEvent[] = [];
          while (afterSeq < boundary && current()) {
            const page = await data('listEvents', [
              { sessionId: id, afterSeq, throughSeq: boundary, limit: 1000 },
            ]);
            if (!page.events.length) throw new Error(`事件存在间隙: ${afterSeq}/${boundary}`);
            history.push(...page.events);
            const next = page.events.at(-1).seq;
            if (next <= afterSeq) throw new Error('事件游标没有前进');
            afterSeq = next;
          }
          if (!current()) return;
          if (history.length > 0 && earliestLoadedSeq === 0) {
            earliestLoadedSeq = history[0]!.seq;
            hasEarlierHistory = earliestLoadedSeq > 1;
            store.setState((state) => ({
              historyMetaBySession: {
                ...state.historyMetaBySession,
                [id]: {
                  earliestSeq: earliestLoadedSeq,
                  hasEarlier: hasEarlierHistory,
                  loadingEarlier: false,
                  totalBoundarySeq: boundary,
                },
              },
            }));
          }
          append(history, true);
        })().finally(() => {
          syncing = undefined;
        }));

      activeEarlierLoader = async (targetSessionId: string): Promise<boolean> => {
        if (!current() || targetSessionId !== id || !hasEarlierHistory || loadingEarlier || earliestLoadedSeq <= 1) {
          return false;
        }
        loadingEarlier = true;
        store.setState((state) => ({
          historyMetaBySession: {
            ...state.historyMetaBySession,
            [id]: {
              ...(state.historyMetaBySession[id] ?? {
                earliestSeq: earliestLoadedSeq,
                hasEarlier: hasEarlierHistory,
                totalBoundarySeq: cursor,
              }),
              loadingEarlier: true,
            },
          },
        }));
        try {
          const page = await data('listEvents', [
            { sessionId: id, beforeSeq: earliestLoadedSeq, tail: true, limit: EARLIER_PAGE_EVENTS },
          ]);
          if (!current()) return false;
          const older = ((page.events ?? []) as CanonicalEvent[]).filter(
            (ev) => ev.sessionId === id && ev.seq < earliestLoadedSeq,
          );
          if (!older.length) {
            hasEarlierHistory = false;
          } else {
            earliestLoadedSeq = older[0]!.seq;
            hasEarlierHistory = page.hasEarlier ?? earliestLoadedSeq > 1;
            store.setState((state) => {
              const existing = state.eventsBySession[id] ?? [];
              return {
                eventChunksBySession: {
                  ...state.eventChunksBySession,
                  [id]: prependToChunks(older, state.eventChunksBySession?.[id]),
                },
                eventsBySession: {
                  ...state.eventsBySession,
                  [id]: older.concat(existing),
                },
              };
            });
          }
          store.setState((state) => ({
            historyMetaBySession: {
              ...state.historyMetaBySession,
              [id]: {
                earliestSeq: earliestLoadedSeq,
                hasEarlier: hasEarlierHistory,
                loadingEarlier: false,
                totalBoundarySeq: state.historyMetaBySession[id]?.totalBoundarySeq ?? cursor,
              },
            },
          }));
          return older.length > 0;
        } catch {
          if (current()) {
            store.setState((state) => ({
              historyMetaBySession: {
                ...state.historyMetaBySession,
                [id]: {
                  ...(state.historyMetaBySession[id] ?? {
                    earliestSeq: earliestLoadedSeq,
                    hasEarlier: hasEarlierHistory,
                    totalBoundarySeq: cursor,
                  }),
                  loadingEarlier: false,
                },
              },
            }));
          }
          return false;
        } finally {
          loadingEarlier = false;
        }
      };

      const consume = (batch: ServiceBatch) => {
        if (!current()) return;
        const pluginReceivedAt = Date.now();
        if (batch.reset && firstBoundary) {
          firstBoundary = false;
          return;
        }
        if (loading) {
          if (queued.length < 512) queued.push(batch);
          else {
            queued = [];
            overflowed = true;
          }
          frontendPerfDiagnostics.recordPluginQueue(queued.length);
          return;
        }
        if (batch.reset) {
          void sync().catch(report);
          return;
        }
        if (typeof window !== 'undefined' && (window as unknown as { __HM_REPLAY_BATCH_HOOK__?: (b: ServiceBatch, at: number) => void }).__HM_REPLAY_BATCH_HOOK__) {
          (window as unknown as { __HM_REPLAY_BATCH_HOOK__: (b: ServiceBatch, at: number) => void }).__HM_REPLAY_BATCH_HOOK__(batch, pluginReceivedAt);
        }
        const events = batch.events.flatMap(({ payload }) =>
          payload.sessionId === id && Array.isArray(payload.events) ? payload.events : [],
        ) as CanonicalEvent[];
        if (!events.length) return;
        append(events);
        if (pending.size) void sync().catch(report);
      };

      const report = (error: unknown) => {
        if (current()) store.getState().pushToast({ kind: 'error', title: '聊天同步失败', body: String(error) });
      };
      const release = await activeBridge.services.subscribe(
        { contract: 'session.data.v1', instanceId: provider },
        consume,
      );
      if (!current()) {
        release();
        return;
      }
      releaseFeed = release;
      await sync();
      if (!current()) return;
      loading = false;
      const initial = queued;
      queued = [];
      for (const batch of initial) consume(batch);
      if (overflowed) await sync();
      void store.getState().refreshTurnItems(id);
      void store.getState().refreshContextPreview(id);
    } catch (error) {
      if (current()) store.getState().pushToast({ kind: 'error', title: '加载聊天失败', body: String(error) });
    }
  };

  const handleShellPatch = (patch: Record<string, unknown>) => {
    const { selectedSessionId: _selected, ...rest } = patch;
    store.setState(rest as Partial<AppState>);
    if (
      patch.workspaceBindingsByWorkspace ||
      patch.sessionBindingsBySession ||
      patch.compositionBindings ||
      patch.plugins
    ) {
      const currentSession = activeBridge.session;
      if (!currentSession || !activeDataProvider) return;
      // Only re-sync if the resolved session.data.v1 provider instance actually changed!
      void activeBridge
        .call<any>('services.resolve', {
          contract: 'session.data.v1',
          sessionId: currentSession.id,
          workspaceId: currentSession.workspaceId,
        })
        .then((res) => {
          if (disposed || !activeDataProvider) return;
          const nextProvider = res?.status === 'ready' ? res.instanceId : '';
          if (nextProvider !== activeDataProvider) {
            scopeKey = '';
            void updateContext(activeBridge.session, true);
          }
        })
        .catch(() => {});
    }
  };

  const handleCommandOutput = (frame: Extract<WsServerFrame, { op: 'command_output' }>) => {
    const key = `${frame.sessionId}::${frame.toolCallId}`;
    store.setState((state) => ({
      liveCommandOutputByKey: {
        ...state.liveCommandOutputByKey,
        [key]: {
          text: frame.snapshot ? frame.chunk : (state.liveCommandOutputByKey[key]?.text ?? '') + frame.chunk,
          done: Boolean(frame.done),
          updatedAt: frame.timestamp,
        },
      },
    }));
  };

  const releaseContext = activeBridge.onContext((session) => {
    void updateContext(session);
  });

  let releaseShell: (() => void) | undefined;
  let releaseOutput: (() => void) | undefined;
  let onMessage: ((event: MessageEvent) => void) | undefined;

  if (typeof activeBridge.onShellState === 'function') {
    releaseShell = activeBridge.onShellState(handleShellPatch);
    releaseOutput = activeBridge.onCommandOutput?.(handleCommandOutput);
  } else if (typeof window !== 'undefined') {
    onMessage = (event: MessageEvent) => {
      if (event.source !== parent || event.data?.runId !== activeBridge.runId) return;
      if (event.data.type === 'hm:shell:state') handleShellPatch(event.data.patch);
      if (event.data.type === 'hm:output') handleCommandOutput(event.data.frame);
    };
    window.addEventListener('message', onMessage);
  }

  void updateContext(activeBridge.session);

  return () => {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = undefined;
      frontendPerfDiagnostics.adjustPluginTimer(-1);
    }
    if (saveDraftTimer) {
      clearTimeout(saveDraftTimer);
      saveDraftTimer = undefined;
      frontendPerfDiagnostics.adjustPluginTimer(-1);
    }
    cancelFrameFlush();
    const id = store.getState().selectedSessionId;
    if (id && dirtyDraftSessionId === id) flushSaveState(id);
    setTimelinePersistence();
    disposed = true;
    ++epoch;
    activeEarlierLoader = undefined;
    releaseFeed?.();
    releaseView?.();
    releaseContext();
    releaseStore();
    releaseShell?.();
    releaseOutput?.();
    if (onMessage && typeof window !== 'undefined') {
      window.removeEventListener('message', onMessage);
    }
  };
}
