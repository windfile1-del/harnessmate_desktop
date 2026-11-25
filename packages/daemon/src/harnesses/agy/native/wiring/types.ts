import type {
  Activity,
  ActivityId,
  AgentIdentity,
  BindingGeneration,
  CapabilityDescriptor,
  Evidence,
  NativeAgentId,
  NativeAlias,
  NativeCanonicalEvent,
  NativeCommandRequest,
  NativeCommandResponse,
  NativeControlRequest,
  NativeControlResponse,
  NativeRelationship,
  NativeRequestKind,
  NativeRequestReceiptState,
  NativeRuntimeStatus,
  NativeTimelineEntryDto,
  NativeWork,
  NativeWorkflow,
  NativeWorkflowResourceItemDto,
  NativeWorkflowResourceKind,
  PendingNativeRequest,
  ResolveNativeRequestInput,
  RpcId,
  RuntimeBinding,
  WorkId,
  WorkflowId,
} from '@harnessmate/protocol';

// ── Feature Gates (ALL OFF BY DEFAULT) ─────────────────────────────────

export interface AgyNativeFeatureFlags {
  /** Master switch for AGY native runtime projection & persistence wiring. Default: false. */
  readonly enabled: boolean;
  /** Enable NativeLifecyclePort hooks (single settlement, retention reasons, native activities). Default: false. */
  readonly nativeLifecycle: boolean;
  /** Enable NativePermissionPort routing (detached / child requests, CAS receipts). Default: false. */
  readonly nativePermissions: boolean;
  /** Enable NativeCommandRouterPort & /native/commands + /native/control writes. Default: false. */
  readonly nativeCommands: boolean;
  /** Enable transport observatory frame tapping. Default: false. */
  readonly observatoryTap: boolean;
  /** ACP v2 Preview protocol negotiation gate. MUST remain false until verified live support exists. */
  readonly acpV2Preview: boolean;
}

export const DEFAULT_AGY_NATIVE_FEATURE_FLAGS: Readonly<AgyNativeFeatureFlags> = Object.freeze({
  enabled: false,
  nativeLifecycle: false,
  nativePermissions: false,
  nativeCommands: false,
  observatoryTap: false,
  acpV2Preview: false,
});

// ── Captured Prompt Context & Turn Settlement ──────────────────────────

export interface PromptContext {
  readonly turnId: string;
  readonly requestOrdinal: number;
  readonly rpcId: RpcId | null;
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly originActivityId?: ActivityId;
  readonly capabilitySnapshotRevision: number;
  readonly startedAt: number;
  readonly isSteering: boolean;
}

export type TurnSettlement =
  | { readonly kind: 'held'; readonly reasonIds: readonly string[] }
  | {
      readonly kind: 'eligible';
      readonly outcome: 'completed' | 'failed' | 'cancelled';
      readonly stopReason?: string;
      readonly message?: string;
      readonly code?: string;
      readonly failureClass?: string;
      readonly resetAt?: number | null;
    }
  | { readonly kind: 'disconnected'; readonly reason: string };

/**
 * Host settlement exit bound by SessionManager so NativeLifecyclePort (NP-04) can release
 * a previously `held` turn exactly once when blocking native work finishes or transport closes.
 */
export interface NativeTurnSettlementSink {
  settleTurn(params: {
    readonly binding: RuntimeBinding;
    readonly turnId: string;
    readonly settlement: Extract<TurnSettlement, { kind: 'eligible' | 'disconnected' }>;
  }): { readonly settled: boolean; readonly reason?: string };
}

// ── Native Ingress & Typed Observation Union ───────────────────────────

export interface NativeIngress {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly ingressOrdinal: number;
  readonly channel: 'live' | 'history_replay';
  readonly originSession?: string;
  readonly wire: unknown;
}

export type NativeObservation =
  | {
      readonly kind: 'runtime_status';
      readonly binding: RuntimeBinding;
      readonly status: NativeRuntimeStatus;
      readonly retentionReasons: readonly string[];
      readonly reasonCode?: string;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'activity_upsert';
      readonly binding: RuntimeBinding;
      readonly activity: Activity;
      readonly deltaSummary?: string;
      readonly timelinePageHint?: string;
      readonly hmAnchorSeq?: number;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'work_upsert';
      readonly binding: RuntimeBinding;
      readonly work: NativeWork;
      readonly turnId?: string | null;
      readonly hmAnchorSeq?: number;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'agent_upsert';
      readonly binding: RuntimeBinding;
      readonly agent: AgentIdentity;
      readonly turnId?: string | null;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'alias_upsert';
      readonly binding: RuntimeBinding;
      readonly targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
      readonly targetEntityId: string;
      readonly alias: NativeAlias;
    }
  | {
      readonly kind: 'relation_upsert';
      readonly binding: RuntimeBinding;
      readonly relation: NativeRelationship;
      readonly turnId?: string | null;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'relation_revoke';
      readonly binding: RuntimeBinding;
      readonly relation: NativeRelationship;
      readonly turnId?: string | null;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'workflow_upsert';
      readonly binding: RuntimeBinding;
      readonly workflow: NativeWorkflow;
      readonly resourceIds?: readonly string[];
      readonly turnId?: string | null;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'capabilities_updated';
      readonly binding: RuntimeBinding;
      readonly capabilitiesRevision: number;
      readonly descriptors: readonly CapabilityDescriptor[];
      readonly changedDescriptorIds: readonly string[];
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'request_changed';
      readonly binding: RuntimeBinding;
      readonly approvalId: string;
      readonly kindName: NativeRequestKind;
      readonly receiptState: NativeRequestReceiptState;
      readonly receiptId?: string;
      readonly targetAgentId?: NativeAgentId;
      readonly activityId?: ActivityId;
      readonly turnId?: string | null;
      readonly mutationKey?: string;
    }
  | {
      readonly kind: 'recovery_changed';
      readonly binding: RuntimeBinding;
      readonly status: NativeRuntimeStatus;
      readonly invalidatedGenerations: readonly BindingGeneration[];
      readonly uncertainEntityIds: readonly string[];
      readonly reasonCode: string;
      readonly mutationKey?: string;
    };

// ── Transport Observatory Tap Seam (for NP-01) ─────────────────────────

export interface NativeTransportFrame {
  readonly connectionId: string;
  readonly direction: 'in' | 'out' | 'internal';
  readonly ordinal: number;
  readonly monotonicMs: number;
  readonly observedAt: number;
  readonly messageKind: 'request' | 'response' | 'notification' | 'server_request' | 'stderr' | 'exit' | 'noise';
  readonly rpcId?: RpcId;
  readonly method?: string;
  readonly wire?: unknown;
  readonly diagnosticText?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
}

export interface NativeTransportObserver {
  readonly id: string;
  onFrame(frame: NativeTransportFrame, binding?: RuntimeBinding): void;
}

// ── Domain Owner Ports (Implemented by NP-04..NP-15) ───────────────────

export interface NativeLifecyclePort {
  attachSettlementSink?(sink: NativeTurnSettlementSink): void;
  acceptFrame(envelope: NativeIngress): void;
  acceptNativeObservation(observation: NativeObservation): void;
  handleTransportClosed(binding: RuntimeBinding, connectionId: string, reason?: string): void;
  listRetentionReasons(binding: RuntimeBinding): string[];
  decideTurnSettlement(turnId: string, binding: RuntimeBinding): TurnSettlement;
  onPromptStarted?(ctx: PromptContext): void;
  onPromptSettled?(
    ctx: PromptContext,
    result:
      | { ok: true; stopReason: string; isCurrentTurn: boolean }
      | { ok: false; message: string; code?: string; failureClass?: string; resetAt?: number | null; isCurrentTurn: boolean },
  ): TurnSettlement;
  onCancelRequested?(binding: RuntimeBinding, target?: { type: string; id: string }): void;
  onProfileGenerationChanged?(prevBinding: RuntimeBinding | null, nextBinding: RuntimeBinding): void;
  onWarmPoolEvictCheck?(binding: RuntimeBinding): { allowEvict: boolean; reasons: string[] };
  onReconnect?(binding: RuntimeBinding, mode: 'resume' | 'load' | 'fresh'): void;
}

export interface NativePermissionDecisionWireResult {
  readonly handled: boolean;
  readonly response?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface NativePermissionPort {
  onIncomingRequest(
    req: {
      readonly binding: RuntimeBinding;
      readonly connectionId: string;
      readonly ingressOrdinal: number;
      readonly channel: 'live' | 'history_replay';
      readonly wireRequestId: RpcId;
      readonly method: string;
      readonly params: Record<string, unknown>;
      readonly respond: (result: unknown) => boolean;
      readonly respondError: (code: number, message: string) => boolean;
    },
  ): NativePermissionDecisionWireResult | null;

  resolveNativeRequest(input: {
    readonly binding: RuntimeBinding;
    readonly approvalId: string;
    readonly receiptId: string;
    readonly request: ResolveNativeRequestInput;
    readonly resolvedBy: 'desktop' | 'mobile';
  }): Promise<{
    readonly approvalId: string;
    readonly receiptId: string;
    readonly receiptState: NativeRequestReceiptState;
    readonly conflict: boolean;
  }>;

  onConnectionClosed(binding: RuntimeBinding, connectionId: string): void;
  listPendingRequests(binding: RuntimeBinding): readonly PendingNativeRequest[];
}

export interface NativeCommandRouterPort {
  getCapabilities(binding: RuntimeBinding): {
    readonly capabilitiesRevision: number;
    readonly descriptors: readonly CapabilityDescriptor[];
  };

  executeCommand(input: {
    readonly binding: RuntimeBinding;
    readonly request: NativeCommandRequest;
    readonly receiptId: string;
  }): Promise<NativeCommandResponse>;

  executeControl(input: {
    readonly binding: RuntimeBinding;
    readonly request: NativeControlRequest;
    readonly receiptId: string;
  }): Promise<NativeControlResponse>;
}

export interface NativeTimelineReaderPort {
  readTimeline(input: {
    readonly binding: RuntimeBinding;
    readonly scopeKind: 'activity' | 'agent';
    readonly scopeId: string;
    readonly pageToken?: string;
    readonly limit: number;
  }): {
    readonly revision: number;
    readonly items: readonly NativeTimelineEntryDto[];
    readonly nextPageToken: string | null;
    readonly hasMore: boolean;
    readonly sourceUnavailableReason?: string;
  };
}

export interface NativeWorkflowResourceReaderPort {
  readWorkflowResource(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly resource: NativeWorkflowResourceKind;
    readonly pageToken?: string;
    readonly limit: number;
  }): {
    readonly revision: number;
    readonly available: boolean;
    readonly sourceUnavailableReason?: string;
    readonly items: readonly NativeWorkflowResourceItemDto[];
    readonly nextPageToken: string | null;
    readonly hasMore: boolean;
  };
}

export interface NativeRuntimeHooks {
  readonly binding: RuntimeBinding;
  readonly getFeatureFlags: () => AgyNativeFeatureFlags;
  readonly onTransportFrame?: (frame: NativeTransportFrame) => void;
  readonly onIngressFrame?: (envelope: NativeIngress) => void;
  readonly onIncomingServerRequest?: (req: {
    readonly connectionId: string;
    readonly ingressOrdinal: number;
    readonly channel: 'live' | 'history_replay';
    readonly wireRequestId: RpcId;
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly respond: (result: unknown) => boolean;
    readonly respondError: (code: number, message: string) => boolean;
  }) => NativePermissionDecisionWireResult | null;
  readonly onPromptStarted?: (ctx: PromptContext) => void;
  readonly onPromptSettled?: (
    ctx: PromptContext,
    result:
      | { ok: true; stopReason: string; isCurrentTurn: boolean }
      | { ok: false; message: string; code?: string; failureClass?: string; resetAt?: number | null; isCurrentTurn: boolean },
  ) => TurnSettlement | null;
  readonly onTransportClosed?: (connectionId: string, reason?: string) => void;
  readonly listRetentionReasons?: () => string[];
}

export interface NativeRuntimeEventListener {
  (event: NativeCanonicalEvent): void;
}

export interface NativeRuntimeModuleRegistration {
  readonly lifecycle?: NativeLifecyclePort;
  readonly permissions?: NativePermissionPort;
  readonly commandRouter?: NativeCommandRouterPort;
  readonly timelineReader?: NativeTimelineReaderPort;
  readonly workflowResourceReader?: NativeWorkflowResourceReaderPort;
  readonly transportObservers?: readonly NativeTransportObserver[];
}

export interface NativeCommitMutation {
  readonly activities?: readonly Activity[];
  readonly work?: readonly NativeWork[];
  readonly agents?: readonly AgentIdentity[];
  readonly workflows?: readonly NativeWorkflow[];
  readonly aliases?: readonly {
    readonly targetEntityKind: 'activity' | 'work' | 'agent' | 'workflow' | 'runtime';
    readonly targetEntityId: string;
    readonly alias: NativeAlias;
  }[];
  readonly relationsUpsert?: readonly NativeRelationship[];
  readonly relationsRevoke?: readonly {
    readonly childAgentId: NativeAgentId;
    readonly revokedAt: number;
  }[];
  readonly status?: NativeRuntimeStatus;
  readonly retentionReasons?: readonly string[];
  readonly capabilitiesRevision?: number;
  readonly capabilityDescriptors?: readonly CapabilityDescriptor[];
}

export interface NativeEventDraft {
  readonly type: NativeCanonicalEvent['type'];
  readonly turnId: string | null;
  readonly hmAnchorSeq?: number;
  readonly payload: NativeCanonicalEvent['payload'];
  readonly mutationKey?: string;
  readonly createdAt?: number;
}

export type NativeWorkIdRef = WorkId;
export type NativeEvidenceRef = Evidence;
