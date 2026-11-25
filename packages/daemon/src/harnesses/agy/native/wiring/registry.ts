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
  type RuntimeBinding,
  type RuntimeId,
} from '@harnessmate/protocol';
import type { HarnessMateStore, NativeRuntimeSchemaStatus } from '../../../../db/sqlite.js';
import {
  NativeRuntimeStore,
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

  // ── Module Registration (Domain Owners Plug In Here) ─────────────────

  registerModules(registration: NativeRuntimeModuleRegistration): void {
    if (registration.lifecycle) {
      this.lifecyclePort = registration.lifecycle;
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

  // ── Binding & Generation Management ──────────────────────────────────

  ensureRuntimeBinding(params: {
    sessionId: string;
    instanceId: string;
    profileRef: string;
    sourceRef?: string;
    advanceGeneration?: boolean;
  }): StoredNativeBinding {
    let stored = this.persistence.ensureBinding({
      sessionId: params.sessionId,
      instanceId: params.instanceId,
      profileRef: params.profileRef,
      sourceRef: params.sourceRef,
    });
    const prev = this.activeBindingsBySession.get(params.sessionId) ?? null;
    if (params.advanceGeneration) {
      stored = this.persistence.advanceGeneration(stored.runtimeId, { status: 'attached' });
    }
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

  getActiveBinding(sessionId: string, instanceId?: string): RuntimeBinding | null {
    const cached = this.activeBindingsBySession.get(sessionId);
    if (cached && (!instanceId || cached.instanceId === instanceId)) {
      return cached;
    }
    if (!this.persistence.getSchemaStatus().compatible) return null;
    const stored = this.persistence.getLatestBindingForSession(sessionId, instanceId);
    if (!stored) return null;
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
        if (!this.flags.enabled || !this.flags.nativePermissions || !this.permissionPort) {
          return null;
        }
        return this.permissionPort.onIncomingRequest({
          binding,
          ...req,
        });
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
        return this.lifecyclePort.onPromptSettled(ctx, result);
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
    return this.lifecyclePort.decideTurnSettlement(turnId, binding);
  }

  listRetentionReasons(binding: RuntimeBinding | null): string[] {
    if (!binding || !this.flags.enabled || !this.flags.nativeLifecycle || !this.lifecyclePort) {
      return [];
    }
    return this.lifecyclePort.listRetentionReasons(binding);
  }

  checkWarmPoolEvict(binding: RuntimeBinding | null): { allowEvict: boolean; reasons: string[] } {
    if (!binding || !this.flags.enabled || !this.flags.nativeLifecycle || !this.lifecyclePort) {
      return { allowEvict: true, reasons: [] };
    }
    if (this.lifecyclePort.onWarmPoolEvictCheck) {
      return this.lifecyclePort.onWarmPoolEvictCheck(binding);
    }
    const reasons = this.lifecyclePort.listRetentionReasons(binding);
    return { allowEvict: reasons.length === 0, reasons };
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

  // ── Read Models (Snapshot, Capabilities, Events) ─────────────────────

  getProjectionForSession(sessionId: string, instanceId: string): NativeRuntimeProjection {
    const schemaStatus = this.persistence.getSchemaStatus();
    if (!schemaStatus.compatible) {
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
        enabled: this.flags.enabled,
        status: 'disconnected',
      });
    }
    return (
      this.persistence.readProjection(latest.runtimeId, { enabled: this.flags.enabled }) ??
      createKnownEmptyNativeProjection({
        sessionId,
        instanceId,
        runtimeId: latest.runtimeId,
        generation: latest.generation,
        enabled: this.flags.enabled,
        status: latest.status,
        capabilitiesRevision: latest.capabilitiesRevision,
      })
    );
  }

  getCapabilitiesForSession(sessionId: string, instanceId: string): NativeCapabilitiesResponse {
    const latest = this.persistence.getSchemaStatus().compatible
      ? this.persistence.getLatestBindingForSession(sessionId, instanceId)
      : null;

    const binding: RuntimeBinding = latest
      ? {
          runtimeId: latest.runtimeId,
          sessionId: latest.sessionId,
          instanceId: latest.instanceId,
          generation: latest.generation,
        }
      : createKnownEmptyNativeProjection({ sessionId, instanceId }).binding;

    let capabilitiesRevision = latest?.capabilitiesRevision ?? 0;
    let descriptors: readonly CapabilityDescriptor[] = createDefaultAgyCapabilityDescriptors(
      capabilitiesRevision,
    );

    if (this.flags.enabled && this.commandRouterPort) {
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
      enabled: this.flags.enabled,
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
    const latest = this.persistence.getLatestBindingForSession(sessionId, instanceId);
    if (!latest) {
      const empty = createKnownEmptyNativeProjection({ sessionId, instanceId });
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
        runtimeId: empty.binding.runtimeId,
        generation: empty.binding.generation,
        events: [],
        nextSeq: 0,
        nextCursor: Buffer.from(
          JSON.stringify({
            v: 1,
            r: empty.binding.runtimeId,
            g: empty.binding.generation,
            s: 0,
          }),
          'utf8',
        ).toString('base64url'),
        hasMore: false,
      };
    }

    return this.persistence.listEvents(latest.runtimeId, opts);
  }
}
