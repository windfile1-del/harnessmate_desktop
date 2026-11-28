import { createStore } from 'zustand';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldUseTrustedModuleMount } from '../src/slots/BoundSessionSurface';
import { ensureSharedPluginRuntime } from '../src/slots/shared-runtime';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('B4-W3 trusted frontend module mount & shared runtime', () => {
  it('gates trusted-module mount cleanly and preserves iframe fallback', () => {
    const basePlugin: any = {
      id: 'hm.plugin.chat-default',
      enabled: true,
      runtimeState: 'ACTIVE',
    };
    expect(shouldUseTrustedModuleMount(basePlugin, { module: 'ui/module.mjs' })).toBe(true);
    expect(shouldUseTrustedModuleMount(basePlugin, { module: undefined })).toBe(false);
    expect(shouldUseTrustedModuleMount(basePlugin, { module: 'ui/module.mjs', mountMode: 'iframe' })).toBe(false);
    expect(shouldUseTrustedModuleMount({ ...basePlugin, enabled: false }, { module: 'ui/module.mjs' })).toBe(false);
    expect(shouldUseTrustedModuleMount({ ...basePlugin, runtimeState: 'FAILED' }, { module: 'ui/module.mjs' })).toBe(false);

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'hm_force_iframe_mount' ? '1' : null),
    });
    expect(shouldUseTrustedModuleMount(basePlugin, { module: 'ui/module.mjs' })).toBe(false);
  });

  it('exposes frozen shared runtime without leaking host private store', () => {
    const w: Record<string, unknown> = {};
    vi.stubGlobal('window', w);
    const rt = ensureSharedPluginRuntime();
    expect(Object.isFrozen(rt)).toBe(true);
    expect(rt.version).toBe('1.0.0');
    expect(typeof rt.react.createElement).toBe('function');
    expect(typeof rt.zustand.create).toBe('function');
    expect('useAppStore' in (rt as unknown as Record<string, unknown>)).toBe(false);
    expect(w.__HARNESSMATE_PLUGIN_RUNTIME__).toBe(rt);
  });
});

describe('B4-W3 chat tail pagination & live stitching', () => {
  it('loads tail boundary first, skips redundant initial readViewState, stitches live events, and pages earlier on demand', async () => {
    const listeners = new Map<string, (batch: any) => void>();
    const release = vi.fn();
    const mk = (seq: number) => ({
      sessionId: 's',
      seq,
      type: 'message.assistant.completed',
      payload: { text: `msg-${seq}` },
      turnId: `t-${seq}`,
      createdAt: seq,
    });
    const tailEvents = Array.from({ length: 400 }, (_, i) => mk(601 + i));
    const earlierEvents = Array.from({ length: 400 }, (_, i) => mk(201 + i));

    let readViewCount = 0;
    const bridge = {
      instanceId: 'chat',
      runId: 'gen1',
      session: { id: 's', workspaceId: 'w' },
      props: {},
      onContext: () => release,
      call: vi.fn(async (method: string) =>
        method === 'shell.snapshot'
          ? { sessions: [{ id: 's' }], selectedSessionId: 's' }
          : { status: 'ready', instanceId: 'data' },
      ),
      services: {
        subscribe: vi.fn(async (options: any, callback: (batch: any) => void) => {
          listeners.set(options.contract, callback);
          callback({ reset: true, events: [] });
          return release;
        }),
        call: vi.fn(async (_contract: string, method: string, args: any[]) => {
          if (method === 'readViewState') {
            readViewCount += 1;
            return { value: { ok: true, value: { state: { text: 'saved', revision: 1 } } } };
          }
          if (method === 'getStreamInfo') {
            return {
              value: { ok: true, value: { stream: { providerInstanceId: 'data', streamId: 'main', runId: 'r1' } } },
            };
          }
          if (method === 'getSession') {
            return { value: { ok: true, value: { session: { lastSeq: 1000 } } } };
          }
          if (method === 'listEvents') {
            const req = args[0];
            if (req.tail && req.beforeSeq === 1001) {
              // Live race during tail fetch: seq 1000 duplicate + 1001 new
              listeners.get('session.data.v1')!({ events: [{ payload: { sessionId: 's', events: [mk(1000), mk(1001)] } }] });
              return { value: { ok: true, value: { events: tailEvents, earliestSeq: 601, hasEarlier: true } } };
            }
            if (req.tail && req.beforeSeq === 601) {
              return { value: { ok: true, value: { events: earlierEvents, earliestSeq: 201, hasEarlier: true } } };
            }
          }
          return { value: { ok: true, value: {} } };
        }),
      },
    };

    vi.stubGlobal('window', { harnessMate: bridge, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const store = createStore<any>(() => ({
      selectedSessionId: null,
      sessions: [],
      draftTextBySession: {},
      draftAttachmentsBySession: {},
      pendingTerminalChipsBySession: {},
      eventsBySession: {},
      historyMetaBySession: {},
      traitsByScope: {},
      refreshTurnItems: vi.fn(),
      refreshPendingApprovals: vi.fn(),
      refreshContextPreview: vi.fn(),
      pushToast: vi.fn(),
      loadEarlierHistory: vi.fn(),
    }));

    const { startView, triggerLoadEarlierHistory } = await import('../src/plugins/chat-default/transport');
    const dispose = startView(store);

    await vi.waitFor(() => expect(store.getState().eventsBySession.s?.length).toBe(401));
    expect(readViewCount).toBe(1);
    expect(store.getState().eventsBySession.s[0].seq).toBe(601);
    expect(store.getState().eventsBySession.s.at(-1).seq).toBe(1001);
    expect(store.getState().historyMetaBySession.s).toMatchObject({
      earliestSeq: 601,
      hasEarlier: true,
    });

    // Load earlier page cleanly prepends seq 201..600 without losing seq 1001
    const loaded = await triggerLoadEarlierHistory('s');
    expect(loaded).toBe(true);
    expect(store.getState().eventsBySession.s).toHaveLength(801);
    expect(store.getState().eventsBySession.s[0].seq).toBe(201);
    expect(store.getState().eventsBySession.s[400].seq).toBe(601);
    expect(store.getState().eventsBySession.s.at(-1).seq).toBe(1001);
    expect(store.getState().historyMetaBySession.s.earliestSeq).toBe(201);

    dispose();
  });
});
