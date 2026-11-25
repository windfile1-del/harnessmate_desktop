import crypto from 'node:crypto';
import {
  AgentIdentitySchema,
  NativeWorkflowSchema,
  asActivityId,
  asNativeAgentId,
  asWorkflowId,
  sanitizeAgentIdentityForPublic,
  sanitizeNativeWorkflowForPublic,
  type ActivityId,
  type AgentForeground,
  type AgentIdentity,
  type BindingGeneration,
  type Evidence,
  type NativeAgentId,
  type NativeAlias,
  type NativeRequestReceiptState,
  type NativeWorkflow,
  type NativeWorkflowResourceKind,
  type Observed,
  type RuntimeBinding,
  type RuntimeId,
  type WorkId,
  type WorkOutcome,
  type WorkState,
  type WorkflowId,
} from '@harnessmate/protocol';
import type { ObservedAcpCommand } from '../../commands/descriptors.js';
import type { NativeRequestTargetResolution } from '../../requests/types.js';
import type { AgyNativeRuntimeRegistry } from '../../wiring/registry.js';
import type {
  NativeCommitMutation,
  NativeEventDraft,
  NativeIngress,
  NativeWorkflowResourceReaderPort,
} from '../../wiring/types.js';
import { SwarmBoardStore, sanitizeSwarmPublicText } from './board-store.js';
import {
  DEFAULT_SWARM_OBSERVER_GATES,
  DEFAULT_SWARM_OBSERVER_LIMITS,
  SWARM_OBSERVER_CONTRACT_REVISION,
  type SwarmBindingAuditSnapshot,
  type SwarmBoardAvailabilityValue,
  type SwarmBoardPostRecord,
  type SwarmBoardSnapshotReadInput,
  type SwarmBoardSnapshotReadResult,
  type SwarmCoordinatorTraceEntry,
  type SwarmFrameIngestionResult,
  type SwarmLaunchReceiptInput,
  type SwarmLinkedApprovalRecord,
  type SwarmMentionObservation,
  type SwarmObserverBindingConfig,
  type SwarmObserverDiagnostic,
  type SwarmObserverGateConfig,
  type SwarmObserverLimits,
  type SwarmWorkerRecord,
  type SwarmWorkflowStateSnapshot,
} from './contracts.js';
import { readVersionedSwarmBoardSnapshot } from './snapshot-reader.js';

const SAFE_OPAQUE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

interface InternalSwarmWorkflow {
  readonly id: WorkflowId;
  readonly originActivityId: ActivityId;
  nativeWorkflowId?: string;
  launchReceiptId?: string;
  objective?: string;
  coordinatorAgentId?: NativeAgentId;
  state: Observed<WorkState>;
  board: Observed<SwarmBoardAvailabilityValue>;
  boardUnavailableReason?: string;
  revision: number;
  readonly workers: Map<NativeAgentId, SwarmWorkerRecord>;
  readonly nativeWorkerIdToAgentId: Map<string, NativeAgentId>;
  readonly rosterNameToAgentId: Map<string, NativeAgentId>;
  readonly mentions: SwarmMentionObservation[];
  readonly linkedApprovals: Map<string, SwarmLinkedApprovalRecord>;
  readonly store: SwarmBoardStore;
  readonly seenEventIds: Set<string>;
  traceSeq: number;
  unverifiedLaunchToolCount: number;
  updatedAt: number;
}

interface BindingGenerationSwarmState {
  readonly binding: RuntimeBinding;
  readonly profileRef: string;
  readonly sourceRef: string;
  readonly rootNativeSessionId: string;
  readonly coordinatorAgentId: NativeAgentId;
  activeConnectionId: string | null;
  swarmAdvertised: boolean | null;
  activeWorkflowId: WorkflowId | null;
  readonly workflows: Map<WorkflowId, InternalSwarmWorkflow>;
  readonly nativeWorkflowIdToId: Map<string, WorkflowId>;
  readonly agents: Map<NativeAgentId, AgentIdentity>;
  readonly seenIngressOrdinals: Set<string>;
  readonly diagnostics: SwarmObserverDiagnostic[];
}

function stableScopedId(prefix: 'wfl' | 'agt' | 'act' | 'trc' | 'mnt', seed: string): string {
  const hash = crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 14);
  return `${prefix}_${hash}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function readNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      return Math.floor(val);
    }
  }
  return undefined;
}

function buildEvidence(envelope: NativeIngress, wireVariant: string, nowMs: number): Evidence {
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

function mapRawWorkState(raw?: string): WorkState {
  switch (raw?.trim().toLowerCase()) {
    case 'queued':
    case 'pending':
    case 'starting':
      return 'queued';
    case 'running':
    case 'in_progress':
    case 'active':
    case 'working':
      return 'running';
    case 'waiting':
    case 'idle':
    case 'quiescent':
    case 'sleeping':
      return 'waiting';
    case 'requires_action':
    case 'awaiting_approval':
    case 'awaiting_input':
      return 'requires_action';
    case 'completed':
    case 'finished':
    case 'done':
    case 'settled':
      return 'finished';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'killed':
    case 'stopped':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function mapRawForeground(raw?: string): AgentForeground {
  switch (raw?.trim().toLowerCase()) {
    case 'running':
    case 'working':
    case 'active':
    case 'in_progress':
      return 'running';
    case 'requires_action':
    case 'awaiting_approval':
    case 'awaiting_input':
      return 'requires_action';
    case 'idle':
    case 'waiting':
    case 'quiescent':
    case 'sleeping':
      return 'idle';
    default:
      return 'unknown';
  }
}

function mapRawOutcome(raw?: string): WorkOutcome | undefined {
  switch (raw?.trim().toLowerCase()) {
    case 'succeeded':
    case 'success':
    case 'passed':
    case 'ok':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'killed':
      return 'cancelled';
    default:
      return undefined;
  }
}

function detectMemberRole(rawRole?: string, rawLabel?: string): 'worker' | 'verifier' {
  const combined = `${rawRole ?? ''} ${rawLabel ?? ''}`.toLowerCase();
  return /\bverifier\b|verify|reviewer|audit/i.test(combined) ? 'verifier' : 'worker';
}

function runtimeGenKey(runtimeId: RuntimeId, generation: BindingGeneration): string {
  return `${runtimeId}|${generation}`;
}

function sanitizePostId(raw: string | undefined, fallbackSeed: string): string {
  if (raw && SAFE_OPAQUE_ID_REGEX.test(raw)) return raw;
  const hash = crypto.createHash('sha256').update(fallbackSeed, 'utf8').digest('hex').slice(0, 14);
  return `post_${hash}`;
}

function sanitizeThreadId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return SAFE_OPAQUE_ID_REGEX.test(raw) ? raw : undefined;
}

/**
 * NP-08 Typed Swarm Observer & Shared Board Resource Reader.
 *
 * Design guarantees:
 * 1. Treats real AGY Swarm execution as sole source of truth — zero local orchestration,
 *    zero automatic mention sending, zero Board fabrication from coordinator prose.
 * 2. Never fabricates confirmed workers from tool titles; workers require verified native IDs
 *    in the same binding/profile/connection scope.
 * 3. Separates Coordinator, Workers/Verifiers, Board availability/posts, and Activity trace.
 * 4. Worker `idle` NEVER counts as `finished`/`succeeded`; tracks real `@mention` -> wakeup transitions.
 * 5. Links worker approvals ONLY when NP-05/NP-07 confirms worker identity in the same scope,
 *    without moving or mutating native context.
 * 6. Independent rollback gates (`swarmEnabled`, `boardFeedEnabled`, `localBoardSnapshotEnabled`)
 *    preserve captured coordinator trajectory even when disabled.
 * 7. Implements `NativeWorkflowResourceReaderPort` with stable-ID cursor pagination for `board`
 *    and `logs`.
 */
export class AgySwarmObserver implements NativeWorkflowResourceReaderPort {
  readonly contractRevision = SWARM_OBSERVER_CONTRACT_REVISION;

  private gates: SwarmObserverGateConfig;
  private readonly limits: SwarmObserverLimits;
  private readonly nowFn: () => number;
  private readonly activeByRuntime = new Map<RuntimeId, BindingGenerationSwarmState>();
  private readonly historicalByRuntimeGen = new Map<string, BindingGenerationSwarmState>();

  constructor(opts?: {
    readonly gates?: Partial<SwarmObserverGateConfig>;
    readonly limits?: Partial<SwarmObserverLimits>;
    readonly now?: () => number;
  }) {
    this.gates = Object.freeze({
      ...DEFAULT_SWARM_OBSERVER_GATES,
      ...opts?.gates,
    });
    this.limits = Object.freeze({
      ...DEFAULT_SWARM_OBSERVER_LIMITS,
      ...opts?.limits,
    });
    this.nowFn = opts?.now ?? (() => Date.now());
  }

  getGates(): SwarmObserverGateConfig {
    return this.gates;
  }

  /**
   * Dynamically updates Swarm / Board gates (zero-code rollback).
   * Captured coordinator traces remain intact and readable via `resource: 'logs'`.
   */
  setGates(patch: Partial<SwarmObserverGateConfig>): SwarmObserverGateConfig {
    this.gates = Object.freeze({
      ...this.gates,
      ...patch,
    });
    return this.gates;
  }

  /**
   * Registers or transitions an active runtime binding.
   * When generation changes, prior generation is frozen as read-only historical/stale state.
   */
  registerBinding(config: SwarmObserverBindingConfig): {
    readonly coordinatorAgentId: NativeAgentId;
    readonly binding: RuntimeBinding;
  } {
    const prev = this.activeByRuntime.get(config.binding.runtimeId);
    if (prev && prev.binding.generation === config.binding.generation) {
      if (config.connectionId) {
        prev.activeConnectionId = config.connectionId;
      }
      return { coordinatorAgentId: prev.coordinatorAgentId, binding: prev.binding };
    }

    if (prev) {
      this.markGenerationStale(prev, 'generation_changed');
      this.historicalByRuntimeGen.set(runtimeGenKey(prev.binding.runtimeId, prev.binding.generation), prev);
    }

    const nowMs = this.nowFn();
    const coordinatorAgentId = asNativeAgentId(
      stableScopedId(
        'agt',
        `swarm_coord|${config.binding.runtimeId}|${config.binding.generation}|${config.profileRef}|${config.rootNativeSessionId}`,
      ),
    );
    const coordinatorEvidence: Evidence = {
      kind: 'host_observation',
      observedAt: nowMs,
      reasonCode: 'swarm_binding_registered',
    };
    const coordinatorIdentity = AgentIdentitySchema.parse({
      id: coordinatorAgentId,
      role: { kind: 'known', value: 'coordinator', evidence: coordinatorEvidence },
      label: { kind: 'known', value: 'Swarm Coordinator', evidence: coordinatorEvidence },
      foreground: { kind: 'unknown', reasonCode: 'coordinator_not_yet_observed' },
      launchWorkIds: [],
      lineage: 'confirmed',
      revision: 1,
    });

    const state: BindingGenerationSwarmState = {
      binding: config.binding,
      profileRef: config.profileRef,
      sourceRef: config.sourceRef,
      rootNativeSessionId: config.rootNativeSessionId,
      coordinatorAgentId,
      activeConnectionId: config.connectionId ?? null,
      swarmAdvertised: null,
      activeWorkflowId: null,
      workflows: new Map(),
      nativeWorkflowIdToId: new Map(),
      agents: new Map([[coordinatorAgentId, coordinatorIdentity]]),
      seenIngressOrdinals: new Set(),
      diagnostics: [],
    };

    this.activeByRuntime.set(config.binding.runtimeId, state);
    return { coordinatorAgentId, binding: config.binding };
  }

  /**
   * Records genuine ACP `available_commands_update` advertisement for `/swarm`.
   * Empty array `[]` explicitly marks `swarmAdvertised = false` (revoked/absent).
   */
  onAvailableCommandsUpdate(
    binding: RuntimeBinding,
    commands: readonly ObservedAcpCommand[] | null,
  ): { readonly advertised: boolean | null } {
    const state = this.getActiveBindingState(binding);
    if (!state) return { advertised: null };
    if (commands === null) {
      state.swarmAdvertised = null;
      return { advertised: null };
    }
    const found = commands.some((cmd) => cmd.name.trim().replace(/^\/+/, '').toLowerCase() === 'swarm');
    state.swarmAdvertised = found;
    return { advertised: found };
  }

  /**
   * Records a genuine user `/swarm <task>` command acceptance receipt from NP-06.
   * Does NOT claim Swarm is `running` until real native coordinator evidence arrives.
   */
  onNativeLaunchReceipt(input: SwarmLaunchReceiptInput): {
    readonly workflowId: WorkflowId | null;
    readonly commits: readonly { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }[];
  } {
    const state = this.getActiveBindingState(input.binding);
    if (!state) return { workflowId: null, commits: [] };

    const nowMs = input.observedAt ?? this.nowFn();
    const objectiveSanitized = sanitizeSwarmPublicText(input.objective, 1000).text;
    const workflowId = asWorkflowId(
      stableScopedId(
        'wfl',
        `swarm|${input.binding.runtimeId}|${input.binding.generation}|${input.receiptId}`,
      ),
    );
    const receiptEvidence: Evidence = {
      kind: 'host_observation',
      observedAt: nowMs,
      reasonCode: input.modeEvidenceObserved ? 'swarm_launch_confirmed' : 'swarm_launch_receipt_pending_native',
    };

    const wf = this.getOrCreateWorkflow(state, {
      workflowId,
      originActivityId: input.activityId,
      launchReceiptId: input.receiptId,
      objective: objectiveSanitized,
      evidence: receiptEvidence,
      nowMs,
      initialState: input.modeEvidenceObserved
        ? { kind: 'known', value: 'queued', evidence: receiptEvidence }
        : { kind: 'unknown', reasonCode: 'awaiting_native_swarm_evidence' },
    });

    this.appendCoordinatorTrace(state, wf, {
      level: 'info',
      kind: 'launch_receipt',
      summary: `已受理 /swarm 启动回执 (${input.receiptId})，等待原生 Coordinator 确认`,
      evidence: receiptEvidence,
      nowMs,
    });

    if (!this.gates.swarmEnabled) {
      this.pushDiagnostic(state, 'swarm_gate_disabled', 'Swarm gate disabled; launch receipt kept in coordinator trace only', nowMs);
      return { workflowId: wf.id, commits: [] };
    }

    const commit = this.buildWorkflowCommit(state, wf, input.turnId ?? null, nowMs, `swarm_launch:${input.receiptId}`);
    return { workflowId: wf.id, commits: [commit] };
  }

  /**
   * Processes an ordered ACP `NativeIngress` frame for Swarm coordinator, workers/verifiers,
   * Board posts, and mentions.
   */
  acceptFrame(envelope: NativeIngress, expectedScope?: { readonly profileRef?: string; readonly sourceRef?: string }): SwarmFrameIngestionResult {
    const nowMs = this.nowFn();
    const state = this.activeByRuntime.get(envelope.binding.runtimeId);

    if (!state || state.binding.generation !== envelope.binding.generation) {
      return {
        accepted: false,
        deduplicated: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        diagnostic: {
          code: 'stale_generation_rejected',
          observedAt: nowMs,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: 'Swarm frame rejected due to missing or stale binding generation',
        },
        commits: [],
      };
    }

    if (
      (expectedScope?.profileRef && expectedScope.profileRef !== state.profileRef) ||
      (expectedScope?.sourceRef && expectedScope.sourceRef !== state.sourceRef)
    ) {
      const diag = this.pushDiagnostic(
        state,
        'cross_profile_rejected',
        'Swarm frame rejected due to profile/source scope mismatch',
        nowMs,
      );
      return {
        accepted: false,
        deduplicated: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        diagnostic: diag,
        commits: [],
      };
    }

    if (
      state.activeConnectionId &&
      envelope.channel === 'live' &&
      envelope.connectionId !== state.activeConnectionId
    ) {
      const diag = this.pushDiagnostic(
        state,
        'scope_mismatch_rejected',
        'Swarm frame rejected due to non-active connectionId',
        nowMs,
      );
      return {
        accepted: false,
        deduplicated: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        diagnostic: diag,
        commits: [],
      };
    }

    const ingressKey = `${envelope.connectionId}:${envelope.ingressOrdinal}`;
    if (state.seenIngressOrdinals.has(ingressKey)) {
      const diag = this.pushDiagnostic(
        state,
        'duplicate_ingress_ignored',
        `Duplicate ingress ordinal ${envelope.ingressOrdinal} ignored`,
        nowMs,
      );
      return {
        accepted: false,
        deduplicated: true,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        diagnostic: diag,
        commits: [],
      };
    }

    const wire = asRecord(envelope.wire);
    const params = asRecord(wire?.params);
    const update = asRecord(params?.update) ?? params ?? wire;
    if (!update) {
      return {
        accepted: false,
        deduplicated: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        commits: [],
      };
    }

    const updateType = readString(update, ['sessionUpdate', 'type']) ?? '';
    const isSwarmRelevant = this.isSwarmUpdate(update, updateType);
    if (!isSwarmRelevant) {
      return {
        accepted: false,
        deduplicated: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        commits: [],
      };
    }

    state.seenIngressOrdinals.add(ingressKey);
    if (state.seenIngressOrdinals.size > 4096) {
      const first = state.seenIngressOrdinals.values().next().value;
      if (first) state.seenIngressOrdinals.delete(first);
    }

    // Verify wire session scope matches active root or known confirmed worker in same binding.
    const wireSessionId =
      envelope.originSession ??
      readString(params ?? {}, ['sessionId']) ??
      state.rootNativeSessionId;
    if (!this.isSessionInBindingScope(state, wireSessionId, update)) {
      const diag = this.pushDiagnostic(
        state,
        'scope_mismatch_rejected',
        'Swarm frame rejected because session/workflow scope does not belong to active binding',
        nowMs,
      );
      return {
        accepted: false,
        deduplicated: false,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        diagnostic: diag,
        commits: [],
      };
    }

    const evidence = buildEvidence(envelope, `acp:${updateType || 'swarm'}`, nowMs);
    const nativeWorkflowId = readString(update, ['swarmId', 'workflowId', 'nativeWorkflowId']);
    const wf = this.resolveOrCreateWorkflowForFrame(state, nativeWorkflowId, update, evidence, nowMs);

    // Optional stable upstream event ID deduplication (never deduplicates raw prose text).
    const stableEventId = readString(update, ['eventId', 'updateId', 'messageId']);
    if (stableEventId) {
      if (wf.seenEventIds.has(stableEventId)) {
        return {
          accepted: false,
          deduplicated: true,
          workflowId: wf.id,
          affectedAgentIds: [],
          affectedWorkIds: [],
          coordinatorTraceAppended: false,
          commits: [],
        };
      }
      wf.seenEventIds.add(stableEventId);
    }

    if (envelope.channel === 'history_replay') {
      this.pushDiagnostic(
        state,
        'history_replay_isolated',
        `Processed Swarm frame ${updateType} as read-only history replay`,
        nowMs,
      );
    }

    // Handle tool_call / tool_call_update explicitly: NEVER fabricate workers from tool titles!
    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      return this.handleSwarmToolCallUpdate(state, wf, update, evidence, nowMs);
    }

    // Handle structured Swarm Board post / mention frames.
    if (
      updateType === 'swarm_board_post' ||
      updateType === 'swarm_board_update' ||
      updateType === 'board_post' ||
      updateType === 'swarm_mention'
    ) {
      return this.handleBoardFeedUpdate(state, wf, update, evidence, envelope.ingressOrdinal, nowMs);
    }

    // Handle structured Worker / Verifier updates (requires explicit native worker ID!).
    if (updateType === 'swarm_worker_update' || updateType === 'subagent_update') {
      return this.handleWorkerStateUpdate(state, wf, update, evidence, nowMs);
    }

    // Default: Coordinator / Swarm lifecycle update (`swarm_update`, `swarm_coordinator_update`, `workflow_update`).
    return this.handleCoordinatorUpdate(state, wf, update, evidence, nowMs);
  }

  /**
   * Links a confirmed worker/coordinator approval from NP-07 without moving native context.
   * Rejects unconfirmed / unknown child requests (never attributes them to a Swarm worker).
   */
  linkWorkerApproval(
    binding: RuntimeBinding,
    input: {
      readonly approvalId: string;
      readonly targetResolution: NativeRequestTargetResolution;
      readonly receiptState: NativeRequestReceiptState;
      readonly summary?: string;
      readonly observedAt?: number;
    },
  ): {
    readonly linked: boolean;
    readonly workerAgentId?: NativeAgentId;
    readonly workflowId?: WorkflowId;
    readonly diagnostic?: SwarmObserverDiagnostic;
    readonly commits: readonly { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }[];
  } {
    const nowMs = input.observedAt ?? this.nowFn();
    const state = this.getActiveBindingState(binding);
    if (!state) {
      return { linked: false, commits: [] };
    }

    const res = input.targetResolution;
    const isConfirmed =
      res.targetLineage === 'confirmed' &&
      (res.scope === 'confirmed_child' || res.scope === 'confirmed_workflow' || res.scope === 'root') &&
      Boolean(res.agentId);

    if (!isConfirmed || !res.agentId) {
      const diag = this.pushDiagnostic(
        state,
        'unconfirmed_approval_not_linked',
        `Approval ${input.approvalId} has scope=${res.scope} lineage=${res.targetLineage}; not linked to Swarm worker`,
        nowMs,
      );
      return { linked: false, diagnostic: diag, commits: [] };
    }

    const wf = this.findWorkflowOwningAgent(state, res.agentId);
    if (!wf) {
      const diag = this.pushDiagnostic(
        state,
        'unconfirmed_approval_not_linked',
        `Approval ${input.approvalId} agent ${res.agentId} is not a confirmed member of active Swarm`,
        nowMs,
      );
      return { linked: false, diagnostic: diag, commits: [] };
    }

    const existing = wf.linkedApprovals.get(input.approvalId);
    const linkedRecord: SwarmLinkedApprovalRecord = {
      approvalId: input.approvalId,
      workerAgentId: res.agentId,
      receiptState: input.receiptState,
      forwardedToParentSession: res.forwardedToParentSession,
      provenanceReason: res.provenanceReason,
      linkedAt: existing?.linkedAt ?? nowMs,
      updatedAt: nowMs,
    };
    wf.linkedApprovals.set(input.approvalId, linkedRecord);

    const evidence: Evidence = {
      kind: 'host_observation',
      observedAt: nowMs,
      reasonCode: `swarm_approval_${input.receiptState}`,
    };

    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [];
    const worker = wf.workers.get(res.agentId);
    if (worker) {
      const nextApprovals = worker.linkedApprovalIds.includes(input.approvalId)
        ? worker.linkedApprovalIds
        : [...worker.linkedApprovalIds, input.approvalId];
      const hasAnyPending = nextApprovals.some(
        (id) => wf.linkedApprovals.get(id)?.receiptState === 'pending',
      );
      const nextForeground: Observed<AgentForeground> = hasAnyPending
        ? { kind: 'known', value: 'requires_action', evidence }
        : worker.foreground.kind === 'known' && worker.foreground.value === 'requires_action'
          ? { kind: 'known', value: 'running', evidence }
          : worker.foreground;
      const nextWorkState: Observed<WorkState> = hasAnyPending
        ? { kind: 'known', value: 'requires_action', evidence }
        : worker.workState.kind === 'known' && worker.workState.value === 'requires_action'
          ? { kind: 'known', value: 'running', evidence }
          : worker.workState;

      const updatedWorker: SwarmWorkerRecord = {
        ...worker,
        foreground: nextForeground,
        workState: nextWorkState,
        linkedApprovalIds: nextApprovals,
        updatedAt: nowMs,
      };
      wf.workers.set(res.agentId, updatedWorker);

      const agentCommit = this.syncWorkerAgentIdentity(state, updatedWorker, nowMs);
      if (this.gates.swarmEnabled && agentCommit) {
        commits.push(agentCommit);
      }
    }

    this.appendCoordinatorTrace(state, wf, {
      level: input.receiptState === 'pending' ? 'warn' : 'info',
      kind: 'approval_linked',
      summary: sanitizeSwarmPublicText(
        `已关联已确证成员 (${res.agentId}) 请求 ${input.approvalId} · 状态=${input.receiptState}${res.forwardedToParentSession ? ' (经父会话转发)' : ''}`,
      ).text,
      evidence,
      nowMs,
    });

    if (this.gates.swarmEnabled) {
      wf.revision += 1;
      wf.updatedAt = nowMs;
      commits.push(
        this.buildWorkflowCommit(
          state,
          wf,
          res.turnId,
          nowMs,
          `swarm_approval:${wf.id}:${input.approvalId}:${input.receiptState}`,
        ),
      );
    }

    return {
      linked: true,
      workerAgentId: res.agentId,
      workflowId: wf.id,
      commits,
    };
  }

  /**
   * Attempts strictly versioned, read-only local Board snapshot ingestion.
   * Fails closed by default (`VERIFIED_LOCAL_BOARD_SCHEMAS = []`).
   */
  ingestReadOnlyBoardSnapshot(
    binding: RuntimeBinding,
    workflowId: WorkflowId,
    input: Omit<
      SwarmBoardSnapshotReadInput,
      'expectedNativeSessionId' | 'expectedWorkflowNativeId' | 'expectedProfileRef' | 'gates'
    >,
  ): SwarmBoardSnapshotReadResult {
    const nowMs = input.nowMs ?? this.nowFn();
    const state = this.getActiveBindingState(binding);
    if (!state) {
      return {
        available: false,
        reasonCode: 'stale_binding_or_generation',
        posts: [],
        truncated: false,
      };
    }

    const wf = state.workflows.get(workflowId);
    if (!wf) {
      return {
        available: false,
        reasonCode: 'workflow_not_found',
        posts: [],
        truncated: false,
      };
    }

    const result = readVersionedSwarmBoardSnapshot({
      ...input,
      expectedNativeSessionId: state.rootNativeSessionId,
      expectedWorkflowNativeId: wf.nativeWorkflowId,
      expectedProfileRef: state.profileRef,
      gates: this.gates,
      nowMs,
    });

    if (!result.available) {
      this.pushDiagnostic(
        state,
        result.reasonCode === 'local_board_snapshot_gate_disabled'
          ? 'board_snapshot_disabled'
          : 'board_snapshot_rejected',
        `Local Board snapshot rejected: ${result.reasonCode ?? 'unknown'}`,
        nowMs,
      );
      return result;
    }

    for (const post of result.posts) {
      wf.store.upsertPost(post);
    }

    if (result.posts.length > 0) {
      const snapEvidence = result.posts[0]!.evidence;
      wf.board = { kind: 'known', value: 'available', evidence: snapEvidence };
      wf.boardUnavailableReason = undefined;
      wf.revision += 1;
      wf.updatedAt = nowMs;
    }

    return result;
  }

  /**
   * Marks active Swarm workflow and workers stale when the ACP connection closes,
   * preserving captured coordinator trajectory and historical board posts as read-only.
   */
  handleTransportClosed(
    binding: RuntimeBinding,
    connectionId: string,
  ): readonly { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }[] {
    const state = this.activeByRuntime.get(binding.runtimeId);
    if (!state || state.binding.generation !== binding.generation) return [];
    if (state.activeConnectionId && state.activeConnectionId !== connectionId) return [];

    const nowMs = this.nowFn();
    state.activeConnectionId = null;
    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [];

    for (const wf of state.workflows.values()) {
      const closeEvidence: Evidence = {
        kind: 'host_observation',
        observedAt: nowMs,
        reasonCode: 'transport_closed',
      };

      if (wf.state.kind === 'known' && !isTerminalWorkState(wf.state.value)) {
        wf.state = {
          kind: 'stale',
          last: wf.state.value,
          evidence: wf.state.evidence,
          reasonCode: 'transport_closed',
        };
      }
      if (wf.board.kind === 'known' && wf.board.value === 'available') {
        wf.board = {
          kind: 'stale',
          last: 'available',
          evidence: wf.board.evidence,
          reasonCode: 'transport_closed',
        };
      }

      for (const [workerId, worker] of wf.workers.entries()) {
        const staleFg: Observed<AgentForeground> =
          worker.foreground.kind === 'known'
            ? {
                kind: 'stale',
                last: worker.foreground.value,
                evidence: worker.foreground.evidence,
                reasonCode: 'transport_closed',
              }
            : worker.foreground;
        const staleWork: Observed<WorkState> =
          worker.workState.kind === 'known' && !isTerminalWorkState(worker.workState.value)
            ? {
                kind: 'stale',
                last: worker.workState.value,
                evidence: worker.workState.evidence,
                reasonCode: 'transport_closed',
              }
            : worker.workState;

        const updated: SwarmWorkerRecord = {
          ...worker,
          foreground: staleFg,
          workState: staleWork,
          updatedAt: nowMs,
        };
        wf.workers.set(workerId, updated);
        const agentCommit = this.syncWorkerAgentIdentity(state, updated, nowMs);
        if (this.gates.swarmEnabled && agentCommit) {
          commits.push(agentCommit);
        }
      }

      this.appendCoordinatorTrace(state, wf, {
        level: 'warn',
        kind: 'transport_closed',
        summary: '观测连接已断开，已保留 Coordinator 轨迹与最后观测状态，不推断原生 Swarm 已停止',
        evidence: closeEvidence,
        nowMs,
      });

      wf.revision += 1;
      wf.updatedAt = nowMs;
      if (this.gates.swarmEnabled) {
        commits.push(
          this.buildWorkflowCommit(
            state,
            wf,
            null,
            nowMs,
            `swarm_closed:${wf.id}:${connectionId}`,
          ),
        );
      }
    }

    return commits;
  }

  /**
   * Implements `NativeWorkflowResourceReaderPort` for `/api/v1/sessions/:id/native/workflows/:workflowId/:resource`.
   *
   * - `board`: stable-ID paginated Board posts (`kind: 'board_post'`), gated by `swarmEnabled && boardFeedEnabled`.
   * - `logs`: stable-ID paginated Coordinator trace (`kind: 'log_entry'`), ALWAYS retained even if
   *   Swarm or Board gates are disabled for rollback!
   * - `phases` / `artifacts`: explicitly reports `available: false` (`swarm_resource_not_applicable`).
   */
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
    readonly items: readonly import('@harnessmate/protocol').NativeWorkflowResourceItemDto[];
    readonly nextPageToken: string | null;
    readonly hasMore: boolean;
  } {
    const state = this.findBindingStateIncludingHistorical(input.binding);
    if (!state) {
      return {
        revision: 0,
        available: false,
        sourceUnavailableReason: 'stale_binding_or_generation',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const wf = state.workflows.get(input.workflowId);
    if (!wf) {
      return {
        revision: 0,
        available: false,
        sourceUnavailableReason: 'workflow_not_found',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const nowMs = this.nowFn();

    if (input.resource === 'logs') {
      const page = wf.store.readTracePage({
        pageToken: input.pageToken,
        limit: input.limit,
        nowMs,
      });
      if (page.cursorInvalid) {
        return {
          revision: page.revision,
          available: false,
          sourceUnavailableReason: 'invalid_log_cursor',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      return {
        revision: page.revision,
        available: true,
        items: page.items,
        nextPageToken: page.nextPageToken,
        hasMore: page.hasMore,
      };
    }

    if (input.resource === 'board') {
      if (!this.gates.swarmEnabled) {
        return {
          revision: wf.store.getBoardRevision(),
          available: false,
          sourceUnavailableReason: 'swarm_gate_disabled',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      if (!this.gates.boardFeedEnabled) {
        return {
          revision: wf.store.getBoardRevision(),
          available: false,
          sourceUnavailableReason: 'swarm_board_gate_disabled',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      if (wf.board.kind === 'known' && wf.board.value === 'upstream_limited') {
        return {
          revision: wf.store.getBoardRevision(),
          available: false,
          sourceUnavailableReason: wf.boardUnavailableReason ?? 'acp_swarm_board_not_exposed',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      if (wf.board.kind === 'unknown') {
        return {
          revision: wf.store.getBoardRevision(),
          available: false,
          sourceUnavailableReason: wf.board.reasonCode,
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }

      const page = wf.store.readBoardPage({
        pageToken: input.pageToken,
        limit: input.limit,
        nowMs,
      });
      if (page.cursorInvalid) {
        return {
          revision: page.revision,
          available: false,
          sourceUnavailableReason: 'invalid_board_cursor',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      return {
        revision: page.revision,
        available: true,
        items: page.items,
        nextPageToken: page.nextPageToken,
        hasMore: page.hasMore,
      };
    }

    return {
      revision: wf.revision,
      available: false,
      sourceUnavailableReason: 'swarm_resource_not_applicable',
      items: [],
      nextPageToken: null,
      hasMore: false,
    };
  }

  /**
   * Commits observer mutations atomically into `AgyNativeRuntimeRegistry` (NP-02 persistence + event feed).
   */
  commitToRegistry(
    registry: AgyNativeRuntimeRegistry,
    binding: RuntimeBinding,
    commits: readonly { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft }[],
  ): number {
    let published = 0;
    for (const item of commits) {
      const res = registry.commitAndPublish(binding, item.mutation, item.eventDraft);
      if (!res.deduplicated) published += 1;
    }
    return published;
  }

  getStateSnapshot(binding: RuntimeBinding): SwarmBindingAuditSnapshot | null {
    const state = this.findBindingStateIncludingHistorical(binding);
    if (!state) return null;

    const workflows: SwarmWorkflowStateSnapshot[] = [];
    const coordinatorTracesByWorkflow = new Map<WorkflowId, readonly SwarmCoordinatorTraceEntry[]>();

    for (const wf of state.workflows.values()) {
      workflows.push({
        workflow: this.toNativeWorkflow(wf),
        binding: state.binding,
        ...(wf.nativeWorkflowId ? { nativeWorkflowId: wf.nativeWorkflowId } : {}),
        ...(wf.launchReceiptId ? { launchReceiptId: wf.launchReceiptId } : {}),
        launchAdvertised: state.swarmAdvertised,
        ...(wf.coordinatorAgentId ? { coordinatorAgentId: wf.coordinatorAgentId } : {}),
        workers: [...wf.workers.values()],
        mentions: [...wf.mentions],
        linkedApprovals: [...wf.linkedApprovals.values()],
        boardPostCount: wf.store.getPostCount(),
        coordinatorTraceCount: wf.store.getTraceCount(),
        ...(wf.boardUnavailableReason ? { boardUnavailableReason: wf.boardUnavailableReason } : {}),
        unverifiedLaunchToolCount: wf.unverifiedLaunchToolCount,
        updatedAt: wf.updatedAt,
      });
      coordinatorTracesByWorkflow.set(wf.id, wf.store.listTraceEntries());
    }

    return {
      binding: state.binding,
      profileRef: state.profileRef,
      sourceRef: state.sourceRef,
      swarmAdvertised: state.swarmAdvertised,
      workflows,
      coordinatorTracesByWorkflow,
      diagnostics: [...state.diagnostics],
      agents: [...state.agents.values()],
    };
  }

  // ── Internal Frame Handlers ──────────────────────────────────────────

  private isSwarmUpdate(update: Record<string, unknown>, updateType: string): boolean {
    if (
      updateType === 'swarm_update' ||
      updateType === 'swarm_coordinator_update' ||
      updateType === 'swarm_worker_update' ||
      updateType === 'swarm_board_post' ||
      updateType === 'swarm_board_update' ||
      updateType === 'board_post' ||
      updateType === 'swarm_mention'
    ) {
      return true;
    }
    if (updateType === 'workflow_update') {
      const kind = readString(update, ['workflowKind', 'kind']);
      return kind?.toLowerCase() === 'swarm';
    }
    if (updateType === 'subagent_update') {
      const swarmId = readString(update, ['swarmId', 'workflowId']);
      const kind = readString(update, ['workflowKind']);
      return Boolean(swarmId || kind?.toLowerCase() === 'swarm');
    }
    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      const toolName = readString(update, ['toolName', 'name']) ?? '';
      const title = readString(update, ['title']) ?? '';
      return /\bswarm\b/i.test(toolName) || /\bswarm\b/i.test(title);
    }
    return false;
  }

  private isSessionInBindingScope(
    state: BindingGenerationSwarmState,
    wireSessionId: string,
    update: Record<string, unknown>,
  ): boolean {
    if (wireSessionId === state.rootNativeSessionId) return true;
    // Allow updates originating from a confirmed worker's native session ID in the same binding.
    for (const wf of state.workflows.values()) {
      if (wf.nativeWorkerIdToAgentId.has(wireSessionId)) return true;
    }
    // Allow first worker announcement if it explicitly references our root session as parent.
    const parentSession = readString(update, ['parentSessionId', 'coordinatorSessionId']);
    if (parentSession && parentSession === state.rootNativeSessionId) return true;
    return false;
  }

  private handleSwarmToolCallUpdate(
    state: BindingGenerationSwarmState,
    wf: InternalSwarmWorkflow,
    update: Record<string, unknown>,
    evidence: Evidence,
    nowMs: number,
  ): SwarmFrameIngestionResult {
    const title = readString(update, ['title', 'toolName']) ?? 'swarm tool';
    const rawInput = asRecord(update.rawInput) ?? {};
    const action = readString(rawInput, ['action']) ?? '';
    const status = readString(update, ['status']) ?? 'running';

    // CRITICAL ANTI-FABRICATION RULE:
    // Tool titles (e.g. "swarm add worker-alpha" or "Launch worker beta") NEVER create
    // confirmed workers in `workflow.detail.workerIds` unless accompanied by a verified native worker ID!
    wf.unverifiedLaunchToolCount += 1;
    const diag = this.pushDiagnostic(
      state,
      'unverified_worker_title_ignored',
      `Tool update "${sanitizeSwarmPublicText(title, 120).text}" (${action || status}) recorded in coordinator trace only; no worker created from tool title`,
      nowMs,
    );

    const traceSummary = sanitizeSwarmPublicText(
      `Coordinator 工具观测: ${title}${action ? ` [${action}]` : ''} · status=${status}（未由工具标题生成 Worker）`,
    ).text;
    this.appendCoordinatorTrace(state, wf, {
      level: 'info',
      kind: 'unverified_launch_tool',
      summary: traceSummary,
      evidence,
      nowMs,
    });

    // If coordinator sets swarm title/objective via tool call, record sanitized objective without fabricating workers/board.
    const titleArg = readString(rawInput, ['title', 'objective']);
    if (action === 'title' && titleArg && !wf.objective) {
      wf.objective = sanitizeSwarmPublicText(titleArg, 1000).text;
    }

    if (!this.gates.swarmEnabled) {
      return {
        accepted: true,
        deduplicated: false,
        workflowId: wf.id,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: true,
        diagnostic: diag,
        commits: [],
      };
    }

    if (wf.state.kind === 'unknown') {
      wf.state = { kind: 'known', value: 'running', evidence };
    }
    wf.revision += 1;
    wf.updatedAt = nowMs;
    const commit = this.buildWorkflowCommit(
      state,
      wf,
      null,
      nowMs,
      `swarm_tool:${wf.id}:${evidence.kind === 'live_protocol' ? evidence.ingressOrdinal : nowMs}`,
    );

    return {
      accepted: true,
      deduplicated: false,
      workflowId: wf.id,
      affectedAgentIds: [],
      affectedWorkIds: [],
      coordinatorTraceAppended: true,
      diagnostic: diag,
      commits: [commit],
    };
  }

  private handleCoordinatorUpdate(
    state: BindingGenerationSwarmState,
    wf: InternalSwarmWorkflow,
    update: Record<string, unknown>,
    evidence: Evidence,
    nowMs: number,
  ): SwarmFrameIngestionResult {
    const rawState = readString(update, ['status', 'state', 'coordinatorState']);
    const rawBoardState = readString(update, ['boardStatus', 'boardAvailability']);
    const objective = readString(update, ['objective', 'title', 'goal']);
    const summary = readString(update, ['summary', 'message', 'text']);

    if (objective) {
      wf.objective = sanitizeSwarmPublicText(objective, 1000).text;
    }

    const mappedWorkState = mapRawWorkState(rawState);
    const isTerminalCoordinator = isTerminalWorkState(mappedWorkState);

    this.appendCoordinatorTrace(state, wf, {
      level: mappedWorkState === 'failed' ? 'error' : 'info',
      kind: isTerminalCoordinator ? 'settled' : 'coordinator_update',
      summary: sanitizeSwarmPublicText(
        summary ?? `Coordinator 状态更新: ${rawState ?? 'active'}`,
      ).text,
      evidence,
      nowMs,
    });

    if (!this.gates.swarmEnabled) {
      const diag = this.pushDiagnostic(
        state,
        'swarm_gate_disabled',
        'Swarm gate disabled; coordinator trajectory preserved without publishing Swarm workflow state',
        nowMs,
      );
      return {
        accepted: true,
        deduplicated: false,
        workflowId: wf.id,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: true,
        diagnostic: diag,
        commits: [],
      };
    }

    // Update coordinator agent identity foreground
    const coord = state.agents.get(state.coordinatorAgentId);
    const affectedAgentIds: NativeAgentId[] = [];
    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [];

    if (coord) {
      const coordFg: AgentForeground = isTerminalCoordinator
        ? 'idle'
        : mapRawForeground(rawState ?? 'running');
      const nextCoord = AgentIdentitySchema.parse({
        ...coord,
        foreground: { kind: 'known', value: coordFg, evidence },
        status: { kind: 'known', value: mappedWorkState === 'unknown' ? 'running' : mappedWorkState, evidence },
        revision: coord.revision + 1,
      });
      state.agents.set(state.coordinatorAgentId, nextCoord);
      affectedAgentIds.push(state.coordinatorAgentId);
      commits.push({
        mutation: { agents: [nextCoord] },
        eventDraft: {
          type: 'native.agent.changed',
          turnId: null,
          payload: { agent: sanitizeAgentIdentityForPublic(nextCoord, nowMs) },
          mutationKey: `swarm_coord:${nextCoord.id}:${nextCoord.revision}`,
        },
      });
    }

    // Only transition workflow to terminal when genuine coordinator terminal frame arrives.
    if (mappedWorkState !== 'unknown') {
      wf.state = { kind: 'known', value: mappedWorkState, evidence };
    } else if (wf.state.kind === 'unknown') {
      wf.state = { kind: 'known', value: 'running', evidence };
    }

    // Update Board availability honestly based on explicit upstream signal or default upstream_limited.
    if (rawBoardState === 'upstream_limited' || rawBoardState === 'unavailable' || rawBoardState === 'not_exposed') {
      wf.board = { kind: 'known', value: 'upstream_limited', evidence };
      wf.boardUnavailableReason =
        readString(update, ['boardUnavailableReason', 'reasonCode']) ?? 'acp_swarm_board_not_exposed';
    } else if (rawBoardState === 'available' && this.gates.boardFeedEnabled) {
      wf.board = { kind: 'known', value: 'available', evidence };
      wf.boardUnavailableReason = undefined;
    } else if (wf.board.kind === 'unknown') {
      wf.board = { kind: 'known', value: 'upstream_limited', evidence };
      wf.boardUnavailableReason = this.gates.boardFeedEnabled
        ? 'acp_swarm_board_not_exposed'
        : 'swarm_board_gate_disabled';
    }

    wf.revision += 1;
    wf.updatedAt = nowMs;
    commits.push(
      this.buildWorkflowCommit(
        state,
        wf,
        null,
        nowMs,
        `swarm_coord_wf:${wf.id}:${wf.revision}`,
      ),
    );

    return {
      accepted: true,
      deduplicated: false,
      workflowId: wf.id,
      affectedAgentIds,
      affectedWorkIds: [],
      coordinatorTraceAppended: true,
      commits,
    };
  }

  private handleWorkerStateUpdate(
    state: BindingGenerationSwarmState,
    wf: InternalSwarmWorkflow,
    update: Record<string, unknown>,
    evidence: Evidence,
    nowMs: number,
  ): SwarmFrameIngestionResult {
    const nativeWorkerId = readString(update, [
      'nativeWorkerId',
      'workerSessionId',
      'childSessionId',
      'memberSessionId',
      'conversationId',
      'workerId',
    ]);

    // STRICT IDENTITY GATE: no verified native ID -> never create or mutate a Swarm worker!
    if (!nativeWorkerId) {
      const diag = this.pushDiagnostic(
        state,
        'unverified_worker_title_ignored',
        'Worker update ignored because it lacked a verified native worker/session ID',
        nowMs,
      );
      this.appendCoordinatorTrace(state, wf, {
        level: 'warn',
        kind: 'unverified_launch_tool',
        summary: '收到缺少原生 worker ID 的成员帧，已拒绝伪造 Worker 身份',
        evidence,
        nowMs,
      });
      return {
        accepted: true,
        deduplicated: false,
        workflowId: wf.id,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: true,
        diagnostic: diag,
        commits: [],
      };
    }

    const rosterName = sanitizeSwarmPublicText(
      readString(update, ['rosterName', 'memberName', 'name', 'label']) ?? nativeWorkerId,
      120,
    ).text;
    const rawRole = readString(update, ['role', 'memberRole']);
    const role = detectMemberRole(rawRole, rosterName);
    const modelHint = readString(update, ['model', 'modelHint']);
    const rawState = readString(update, ['state', 'status', 'workerState']);
    const rawForeground = readString(update, ['foreground', 'activityState']) ?? rawState;
    const rawOutcome = readString(update, ['outcome', 'result']);

    this.appendCoordinatorTrace(state, wf, {
      level: mapRawWorkState(rawState) === 'failed' ? 'error' : 'info',
      kind: 'worker_state',
      summary: sanitizeSwarmPublicText(
        `${role === 'verifier' ? 'Verifier' : 'Worker'} ${rosterName} 状态更新: foreground=${rawForeground ?? 'unknown'} state=${rawState ?? 'unknown'}`,
      ).text,
      evidence,
      nowMs,
    });

    if (!this.gates.swarmEnabled) {
      const diag = this.pushDiagnostic(
        state,
        'swarm_gate_disabled',
        'Swarm gate disabled; worker event retained in coordinator trace only',
        nowMs,
      );
      return {
        accepted: true,
        deduplicated: false,
        workflowId: wf.id,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: true,
        diagnostic: diag,
        commits: [],
      };
    }

    let agentId = wf.nativeWorkerIdToAgentId.get(nativeWorkerId);
    if (!agentId) {
      if (wf.workers.size >= this.limits.maxWorkersPerWorkflow) {
        const diag = this.pushDiagnostic(
          state,
          'worker_cap_exceeded',
          `Worker cap (${this.limits.maxWorkersPerWorkflow}) reached for workflow ${wf.id}`,
          nowMs,
        );
        return {
          accepted: false,
          deduplicated: false,
          workflowId: wf.id,
          affectedAgentIds: [],
          affectedWorkIds: [],
          coordinatorTraceAppended: true,
          diagnostic: diag,
          commits: [],
        };
      }
      agentId = asNativeAgentId(
        stableScopedId(
          'agt',
          `swarm_wrk|${state.binding.runtimeId}|${state.binding.generation}|${state.profileRef}|${wf.id}|${nativeWorkerId}`,
        ),
      );
      wf.nativeWorkerIdToAgentId.set(nativeWorkerId, agentId);
    }

    const existing = wf.workers.get(agentId);
    const fgValue = mapRawForeground(rawForeground);
    const wsValue = mapRawWorkState(rawState);
    const explicitOutcome = mapRawOutcome(rawOutcome);

    // CRITICAL T10 RULE:
    // Worker `idle` NEVER counts as `finished` or `succeeded`!
    // If transitioning from `idle` -> `running`, record an authentic native wakeup and link any pending mention.
    const wasIdle = existing?.foreground.kind === 'known' && existing.foreground.value === 'idle';
    const isNowRunning = fgValue === 'running';
    let idleWakeCount = existing?.idleWakeCount ?? 0;
    let lastMentionWakeAt = existing?.lastMentionWakeAt;
    let lastMentionPostId = existing?.lastMentionPostId;

    if (wasIdle && isNowRunning) {
      idleWakeCount += 1;
      const pendingMentionIdx = this.findLatestPendingMentionIndex(wf, agentId, rosterName);
      if (pendingMentionIdx >= 0) {
        const mention = wf.mentions[pendingMentionIdx]!;
        wf.mentions[pendingMentionIdx] = {
          ...mention,
          targetWorkerId: agentId,
          wakeObserved: true,
          wakeObservedAt: nowMs,
        };
        lastMentionWakeAt = nowMs;
        lastMentionPostId = mention.postId;
      }
    }

    const nextWorkState: Observed<WorkState> =
      fgValue === 'idle' && wsValue === 'unknown'
        ? { kind: 'known', value: 'waiting', evidence }
        : wsValue !== 'unknown'
          ? { kind: 'known', value: wsValue, evidence }
          : existing?.workState ?? { kind: 'unknown', reasonCode: 'worker_work_state_not_observed' };

    // Only set explicit outcome when upstream provides one or explicit failure/cancel occurs; NEVER on idle.
    const nextOutcome: Observed<WorkOutcome> | undefined = explicitOutcome
      ? { kind: 'known', value: explicitOutcome, evidence }
      : wsValue === 'failed'
        ? { kind: 'known', value: 'failed', evidence }
        : wsValue === 'cancelled'
          ? { kind: 'known', value: 'cancelled', evidence }
          : existing?.outcome;

    const updatedWorker: SwarmWorkerRecord = {
      agentId,
      nativeWorkerId,
      role: existing?.role === 'verifier' ? 'verifier' : role,
      rosterName,
      ...(modelHint ?? existing?.modelHint ? { modelHint: modelHint ?? existing?.modelHint } : {}),
      foreground:
        fgValue !== 'unknown'
          ? { kind: 'known', value: fgValue, evidence }
          : existing?.foreground ?? { kind: 'unknown', reasonCode: 'worker_foreground_not_observed' },
      workState: nextWorkState,
      ...(nextOutcome ? { outcome: nextOutcome } : {}),
      lineage: 'confirmed',
      idleWakeCount,
      ...(lastMentionWakeAt !== undefined ? { lastMentionWakeAt } : {}),
      ...(lastMentionPostId ? { lastMentionPostId } : {}),
      linkedApprovalIds: existing?.linkedApprovalIds ?? [],
      updatedAt: nowMs,
      evidence,
    };

    wf.workers.set(agentId, updatedWorker);
    wf.rosterNameToAgentId.set(rosterName.toLowerCase(), agentId);

    // Backfill targetWorkerId on any earlier mention targeting this rosterName.
    for (let i = 0; i < wf.mentions.length; i += 1) {
      const m = wf.mentions[i]!;
      if (!m.targetWorkerId && m.targetRosterName.toLowerCase() === rosterName.toLowerCase()) {
        wf.mentions[i] = { ...m, targetWorkerId: agentId };
      }
    }

    if (wf.state.kind === 'unknown' || (wf.state.kind === 'known' && wf.state.value === 'queued')) {
      wf.state = { kind: 'known', value: 'running', evidence };
    }

    const commits: Array<{ mutation: NativeCommitMutation; eventDraft: NativeEventDraft }> = [];
    const agentCommit = this.syncWorkerAgentIdentity(state, updatedWorker, nowMs);
    if (agentCommit) commits.push(agentCommit);

    wf.revision += 1;
    wf.updatedAt = nowMs;
    commits.push(
      this.buildWorkflowCommit(
        state,
        wf,
        null,
        nowMs,
        `swarm_worker_wf:${wf.id}:${agentId}:${wf.revision}`,
      ),
    );

    return {
      accepted: true,
      deduplicated: false,
      workflowId: wf.id,
      affectedAgentIds: [agentId],
      affectedWorkIds: [],
      coordinatorTraceAppended: true,
      commits,
    };
  }

  private handleBoardFeedUpdate(
    state: BindingGenerationSwarmState,
    wf: InternalSwarmWorkflow,
    update: Record<string, unknown>,
    evidence: Evidence,
    ingressOrdinal: number,
    nowMs: number,
  ): SwarmFrameIngestionResult {
    const rawBody = readString(update, ['summary', 'body', 'content', 'text']) ?? '';
    const rawPostId = readString(update, ['postId', 'id', 'messageId']);
    const postId = sanitizePostId(rawPostId, `${wf.id}|${ingressOrdinal}|${rawBody.slice(0, 64)}`);
    const threadId = sanitizeThreadId(readString(update, ['threadId', 'parentPostId']));
    const authorNativeId = readString(update, ['authorNativeId', 'authorSessionId', 'authorWorkerId', 'senderId']);
    const authorLabelRaw = readString(update, ['authorLabel', 'authorName', 'author', 'sender']);
    const isSystemWake = update.isSystemWake === true || update.systemAttribution === true;
    const createdAt = readNumber(update, ['createdAt', 'timestamp']) ?? nowMs;

    const rawMentions = Array.isArray(update.mentions)
      ? update.mentions
          .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
          .map((m) => m.trim().replace(/^@+/, '').slice(0, 80))
          .slice(0, 16)
      : [];

    if (!this.gates.swarmEnabled || !this.gates.boardFeedEnabled) {
      const code = !this.gates.swarmEnabled ? 'swarm_gate_disabled' : 'board_gate_disabled';
      const diag = this.pushDiagnostic(
        state,
        code,
        `Board post ${postId} withheld because ${code}; coordinator trajectory preserved`,
        nowMs,
      );
      this.appendCoordinatorTrace(state, wf, {
        level: 'info',
        kind: 'board_status',
        summary: `Board feed 门控关闭 (${code})，保留只读轨迹与官方 /swarm board 入口`,
        evidence,
        nowMs,
      });
      return {
        accepted: true,
        deduplicated: false,
        workflowId: wf.id,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: true,
        diagnostic: diag,
        commits: [],
      };
    }

    if (!rawBody) {
      return {
        accepted: false,
        deduplicated: false,
        workflowId: wf.id,
        affectedAgentIds: [],
        affectedWorkIds: [],
        coordinatorTraceAppended: false,
        commits: [],
      };
    }

    // Resolve authorAgentId ONLY when confirmed within same binding scope.
    let authorAgentId: NativeAgentId | undefined;
    if (authorNativeId) {
      if (authorNativeId === state.rootNativeSessionId || authorNativeId === 'coordinator') {
        authorAgentId = state.coordinatorAgentId;
      } else {
        authorAgentId = wf.nativeWorkerIdToAgentId.get(authorNativeId);
      }
    } else if (authorLabelRaw) {
      const byRoster = wf.rosterNameToAgentId.get(authorLabelRaw.toLowerCase());
      if (byRoster) authorAgentId = byRoster;
    }

    const sanitizedBody = sanitizeSwarmPublicText(rawBody);
    const authorLabel = authorLabelRaw ? sanitizeSwarmPublicText(authorLabelRaw, 120).text : undefined;

    const postRecord: SwarmBoardPostRecord = {
      postId,
      ...(threadId ? { threadId } : {}),
      ...(authorAgentId ? { authorAgentId } : {}),
      ...(authorLabel ? { authorLabel } : {}),
      summary: sanitizedBody.text,
      truncated: sanitizedBody.truncated,
      mentions: rawMentions,
      isSystemWake,
      createdAt,
      ingressOrdinal,
      evidence,
    };

    const storeRes = wf.store.upsertPost(postRecord);
    if (storeRes.trimmed) {
      this.pushDiagnostic(state, 'board_post_trimmed', `Board store reached cap (${this.limits.maxBoardPostsPerWorkflow})`, nowMs);
    }

    // Record structured @mentions (observed only; never auto-sent).
    for (const targetRosterName of rawMentions) {
      const targetWorkerId = wf.rosterNameToAgentId.get(targetRosterName.toLowerCase());
      const mentionId = stableScopedId('mnt', `${wf.id}|${postId}|${targetRosterName}`);
      if (!wf.mentions.some((m) => m.mentionId === mentionId)) {
        wf.mentions.push({
          mentionId,
          postId,
          targetRosterName,
          ...(targetWorkerId ? { targetWorkerId } : {}),
          observedAt: createdAt,
          wakeObserved: false,
          evidence,
        });
        if (wf.mentions.length > this.limits.maxMentionsPerWorkflow) {
          wf.mentions.shift();
        }
      }
    }

    this.appendCoordinatorTrace(state, wf, {
      level: 'info',
      kind: rawMentions.length > 0 ? 'mention_observed' : 'board_status',
      summary: sanitizeSwarmPublicText(
        `Board 帖子 ${postId}${authorLabel ? ` (${authorLabel})` : ''}${rawMentions.length > 0 ? ` @${rawMentions.join(' @')}` : ''}${isSystemWake ? ' [system]' : ''}`,
      ).text,
      evidence,
      nowMs,
    });

    wf.board = { kind: 'known', value: 'available', evidence };
    wf.boardUnavailableReason = undefined;
    wf.revision += 1;
    wf.updatedAt = nowMs;

    const commit = this.buildWorkflowCommit(
      state,
      wf,
      null,
      nowMs,
      `swarm_board:${wf.id}:${postId}:${wf.revision}`,
      [`board:${postId}`],
    );

    return {
      accepted: true,
      deduplicated: !storeRes.inserted && !storeRes.updated,
      workflowId: wf.id,
      affectedAgentIds: authorAgentId ? [authorAgentId] : [],
      affectedWorkIds: [],
      coordinatorTraceAppended: true,
      commits: [commit],
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private getActiveBindingState(binding: RuntimeBinding): BindingGenerationSwarmState | null {
    const state = this.activeByRuntime.get(binding.runtimeId);
    if (!state || state.binding.generation !== binding.generation) return null;
    return state;
  }

  private findBindingStateIncludingHistorical(binding: RuntimeBinding): BindingGenerationSwarmState | null {
    const active = this.activeByRuntime.get(binding.runtimeId);
    if (active && active.binding.generation === binding.generation) return active;
    return this.historicalByRuntimeGen.get(runtimeGenKey(binding.runtimeId, binding.generation)) ?? null;
  }

  private findWorkflowOwningAgent(
    state: BindingGenerationSwarmState,
    agentId: NativeAgentId,
  ): InternalSwarmWorkflow | null {
    for (const wf of state.workflows.values()) {
      if (wf.workers.has(agentId) || wf.coordinatorAgentId === agentId) {
        return wf;
      }
    }
    return null;
  }

  private findLatestPendingMentionIndex(
    wf: InternalSwarmWorkflow,
    agentId: NativeAgentId,
    rosterName: string,
  ): number {
    for (let i = wf.mentions.length - 1; i >= 0; i -= 1) {
      const m = wf.mentions[i]!;
      if (m.wakeObserved) continue;
      if (
        m.targetWorkerId === agentId ||
        m.targetRosterName.toLowerCase() === rosterName.toLowerCase()
      ) {
        return i;
      }
    }
    return -1;
  }

  private resolveOrCreateWorkflowForFrame(
    state: BindingGenerationSwarmState,
    nativeWorkflowId: string | undefined,
    update: Record<string, unknown>,
    evidence: Evidence,
    nowMs: number,
  ): InternalSwarmWorkflow {
    if (nativeWorkflowId) {
      const existingId = state.nativeWorkflowIdToId.get(nativeWorkflowId);
      if (existingId) {
        const existing = state.workflows.get(existingId);
        if (existing) return existing;
      }
      // Attach to active receipt-created workflow if it does not yet have a nativeWorkflowId.
      if (state.activeWorkflowId) {
        const activeWf = state.workflows.get(state.activeWorkflowId);
        if (activeWf && !activeWf.nativeWorkflowId) {
          activeWf.nativeWorkflowId = nativeWorkflowId;
          state.nativeWorkflowIdToId.set(nativeWorkflowId, activeWf.id);
          return activeWf;
        }
      }
    } else if (state.activeWorkflowId) {
      const activeWf = state.workflows.get(state.activeWorkflowId);
      if (activeWf) return activeWf;
    }

    const wfId = asWorkflowId(
      stableScopedId(
        'wfl',
        `swarm|${state.binding.runtimeId}|${state.binding.generation}|${nativeWorkflowId ?? `auto_${state.workflows.size + 1}`}`,
      ),
    );
    const originActivityId = asActivityId(
      readString(update, ['originActivityId', 'activityId']) ??
        stableScopedId('act', `swarm_origin|${wfId}`),
    );
    const objective = readString(update, ['objective', 'title']);
    return this.getOrCreateWorkflow(state, {
      workflowId: wfId,
      originActivityId,
      nativeWorkflowId,
      objective: objective ? sanitizeSwarmPublicText(objective, 1000).text : undefined,
      evidence,
      nowMs,
      initialState: { kind: 'known', value: 'running', evidence },
    });
  }

  private getOrCreateWorkflow(
    state: BindingGenerationSwarmState,
    opts: {
      readonly workflowId: WorkflowId;
      readonly originActivityId: ActivityId;
      readonly nativeWorkflowId?: string;
      readonly launchReceiptId?: string;
      readonly objective?: string;
      readonly evidence: Evidence;
      readonly nowMs: number;
      readonly initialState: Observed<WorkState>;
    },
  ): InternalSwarmWorkflow {
    const existing = state.workflows.get(opts.workflowId);
    if (existing) return existing;

    if (state.workflows.size >= this.limits.maxWorkflowsPerRuntime) {
      const oldestKey = state.workflows.keys().next().value;
      if (oldestKey) state.workflows.delete(oldestKey);
    }

    const wf: InternalSwarmWorkflow = {
      id: opts.workflowId,
      originActivityId: opts.originActivityId,
      ...(opts.nativeWorkflowId ? { nativeWorkflowId: opts.nativeWorkflowId } : {}),
      ...(opts.launchReceiptId ? { launchReceiptId: opts.launchReceiptId } : {}),
      ...(opts.objective ? { objective: opts.objective } : {}),
      coordinatorAgentId: state.coordinatorAgentId,
      state: opts.initialState,
      board: this.gates.boardFeedEnabled
        ? { kind: 'unknown', reasonCode: 'board_feed_not_yet_observed' }
        : { kind: 'known', value: 'upstream_limited', evidence: opts.evidence },
      boardUnavailableReason: this.gates.boardFeedEnabled
        ? 'acp_swarm_board_not_exposed'
        : 'swarm_board_gate_disabled',
      revision: 1,
      workers: new Map(),
      nativeWorkerIdToAgentId: new Map(),
      rosterNameToAgentId: new Map(),
      mentions: [],
      linkedApprovals: new Map(),
      store: new SwarmBoardStore(
        this.limits.maxBoardPostsPerWorkflow,
        this.limits.maxCoordinatorTraceEntries,
      ),
      seenEventIds: new Set(),
      traceSeq: 0,
      unverifiedLaunchToolCount: 0,
      updatedAt: opts.nowMs,
    };

    state.workflows.set(wf.id, wf);
    state.activeWorkflowId = wf.id;
    if (opts.nativeWorkflowId) {
      state.nativeWorkflowIdToId.set(opts.nativeWorkflowId, wf.id);
    }
    return wf;
  }

  private toNativeWorkflow(wf: InternalSwarmWorkflow): NativeWorkflow {
    const confirmedWorkerIds = [...wf.workers.values()]
      .filter((w) => w.lineage === 'confirmed')
      .map((w) => w.agentId);

    const boardObserved: Observed<SwarmBoardAvailabilityValue> = !this.gates.boardFeedEnabled
      ? {
          kind: 'unknown',
          reasonCode: 'swarm_board_gate_disabled',
        }
      : wf.board;

    return NativeWorkflowSchema.parse({
      id: wf.id,
      originActivityId: wf.originActivityId,
      state: wf.state,
      detail: {
        kind: 'swarm',
        ...(wf.coordinatorAgentId ? { coordinatorId: wf.coordinatorAgentId } : {}),
        workerIds: confirmedWorkerIds,
        board: boardObserved,
        ...(wf.objective ? { objective: wf.objective } : {}),
      },
      revision: wf.revision,
    });
  }

  private syncWorkerAgentIdentity(
    state: BindingGenerationSwarmState,
    worker: SwarmWorkerRecord,
    nowMs: number,
  ): { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft } {
    const prev = state.agents.get(worker.agentId);
    const nextRevision = (prev?.revision ?? 0) + 1;
    const identity = AgentIdentitySchema.parse({
      id: worker.agentId,
      role: { kind: 'known', value: worker.role, evidence: worker.evidence },
      label: { kind: 'known', value: worker.rosterName, evidence: worker.evidence },
      foreground: worker.foreground,
      status: worker.workState,
      launchWorkIds: prev?.launchWorkIds ?? [],
      lineage: worker.lineage,
      revision: nextRevision,
    });
    state.agents.set(worker.agentId, identity);

    return {
      mutation: { agents: [identity] },
      eventDraft: {
        type: 'native.agent.changed',
        turnId: null,
        payload: { agent: sanitizeAgentIdentityForPublic(identity, nowMs) },
        mutationKey: `swarm_worker_agent:${identity.id}:${identity.revision}`,
      },
    };
  }

  private buildWorkflowCommit(
    state: BindingGenerationSwarmState,
    wf: InternalSwarmWorkflow,
    turnId: string | null,
    nowMs: number,
    mutationKey: string,
    resourceIds?: readonly string[],
  ): { readonly mutation: NativeCommitMutation; readonly eventDraft: NativeEventDraft } {
    const workflow = this.toNativeWorkflow(wf);
    const aliases: Array<{
      readonly targetEntityKind: 'workflow';
      readonly targetEntityId: string;
      readonly alias: NativeAlias;
    }> = [];

    if (wf.nativeWorkflowId) {
      aliases.push({
        targetEntityKind: 'workflow',
        targetEntityId: wf.id,
        alias: {
          namespace: 'workflow',
          originSessionId: state.rootNativeSessionId,
          nativeValue: wf.nativeWorkflowId,
          evidence:
            wf.state.kind === 'known'
              ? wf.state.evidence
              : {
                  kind: 'host_observation',
                  observedAt: nowMs,
                  reasonCode: 'swarm_workflow_alias',
                },
        },
      });
    }

    return {
      mutation: {
        workflows: [workflow],
        ...(aliases.length > 0 ? { aliases } : {}),
      },
      eventDraft: {
        type: 'native.workflow.changed',
        turnId,
        payload: {
          workflow: sanitizeNativeWorkflowForPublic(workflow, nowMs),
          ...(resourceIds && resourceIds.length > 0 ? { resourceIds: [...resourceIds] } : {}),
        },
        mutationKey,
      },
    };
  }

  private appendCoordinatorTrace(
    state: BindingGenerationSwarmState,
    wf: InternalSwarmWorkflow,
    opts: {
      readonly level: 'info' | 'warn' | 'error';
      readonly kind: SwarmCoordinatorTraceEntry['kind'];
      readonly summary: string;
      readonly evidence: Evidence;
      readonly nowMs: number;
    },
  ): void {
    wf.traceSeq += 1;
    const sanitized = sanitizeSwarmPublicText(opts.summary);
    const entry: SwarmCoordinatorTraceEntry = {
      entryId: stableScopedId('trc', `${wf.id}|${wf.traceSeq}|${opts.kind}`),
      seq: wf.traceSeq,
      timestamp: opts.nowMs,
      level: opts.level,
      kind: opts.kind,
      summary: sanitized.text,
      truncated: sanitized.truncated,
      evidence: opts.evidence,
    };
    const res = wf.store.appendTrace(entry);
    if (res.trimmed) {
      this.pushDiagnostic(state, 'trace_trimmed', `Coordinator trace reached cap (${this.limits.maxCoordinatorTraceEntries})`, opts.nowMs);
    }
  }

  private markGenerationStale(state: BindingGenerationSwarmState, reasonCode: string): void {
    state.activeConnectionId = null;
    for (const wf of state.workflows.values()) {
      if (wf.state.kind === 'known' && !isTerminalWorkState(wf.state.value)) {
        wf.state = {
          kind: 'stale',
          last: wf.state.value,
          evidence: wf.state.evidence,
          reasonCode,
        };
      }
      if (wf.board.kind === 'known' && wf.board.value === 'available') {
        wf.board = {
          kind: 'stale',
          last: 'available',
          evidence: wf.board.evidence,
          reasonCode,
        };
      }
    }
  }

  private pushDiagnostic(
    state: BindingGenerationSwarmState,
    code: SwarmObserverDiagnostic['code'],
    detail: string,
    nowMs: number,
  ): SwarmObserverDiagnostic {
    const diag: SwarmObserverDiagnostic = {
      code,
      observedAt: nowMs,
      runtimeId: state.binding.runtimeId,
      generation: state.binding.generation,
      detail,
    };
    state.diagnostics.push(diag);
    if (state.diagnostics.length > this.limits.maxDiagnostics) {
      state.diagnostics.shift();
    }
    return diag;
  }
}

function isTerminalWorkState(state: WorkState): boolean {
  return state === 'finished' || state === 'failed' || state === 'cancelled';
}
