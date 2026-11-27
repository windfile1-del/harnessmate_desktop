import type { StoreApi } from 'zustand';
import type { AppState } from '../../stores/app-store';
import type { CanonicalEvent } from '@harnessmate/protocol';
import { daemonApi, type ServiceBatch } from '../../api/client';
import { restoreTimelinePosition, setTimelinePersistence } from './work-groups';

interface PageBridge {
  instanceId: string;
  session: { id: string; workspaceId: string } | null;
  props: Record<string, unknown>;
  call<T = any>(method: string, params?: unknown): Promise<T>;
  navigateToFile(params: unknown): Promise<unknown>;
  onContext(listener: (session: PageBridge['session'], props: Record<string, unknown>) => void): () => void;
  services: {
    call(contract: string, method: string, args: unknown[], options?: unknown): Promise<{ value: any }>;
    subscribe(options: unknown, listener: (batch: ServiceBatch) => void): Promise<() => void>;
  };
}

export const bridge = (typeof window !== 'undefined' ? (window as unknown as { harnessMate: PageBridge }).harnessMate : undefined)!;
export async function callPeer(contract: string, method: string, args: unknown[], scope: Record<string, unknown> = {}) {
  const result = await bridge.services.call(contract, method, args, {
    sessionId: bridge.session?.id, workspaceId: bridge.session?.workspaceId ?? bridge.props.workspaceId, ...scope,
  });
  return result.value;
}

function unwrap<T>(result: { ok: boolean; value: T; error?: { message: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? '服务调用失败');
  return result.value;
}

/** Owns the page projection. The host forwards batches; it never supplies its Zustand object. */
export function startView(store: StoreApi<AppState>): () => void {
  let epoch = 0;
  let releaseFeed: (() => void) | undefined;
  let releaseView: (() => void) | undefined;
  const sourceId = crypto.randomUUID();
  let disposed = false;
  let scopeKey = '';
  let viewState: Record<string, unknown> = {};
  let persistence = Promise.resolve();
  const saveState = (sessionId: string) => {
    const state = store.getState();
    const patch = { ...viewState, text: state.draftTextBySession[sessionId] ?? '',
      attachments: state.draftAttachmentsBySession[sessionId] ?? [],
      terminalContexts: state.pendingTerminalChipsBySession[sessionId] ?? [],
      traitsByScope: state.traitsByScope };
    persistence = persistence.then(() => callPeer('chat.view.v1', 'writeViewState', [{ sessionId, patch, sourceId }],
      { instanceId: bridge.instanceId })).then(() => {}, (error) => {
        if (!disposed) store.getState().pushToast({ kind: 'error', title: '保存草稿失败', body: String(error) });
      });
  };
  let restoring = false;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  setTimelinePersistence((sessionId, position) => {
    viewState = { ...viewState, timeline: position };
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => saveState(sessionId), 150);
  });
  const releaseStore = store.subscribe((state, prev) => {
    const id = state.selectedSessionId;
    if (id && !restoring && (state.draftTextBySession !== prev.draftTextBySession
      || state.draftAttachmentsBySession !== prev.draftAttachmentsBySession
      || state.pendingTerminalChipsBySession !== prev.pendingTerminalChipsBySession
      || state.traitsByScope !== prev.traitsByScope)) saveState(id);
  });

  const updateContext = async (session: PageBridge['session']) => {
    const key = `${bridge.instanceId}:${session?.id ?? ''}`;
    if (scopeKey === key) return;
    scopeKey = key;
    const generation = ++epoch;
    releaseFeed?.(); releaseFeed = undefined;
    releaseView?.(); releaseView = undefined;
    const current = () => !disposed && generation === epoch;
    try {
      const shell = await bridge.call<Partial<AppState>>('shell.snapshot');
      if (!current()) return;
      store.setState({ ...shell, selectedSessionId: null });
      if (!session) return;
      const id = session.id;
      store.setState(state => ({ eventsBySession: { ...state.eventsBySession, [id]: [] } }));
      let revision = -1;
      const applyState = (received: Record<string, any>) => {
        if (!current() || (received.revision ?? 0) < revision) return;
        revision = received.revision ?? 0;
        viewState = received;
        if (received.timeline) restoreTimelinePosition(id, received.timeline);
        restoring = true;
        store.setState((state) => ({
          draftTextBySession: { ...state.draftTextBySession, [id]: typeof received.text === 'string' ? received.text : '' },
          draftAttachmentsBySession: { ...state.draftAttachmentsBySession, [id]: Array.isArray(received.attachments) ? received.attachments : [] },
          pendingTerminalChipsBySession: { ...state.pendingTerminalChipsBySession, [id]: Array.isArray(received.terminalContexts) ? received.terminalContexts : [] },
          ...(received.traitsByScope ? { traitsByScope: received.traitsByScope } : {}),
        }));
        restoring = false;
      };
      const releaseOwn = await bridge.services.subscribe({ contract: 'chat.view.v1', instanceId: bridge.instanceId }, (batch) => {
        if (batch.reset) void callPeer('chat.view.v1', 'readViewState', [{ sessionId: id }], { instanceId: bridge.instanceId })
          .then(result => applyState(unwrap<any>(result).state ?? {})).catch(() => {});
        for (const { payload } of batch.events) {
          if (!current() || payload.sessionId !== id || payload.sourceId === sourceId || !payload.state) continue;
          applyState(payload.state);
        }
      });
      if (!current()) { releaseOwn(); return; }
      releaseView = releaseOwn;
      const own = unwrap<any>(await callPeer('chat.view.v1', 'readViewState', [{ sessionId: id }], { instanceId: bridge.instanceId }));
      applyState(own.state ?? {});
      if (!current()) return;
      store.setState({ selectedSessionId: id });
      const selection = await bridge.call<any>('services.resolve', { contract: 'session.data.v1', sessionId: id, workspaceId: session.workspaceId });
      if (!current()) return;
      if (selection.status !== 'ready') throw new Error(`会话数据不可用 (${selection.status})`);
      const provider = selection.instanceId;
      const data = async (method: string, args: unknown[]) => unwrap<any>(await callPeer('session.data.v1', method, args, { instanceId: provider }));
      let loading = true;
      let queued: ServiceBatch[] = [];
      let cursor = 0;
      let stream = '';
      let syncing: Promise<void> | undefined;
      let firstBoundary = true;
      let overflowed = false;
      const pending = new Map<number, CanonicalEvent>();
      const append = (events: CanonicalEvent[]) => {
        for (const event of events) if (event.seq > cursor && event.sessionId === id) pending.set(event.seq, event);
        const ready: CanonicalEvent[] = [];
        while (pending.has(cursor + 1)) { ready.push(pending.get(++cursor)!); pending.delete(cursor); }
        if (!ready.length || !current()) return;
        store.setState((state) => ({ eventsBySession: { ...state.eventsBySession,
          [id]: [...(state.eventsBySession[id] ?? []), ...ready] } }));
        if (ready.some((event) => !event.type.endsWith('.delta'))) {
          void daemonApi.getSession(id).then((detail) => {
            if (!current()) return;
            store.setState((state) => ({ sessions: state.sessions.map((item) => item.id === id ? detail.session : item) }));
          }).catch(() => {});
        }
        if (ready.some(({ type }) => type === 'turn.completed' || type === 'turn.failed' || type === 'turn.cancelled')) {
          void store.getState().refreshTurnItems(id);
          void store.getState().refreshPendingApprovals();
        }
      };
      const sync = (): Promise<void> => syncing ??= (async () => {
        const info = await data('getStreamInfo', []);
        if (!current()) return;
        const nextStream = JSON.stringify([info.stream.providerInstanceId, info.stream.streamId, info.stream.runId]);
        if (stream && nextStream !== stream) {
          cursor = 0; pending.clear();
          store.setState((state) => ({ eventsBySession: { ...state.eventsBySession, [id]: [] } }));
        }
        stream = nextStream;
        const detail = await data('getSession', [{ sessionId: id }]);
        const boundary = detail.session?.lastSeq ?? 0;
        let afterSeq = cursor;
        const history: CanonicalEvent[] = [];
        while (afterSeq < boundary && current()) {
          const page = await data('listEvents', [{ sessionId: id, afterSeq, throughSeq: boundary, limit: 1000 }]);
          if (!page.events.length) throw new Error(`事件存在间隙: ${afterSeq}/${boundary}`);
          history.push(...page.events);
          const next = page.events.at(-1).seq;
          if (next <= afterSeq) throw new Error('事件游标没有前进');
          afterSeq = next;
        }
        if (!current()) return;
        append(history);
      })().finally(() => { syncing = undefined; });
      const consume = (batch: ServiceBatch) => {
        if (!current()) return;
        if (batch.reset && firstBoundary) { firstBoundary = false; return; }
        if (loading) {
          if (queued.length < 512) queued.push(batch);
          else { queued = []; overflowed = true; }
          return;
        }
        if (batch.reset) { void sync().catch(report); return; }
        const events = batch.events.flatMap(({ payload }) => payload.sessionId === id && Array.isArray(payload.events) ? payload.events : []) as CanonicalEvent[];
        append(events);
        if (pending.size) void sync().catch(report);
      };
      const report = (error: unknown) => { if (current()) store.getState().pushToast({ kind: 'error', title: '聊天同步失败', body: String(error) }); };
      const release = await bridge.services.subscribe({ contract: 'session.data.v1', instanceId: provider }, consume);
      if (!current()) { release(); return; }
      releaseFeed = release;
      await sync();
      if (!current()) return;
      loading = false;
      const initial = queued; queued = [];
      for (const batch of initial) consume(batch);
      if (overflowed) await sync();
      void store.getState().refreshTurnItems(id);
      void store.getState().refreshPendingApprovals();
      void store.getState().refreshContextPreview(id);
    } catch (error) {
      if (current()) store.getState().pushToast({ kind: 'error', title: '加载聊天失败', body: String(error) });
    }
  };
  const releaseContext = bridge.onContext((session) => { void updateContext(session); });
  const onMessage = (event: MessageEvent) => {
    if (event.source !== parent || event.data?.runId !== (bridge as unknown as { runId: string }).runId) return;
    if (event.data.type === 'hm:shell:state') {
      const { selectedSessionId: _selected, ...patch } = event.data.patch;
      store.setState(patch);
      if (patch.workspaceBindingsByWorkspace || patch.sessionBindingsBySession || patch.compositionBindings || patch.plugins) {
        scopeKey = '';
        void updateContext(bridge.session);
      }
    }
    if (event.data.type === 'hm:output') {
      const frame = event.data.frame;
      const key = `${frame.sessionId}::${frame.toolCallId}`;
      store.setState((state) => ({ liveCommandOutputByKey: { ...state.liveCommandOutputByKey, [key]: {
        text: frame.snapshot ? frame.chunk : (state.liveCommandOutputByKey[key]?.text ?? '') + frame.chunk,
        done: Boolean(frame.done), updatedAt: frame.timestamp,
      } } }));
    }
  };
  window.addEventListener('message', onMessage);
  void updateContext(bridge.session);
  return () => { clearTimeout(scrollTimer); const id = store.getState().selectedSessionId; if (id) saveState(id); setTimelinePersistence(); disposed = true; ++epoch; releaseFeed?.(); releaseView?.(); releaseContext(); releaseStore(); window.removeEventListener('message', onMessage); };
}
