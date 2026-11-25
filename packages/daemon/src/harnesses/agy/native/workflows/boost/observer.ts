import crypto from 'node:crypto';
import {
  NativeStageSchema,
  NativeWorkflowResourceItemDtoSchema,
  NativeWorkflowSchema,
  asWorkflowId,
  sanitizeNativeWorkflowForPublic,
  sanitizeObservedForPublic,
  toPublicEvidenceDto,
  type ActivityId,
  type AgentIdentity,
  type BindingGeneration,
  type Evidence,
  type NativeAgentId,
  type NativeStage,
  type NativeWorkflow,
  type NativeWorkflowResourceItemDto,
  type NativeWorkflowResourceKind,
  type Observed,
  type RuntimeBinding,
  type WorkId,
  type WorkOutcome,
  type WorkState,
  type WorkflowId,
} from '@harnessmate/protocol';
import type { AgyNativeRuntimeRegistry } from '../../wiring/registry.js';
import type {
  NativeCommitMutation,
  NativeEventDraft,
  NativeIngress,
  NativeWorkflowResourceReaderPort,
} from '../../wiring/types.js';
import {
  classifyBoostSignalLabel,
  detectBoostServerDenial,
  sanitizeBoostLabel,
  sanitizeBoostSummary,
} from './resolver.js';
import {
  BOOST_WORKFLOW_CONTRACT_REVISION,
  type BoostArtifactObservation,
  type BoostObserverDiagnostic,
  type BoostRoleObservation,
  type BoostServerDenialRecord,
  type BoostStageRecord,
  type BoostStudioSnapshotDto,
  type BoostVerificationClue,
  type BoostWorkflowState,
} from './types.js';

export interface BoostObserverLimits {
  readonly maxStagesPerWorkflow: number;
  readonly maxRolesPerWorkflow: number;
  readonly maxCluesPerWorkflow: number;
  readonly maxArtifactsPerWorkflow: number;
  readonly maxDiagnostics: number;
  readonly maxDedupeKeys: number;
}

export const DEFAULT_BOOST_OBSERVER_LIMITS: Readonly<BoostObserverLimits> = Object.freeze({
  maxStagesPerWorkflow: 32,
  maxRolesPerWorkflow: 64,
  maxCluesPerWorkflow: 200,
  maxArtifactsPerWorkflow: 64,
  maxDiagnostics: 200,
  maxDedupeKeys: 2048,
});

export interface BoostCommitBatch {
  readonly mutation: NativeCommitMutation;
  readonly eventDraft: NativeEventDraft;
}

export interface BoostIngestionResult {
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly workflowId?: WorkflowId;
  readonly commits: readonly BoostCommitBatch[];
  readonly diagnostic?: BoostObserverDiagnostic;
}

interface MutableBoostSession {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly rootNativeSessionId: string;
  activeWorkflowId: WorkflowId | null;
  readonly workflows: Map<WorkflowId, MutableBoostWorkflow>;
  readonly seenDedupeKeys: Set<string>;
  readonly seenDedupeQueue: string[];
  readonly confirmedAgents: Map<NativeAgentId, AgentIdentity>;
  lastServerDenial: BoostServerDenialRecord | null;
}

interface MutableBoostWorkflow {
  id: WorkflowId;
  originActivityId: ActivityId;
  objective?: string;
  state: Observed<WorkState>;
  launchConfirmed: boolean;
  launchEvidence: Evidence;
  stagesById: Map<string, BoostStageRecord>;
  stageOrder: string[];
  rolesByKey: Map<string, BoostRoleObservation>;
  clues: BoostVerificationClue[];
  clueSeq: number;
  artifacts: BoostArtifactObservation[];
  relatedActivityIds: ActivityId[];
  relatedWorkIds: WorkId[];
  stop: BoostWorkflowState['stop'];
  serverDenial: BoostServerDenialRecord | null;
  revision: number;
}

function bindingSlotKey(binding: RuntimeBinding): string {
  return `${binding.runtimeId}::${binding.generation}`;
}

function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.sessionId === b.sessionId &&
    a.instanceId === b.instanceId &&
    a.generation === b.generation
  );
}

function normalizeWorkState(raw: unknown): WorkState | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.trim().toLowerCase();
  switch (lowered) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'in_progress':
    case 'active':
    case 'started':
      return 'running';
    case 'waiting':
    case 'paused':
      return 'waiting';
    case 'requires_action':
    case 'awaiting_approval':
    case 'awaiting_input':
      return 'requires_action';
    case 'finished':
    case 'completed':
    case 'done':
    case 'succeeded':
    case 'passed':
      return 'finished';
    case 'failed':
    case 'error':
    case 'denied':
    case 'rejected':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'stopped':
      return 'cancelled';
    case 'unknown':
      return 'unknown';
    default:
      return null;
  }
}

function normalizeWorkOutcome(raw: unknown): WorkOutcome | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'succeeded' || lowered === 'passed' || lowered === 'verified' || lowered === 'ok') {
    return 'succeeded';
  }
  if (lowered === 'failed' || lowered === 'error' || lowered === 'denied' || lowered === 'rejected') {
    return 'failed';
  }
  if (lowered === 'cancelled' || lowered === 'canceled' || lowered === 'aborted' || lowered === 'stopped') {
    return 'cancelled';
  }
  return null;
}

function safeStageId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 96);
  return cleaned || `stage_${crypto.randomBytes(4).toString('hex')}`;
}

function safeOpaqueToken(prefix: string, raw?: string): string {
  if (raw) {
    const cleaned = raw
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
      .replace(/^[^a-zA-Z0-9]+/, '')
      .slice(0, 96);
    if (cleaned) return cleaned;
  }
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function extractString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function extractStringArray(obj: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      const items = value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => safeStageId(item));
      return items.length > 0 ? [...new Set(items)] : undefined;
    }
  }
  return undefined;
}

/**
 * NP-09 Typed Boost Workflow Observer & Resource Reader.
 *
 * Design guarantees:
 * 1. Read-only observation: NEVER triggers Boost, NEVER spawns auxiliary CLI instances,
 *    NEVER mutates system prompts or other workflows.
 * 2. Zero phase fabrication: `detail.phases` is OMITTED (`undefined`) unless explicit
 *    structured Boost phase evidence is received.
 * 3. Canonical enum restraint: `initial | improvement | verification` is ONLY assigned
 *    when explicit signals match; unknown stages/roles are preserved verbatim as
 *    `observedLabel` without inferring progress or round counts.
 * 4. Strict lineage separation: `agentIds` on stages or roles are ONLY linked when
 *    confirmed via `syncConfirmedAgent` (`lineage === 'confirmed'`).
 * 5. Generation/connection fencing, history_replay isolation, and deduplication of
 *    duplicate frames.
 */
export class BoostWorkflowObserver implements NativeWorkflowResourceReaderPort {
  private readonly sessions = new Map<string, MutableBoostSession>();
  private readonly diagnostics: BoostObserverDiagnostic[] = [];

  constructor(private readonly limits: BoostObserverLimits = DEFAULT_BOOST_OBSERVER_LIMITS) {}

  registerBinding(config: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly rootNativeSessionId: string;
  }): void {
    const key = bindingSlotKey(config.binding);
    const existing = this.sessions.get(key);
    if (existing && existing.connectionId === config.connectionId) {
      return;
    }
    this.sessions.set(key, {
      binding: config.binding,
      connectionId: config.connectionId,
      rootNativeSessionId: config.rootNativeSessionId,
      activeWorkflowId: null,
      workflows: new Map(),
      seenDedupeKeys: new Set(),
      seenDedupeQueue: [],
      confirmedAgents: new Map(),
      lastServerDenial: null,
    });
  }

  /**
   * Syncs a confirmed child/root agent identity from NP-05 without conflating
   * lineage with Boost phase semantics.
   */
  syncConfirmedAgent(binding: RuntimeBinding, agent: AgentIdentity): void {
    const session = this.sessions.get(bindingSlotKey(binding));
    if (!session) return;
    if (agent.lineage === 'confirmed') {
      session.confirmedAgents.set(agent.id, agent);
    } else {
      session.confirmedAgents.delete(agent.id);
    }
  }

  /**
   * Records an explicit user-confirmed `/boost` launch on `live_workflow`.
   * Starts with `detail.phases` OMITTED (`undefined`) until real phase evidence arrives.
   */
  recordConfirmedLaunch(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly originActivityId: ActivityId;
    readonly objective?: string;
    readonly workflowId?: WorkflowId;
    readonly ingressOrdinal?: number;
    readonly observedAt?: number;
    readonly wireVariant?: string;
  }): BoostIngestionResult {
    const session = this.sessions.get(bindingSlotKey(input.binding));
    if (!session) {
      return { accepted: false, deduplicated: false, commits: [] };
    }
    if (session.connectionId !== input.connectionId) {
      const diag = this.pushDiagnostic({
        code: 'wrong_connection_rejected',
        observedAt: input.observedAt ?? Date.now(),
        runtimeId: input.binding.runtimeId,
        generation: input.binding.generation,
        detail: 'Boost launch ignored because connectionId does not match active binding',
      });
      return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
    }

    const observedAt = input.observedAt ?? Date.now();
    const workflowId =
      input.workflowId ??
      asWorkflowId(`wf_boost_${crypto.randomBytes(5).toString('hex')}`);

    const dedupeKey = `launch:${input.connectionId}:${workflowId}:${input.originActivityId}`;
    if (this.hasOrRecordDedupeKey(session, dedupeKey)) {
      const diag = this.pushDiagnostic({
        code: 'duplicate_frame_ignored',
        observedAt,
        runtimeId: input.binding.runtimeId,
        generation: input.binding.generation,
        detail: `Duplicate Boost launch ignored for ${workflowId}`,
      });
      return { accepted: true, deduplicated: true, workflowId, commits: [], diagnostic: diag };
    }

    const evidence: Evidence = {
      kind: 'live_protocol',
      connectionId: input.connectionId,
      ingressOrdinal: input.ingressOrdinal ?? 0,
      wireVariant: input.wireVariant ?? 'boost_live_workflow_launch',
      observedAt,
    };

    const objective = input.objective ? sanitizeBoostSummary(input.objective, 1000) : undefined;
    const wf: MutableBoostWorkflow = {
      id: workflowId,
      originActivityId: input.originActivityId,
      ...(objective ? { objective } : {}),
      state: { kind: 'known', value: 'running', evidence },
      launchConfirmed: true,
      launchEvidence: evidence,
      stagesById: new Map(),
      stageOrder: [],
      rolesByKey: new Map(),
      clues: [],
      clueSeq: 0,
      artifacts: [],
      relatedActivityIds: [input.originActivityId],
      relatedWorkIds: [],
      stop: {
        state: 'none',
        supportedInterruptPath: 'root_session_cancel',
      },
      serverDenial: null,
      revision: 1,
    };

    this.appendClue(wf, {
      kind: 'launch_confirmed',
      label: '已证实 /boost 启动',
      summary: objective
        ? `用户显式通过 live_workflow 发起 Boost：${sanitizeBoostSummary(objective, 220)}`
        : '用户显式通过 live_workflow 发起 Boost（当前尚未观测到原生阶段字段）',
      state: wf.state,
      evidence,
      observedAt,
    });

    session.workflows.set(workflowId, wf);
    session.activeWorkflowId = workflowId;
    session.lastServerDenial = null;

    const commit = this.buildWorkflowCommit(session.binding, wf, observedAt, `boost_launch:${workflowId}:1`);
    return {
      accepted: true,
      deduplicated: false,
      workflowId,
      commits: [commit],
    };
  }

  /**
   * Ingests a single ACP frame into the Boost observer.
   * Rejects stale generations, mismatched connections, history_replay frames,
   * duplicate deliveries, and model-spontaneous mentions without confirmed Boost run.
   */
  acceptFrame(
    envelope: NativeIngress,
    opts?: {
      readonly relatedActivityId?: ActivityId;
      readonly relatedWorkId?: WorkId;
      readonly confirmedAgentId?: NativeAgentId;
      readonly observedAt?: number;
    },
  ): BoostIngestionResult {
    const observedAt = opts?.observedAt ?? Date.now();
    const session = this.sessions.get(bindingSlotKey(envelope.binding));
    if (!session || !sameBinding(session.binding, envelope.binding)) {
      const diag = this.pushDiagnostic({
        code: 'stale_generation_rejected',
        observedAt,
        runtimeId: envelope.binding.runtimeId,
        generation: envelope.binding.generation,
        detail: 'Boost observer rejected frame for unregistered or stale binding generation',
      });
      return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
    }

    if (session.connectionId !== envelope.connectionId) {
      const diag = this.pushDiagnostic({
        code: 'wrong_connection_rejected',
        observedAt,
        runtimeId: envelope.binding.runtimeId,
        generation: envelope.binding.generation,
        detail: 'Boost observer rejected frame from non-active connection',
      });
      return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
    }

    if (envelope.channel === 'history_replay') {
      const diag = this.pushDiagnostic({
        code: 'history_replay_isolated',
        observedAt,
        runtimeId: envelope.binding.runtimeId,
        generation: envelope.binding.generation,
        detail: 'Boost observer isolated history_replay frame from mutating live Boost state',
      });
      return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
    }

    const wire = envelope.wire;
    if (!isObject(wire)) {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    const evidence: Evidence = {
      kind: 'live_protocol',
      connectionId: envelope.connectionId,
      ingressOrdinal: envelope.ingressOrdinal,
      wireVariant: typeof wire.method === 'string' ? wire.method : 'acp_frame',
      observedAt,
    };

    // 1. Check for server denial (error response or explicit denied update)
    const denial = detectBoostServerDenial(wire, evidence, observedAt);
    if (denial) {
      return this.recordServerDenial({
        binding: envelope.binding,
        connectionId: envelope.connectionId,
        denial,
        dedupeToken: `ordinal:${envelope.ingressOrdinal}:denial:${denial.code}`,
        observedAt,
      });
    }

    // Only inspect session/update notifications (or explicit boost workflow notifications)
    const method = typeof wire.method === 'string' ? wire.method : '';
    if (method !== 'session/update') {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    const params = isObject(wire.params) ? wire.params : null;
    const update = params && isObject(params.update) ? params.update : params;
    if (!update) {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    const updateKind = String(update.sessionUpdate ?? update.type ?? '');
    const meta = isObject(update._meta) ? update._meta : isObject(params?._meta) ? (params!._meta as Record<string, unknown>) : null;
    const boostMeta = meta && isObject(meta.boost) ? meta.boost : isObject(update.boost) ? update.boost : null;

    const activeWf = session.activeWorkflowId
      ? session.workflows.get(session.activeWorkflowId) ?? null
      : null;

    // 2. Guard against model-spontaneous Boost:
    // Without a confirmed user `/boost` launch, NEVER fabricate a Boost workflow from text/ordinary tools.
    if (!activeWf) {
      if (this.looksLikeTextMentioningBoost(updateKind, update)) {
        const diag = this.pushDiagnostic({
          code: 'model_spontaneous_ignored',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: 'Ignored model text/tool mentioning boost without confirmed live_workflow launch',
        });
        return { accepted: false, deduplicated: false, commits: [], diagnostic: diag };
      }
      return { accepted: false, deduplicated: false, commits: [] };
    }

    // 3. Deduplicate by connectionId + ingressOrdinal AND semantic event/update ID when present
    const semanticEventId = extractString(update, ['eventId', 'updateId', 'stageUpdateId']);
    const ordinalKey = `ord:${envelope.connectionId}:${envelope.ingressOrdinal}`;
    if (this.hasOrRecordDedupeKey(session, ordinalKey)) {
      const diag = this.pushDiagnostic({
        code: 'duplicate_frame_ignored',
        observedAt,
        runtimeId: envelope.binding.runtimeId,
        generation: envelope.binding.generation,
        detail: `Duplicate Boost ingress ordinal ${envelope.ingressOrdinal} ignored`,
      });
      return { accepted: true, deduplicated: true, workflowId: activeWf.id, commits: [], diagnostic: diag };
    }
    if (semanticEventId) {
      const semKey = `sem:${activeWf.id}:${semanticEventId}`;
      if (this.hasOrRecordDedupeKey(session, semKey)) {
        const diag = this.pushDiagnostic({
          code: 'duplicate_frame_ignored',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Duplicate Boost updateId "${semanticEventId}" ignored`,
        });
        return { accepted: true, deduplicated: true, workflowId: activeWf.id, commits: [], diagnostic: diag };
      }
    }

    // Link related activity / work IDs if supplied by runtime caller
    let mutated = false;
    if (opts?.relatedActivityId && !activeWf.relatedActivityIds.includes(opts.relatedActivityId)) {
      activeWf.relatedActivityIds.push(opts.relatedActivityId);
      mutated = true;
    }
    if (opts?.relatedWorkId && !activeWf.relatedWorkIds.includes(opts.relatedWorkId)) {
      activeWf.relatedWorkIds.push(opts.relatedWorkId);
      mutated = true;
    }

    const confirmedAgentId = this.resolveConfirmedAgentId(session, opts?.confirmedAgentId);
    if (opts?.confirmedAgentId && !confirmedAgentId) {
      this.pushDiagnostic({
        code: 'unconfirmed_lineage_kept_unlinked',
        observedAt,
        runtimeId: envelope.binding.runtimeId,
        generation: envelope.binding.generation,
        detail: `Unconfirmed agent ${opts.confirmedAgentId} was not linked to Boost stage`,
      });
    }

    let lastDiagnostic: BoostObserverDiagnostic | undefined;

    // 4. Structured Boost stage / phase update (ONLY when explicit Boost phase fields exist)
    const phasePayload = this.extractExplicitBoostPhasePayload(updateKind, update, boostMeta);
    if (phasePayload) {
      const stageDedupeKey = `stage:${activeWf.id}:${phasePayload.stageId}:${phasePayload.state}:${phasePayload.label}:${phasePayload.outcome ?? ''}:${phasePayload.after?.join(',') ?? ''}:${confirmedAgentId ?? ''}`;
      if (this.hasOrRecordDedupeKey(session, stageDedupeKey)) {
        const diag = this.pushDiagnostic({
          code: 'duplicate_frame_ignored',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Duplicate Boost stage state for "${phasePayload.stageId}" ignored`,
        });
        return { accepted: true, deduplicated: true, workflowId: activeWf.id, commits: [], diagnostic: diag };
      }

      const classification = classifyBoostSignalLabel(
        phasePayload.label,
        phasePayload.canonicalHint,
      );
      const existingStage = activeWf.stagesById.get(phasePayload.stageId);
      const nextAgentIds = this.mergeAgentIds(existingStage?.stage.agentIds, confirmedAgentId);
      const nextAfter = phasePayload.after ?? existingStage?.stage.after;

      const stage: NativeStage = NativeStageSchema.parse({
        id: phasePayload.stageId,
        label: classification.observedLabel,
        state: {
          kind: 'known',
          value: phasePayload.state,
          evidence,
        },
        ...(nextAfter && nextAfter.length > 0 ? { after: nextAfter } : {}),
        ...(nextAgentIds && nextAgentIds.length > 0 ? { agentIds: nextAgentIds } : {}),
      });

      if (!existingStage && activeWf.stagesById.size < this.limits.maxStagesPerWorkflow) {
        activeWf.stageOrder.push(stage.id);
      }
      if (existingStage || activeWf.stagesById.size < this.limits.maxStagesPerWorkflow) {
        activeWf.stagesById.set(stage.id, {
          stage,
          classification,
          ...(phasePayload.summary ? { summary: phasePayload.summary } : existingStage?.summary ? { summary: existingStage.summary } : {}),
          revision: (existingStage?.revision ?? 0) + 1,
          updatedAt: observedAt,
        });
        mutated = true;
      }

      if (classification.kind === 'observed_unknown') {
        lastDiagnostic = this.pushDiagnostic({
          code: 'unknown_stage_preserved',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Preserved unknown Boost stage label "${classification.observedLabel}" without enum coercion`,
        });
      }

      const clueKind =
        classification.kind === 'canonical' && classification.phaseKind === 'verification'
          ? phasePayload.outcome
            ? 'verification_outcome'
            : 'verification_check'
          : classification.kind === 'observed_unknown'
            ? 'unknown_stage_observed'
            : 'phase_signal';

      this.appendClue(activeWf, {
        kind: clueKind,
        label:
          classification.kind === 'canonical'
            ? `阶段 · ${classification.observedLabel}`
            : `已观测阶段 · ${classification.observedLabel}`,
        summary:
          phasePayload.summary ||
          `阶段 ${classification.observedLabel} 状态更新为 ${phasePayload.state}`,
        state: stage.state,
        ...(phasePayload.outcome
          ? { outcome: { kind: 'known', value: phasePayload.outcome, evidence } }
          : {}),
        stageId: stage.id,
        ...(confirmedAgentId ? { agentId: confirmedAgentId } : {}),
        ...(opts?.relatedWorkId ? { workId: opts.relatedWorkId } : {}),
        evidence,
        observedAt,
      });

      // If verification outcome explicitly failed/cancelled or workflow state explicitly provided
      const explicitWorkflowState = normalizeWorkState(
        update.workflowState ?? boostMeta?.workflowState ?? boostMeta?.state,
      );
      if (explicitWorkflowState) {
        activeWf.state = { kind: 'known', value: explicitWorkflowState, evidence };
        if (explicitWorkflowState === 'cancelled' && activeWf.stop.state === 'requested') {
          activeWf.stop = {
            ...activeWf.stop,
            state: 'confirmed',
            confirmedAt: observedAt,
            reasonCode: 'native_workflow_cancelled',
            evidence,
          };
        }
      }
    }

    // 5. Subagent role observation during an active Boost run (keeps lineage separate from phases)
    const rolePayload = this.extractSubagentRolePayload(updateKind, update, boostMeta);
    if (rolePayload) {
      const roleKey = safeStageId(rolePayload.roleLabel);
      const roleDedupeKey = `role:${activeWf.id}:${roleKey}:${rolePayload.state}:${opts?.relatedWorkId ?? ''}:${confirmedAgentId ?? ''}`;
      if (this.hasOrRecordDedupeKey(session, roleDedupeKey)) {
        const diag = this.pushDiagnostic({
          code: 'duplicate_frame_ignored',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Duplicate Boost role update for "${roleKey}" ignored`,
        });
        return { accepted: true, deduplicated: true, workflowId: activeWf.id, commits: [], diagnostic: diag };
      }

      const classification = classifyBoostSignalLabel(rolePayload.roleLabel, rolePayload.canonicalHint);
      const existingRole = activeWf.rolesByKey.get(roleKey);
      const nextWorkIds =
        opts?.relatedWorkId && !(existingRole?.workIds.includes(opts.relatedWorkId))
          ? [...(existingRole?.workIds ?? []), opts.relatedWorkId]
          : [...(existingRole?.workIds ?? [])];

      if (existingRole || activeWf.rolesByKey.size < this.limits.maxRolesPerWorkflow) {
        const agentLineage = confirmedAgentId ? 'confirmed' : existingRole?.lineage ?? 'unlinked';
        activeWf.rolesByKey.set(roleKey, {
          roleKey,
          observedLabel: classification.observedLabel,
          classification,
          ...(confirmedAgentId ? { agentId: confirmedAgentId } : existingRole?.agentId ? { agentId: existingRole.agentId } : {}),
          lineage: agentLineage,
          workIds: nextWorkIds,
          state: { kind: 'known', value: rolePayload.state, evidence },
          revision: (existingRole?.revision ?? 0) + 1,
          evidence,
        });
        mutated = true;
      }

      if (classification.kind === 'observed_unknown') {
        lastDiagnostic = this.pushDiagnostic({
          code: 'unknown_role_preserved',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Preserved unknown Boost subagent role "${classification.observedLabel}" as observed label`,
        });
      }

      this.appendClue(activeWf, {
        kind:
          classification.kind === 'canonical' && classification.phaseKind === 'verification'
            ? rolePayload.outcome
              ? 'verification_outcome'
              : 'verification_check'
            : 'role_observed',
        label: `角色 · ${classification.observedLabel}`,
        summary:
          rolePayload.summary ||
          `观测到子角色「${classification.observedLabel}」（状态：${rolePayload.state}）`,
        state: { kind: 'known', value: rolePayload.state, evidence },
        ...(rolePayload.outcome
          ? { outcome: { kind: 'known', value: rolePayload.outcome, evidence } }
          : {}),
        ...(confirmedAgentId ? { agentId: confirmedAgentId } : {}),
        ...(opts?.relatedWorkId ? { workId: opts.relatedWorkId } : {}),
        evidence,
        observedAt,
      });
    }

    // 6. Explicit Boost workflow-level status / verification clue / artifact ref (even when NO phases are exposed!)
    const workflowTerminal = this.extractBoostWorkflowStatusUpdate(updateKind, update, boostMeta);
    if (workflowTerminal) {
      const wfStateKey = `wfstate:${activeWf.id}:${workflowTerminal.state}:${workflowTerminal.outcome ?? ''}:${workflowTerminal.summary ?? ''}`;
      if (this.hasOrRecordDedupeKey(session, wfStateKey)) {
        const diag = this.pushDiagnostic({
          code: 'duplicate_frame_ignored',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Duplicate Boost workflow state "${workflowTerminal.state}" ignored`,
        });
        return { accepted: true, deduplicated: true, workflowId: activeWf.id, commits: [], diagnostic: diag };
      }

      activeWf.state = { kind: 'known', value: workflowTerminal.state, evidence };
      mutated = true;

      if (workflowTerminal.state === 'cancelled') {
        activeWf.stop = {
          ...activeWf.stop,
          state: 'confirmed',
          confirmedAt: observedAt,
          reasonCode: workflowTerminal.reasonCode ?? 'native_boost_cancelled',
          evidence,
        };
        lastDiagnostic = this.pushDiagnostic({
          code: 'stop_confirmed',
          observedAt,
          runtimeId: envelope.binding.runtimeId,
          generation: envelope.binding.generation,
          detail: `Boost workflow ${activeWf.id} cancellation confirmed by native frame`,
        });
        this.appendClue(activeWf, {
          kind: 'stop_confirmed',
          label: 'Boost 已确认停止',
          summary: workflowTerminal.summary || '原生端已返回取消终态。',
          state: activeWf.state,
          outcome: { kind: 'known', value: 'cancelled', evidence },
          evidence,
          observedAt,
        });
      } else if (workflowTerminal.outcome || workflowTerminal.isVerification) {
        this.appendClue(activeWf, {
          kind: workflowTerminal.outcome ? 'verification_outcome' : 'verification_check',
          label: workflowTerminal.label || 'Boost 验证线索',
          summary:
            workflowTerminal.summary ||
            `Boost 工作流状态更新为 ${workflowTerminal.state}`,
          state: activeWf.state,
          ...(workflowTerminal.outcome
            ? { outcome: { kind: 'known', value: workflowTerminal.outcome, evidence } }
            : {}),
          ...(opts?.relatedWorkId ? { workId: opts.relatedWorkId } : {}),
          evidence,
          observedAt,
        });
      }
    }

    // 7. Optional artifact reference attached to Boost verification
    const artifactObs = this.extractArtifactObservation(update, boostMeta, evidence, observedAt, confirmedAgentId, opts?.relatedActivityId);
    if (artifactObs) {
      const existingIdx = activeWf.artifacts.findIndex((a) => a.artifactId === artifactObs.artifactId);
      if (existingIdx >= 0) {
        activeWf.artifacts[existingIdx] = artifactObs;
        mutated = true;
      } else if (activeWf.artifacts.length < this.limits.maxArtifactsPerWorkflow) {
        activeWf.artifacts.push(artifactObs);
        mutated = true;
      }
    }

    if (!mutated) {
      return { accepted: false, deduplicated: false, workflowId: activeWf.id, commits: [] };
    }

    activeWf.revision += 1;
    const commit = this.buildWorkflowCommit(
      session.binding,
      activeWf,
      observedAt,
      `boost_update:${activeWf.id}:${activeWf.revision}`,
    );
    return {
      accepted: true,
      deduplicated: false,
      workflowId: activeWf.id,
      commits: [commit],
      ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}),
    };
  }

  /**
   * Records a server denial (entitlement, quota, plan required, policy, or permission denied)
   * against the active Boost workflow (if any) and binding.
   */
  recordServerDenial(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly denial: BoostServerDenialRecord;
    readonly dedupeToken?: string;
    readonly observedAt?: number;
  }): BoostIngestionResult {
    const observedAt = input.observedAt ?? Date.now();
    const session = this.sessions.get(bindingSlotKey(input.binding));
    if (!session || session.connectionId !== input.connectionId) {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    const dedupeKey = input.dedupeToken ?? `denial:${input.denial.code}:${input.denial.category}`;
    if (this.hasOrRecordDedupeKey(session, dedupeKey)) {
      const diag = this.pushDiagnostic({
        code: 'duplicate_frame_ignored',
        observedAt,
        runtimeId: input.binding.runtimeId,
        generation: input.binding.generation,
        detail: `Duplicate Boost server denial "${input.denial.code}" ignored`,
      });
      return {
        accepted: true,
        deduplicated: true,
        ...(session.activeWorkflowId ? { workflowId: session.activeWorkflowId } : {}),
        commits: [],
        diagnostic: diag,
      };
    }

    session.lastServerDenial = input.denial;
    const diag = this.pushDiagnostic({
      code: 'server_denial_recorded',
      observedAt,
      runtimeId: input.binding.runtimeId,
      generation: input.binding.generation,
      detail: `Boost server denial recorded: ${input.denial.category} (${input.denial.code})`,
    });

    const activeWf = session.activeWorkflowId
      ? session.workflows.get(session.activeWorkflowId) ?? null
      : null;
    if (!activeWf) {
      return { accepted: true, deduplicated: false, commits: [], diagnostic: diag };
    }

    activeWf.serverDenial = input.denial;
    activeWf.state = {
      kind: 'known',
      value: 'failed',
      evidence: input.denial.evidence,
    };
    activeWf.revision += 1;
    this.appendClue(activeWf, {
      kind: 'server_denied',
      label: `服务端拒绝 (${input.denial.category})`,
      summary: input.denial.message,
      state: activeWf.state,
      outcome: { kind: 'known', value: 'failed', evidence: input.denial.evidence },
      evidence: input.denial.evidence,
      observedAt,
    });

    const commit = this.buildWorkflowCommit(
      session.binding,
      activeWf,
      observedAt,
      `boost_denied:${activeWf.id}:${activeWf.revision}`,
    );
    return {
      accepted: true,
      deduplicated: false,
      workflowId: activeWf.id,
      commits: [commit],
      diagnostic: diag,
    };
  }

  /**
   * Records a user-initiated Stop (`session/cancel` on root session).
   * Distinguishes `requested` from native terminal `confirmed` and never fabricates immediate stop.
   */
  handleStopRequested(
    binding: RuntimeBinding,
    opts?: { readonly observedAt?: number; readonly reasonCode?: string },
  ): BoostIngestionResult {
    const observedAt = opts?.observedAt ?? Date.now();
    const session = this.sessions.get(bindingSlotKey(binding));
    const activeWf = session?.activeWorkflowId
      ? session.workflows.get(session.activeWorkflowId) ?? null
      : null;
    if (!session || !activeWf) {
      return { accepted: false, deduplicated: false, commits: [] };
    }

    const evidence: Evidence = {
      kind: 'host_observation',
      observedAt,
      reasonCode: opts?.reasonCode ?? 'root_session_cancel_requested',
    };
    activeWf.stop = {
      state: 'requested',
      supportedInterruptPath: 'root_session_cancel',
      requestedAt: observedAt,
      reasonCode: opts?.reasonCode ?? 'root_session_cancel_requested',
      evidence,
    };
    activeWf.revision += 1;

    this.appendClue(activeWf, {
      kind: 'stop_requested',
      label: '已发送根会话停止请求',
      summary: '已向当前 live ACP 根会话发送 session/cancel，等待原生终态确认（不推定阶段或子任务已立即终止）。',
      state: activeWf.state,
      evidence,
      observedAt,
    });

    const diag = this.pushDiagnostic({
      code: 'stop_requested',
      observedAt,
      runtimeId: binding.runtimeId,
      generation: binding.generation,
      detail: `Boost stop requested via root_session_cancel for ${activeWf.id}`,
    });

    const commit = this.buildWorkflowCommit(
      session.binding,
      activeWf,
      observedAt,
      `boost_stop_req:${activeWf.id}:${activeWf.revision}`,
    );
    return {
      accepted: true,
      deduplicated: false,
      workflowId: activeWf.id,
      commits: [commit],
      diagnostic: diag,
    };
  }

  /**
   * Marks in-flight Boost observations stale/unknown when the live transport closes.
   * Never fabricates `cancelled` or `finished` on disconnect.
   */
  handleTransportClosed(
    binding: RuntimeBinding,
    connectionId: string,
    opts?: { readonly observedAt?: number; readonly reasonCode?: string },
  ): readonly BoostCommitBatch[] {
    const observedAt = opts?.observedAt ?? Date.now();
    const reasonCode = opts?.reasonCode ?? 'transport_closed_before_terminal';
    const session = this.sessions.get(bindingSlotKey(binding));
    if (!session || session.connectionId !== connectionId) {
      return [];
    }

    const commits: BoostCommitBatch[] = [];
    for (const wf of session.workflows.values()) {
      const currentState = wf.state.kind === 'known' ? wf.state.value : wf.state.kind === 'stale' ? wf.state.last : undefined;
      const isTerminal =
        currentState === 'finished' || currentState === 'failed' || currentState === 'cancelled';
      if (isTerminal) continue;

      const hostEvidence: Evidence = {
        kind: 'host_observation',
        observedAt,
        reasonCode,
      };
      wf.state = {
        kind: 'stale',
        ...(currentState ? { last: currentState } : {}),
        evidence: hostEvidence,
        reasonCode,
      };

      // Also mark non-terminal observed stages stale
      for (const stageId of wf.stageOrder) {
        const rec = wf.stagesById.get(stageId);
        if (!rec) continue;
        const stVal = rec.stage.state.kind === 'known' ? rec.stage.state.value : undefined;
        if (stVal && stVal !== 'finished' && stVal !== 'failed' && stVal !== 'cancelled') {
          wf.stagesById.set(stageId, {
            ...rec,
            stage: {
              ...rec.stage,
              state: {
                kind: 'stale',
                last: stVal,
                evidence: hostEvidence,
                reasonCode,
              },
            },
            revision: rec.revision + 1,
            updatedAt: observedAt,
          });
        }
      }

      if (wf.stop.state === 'requested') {
        wf.stop = {
          ...wf.stop,
          state: 'unknown',
          reasonCode: 'stop_confirmation_lost_on_disconnect',
          evidence: hostEvidence,
        };
        this.appendClue(wf, {
          kind: 'stop_unknown',
          label: '停止结果未确认（连接已断开）',
          summary: '在收到原生取消终态前观测连接已断开，不能推定 Boost 已逻辑结束。',
          state: wf.state,
          evidence: hostEvidence,
          observedAt,
        });
        this.pushDiagnostic({
          code: 'stop_unknown_after_disconnect',
          observedAt,
          runtimeId: binding.runtimeId,
          generation: binding.generation,
          detail: `Boost ${wf.id} stop outcome unknown after transport closed`,
        });
      }

      wf.revision += 1;
      commits.push(
        this.buildWorkflowCommit(session.binding, wf, observedAt, `boost_closed:${wf.id}:${wf.revision}`),
      );
    }

    return commits;
  }

  /**
   * Commits generated Boost mutations/events atomically through NP-02's `AgyNativeRuntimeRegistry`.
   */
  commitToRegistry(
    registry: AgyNativeRuntimeRegistry,
    binding: RuntimeBinding,
    commits: readonly BoostCommitBatch[],
  ): void {
    for (const batch of commits) {
      registry.commitAndPublish(binding, batch.mutation, batch.eventDraft);
    }
  }

  getServerDenial(binding: RuntimeBinding): BoostServerDenialRecord | null {
    return this.sessions.get(bindingSlotKey(binding))?.lastServerDenial ?? null;
  }

  getWorkflowState(binding: RuntimeBinding, workflowId?: WorkflowId): BoostWorkflowState | null {
    const session = this.sessions.get(bindingSlotKey(binding));
    if (!session) return null;
    const targetId = workflowId ?? session.activeWorkflowId;
    if (!targetId) return null;
    const wf = session.workflows.get(targetId);
    if (!wf) return null;
    return this.freezeWorkflowState(session.binding, wf);
  }

  getStudioSnapshot(
    binding: RuntimeBinding,
    workflowId?: WorkflowId,
    nowMs = Date.now(),
  ): BoostStudioSnapshotDto | null {
    const state = this.getWorkflowState(binding, workflowId);
    if (!state) return null;

    const workflowDto = sanitizeNativeWorkflowForPublic(state.workflow, nowMs);
    const phaseClassifications: Record<string, BoostStageRecord['classification']> = {};
    for (const stageId of state.stageOrder) {
      const rec = state.stagesById.get(stageId);
      if (rec) phaseClassifications[stageId] = rec.classification;
    }

    return {
      contractRevision: BOOST_WORKFLOW_CONTRACT_REVISION,
      binding: state.binding,
      workflow: workflowDto,
      launchConfirmed: state.launchConfirmed,
      hasObservedPhases: state.stageOrder.length > 0,
      phaseClassifications,
      ...(workflowDto.detail.kind === 'boost' && workflowDto.detail.phases
        ? { stages: workflowDto.detail.phases }
        : {}),
      roles: [...state.rolesByKey.values()].map((role) => ({
        roleKey: role.roleKey,
        observedLabel: role.observedLabel,
        classification: role.classification,
        ...(role.agentId ? { agentId: role.agentId } : {}),
        lineage: role.lineage,
        workIds: [...role.workIds],
        state: sanitizeObservedForPublic(role.state, nowMs),
        revision: role.revision,
        evidence: toPublicEvidenceDto(role.evidence, nowMs),
      })),
      verificationClues: state.clues.map((clue) => ({
        clueId: clue.clueId,
        seq: clue.seq,
        kind: clue.kind,
        label: clue.label,
        summary: clue.summary,
        state: sanitizeObservedForPublic(clue.state, nowMs),
        ...(clue.outcome ? { outcome: sanitizeObservedForPublic(clue.outcome, nowMs) } : {}),
        ...(clue.stageId ? { stageId: clue.stageId } : {}),
        ...(clue.agentId ? { agentId: clue.agentId } : {}),
        ...(clue.workId ? { workId: clue.workId } : {}),
        ...(clue.artifactId ? { artifactId: clue.artifactId } : {}),
        evidence: toPublicEvidenceDto(clue.evidence, nowMs),
        observedAt: clue.observedAt,
      })),
      relatedActivityIds: [...state.relatedActivityIds],
      relatedWorkIds: [...state.relatedWorkIds],
      stop: {
        state: state.stop.state,
        supportedInterruptPath: state.stop.supportedInterruptPath,
        ...(state.stop.requestedAt !== undefined ? { requestedAt: state.stop.requestedAt } : {}),
        ...(state.stop.confirmedAt !== undefined ? { confirmedAt: state.stop.confirmedAt } : {}),
        ...(state.stop.reasonCode ? { reasonCode: state.stop.reasonCode } : {}),
        ...(state.stop.evidence ? { evidence: toPublicEvidenceDto(state.stop.evidence, nowMs) } : {}),
      },
      serverDenial: state.serverDenial
        ? {
            code: state.serverDenial.code,
            category: state.serverDenial.category,
            message: state.serverDenial.message,
            evidence: toPublicEvidenceDto(state.serverDenial.evidence, nowMs),
          }
        : null,
      revision: state.revision,
    };
  }

  getDiagnostics(): readonly BoostObserverDiagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * Implements `NativeWorkflowResourceReaderPort` for paginated, allowlisted Boost resources:
   * - `phases`: ONLY available when observed phase records exist
   * - `logs`: sanitized verification clues & lifecycle observations
   * - `artifacts`: observed verification artifacts (if any)
   * - `board`: unavailable (`boost_board_not_applicable`)
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
    readonly items: readonly NativeWorkflowResourceItemDto[];
    readonly nextPageToken: string | null;
    readonly hasMore: boolean;
  } {
    const session = this.sessions.get(bindingSlotKey(input.binding));
    const wf = session?.workflows.get(input.workflowId);
    if (!session || !wf) {
      return {
        revision: 0,
        available: false,
        sourceUnavailableReason: 'boost_workflow_not_found',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const nowMs = Date.now();
    const limit = Math.max(1, Math.min(200, input.limit));
    const offset = input.pageToken ? Math.max(0, Number.parseInt(input.pageToken, 10) || 0) : 0;

    if (input.resource === 'board') {
      return {
        revision: wf.revision,
        available: false,
        sourceUnavailableReason: 'boost_board_not_applicable',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    if (input.resource === 'phases') {
      if (wf.stageOrder.length === 0) {
        return {
          revision: wf.revision,
          available: false,
          sourceUnavailableReason: 'boost_phases_not_observed',
          items: [],
          nextPageToken: null,
          hasMore: false,
        };
      }
      const allItems: NativeWorkflowResourceItemDto[] = wf.stageOrder
        .map((id) => wf.stagesById.get(id))
        .filter((rec): rec is BoostStageRecord => Boolean(rec))
        .map((rec) =>
          NativeWorkflowResourceItemDtoSchema.parse({
            kind: 'phase',
            stage: {
              id: rec.stage.id,
              label: rec.stage.label,
              state: sanitizeObservedForPublic(rec.stage.state, nowMs),
              ...(rec.stage.after ? { after: [...rec.stage.after] } : {}),
              ...(rec.stage.agentIds ? { agentIds: [...rec.stage.agentIds] } : {}),
            },
            ...(rec.summary ? { summary: rec.summary } : {}),
          }),
        );
      return this.paginateResource(wf.revision, allItems, offset, limit);
    }

    if (input.resource === 'logs') {
      const allItems: NativeWorkflowResourceItemDto[] = wf.clues.map((clue) =>
        NativeWorkflowResourceItemDtoSchema.parse({
          kind: 'log_entry',
          entryId: clue.clueId,
          seq: clue.seq,
          level:
            clue.kind === 'server_denied'
              ? 'error'
              : clue.kind === 'stop_unknown' || clue.kind === 'unknown_stage_observed'
                ? 'warn'
                : 'info',
          summary: `${clue.label}: ${clue.summary}`.slice(0, 4000),
          truncated: false,
          createdAt: clue.observedAt,
          evidence: toPublicEvidenceDto(clue.evidence, nowMs),
        }),
      );
      return this.paginateResource(wf.revision, allItems, offset, limit);
    }

    // 'artifacts'
    if (wf.artifacts.length === 0) {
      return {
        revision: wf.revision,
        available: false,
        sourceUnavailableReason: 'boost_artifacts_not_observed',
        items: [],
        nextPageToken: null,
        hasMore: false,
      };
    }

    const allArtifacts: NativeWorkflowResourceItemDto[] = wf.artifacts.map((art) =>
      NativeWorkflowResourceItemDtoSchema.parse({
        kind: 'artifact_ref',
        artifactId: art.artifactId,
        title: art.title,
        artifactKind: art.artifactKind,
        ...(art.ownerAgentId ? { ownerAgentId: art.ownerAgentId } : {}),
        ...(art.activityId ? { activityId: art.activityId } : {}),
        revision: art.revision,
        updatedAt: art.updatedAt,
        evidence: toPublicEvidenceDto(art.evidence, nowMs),
      }),
    );
    return this.paginateResource(wf.revision, allArtifacts, offset, limit);
  }

  private paginateResource(
    revision: number,
    allItems: readonly NativeWorkflowResourceItemDto[],
    offset: number,
    limit: number,
  ) {
    const slice = allItems.slice(offset, offset + limit);
    const hasMore = offset + slice.length < allItems.length;
    return {
      revision,
      available: true,
      items: slice,
      nextPageToken: hasMore ? String(offset + slice.length) : null,
      hasMore,
    };
  }

  private buildWorkflowEntity(wf: MutableBoostWorkflow): NativeWorkflow {
    const phases: NativeStage[] = [];
    for (const id of wf.stageOrder) {
      const rec = wf.stagesById.get(id);
      if (rec) phases.push(rec.stage);
    }

    // CRITICAL CONTRACT RULE: Omit `phases` completely when no phase evidence has been observed!
    return NativeWorkflowSchema.parse({
      id: wf.id,
      originActivityId: wf.originActivityId,
      state: wf.state,
      detail: {
        kind: 'boost',
        ...(phases.length > 0 ? { phases } : {}),
        ...(wf.objective !== undefined ? { objective: wf.objective } : {}),
      },
      revision: wf.revision,
    });
  }

  private buildWorkflowCommit(
    binding: RuntimeBinding,
    wf: MutableBoostWorkflow,
    observedAt: number,
    mutationKey: string,
  ): BoostCommitBatch {
    const workflow = this.buildWorkflowEntity(wf);
    const workflowDto = sanitizeNativeWorkflowForPublic(workflow, observedAt);
    const resourceIds: string[] = ['logs'];
    if (wf.stageOrder.length > 0) resourceIds.unshift('phases');
    if (wf.artifacts.length > 0) resourceIds.push('artifacts');

    return {
      mutation: {
        workflows: [workflow],
      },
      eventDraft: {
        type: 'native.workflow.changed',
        turnId: null,
        payload: {
          workflow: workflowDto,
          resourceIds,
        },
        mutationKey,
        createdAt: observedAt,
      },
    };
  }

  private freezeWorkflowState(binding: RuntimeBinding, wf: MutableBoostWorkflow): BoostWorkflowState {
    return {
      binding,
      workflow: this.buildWorkflowEntity(wf),
      launchConfirmed: wf.launchConfirmed,
      launchEvidence: wf.launchEvidence,
      stagesById: new Map(wf.stagesById),
      stageOrder: [...wf.stageOrder],
      rolesByKey: new Map(wf.rolesByKey),
      clues: [...wf.clues],
      artifacts: [...wf.artifacts],
      relatedActivityIds: [...wf.relatedActivityIds],
      relatedWorkIds: [...wf.relatedWorkIds],
      stop: { ...wf.stop },
      serverDenial: wf.serverDenial,
      revision: wf.revision,
    };
  }

  private appendClue(
    wf: MutableBoostWorkflow,
    input: Omit<BoostVerificationClue, 'clueId' | 'seq'>,
  ): void {
    wf.clueSeq += 1;
    const clue: BoostVerificationClue = {
      clueId: `bclue_${wf.clueSeq}_${crypto.randomBytes(3).toString('hex')}`,
      seq: wf.clueSeq,
      ...input,
    };
    wf.clues.push(clue);
    if (wf.clues.length > this.limits.maxCluesPerWorkflow) {
      wf.clues.shift();
    }
  }

  private resolveConfirmedAgentId(
    session: MutableBoostSession,
    candidate?: NativeAgentId,
  ): NativeAgentId | undefined {
    if (!candidate) return undefined;
    const agent = session.confirmedAgents.get(candidate);
    return agent && agent.lineage === 'confirmed' ? agent.id : undefined;
  }

  private mergeAgentIds(
    existing: readonly NativeAgentId[] | undefined,
    next?: NativeAgentId,
  ): NativeAgentId[] | undefined {
    const list = new Set<NativeAgentId>(existing ?? []);
    if (next) list.add(next);
    return list.size > 0 ? [...list] : undefined;
  }

  private hasOrRecordDedupeKey(session: MutableBoostSession, key: string): boolean {
    if (session.seenDedupeKeys.has(key)) {
      return true;
    }
    session.seenDedupeKeys.add(key);
    session.seenDedupeQueue.push(key);
    while (session.seenDedupeQueue.length > this.limits.maxDedupeKeys) {
      const oldest = session.seenDedupeQueue.shift();
      if (oldest) session.seenDedupeKeys.delete(oldest);
    }
    return false;
  }

  private pushDiagnostic(diag: BoostObserverDiagnostic): BoostObserverDiagnostic {
    this.diagnostics.push(diag);
    if (this.diagnostics.length > this.limits.maxDiagnostics) {
      this.diagnostics.shift();
    }
    return diag;
  }

  private looksLikeTextMentioningBoost(updateKind: string, update: Record<string, unknown>): boolean {
    if (updateKind === 'agent_message_chunk' || updateKind === 'agent_thought_chunk') {
      const content = isObject(update.content) ? update.content : null;
      const text = typeof content?.text === 'string' ? content.text : typeof update.text === 'string' ? update.text : '';
      return /\/boost\b|\bboost\b/i.test(text);
    }
    if (updateKind === 'tool_call' || updateKind === 'tool_call_update') {
      const title = String(update.title ?? '');
      return /\bboost\b/i.test(title);
    }
    return false;
  }

  private extractExplicitBoostPhasePayload(
    updateKind: string,
    update: Record<string, unknown>,
    boostMeta: Record<string, unknown> | null,
  ): {
    readonly stageId: string;
    readonly label: string;
    readonly canonicalHint?: string;
    readonly state: WorkState;
    readonly outcome?: WorkOutcome;
    readonly after?: string[];
    readonly summary?: string;
  } | null {
    const rawInput = isObject(update.rawInput) ? update.rawInput : null;
    const rawOutput = isObject(update.rawOutput) ? update.rawOutput : null;

    const isExplicitBoostUpdate =
      updateKind === 'boost_phase_update' ||
      (updateKind === 'workflow_update' && String(update.workflowKind ?? '').toLowerCase() === 'boost') ||
      Boolean(boostMeta && (boostMeta.phase || boostMeta.stage || boostMeta.phaseId || boostMeta.stageId)) ||
      Boolean(rawInput && (rawInput.boostPhase || rawInput.boostStage)) ||
      Boolean(rawOutput && (rawOutput.boostPhase || rawOutput.boostStage));

    if (!isExplicitBoostUpdate) return null;

    const stageContainer = isObject(update.stage)
      ? update.stage
      : isObject(update.phase)
        ? update.phase
        : isObject(boostMeta?.phase)
          ? (boostMeta!.phase as Record<string, unknown>)
          : isObject(boostMeta?.stage)
            ? (boostMeta!.stage as Record<string, unknown>)
            : boostMeta ?? update;

    const rawLabel =
      extractString(stageContainer, ['label', 'name', 'phase', 'stage', 'role']) ??
      (typeof rawInput?.boostPhase === 'string' ? rawInput.boostPhase : undefined) ??
      (typeof rawInput?.boostStage === 'string' ? rawInput.boostStage : undefined) ??
      (typeof rawOutput?.boostPhase === 'string' ? rawOutput.boostPhase : undefined) ??
      (typeof rawOutput?.boostStage === 'string' ? rawOutput.boostStage : undefined);

    if (!rawLabel) return null;

    const rawId =
      extractString(stageContainer, ['id', 'stageId', 'phaseId']) ??
      extractString(update, ['stageId', 'phaseId']) ??
      rawLabel;

    const canonicalHint = extractString(stageContainer, ['phaseKind', 'kind', 'canonicalPhase']);
    const state =
      normalizeWorkState(stageContainer.state ?? stageContainer.status ?? update.status) ?? 'unknown';
    const outcome =
      normalizeWorkOutcome(stageContainer.outcome ?? update.outcome ?? rawOutput?.outcome) ?? undefined;
    const after =
      extractStringArray(stageContainer, ['after', 'dependsOn']) ??
      extractStringArray(update, ['after', 'dependsOn']);
    const rawSummary =
      extractString(stageContainer, ['summary', 'message', 'detail']) ??
      extractString(update, ['summary', 'message']);

    return {
      stageId: safeStageId(rawId),
      label: sanitizeBoostLabel(rawLabel),
      ...(canonicalHint ? { canonicalHint } : {}),
      state,
      ...(outcome ? { outcome } : {}),
      ...(after ? { after } : {}),
      ...(rawSummary ? { summary: sanitizeBoostSummary(rawSummary) } : {}),
    };
  }

  private extractSubagentRolePayload(
    updateKind: string,
    update: Record<string, unknown>,
    boostMeta: Record<string, unknown> | null,
  ): {
    readonly roleLabel: string;
    readonly canonicalHint?: string;
    readonly state: WorkState;
    readonly outcome?: WorkOutcome;
    readonly summary?: string;
  } | null {
    if (updateKind !== 'tool_call' && updateKind !== 'tool_call_update' && updateKind !== 'subagent_update') {
      return null;
    }

    const title = String(update.title ?? '').trim();
    const rawInput = isObject(update.rawInput) ? update.rawInput : null;
    const rawOutput = isObject(update.rawOutput) ? update.rawOutput : null;

    const isSubagentTool = /invoke_subagent/i.test(title) || updateKind === 'subagent_update';
    const roleLabel =
      (isSubagentTool && rawInput ? extractString(rawInput, ['Role', 'role', 'TypeName', 'typeName']) : undefined) ??
      (updateKind === 'subagent_update' ? extractString(update, ['role', 'label', 'agentRole']) : undefined) ??
      (boostMeta ? extractString(boostMeta, ['role', 'agentRole']) : undefined);

    if (!roleLabel) return null;

    const state = normalizeWorkState(update.status ?? update.state ?? boostMeta?.roleState) ?? 'running';
    const outcome =
      normalizeWorkOutcome(update.outcome ?? rawOutput?.outcome ?? boostMeta?.outcome) ?? undefined;
    const canonicalHint = boostMeta ? extractString(boostMeta, ['canonicalRole', 'phaseKind']) : undefined;
    const rawSummary =
      extractString(update, ['summary', 'title']) ??
      (rawOutput ? extractString(rawOutput, ['summary', 'verdict', 'result']) : undefined);

    return {
      roleLabel: sanitizeBoostLabel(roleLabel),
      ...(canonicalHint ? { canonicalHint } : {}),
      state,
      ...(outcome ? { outcome } : {}),
      ...(rawSummary ? { summary: sanitizeBoostSummary(rawSummary) } : {}),
    };
  }

  private extractBoostWorkflowStatusUpdate(
    updateKind: string,
    update: Record<string, unknown>,
    boostMeta: Record<string, unknown> | null,
  ): {
    readonly state: WorkState;
    readonly outcome?: WorkOutcome;
    readonly label?: string;
    readonly summary?: string;
    readonly reasonCode?: string;
    readonly isVerification?: boolean;
  } | null {
    const isBoostWorkflowFrame =
      updateKind === 'boost_workflow_update' ||
      (updateKind === 'workflow_update' && String(update.workflowKind ?? '').toLowerCase() === 'boost') ||
      Boolean(boostMeta && (boostMeta.workflowState || boostMeta.verification || boostMeta.terminal));

    if (!isBoostWorkflowFrame) return null;

    const rawState = update.workflowState ?? update.status ?? update.state ?? boostMeta?.workflowState;
    const state = normalizeWorkState(rawState);
    if (!state) return null;

    const outcome =
      normalizeWorkOutcome(
        update.outcome ?? boostMeta?.outcome ?? (isObject(boostMeta?.verification) ? boostMeta!.verification.outcome : undefined),
      ) ?? undefined;
    const isVerification = Boolean(
      boostMeta?.verification ||
        update.verification ||
        /verif/i.test(String(update.label ?? update.summary ?? '')),
    );
    const label = extractString(update, ['label', 'title']) ?? (isVerification ? '独立验证结果' : 'Boost 状态更新');
    const summary =
      extractString(update, ['summary', 'message']) ??
      (isObject(boostMeta?.verification) ? extractString(boostMeta!.verification, ['summary', 'verdict']) : undefined);
    const reasonCode = extractString(update, ['reasonCode']);

    return {
      state,
      ...(outcome ? { outcome } : {}),
      label: sanitizeBoostLabel(label),
      ...(summary ? { summary: sanitizeBoostSummary(summary) } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      isVerification,
    };
  }

  private extractArtifactObservation(
    update: Record<string, unknown>,
    boostMeta: Record<string, unknown> | null,
    evidence: Evidence,
    observedAt: number,
    ownerAgentId?: NativeAgentId,
    activityId?: ActivityId,
  ): BoostArtifactObservation | null {
    const rawArt = isObject(update.artifact)
      ? update.artifact
      : isObject(boostMeta?.artifact)
        ? (boostMeta!.artifact as Record<string, unknown>)
        : null;
    if (!rawArt) return null;

    const title = extractString(rawArt, ['title', 'name']);
    if (!title) return null;
    const rawKind = extractString(rawArt, ['artifactKind', 'kind']) ?? 'unknown';
    const allowedKinds = new Set(['markdown', 'text', 'diff', 'script', 'json', 'media', 'unknown']);
    const artifactKind = (allowedKinds.has(rawKind) ? rawKind : 'unknown') as BoostArtifactObservation['artifactKind'];

    return {
      artifactId: safeOpaqueToken('art_boost', extractString(rawArt, ['artifactId', 'id'])),
      title: sanitizeBoostLabel(title, 200),
      artifactKind,
      ...(ownerAgentId ? { ownerAgentId } : {}),
      ...(activityId ? { activityId } : {}),
      revision: typeof rawArt.revision === 'number' && Number.isInteger(rawArt.revision) && rawArt.revision >= 0
        ? rawArt.revision
        : 1,
      updatedAt: observedAt,
      evidence,
    };
  }
}
