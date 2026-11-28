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
export const requestBridge = typeof window === 'undefined' ? undefined : (window as unknown as { harnessMate?: Bridge }).harnessMate;
export async function requestCall<T>(method: string, input: unknown): Promise<T> {
  if (!requestBridge) throw new Error('请求插件连接不可用');
  const response = await requestBridge.services.call('runtime.requests.v1', method, [input]);
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
export function startRequestView() {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  const refresh = () => { if (!stopped) void useRequestViewStore.getState().refresh(); };
  const context = requestBridge?.onContext(session => { useRequestViewStore.setState({ session }); refresh(); });
  void requestBridge?.services.subscribe({ contract: 'runtime.requests.v1' }, refresh).then(dispose => { if (stopped) dispose(); else unsubscribe = dispose; });
  // Deadline and missed-event correction, with complete disposal when UI is stopped.
  const timer = setInterval(refresh, 2000);
  refresh();
  return () => { stopped = true; clearInterval(timer); unsubscribe?.(); context?.(); useRequestViewStore.setState({ requests: [], mode: null }); };
}
