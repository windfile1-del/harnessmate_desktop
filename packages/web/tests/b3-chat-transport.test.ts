import { createStore } from 'zustand';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('subscribes before the history boundary, deduplicates live races, restores the newer draft and cancels on unmount', async () => {
  const listeners = new Map<string, (batch: any) => void>();
  const release = vi.fn();
  const e = (seq: number) => ({ sessionId: 's', seq, type: 'message.assistant.delta', payload: { text: String(seq) }, turnId: 't', createdAt: seq });
  const bridge = {
    instanceId: 'chat', runId: 'generation', session: { id: 's', workspaceId: 'w' }, props: {},
    onContext: () => release,
    call: vi.fn(async (method: string) => method === 'shell.snapshot'
      ? { sessions: [{ id: 's' }], selectedSessionId: 's' } : { status: 'ready', instanceId: 'data' }),
    services: {
      subscribe: vi.fn(async (options: any, callback: (batch: any) => void) => {
        listeners.set(options.contract, callback);
        if (options.contract === 'chat.view.v1') callback({ events: [{ payload: { sessionId: 's', state: { text: 'new draft', revision: 2 } } }] });
        else callback({ reset: true, events: [] });
        return release;
      }),
      call: vi.fn(async (contract: string, method: string) => {
        let value: any;
        if (method === 'readViewState') value = { state: { text: 'old snapshot', revision: 1 } };
        if (method === 'getStreamInfo') value = { stream: { providerInstanceId: 'data', streamId: 'stream', runId: 'data-run' } };
        if (method === 'getSession') value = { session: { lastSeq: 2 } };
        if (method === 'listEvents') {
          expect(listeners.has('session.data.v1')).toBe(true);
          listeners.get('session.data.v1')!({ events: [{ payload: { sessionId: 's', events: [e(2), e(3)] } }] });
          value = { events: [e(1), e(2)] };
        }
        return { value: { ok: true, value } };
      }),
    },
  };
  vi.stubGlobal('window', { harnessMate: bridge, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const store = createStore<any>(() => ({
    selectedSessionId: null, sessions: [], draftTextBySession: {}, draftAttachmentsBySession: {},
    pendingTerminalChipsBySession: {}, eventsBySession: {}, traitsByScope: {},
    refreshTurnItems: vi.fn(), refreshPendingApprovals: vi.fn(), refreshContextPreview: vi.fn(), pushToast: vi.fn(),
  }));
  const { startView } = await import('../src/plugins/chat-default/transport');
  const dispose = startView(store);
  await vi.waitFor(() => expect(store.getState().eventsBySession.s?.length).toBe(3));
  expect(store.getState().eventsBySession.s.map((event: any) => event.seq)).toEqual([1, 2, 3]);
  expect(store.getState().draftTextBySession.s).toBe('new draft');
  expect(bridge.services.call.mock.calls.some(call => call[1] === 'sendTurn')).toBe(false);
  dispose();
  expect(release).toHaveBeenCalledTimes(3);
  listeners.get('session.data.v1')!({ events: [{ payload: { sessionId: 's', events: [e(4)] } }] });
  expect(store.getState().eventsBySession.s).toHaveLength(3);
});
