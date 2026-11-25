import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  NativeCapabilitiesResponseSchema,
  createDefaultAgyCapabilityDescriptors,
  createKnownEmptyNativeProjection,
  type BindingGeneration,
  type CapabilityDescriptor,
  type NativeCanonicalEvent,
  type NativeCapabilitiesResponse,
  type NativeRuntimeProjection,
  type NativeRuntimeStatus,
  type RuntimeBinding,
  type RuntimeId,
} from '@harnessmate/protocol';
import type { HarnessMateStore, NativeRuntimeSchemaStatus } from '../../../../db/sqlite.js';
import {
  NativeRuntimeStore,
  encodeNativeCursor,
  type NativeEventsReadResult,
  type StoredNativeBinding,
} from './persistence.js';
import {
  DEFAULT_AGY_NATIVE_FEATURE_FLAGS,
  type AgyNativeFeatureFlags,
  type NativeCommandRouterPort,
  type NativeCommitMutation,
  type NativeEventDraft,
  type NativeLifecyclePort,
  type NativePermissionPort,
  type NativeRuntimeEventListener,
  type NativeRuntimeHooks,
  type NativeRuntimeModuleRegistration,
  type NativeTimelineReaderPort,
  type NativeTransportFrame,
  type NativeTransportObserver,
  type NativeTurnSettlementSink,
  type NativeWorkflowResourceReaderPort,
  type TurnSettlement,
} from './types.js';

export class AgyNativeRuntimeRegistry {
  readonly persistence: NativeRuntimeStore;
  private flags: AgyNativeFeatureFlags;
  private lifecyclePort: NativeLifecyclePort | null = null;
  private permissionPort: NativePermissionPort | null = null;
  private commandRouterPort: NativeCommandRouterPort | null = null;
  private timelineReaderPort: NativeTimelineReaderPort | null = null;
  private workflowResourceReaderPort: NativeWorkflowResourceReaderPort | null = null;
  private settlementSink: NativeTurnSettlementSink | null = null;
  private readonly transportObservers = new Map<string, NativeTransportObserver>();
  private readonly sessionSubscribers = new Map<string, Set<NativeRuntimeEventListener>>();
  private readonly runtimeSubscribers = new Map<RuntimeId, Set<NativeRuntimeEventListener>>();
  private readonly activeBindingsBySession = new Map<string, RuntimeBinding>();

  constructor(
    store: HarnessMateStore,
    initialFlags?: Partial<AgyNativeFeatureFlags>,
  ) {
    this.persistence = new NativeRuntimeStore(store);
    this.flags = Object.freeze({
      ...DEFAULT_AGY_NATIVE_FEATURE_FLAGS,
      ...initialFlags,
      // Explicitly keep v2 Preview disabled unless specifically requested via config
      acpV2Preview: Boolean(initialFlags?.acpV2Preview ?? false),
    });
  }

  getFeatureFlags(): AgyNativeFeatureFlags {
    return this.flags;
  }

  setFeatureFlags(patch: Partial<AgyNativeFeatureFlags>): AgyNativeFeatureFlags {
    this.flags = Object.freeze({
      ...this.flags,
      ...patch,
    });
    return this.flags;
  }

  isEnabled(): boolean {
    return this.flags.enabled && this.persistence.getSchemaStatus().compatible;
  }

  getSchemaStatus(): NativeRuntimeSchemaStatus {
    return this.persistence.getSchemaStatus();
  }

  // ── Module Registration & Host Settlement Exit ───────────────────────

  bindTurnSettlementSink(sink: NativeTurnSettlementSink): void {
    this.settlementSink = sink;
    try {
      this.lifecyclePort?.attachSettlementSink?.(sink);
    } catch {
      // isolate lifecycle hook failures
    }
  }

  getTurnSettlementSink(): NativeTurnSettlementSink | null {
    return this.settlementSink;
  }

  registerModules(registration: NativeRuntimeModuleRegistration): void {
    if (registration.lifecycle) {
      this.lifecyclePort = registration.lifecycle;
      if (this.settlementSink) {
        try {
          this.lifecyclePort.attachSettlementSink?.(this.settlementSink);
        } catch {
          // isolate lifecycle hook failures
        }
      }
    }
    if (registration.permissions) {
      this.permissionPort = registration.permissions;
    }
    if (registration.commandRouter) {
      this.commandRouterPort = registration.commandRouter;
    }
    if (registration.timelineReader) {
      this.timelineReaderPort = registration.timelineReader;
    }
    if (registration.workflowResourceReader) {
      this.workflowResourceReaderPort = registration.workflowResourceReader;
    }
    for (const obs of registration.transportObservers ?? []) {
      this.transportObservers.set(obs.id, obs);
    }
  }

  addTransportObserver(observer: NativeTransportObserver): () => void {
    this.transportObservers.set(observer.id, observer);
    return () => {
      if (this.transportObservers.get(observer.id) === observer) {
        this.transportObservers.delete(observer.id);
      }
    };
  }

  getLifecyclePort(): NativeLifecyclePort | null {
    return this.lifecyclePort;
  }

  getPermissionPort(): NativePermissionPort | null {
    return this.permissionPort;
  }

  getCommandRouterPort(): NativeCommandRouterPort | null {
    return this.commandRouterPort;
  }

  getTimelineReaderPort(): NativeTimelineReaderPort | null {
    return this.timelineReaderPort;
  }

  getWorkflowResourceReaderPort(): NativeWorkflowResourceReaderPort | null {
    return this.workflowResourceReaderPort;
  }

  // ── Binding & Generation Management (DB Authoritative) ───────────────

  ensureRuntimeBinding(params: {
    sessionId: string;
    instanceId: string;
    profileRef: string;
    sourceRef?: string;
    advanceGeneration?: boolean;
    status?: NativeRuntimeStatus;
  }): StoredNativeBinding {
    const prev = this.activeBindingsBySession.get(params.sessionId) ?? null;
    const stored = this.persistence.ensureBinding({
      sessionId: params.sessionId,
      instanceId: params.instanceId,
      profileRef: params.profileRef,
      sourceRef: params.sourceRef,
      advanceIfExisting: params.advanceGeneration,
      status: params.status,
    });
    const nextBinding: RuntimeBinding = {
      runtimeId: stored.runtimeId,
      sessionId: stored.sessionId,
      instanceId: stored.instanceId,
      generation: stored.generation,
    };
    this.activeBindingsBySession.set(params.sessionId, nextBinding);

    if (
      this.flags.enabled &&
      this.flags.nativeLifecycle &&
      prev &&
      (prev.runtimeId !== nextBinding.runtimeId || prev.generation !== nextBinding.generation)
    ) {
      try {
        this.lifecyclePort?.onProfileGenerationChanged?.(prev, nextBinding);
      } catch {
        // isolate observer failures
      }
    }
    return stored;
  }

  advanceRuntimeGeneration(
    runtimeId: RuntimeId,
    opts?: { generation?: BindingGeneration; status?: NativeRuntimeStatus },
  ): StoredNativeBinding {
    const prevStored = this.persistence.getBinding(runtimeId);
    const prevBinding: RuntimeBinding | null = prevStored
      ? {
          runtimeId: prevStored.runtimeId,
          sessionId: prevStored.sessionId,
          instanceId: prevStored.instanceId,
          generation: prevStored.generation,
        }
      : null;

    const updated = this.persistence.advanceGeneration(runtimeId, opts);
    const nextBinding: RuntimeBinding = {
      runtimeId: updated.runtimeId,
      sessionId: updated.sessionId,
      instanceId: updated.instanceId,
      generation: updated.generation,
    };
    this.activeBindingsBySession.set(updated.sessionId, nextBinding);

    if (this.flags.enabled && this.flags.nativeLifecycle && prevBinding) {
      try {
        this.lifecyclePort?.onProfileGenerationChanged?.(prevBinding, nextBinding);
      } catch {
        // isolate observer failures
      }
    }
    return updated;
  }

  /**
   * Authoritatively reads the latest binding for a session from SQLite and refreshes cache so
   * cache and DB never drift across generation advances or restarts.
   */
  getActiveBinding(sessionId: string, instanceId?: string): RuntimeBinding | null {
    if (!this.persistence.getSchemaStatus().compatible) return null;
    const stored = this.persistence.getLatestBindingForSession(sessionId, instanceId);
    if (!stored) {
      this.activeBindingsBySession.delete(sessionId);
      return null;
    }
    const binding: RuntimeBinding = {
      runtimeId: stored.runtimeId,
      sessionId: stored.sessionId,
      instanceId: stored.instanceId,
      generation: stored.generation,
    };
    this.activeBindingsBySession.set(sessionId, binding);
    return binding;
  }

  // ── Single-Writer Atomic Persist + Publish ───────────────────────────

  commitAndPublish(
    binding: RuntimeBinding,
    mutation: NativeCommitMutation,
    eventDraft: NativeEventDraft,
  ): { deduplicated: boolean; event: NativeCanonicalEvent; binding: StoredNativeBinding } {
    const committed = this.persistence.commitSnapshotAndEvent(binding, mutation, eventDraft);
    this.activeBindingsBySession.set(committed.binding.sessionId, {
      runtimeId: committed.binding.runtimeId,
      sessionId: committed.binding.sessionId,
      instanceId: committed.binding.instanceId,
      generation: committed.binding.generation,
    });
    if (!committed.deduplicated) {
      this.publishEvent(committed.event);
    }
    return committed;
  }

  subscribeSession(sessionId: string, listener: NativeRuntimeEventListener): () => void {
    let set = this.sessionSubscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionSubscribers.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.sessionSubscribers.delete(sessionId);
      }
    };
  }

  subscribeRuntime(runtimeId: RuntimeId, listener: NativeRuntimeEventListener): () => void {
    let set = this.runtimeSubscribers.get(runtimeId);
    if (!set) {
      set = new Set();
      this.runtimeSubscribers.set(runtimeId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.runtimeSubscribers.delete(runtimeId);
      }
    };
  }

  private publishEvent(event: NativeCanonicalEvent): void {
    const dispatch = (listener: NativeRuntimeEventListener) => {
      try {
        listener(event);
      } catch {
        // isolate subscriber errors
      }
    };
    this.sessionSubscribers.get(event.sessionId)?.forEach(dispatch);
    this.runtimeSubscribers.get(event.runtimeId)?.forEach(dispatch);
  }

  // ── Adapter & SessionManager Integration Seams ───────────────────────

  emitTransportFrame(frame: NativeTransportFrame, binding?: RuntimeBinding): void {
    if (!this.flags.observatoryTap || this.transportObservers.size === 0) return;
    for (const observer of this.transportObservers.values()) {
      try {
        observer.onFrame(frame, binding);
      } catch {
        // observatory tap failure must never block transport
      }
    }
  }

  /** Lightweight observatory-only hook used when observatoryTap is enabled while native runtime is OFF. */
  createObservatoryOnlyHooks(sessionId: string, instanceId: string): NativeRuntimeHooks {
    const ephemeralBinding = createKnownEmptyNativeProjection({ sessionId, instanceId }).binding;
    return {
      binding: ephemeralBinding,
      getFeatureFlags: () => this.flags,
      onTransportFrame: (frame) => {
        this.emitTransportFrame(frame, ephemeralBinding);
      },
    };
  }

  createAdapterRuntimeHooks(binding: RuntimeBinding): NativeRuntimeHooks {
    return {
      binding,
      getFeatureFlags: () => this.flags,
      onTransportFrame: (frame) => {
        this.emitTransportFrame(frame, binding);
      },
      onIngressFrame: (envelope) => {
        if (!this.flags.enabled || !this.flags.nativeLifecycle) return;
        try {
          this.lifecyclePort?.acceptFrame(envelope);
        } catch {
          // isolate lifecycle failures
        }
      },
      onIncomingServerRequest: (req) => {
        // Never allow history_replay frames to create or resolve live permissions
        if (req.channel === 'history_replay') {
          return {
            handled: true,
            error: {
              code: -32601,
              message: 'Server requests are not permitted during history replay',
            },
          };
        }
        if (!this.flags.enabled || !this.flags.nativePermissions || !this.permissionPort) {
          return null;
        }
        try {
          return this.permissionPort.onIncomingRequest({
            binding,
            ...req,
          });
        } catch {
          return {
            handled: true,
            error: {
              code: -32603,
              message: 'Native permission router encountered an internal error',
            },
          };
        }
      },
      onPromptStarted: (ctx) => {
        if (!this.flags.enabled || !this.flags.nativeLifecycle) return;
        try {
          this.lifecyclePort?.onPromptStarted?.(ctx);
        } catch {
          // isolate lifecycle failures
        }
      },
      onPromptSettled: (ctx, result) => {
        if (!this.flags.enabled || !this.flags.nativeLifecycle || !this.lifecyclePort?.onPromptSettled) {
          return null;
        }
        try {
          return this.lifecyclePort.onPromptSettled(ctx, result);
        } catch {
          // Isolate settlement hook exceptions so adapter never double-invokes failure callback
          return null;
        }
      },
      onTransportClosed: (connectionId, reason) => {
        this.handleTransportClosed(binding, connectionId, reason);
      },
      listRetentionReasons: () => this.listRetentionReasons(binding),
    };
  }

  decideTurnSettlement(turnId: string, binding: RuntimeBinding | null): TurnSettlement | null {
    if (!binding || !this.flags.enabled || !this.flags.nativeLifecycle || !this.lifecyclePort) {
      return null;
    }
    try {
      return this.lifecyclePort.decideTurnSettlement(turnId, binding);
    } catch {
      return null;
    }
  }

  listRetentionReasons(binding: RuntimeBinding | null): string[] {
    if (!binding || !this.flags.enabled || !this.flags.nativeLifecycle || !this.lifecyclePort) {
      return [];
    }
    try {
      return this.lifecyclePort.listRetentionReasons(binding);
    } catch {
      return [];
    }
  }

  checkWarmPoolEvict(binding: RuntimeBinding | null): { allowEvict: boolean; reasons: string[] } {
    if (!binding || !this.flags.enabled || !this.flags.nativeLifecycle || !this.lifecyclePort) {
      return { allowEvict: true, reasons: [] };
    }
    try {
      if (this.lifecyclePort.onWarmPoolEvictCheck) {
        return this.lifecyclePort.onWarmPoolEvictCheck(binding);
      }
      const reasons = this.lifecyclePort.listRetentionReasons(binding);
      return { allowEvict: reasons.length === 0, reasons };
    } catch {
      return { allowEvict: true, reasons: [] };
    }
  }

  notifyCancelRequested(
    binding: RuntimeBinding | null,
    target?: { type: string; id: string },
  ): void {
    if (!binding || !this.flags.enabled || !this.flags.nativeLifecycle) return;
    try {
      this.lifecyclePort?.onCancelRequested?.(binding, target);
    } catch {
      // isolate failures
    }
  }

  notifyReconnect(
    binding: RuntimeBinding | null,
    mode: 'resume' | 'load' | 'fresh',
  ): void {
    if (!binding || !this.flags.enabled || !this.flags.nativeLifecycle) return;
    try {
      this.lifecyclePort?.onReconnect?.(binding, mode);
    } catch {
      // isolate failures
    }
  }

  handleTransportClosed(
    binding: RuntimeBinding | null,
    connectionId: string,
    reason?: string,
  ): void {
    if (!binding) return;
    if (this.persistence.getSchemaStatus().compatible) {
      try {
        this.persistence.invalidateApprovalReceiptsForRuntime(
          binding.runtimeId,
          binding.generation,
        );
      } catch {
        // ignore if binding not persisted yet
      }
    }
    if (this.flags.enabled && this.flags.nativePermissions) {
      try {
        this.permissionPort?.onConnectionClosed(binding, connectionId);
      } catch {
        // isolate failures
      }
    }
    if (this.flags.enabled && this.flags.nativeLifecycle) {
      try {
        this.lifecyclePort?.handleTransportClosed(binding, connectionId, reason);
      } catch {
        // isolate failures
      }
    }
  }

  // ── Read Models (Strict Feature-Off Purity + Authoritative Projection) ──

  getProjectionForSession(sessionId: string, instanceId: string): NativeRuntimeProjection {
    const schemaStatus = this.persistence.getSchemaStatus();
    // Feature-off or incompatible schema: ALWAYS return Known Empty disconnected projection
    // (never project stale attached/live entities while gate is OFF; persisted DB rows stay intact).
    if (!this.flags.enabled || !schemaStatus.compatible) {
      return createKnownEmptyNativeProjection({
        sessionId,
        instanceId,
        enabled: false,
        status: 'disconnected',
      });
    }
    const latest = this.persistence.getLatestBindingForSession(sessionId, instanceId);
    if (!latest) {
      return createKnownEmptyNativeProjection({
        sessionId,
        instanceId,
        enabled: true,
        status: 'disconnected',
      });
    }
    return (
      this.persistence.readProjection(latest.runtimeId, { enabled: true }) ??
      createKnownEmptyNativeProjection({
        sessionId,
        instanceId,
        runtimeId: latest.runtimeId,
        generation: latest.generation,
        enabled: true,
        status: latest.status,
        capabilitiesRevision: latest.capabilitiesRevision,
      })
    );
  }

  getCapabilitiesForSession(sessionId: string, instanceId: string): NativeCapabilitiesResponse {
    // Feature-off: ALWAYS return honest default `not_tested` descriptors (never leak historical `available` caps!)
    if (!this.flags.enabled || !this.persistence.getSchemaStatus().compatible) {
      const empty = createKnownEmptyNativeProjection({ sessionId, instanceId, enabled: false });
      return NativeCapabilitiesResponseSchema.parse({
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        contractRevision: AGY_NATIVE_CONTRACT_REVISION,
        enabled: false,
        binding: empty.binding,
        capabilitiesRevision: 0,
        descriptors: createDefaultAgyCapabilityDescriptors(0),
      });
    }

    const latest = this.persistence.getLatestBindingForSession(sessionId, instanceId);
    const binding: RuntimeBinding = latest
      ? {
          runtimeId: latest.runtimeId,
          sessionId: latest.sessionId,
          instanceId: latest.instanceId,
          generation: latest.generation,
        }
      : createKnownEmptyNativeProjection({ sessionId, instanceId, enabled: true }).binding;

    let capabilitiesRevision = latest?.capabilitiesRevision ?? 0;
    let descriptors: readonly CapabilityDescriptor[] = createDefaultAgyCapabilityDescriptors(
      capabilitiesRevision,
    );

    if (this.commandRouterPort) {
      const liveCaps = this.commandRouterPort.getCapabilities(binding);
      capabilitiesRevision = liveCaps.capabilitiesRevision;
      descriptors = liveCaps.descriptors;
    } else if (latest) {
      const storedSnap = this.persistence.readCapabilitySnapshot(latest.runtimeId);
      if (storedSnap && storedSnap.descriptors.length > 0) {
        capabilitiesRevision = storedSnap.capabilitiesRevision;
        descriptors = storedSnap.descriptors;
      }
    }

    return NativeCapabilitiesResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      contractRevision: AGY_NATIVE_CONTRACT_REVISION,
      enabled: true,
      binding,
      capabilitiesRevision,
      descriptors: [...descriptors],
    });
  }

  readEventsForSession(
    sessionId: string,
    instanceId: string,
    opts: {
      afterSeq: number;
      limit: number;
      cursor?: string;
      expectedGeneration?: BindingGeneration;
    },
  ): NativeEventsReadResult {
    if (!this.flags.enabled) {
      const empty = createKnownEmptyNativeProjection({ sessionId, instanceId, enabled: false });
      if (opts.cursor || (opts.expectedGeneration && opts.expectedGeneration !== empty.binding.generation)) {
        return {
          resyncRequired: true,
          reason: 'native_runtime_disabled',
          latestSeq: 0,
          currentGeneration: empty.binding.generation,
        };
      }
      if (opts.afterSeq > 0) {
        return {
          resyncRequired: true,
          reason: 'cursor_ahead_of_head',
          latestSeq: 0,
          currentGeneration: empty.binding.generation,
        };
      }
      return {
        resyncRequired: false,
        binding: empty.binding,
        runtimeId: empty.binding.runtimeId,
        generation: empty.binding.generation,
        asOfSeq: 0,
        events: [],
        nextSeq: 0,
        nextCursor: encodeNativeCursor(empty.binding.runtimeId, empty.binding.generation, 0),
        hasMore: false,
      };
    }

    const latest = this.persistence.getLatestBindingForSession(sessionId, instanceId);
    if (!latest) {
      const empty = createKnownEmptyNativeProjection({ sessionId, instanceId, enabled: true });
      if (opts.cursor || (opts.expectedGeneration && opts.expectedGeneration !== empty.binding.generation)) {
        return {
          resyncRequired: true,
          reason: 'binding_not_initialized',
          latestSeq: 0,
          currentGeneration: empty.binding.generation,
        };
      }
      if (opts.afterSeq > 0) {
        return {
          resyncRequired: true,
          reason: 'cursor_ahead_of_head',
          latestSeq: 0,
          currentGeneration: empty.binding.generation,
        };
      }
      return {
        resyncRequired: false,
        binding: empty.binding,
        runtimeId: empty.binding.runtimeId,
        generation: empty.binding.generation,
        asOfSeq: 0,
        events: [],
        nextSeq: 0,
        nextCursor: encodeNativeCursor(empty.binding.runtimeId, empty.binding.generation, 0),
        hasMore: false,
      };
    }

    return this.persistence.listEvents(latest.runtimeId, opts);
  }
}
