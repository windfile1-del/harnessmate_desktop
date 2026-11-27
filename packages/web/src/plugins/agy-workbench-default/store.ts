import type {
  AgyAuthState,
  ResolveApprovalRequest,
  Session,
} from '@harnessmate/protocol';
import { create } from 'zustand';
import {
  DEFAULT_WORKBENCH_ROUTE,
  type WorkbenchRouteState,
} from '../../components/agy/native/shared/workbench-registry';
import {
  applyNativeEventBatch,
  createNativeIdempotencyKey,
  defaultNativeTransport,
  NativeClientError,
  type ActivityId,
  type CapabilityDescriptor,
  type NativeAgentId,
  type NativeCanonicalEvent,
  type NativeCommandSubmitRequest,
  type NativeControlRequest,
  type NativeFeedSyncState,
  type NativeRuntimeProjection,
  type NativeRuntimeTransport,
  type NativeTimelinePageResponse,
  type NativeWorkflowResourcePageResponse,
  type RuntimeBinding,
  type WorkflowId,
} from '../../lib/native-client';
import type { AppState, NativeSessionRuntimeSlice, ToastNotice } from '../../stores/app-store';

export interface WorkbenchBridge {
  instanceId: string;
  slotId: string;
  slot: string;
  session: Session | null;
  props: Record<string, unknown>;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  onContext(listener: (session: Session | null, props: Record<string, unknown>) => void): () => void;
  services: {
    call(contract: string, method: string, args: unknown[], options?: unknown): Promise<{ value: unknown }>;
    subscribe(
      options: unknown,
      listener: (batch: { reset?: boolean; events: Array<{ payload: Record<string, unknown> }> }) => void,
    ): Promise<() => void>;
  };
}

export const workbenchBridge = (
  typeof window !== 'undefined'
    ? (window as unknown as { harnessMate?: WorkbenchBridge }).harnessMate
    : undefined
);

function createEmptyNativeSlice(): NativeSessionRuntimeSlice {
  return {
    projection: null,
    capabilities: [],
    syncState: {
      phase: 'idle',
      resyncCount: 0,
      droppedStaleEvents: 0,
      lastError: null,
      lastSyncedAt: null,
    },
    route: { ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' },
    selectedModeId: 'normal',
    commandSubmission: null,
  };
}

function createWorkbenchBridgeTransport(): NativeRuntimeTransport {
  return {
    mode: 'http',
    async getSnapshot(sessionId: string, signal?: AbortSignal) {
      if (!workbenchBridge) return defaultNativeTransport.getSnapshot(sessionId, signal);
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/snapshot`,
      }) as ReturnType<NativeRuntimeTransport['getSnapshot']>;
    },
    async getCapabilities(sessionId: string, signal?: AbortSignal) {
      if (!workbenchBridge) return defaultNativeTransport.getCapabilities(sessionId, signal);
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/capabilities`,
      }) as ReturnType<NativeRuntimeTransport['getCapabilities']>;
    },
    async getEvents(sessionId, params, signal) {
      if (!workbenchBridge) return defaultNativeTransport.getEvents(sessionId, params, signal);
      const q = new URLSearchParams();
      q.set('after', String(params.afterSeq));
      if (params.limit !== undefined) q.set('limit', String(params.limit));
      if (params.cursor) q.set('cursor', params.cursor);
      if (params.generation) q.set('generation', params.generation);
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/events?${q.toString()}`,
      }) as ReturnType<NativeRuntimeTransport['getEvents']>;
    },
    async getActivityTimeline(
      sessionId: string,
      activityId: ActivityId,
      params?: { pageToken?: string | null; limit?: number },
      signal?: AbortSignal,
    ): Promise<NativeTimelinePageResponse> {
      if (!workbenchBridge) {
        return defaultNativeTransport.getActivityTimeline(sessionId, activityId, params, signal);
      }
      const q = new URLSearchParams();
      if (params?.pageToken) q.set('pageToken', params.pageToken);
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      const qs = q.toString();
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/activities/${encodeURIComponent(activityId)}/timeline${qs ? `?${qs}` : ''}`,
      }) as Promise<NativeTimelinePageResponse>;
    },
    async getAgentTimeline(
      sessionId: string,
      agentId: NativeAgentId,
      params?: { pageToken?: string | null; limit?: number },
      signal?: AbortSignal,
    ): Promise<NativeTimelinePageResponse> {
      if (!workbenchBridge) {
        return defaultNativeTransport.getAgentTimeline(sessionId, agentId, params, signal);
      }
      const q = new URLSearchParams();
      if (params?.pageToken) q.set('pageToken', params.pageToken);
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      const qs = q.toString();
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/agents/${encodeURIComponent(agentId)}/timeline${qs ? `?${qs}` : ''}`,
      }) as Promise<NativeTimelinePageResponse>;
    },
    async getWorkflowResource(
      sessionId: string,
      workflowId: WorkflowId,
      resource: string,
      params?: { pageToken?: string | null; limit?: number },
      signal?: AbortSignal,
    ): Promise<NativeWorkflowResourcePageResponse> {
      if (!workbenchBridge) {
        return defaultNativeTransport.getWorkflowResource(sessionId, workflowId, resource, params, signal);
      }
      const q = new URLSearchParams();
      if (params?.pageToken) q.set('pageToken', params.pageToken);
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      const qs = q.toString();
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/workflows/${encodeURIComponent(workflowId)}/${encodeURIComponent(resource)}${qs ? `?${qs}` : ''}`,
      }) as Promise<NativeWorkflowResourcePageResponse>;
    },
    async submitCommand(sessionId: string, body: NativeCommandSubmitRequest, signal?: AbortSignal) {
      if (!workbenchBridge) return defaultNativeTransport.submitCommand(sessionId, body, signal);
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/commands`,
        method: 'POST',
        body,
      }) as ReturnType<NativeRuntimeTransport['submitCommand']>;
    },
    async dispatchControl(sessionId: string, body: NativeControlRequest, signal?: AbortSignal) {
      if (!workbenchBridge) return defaultNativeTransport.dispatchControl(sessionId, body, signal);
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/control`,
        method: 'POST',
        body,
      }) as ReturnType<NativeRuntimeTransport['dispatchControl']>;
    },
    async resolveNativeRequest(sessionId, approvalId, req, signal) {
      if (!workbenchBridge) {
        return defaultNativeTransport.resolveNativeRequest(sessionId, approvalId, req, signal);
      }
      return workbenchBridge.call('api.fetch', {
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/native/requests/${encodeURIComponent(approvalId)}/resolve`,
        method: 'POST',
        body: req,
      }) as ReturnType<NativeRuntimeTransport['resolveNativeRequest']>;
    },
  };
}

let activeTransport: NativeRuntimeTransport = createWorkbenchBridgeTransport();
const sourceId =
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `wb-${Date.now()}`;

/**
 * Plugin-owned AGY workbench store. Never shares or imports the host Zustand instance.
 */
export const useAppStore = create<AppState>((set, get) => {
  const pushToast = (toast: Omit<ToastNotice, 'id'>) => {
    const id = `wb-toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((state) => ({ toasts: [...(state.toasts ?? []), { ...toast, id }].slice(-5) }));
    void workbenchBridge?.call('shell.toast', toast).catch(() => {});
  };

  const persistRoute = async (sessionId: string, route: WorkbenchRouteState) => {
    if (!workbenchBridge) return;
    try {
      await workbenchBridge.services.call(
        'agy.workbench.v1',
        'writeWorkbenchState',
        [{ sessionId, patch: route, sourceId }],
        { instanceId: workbenchBridge.instanceId, sessionId },
      );
    } catch {
      // Ignore persistence errors during unmount
    }
  };

  const state: Partial<AppState> = {
    sessions: [],
    workspaces: [],
    harnesses: [],
    pendingApprovals: [],
    plugins: [],
    selectedSessionId: null,
    selectedWorkspaceId: null,
    agyAuthStates: {},
    agyNativeWorkbenchEnabled: true,
    nativeRuntimeBySession: {},
    toasts: [],
    pushToast,
    setAgyNativeWorkbenchEnabled: (enabled: boolean) => set({ agyNativeWorkbenchEnabled: enabled }),
    setNativeTransport: (transport: NativeRuntimeTransport | null) => {
      activeTransport = transport ?? createWorkbenchBridgeTransport();
    },
    setNativeWorkbenchRoute: (sessionId: string, patch: Partial<WorkbenchRouteState>) => {
      set((cur) => {
        const prev = cur.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
        const nextRoute: WorkbenchRouteState = { ...prev.route, ...patch };
        void persistRoute(sessionId, nextRoute);
        return {
          nativeRuntimeBySession: {
            ...cur.nativeRuntimeBySession,
            [sessionId]: { ...prev, route: nextRoute },
          },
        };
      });
    },
    setNativeAgentMode: (sessionId: string, modeId: string) => {
      set((cur) => {
        const prev = cur.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
        return {
          nativeRuntimeBySession: {
            ...cur.nativeRuntimeBySession,
            [sessionId]: { ...prev, selectedModeId: modeId },
          },
        };
      });
    },
    ingestNativeProjectionFixture: (
      sessionId: string,
      projection: NativeRuntimeProjection,
      capabilities: readonly CapabilityDescriptor[] = [],
    ) => {
      set((cur) => {
        const prev = cur.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
        return {
          nativeRuntimeBySession: {
            ...cur.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              projection,
              capabilities: [...capabilities],
              syncState: {
                phase: 'live',
                resyncCount: prev.syncState.resyncCount,
                droppedStaleEvents: prev.syncState.droppedStaleEvents,
                lastError: null,
                lastSyncedAt: Date.now(),
              },
            },
          },
        };
      });
    },
    clearNativeSessionState: (sessionId: string) => {
      set((cur) => {
        const next = { ...cur.nativeRuntimeBySession };
        delete next[sessionId];
        return { nativeRuntimeBySession: next };
      });
    },
    hydrateNativeRuntime: async (sessionId: string) => {
      try {
        const [snapRes, capRes] = await Promise.all([
          activeTransport.getSnapshot(sessionId),
          activeTransport.getCapabilities(sessionId),
        ]);
        set((cur) => {
          const prev = cur.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
          const projection: NativeRuntimeProjection = snapRes.projection;
          const capabilities: CapabilityDescriptor[] = capRes.descriptors;
          const syncState: NativeFeedSyncState = {
            phase: 'live',
            resyncCount: prev.syncState.resyncCount,
            droppedStaleEvents: prev.syncState.droppedStaleEvents,
            lastError: null,
            lastSyncedAt: Date.now(),
          };
          return {
            nativeRuntimeBySession: {
              ...cur.nativeRuntimeBySession,
              [sessionId]: {
                ...prev,
                projection,
                capabilities,
                syncState,
              },
            },
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((cur) => {
          const prev = cur.nativeRuntimeBySession[sessionId] ?? createEmptyNativeSlice();
          return {
            nativeRuntimeBySession: {
              ...cur.nativeRuntimeBySession,
              [sessionId]: {
                ...prev,
                syncState: { ...prev.syncState, phase: 'error', lastError: msg },
              },
            },
          };
        });
      }
    },
    applyNativeEvents: (sessionId: string, events: readonly NativeCanonicalEvent[]) => {
      if (!events.length) return;
      set((cur) => {
        const prev = cur.nativeRuntimeBySession[sessionId];
        if (!prev?.projection) return cur;
        const applied = applyNativeEventBatch(prev.projection, events);
        return {
          nativeRuntimeBySession: {
            ...cur.nativeRuntimeBySession,
            [sessionId]: {
              ...prev,
              projection: applied.projection,
              syncState: {
                ...prev.syncState,
                droppedStaleEvents:
                  prev.syncState.droppedStaleEvents + applied.droppedStaleGenerationCount,
                lastSyncedAt: Date.now(),
              },
            },
          },
        };
      });
    },
    submitNativeCommand: async (sessionId, req) => {
      const slice = get().nativeRuntimeBySession[sessionId];
      const binding = req.expectedBinding ?? slice?.projection?.binding;
      if (!binding) return false;
      const idempotencyKey =
        req.idempotencyKey ?? createNativeIdempotencyKey('cmd', `${req.capabilityId}_${req.actionKey}`);
      const body: NativeCommandSubmitRequest = {
        bindingGeneration: binding.generation,
        catalogRevision: req.expectedCapabilitiesRevision ?? slice?.projection?.capabilitiesRevision ?? 0,
        idempotencyKey,
        capabilityId: req.capabilityId,
        actionKey: req.actionKey,
        args: req.args,
      };
      try {
        await activeTransport.submitCommand(sessionId, body);
        await get().hydrateNativeRuntime(sessionId);
        return true;
      } catch (err) {
        const msg = err instanceof NativeClientError ? err.message : String(err);
        pushToast({ kind: 'error', title: 'AGY 原生命令失败', body: msg });
        return false;
      }
    },
    dispatchNativeControl: async (sessionId, req) => {
      const slice = get().nativeRuntimeBySession[sessionId];
      const binding = req.expectedBinding ?? slice?.projection?.binding;
      if (!binding) return;
      const idempotencyKey =
        req.idempotencyKey ?? createNativeIdempotencyKey('ctrl', `${req.target.type}_${req.action}`);
      const body: NativeControlRequest = {
        generation: binding.generation,
        idempotencyKey,
        target: req.target,
        action: req.action,
        expectedRevision: req.expectedRevision,
      };
      try {
        await activeTransport.dispatchControl(sessionId, body);
        await get().hydrateNativeRuntime(sessionId);
      } catch (err) {
        const msg = err instanceof NativeClientError ? err.message : String(err);
        pushToast({ kind: 'error', title: 'AGY 原生控制失败', body: msg });
      }
    },
    loadNativeTimeline: (sessionId, scope, pageToken, signal) =>
      scope.kind === 'activity'
        ? activeTransport.getActivityTimeline(sessionId, scope.id as ActivityId, { pageToken }, signal)
        : activeTransport.getAgentTimeline(sessionId, scope.id as NativeAgentId, { pageToken }, signal),
    loadNativeWorkflowResource: (sessionId, workflowId, resource, pageToken, signal) =>
      activeTransport.getWorkflowResource(sessionId, workflowId, resource, { pageToken }, signal),
    resolveRuntimeRequest: async (approvalId: string, req: ResolveApprovalRequest) => {
      if (workbenchBridge) {
        return workbenchBridge.call('api.fetch', {
          path: `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
          method: 'POST',
          body: req,
        }) as Promise<{ conflict?: boolean; resolvedBy?: string | null }>;
      }
      const res = await fetch(`/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) return { conflict: res.status === 409, resolvedBy: null };
      const data = (await res.json()) as { conflict?: boolean; approval?: { resolvedBy?: string | null } };
      return { conflict: data.conflict, resolvedBy: data.approval?.resolvedBy ?? null };
    },
    switchHarness: async (sessionId, req) => {
      if (workbenchBridge) {
        await workbenchBridge.call('api.fetch', {
          path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/switch-harness`,
          method: 'POST',
          body: req,
        });
      }
    },
    openInspectorFile: (sessionId: string, path: string, line?: number) => {
      void workbenchBridge?.call('shell.openFile', { sessionId, path, line }).catch(() => {});
      return { opened: true, sessionId, path, line };
    },
    setInspectorOpen: (open) => {
      void workbenchBridge?.call('shell.setInspectorOpen', { open }).catch(() => {});
    },
    setInspectorTab: (tab) => {
      void workbenchBridge?.call('shell.setInspectorTab', { tab }).catch(() => {});
    },
  };

  return state as AppState;
});

export function startWorkbenchBridgeSync(): () => void {
  if (!workbenchBridge) return () => {};
  let disposed = false;
  let releaseWorkbenchSub: (() => void) | undefined;
  let releaseRuntimeSub: (() => void) | undefined;
  let releaseAccountsSub: (() => void) | undefined;

  const syncContext = async (session: Session | null) => {
    if (disposed) return;
    try {
      const snap = (await workbenchBridge.call<Partial<AppState>>('shell.snapshot')) ?? {};
      if (disposed) return;
      useAppStore.setState({
        sessions: snap.sessions ?? [],
        workspaces: snap.workspaces ?? [],
        harnesses: snap.harnesses ?? [],
        pendingApprovals: snap.pendingApprovals ?? [],
        plugins: snap.plugins ?? [],
        agyAuthStates: (snap.agyAuthStates ?? {}) as Record<string, AgyAuthState>,
        selectedSessionId: session?.id ?? null,
        selectedWorkspaceId: session?.workspaceId ?? snap.selectedWorkspaceId ?? null,
      });
    } catch {
      // ignore initial snapshot failures
    }

    if (session) {
      try {
        const res = (await workbenchBridge.services.call(
          'agy.workbench.v1',
          'readWorkbenchState',
          [{ sessionId: session.id }],
          { instanceId: workbenchBridge.instanceId, sessionId: session.id },
        )) as { value?: { ok?: boolean; value?: { state?: Partial<WorkbenchRouteState> } } };
        const stored = res?.value?.ok ? res.value.value?.state : undefined;
        if (stored && !disposed) {
          useAppStore.setState((cur) => {
            const prev = cur.nativeRuntimeBySession[session.id] ?? createEmptyNativeSlice();
            return {
              nativeRuntimeBySession: {
                ...cur.nativeRuntimeBySession,
                [session.id]: { ...prev, route: { ...prev.route, ...stored } },
              },
            };
          });
        }
      } catch {
        // ignore
      }
      if (session.harnessKind === 'agy') {
        void useAppStore.getState().hydrateNativeRuntime(session.id);
      }
    }
  };

  const unsubContext = workbenchBridge.onContext((session) => {
    void syncContext(session);
  });

  void workbenchBridge.services
    .subscribe({ contract: 'agy.workbench.v1', instanceId: workbenchBridge.instanceId }, (batch) => {
      for (const { payload } of batch.events) {
        if (disposed || payload.sourceId === sourceId) continue;
        const sid = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        const st = payload.state as Partial<WorkbenchRouteState> | undefined;
        if (sid && st) {
          useAppStore.setState((cur) => {
            const prev = cur.nativeRuntimeBySession[sid] ?? createEmptyNativeSlice();
            return {
              nativeRuntimeBySession: {
                ...cur.nativeRuntimeBySession,
                [sid]: { ...prev, route: { ...prev.route, ...st } },
              },
            };
          });
        }
      }
    })
    .then((unsub) => {
      if (disposed) unsub();
      else releaseWorkbenchSub = unsub;
    })
    .catch(() => {});

  void workbenchBridge.services
    .subscribe({ contract: 'agy.runtime.v1' }, (batch) => {
      for (const { payload } of batch.events) {
        if (disposed) continue;
        const sid = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        const ev = payload.nativeEvent as NativeCanonicalEvent | undefined;
        if (sid && ev) {
          useAppStore.getState().applyNativeEvents(sid, [ev]);
        }
      }
    })
    .then((unsub) => {
      if (disposed) unsub();
      else releaseRuntimeSub = unsub;
    })
    .catch(() => {});

  void workbenchBridge.services
    .subscribe({ contract: 'agy.accounts.v1' }, (batch) => {
      for (const { payload } of batch.events) {
        if (disposed) continue;
        const st = payload.state as AgyAuthState | undefined;
        if (st?.instanceId) {
          useAppStore.setState((cur) => ({
            agyAuthStates: { ...cur.agyAuthStates, [st.instanceId]: st },
          }));
        }
      }
    })
    .then((unsub) => {
      if (disposed) unsub();
      else releaseAccountsSub = unsub;
    })
    .catch(() => {});

  void syncContext(workbenchBridge.session);

  return () => {
    disposed = true;
    unsubContext();
    releaseWorkbenchSub?.();
    releaseRuntimeSub?.();
    releaseAccountsSub?.();
  };
}
