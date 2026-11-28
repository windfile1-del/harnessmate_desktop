import { create } from 'zustand';
import type { RuntimeRequestDto, RequestModeReceiptDto } from '@harnessmate/plugin-api';
import type { Session } from '@harnessmate/protocol';

type Bridge = {
  session: Session | null;
  onContext(fn: (session: Session | null) => void): () => void;
  services: {
    call(contract: string, method: string, args: unknown[], options?: unknown): Promise<{ value: unknown }>;
    subscribe(options: unknown, fn: (batch: unknown) => void): Promise<() => void>;
  };
};
let activeRequestBridgeOverride: Bridge | undefined;
export function setRequestViewBridge(bridge?: Bridge) {
  activeRequestBridgeOverride = bridge;
}
export function getActiveRequestBridge(): Bridge | undefined {
  return activeRequestBridgeOverride ?? (typeof window === 'undefined' ? undefined : (window as unknown as { harnessMate?: Bridge }).harnessMate);
}
export const requestBridge = typeof window === 'undefined' ? undefined : (window as unknown as { harnessMate?: Bridge }).harnessMate;
export async function requestCall<T>(method: string, input: unknown): Promise<T> {
  const active = getActiveRequestBridge();
  if (!active) throw new Error('请求插件连接不可用');
  const response = await active.services.call('runtime.requests.v1', method, [input]);
  const result = response.value as { ok: boolean; value: T; error?: { message: string } };
  if (!result?.ok) throw new Error(result?.error?.message ?? '请求服务不可用');
  return result.value;
}
export const useRequestViewStore = create<{
  session: Session | null;
  requests: RuntimeRequestDto[];
  mode: RequestModeReceiptDto | null;
  error: string | null;
  pushToast: (input: { title: string; body?: string; kind?: string }) => void;
  refresh: () => Promise<void>;
}>((set, get) => ({
  session: requestBridge?.session ?? null, requests: [], mode: null, error: null,
  pushToast: input => set({ error: input.body ?? input.title }),
  refresh: async () => {
    try {
      const sessionId = get().session?.id;
      const [snapshot, mode] = await Promise.all([
        requestCall<{ requests: RuntimeRequestDto[] }>('snapshot', { includeHistory: true }),
        sessionId ? requestCall<RequestModeReceiptDto | null>('getMode', { sessionId }) : null,
      ]);
      set({ requests: snapshot.requests, mode, error: null });
    } catch (error) { set({ requests: [], error: error instanceof Error ? error.message : String(error) }); }
  },
}));
export function startRequestView(bridgeOverride?: Bridge) {
  const activeBridge = bridgeOverride ?? getActiveRequestBridge();
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastSessionKey = '';
  let inFlight = false;
  let queued = false;

  const syncTimer = () => {
    const hasPending = useRequestViewStore.getState().requests.some((r) => r.status === 'pending');
    if (hasPending && !timer && !stopped) {
      // Deadline and missed-event correction ONLY while pending requests exist.
      timer = setInterval(refresh, 2000);
    } else if ((!hasPending || stopped) && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const refresh = () => {
    if (stopped) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    void useRequestViewStore.getState().refresh().finally(() => {
      inFlight = false;
      syncTimer();
      if (queued && !stopped) {
        queued = false;
        refresh();
      }
    });
  };

  const context = activeBridge?.onContext((session) => {
    const nextKey = `${session?.id ?? ''}:${session?.permissionMode ?? ''}:${session?.pendingApprovalCount ?? 0}`;
    if (nextKey === lastSessionKey) return;
    lastSessionKey = nextKey;
    useRequestViewStore.setState({ session });
    refresh();
  });
  void activeBridge?.services.subscribe({ contract: 'runtime.requests.v1' }, refresh).then((dispose) => {
    if (stopped) dispose();
    else unsubscribe = dispose;
  });
  useRequestViewStore.setState({ session: activeBridge?.session ?? null });
  refresh();
  return () => {
    stopped = true;
    if (timer) { clearInterval(timer); timer = undefined; }
    unsubscribe?.();
    context?.();
    useRequestViewStore.setState({ requests: [], mode: null, error: null });
  };
}
