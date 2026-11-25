import crypto from 'node:crypto';
import {
  AgentIdentitySchema,
  NativeRelationshipSchema,
  NativeTimelineEntryDtoSchema,
  NativeWorkSchema,
  asNativeAgentId,
  asWorkId,
  sanitizeAgentIdentityForPublic,
  sanitizeNativeRelationshipForPublic,
  sanitizeNativeWorkForPublic,
  toPublicEvidenceDto,
  type ActivityId,
  type AgentForeground,
  type AgentIdentity,
  type BindingGeneration,
  type Evidence,
  type NativeAgentId,
  type NativeAlias,
  type NativeRelationship,
  type NativeTimelineEntryDto,
  type NativeWork,
  type Observed,
  type RuntimeBinding,
  type RuntimeId,
  type WorkId,
  type WorkState,
} from '@harnessmate/protocol';
import type { AgyNativeRuntimeRegistry } from '../wiring/registry.js';
import type {
  NativeCommitMutation,
  NativeEventDraft,
  NativeIngress,
  NativeTimelineReaderPort,
} from '../wiring/types.js';
import {
  CHILD_SCOPE_CONTRACT_REVISION,
  READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
  type ChildAgentCapabilities,
  type ChildCancelAuthorization,
  type ChildIdNamespace,
  type ChildRouteLookupInput,
  type ChildScopeResolution,
  type ChildScopeResolverPort,
} from './contracts.js';
import {
  DEFAULT_CHILD_SCAN_LIMITS,
  mapNativeChildRecordState,
  readChildOwnedTranscriptOnly,
  redactPrivateChildText,
  scanVersionedChildRecords,
  type ChildRecordScanOptions,
  type ChildRecordScanResult,
  type ParsedChildRecord,
} from './record-parser.js';

export interface ChildRouterLimits {
  readonly maxAgentsPerRuntime: number;
  readonly maxTimelineEntriesPerAgent: number;
  readonly maxUnownedFrames: number;
  readonly maxAncestorDepth: number;
  readonly maxDiagnostics: number;
}

export const DEFAULT_CHILD_ROUTER_LIMITS: Readonly<ChildRouterLimits> = Object.freeze({
  maxAgentsPerRuntime: 200,
  maxTimelineEntriesPerAgent: 500,
  maxUnownedFrames: 100,
  maxAncestorDepth: 16,
  maxDiagnostics: 200,
});

export interface ChildRouterDiagnostic {
  readonly code:
    | 'stale_generation_rejected'
    | 'cross_profile_rejected'
    | 'relation_cycle_rejected'
    | 'relation_parent_conflict_rejected'
    | 'ancestor_depth_exceeded'
    | 'unknown_child_buffered'
    | 'unowned_buffer_overflow'
    | 'agent_cap_exceeded'
    | 'timeline_buffer_trimmed'
    | 'duplicate_ingress_ignored'
    | 'history_replay_isolated'
    | 'snapshot_record_rejected'
    | 'snapshot_reader_disabled'
    | 'alias_namespace_conflict';
  readonly observedAt: number;
  readonly runtimeId: RuntimeId;
  readonly generation: BindingGeneration;
  readonly detail: string;
}

export interface ChildRouterSessionConfig {
  readonly binding: RuntimeBinding;
  readonly rootNativeSessionId: string;
  readonly profileRef: string;
  readonly sourceRef: string;
  readonly connectionId?: string;
  readonly appDataPath?: string;
  readonly enableReadOnlySnapshot?: boolean;
  readonly snapshotScanOptions?: ChildRecordScanOptions;
}

export interface ChildFrameIngestionResult {
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly buffered: boolean;
  readonly affectedAgentIds: readonly NativeAgentId[];
  readonly affectedWorkIds: readonly WorkId[];
  readonly diagnostic?: ChildRouterDiagnostic;
  readonly commits: readonly {
    readonly mutation: NativeCommitMutation;
    readonly eventDraft: NativeEventDraft;
  }[];
}

interface AliasEntry {
  readonly namespace: ChildIdNamespace;
  readonly originSessionId: string;
  readonly nativeValue: string;
  readonly targetEntityKind: 'agent' | 'work';
  readonly targetEntityId: string;
  readonly alias: NativeAlias;
}

interface InternalAgentRecord {
  identity: AgentIdentity;
  capabilities: ChildAgentCapabilities;
  sessionAliases: Set<string>;
  recordAliases: Set<string>;
  launchToolCallIds: Set<string>;
  timeline: NativeTimelineEntryDto[];
  timelineSeq: number;
  droppedTimelineEntries: number;
  seenStableEventIds: Set<string>;
  appDataRecordRef?: { readonly parentNativeSessionId: string; readonly recordId: string };
}

interface UnownedBufferedFrame {
  readonly connectionId: string;
  readonly ingressOrdinal: number;
  readonly wireSessionId: string;
  readonly envelope: NativeIngress;
  readonly observedAt: number;
}

interface GenerationState {
  readonly binding: RuntimeBinding;
  readonly profileRef: string;
  readonly sourceRef: string;
  readonly rootNativeSessionId: string;
  readonly rootAgentId: NativeAgentId;
  activeConnectionId: string | null;
  appDataPath?: string;
  enableReadOnlySnapshot: boolean;
  snapshotScanOptions?: ChildRecordScanOptions;
  readonly agents: Map<NativeAgentId, InternalAgentRecord>;
  readonly work: Map<WorkId, NativeWork>;
  /** Active single-parent edges keyed by childAgentId. */
  readonly relations: Map<NativeAgentId, NativeRelationship>;
  /** Strictly namespaced alias maps: `${namespace}|${originSessionId}|${nativeValue}` */
  readonly aliases: Map<string, AliasEntry>;
  /** Deduplication set for `(connectionId, ingressOrdinal)`. */
  readonly seenIngressOrdinals: Set<string>;
  /** Bounded buffer for frames arriving before verified child announcement on same connection. */
  readonly unownedFrames: UnownedBufferedFrame[];
  readonly diagnostics: ChildRouterDiagnostic[];
  timelineRevision: number;
}

function stableScopedId(prefix: 'agt' | 'wrk', seed: string): string {
  const hash = crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 14);
  return `${prefix}_${hash}`;
}

function aliasKey(namespace: ChildIdNamespace, originSessionId: string, nativeValue: string): string {
  return `${namespace}|${originSessionId}|${nativeValue}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function readBoolean(obj: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof obj[key] === 'boolean') return obj[key] as boolean;
  }
  return undefined;
}

function buildLiveOrReplayEvidence(envelope: NativeIngress, wireVariant: string, nowMs: number): Evidence {
  if (envelope.channel === 'history_replay') {
    return {
      kind: 'replay',
      captureId: `replay_${envelope.connectionId}`,
      ordinal: envelope.ingressOrdinal,
      observedAt: nowMs,
    };
  }
  return {
    kind: 'live_protocol',
    connectionId: envelope.connectionId,
    ingressOrdinal: envelope.ingressOrdinal,
    wireVariant,
    observedAt: nowMs,
  };
}

function mapToolStatusToWorkState(rawStatus: string): WorkState {
  switch (rawStatus.trim().toLowerCase()) {
    case 'pending':
    case 'queued':
      return 'queued';
    case 'running':
    case 'in_progress':
    case 'active':
      return 'running';
    case 'completed':
    case 'finished':
    case 'done':
      return 'finished';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function encodePageToken(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodePageToken(token?: string): number {
  if (!token) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}

/**
 * NP-05 Agent Registry & Child Session Router.
 *
 * Implements:
 * - `ChildScopeResolverPort` (shared route resolution contract for NP-07)
 * - `NativeTimelineReaderPort` (paginated, independent child timeline reader for NP-02 routes)
 * - Three strict ID namespaces (`tool_call`, `native_record`, `session`)
 * - Verified lineage graph (single-parent, acyclic, depth-bounded, cross-profile & cross-generation isolated)
 * - Bounded timeline & unowned-frame buffers with deterministic deduplication
 * - Versioned read-only snapshot ingestion (never falling back to parent transcript)
 */
export class ChildSessionRouter implements ChildScopeResolverPort, NativeTimelineReaderPort {
  readonly contractRevision = CHILD_SCOPE_CONTRACT_REVISION;

  private readonly limits: ChildRouterLimits;
  private readonly nowFn: () => number;
  /** Active generation state keyed by runtimeId. */
  private readonly activeByRuntime = new Map<RuntimeId, GenerationState>();
  /** Historical read-only generation snapshots keyed by `${runtimeId}|${generation}`. */
  private readonly historicalByRuntimeGen = new Map<string, GenerationState>();

  constructor(opts?: { readonly limits?: Partial<ChildRouterLimits>; readonly now?: () => number }) {
    this.limits = Object.freeze({
      ...DEFAULT_CHILD_ROUTER_LIMITS,
      ...opts?.limits,
    });
    this.nowFn = opts?.now ?? (() => Date.now());
  }

  /**
   * Registers or transitions an active runtime binding.
   * When generation or profile/source changes, prior generation state is demoted to
   * read-only historical/stale state and live capabilities are immediately revoked.
   */
  registerBinding(config: ChildRouterSessionConfig): {
    readonly rootAgentId: NativeAgentId;
    readonly binding: RuntimeBinding;
  } {
    const prev = this.activeByRuntime.get(config.binding.runtimeId);
    if (prev && prev.binding.generation === config.binding.generation) {
      if (
        prev.profileRef !== config.profileRef ||
        prev.sourceRef !== config.sourceRef ||
        prev.binding.sessionId !== config.binding.sessionId ||
        prev.binding.instanceId !== config.binding.instanceId
      ) {
        throw new Error(
          `Cross-profile or scope mismatch for active binding ${config.binding.runtimeId}/${config.binding.generation}`,
        );
      }
      if (config.connectionId) {
        prev.activeConnectionId = config.connectionId;
      }
      if (config.appDataPath !== undefined) {
        prev.appDataPath = config.appDataPath;
      }
      if (config.enableReadOnlySnapshot !== undefined) {
        prev.enableReadOnlySnapshot = config.enableReadOnlySnapshot;
      }
      if (config.snapshotScanOptions !== undefined) {
        prev.snapshotScanOptions = config.snapshotScanOptions;
      }
      return { rootAgentId: prev.rootAgentId, binding: prev.binding };
    }

    if (prev) {
      this.demoteStateToHistorical(prev, 'generation_changed');
    }

    const nowMs = this.nowFn();
    const rootAgentId = asNativeAgentId(
      stableScopedId(
        'agt',
        `root|${config.binding.runtimeId}|${config.binding.generation}|${config.profileRef}|${config.rootNativeSessionId}`,
      ),
    );

    const rootEvidence: Evidence = {
      kind: 'host_observation',
      observedAt: nowMs,
      reasonCode: 'root_session_bound',
    };

    const rootIdentity: AgentIdentity = AgentIdentitySchema.parse({
      id: rootAgentId,
      role: { kind: 'known', value: 'primary', evidence: rootEvidence },
      label: { kind: 'known', value: '主 Agent', evidence: rootEvidence },
      foreground: { kind: 'known', value: 'idle', evidence: rootEvidence },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 1,
    });

    const state: GenerationState = {
      binding: config.binding,
      profileRef: config.profileRef,
      sourceRef: config.sourceRef,
      rootNativeSessionId: config.rootNativeSessionId,
      rootAgentId,
      activeConnectionId: config.connectionId ?? null,
      appDataPath: config.appDataPath,
      enableReadOnlySnapshot: Boolean(config.enableReadOnlySnapshot),
      snapshotScanOptions: config.snapshotScanOptions,
      agents: new Map(),
      work: new Map(),
      relations: new Map(),
      aliases: new Map(),
      seenIngressOrdinals: new Set(),
      unownedFrames: [],
      diagnostics: [],
      timelineRevision: 1,
    };

    state.agents.set(rootAgentId, {
      identity: rootIdentity,
      capabilities: {
        canObserveLiveStream: Boolean(config.connectionId),
        canCancel: false,
        canReadSnapshot: false,
        canSteer: false,
        canLoadDirect: false,
        cancelReasonCode: 'root_uses_session_cancel',
      },
      sessionAliases: new Set([config.rootNativeSessionId]),
      recordAliases: new Set(),
      launchToolCallIds: new Set(),
      timeline: [],
      timelineSeq: 0,
      droppedTimelineEntries: 0,
      seenStableEventIds: new Set(),
    });

    const rootAlias: NativeAlias = {
      namespace: 'session',
      originSessionId: config.rootNativeSessionId,
      nativeValue: config.rootNativeSessionId,
      evidence: rootEvidence,
    };
    state.aliases.set(aliasKey('session', '', config.rootNativeSessionId), {
      namespace: 'session',
      originSessionId: '',
      nativeValue: config.rootNativeSessionId,
      targetEntityKind: 'agent',
      targetEntityId: rootAgentId,
      alias: rootAlias,
    });

    this.activeByRuntime.set(config.binding.runtimeId, state);
    return { rootAgentId, binding: config.binding };
  }

  /**
   * Handles transport close / crash / restart:
   * revokes live child capabilities, clears unowned live frame buffers, and marks active
   * foreground/status states as stale without fabricating `finished` or `succeeded`.
   */
  handleTransportClosed(
    binding: RuntimeBinding,
    connectionId: string,
    reasonCode = 'transport_closed',
  ): void {
    const state = this.getActiveState(binding);
    if (!state) return;
    if (state.activeConnectionId && state.activeConnectionId !== connectionId) {
      return;
    }
    state.activeConnectionId = null;
    state.unownedFrames.length = 0;
    this.markAgentsAndWorkStale(state, reasonCode);
  }

  /**
   * Marks active generation as reconciling after daemon/host restart.
   */
  markReconciling(binding: RuntimeBinding, reasonCode = 'reconciling_after_restart'): void {
    const state = this.getActiveState(binding);
    if (!state) return;
    state.activeConnectionId = null;
    state.unownedFrames.length = 0;
    this.markAgentsAndWorkStale(state, reasonCode);
  }

  /**
   * Main ordered ingress entry point for ACP live / history_replay frames.
   *
   * Handles:
   * - `invoke_subagent` `tool_call` / `tool_call_update` (launch batch -> `tool_call` namespace, `unresolved` until verified)
   * - Explicit child announcements (`subagent_announced` / `subagent_update` / `session_message` / tool result with verified child conversationId)
   * - Independent child stream chunks (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `state_update`, `subagent_state_update`)
   * - Non-root unknown session frames buffered up to bounded cap until verified announcement on same connection
   */
  acceptFrame(
    envelope: NativeIngress,
    opts?: { readonly profileRef?: string; readonly sourceRef?: string },
  ): ChildFrameIngestionResult {
    const nowMs = this.nowFn();
    const state = this.getActiveState(envelope.binding);
    if (!state) {
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        diagnostic: {
          code: 'stale_generation_rejected',
          observedAt: nowMs,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: 'Frame binding does not match active runtime generation',
        },
        commits: [],
      };
    }

    if (
      (opts?.profileRef && opts.profileRef !== state.profileRef) ||
      (opts?.sourceRef && opts.sourceRef !== state.sourceRef)
    ) {
      const diag = this.pushDiagnostic(state, {
        code: 'cross_profile_rejected',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: 'Rejected ingress frame from mismatched profile or source scope',
      });
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        diagnostic: diag,
        commits: [],
      };
    }

    // Bind live connection if not yet set; reject frames from a stale connection
    if (envelope.channel === 'live') {
      if (state.activeConnectionId === null) {
        state.activeConnectionId = envelope.connectionId;
      } else if (state.activeConnectionId !== envelope.connectionId) {
        const diag = this.pushDiagnostic(state, {
          code: 'stale_generation_rejected',
          observedAt: nowMs,
          runtimeId: state.binding.runtimeId,
          generation: state.binding.generation,
          detail: 'Rejected frame from non-active connection',
        });
        return {
          accepted: false,
          deduplicated: false,
          buffered: false,
          affectedAgentIds: [],
          affectedWorkIds: [],
          diagnostic: diag,
          commits: [],
        };
      }
    }

    // Ingress ordinal deduplication per connection
    const dedupKey = `${envelope.connectionId}:${envelope.ingressOrdinal}`;
    if (state.seenIngressOrdinals.has(dedupKey)) {
      const diag = this.pushDiagnostic(state, {
        code: 'duplicate_ingress_ignored',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: `Duplicate ingress ordinal ${envelope.ingressOrdinal}`,
      });
      return {
        accepted: true,
        deduplicated: true,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        diagnostic: diag,
        commits: [],
      };
    }
    state.seenIngressOrdinals.add(dedupKey);

    const wireObj = asRecord(envelope.wire);
    if (!wireObj) {
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        commits: [],
      };
    }

    // Unwrap JSON-RPC params/update shape if present
    const paramsObj = asRecord(wireObj.params) ?? wireObj;
    const updateObj = asRecord(paramsObj.update) ?? paramsObj;
    const updateKind = readNonEmptyString(updateObj, ['sessionUpdate', 'type', 'kind']) ?? '';
    const outerWireSessionId =
      envelope.originSession?.trim() ||
      readNonEmptyString(paramsObj, ['sessionId']) ||
      readNonEmptyString(updateObj, ['sessionId']) ||
      state.rootNativeSessionId;

    // 1. Explicit child announcement / subagent_update (ACP v1 optional extension or v2 Preview)
    if (
      updateKind === 'subagent_update' ||
      updateKind === 'subagent_announced' ||
      updateKind === 'subagent_state_update' ||
      updateKind === 'session_message'
    ) {
      return this.handleExplicitChildProtocolFrame(
        state,
        envelope,
        outerWireSessionId,
        updateKind,
        updateObj,
        nowMs,
      );
    }

    // 2. Parent or child invoking a subagent via `tool_call` / `tool_call_update`
    if (updateKind === 'tool_call' || updateKind === 'tool_call_update') {
      const title = readNonEmptyString(updateObj, ['title', 'toolName']) ?? '';
      const toolName = readNonEmptyString(updateObj, ['toolName']) ?? '';
      const isSubagentTool =
        /invoke_subagent/i.test(title) ||
        /invoke_subagent/i.test(toolName) ||
        this.lookupToolCallWork(state, outerWireSessionId, readNonEmptyString(updateObj, ['toolCallId']) ?? '') !== null;

      if (isSubagentTool) {
        return this.handleSubagentLaunchToolFrame(
          state,
          envelope,
          outerWireSessionId,
          updateObj,
          nowMs,
        );
      }
    }

    // 3. Regular session update routed to a confirmed child session (or buffered if unknown non-root session)
    if (outerWireSessionId !== state.rootNativeSessionId) {
      const childAgentId = this.lookupSessionAgent(state, outerWireSessionId);
      if (!childAgentId) {
        return this.bufferUnownedChildFrame(state, envelope, outerWireSessionId, nowMs);
      }
      return this.handleConfirmedChildActivityFrame(
        state,
        envelope,
        childAgentId,
        outerWireSessionId,
        updateKind,
        updateObj,
        nowMs,
      );
    }

    // Root non-subagent frame: not owned by NP-05 child router
    return {
      accepted: false,
      deduplicated: false,
      buffered: false,
      affectedAgentIds: [],
      affectedWorkIds: [],
      commits: [],
    };
  }

  /**
   * Ingests versioned read-only native child snapshots from the bound profile's `appDataPath`.
   * - Strictly validates profile/source scope & generation.
   * - Uses versioned parser (`app_v1` / `cli_legacy_v0`), failing closed on unknown/newer schemas.
   * - Establishes `snapshot_confirmed` relationships (NEVER granting live cancel capability).
   * - NEVER reads parent `logs/transcript.jsonl` as child transcript.
   */
  ingestReadOnlySnapshot(params: {
    readonly binding: RuntimeBinding;
    readonly profileRef: string;
    readonly sourceRef: string;
    readonly appDataPath?: string;
    readonly parentNativeSessionId?: string;
    readonly scanOptions?: ChildRecordScanOptions;
  }): {
    readonly scan: ChildRecordScanResult;
    readonly affectedAgentIds: readonly NativeAgentId[];
    readonly commits: readonly {
      readonly mutation: NativeCommitMutation;
      readonly eventDraft: NativeEventDraft;
    }[];
  } {
    const nowMs = params.scanOptions?.nowMs ?? this.nowFn();
    const state = this.getActiveState(params.binding);
    const parentNativeId = params.parentNativeSessionId?.trim() || state?.rootNativeSessionId || '';

    if (!state) {
      return {
        scan: {
          parentNativeSessionId: parentNativeId,
          records: [],
          rejected: [],
          scannedFileCount: 0,
          truncatedDirectoryScan: false,
          observedAt: nowMs,
          staleAt: nowMs + DEFAULT_CHILD_SCAN_LIMITS.staleTtlMs,
          readerDisabledReason: 'stale_binding_or_generation',
        },
        affectedAgentIds: [],
        commits: [],
      };
    }

    if (params.profileRef !== state.profileRef || params.sourceRef !== state.sourceRef) {
      this.pushDiagnostic(state, {
        code: 'cross_profile_rejected',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: 'Rejected read-only snapshot from mismatched profile or source scope',
      });
      return {
        scan: {
          parentNativeSessionId: parentNativeId,
          records: [],
          rejected: [],
          scannedFileCount: 0,
          truncatedDirectoryScan: false,
          observedAt: nowMs,
          staleAt: nowMs + DEFAULT_CHILD_SCAN_LIMITS.staleTtlMs,
          readerDisabledReason: 'cross_profile_scope_mismatch',
        },
        affectedAgentIds: [],
        commits: [],
      };
    }

    const appDataPath = params.appDataPath ?? state.appDataPath;
    if (!state.enableReadOnlySnapshot || !appDataPath) {
      this.pushDiagnostic(state, {
        code: 'snapshot_reader_disabled',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: 'Read-only snapshot reader is disabled or appDataPath is not configured',
      });
      return {
        scan: {
          parentNativeSessionId: parentNativeId,
          records: [],
          rejected: [],
          scannedFileCount: 0,
          truncatedDirectoryScan: false,
          observedAt: nowMs,
          staleAt: nowMs + DEFAULT_CHILD_SCAN_LIMITS.staleTtlMs,
          readerDisabledReason: 'snapshot_reader_disabled',
        },
        affectedAgentIds: [],
        commits: [],
      };
    }

    // Verify parentNativeId belongs to a confirmed agent in this binding (root or confirmed child)
    const parentAgentId = this.lookupSessionAgent(state, parentNativeId);
    if (!parentAgentId) {
      return {
        scan: {
          parentNativeSessionId: parentNativeId,
          records: [],
          rejected: [],
          scannedFileCount: 0,
          truncatedDirectoryScan: false,
          observedAt: nowMs,
          staleAt: nowMs + DEFAULT_CHILD_SCAN_LIMITS.staleTtlMs,
          readerDisabledReason: 'parent_session_not_in_binding',
        },
        affectedAgentIds: [],
        commits: [],
      };
    }

    const scan = scanVersionedChildRecords(appDataPath, parentNativeId, {
      ...state.snapshotScanOptions,
      ...params.scanOptions,
      nowMs,
    });

    for (const rej of scan.rejected) {
      this.pushDiagnostic(state, {
        code: 'snapshot_record_rejected',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: `${rej.fileName}:${rej.reasonCode}`,
      });
    }

    const affectedAgentIds: NativeAgentId[] = [];
    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [];

    for (const rec of scan.records) {
      const applied = this.applySnapshotRecord(state, parentAgentId, parentNativeId, rec, nowMs);
      if (applied) {
        affectedAgentIds.push(applied.agentId);
        commits.push(...applied.commits);
      }
    }

    return { scan, affectedAgentIds, commits };
  }

  /**
   * Applies generated commits directly to `AgyNativeRuntimeRegistry` (SQLite + event bus)
   * when wired into the daemon.
   */
  commitToRegistry(
    registry: AgyNativeRuntimeRegistry,
    binding: RuntimeBinding,
    commits: readonly { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }[],
  ): void {
    for (const item of commits) {
      registry.commitAndPublish(binding, item.mutation, item.eventDraft);
    }
  }

  // ── ChildScopeResolverPort (Shared Contract for NP-07) ───────────────

  resolveScope(input: ChildRouteLookupInput): ChildScopeResolution {
    const state = this.getActiveState(input.binding);
    if (!state) {
      return {
        contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
        matchKind: 'rejected_scope',
        actualWireSessionId: input.wireSessionId,
        forwardedViaParent: false,
        lineage: 'unresolved',
        capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
        reasonCode: 'stale_binding_or_generation',
        allowConfirmedChildAttribution: false,
        rejectRequest: true,
      };
    }

    if (
      input.profileRef !== state.profileRef ||
      (input.sourceRef && input.sourceRef !== state.sourceRef)
    ) {
      return {
        contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
        matchKind: 'rejected_scope',
        actualWireSessionId: input.wireSessionId,
        forwardedViaParent: false,
        lineage: 'unresolved',
        capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
        reasonCode: 'cross_profile_scope_mismatch',
        allowConfirmedChildAttribution: false,
        rejectRequest: true,
      };
    }

    if (
      input.connectionId &&
      state.activeConnectionId &&
      input.connectionId !== state.activeConnectionId
    ) {
      return {
        contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
        matchKind: 'rejected_scope',
        actualWireSessionId: input.wireSessionId,
        forwardedViaParent: false,
        lineage: 'unresolved',
        capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
        reasonCode: 'stale_connection_id',
        allowConfirmedChildAttribution: false,
        rejectRequest: true,
      };
    }

    const wireIsRoot =
      input.wireSessionId === state.rootNativeSessionId &&
      input.rootNativeSessionId === state.rootNativeSessionId;

    if (wireIsRoot) {
      // Check if this parent-forwarded request carries a verified child hint (AGY 1.5.16+ forwarding)
      if (input.wireChildSessionId && input.wireChildSessionId !== state.rootNativeSessionId) {
        const inferredAgentId = this.lookupSessionAgent(state, input.wireChildSessionId);
        if (inferredAgentId) {
          const rec = state.agents.get(inferredAgentId);
          const rel = state.relations.get(inferredAgentId);
          if (rec && rec.identity.lineage === 'confirmed' && rel) {
            return {
              contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
              matchKind: 'forwarded_parent_with_inferred_child',
              actualWireSessionId: input.wireSessionId,
              forwardedViaParent: true,
              targetAgentId: state.rootAgentId,
              displayOwnerAgentId: inferredAgentId,
              lineage: 'confirmed',
              ...(rel.launchWorkId ? { launchWorkId: rel.launchWorkId } : {}),
              capabilities: rec.capabilities,
              evidence: rel.evidence,
              reasonCode: 'forwarded_via_parent_verified_child_session',
              allowConfirmedChildAttribution: true,
              rejectRequest: false,
            };
          }
          if (rec?.identity.lineage === 'conflicting') {
            return {
              contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
              matchKind: 'conflicting_child',
              actualWireSessionId: input.wireSessionId,
              forwardedViaParent: true,
              targetAgentId: state.rootAgentId,
              displayOwnerAgentId: inferredAgentId,
              lineage: 'conflicting',
              capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
              reasonCode: 'forwarded_child_lineage_conflicting',
              allowConfirmedChildAttribution: false,
              rejectRequest: true,
            };
          }
        }
        return {
          contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
          matchKind: 'unresolved_child',
          actualWireSessionId: input.wireSessionId,
          forwardedViaParent: true,
          targetAgentId: state.rootAgentId,
          lineage: 'unresolved',
          capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
          reasonCode: 'forwarded_child_session_unverified',
          allowConfirmedChildAttribution: false,
          rejectRequest: false,
        };
      }

      // Check if toolCallId maps via verified launchWork -> confirmed child (NEVER raw toolId == childId!)
      if (input.toolCallId) {
        const launchWorkId = this.lookupToolCallWork(state, input.wireSessionId, input.toolCallId);
        if (launchWorkId) {
          const verifiedChild = this.findConfirmedChildByLaunchWork(state, launchWorkId);
          if (verifiedChild) {
            const rel = state.relations.get(verifiedChild.identity.id);
            return {
              contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
              matchKind: 'forwarded_parent_with_inferred_child',
              actualWireSessionId: input.wireSessionId,
              forwardedViaParent: true,
              targetAgentId: state.rootAgentId,
              displayOwnerAgentId: verifiedChild.identity.id,
              lineage: 'confirmed',
              launchWorkId,
              capabilities: verifiedChild.capabilities,
              ...(rel?.evidence ? { evidence: rel.evidence } : {}),
              reasonCode: 'forwarded_via_parent_verified_launch_work',
              allowConfirmedChildAttribution: true,
              rejectRequest: false,
            };
          }
          // Launch work exists, but child identity is NOT confirmed yet
          return {
            contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
            matchKind: 'unresolved_child',
            actualWireSessionId: input.wireSessionId,
            forwardedViaParent: true,
            targetAgentId: state.rootAgentId,
            lineage: 'unresolved',
            launchWorkId,
            capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
            reasonCode: 'launch_work_child_identity_unresolved',
            allowConfirmedChildAttribution: false,
            rejectRequest: false,
          };
        }
      }

      return {
        contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
        matchKind: 'root_session',
        actualWireSessionId: input.wireSessionId,
        forwardedViaParent: false,
        targetAgentId: state.rootAgentId,
        lineage: 'confirmed',
        capabilities: state.agents.get(state.rootAgentId)?.capabilities ?? READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
        reasonCode: 'root_wire_session',
        allowConfirmedChildAttribution: false,
        rejectRequest: false,
      };
    }

    // Non-root wire session: must match a confirmed child session alias in the current generation
    const childAgentId = this.lookupSessionAgent(state, input.wireSessionId);
    if (childAgentId) {
      const rec = state.agents.get(childAgentId);
      const rel = state.relations.get(childAgentId);
      if (rec?.identity.lineage === 'conflicting') {
        return {
          contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
          matchKind: 'conflicting_child',
          actualWireSessionId: input.wireSessionId,
          forwardedViaParent: false,
          targetAgentId: childAgentId,
          displayOwnerAgentId: childAgentId,
          lineage: 'conflicting',
          capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
          reasonCode: 'child_lineage_conflicting',
          allowConfirmedChildAttribution: false,
          rejectRequest: true,
        };
      }
      if (rec && rec.identity.lineage === 'confirmed' && rel) {
        return {
          contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
          matchKind: 'confirmed_child',
          actualWireSessionId: input.wireSessionId,
          forwardedViaParent: false,
          targetAgentId: childAgentId,
          displayOwnerAgentId: childAgentId,
          lineage: 'confirmed',
          ...(rel.launchWorkId ? { launchWorkId: rel.launchWorkId } : {}),
          capabilities: rec.capabilities,
          evidence: rel.evidence,
          reasonCode: 'confirmed_child_wire_session',
          allowConfirmedChildAttribution: true,
          rejectRequest: false,
        };
      }
    }

    return {
      contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
      matchKind: 'unresolved_child',
      actualWireSessionId: input.wireSessionId,
      forwardedViaParent: false,
      lineage: 'unresolved',
      capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
      reasonCode: 'unknown_non_root_wire_session',
      allowConfirmedChildAttribution: false,
      rejectRequest: false,
    };
  }

  authorizeChildCancel(binding: RuntimeBinding, agentId: NativeAgentId): ChildCancelAuthorization {
    const state = this.getActiveState(binding);
    if (!state) {
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode: 'stale_binding_or_generation',
      };
    }
    if (!state.activeConnectionId) {
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode: 'no_live_connection',
      };
    }
    const rec = state.agents.get(agentId);
    if (!rec) {
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode: 'agent_not_found',
      };
    }
    if (agentId === state.rootAgentId) {
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode: 'root_uses_session_cancel',
      };
    }
    if (rec.identity.lineage !== 'confirmed') {
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode:
          rec.identity.lineage === 'conflicting'
            ? 'child_lineage_conflicting'
            : 'child_lineage_unconfirmed',
      };
    }
    if (!rec.capabilities.canCancel) {
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode: rec.capabilities.cancelReasonCode ?? 'child_cancel_not_advertised',
      };
    }
    const wireSessionId = [...rec.sessionAliases][0];
    if (!wireSessionId) {
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode: 'missing_live_child_session_alias',
      };
    }
    return {
      allowed: true,
      targetAgentId: agentId,
      wireSessionId,
      reasonCode: 'child_cancel_capability_verified',
    };
  }

  getChildCapabilities(binding: RuntimeBinding, agentId: NativeAgentId): ChildAgentCapabilities {
    const state = this.getActiveState(binding);
    if (!state) return READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES;
    return state.agents.get(agentId)?.capabilities ?? READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES;
  }

  // ── NativeTimelineReaderPort (NP-02 Route Adapter) ───────────────────

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
  } {
    if (input.scopeKind !== 'agent') {
      return {
        revision: 0,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'scope_not_owned_by_child_router',
      };
    }

    const state =
      this.getActiveState(input.binding) ??
      this.historicalByRuntimeGen.get(`${input.binding.runtimeId}|${input.binding.generation}`) ??
      null;

    if (!state) {
      return {
        revision: 0,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'binding_not_found',
      };
    }

    const rec = state.agents.get(input.scopeId as NativeAgentId);
    if (!rec) {
      return {
        revision: state.timelineRevision,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'agent_not_found',
      };
    }

    if (rec.identity.lineage === 'unresolved') {
      return {
        revision: state.timelineRevision,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'child_lineage_unconfirmed',
      };
    }

    if (rec.identity.lineage === 'conflicting') {
      return {
        revision: state.timelineRevision,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'child_lineage_conflicting',
      };
    }

    let entries: readonly NativeTimelineEntryDto[] = rec.timeline;

    // If no live timeline entries exist, try reading ONLY the child's own sibling JSONL
    // (NEVER falling back to parent transcript!)
    if (entries.length === 0 && state.enableReadOnlySnapshot && state.appDataPath && rec.appDataRecordRef) {
      const read = readChildOwnedTranscriptOnly(
        state.appDataPath,
        rec.appDataRecordRef.parentNativeSessionId,
        rec.appDataRecordRef.recordId,
      );
      if (read.available && read.lines.length > 0) {
        const nowMs = this.nowFn();
        entries = read.lines.map((line, idx) =>
          NativeTimelineEntryDtoSchema.parse({
            entryId: `snap_${rec.identity.id}_${idx + 1}`,
            seq: idx + 1,
            timestamp: nowMs,
            kind: 'assistant_text',
            actorKind: 'child',
            actorId: rec.identity.id,
            actorLabel:
              rec.identity.label?.kind === 'known'
                ? rec.identity.label.value
                : rec.identity.role?.kind === 'known'
                  ? rec.identity.role.value
                  : undefined,
            text: redactPrivateChildText(line, 4000),
            truncated: read.truncated,
            evidence: {
              sourceKind: 'native_snapshot',
              freshness: 'snapshot',
              observedAt: nowMs,
            },
          }),
        );
      } else {
        return {
          revision: state.timelineRevision,
          items: [],
          nextPageToken: null,
          hasMore: false,
          sourceUnavailableReason:
            read.reasonCode === 'path_or_reparse_rejected'
              ? 'child_transcript_path_rejected'
              : 'child_transcript_source_not_provided',
        };
      }
    }

    if (entries.length === 0) {
      return {
        revision: state.timelineRevision,
        items: [],
        nextPageToken: null,
        hasMore: false,
        sourceUnavailableReason: 'child_transcript_source_not_provided',
      };
    }

    const offset = decodePageToken(input.pageToken);
    const cappedLimit = Math.min(Math.max(1, input.limit), 200);
    const slice = entries.slice(offset, offset + cappedLimit);
    const hasMore = offset + slice.length < entries.length;

    return {
      revision: state.timelineRevision,
      items: slice,
      nextPageToken: hasMore ? encodePageToken(offset + slice.length) : null,
      hasMore,
    };
  }

  // ── Read Helpers for Tests & Diagnostics ─────────────────────────────

  getStateSnapshot(binding: RuntimeBinding): {
    readonly agents: readonly AgentIdentity[];
    readonly work: readonly NativeWork[];
    readonly relations: readonly NativeRelationship[];
    readonly diagnostics: readonly ChildRouterDiagnostic[];
    readonly unownedBufferedCount: number;
    readonly isHistorical: boolean;
  } | null {
    const active = this.getActiveState(binding);
    const historical =
      !active
        ? this.historicalByRuntimeGen.get(`${binding.runtimeId}|${binding.generation}`) ?? null
        : null;
    const state = active ?? historical;
    if (!state) return null;

    return {
      agents: [...state.agents.values()].map((a) => a.identity),
      work: [...state.work.values()],
      relations: [...state.relations.values()],
      diagnostics: [...state.diagnostics],
      unownedBufferedCount: state.unownedFrames.length,
      isHistorical: Boolean(historical),
    };
  }

  // ── Internal Handlers ────────────────────────────────────────────────

  private getActiveState(binding: RuntimeBinding): GenerationState | null {
    const state = this.activeByRuntime.get(binding.runtimeId);
    if (!state) return null;
    if (
      state.binding.generation !== binding.generation ||
      state.binding.sessionId !== binding.sessionId ||
      state.binding.instanceId !== binding.instanceId
    ) {
      return null;
    }
    return state;
  }

  private demoteStateToHistorical(state: GenerationState, reasonCode: string): void {
    state.activeConnectionId = null;
    state.unownedFrames.length = 0;
    this.markAgentsAndWorkStale(state, reasonCode);
    this.historicalByRuntimeGen.set(
      `${state.binding.runtimeId}|${state.binding.generation}`,
      state,
    );
  }

  private markAgentsAndWorkStale(state: GenerationState, reasonCode: string): void {
    for (const rec of state.agents.values()) {
      rec.capabilities = {
        ...rec.capabilities,
        canObserveLiveStream: false,
        canCancel: false,
        canSteer: false,
        canLoadDirect: false,
        cancelReasonCode: reasonCode,
      };
      const prevFg = rec.identity.foreground;
      const staleFg: Observed<AgentForeground> =
        prevFg.kind === 'known'
          ? { kind: 'stale', last: prevFg.value, evidence: prevFg.evidence, reasonCode }
          : prevFg.kind === 'stale'
            ? { ...prevFg, reasonCode }
            : { kind: 'unknown', reasonCode };

      const prevStatus = rec.identity.status;
      const staleStatus: Observed<WorkState> | undefined = prevStatus
        ? prevStatus.kind === 'known'
          ? { kind: 'stale', last: prevStatus.value, evidence: prevStatus.evidence, reasonCode }
          : prevStatus.kind === 'stale'
            ? { ...prevStatus, reasonCode }
            : { kind: 'unknown', reasonCode }
        : undefined;

      rec.identity = AgentIdentitySchema.parse({
        ...rec.identity,
        foreground: staleFg,
        ...(staleStatus ? { status: staleStatus } : {}),
        revision: rec.identity.revision + 1,
      });
    }

    for (const [workId, work] of state.work.entries()) {
      if (
        work.state.kind === 'known' &&
        !['finished', 'failed', 'cancelled'].includes(work.state.value)
      ) {
        state.work.set(
          workId,
          NativeWorkSchema.parse({
            ...work,
            state: {
              kind: 'stale',
              last: work.state.value,
              evidence: work.state.evidence,
              reasonCode,
            },
            revision: work.revision + 1,
          }),
        );
      }
    }
  }

  private pushDiagnostic(state: GenerationState, diag: ChildRouterDiagnostic): ChildRouterDiagnostic {
    if (state.diagnostics.length >= this.limits.maxDiagnostics) {
      state.diagnostics.shift();
    }
    state.diagnostics.push(diag);
    return diag;
  }

  private lookupSessionAgent(state: GenerationState, nativeSessionId: string): NativeAgentId | null {
    const entry = state.aliases.get(aliasKey('session', '', nativeSessionId));
    if (entry && entry.targetEntityKind === 'agent') {
      return entry.targetEntityId as NativeAgentId;
    }
    return null;
  }

  private lookupRecordAgent(
    state: GenerationState,
    parentNativeSessionId: string,
    recordId: string,
  ): NativeAgentId | null {
    const entry = state.aliases.get(aliasKey('native_record', parentNativeSessionId, recordId));
    if (entry && entry.targetEntityKind === 'agent') {
      return entry.targetEntityId as NativeAgentId;
    }
    return null;
  }

  private lookupToolCallWork(
    state: GenerationState,
    originSessionId: string,
    toolCallId: string,
  ): WorkId | null {
    if (!toolCallId) return null;
    const entry = state.aliases.get(aliasKey('tool_call', originSessionId, toolCallId));
    if (entry && entry.targetEntityKind === 'work') {
      return entry.targetEntityId as WorkId;
    }
    return null;
  }

  private findConfirmedChildByLaunchWork(
    state: GenerationState,
    launchWorkId: WorkId,
  ): InternalAgentRecord | null {
    for (const rec of state.agents.values()) {
      if (rec.identity.lineage === 'confirmed' && rec.identity.launchWorkIds.includes(launchWorkId)) {
        return rec;
      }
    }
    return null;
  }

  private findUnresolvedCandidateByLaunchWork(
    state: GenerationState,
    launchWorkId: WorkId,
  ): InternalAgentRecord | null {
    for (const rec of state.agents.values()) {
      if (rec.identity.lineage === 'unresolved' && rec.identity.launchWorkIds.includes(launchWorkId)) {
        return rec;
      }
    }
    return null;
  }

  private validateLineageEdge(
    state: GenerationState,
    parentAgentId: NativeAgentId,
    childAgentId: NativeAgentId,
    nowMs: number,
  ): { readonly ok: true } | { readonly ok: false; readonly diagnostic: ChildRouterDiagnostic } {
    if (parentAgentId === childAgentId) {
      return {
        ok: false,
        diagnostic: this.pushDiagnostic(state, {
          code: 'relation_cycle_rejected',
          observedAt: nowMs,
          runtimeId: state.binding.runtimeId,
          generation: state.binding.generation,
          detail: `Self-parent cycle rejected for ${childAgentId}`,
        }),
      };
    }

    const existing = state.relations.get(childAgentId);
    if (existing && existing.parentAgentId !== parentAgentId) {
      return {
        ok: false,
        diagnostic: this.pushDiagnostic(state, {
          code: 'relation_parent_conflict_rejected',
          observedAt: nowMs,
          runtimeId: state.binding.runtimeId,
          generation: state.binding.generation,
          detail: `Child ${childAgentId} already bound to parent ${existing.parentAgentId}, rejecting ${parentAgentId}`,
        }),
      };
    }

    // Walk ancestor chain from parentAgentId to verify acyclicity and max depth
    let cursor: NativeAgentId | null = parentAgentId;
    const visited = new Set<NativeAgentId>([childAgentId]);
    let depth = 1;
    while (cursor) {
      if (visited.has(cursor)) {
        return {
          ok: false,
          diagnostic: this.pushDiagnostic(state, {
            code: 'relation_cycle_rejected',
            observedAt: nowMs,
            runtimeId: state.binding.runtimeId,
            generation: state.binding.generation,
            detail: `Ancestor cycle rejected for ${parentAgentId} -> ${childAgentId}`,
          }),
        };
      }
      if (depth > this.limits.maxAncestorDepth) {
        return {
          ok: false,
          diagnostic: this.pushDiagnostic(state, {
            code: 'ancestor_depth_exceeded',
            observedAt: nowMs,
            runtimeId: state.binding.runtimeId,
            generation: state.binding.generation,
            detail: `Ancestor depth limit (${this.limits.maxAncestorDepth}) exceeded`,
          }),
        };
      }
      visited.add(cursor);
      const rel = state.relations.get(cursor);
      cursor = rel ? rel.parentAgentId : null;
      depth += 1;
    }

    return { ok: true };
  }

  private handleSubagentLaunchToolFrame(
    state: GenerationState,
    envelope: NativeIngress,
    originSessionId: string,
    updateObj: Record<string, unknown>,
    nowMs: number,
  ): ChildFrameIngestionResult {
    const toolCallId = readNonEmptyString(updateObj, ['toolCallId']);
    if (!toolCallId) {
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        commits: [],
      };
    }

    const parentAgentId = this.lookupSessionAgent(state, originSessionId);
    if (!parentAgentId) {
      return this.bufferUnownedChildFrame(state, envelope, originSessionId, nowMs);
    }

    const evidence = buildLiveOrReplayEvidence(envelope, 'tool_call:invoke_subagent', nowMs);
    const rawInput = asRecord(updateObj.rawInput) ?? {};
    const rawOutput = asRecord(updateObj.rawOutput) ?? asRecord(updateObj.result) ?? {};
    const rawStatus = readNonEmptyString(updateObj, ['status']) ?? 'running';
    const workState = mapToolStatusToWorkState(rawStatus);

    const role = readNonEmptyString(rawInput, ['Role', 'role']);
    const typeName = readNonEmptyString(rawInput, ['TypeName', 'typeName']);
    const label = role
      ? redactPrivateChildText(role, DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars)
      : typeName
        ? redactPrivateChildText(typeName, DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars)
        : undefined;

    // 1. Upsert launch work in `tool_call` namespace (NEVER conflated with child sessionId!)
    let workId = this.lookupToolCallWork(state, originSessionId, toolCallId);
    const isNewWork = !workId;
    if (!workId) {
      workId = asWorkId(
        stableScopedId(
          'wrk',
          `subagent_launch|${state.binding.runtimeId}|${state.binding.generation}|${originSessionId}|${toolCallId}`,
        ),
      );
    }
    const prevWork = state.work.get(workId);
    const nextWork: NativeWork = NativeWorkSchema.parse({
      id: workId,
      kind: 'subagent',
      ownerAgentId: parentAgentId,
      blocking: prevWork?.blocking ?? 'unknown',
      state: { kind: 'known', value: workState, evidence },
      ...(workState === 'failed'
        ? { outcome: { kind: 'known', value: 'failed', evidence } }
        : workState === 'cancelled'
          ? { outcome: { kind: 'known', value: 'cancelled', evidence } }
          : prevWork?.outcome
            ? { outcome: prevWork.outcome }
            : {}),
      ...(label ?? prevWork?.observedLabel ? { observedLabel: label ?? prevWork?.observedLabel } : {}),
      revision: (prevWork?.revision ?? 0) + 1,
    });
    state.work.set(workId, nextWork);

    const toolAlias: NativeAlias = {
      namespace: 'tool_call',
      originSessionId,
      nativeValue: toolCallId,
      evidence,
    };
    state.aliases.set(aliasKey('tool_call', originSessionId, toolCallId), {
      namespace: 'tool_call',
      originSessionId,
      nativeValue: toolCallId,
      targetEntityKind: 'work',
      targetEntityId: workId,
      alias: toolAlias,
    });

    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [
      {
        mutation: {
          work: [nextWork],
          aliases: isNewWork
            ? [{ targetEntityKind: 'work', targetEntityId: workId, alias: toolAlias }]
            : [],
        },
        eventDraft: {
          type: 'native.work.changed',
          turnId: null,
          payload: { work: sanitizeNativeWorkForPublic(nextWork, nowMs) },
          mutationKey: `np05:work:${envelope.connectionId}:${envelope.ingressOrdinal}`,
          createdAt: nowMs,
        },
      },
    ];

    // 2. Check if tool output explicitly carries a verified child conversation/session ID
    const verifiedChildSessionId =
      readNonEmptyString(rawOutput, ['conversationId', 'childSessionId', 'subagentSessionId']) ??
      readNonEmptyString(asRecord(updateObj._meta) ?? {}, ['childSessionId', 'conversationId']);

    if (verifiedChildSessionId && verifiedChildSessionId !== originSessionId) {
      const childCapsObj = asRecord(rawOutput.capabilities) ?? asRecord(updateObj.capabilities);
      const promoted = this.upsertConfirmedChild(state, {
        parentAgentId,
        childNativeSessionId: verifiedChildSessionId,
        launchWorkId: workId,
        launchToolCallId: toolCallId,
        role: label,
        label,
        foreground: workState === 'running' || workState === 'queued' ? 'running' : 'idle',
        status: workState,
        confidence: 'protocol_confirmed',
        evidence,
        channel: envelope.channel,
        capabilitiesObj: childCapsObj,
        nowMs,
        mutationKeyPrefix: `np05:tool_join:${envelope.connectionId}:${envelope.ingressOrdinal}`,
      });
      if (!promoted.ok) {
        return {
          accepted: false,
          deduplicated: false,
          buffered: false,
          affectedAgentIds: promoted.agentId ? [promoted.agentId] : [],
          affectedWorkIds: [workId],
          diagnostic: promoted.diagnostic,
          commits: [...commits, ...promoted.commits],
        };
      }
      return {
        accepted: true,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [promoted.agentId],
        affectedWorkIds: [workId],
        commits: [...commits, ...promoted.commits],
      };
    }

    // 3. No verified child conversationId yet:
    //    If already confirmed via a prior announcement for this launchWorkId, keep it;
    //    otherwise create/update an UNRESOLVED candidate (never fabricating a confirmed edge!).
    const confirmedExisting = this.findConfirmedChildByLaunchWork(state, workId);
    if (confirmedExisting) {
      return {
        accepted: true,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [confirmedExisting.identity.id],
        affectedWorkIds: [workId],
        commits,
      };
    }

    const existingCandidate = this.findUnresolvedCandidateByLaunchWork(state, workId);
    if (!existingCandidate && state.agents.size >= this.limits.maxAgentsPerRuntime) {
      const diag = this.pushDiagnostic(state, {
        code: 'agent_cap_exceeded',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: `Agent cap (${this.limits.maxAgentsPerRuntime}) reached`,
      });
      return {
        accepted: true,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [workId],
        diagnostic: diag,
        commits,
      };
    }

    const candidateId =
      existingCandidate?.identity.id ??
      asNativeAgentId(
        stableScopedId(
          'agt',
          `unresolved_launch|${state.binding.runtimeId}|${state.binding.generation}|${workId}`,
        ),
      );
    const nextCandidate: AgentIdentity = AgentIdentitySchema.parse({
      id: candidateId,
      ...(label
        ? { role: { kind: 'known', value: label, evidence } }
        : existingCandidate?.identity.role
          ? { role: existingCandidate.identity.role }
          : { role: { kind: 'unknown', reasonCode: 'subagent_role_not_observed' } }),
      ...(label
        ? { label: { kind: 'known', value: label, evidence } }
        : existingCandidate?.identity.label
          ? { label: existingCandidate.identity.label }
          : {}),
      foreground: { kind: 'unknown', reasonCode: 'no_child_session_id_observed' },
      status: { kind: 'known', value: workState, evidence },
      launchWorkIds: [workId],
      lineage: 'unresolved',
      revision: (existingCandidate?.identity.revision ?? 0) + 1,
    });

    if (existingCandidate) {
      existingCandidate.identity = nextCandidate;
      existingCandidate.launchToolCallIds.add(toolCallId);
    } else {
      state.agents.set(candidateId, {
        identity: nextCandidate,
        capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
        sessionAliases: new Set(),
        recordAliases: new Set(),
        launchToolCallIds: new Set([toolCallId]),
        timeline: [],
        timelineSeq: 0,
        droppedTimelineEntries: 0,
        seenStableEventIds: new Set(),
      });
    }

    commits.push({
      mutation: { agents: [nextCandidate] },
      eventDraft: {
        type: 'native.agent.changed',
        turnId: null,
        payload: { agent: sanitizeAgentIdentityForPublic(nextCandidate, nowMs) },
        mutationKey: `np05:unresolved:${envelope.connectionId}:${envelope.ingressOrdinal}`,
        createdAt: nowMs,
      },
    });

    return {
      accepted: true,
      deduplicated: false,
      buffered: false,
      affectedAgentIds: [candidateId],
      affectedWorkIds: [workId],
      commits,
    };
  }

  private handleExplicitChildProtocolFrame(
    state: GenerationState,
    envelope: NativeIngress,
    outerWireSessionId: string,
    updateKind: string,
    updateObj: Record<string, unknown>,
    nowMs: number,
  ): ChildFrameIngestionResult {
    const childSessionId =
      readNonEmptyString(updateObj, ['childSessionId', 'subagentSessionId', 'conversationId']) ??
      (outerWireSessionId !== state.rootNativeSessionId ? outerWireSessionId : undefined);

    if (!childSessionId) {
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        commits: [],
      };
    }

    const explicitParentSessionId = readNonEmptyString(updateObj, ['parentSessionId', 'originSessionId']);
    const parentSessionId =
      explicitParentSessionId ??
      (outerWireSessionId !== childSessionId ? outerWireSessionId : undefined);

    const existingChildId = this.lookupSessionAgent(state, childSessionId);
    let parentAgentId = parentSessionId ? this.lookupSessionAgent(state, parentSessionId) : null;
    if (!parentAgentId && existingChildId) {
      parentAgentId = state.relations.get(existingChildId)?.parentAgentId ?? null;
    }

    if (!parentAgentId) {
      // Cannot confirm parent lineage yet — buffer boundedly if live
      return this.bufferUnownedChildFrame(state, envelope, childSessionId, nowMs);
    }

    const launchToolCallId = readNonEmptyString(updateObj, ['launchToolCallId', 'toolCallId']);
    const launchWorkId =
      launchToolCallId && parentSessionId
        ? this.lookupToolCallWork(state, parentSessionId, launchToolCallId) ?? undefined
        : undefined;

    const evidence = buildLiveOrReplayEvidence(envelope, `protocol:${updateKind}`, nowMs);
    const rawState = readNonEmptyString(updateObj, ['state', 'status']);
    const rawForeground = readNonEmptyString(updateObj, ['foreground']);
    const mapped = rawState ? mapNativeChildRecordState(rawState) : null;
    const foreground: AgentForeground | undefined =
      rawForeground === 'running' ||
      rawForeground === 'requires_action' ||
      rawForeground === 'idle' ||
      rawForeground === 'unknown'
        ? rawForeground
        : mapped?.foreground ?? (updateKind === 'session_message' ? 'running' : undefined);

    const role = readNonEmptyString(updateObj, ['role', 'Role']);
    const label = readNonEmptyString(updateObj, ['label', 'displayName', 'name']);
    const capabilitiesObj = asRecord(updateObj.capabilities);

    const promoted = this.upsertConfirmedChild(state, {
      parentAgentId,
      childNativeSessionId: childSessionId,
      launchWorkId,
      launchToolCallId,
      role: role ? redactPrivateChildText(role, DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars) : undefined,
      label: label ? redactPrivateChildText(label, DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars) : undefined,
      foreground,
      status: mapped?.workState,
      confidence: 'protocol_confirmed',
      evidence,
      channel: envelope.channel,
      capabilitiesObj,
      nowMs,
      mutationKeyPrefix: `np05:proto:${envelope.connectionId}:${envelope.ingressOrdinal}`,
    });

    if (!promoted.ok) {
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: promoted.agentId ? [promoted.agentId] : [],
        affectedWorkIds: launchWorkId ? [launchWorkId] : [],
        diagnostic: promoted.diagnostic,
        commits: promoted.commits,
      };
    }

    const commits = [...promoted.commits];

    // If this frame also carries message content (e.g., `session_message`), append to child's own timeline
    const textContent = this.extractTimelineText(updateObj);
    if (textContent) {
      const stableEventId = readNonEmptyString(updateObj, ['eventId', 'messageId', 'partId']);
      this.appendChildTimelineEntry(state, promoted.agentId, {
        kind: updateKind === 'session_message' ? 'assistant_text' : 'status',
        text: textContent,
        status: mapped?.workState,
        evidence,
        stableEventId,
        nowMs,
      });
    }

    // Drain any previously buffered unowned frames for this childSessionId on the same connection
    const drainedCommits = this.drainUnownedFramesForSession(
      state,
      childSessionId,
      envelope.connectionId,
      nowMs,
    );
    commits.push(...drainedCommits);

    return {
      accepted: true,
      deduplicated: false,
      buffered: false,
      affectedAgentIds: [promoted.agentId],
      affectedWorkIds: launchWorkId ? [launchWorkId] : [],
      commits,
    };
  }

  private handleConfirmedChildActivityFrame(
    state: GenerationState,
    envelope: NativeIngress,
    childAgentId: NativeAgentId,
    wireSessionId: string,
    updateKind: string,
    updateObj: Record<string, unknown>,
    nowMs: number,
  ): ChildFrameIngestionResult {
    const rec = state.agents.get(childAgentId);
    if (!rec || rec.identity.lineage !== 'confirmed') {
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        commits: [],
      };
    }

    const evidence = buildLiveOrReplayEvidence(envelope, `child:${updateKind || 'update'}`, nowMs);
    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [];
    let stateChanged = false;

    // Detect reactivation (idle -> running) or explicit state change!
    let nextForeground: AgentForeground | undefined;
    let nextStatus: WorkState | undefined;
    const rawState = readNonEmptyString(updateObj, ['state', 'status']);
    if (rawState) {
      const mapped = mapNativeChildRecordState(rawState);
      nextForeground = mapped.foreground;
      nextStatus = mapped.workState;
    }

    const explicitFg = readNonEmptyString(updateObj, ['foreground']);
    if (
      explicitFg === 'running' ||
      explicitFg === 'requires_action' ||
      explicitFg === 'idle' ||
      explicitFg === 'unknown'
    ) {
      nextForeground = explicitFg;
    } else if (
      !nextForeground &&
      (updateKind === 'agent_message_chunk' ||
        updateKind === 'agent_thought_chunk' ||
        updateKind === 'tool_call' ||
        updateKind === 'tool_call_update')
    ) {
      // Receiving active output reactivates an idle child cleanly (`idle -> running`)
      nextForeground = 'running';
      if (!nextStatus) nextStatus = 'running';
    }

    if (
      nextForeground &&
      (rec.identity.foreground.kind !== 'known' || rec.identity.foreground.value !== nextForeground)
    ) {
      stateChanged = true;
    }
    if (
      nextStatus &&
      (!rec.identity.status ||
        rec.identity.status.kind !== 'known' ||
        rec.identity.status.value !== nextStatus)
    ) {
      stateChanged = true;
    }

    // Update capabilities ONLY if explicitly provided on a live frame
    const capsObj = asRecord(updateObj.capabilities);
    if (capsObj && envelope.channel === 'live') {
      rec.capabilities = this.mergeCapabilities(rec.capabilities, capsObj, true);
    }

    // Append to child's own independent timeline (never deduplicating un-ID'd text chunks by string!)
    const stableEventId = readNonEmptyString(updateObj, ['eventId', 'messageId', 'partId']);
    const text = this.extractTimelineText(updateObj);
    const title = readNonEmptyString(updateObj, ['title', 'toolName']);

    if (updateKind === 'agent_message_chunk' && text !== undefined) {
      this.appendChildTimelineEntry(state, childAgentId, {
        kind: 'assistant_text',
        text,
        evidence,
        stableEventId,
        deltaCoalesceKey: `child_msg_${wireSessionId}`,
        nowMs,
      });
    } else if (updateKind === 'agent_thought_chunk' && text !== undefined) {
      this.appendChildTimelineEntry(state, childAgentId, {
        kind: 'thinking',
        text,
        evidence,
        stableEventId,
        deltaCoalesceKey: `child_thought_${wireSessionId}`,
        nowMs,
      });
    } else if (updateKind === 'tool_call' || updateKind === 'tool_call_update') {
      const toolCallId = readNonEmptyString(updateObj, ['toolCallId']);
      const toolStableId =
        stableEventId ??
        (toolCallId && rawState ? `tool:${toolCallId}:${rawState}:${envelope.ingressOrdinal}` : undefined);
      this.appendChildTimelineEntry(state, childAgentId, {
        kind: 'tool',
        title: title ? redactPrivateChildText(title, 200) : 'Tool call',
        text: text ?? rawState,
        status: nextStatus,
        evidence,
        stableEventId: toolStableId,
        nowMs,
      });
    } else if (text !== undefined || rawState) {
      this.appendChildTimelineEntry(state, childAgentId, {
        kind: 'status',
        title: title ? redactPrivateChildText(title, 200) : undefined,
        text: text ?? rawState,
        status: nextStatus,
        evidence,
        stableEventId,
        nowMs,
      });
    }

    if (stateChanged) {
      rec.identity = AgentIdentitySchema.parse({
        ...rec.identity,
        foreground: nextForeground
          ? { kind: 'known', value: nextForeground, evidence }
          : rec.identity.foreground,
        ...(nextStatus
          ? { status: { kind: 'known', value: nextStatus, evidence } }
          : rec.identity.status
            ? { status: rec.identity.status }
            : {}),
        revision: rec.identity.revision + 1,
      });
      commits.push({
        mutation: { agents: [rec.identity] },
        eventDraft: {
          type: 'native.agent.changed',
          turnId: null,
          payload: { agent: sanitizeAgentIdentityForPublic(rec.identity, nowMs) },
          mutationKey: `np05:child_act:${envelope.connectionId}:${envelope.ingressOrdinal}`,
          createdAt: nowMs,
        },
      });
    }

    return {
      accepted: true,
      deduplicated: false,
      buffered: false,
      affectedAgentIds: [childAgentId],
      affectedWorkIds: [],
      commits,
    };
  }

  private applySnapshotRecord(
    state: GenerationState,
    parentAgentId: NativeAgentId,
    parentNativeSessionId: string,
    rec: ParsedChildRecord,
    nowMs: number,
  ): {
    readonly agentId: NativeAgentId;
    readonly commits: readonly { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }[];
  } | null {
    // App v1 has verified conversationId (`session` namespace). Legacy v0 may only have recordId (`native_record` namespace).
    const existingBySession = rec.conversationId
      ? this.lookupSessionAgent(state, rec.conversationId)
      : null;
    const existingByRecord = this.lookupRecordAgent(state, parentNativeSessionId, rec.recordId);

    // Reject conflicting alias join if recordId and conversationId point to DIFFERENT agents!
    if (existingBySession && existingByRecord && existingBySession !== existingByRecord) {
      this.pushDiagnostic(state, {
        code: 'alias_namespace_conflict',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: `Record ${rec.recordId} conflicts with existing session agent ${existingBySession}`,
      });
      return null;
    }

    // If only `cli_legacy_v0` without a conversationId, keep separate `native_record` namespace!
    if (!rec.conversationId) {
      if (!existingByRecord && state.agents.size >= this.limits.maxAgentsPerRuntime) {
        this.pushDiagnostic(state, {
          code: 'agent_cap_exceeded',
          observedAt: nowMs,
          runtimeId: state.binding.runtimeId,
          generation: state.binding.generation,
          detail: `Agent cap (${this.limits.maxAgentsPerRuntime}) reached during snapshot scan`,
        });
        return null;
      }

      const agentId =
        existingByRecord ??
        asNativeAgentId(
          stableScopedId(
            'agt',
            `record_only|${state.binding.runtimeId}|${state.binding.generation}|${parentNativeSessionId}|${rec.recordId}`,
          ),
        );

      const edgeCheck = this.validateLineageEdge(state, parentAgentId, agentId, nowMs);
      if (!edgeCheck.ok) return null;

      const prev = state.agents.get(agentId);
      const nextIdentity: AgentIdentity = AgentIdentitySchema.parse({
        id: agentId,
        ...(rec.role
          ? { role: { kind: 'known', value: rec.role, evidence: rec.evidence } }
          : prev?.identity.role
            ? { role: prev.identity.role }
            : {}),
        ...(rec.label
          ? { label: { kind: 'known', value: rec.label, evidence: rec.evidence } }
          : prev?.identity.label
            ? { label: prev.identity.label }
            : {}),
        foreground: { kind: 'known', value: rec.foreground, evidence: rec.evidence },
        status: { kind: 'known', value: rec.workState, evidence: rec.evidence },
        launchWorkIds: prev ? [...prev.identity.launchWorkIds] : [],
        lineage: 'confirmed',
        revision: (prev?.identity.revision ?? 0) + 1,
      });

      const recordAlias: NativeAlias = {
        namespace: 'native_record',
        originSessionId: parentNativeSessionId,
        nativeValue: rec.recordId,
        evidence: rec.evidence,
      };
      state.aliases.set(aliasKey('native_record', parentNativeSessionId, rec.recordId), {
        namespace: 'native_record',
        originSessionId: parentNativeSessionId,
        nativeValue: rec.recordId,
        targetEntityKind: 'agent',
        targetEntityId: agentId,
        alias: recordAlias,
      });

      const rel: NativeRelationship = NativeRelationshipSchema.parse({
        parentAgentId,
        childAgentId: agentId,
        confidence: 'snapshot_confirmed',
        evidence: rec.evidence,
      });
      state.relations.set(agentId, rel);

      if (prev) {
        prev.identity = nextIdentity;
        prev.recordAliases.add(rec.recordId);
        prev.capabilities = {
          ...prev.capabilities,
          canReadSnapshot: true,
          canSteer: false,
          canLoadDirect: false,
        };
        prev.appDataRecordRef = { parentNativeSessionId, recordId: rec.recordId };
      } else {
        state.agents.set(agentId, {
          identity: nextIdentity,
          capabilities: {
            canObserveLiveStream: false,
            canCancel: false,
            canReadSnapshot: true,
            canSteer: false,
            canLoadDirect: false,
            cancelReasonCode: 'snapshot_only_child_readonly',
          },
          sessionAliases: new Set(),
          recordAliases: new Set([rec.recordId]),
          launchToolCallIds: new Set(),
          timeline: [],
          timelineSeq: 0,
          droppedTimelineEntries: 0,
          seenStableEventIds: new Set(),
          appDataRecordRef: { parentNativeSessionId, recordId: rec.recordId },
        });
      }

      return {
        agentId,
        commits: [
          {
            mutation: {
              agents: [nextIdentity],
              aliases: [{ targetEntityKind: 'agent', targetEntityId: agentId, alias: recordAlias }],
              relationsUpsert: [rel],
            },
            eventDraft: {
              type: 'native.agent.changed',
              turnId: null,
              payload: { agent: sanitizeAgentIdentityForPublic(nextIdentity, nowMs) },
              mutationKey: `np05:snap:${rec.schemaVersion}:${rec.recordId}:${nextIdentity.revision}`,
              createdAt: nowMs,
            },
          },
        ],
      };
    }

    // Verified App v1 record (has BOTH `native_record` recordId AND `session` conversationId)
    const promoted = this.upsertConfirmedChild(state, {
      parentAgentId,
      childNativeSessionId: rec.conversationId,
      recordId: rec.recordId,
      parentNativeSessionId,
      role: rec.role,
      label: rec.label,
      foreground: rec.foreground,
      status: rec.workState,
      confidence: 'snapshot_confirmed',
      evidence: rec.evidence,
      channel: 'history_replay',
      capabilitiesObj: null,
      nowMs,
      mutationKeyPrefix: `np05:snap:${rec.schemaVersion}:${rec.recordId}`,
    });

    if (!promoted.ok) return null;
    const internal = state.agents.get(promoted.agentId);
    if (internal) {
      internal.capabilities = {
        ...internal.capabilities,
        canReadSnapshot: true,
        canSteer: false,
        canLoadDirect: false,
      };
      internal.appDataRecordRef = { parentNativeSessionId, recordId: rec.recordId };
    }
    return { agentId: promoted.agentId, commits: promoted.commits };
  }

  private upsertConfirmedChild(
    state: GenerationState,
    params: {
      readonly parentAgentId: NativeAgentId;
      readonly childNativeSessionId: string;
      readonly recordId?: string;
      readonly parentNativeSessionId?: string;
      readonly launchWorkId?: WorkId;
      readonly launchToolCallId?: string;
      readonly role?: string;
      readonly label?: string;
      readonly foreground?: AgentForeground;
      readonly status?: WorkState;
      readonly confidence: 'protocol_confirmed' | 'snapshot_confirmed';
      readonly evidence: Evidence;
      readonly channel: 'live' | 'history_replay';
      readonly capabilitiesObj: Record<string, unknown> | null;
      readonly nowMs: number;
      readonly mutationKeyPrefix: string;
    },
  ):
    | {
        readonly ok: true;
        readonly agentId: NativeAgentId;
        readonly commits: readonly {
          readonly mutation: NativeCommitMutation;
          readonly eventDraft: NativeEventDraft;
        }[];
      }
    | {
        readonly ok: false;
        readonly agentId?: NativeAgentId;
        readonly diagnostic: ChildRouterDiagnostic;
        readonly commits: readonly {
          readonly mutation: NativeCommitMutation;
          readonly eventDraft: NativeEventDraft;
        }[];
      } {
    const existingBySession = this.lookupSessionAgent(state, params.childNativeSessionId);
    const existingByRecord =
      params.recordId && params.parentNativeSessionId
        ? this.lookupRecordAgent(state, params.parentNativeSessionId, params.recordId)
        : null;

    if (existingBySession && existingByRecord && existingBySession !== existingByRecord) {
      const diag = this.pushDiagnostic(state, {
        code: 'alias_namespace_conflict',
        observedAt: params.nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: `Session alias conflicts with record alias ${params.recordId}`,
      });
      return { ok: false, agentId: existingBySession, diagnostic: diag, commits: [] };
    }

    // If an explicit launchWorkId was previously tracked as an unresolved candidate, we promote
    // or absorb its launchWorkId onto the stable confirmed agent ID (NEVER matching by role string!).
    const unresolvedLaunchCandidate = params.launchWorkId
      ? this.findUnresolvedCandidateByLaunchWork(state, params.launchWorkId)
      : null;

    let agentId = existingBySession ?? existingByRecord ?? unresolvedLaunchCandidate?.identity.id;
    if (!agentId) {
      if (state.agents.size >= this.limits.maxAgentsPerRuntime && !unresolvedLaunchCandidate) {
        const diag = this.pushDiagnostic(state, {
          code: 'agent_cap_exceeded',
          observedAt: params.nowMs,
          runtimeId: state.binding.runtimeId,
          generation: state.binding.generation,
          detail: `Agent cap (${this.limits.maxAgentsPerRuntime}) reached`,
        });
        return { ok: false, diagnostic: diag, commits: [] };
      }
      // Stable opaque ID derived from runtime + generation + profile + native session ID
      agentId = asNativeAgentId(
        stableScopedId(
          'agt',
          `child|${state.binding.runtimeId}|${state.binding.generation}|${state.profileRef}|${params.childNativeSessionId}`,
        ),
      );
    }

    // Enforce single-parent + acyclicity + max ancestor depth BEFORE mutating
    const edgeCheck = this.validateLineageEdge(state, params.parentAgentId, agentId, params.nowMs);
    if (!edgeCheck.ok) {
      const existingRec = state.agents.get(agentId);
      const conflictCommits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [];
      if (existingRec && existingRec.identity.lineage !== 'conflicting') {
        existingRec.identity = AgentIdentitySchema.parse({
          ...existingRec.identity,
          lineage: 'conflicting',
          revision: existingRec.identity.revision + 1,
        });
        existingRec.capabilities = {
          ...existingRec.capabilities,
          canCancel: false,
          canSteer: false,
          canLoadDirect: false,
          cancelReasonCode: 'child_lineage_conflicting',
        };
        conflictCommits.push({
          mutation: { agents: [existingRec.identity] },
          eventDraft: {
            type: 'native.agent.changed',
            turnId: null,
            payload: { agent: sanitizeAgentIdentityForPublic(existingRec.identity, params.nowMs) },
            mutationKey: `${params.mutationKeyPrefix}:conflict:${existingRec.identity.revision}`,
            createdAt: params.nowMs,
          },
        });
      }
      return {
        ok: false,
        agentId,
        diagnostic: edgeCheck.diagnostic,
        commits: conflictCommits,
      };
    }

    const prev = state.agents.get(agentId);
    const mergedLaunchWorkIds = new Set<WorkId>(prev?.identity.launchWorkIds ?? []);
    if (params.launchWorkId) mergedLaunchWorkIds.add(params.launchWorkId);

    // If an unresolved launch candidate existed ONLY for this launchWorkId, absorb its metadata & remove placeholder
    let inheritedRole = prev?.identity.role;
    let inheritedLabel = prev?.identity.label;
    if (unresolvedLaunchCandidate && unresolvedLaunchCandidate.identity.id !== agentId) {
      for (const wid of unresolvedLaunchCandidate.identity.launchWorkIds) {
        mergedLaunchWorkIds.add(wid);
      }
      inheritedRole = inheritedRole ?? unresolvedLaunchCandidate.identity.role;
      inheritedLabel = inheritedLabel ?? unresolvedLaunchCandidate.identity.label;
      state.agents.delete(unresolvedLaunchCandidate.identity.id);
    }

    const nextRole = params.role
      ? { kind: 'known' as const, value: params.role, evidence: params.evidence }
      : inheritedRole;
    const nextLabel = params.label
      ? { kind: 'known' as const, value: params.label, evidence: params.evidence }
      : inheritedLabel;
    const nextForeground: Observed<AgentForeground> = params.foreground
      ? { kind: 'known', value: params.foreground, evidence: params.evidence }
      : prev?.identity.foreground ?? { kind: 'unknown', reasonCode: 'child_foreground_not_observed' };
    const nextStatus = params.status
      ? { kind: 'known' as const, value: params.status, evidence: params.evidence }
      : prev?.identity.status;

    const nextIdentity: AgentIdentity = AgentIdentitySchema.parse({
      id: agentId,
      ...(nextRole ? { role: nextRole } : {}),
      ...(nextLabel ? { label: nextLabel } : {}),
      foreground: nextForeground,
      ...(nextStatus ? { status: nextStatus } : {}),
      launchWorkIds: [...mergedLaunchWorkIds],
      lineage: 'confirmed',
      revision: (prev?.identity.revision ?? 0) + 1,
    });

    const isLive = params.channel === 'live' && params.confidence === 'protocol_confirmed';
    const baseCaps: ChildAgentCapabilities = prev?.capabilities ?? {
      canObserveLiveStream: isLive,
      canCancel: false,
      canReadSnapshot: params.confidence === 'snapshot_confirmed',
      canSteer: false,
      canLoadDirect: false,
      cancelReasonCode: 'child_cancel_not_advertised',
    };
    const nextCaps = this.mergeCapabilities(
      {
        ...baseCaps,
        canObserveLiveStream: baseCaps.canObserveLiveStream || isLive,
        canReadSnapshot: baseCaps.canReadSnapshot || params.confidence === 'snapshot_confirmed',
      },
      params.capabilitiesObj,
      isLive,
    );

    if (prev) {
      prev.identity = nextIdentity;
      prev.capabilities = nextCaps;
      prev.sessionAliases.add(params.childNativeSessionId);
      if (params.recordId) prev.recordAliases.add(params.recordId);
      if (params.launchToolCallId) prev.launchToolCallIds.add(params.launchToolCallId);
    } else {
      state.agents.set(agentId, {
        identity: nextIdentity,
        capabilities: nextCaps,
        sessionAliases: new Set([params.childNativeSessionId]),
        recordAliases: new Set(params.recordId ? [params.recordId] : []),
        launchToolCallIds: new Set(params.launchToolCallId ? [params.launchToolCallId] : []),
        timeline: [],
        timelineSeq: 0,
        droppedTimelineEntries: 0,
        seenStableEventIds: new Set(),
      });
    }

    const aliasesToPersist: Array<{
      readonly targetEntityKind: 'agent';
      readonly targetEntityId: string;
      readonly alias: NativeAlias;
    }> = [];

    const sessionAlias: NativeAlias = {
      namespace: 'session',
      ...(params.parentNativeSessionId ? { originSessionId: params.parentNativeSessionId } : {}),
      nativeValue: params.childNativeSessionId,
      evidence: params.evidence,
    };
    state.aliases.set(aliasKey('session', '', params.childNativeSessionId), {
      namespace: 'session',
      originSessionId: '',
      nativeValue: params.childNativeSessionId,
      targetEntityKind: 'agent',
      targetEntityId: agentId,
      alias: sessionAlias,
    });
    aliasesToPersist.push({ targetEntityKind: 'agent', targetEntityId: agentId, alias: sessionAlias });

    if (params.recordId && params.parentNativeSessionId) {
      const recordAlias: NativeAlias = {
        namespace: 'native_record',
        originSessionId: params.parentNativeSessionId,
        nativeValue: params.recordId,
        evidence: params.evidence,
      };
      state.aliases.set(aliasKey('native_record', params.parentNativeSessionId, params.recordId), {
        namespace: 'native_record',
        originSessionId: params.parentNativeSessionId,
        nativeValue: params.recordId,
        targetEntityKind: 'agent',
        targetEntityId: agentId,
        alias: recordAlias,
      });
      aliasesToPersist.push({
        targetEntityKind: 'agent',
        targetEntityId: agentId,
        alias: recordAlias,
      });
    }

    const existingRel = state.relations.get(agentId);
    const rel: NativeRelationship = NativeRelationshipSchema.parse({
      parentAgentId: params.parentAgentId,
      childAgentId: agentId,
      // Prefer protocol_confirmed over snapshot_confirmed if already protocol confirmed
      confidence:
        existingRel?.confidence === 'protocol_confirmed' ? 'protocol_confirmed' : params.confidence,
      ...(params.launchWorkId ?? existingRel?.launchWorkId
        ? { launchWorkId: params.launchWorkId ?? existingRel?.launchWorkId }
        : {}),
      evidence: params.evidence,
    });
    state.relations.set(agentId, rel);

    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [
      {
        mutation: {
          agents: [nextIdentity],
          aliases: aliasesToPersist,
          relationsUpsert: [rel],
        },
        eventDraft: {
          type: 'native.agent.changed',
          turnId: null,
          payload: { agent: sanitizeAgentIdentityForPublic(nextIdentity, params.nowMs) },
          mutationKey: `${params.mutationKeyPrefix}:agent:${agentId}:${nextIdentity.revision}`,
          createdAt: params.nowMs,
        },
      },
      {
        mutation: {
          relationsUpsert: [rel],
        },
        eventDraft: {
          type: 'native.relation.changed',
          turnId: null,
          payload: {
            op: 'upsert',
            relation: sanitizeNativeRelationshipForPublic(rel, params.nowMs),
          },
          mutationKey: `${params.mutationKeyPrefix}:rel:${params.parentAgentId}:${agentId}`,
          createdAt: params.nowMs,
        },
      },
    ];

    return { ok: true, agentId, commits };
  }

  private mergeCapabilities(
    current: ChildAgentCapabilities,
    capsObj: Record<string, unknown> | null,
    allowLiveCapabilities: boolean,
  ): ChildAgentCapabilities {
    if (!capsObj || !allowLiveCapabilities) {
      return {
        ...current,
        canCancel: allowLiveCapabilities ? current.canCancel : false,
        canSteer: false,
        canLoadDirect: false,
      };
    }

    const explicitCancel = readBoolean(capsObj, ['cancel', 'canCancel', 'supportsCancel']);
    const canCancel = explicitCancel !== undefined ? explicitCancel : current.canCancel;
    return {
      canObserveLiveStream: true,
      canCancel,
      canReadSnapshot: current.canReadSnapshot,
      canSteer: false,
      canLoadDirect: false,
      cancelReasonCode: canCancel ? undefined : 'child_cancel_not_advertised',
    };
  }

  private bufferUnownedChildFrame(
    state: GenerationState,
    envelope: NativeIngress,
    wireSessionId: string,
    nowMs: number,
  ): ChildFrameIngestionResult {
    // History replay frames are NEVER buffered as pending live children
    if (envelope.channel === 'history_replay') {
      const diag = this.pushDiagnostic(state, {
        code: 'history_replay_isolated',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: 'Unowned non-root replay frame isolated without creating live state',
      });
      return {
        accepted: false,
        deduplicated: false,
        buffered: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        diagnostic: diag,
        commits: [],
      };
    }

    if (state.unownedFrames.length >= this.limits.maxUnownedFrames) {
      state.unownedFrames.shift();
      this.pushDiagnostic(state, {
        code: 'unowned_buffer_overflow',
        observedAt: nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: `Dropped oldest unowned frame at cap ${this.limits.maxUnownedFrames}`,
      });
    }

    state.unownedFrames.push({
      connectionId: envelope.connectionId,
      ingressOrdinal: envelope.ingressOrdinal,
      wireSessionId,
      envelope,
      observedAt: nowMs,
    });

    const diag = this.pushDiagnostic(state, {
      code: 'unknown_child_buffered',
      observedAt: nowMs,
      runtimeId: state.binding.runtimeId,
      generation: state.binding.generation,
      detail: `Buffered frame ordinal=${envelope.ingressOrdinal} awaiting verified child announcement`,
    });

    return {
      accepted: true,
      deduplicated: false,
      buffered: true,
      affectedAgentIds: [],
      affectedWorkIds: [],
      diagnostic: diag,
      commits: [],
    };
  }

  private drainUnownedFramesForSession(
    state: GenerationState,
    childSessionId: string,
    connectionId: string,
    nowMs: number,
  ): Array<{ readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }> {
    const childAgentId = this.lookupSessionAgent(state, childSessionId);
    if (!childAgentId) return [];

    const remaining: UnownedBufferedFrame[] = [];
    const matched: UnownedBufferedFrame[] = [];
    for (const item of state.unownedFrames) {
      if (item.wireSessionId === childSessionId && item.connectionId === connectionId) {
        matched.push(item);
      } else {
        remaining.push(item);
      }
    }
    state.unownedFrames.length = 0;
    state.unownedFrames.push(...remaining);

    matched.sort((a, b) => a.ingressOrdinal - b.ingressOrdinal);
    const commits: Array<{ readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }> = [];

    for (const item of matched) {
      const wireObj = asRecord(item.envelope.wire);
      if (!wireObj) continue;
      const paramsObj = asRecord(wireObj.params) ?? wireObj;
      const updateObj = asRecord(paramsObj.update) ?? paramsObj;
      const updateKind = readNonEmptyString(updateObj, ['sessionUpdate', 'type', 'kind']) ?? '';
      const res = this.handleConfirmedChildActivityFrame(
        state,
        item.envelope,
        childAgentId,
        childSessionId,
        updateKind,
        updateObj,
        nowMs,
      );
      commits.push(...res.commits);
    }

    return commits;
  }

  private extractTimelineText(updateObj: Record<string, unknown>): string | undefined {
    const direct = readNonEmptyString(updateObj, ['text', 'message', 'summary']);
    if (direct) return redactPrivateChildText(direct, 4000);
    const content = asRecord(updateObj.content);
    if (content && typeof content.text === 'string' && content.text.length > 0) {
      return redactPrivateChildText(content.text, 4000);
    }
    return undefined;
  }

  private appendChildTimelineEntry(
    state: GenerationState,
    agentId: NativeAgentId,
    entry: {
      readonly kind: NativeTimelineEntryDto['kind'];
      readonly title?: string;
      readonly text?: string;
      readonly status?: WorkState;
      readonly evidence: Evidence;
      readonly stableEventId?: string;
      readonly deltaCoalesceKey?: string;
      readonly nowMs: number;
    },
  ): void {
    const rec = state.agents.get(agentId);
    if (!rec) return;

    // Deduplicate ONLY by explicit stable upstream event ID — NEVER by text string equality!
    if (entry.stableEventId) {
      if (rec.seenStableEventIds.has(entry.stableEventId)) {
        return;
      }
      rec.seenStableEventIds.add(entry.stableEventId);
    }

    rec.timelineSeq += 1;
    state.timelineRevision += 1;
    const seq = rec.timelineSeq;
    const actorLabel =
      rec.identity.label?.kind === 'known'
        ? rec.identity.label.value
        : rec.identity.role?.kind === 'known'
          ? rec.identity.role.value
          : undefined;

    const dto = NativeTimelineEntryDtoSchema.parse({
      entryId: entry.stableEventId
        ? `ev_${entry.stableEventId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96)}`
        : `tl_${agentId}_${seq}`,
      seq,
      timestamp: entry.nowMs,
      kind: entry.kind,
      actorKind: agentId === state.rootAgentId ? 'main' : 'child',
      actorId: agentId,
      ...(actorLabel ? { actorLabel } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.text !== undefined ? { text: entry.text } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      truncated: false,
      ...(entry.deltaCoalesceKey ? { deltaCoalesceKey: entry.deltaCoalesceKey } : {}),
      evidence: toPublicEvidenceDto(entry.evidence, entry.nowMs),
    });

    if (rec.timeline.length >= this.limits.maxTimelineEntriesPerAgent) {
      rec.timeline.shift();
      rec.droppedTimelineEntries += 1;
      this.pushDiagnostic(state, {
        code: 'timeline_buffer_trimmed',
        observedAt: entry.nowMs,
        runtimeId: state.binding.runtimeId,
        generation: state.binding.generation,
        detail: `Trimmed oldest timeline entry for ${agentId} (dropped=${rec.droppedTimelineEntries})`,
      });
    }
    rec.timeline.push(dto);
  }
}
